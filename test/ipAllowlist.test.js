"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { ipInCidr } = require("../src/ipAllowlist");

test("ipInCidr matches /8", () => {
  assert.equal(ipInCidr("10.1.2.3", "10.0.0.0/8"), true);
  assert.equal(ipInCidr("11.1.2.3", "10.0.0.0/8"), false);
});

test("ipInCidr matches /24", () => {
  assert.equal(ipInCidr("192.168.1.10", "192.168.1.0/24"), true);
  assert.equal(ipInCidr("192.168.2.10", "192.168.1.0/24"), false);
});

test("ipInCidr ignores IPv6 (best-effort IPv4 only)", () => {
  assert.equal(ipInCidr("::1", "192.168.0.0/16"), false);
});
