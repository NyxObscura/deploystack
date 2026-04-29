"use strict";

const fs = require("node:fs");
const path = require("node:path");
const pino = require("pino");

const LOG_LEVEL = process.env.LOG_LEVEL || "info";
const DATA_DIR = process.env.DEPLOYSTACK_DATA || "/var/lib/deploystack";
const SERVER_LOG_DIR = path.join(DATA_DIR, "logs", "server");

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function createServerLogger() {
  ensureDir(SERVER_LOG_DIR);
  const logFile = path.join(SERVER_LOG_DIR, "deploystack.log");
  // Pretty stream to stderr for humans, file stream for durability.
  const streams = [
    { level: LOG_LEVEL, stream: fs.createWriteStream(logFile, { flags: "a" }) },
  ];
  if (process.stdout.isTTY) {
    const pretty = require("pino-pretty")({
      colorize: true,
      translateTime: "SYS:HH:MM:ss.l",
      ignore: "pid,hostname",
    });
    streams.push({ level: LOG_LEVEL, stream: pretty });
  } else {
    streams.push({ level: LOG_LEVEL, stream: process.stdout });
  }
  return pino({ level: LOG_LEVEL, base: { svc: "deploystack" } }, pino.multistream(streams));
}

const logger = createServerLogger();

// Per-deploy log path: <data>/logs/deploys/<app>/<release>.log
function deployLogPath(app, releaseId) {
  const dir = path.join(DATA_DIR, "logs", "deploys", app);
  ensureDir(dir);
  return path.join(dir, `${releaseId}.log`);
}

// Tail the last `lines` lines of a file without reading the whole thing.
function tailFile(file, lines = 200) {
  if (!fs.existsSync(file)) return "";
  const stat = fs.statSync(file);
  const CHUNK = 64 * 1024;
  let pos = stat.size;
  let collected = Buffer.alloc(0);
  const fd = fs.openSync(file, "r");
  try {
    while (pos > 0 && collected.toString("utf8").split("\n").length <= lines + 1) {
      const readSize = Math.min(CHUNK, pos);
      pos -= readSize;
      const buf = Buffer.alloc(readSize);
      fs.readSync(fd, buf, 0, readSize, pos);
      collected = Buffer.concat([buf, collected]);
    }
  } finally {
    fs.closeSync(fd);
  }
  const text = collected.toString("utf8");
  const split = text.split("\n");
  return split.slice(Math.max(0, split.length - lines - 1)).join("\n");
}

module.exports = {
  logger,
  deployLogPath,
  tailFile,
  DATA_DIR,
};
