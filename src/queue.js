"use strict";

// Per-app FIFO deploy queue with on-disk lock.
//
// Guarantees:
//   - at most one deploy runs per app at a time (in-memory serialization)
//   - lock file prevents a second deploystack process on the same host from
//     clobbering the release dir (on-disk serialization, crash-safe)
//   - queued jobs are capped (oldest additional jobs are coalesced -- for an
//     auto-deploy system you only ever need "latest"; queuing 50 of them makes
//     no sense).

const fs = require("node:fs");
const path = require("node:path");

class DeployQueue {
  constructor({ app, lockFile, runner, logger, maxQueued = 1 }) {
    this.app = app;
    this.lockFile = lockFile;
    this.runner = runner;
    this.logger = logger;
    this.maxQueued = maxQueued;
    this.pending = []; // array of jobs waiting
    this.active = null; // currently running job
  }

  get depth() {
    return (this.active ? 1 : 0) + this.pending.length;
  }

  enqueue(job) {
    // Coalesce: if the queue already has `maxQueued` pending jobs from webhooks,
    // replace the tail with the newest one. The newest commit is what matters.
    if (job.source === "webhook" && this.pending.length >= this.maxQueued) {
      const dropped = this.pending.splice(this.maxQueued - 1).map((j) => j.id);
      if (dropped.length) {
        this.logger.warn(
          { app: this.app, dropped },
          "coalesced older webhook deploys in favor of newer commit"
        );
      }
    }
    this.pending.push(job);
    this.logger.info(
      { app: this.app, id: job.id, source: job.source, sha: job.sha, depth: this.depth },
      "deploy enqueued"
    );
    setImmediate(() => this._drain());
    return job;
  }

  async _drain() {
    if (this.active) return;
    const job = this.pending.shift();
    if (!job) return;
    this.active = job;

    // Acquire on-disk lock. If another deploystack process holds it, requeue and wait.
    let lockFd;
    try {
      lockFd = fs.openSync(this.lockFile, "wx");
      fs.writeSync(lockFd, `${process.pid}\n${new Date().toISOString()}\n`);
    } catch (err) {
      if (err.code === "EEXIST") {
        // Lock held by someone else (or stale). Check staleness.
        if (this._isLockStale()) {
          this.logger.warn({ app: this.app }, "removing stale lock file");
          fs.unlinkSync(this.lockFile);
          this.active = null;
          this.pending.unshift(job);
          setImmediate(() => this._drain());
          return;
        }
        this.logger.warn(
          { app: this.app, id: job.id },
          "lock held by another process; retrying in 5s"
        );
        this.active = null;
        this.pending.unshift(job);
        setTimeout(() => this._drain(), 5000);
        return;
      }
      this.logger.error({ err, app: this.app }, "failed to acquire lock");
      this.active = null;
      job.reject?.(err);
      setImmediate(() => this._drain());
      return;
    }

    job.startedAt = new Date();
    try {
      const result = await this.runner(job);
      job.resolve?.(result);
    } catch (err) {
      this.logger.error({ err, app: this.app, id: job.id }, "deploy failed");
      job.reject?.(err);
    } finally {
      job.finishedAt = new Date();
      try {
        fs.closeSync(lockFd);
        fs.unlinkSync(this.lockFile);
      } catch (e) {
        this.logger.warn({ err: e, app: this.app }, "failed to release lock");
      }
      this.active = null;
      setImmediate(() => this._drain());
    }
  }

  _isLockStale() {
    try {
      const stat = fs.statSync(this.lockFile);
      // stale if older than 2x deploy timeout
      const maxAgeMs = (parseInt(process.env.DEPLOYSTACK_DEPLOY_TIMEOUT || "900", 10) * 2) * 1000;
      return Date.now() - stat.mtimeMs > maxAgeMs;
    } catch {
      return true;
    }
  }

  snapshot() {
    return {
      app: this.app,
      active: this.active
        ? {
            id: this.active.id,
            sha: this.active.sha,
            ref: this.active.ref,
            source: this.active.source,
            startedAt: this.active.startedAt,
          }
        : null,
      pending: this.pending.map((j) => ({
        id: j.id,
        sha: j.sha,
        ref: j.ref,
        source: j.source,
      })),
    };
  }
}

class QueueManager {
  constructor({ cfg, logger, runner }) {
    this.cfg = cfg;
    this.logger = logger;
    this.runner = runner;
    this.queues = new Map();
    for (const name of Object.keys(cfg.apps)) {
      const lockFile = path.join(cfg.data, "state", `${name}.lock`);
      fs.mkdirSync(path.dirname(lockFile), { recursive: true });
      this.queues.set(
        name,
        new DeployQueue({
          app: name,
          lockFile,
          runner: (job) => runner(cfg.apps[name], job),
          logger: logger.child({ app: name }),
        })
      );
    }
  }

  enqueue(appName, job) {
    const q = this.queues.get(appName);
    if (!q) throw new Error(`Unknown app "${appName}"`);
    return q.enqueue(job);
  }

  snapshot() {
    return Array.from(this.queues.values()).map((q) => q.snapshot());
  }
}

module.exports = { DeployQueue, QueueManager };
