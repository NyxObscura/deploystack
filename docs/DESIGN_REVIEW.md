# Self-review: v1 → v2

The prompt asked for a first-pass system, then a self-review identifying weaknesses, then a refined final version. Rather than ship two codebases, this document captures the weaknesses of the obvious first-pass design and maps each one to the fix that's already applied in the code in this repo.

## v1 (strawman)

A minimal take on "deploy Next.js from a GitHub webhook" tends to look like this:

```js
// server.js (v1 sketch, DO NOT use)
app.post("/webhook", express.json(), (req, res) => {
  if (req.header("x-hub-signature-256") !== "sha256=" + hmac(JSON.stringify(req.body)))
    return res.sendStatus(401);
  exec("bash deploy.sh", (err) => { if (err) console.error(err); });
  res.sendStatus(200);
});
```

```bash
# deploy.sh (v1 sketch)
cd /srv/app
git pull
npm install
npm run build
pm2 restart my-app
```

It looks reasonable. It has eight serious problems. The code in this repo is structured specifically to avoid each of them.

## Weaknesses and how the final version fixes them

### 1. HMAC over the parsed JSON body is broken

Computing the signature over `JSON.stringify(req.body)` re-serializes the payload. GitHub signs the **raw bytes**. Any difference in key order, whitespace, or number precision (and there are many, e.g. `\u00fc` vs `ü`) produces a valid-looking payload that fails signature check, or worse, a crafted payload that matches because you just re-signed whatever you parsed.

**Fix:** [`src/webhook.js`](../src/webhook.js) uses `express.raw({ type: "application/json", limit: "2mb" })` so `req.body` is a `Buffer` of the exact bytes GitHub sent. The HMAC is computed over that buffer, and compared with `crypto.timingSafeEqual` after equal-length guard.

### 2. String equality on signatures leaks timing

`a === b` on two 72-byte hex strings is data-dependent. An attacker who can send many requests can recover the signature one byte at a time.

**Fix:** `timingSafeEqualStr` in `src/webhook.js` always compares equal-length buffers with `crypto.timingSafeEqual`.

### 3. `git pull` in place is not atomic

`git pull && npm install && next build && pm2 restart` mutates the live directory. If `npm install` or `next build` fails halfway, the running Node.js process may pick up a broken `node_modules` or a half-written `.next/`. `pm2 restart` drops requests. There's no way to roll back to "what was running 30 seconds ago" — the files are already gone.

**Fix:** Each deploy produces an immutable release directory `releases/build-<timestamp>-<sha>/`. The previous release is never touched. The symlink `current` is the only thing that changes, via `ln -sfn tmp && mv -Tf tmp current`, which is atomic within a directory on POSIX.

### 4. `pm2 restart` is not zero-downtime

`restart` stops all workers, then starts them. Even in cluster mode there's a gap. Worse, if the new release fails to boot, PM2 keeps trying and you're down.

**Fix:** The deploy script uses `pm2 reload`, which does a rolling worker replacement in cluster mode. The example `ecosystem.config.js` sets `exec_mode: "cluster"`, `instances: "max"`, `wait_ready: true`, `listen_timeout: 15000`. Combined with the symlink swap happening *before* the reload, worker N+1 boots from the new release while worker N continues serving from its own (already-loaded) code.

### 5. No protection against concurrent or flooded deploys

Two webhooks landing within a few seconds run two concurrent `npm install`s in the same directory, which corrupts `node_modules`. CI amplifying pushes (or a rebase force-push triggering several push events) makes this routine.

**Fix:**
- Per-app in-memory FIFO queue (`src/queue.js`) serializes deploys of the same app.
- A filesystem lock (`<data>/state/<app>.lock`) serializes deploys across multiple `deploystack` processes on the same host, with stale-lock detection after `2 × DEPLOYSTACK_DEPLOY_TIMEOUT`.
- Coalescing: if a deploy is already running AND another is already queued, a third webhook replaces the queued one (it has a newer commit). The queue depth per app is capped at 2 (1 running + 1 queued).

### 6. No rollback path, no release retention, no pruning

Replacing the directory in place means `rollback` is "`git reset --hard <old sha> && redeploy`", which only works if nothing in `node_modules` has moved (it usually has) and forces a full rebuild on rollback — the opposite of what you want when you're trying to recover from a bad deploy.

**Fix:**
- Every successful build remains on disk, unmodified, until pruned.
- `deploystack rollback <app>` is a symlink flip plus `pm2 reload`. No rebuild. Takes about a second.
- `keep_releases` (per-app) and `prune_releases` (in `scripts/lib.sh`) never delete the currently-active release even if it's older than the threshold.

### 7. Build failures leave the system broken

A half-failed build followed by `pm2 restart` means PM2 tries to start something that can't start. Or `pm2 restart` is skipped but `current/` already points at the broken tree because you untarred into it.

**Fix:**
- Bash `set -Eeuo pipefail` + an `ERR` trap in `scripts/deploy.sh`.
- If the failure happened **before** the symlink swap, the partial release dir is removed and nothing else changed.
- If the failure happened **after** the swap (e.g. the health check failed), the trap reverts the symlink to the previous release and reloads PM2, so traffic goes back to the last known-good build.
- Health-check is a real HTTP probe against a URL you specify; the deploy fails (and rolls back) if the new release doesn't return 2xx within the timeout.

### 8. Scary defaults

The v1 sketch silently assumes you've run it as root inside `/srv/app`, that `pm2` is in root's PATH, and that the webhook server is directly reachable from the public internet on a high port. These are how real incidents happen.

**Fix:**
- systemd unit binds to `127.0.0.1` by default and runs as an unprivileged `deploy` user, with `NoNewPrivileges`, `ProtectSystem=strict`, `PrivateTmp`, restricted `RestrictAddressFamilies`, and an explicit `ReadWritePaths` whitelist.
- `docs/SETUP.md` sets up user-level PM2 owned by `deploy`, not root.
- `docs/SECURITY.md` documents the expected nginx frontend and points to optional GitHub IP allowlisting.

## Things I considered and deliberately left out

- **Downloading tarballs from GitHub's archive API** (faster than `git clone`). Rejected: requires a GitHub token, which adds an attack surface for a feature that a bare clone cache already provides at comparable speed (blob-filter clone + archive-extract per release).
- **A built-in HTTPS listener.** Rejected: nginx/Caddy already do this better, and re-implementing ACME in the deploy server is out of scope.
- **A web UI.** Rejected per "avoid unnecessary dependencies". `/status` + CLI cover the operational needs.
- **Database-backed deploy history.** Rejected: release directories + per-release log files under `/var/lib/deploystack` are the history. Grep works.
- **Multi-host orchestration.** Rejected: single-VPS is in-scope. Multi-host is a different system (you'd want a control plane plus a per-host agent, plus a shared artifact store).

## Known remaining trade-offs

- Zero-downtime relies on the Next.js server calling `process.send('ready')` once it's listening. PM2 has a fallback (`listen_timeout` before it considers the worker ready) so you don't **need** the ready signal, but for the tightest guarantee add to your Next.js custom server: `if (process.send) process.send('ready')` after `server.listen` resolves. If you use `next start` directly, PM2 falls back to `listen_timeout`.
- The repo cache (`shared/repo.git`) is mutated by every deploy. A catastrophic interruption mid-fetch could leave it corrupted; the deploy script would then fail loudly on the next run and the admin would need to `rm -rf shared/repo.git` and retry (it's rebuilt on first deploy).
- `DEPLOYSTACK_GITHUB_IP_ALLOWLIST=true` fails closed if `api.github.com` is unreachable at boot. That's almost always what you want, but it means the very first deploy after a network partition can be delayed until the allowlist refresh succeeds.
