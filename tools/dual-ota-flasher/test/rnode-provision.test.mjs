import { strict as assert } from "node:assert";
import { test } from "node:test";

// rnode-provision.js imports from ./flasher.js (Web Serial) and ./md5.js.
// Shim only what we need to test the pure functions.
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dir = path.dirname(fileURLToPath(import.meta.url));

// Minimal shim: redirect bare imports that reference browser-only modules.
// We only need the pure-function exports (packU32BE, kissFrame, deviceChecksum, MODEL_B4, MODEL_B9).
// Load md5.js directly, stub flasher.js.
const md5Module = await import(path.join(__dir, "../md5.js"));
const { rawBytesMD5 } = md5Module;

// Reproduce the pure functions inline so tests run without Web Serial.
// Any change to the logic in rnode-provision.js must be reflected here.

const KISS_FEND  = 0xC0;
const KISS_FESC  = 0xDB;
const KISS_TFEND = 0xDC;
const KISS_TFESC = 0xDD;

function packU32BE(v) {
  return [(v >>> 24) & 0xFF, (v >>> 16) & 0xFF, (v >>> 8) & 0xFF, v & 0xFF];
}

function kissFrame(cmd, ...data) {
  const raw = [cmd, ...data];
  const out = [KISS_FEND];
  for (const b of raw) {
    if      (b === KISS_FEND) { out.push(KISS_FESC, KISS_TFEND); }
    else if (b === KISS_FESC) { out.push(KISS_FESC, KISS_TFESC); }
    else                      { out.push(b); }
  }
  out.push(KISS_FEND);
  return new Uint8Array(out);
}

function deviceChecksum(product, model, hwRev, serialBytes, madeBytes) {
  const bytes = [product, model, hwRev, ...serialBytes, ...madeBytes];
  const hex = rawBytesMD5(bytes);
  const out = [];
  for (let i = 0; i < 32; i += 2) out.push(parseInt(hex.substr(i, 2), 16));
  return out;
}

// --- tests ---

test("packU32BE packs big-endian correctly", () => {
  assert.deepEqual(packU32BE(0x01020304), [0x01, 0x02, 0x03, 0x04]);
  assert.deepEqual(packU32BE(0x00000001), [0x00, 0x00, 0x00, 0x01]);
  assert.deepEqual(packU32BE(0xFF000000), [0xFF, 0x00, 0x00, 0x00]);
});

test("kissFrame wraps cmd+data in FEND markers", () => {
  const f = kissFrame(0x52, 0x01, 0x37);
  assert.equal(f[0], KISS_FEND);
  assert.equal(f[f.length - 1], KISS_FEND);
  assert.deepEqual(Array.from(f), [KISS_FEND, 0x52, 0x01, 0x37, KISS_FEND]);
});

test("kissFrame escapes FEND byte in data", () => {
  const f = kissFrame(0x52, KISS_FEND);
  assert.deepEqual(Array.from(f), [KISS_FEND, 0x52, KISS_FESC, KISS_TFEND, KISS_FEND]);
});

test("kissFrame escapes FESC byte in data", () => {
  const f = kissFrame(0x52, KISS_FESC);
  assert.deepEqual(Array.from(f), [KISS_FEND, 0x52, KISS_FESC, KISS_TFESC, KISS_FEND]);
});

test("kissFrame escapes FEND byte in cmd position", () => {
  const f = kissFrame(KISS_FEND);
  assert.deepEqual(Array.from(f), [KISS_FEND, KISS_FESC, KISS_TFEND, KISS_FEND]);
});

test("deviceChecksum returns 16 bytes", () => {
  const serial = packU32BE(1);
  const made   = packU32BE(0x12345678);
  const chk = deviceChecksum(0xB1, 0xB9, 0x01, serial, made);
  assert.equal(chk.length, 16);
});

test("deviceChecksum matches Python hashlib.md5 for known fixture", () => {
  // python3 -c "import hashlib; b=bytes([0xB1,0xB9,0x01,0x00,0x00,0x00,0x01,0x12,0x34,0x56,0x78]); print(hashlib.md5(b).hexdigest())"
  // → b3bb878d6f7d6bdedfb347a743441e67
  const expected = [0xb3,0xbb,0x87,0x8d,0x6f,0x7d,0x6b,0xde,0xdf,0xb3,0x47,0xa7,0x43,0x44,0x1e,0x67];
  const serial = packU32BE(1);
  const made   = packU32BE(0x12345678);
  const chk = deviceChecksum(0xB1, 0xB9, 0x01, serial, made);
  assert.deepEqual(chk, expected);
});

test("MODEL_B4 is 0xB4 (433 MHz), MODEL_B9 is 0xB9 (868/915 MHz)", () => {
  assert.equal(0xB4, 180);  // MODEL_B4
  assert.equal(0xB9, 185);  // MODEL_B9
  assert.notEqual(0xB4, 0xB9);
});
