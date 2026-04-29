"use strict";

// deploystack CLI
//
// Commands:
//   deploystack deploy <app> [--ref <ref>] [--sha <sha>]
//   deploystack rollback <app> [--to <build-id>]
//   deploystack logs <app> [--release <build-id>] [--tail N] [--follow]
//   deploystack status [<app>]
//   deploystack list <app>
//
// The CLI reads the same config as the server and runs deploys in-process.
// This means the CLI uses the same queue/lock logic on disk, so it will wait if
// a server-driven deploy is already in progress for that app.

const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const { loadConfig } = require("./config");
const { logger, deployLogPath, tailFile } = require("./logger");
const { QueueManager } = require("./queue");
const { runDeploy, runRollback } = require("./deployer");
const {
  listReleases,
  currentRelease,
  previousRelease,
} = require("./releases");

function parseArgs(argv) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        out.flags[key] = true;
      } else {
        out.flags[key] = next;
        i++;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

function usage() {
  return `deploystack <command> [args]

Commands:
  deploy <app> [--ref refs/heads/main] [--sha <sha>]
  rollback <app> [--to <build-id>]
  logs <app> [--release <build-id>] [--tail N] [--follow]
  status [<app>]
  list <app>
  help
`;
}

async function withQueue(cfg, fn) {
  const qm = new QueueManager({
    cfg,
    logger,
    runner: (app, job) => {
      if (job.kind === "rollback") {
        return runRollback(cfg, app, job);
      }
      return runDeploy(cfg, app, job);
    },
  });
  return fn(qm);
}

function cmdStatus(cfg, args) {
  const only = args._[1];
  const names = only ? [only] : Object.keys(cfg.apps);
  for (const name of names) {
    if (!cfg.apps[name]) {
      console.error(`unknown app: ${name}`);
      process.exitCode = 2;
      continue;
    }
    const cur = currentRelease(cfg, name);
    const prev = previousRelease(cfg, name);
    const rels = listReleases(cfg, name);
    console.log(`# ${name}`);
    console.log(`  current:  ${cur ? cur.name : "(none)"}`);
    console.log(`  previous: ${prev ? prev.name : "(none)"}`);
    console.log(`  releases: ${rels.length}`);
  }
}

function cmdList(cfg, args) {
  const name = args._[1];
  if (!name || !cfg.apps[name]) {
    console.error(`usage: deploystack list <app>`);
    process.exitCode = 2;
    return;
  }
  const cur = currentRelease(cfg, name);
  for (const r of listReleases(cfg, name)) {
    const marker = cur && cur.name === r.name ? "*" : " ";
    console.log(`${marker} ${r.name}\t${new Date(r.mtime).toISOString()}`);
  }
}

async function cmdDeploy(cfg, args) {
  const name = args._[1];
  if (!name || !cfg.apps[name]) {
    console.error(`usage: deploystack deploy <app> [--ref refs/heads/main] [--sha <sha>]`);
    process.exitCode = 2;
    return;
  }
  const ref = args.flags.ref || `refs/heads/${cfg.apps[name].branch}`;
  const sha = args.flags.sha || "";
  await withQueue(cfg, (qm) => {
    return new Promise((resolve, reject) => {
      qm.enqueue(name, {
        id: randomUUID(),
        source: "cli",
        ref,
        sha,
        enqueuedAt: new Date(),
        resolve,
        reject,
      });
    });
  });
  console.log(`[deploystack] deploy for ${name} completed`);
}

async function cmdRollback(cfg, args) {
  const name = args._[1];
  if (!name || !cfg.apps[name]) {
    console.error(`usage: deploystack rollback <app> [--to <build-id>]`);
    process.exitCode = 2;
    return;
  }
  const target = args.flags.to;
  await withQueue(cfg, (qm) => {
    return new Promise((resolve, reject) => {
      qm.enqueue(name, {
        id: randomUUID(),
        kind: "rollback",
        source: "cli",
        target,
        enqueuedAt: new Date(),
        resolve,
        reject,
      });
    });
  });
  console.log(`[deploystack] rollback for ${name} completed`);
}

async function cmdLogs(cfg, args) {
  const name = args._[1];
  if (!name || !cfg.apps[name]) {
    console.error(`usage: deploystack logs <app> [--release <build-id>] [--tail N] [--follow]`);
    process.exitCode = 2;
    return;
  }
  let release = args.flags.release;
  if (!release) {
    const cur = currentRelease(cfg, name);
    if (!cur) {
      console.error(`no current release for ${name}`);
      process.exitCode = 2;
      return;
    }
    release = cur.name;
  }
  const file = deployLogPath(name, release);
  if (!fs.existsSync(file)) {
    console.error(`no log file for release ${release}: ${file}`);
    process.exitCode = 2;
    return;
  }
  const tailN = parseInt(args.flags.tail || "500", 10);
  process.stdout.write(tailFile(file, tailN));
  if (args.flags.follow) {
    let size = fs.statSync(file).size;
    const watcher = fs.watch(file, () => {
      const s = fs.statSync(file).size;
      if (s > size) {
        const stream = fs.createReadStream(file, { start: size, end: s });
        stream.pipe(process.stdout, { end: false });
        size = s;
      } else if (s < size) {
        size = s; // log rotated/truncated
      }
    });
    process.on("SIGINT", () => {
      watcher.close();
      process.exit(0);
    });
    return new Promise(() => {});
  }
}

async function main(argv) {
  const args = parseArgs(argv);
  const cmd = args._[0];
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    process.stdout.write(usage());
    return;
  }
  let cfg;
  try {
    cfg = loadConfig();
  } catch (err) {
    console.error(`config error: ${err.message}`);
    process.exit(1);
  }
  try {
    switch (cmd) {
      case "status":
        cmdStatus(cfg, args);
        break;
      case "list":
        cmdList(cfg, args);
        break;
      case "deploy":
        await cmdDeploy(cfg, args);
        break;
      case "rollback":
        await cmdRollback(cfg, args);
        break;
      case "logs":
        await cmdLogs(cfg, args);
        break;
      default:
        console.error(`unknown command: ${cmd}`);
        console.error(usage());
        process.exit(2);
    }
  } catch (err) {
    console.error(`[deploystack] ${cmd} failed: ${err.message}`);
    process.exit(1);
  }
}

module.exports = { main, parseArgs };
