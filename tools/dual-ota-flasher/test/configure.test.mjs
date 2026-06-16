import { test } from "node:test";
import assert from "node:assert/strict";
import { generateUID, domainNumber, buildDefines, findFirmwareEnd } from "../configure.js";

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

function makeEsp32Image(segments, segSizes) {
  // 24-byte header (magic 0xe9, segment count), then per-segment [addr u32, size u32, data...]
  const total = 24 + segSizes.reduce((a, s) => a + 8 + s, 0);
  const buf = new Uint8Array(total + 64);
  const dv = new DataView(buf.buffer);
  buf[0] = 0xe9; buf[1] = segments;
  let p = 24;
  for (const s of segSizes) { dv.setUint32(p, 0, true); dv.setUint32(p + 4, s, true); p += 8 + s; }
  return { buf, dataEnd: p };
}

test("findFirmwareEnd walks segments, aligns 16, adds 32", () => {
  const { buf, dataEnd } = makeEsp32Image(3, [16, 32, 48]);
  const expected = (((dataEnd + 16) & ~15) >>> 0) + 32;
  assert.equal(findFirmwareEnd(buf), expected);
});

test("findFirmwareEnd rejects bad magic", () => {
  assert.throws(() => findFirmwareEnd(new Uint8Array([0x00, 1, 0, 0])));
});
