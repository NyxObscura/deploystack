# GitHub webhook setup

1. In your repo on GitHub, go to **Settings → Webhooks → Add webhook**.
2. **Payload URL**: `https://deploy.example.com/webhook/<app-name>`
   — `<app-name>` must match a key under `apps:` in `/etc/deploystack/apps.yml`.
3. **Content type**: `application/json` (required — deploystack does not parse form-encoded bodies).
4. **Secret**: paste the same value stored in the `secret_env` environment variable for this app (e.g. `MY_APP_WEBHOOK_SECRET`).
5. **Which events?** → "Just the push event".
6. **Active**: checked.

GitHub will send a `ping` event immediately. The server should respond `200 {"ok":true,"msg":"pong"}` and the "Recent Deliveries" tab will show it green.

## Filtering

The server only deploys when **all** of these match:

- Event type is `push` (pings and other events are accepted but ignored).
- `ref` is `refs/heads/<branch>` where `<branch>` is the `branch` in the app config.
- `repository.clone_url` (or ssh/html) matches the `repo` in the app config (after normalization). This prevents a leaked webhook secret from being replayed across repos.
- HMAC-SHA256 of the raw body using the app's secret matches `X-Hub-Signature-256`.

## Redelivery

If your first real push fails due to misconfiguration, you can redeliver it from the GitHub webhook "Recent Deliveries" UI after fixing `/etc/deploystack/apps.yml` and restarting the service.

## Multiple apps, one server

Add another entry under `apps:`, another secret env var, and set up another GitHub webhook pointing at `/webhook/<other-app>`. Each app has its own queue/lock, so deploys of different apps can run concurrently.
