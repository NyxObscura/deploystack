"use strict";

// Optional GitHub IP allowlist. Pulls https://api.github.com/meta once at boot and
// every 6h. If GitHub is unreachable we keep the last known set (fail-closed if we
// never got one).

const https = require("node:https");

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { headers: { "user-agent": "deploystack", accept: "application/vnd.github+json" } },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`GET ${url} => ${res.statusCode}`));
        }
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch (err) {
            reject(err);
          }
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(10000, () => req.destroy(new Error("timeout")));
  });
}

function ipInCidr(ip, cidr) {
  // IPv4-only implementation (GitHub does publish IPv6 but most deployments
  // put deploystack behind nginx; this is a best-effort extra layer).
  if (!cidr.includes("/") || ip.includes(":")) return false;
  const [base, bitsStr] = cidr.split("/");
  const bits = parseInt(bitsStr, 10);
  const toInt = (s) => s.split(".").reduce((acc, b) => (acc << 8) | parseInt(b, 10), 0) >>> 0;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (toInt(ip) & mask) === (toInt(base) & mask);
}

class GitHubIpAllowlist {
  constructor({ logger, intervalMs = 6 * 60 * 60 * 1000 }) {
    this.logger = logger;
    this.intervalMs = intervalMs;
    this.cidrs = [];
    this.timer = null;
  }
  async refresh() {
    try {
      const meta = await fetchJson("https://api.github.com/meta");
      const hooks = Array.isArray(meta.hooks) ? meta.hooks : [];
      this.cidrs = hooks.filter((c) => typeof c === "string" && c.includes("/"));
      this.logger.info({ count: this.cidrs.length }, "refreshed GitHub hook CIDR allowlist");
    } catch (err) {
      this.logger.warn({ err: err.message }, "failed to refresh GitHub CIDR allowlist");
    }
  }
  start() {
    this.refresh();
    this.timer = setInterval(() => this.refresh(), this.intervalMs);
    this.timer.unref?.();
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
  }
  middleware() {
    return (req, res, next) => {
      if (this.cidrs.length === 0) {
        // fail-closed if we never succeeded in fetching the list
        return res.status(503).json({ error: "allowlist not ready" });
      }
      // Trust the socket IP. If you're behind a reverse proxy you must set
      // `app.set('trust proxy', ...)` appropriately.
      const ip = req.ip || req.socket.remoteAddress || "";
      const clean = ip.replace(/^::ffff:/, "");
      if (this.cidrs.some((c) => ipInCidr(clean, c))) return next();
      this.logger.warn({ ip: clean }, "blocked by GitHub IP allowlist");
      return res.status(403).json({ error: "ip not allowed" });
    };
  }
}

module.exports = { GitHubIpAllowlist, ipInCidr };
