"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { verifySignature, normalizeRepo } = require("../src/webhook");

test("verifySignature accepts a valid HMAC-SHA256", () => {
  const secret = "supersecret";
  const body = Buffer.from('{"ref":"refs/heads/main"}', "utf8");
  const sig = "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex");
  assert.equal(verifySignature(body, secret, sig), true);
});

test("verifySignature rejects a bad HMAC", () => {
  const secret = "supersecret";
  const body = Buffer.from('{"ref":"refs/heads/main"}', "utf8");
  const sig =
    "sha256=" + crypto.createHmac("sha256", "other").update(body).digest("hex");
  assert.equal(verifySignature(body, secret, sig), false);
});

test("verifySignature rejects missing/wrong-prefix header", () => {
  const secret = "supersecret";
  const body = Buffer.from("{}", "utf8");
  assert.equal(verifySignature(body, secret, undefined), false);
  assert.equal(verifySignature(body, secret, ""), false);
  assert.equal(verifySignature(body, secret, "sha1=abc"), false);
});

test("verifySignature rejects length-mismatched signature (no timingSafeEqual crash)", () => {
  const secret = "supersecret";
  const body = Buffer.from("{}", "utf8");
  assert.equal(verifySignature(body, secret, "sha256=abcd"), false);
});

test("normalizeRepo handles https, ssh, and .git variants", () => {
  assert.equal(
    normalizeRepo("https://github.com/Acme/MyApp.git"),
    normalizeRepo("git@github.com:acme/myapp")
  );
  assert.equal(
    normalizeRepo("https://github.com/acme/myapp"),
    "acme/myapp"
  );
  assert.equal(normalizeRepo(""), "");
});
