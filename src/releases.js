"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { appRoot } = require("./config");

function releasesDir(cfg, appName) {
  return path.join(appRoot(cfg, appName), "releases");
}

function currentSymlink(cfg, appName) {
  return path.join(appRoot(cfg, appName), "current");
}

function sharedDir(cfg, appName) {
  return path.join(appRoot(cfg, appName), "shared");
}

function listReleases(cfg, appName) {
  const dir = releasesDir(cfg, appName);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const p = path.join(dir, d.name);
      const stat = fs.statSync(p);
      return { name: d.name, path: p, mtime: stat.mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

function currentRelease(cfg, appName) {
  const link = currentSymlink(cfg, appName);
  try {
    const target = fs.readlinkSync(link);
    // target is relative to the symlink's parent. Resolve to its basename.
    const abs = path.isAbsolute(target) ? target : path.resolve(path.dirname(link), target);
    return { name: path.basename(abs), path: abs };
  } catch {
    return null;
  }
}

function previousRelease(cfg, appName) {
  const all = listReleases(cfg, appName);
  const cur = currentRelease(cfg, appName);
  if (!cur) return all[0] || null;
  const idx = all.findIndex((r) => r.name === cur.name);
  if (idx < 0) return all[0] || null;
  return all[idx + 1] || null;
}

function findReleaseByName(cfg, appName, name) {
  return listReleases(cfg, appName).find((r) => r.name === name) || null;
}

module.exports = {
  releasesDir,
  currentSymlink,
  sharedDir,
  listReleases,
  currentRelease,
  previousRelease,
  findReleaseByName,
};
