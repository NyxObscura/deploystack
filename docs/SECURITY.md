# Security best practices

deploystack is a deployment control plane with code-execution power: every webhook can cause arbitrary `npm` scripts from your repo to run on the host. Treat it accordingly.

## Non-negotiables

1. **Never run as root.** The systemd unit runs as `deploy`. Do not change this.
2. **Never put the Node process on a public port.** Always front it with nginx + TLS. The Node server binds to `127.0.0.1` by default.
3. **Rotate webhook secrets on any suspected leak.** Generate with `openssl rand -hex 32`. Store in `/etc/deploystack/env`, mode `640`, owned by `root:deploy`.
4. **Validate every webhook.** deploystack verifies `X-Hub-Signature-256` with constant-time compare on the raw request body. Do not disable this.
5. **Lock down the repo mapping.** Each app is hard-pinned to a single repo URL. A leaked secret cannot trigger deploys for a different repo on the same server.
6. **Pin the branch.** Pushes to other branches are ignored, even with a valid signature.

## Defense in depth

- Enable the optional GitHub IP allowlist (`DEPLOYSTACK_GITHUB_IP_ALLOWLIST=true`). The server fetches `https://api.github.com/meta` at boot and refreshes every 6h.
- Put deploystack behind Cloudflare or a WAF with rate limiting on `/webhook/*`.
- Set `client_max_body_size 2m` in nginx. deploystack already caps at 2 MB.
- Give the `deploy` user the minimum sudo rights it needs (ideally none). `next build` and `npm install` MUST NOT have sudo.
- Run `next start` on `127.0.0.1:<port>` and proxy through nginx; do not expose the Next.js port directly.
- Your apps almost certainly need secrets (DB URL, API keys). Store them in `shared/.env.production` under each app's shared dir (permissions `600`, owned by `deploy`). deploystack symlinks them into each new release so they never live in git.

## Build-time sandboxing (recommended, advanced)

`next build` executes user code (server components, `getStaticProps`, etc.) at build time. If the repo contents are untrusted (e.g. you accept PRs from strangers), run the build inside a rootless container:

- Use `podman run --rm --userns keep-id --network none -v $RELEASE:/work -w /work node:20 bash -c "<install and build>"` for the install/build steps in `deploy.sh`, and copy `.next` back out.
- Only the build is sandboxed; `pm2 reload` happens on the host.

This is not wired in by default because it complicates the setup significantly; it's a drop-in replacement for the `install` + `build` steps in `scripts/deploy.sh`.

## What deploystack intentionally does NOT do

- **It does not talk to GitHub as a user.** There is no OAuth token stored anywhere. It only responds to signed webhooks.
- **It does not pull arbitrary refs on demand.** Only the configured branch is deployed, and only commits reachable from that branch at the time of the webhook.
- **It does not auto-rollback on arbitrary signals.** Rollback is either: (a) the symlink-revert the deploy script performs if the health check fails, or (b) an explicit CLI `rollback` call.

## Logs

Deploy logs go to `/var/lib/deploystack/logs/deploys/<app>/<release>.log`. They include the full stdout/stderr of `git`, `npm install`, `next build`, and `pm2 reload`. These logs may contain secrets that leak through `npm install` scripts. Restrict read access:

```bash
sudo chmod 750 /var/lib/deploystack/logs
sudo chmod -R 640 /var/lib/deploystack/logs/deploys
```

## Updating deploystack itself

```bash
sudo -u deploy bash -c 'cd /opt/deploystack && git fetch && git checkout <tag> && npm ci --omit=dev'
sudo systemctl restart deploystack
```

A running deploy is NOT killed by `systemctl restart` — the Node child `bash` process is reparented to PID 1 and runs to completion. The deploy script's own `ERR` trap still rolls the symlink back on failure.
