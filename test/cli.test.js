"use strict";

const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");
process.env.DEPLOYSTACK_DATA =
  process.env.DEPLOYSTACK_DATA || fs.mkdtempSync(path.join(os.tmpdir(), "ds-data-"));

const test = require("node:test");
const assert = require("node:assert/strict");
const { parseArgs } = require("../src/cli");

test("parseArgs parses positionals and flags", () => {
  const r = parseArgs(["deploy", "my-app", "--ref", "refs/heads/main", "--sha", "abc123"]);
  assert.deepEqual(r._, ["deploy", "my-app"]);
  assert.deepEqual(r.flags, { ref: "refs/heads/main", sha: "abc123" });
});

test("parseArgs treats bare --flag as boolean", () => {
  const r = parseArgs(["logs", "my-app", "--follow"]);
  assert.deepEqual(r._, ["logs", "my-app"]);
  assert.deepEqual(r.flags, { follow: true });
});
