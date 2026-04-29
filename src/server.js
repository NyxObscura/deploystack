"use strict";

const fs = require("node:fs");
const path = require("node:path");
const express = require("express");

const { loadConfig } = require("./config");
const { logger } = require("./logger");
const { QueueManager } = require("./queue");
const { createWebhookRouter } = require("./webhook");
const { createStatusRouter } = require("./status");
const { runDeploy } = require("./deployer");
const { GitHubIpAllowlist } = require("./ipAllowlist");

function ensureDirs(cfg) {
  fs.mkdirSync(cfg.root, { recursive: true });
  fs.mkdirSync(cfg.data, { recursive: true });
  fs.mkdirSync(path.join(cfg.data, "state"), { recursive: true });
  fs.mkdirSync(path.join(cfg.data, "logs", "deploys"), { recursive: true });
  for (const name of Object.keys(cfg.apps)) {
    const appDir = path.join(cfg.root, name);
    fs.mkdirSync(path.join(appDir, "releases"), { recursive: true });
    fs.mkdirSync(path.join(appDir, "shared"), { recursive: true });
  }
}

async function main() {
  let cfg;
  try {
    cfg = loadConfig();
  } catch (err) {
    logger.fatal({ err: err.message }, "config load failed");
    process.exit(1);
  }
  ensureDirs(cfg);

  const queueManager = new QueueManager({
    cfg,
    logger,
    runner: (app, job) => runDeploy(cfg, app, job),
  });

  const startedAt = new Date();
  const app = express();
  app.disable("x-powered-by");

  // Trust the loopback / private proxy so req.ip is meaningful when behind nginx.
  app.set("trust proxy", "loopback, linklocal, uniquelocal");

  // Optional IP allowlist on webhook routes only.
  if (cfg.githubIpAllowlist) {
    const allow = new GitHubIpAllowlist({ logger });
    allow.start();
    app.use("/webhook", allow.middleware());
  }

  app.use(createWebhookRouter({ cfg, queueManager, logger }));
  app.use(createStatusRouter({ cfg, queueManager, startedAt }));

  // JSON 404 fallback
  app.use((req, res) => res.status(404).json({ error: "not found" }));

  // JSON error handler
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    logger.error({ err }, "unhandled error");
    res.status(500).json({ error: "internal error" });
  });

  const server = app.listen(cfg.port, cfg.host, () => {
    logger.info(
      { host: cfg.host, port: cfg.port, apps: Object.keys(cfg.apps) },
      "deploystack listening"
    );
  });

  const shutdown = (sig) => {
    logger.info({ sig }, "shutting down");
    server.close(() => process.exit(0));
    // hard-exit safety net
    setTimeout(() => process.exit(1), 15000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("unhandledRejection", (reason) => {
    logger.error({ reason }, "unhandledRejection");
  });
  process.on("uncaughtException", (err) => {
    logger.error({ err }, "uncaughtException");
    // Let the process die; PM2/systemd will restart it.
    process.exit(1);
  });
}

if (require.main === module) {
  main();
}

module.exports = { main };
