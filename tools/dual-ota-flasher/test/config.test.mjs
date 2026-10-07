import { test } from "node:test";
import assert from "node:assert/strict";
import { BRANCHES, RNODE_BOARDS, RNODE_IDENTITY } from "../config.js";

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
