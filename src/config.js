"use strict";

const fs = require("node:fs");
const path = require("node:path");
const yaml = require("js-yaml");

const DEFAULTS = {
  host: process.env.DEPLOYSTACK_HOST || "127.0.0.1",
  port: parseInt(process.env.DEPLOYSTACK_PORT || "9000", 10),
  configPath: process.env.DEPLOYSTACK_CONFIG || "/etc/deploystack/apps.yml",
  root: process.env.DEPLOYSTACK_ROOT || "/srv/apps",
  data: process.env.DEPLOYSTACK_DATA || "/var/lib/deploystack",
  keepReleases: parseInt(process.env.DEPLOYSTACK_KEEP_RELEASES || "5", 10),
  deployTimeout: parseInt(process.env.DEPLOYSTACK_DEPLOY_TIMEOUT || "900", 10),
  githubIpAllowlist:
    (process.env.DEPLOYSTACK_GITHUB_IP_ALLOWLIST || "false").toLowerCase() === "true",
};

// Strict app name: matches GitHub webhook URL segment and filesystem path.
const APP_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;

function validateApp(name, app) {
  if (!APP_NAME_RE.test(name)) {
    throw new Error(`Invalid app name "${name}": must match ${APP_NAME_RE}`);
  }
  if (!app || typeof app !== "object") {
    throw new Error(`App "${name}" missing configuration`);
  }
  if (!app.repo || typeof app.repo !== "string") {
    throw new Error(`App "${name}" missing "repo"`);
  }
  if (!app.branch || typeof app.branch !== "string") {
    throw new Error(`App "${name}" missing "branch"`);
  }
  if (!app.secret_env || typeof app.secret_env !== "string") {
    throw new Error(`App "${name}" missing "secret_env"`);
  }
  const secret = process.env[app.secret_env];
  if (!secret || secret.length < 16) {
    throw new Error(
      `App "${name}": env var ${app.secret_env} is unset or too short (need >= 16 chars)`
    );
  }
  if (!app.pm2_name || typeof app.pm2_name !== "string") {
    throw new Error(`App "${name}" missing "pm2_name"`);
  }
  return {
    name,
    repo: app.repo,
    branch: app.branch,
    secret, // resolved secret, not the env var name
    pm2Name: app.pm2_name,
    packageManager: app.package_manager || "npm",
    installCommand: app.install_command || "npm ci --no-audit --no-fund",
    buildCommand: app.build_command || "npm run build",
    nodeVersion: app.node_version || "",
    sharedFiles: Array.isArray(app.shared_files) ? app.shared_files : [],
    sharedDirs: Array.isArray(app.shared_dirs) ? app.shared_dirs : [],
    healthcheckUrl: app.healthcheck_url || "",
    healthcheckTimeout: parseInt(app.healthcheck_timeout || "20", 10),
    keepReleases: parseInt(app.keep_releases || DEFAULTS.keepReleases, 10),
  };
}

function loadConfig(configPath = DEFAULTS.configPath) {
  if (!fs.existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}`);
  }
  const raw = fs.readFileSync(configPath, "utf8");
  const parsed = yaml.load(raw);
  if (!parsed || typeof parsed !== "object" || !parsed.apps) {
    throw new Error(`Config file ${configPath} must define "apps:"`);
  }
  const apps = {};
  for (const [name, cfg] of Object.entries(parsed.apps)) {
    apps[name] = validateApp(name, cfg);
  }
  return { ...DEFAULTS, configPath, apps };
}

function appRoot(cfg, name) {
  return path.join(cfg.root, name);
}

module.exports = {
  loadConfig,
  DEFAULTS,
  appRoot,
  APP_NAME_RE,
};
