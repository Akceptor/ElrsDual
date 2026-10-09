import { test } from "node:test";
import assert from "node:assert/strict";
import { BRANCHES, RNODE_BOARDS, RNODE_IDENTITY, RNODE_CHIPS } from "../config.js";

test("BRANCHES includes rnode key", () => {
  assert.ok("rnode" in BRANCHES, "BRANCHES must have a 'rnode' key");
});

test("RNODE_BOARDS is non-empty", () => {
  assert.ok(Object.keys(RNODE_BOARDS).length > 0, "RNODE_BOARDS must have at least one entry");
});

test("RNODE_BOARDS values are valid CI artifact subdirectory names (alphanumeric + underscore)", () => {
  for (const [label, env] of Object.entries(RNODE_BOARDS)) {
    assert.match(env, /^[A-Za-z0-9_]+$/, `invalid env for "${label}": "${env}"`);
  }
});

test("RNODE_BOARDS values do not look like ELRS Unified envs", () => {
  for (const env of Object.values(RNODE_BOARDS)) {
    assert.doesNotMatch(env, /^Unified_/, `RNode env "${env}" looks like an ELRS env — check RNODE_BOARDS`);
  }
});

test("every RNODE_BOARDS entry has an RNODE_IDENTITY with product + 433/868 models", () => {
  for (const env of Object.values(RNODE_BOARDS)) {
    const id = RNODE_IDENTITY[env];
    assert.ok(id, `RNODE_IDENTITY missing for "${env}"`);
    assert.ok(Number.isInteger(id.product), `product missing for "${env}"`);
    assert.ok(Number.isInteger(id.model["433"]) && Number.isInteger(id.model["868"]), `models missing for "${env}"`);
  }
});

test("every RNODE_BOARDS entry has an RNODE_CHIPS entry", () => {
  for (const env of Object.values(RNODE_BOARDS)) {
    assert.ok(["ESP32", "ESP32-C3"].includes(RNODE_CHIPS[env]), `RNODE_CHIPS missing/invalid for "${env}"`);
  }
});

const hdr = (chipId) => { const b = new Uint8Array(24); b[0] = 0xE9; b[12] = chipId & 0xff; b[13] = chipId >> 8; return b; };

test("checkImageChip accepts matching ESP32 and ESP32-C3 headers", async () => {
  const { checkImageChip } = await import("../chipcheck.js");
  assert.equal(checkImageChip(hdr(0), "ESP32"), null);
  assert.equal(checkImageChip(hdr(5), "ESP32-C3"), null);
});

test("checkImageChip rejects mismatches and bad images", async () => {
  const { checkImageChip } = await import("../chipcheck.js");
  assert.match(checkImageChip(hdr(5), "ESP32"), /ESP32-C3/);
  assert.match(checkImageChip(hdr(0), "ESP32-C3"), /connected chip is ESP32-C3/);
  assert.match(checkImageChip(hdr(9), "ESP32"), /unknown chip_id 9/);
  assert.ok(checkImageChip(new Uint8Array(24), "ESP32"));
  assert.ok(checkImageChip(new Uint8Array(4), "ESP32"));
});
