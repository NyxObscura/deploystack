"use strict";

// GitHub webhook handler with HMAC validation.
//
// Security:
//   - Validates X-Hub-Signature-256 using HMAC-SHA256 with constant-time compare.
//   - Rejects unsigned or mis-signed payloads.
//   - Limits body size (set in server.js).
//   - Only acts on "push" events to the configured branch.
//   - Ignores events for other repos (repo URL mismatch).
//
// NOTE: we must compute the HMAC over the RAW request body, not the parsed JSON.

const crypto = require("node:crypto");
const { randomUUID } = require("node:crypto");

const GITHUB_SIG_HEADER = "x-hub-signature-256";
const GITHUB_EVENT_HEADER = "x-github-event";
const GITHUB_DELIVERY_HEADER = "x-github-delivery";

function timingSafeEqualStr(a, b) {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function verifySignature(rawBody, secret, header) {
  if (!header || typeof header !== "string" || !header.startsWith("sha256=")) {
    return false;
  }
  const expected =
    "sha256=" + crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  return timingSafeEqualStr(expected, header);
}

// Normalize a repo URL to a comparable form: lower-case owner/name without .git
function normalizeRepo(url) {
  if (!url) return "";
  let s = String(url).toLowerCase().trim();
  s = s.replace(/\.git$/, "");
  // git@github.com:owner/name  ->  owner/name
  const m1 = s.match(/git@[^:]+:(.+)$/);
  if (m1) s = m1[1];
  // https://github.com/owner/name -> owner/name
  const m2 = s.match(/^https?:\/\/[^/]+\/(.+)$/);
  if (m2) s = m2[1];
  return s;
}

function createWebhookRouter({ cfg, queueManager, logger }) {
  const express = require("express");
  const router = express.Router();

  // We need the raw body to compute the HMAC. Attach it via express.raw().
  const rawJson = express.raw({
    type: "application/json",
    limit: "2mb",
  });

  router.post("/webhook/:app", rawJson, (req, res) => {
    const appName = req.params.app;
    const app = cfg.apps[appName];
    if (!app) {
      return res.status(404).json({ error: "unknown app" });
    }

    const sig = req.header(GITHUB_SIG_HEADER);
    const event = req.header(GITHUB_EVENT_HEADER);
    const delivery = req.header(GITHUB_DELIVERY_HEADER) || randomUUID();

    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return res.status(400).json({ error: "empty body" });
    }

    if (!verifySignature(req.body, app.secret, sig)) {
      logger.warn(
        { app: appName, delivery, ip: req.ip },
        "webhook rejected: invalid signature"
      );
      return res.status(401).json({ error: "invalid signature" });
    }

    // Respond to GitHub's ping event for setup testing.
    if (event === "ping") {
      return res.status(200).json({ ok: true, msg: "pong" });
    }
    if (event !== "push") {
      return res.status(202).json({ ok: true, ignored: event });
    }

    let payload;
    try {
      payload = JSON.parse(req.body.toString("utf8"));
    } catch {
      return res.status(400).json({ error: "invalid json" });
    }

    const ref = payload.ref; // e.g. "refs/heads/main"
    const branch = ref ? ref.replace(/^refs\/heads\//, "") : "";
    if (branch !== app.branch) {
      logger.info(
        { app: appName, branch, expected: app.branch, delivery },
        "webhook ignored: branch mismatch"
      );
      return res.status(202).json({ ok: true, ignored: "branch" });
    }

    // Ignore pushes that are branch deletions
    if (payload.deleted) {
      return res.status(202).json({ ok: true, ignored: "deleted" });
    }

    // Repo URL sanity check (prevents a leaked secret on app A from triggering deploys
    // for app B pointing at a different repo).
    const repoClone =
      (payload.repository && (payload.repository.clone_url || payload.repository.ssh_url || payload.repository.html_url)) ||
      "";
    if (normalizeRepo(repoClone) !== normalizeRepo(app.repo)) {
      logger.warn(
        { app: appName, got: repoClone, expected: app.repo, delivery },
        "webhook rejected: repo mismatch"
      );
      return res.status(400).json({ error: "repo mismatch" });
    }

    const sha = payload.after || "";
    if (!/^[0-9a-f]{7,40}$/i.test(sha)) {
      return res.status(400).json({ error: "invalid commit sha" });
    }

    const job = {
      id: delivery,
      source: "webhook",
      ref,
      sha,
      pusher: payload.pusher && payload.pusher.name,
      enqueuedAt: new Date(),
    };
    queueManager.enqueue(appName, job);

    return res.status(202).json({ ok: true, queued: true, id: job.id });
  });

  return router;
}

module.exports = {
  createWebhookRouter,
  verifySignature,
  normalizeRepo,
};
