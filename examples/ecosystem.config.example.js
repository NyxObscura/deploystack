// PM2 ecosystem file for a Next.js app deployed by deploystack.
//
// Key ideas for zero-downtime:
//   - `exec_mode: cluster` + `instances` >= 2 lets PM2 reload workers one at a time.
//   - `wait_ready: true` + `listen_timeout` lets Next.js signal "ready" before the old
//     worker is killed, preventing any dropped requests.
//   - `cwd` points to the `current` symlink. Each deploy atomically re-points it, and
//     the next `pm2 reload` picks it up because PM2 re-reads cwd on restart.
//
// Copy to /srv/apps/my-app/ecosystem.config.js and adjust paths.

module.exports = {
  apps: [
    {
      name: "my-app",
      cwd: "/srv/apps/my-app/current",
      script: "node_modules/next/dist/bin/next",
      args: "start -p 3000",
      exec_mode: "cluster",
      instances: "max", // or a fixed number, e.g. 2
      max_memory_restart: "1G",
      kill_timeout: 10000,
      listen_timeout: 15000,
      wait_ready: true,
      autorestart: true,
      merge_logs: true,
      out_file: "/var/log/deploystack/my-app.out.log",
      error_file: "/var/log/deploystack/my-app.err.log",
      env: {
        NODE_ENV: "production",
        PORT: "3000",
      },
    },
  ],
};
