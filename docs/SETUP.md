# deploystack setup (Ubuntu VPS, production)

This guide walks through a production install on a fresh Ubuntu 22.04+ VPS. Commands assume `root` or a user with `sudo`.

## 1. System prerequisites

```bash
sudo apt update
sudo apt install -y curl git build-essential jq
# Node.js 20 LTS
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
# PM2, globally
sudo npm install -g pm2
```

## 2. Create a dedicated `deploy` user

deploystack must NOT run as root. Everything — webhook server, PM2, git fetch, `next build` — runs as an unprivileged user.

```bash
sudo adduser --disabled-password --gecos "" deploy
sudo loginctl enable-linger deploy   # so user-level PM2 survives reboots
```

## 3. Install deploystack

```bash
sudo mkdir -p /opt/deploystack
sudo chown deploy:deploy /opt/deploystack
sudo -u deploy git clone https://github.com/<your-org>/deploystack.git /opt/deploystack
sudo -u deploy bash -c 'cd /opt/deploystack && npm ci --omit=dev'
```

## 4. Create runtime directories

```bash
sudo mkdir -p /srv/apps /var/lib/deploystack /var/log/deploystack /etc/deploystack
sudo chown -R deploy:deploy /srv/apps /var/lib/deploystack /var/log/deploystack
sudo chmod 750 /etc/deploystack
```

## 5. Configure apps

Copy the example config:

```bash
sudo cp /opt/deploystack/examples/apps.example.yml /etc/deploystack/apps.yml
sudoedit /etc/deploystack/apps.yml
```

Adjust the `repo`, `branch`, `pm2_name`, and `secret_env` for each app. Generate a strong webhook secret:

```bash
openssl rand -hex 32
```

## 6. Create the environment file

```bash
sudo tee /etc/deploystack/env >/dev/null <<'EOF'
DEPLOYSTACK_HOST=127.0.0.1
DEPLOYSTACK_PORT=9000
DEPLOYSTACK_CONFIG=/etc/deploystack/apps.yml
DEPLOYSTACK_ROOT=/srv/apps
DEPLOYSTACK_DATA=/var/lib/deploystack
DEPLOYSTACK_KEEP_RELEASES=5
DEPLOYSTACK_DEPLOY_TIMEOUT=900
DEPLOYSTACK_GITHUB_IP_ALLOWLIST=false
LOG_LEVEL=info

# Per-app secrets referenced in apps.yml via secret_env:
MY_APP_WEBHOOK_SECRET=<hex-from-openssl>
EOF
sudo chown root:deploy /etc/deploystack/env
sudo chmod 640 /etc/deploystack/env
```

## 7. Set up PM2 for the `deploy` user

```bash
sudo -u deploy -H pm2 status || true
sudo env PATH="$PATH" pm2 startup systemd -u deploy --hp /home/deploy
# then run the command pm2 prints (as root) to install the user-level pm2 systemd unit.
```

Copy the example ecosystem file for your first app:

```bash
sudo -u deploy mkdir -p /srv/apps/my-app
sudo -u deploy cp /opt/deploystack/examples/ecosystem.config.example.js /srv/apps/my-app/ecosystem.config.js
sudoedit /srv/apps/my-app/ecosystem.config.js
```

## 8. Install the deploystack systemd unit

```bash
sudo install -m 644 /opt/deploystack/systemd/deploystack.service /etc/systemd/system/deploystack.service
sudo systemctl daemon-reload
sudo systemctl enable --now deploystack
sudo systemctl status deploystack --no-pager
```

## 9. First deploy (manually, from the CLI)

Before pointing GitHub at the server, do a dry run from the command line to verify install/build/reload works:

```bash
sudo -u deploy -H bash -lc 'set -a; . /etc/deploystack/env; set +a; /opt/deploystack/bin/deploystack deploy my-app'
sudo -u deploy -H pm2 status
sudo -u deploy -H /opt/deploystack/bin/deploystack status
```

## 10. Expose the webhook through nginx with TLS

Never expose the Node process directly to the internet. Put it behind nginx with TLS:

```nginx
server {
    listen 443 ssl http2;
    server_name deploy.example.com;

    ssl_certificate     /etc/letsencrypt/live/deploy.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/deploy.example.com/privkey.pem;

    # Reject oversize payloads (GitHub hook bodies are usually < 100 KB)
    client_max_body_size 2m;

    # Only webhook + status are public.
    location = /status { proxy_pass http://127.0.0.1:9000/status; }
    location = /healthz { proxy_pass http://127.0.0.1:9000/healthz; }
    location /webhook/ {
        proxy_pass http://127.0.0.1:9000;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 30s;
    }
    location / { return 404; }
}
```

## 11. Point GitHub at it

See [`WEBHOOK.md`](./WEBHOOK.md).

## 12. Rollback

```bash
sudo -u deploy -H bash -lc 'set -a; . /etc/deploystack/env; set +a; /opt/deploystack/bin/deploystack rollback my-app'
# or a specific build:
sudo -u deploy -H bash -lc 'set -a; . /etc/deploystack/env; set +a; /opt/deploystack/bin/deploystack rollback my-app --to build-20250101-120000-abcdef'
```

## 13. Logs

```bash
# Per-deploy log of the current release
sudo -u deploy -H bash -lc 'set -a; . /etc/deploystack/env; set +a; /opt/deploystack/bin/deploystack logs my-app --tail 200'

# Follow live:
sudo -u deploy -H bash -lc 'set -a; . /etc/deploystack/env; set +a; /opt/deploystack/bin/deploystack logs my-app --follow'

# PM2 runtime logs (app stdout/stderr):
sudo -u deploy -H pm2 logs my-app

# deploystack server log:
tail -f /var/lib/deploystack/logs/server/deploystack.log
```
