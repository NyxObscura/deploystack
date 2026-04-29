"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { DeployQueue } = require("../src/queue");

function silentLogger() {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop };
  logger.child = () => logger;
  return logger;
}

test("queue serializes jobs and uses lock file", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsq-"));
  const lockFile = path.join(dir, "app.lock");
  const order = [];
  let active = 0;
  let maxActive = 0;
  const q = new DeployQueue({
    app: "test",
    lockFile,
    logger: silentLogger(),
    runner: async (job) => {
      active++;
      maxActive = Math.max(maxActive, active);
      assert.equal(fs.existsSync(lockFile), true, "lock file exists during deploy");
      await new Promise((r) => setTimeout(r, 20));
      order.push(job.id);
      active--;
    },
  });

  await Promise.all([
    new Promise((resolve, reject) => q.enqueue({ id: "a", source: "cli", resolve, reject })),
    new Promise((resolve, reject) => q.enqueue({ id: "b", source: "cli", resolve, reject })),
  ]);

  assert.equal(maxActive, 1, "at most one deploy runs at once");
  assert.deepEqual(order, ["a", "b"]);
  assert.equal(fs.existsSync(lockFile), false, "lock is released");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("webhook coalescing keeps only the newest queued webhook", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsq-"));
  const lockFile = path.join(dir, "app.lock");
  const ran = [];
  let release;
  const block = new Promise((r) => { release = r; });
  const q = new DeployQueue({
    app: "test",
    lockFile,
    logger: silentLogger(),
    runner: async (job) => {
      ran.push(job.id);
      if (job.id === "first") await block;
    },
  });

  const p1 = new Promise((resolve, reject) =>
    q.enqueue({ id: "first", source: "webhook", resolve, reject })
  );
  // Wait a tick so "first" is active
  await new Promise((r) => setImmediate(r));

  q.enqueue({ id: "second", source: "webhook", resolve: () => {}, reject: () => {} });
  q.enqueue({ id: "third", source: "webhook", resolve: () => {}, reject: () => {} });
  q.enqueue({ id: "fourth", source: "webhook", resolve: () => {}, reject: () => {} });

  release();
  await p1;
  // give the drain loop a chance
  await new Promise((r) => setTimeout(r, 50));

  // first ran, then only one of the later ones ran (the newest), the older queued
  // ones got coalesced away
  assert.equal(ran[0], "first");
  assert.equal(ran.length, 2);
  assert.equal(ran[1], "fourth");
  fs.rmSync(dir, { recursive: true, force: true });
});
