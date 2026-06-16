import { test } from "node:test";
import assert from "node:assert/strict";
import { generateUID, domainNumber, buildDefines } from "../configure.js";

test("generateUID: comma-separated ints are left-padded to 6 bytes", () => {
  assert.deepEqual([...generateUID("1,2,3,4")], [0, 0, 1, 2, 3, 4]);
});

test("generateUID: phrase falls back to md5[0:6]", () => {
  assert.deepEqual([...generateUID("test")], [79, 4, 253, 130, 33, 85]);
});

test("domainNumber maps per binary_configurator", () => {
  assert.equal(domainNumber("eu_868"), 2);
  assert.equal(domainNumber("fcc_915"), 1);
  assert.equal(domainNumber("us_433_wide"), 7);
});

test("buildDefines emits uid + domain + fixed discriminator as compact JSON", () => {
  const json = buildDefines({ phrase: "1,2,3,4", domain: "eu_868", discriminator: 123 });
  assert.equal(json, '{"uid":[0,0,1,2,3,4],"domain":2,"flash-discriminator":123}');
});
