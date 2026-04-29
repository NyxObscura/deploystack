"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { logger, deployLogPath } = require("./logger");
const { appRoot } = require("./config");
const { currentRelease, findReleaseByName, releasesDir } = require("./releases");

const SCRIPTS_DIR = path.resolve(__dirname, "..", "scripts");
const DEPLOY_SCRIPT = path.join(SCRIPTS_DIR, "deploy.sh");
const ROLLBACK_SCRIPT = path.join(SCRIPTS_DIR, "rollback.sh");

function ts() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return (
    d.getUTCFullYear().toString() +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    "-" +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds())
  );
}

function buildReleaseId(sha) {
  const short = (sha || "nosha").slice(0, 12);
  return `build-${ts()}-${short}`;
}

function buildEnv(cfg, app, releaseId, sha, ref) {
  return {
    ...process.env,
    DS_APP_NAME: app.name,
    DS_APP_ROOT: appRoot(cfg, app.name),
    DS_RELEASES_DIR: releasesDir(cfg, app.name),
    DS_SHARED_DIR: path.join(appRoot(cfg, app.name), "shared"),
    DS_CURRENT_LINK: path.join(appRoot(cfg, app.name), "current"),
    DS_RELEASE_ID: releaseId,
    DS_REPO_URL: app.repo,
    DS_BRANCH: app.branch,
    DS_REF: ref || "",
    DS_SHA: sha || "",
    DS_INSTALL_CMD: app.installCommand,
    DS_BUILD_CMD: app.buildCommand,
    DS_PM2_NAME: app.pm2Name,
    DS_NODE_VERSION: app.nodeVersion || "",
    DS_SHARED_FILES: (app.sharedFiles || []).join("\n"),
    DS_SHARED_DIRS: (app.sharedDirs || []).join("\n"),
    DS_HEALTHCHECK_URL: app.healthcheckUrl || "",
    DS_HEALTHCHECK_TIMEOUT: String(app.healthcheckTimeout || 20),
    DS_KEEP_RELEASES: String(app.keepReleases),
    DS_DATA_DIR: cfg.data,
  };
}

function runScript({ script, env, logFile, timeoutSec }) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    const out = fs.openSync(logFile, "a");
    try {
      fs.writeSync(
        out,
        `\n\n===== ${new Date().toISOString()} running ${path.basename(script)} =====\n`
      );
    } catch {}

    const child = spawn("/bin/bash", [script], {
      env,
      stdio: ["ignore", out, out],
      detached: false,
    });

    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      logger.error({ pid: child.pid, script }, "deploy timed out; killing process group");
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {}
      setTimeout(() => {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {}
      }, 5000);
    }, timeoutSec * 1000);

    child.on("error", (err) => {
      clearTimeout(timer);
      try { fs.closeSync(out); } catch {}
      reject(err);
    });

    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      try {
        fs.writeSync(
          out,
          `\n===== exit code=${code} signal=${signal} =====\n`
        );
      } catch {}
      try { fs.closeSync(out); } catch {}
      if (killed) {
        return reject(new Error(`timed out after ${timeoutSec}s`));
      }
      if (code === 0) return resolve();
      reject(new Error(`exit code ${code}${signal ? ` (signal ${signal})` : ""}`));
    });
  });
}

// Creates and executes a deploy job. Called by the queue.
async function runDeploy(cfg, app, job) {
  const releaseId = job.releaseId || buildReleaseId(job.sha);
  job.releaseId = releaseId;
  const logFile = deployLogPath(app.name, releaseId);
  const env = buildEnv(cfg, app, releaseId, job.sha, job.ref);

  logger.info(
    { app: app.name, id: job.id, releaseId, sha: job.sha, source: job.source, logFile },
    "deploy starting"
  );

  await runScript({
    script: DEPLOY_SCRIPT,
    env,
    logFile,
    timeoutSec: cfg.deployTimeout,
  });

  logger.info({ app: app.name, releaseId }, "deploy succeeded");
  return { releaseId, logFile };
}

// Rollback to a specific release (or the previous one if not provided).
async function runRollback(cfg, app, { target, source, id }) {
  const targetName =
    typeof target === "string" && target
      ? target
      : (require("./releases").previousRelease(cfg, app.name) || {}).name;
  if (!targetName) {
    throw new Error(`No previous release to roll back to for ${app.name}`);
  }
  const rel = findReleaseByName(cfg, app.name, targetName);
  if (!rel) {
    throw new Error(`Release "${targetName}" not found for ${app.name}`);
  }

  const rollbackId = id || randomUUID();
  const logFile = deployLogPath(app.name, `rollback-${rollbackId}`);
  const env = buildEnv(cfg, app, targetName, "", "");
  env.DS_ROLLBACK_TARGET = rel.path;

  logger.info(
    { app: app.name, rollbackId, target: targetName, source },
    "rollback starting"
  );
  await runScript({
    script: ROLLBACK_SCRIPT,
    env,
    logFile,
    timeoutSec: cfg.deployTimeout,
  });
  logger.info({ app: app.name, target: targetName }, "rollback succeeded");
  return { target: targetName, logFile };
}

module.exports = { runDeploy, runRollback, buildReleaseId };
