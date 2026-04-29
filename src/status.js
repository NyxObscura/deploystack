"use strict";

const express = require("express");
const { listReleases, currentRelease } = require("./releases");

function createStatusRouter({ cfg, queueManager, startedAt }) {
  const router = express.Router();

  router.get("/status", (_req, res) => {
    const apps = {};
    for (const name of Object.keys(cfg.apps)) {
      const cur = currentRelease(cfg, name);
      const rels = listReleases(cfg, name);
      apps[name] = {
        current: cur ? cur.name : null,
        releases: rels.slice(0, cfg.apps[name].keepReleases).map((r) => ({
          name: r.name,
          mtime: new Date(r.mtime).toISOString(),
        })),
      };
    }
    const queues = queueManager.snapshot();
    for (const q of queues) {
      if (apps[q.app]) {
        apps[q.app].queue = { active: q.active, pending: q.pending };
      }
    }
    res.json({
      ok: true,
      version: require("../package.json").version,
      startedAt: startedAt.toISOString(),
      uptimeSec: Math.round((Date.now() - startedAt.getTime()) / 1000),
      apps,
    });
  });

  router.get("/healthz", (_req, res) => {
    res.json({ ok: true });
  });

  return router;
}

module.exports = { createStatusRouter };
