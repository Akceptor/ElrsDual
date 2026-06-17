# Dual-OTA Web Builder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the existing browser flasher so it can build an ELRS image on demand (v3.6.3/v4 branch, chosen ESP32 target) in GitHub Actions, configure it in-browser, and stage it into an OTA slot — and be hostable on GitHub Pages.

**Architecture:** A `workflow_dispatch` CI job compiles a *generic* `firmware.bin` per `{branch, env}` and commits it to a force-pushed orphan `flasher-artifacts` branch. The browser triggers the build with a user-pasted PAT, polls the run, pulls the bin via the Git Blobs API (CORS-safe), specializes it to the target/domain/phrase in JS (logic ported from `python/binary_configurator.py` + `UnifiedConfiguration.py`), and stages it into app0/app1 reusing the existing `flasher.js` write paths.

**Tech Stack:** Static HTML/ES modules, Web Serial via `esptool-bundle.js`, GitHub REST API (`api.github.com`), GitHub Actions + PlatformIO, Node built-in test runner (`node:test`) for the pure-JS configurator, Python (for the byte-parity reference).

**Branch:** All work on `dual-ota-builder` (already created off `dual-ota-flasher`).

---

## Reference facts (from the codebase)

- **Unified config block** appended after firmware end (`UnifiedConfiguration.appendToFirmware`, `src/python/UnifiedConfiguration.py:38`):
  `product_name`(128B null-padded) + `lua_name`(16B) + `defines` JSON(512B) + `layout` JSON(2048B), then optional logo / `prior_target_name`. We only emit the first four blocks.
- **`findFirmwareEnd`** (`UnifiedConfiguration.py:13`): read `<BBBBI` at 0; require magic `0xe9`. If `segments==2` → ESP8266/85 path (not used here). Else seek to 24, walk `segments` segment headers (each `<II` addr,size; skip `size` bytes), then `pos = (pos+16) & ~15`, then `pos += 32`.
- **`generateUID`** (`binary_configurator.py:33`): if phrase is 4–6 comma-separated ints in 0–255 → left-pad with zeros to 6 bytes; else `md5('-DMY_BINDING_PHRASE="'+phrase+'"')[0:6]`.
  - Vector: `"1,2,3,4"` → `[0,0,1,2,3,4]`; `"test"` → `[79,4,253,130,33,85]`.
- **`json_flags`** (`binary_configurator.py:70` `patch_unified`): keys we set — `uid` (phrase), `domain` (number), `flash-discriminator` (random uint32). Optional later: `wifi-ssid`, `rcvr-uart-baud`, `tlm-interval`, etc.
- **`domain_number`** (`binary_configurator.py:52`): au_915=0, fcc_915=1, eu_868=2, in_866=3, au_433=4, eu_433=5, us_433=6, us_433_wide=7.
- **Target dict** (`targets.json`): keys `product_name`, `lua_name`, `layout_file`, `firmware`, `platform`, optional `overlay`. Layout path = `hardware/{TX|RX}/{layout_file}`; TX if `'_TX' in firmware`.
- **Target→env**: env = `firmware` + `_via_UART` (per `build-flash-elrs` skill).
- **Build domain flag**: 2400 envs → `-DRegulatory_Domain_ISM_2400`; 900/LR1121 envs → `-DRegulatory_Domain_FCC_915` (overridden in-browser; just satisfies the compiler).
- **`flasher.js`** imports `{ ESPLoader, Transport } from "./esptool-bundle.js"`; module-scope `esploader`/`transport`; constants `APP0_ADDR=0x10000`, `APP1_ADDR=0x1F0000`; `flashSlot(file,address,label)`, `log(msg)`, `setBusy(busy)`; button IDs incl. `connect,flash,flash0,flash1`; file inputs `v3file`,`v4file`; controls hidden in `#controls`; log `#log`.

---

## File structure

- Create `tools/dual-ota-flasher/config.js` — repo owner/name (+ Pages auto-detect), branch→ref map, artifact-branch name, domain list.
- Create `tools/dual-ota-flasher/md5.js` — vendored MIT blueimp-md5 (UID hashing; no MD5 in SubtleCrypto).
- Create `tools/dual-ota-flasher/configure.js` — `generateUID`, `domainNumber`, `buildDefines`, `findFirmwareEnd`, `appendConfig`.
- Create `tools/dual-ota-flasher/targets.js` — pure helpers `filterEsp32Targets`, `flattenTargets`, `targetToEnv`, `bandBuildFlag`.
- Create `tools/dual-ota-flasher/github.js` — `buildApiBase`, `dispatchBuild`, `findRunByTag`, `fetchArtifactBin`.
- Create `tools/dual-ota-flasher/builder.js` — browser orchestration + staging; imports from the above and from `flasher.js`.
- Modify `tools/dual-ota-flasher/flasher.js` — export `flashData`, `log`, `setBusy`, `isConnected`; refactor `flashSlot` to delegate to `flashData`.
- Modify `tools/dual-ota-flasher/index.html` — add Build section + token field; load `builder.js`.
- Create `tools/dual-ota-flasher/test/package.json` + `*.test.mjs` — Node tests.
- Create `tools/dual-ota-flasher/test/gen_reference.py` — Python parity reference generator.
- Create `.github/workflows/flasher-build.yml` — on-demand build → orphan branch.
- Create `.github/workflows/flasher-pages.yml` — deploy tool to GitHub Pages.
- Modify `tools/dual-ota-flasher/README.md` — builder usage + Pages instructions.

---

## Task 1: Test harness + config constants

**Files:**
- Create: `tools/dual-ota-flasher/test/package.json`
- Create: `tools/dual-ota-flasher/config.js`

- [ ] **Step 1: Create the test package manifest**

`tools/dual-ota-flasher/test/package.json`:
```json
{
  "name": "dual-ota-flasher-tests",
  "private": true,
  "type": "module",
  "scripts": { "test": "node --test" }
}
```

- [ ] **Step 2: Create config.js**

`tools/dual-ota-flasher/config.js`:
```js
// Static config for the builder. Safe to serve publicly (no secrets).
export const REPO = detectRepo();
export const ARTIFACT_BRANCH = "flasher-artifacts";
export const BUILD_WORKFLOW = "flasher-build.yml";
// Branch that HOSTS the workflow file — this is the ref we dispatch (workflow_dispatch
// requires the file to exist on the dispatched ref). The version branch to *compile* is
// passed separately as the checkout_ref input. Set to your default branch after merge.
export const WORKFLOW_REF = "dual-ota-builder";

// branch label shown in UI -> git ref the workflow checks out
export const BRANCHES = {
  "v3.6.3": "lua-slot/v3.6.3",
  "v4": "lua-slot/v4",
};

export const DOMAINS = ["eu_868", "fcc_915", "au_915", "in_866", "au_433", "eu_433", "us_433", "us_433_wide"];

// Owner/repo for api.github.com + raw.githubusercontent.com.
// On *.github.io this is inferred; override the fallback for local serving.
function detectRepo() {
  const host = (typeof location !== "undefined" && location.hostname) || "";
  if (host.endsWith(".github.io")) {
    const owner = host.replace(".github.io", "");
    const repo = (location.pathname.split("/").filter(Boolean)[0]) || `${owner}.github.io`;
    return { owner, repo };
  }
  return { owner: "vostapiv", repo: "ExpressLRS" }; // fallback for localhost; edit if forked
}
```

- [ ] **Step 3: Commit**

```bash
git add tools/dual-ota-flasher/test/package.json tools/dual-ota-flasher/config.js
git commit -m "chore(web-builder): test harness + static config"
```

---

## Task 2: Vendor MD5

**Files:**
- Create: `tools/dual-ota-flasher/md5.js`

- [ ] **Step 1: Vendor blueimp-md5 (MIT) as an ES module**

Download the canonical MIT source and adapt the export. Run:
```bash
cd tools/dual-ota-flasher
curl -fsSL https://raw.githubusercontent.com/blueimp/JavaScript-MD5/v2.19.0/js/md5.js -o md5.js
```
Then append a named ES export so it works in browser + Node. Edit the end of `md5.js` to ensure it exposes a function `md5(string)` returning a hex string and add:
```js
export const md5 = (typeof globalThis.md5 === "function") ? globalThis.md5 : md5;
```
If the vendored file uses a UMD wrapper that assigns `window.md5`, replace the wrapper's tail with a direct `export function md5(string){ ... }`. The only requirement: `import { md5 } from "./md5.js"` yields hex MD5.

- [ ] **Step 2: Sanity-check in Node**

Run:
```bash
cd tools/dual-ota-flasher
node -e 'import("./md5.js").then(m=>console.log(m.md5("abc")))'
```
Expected: `900150983cd24fb0d6963f7d28e17f72`

- [ ] **Step 3: Commit**

```bash
git add -f tools/dual-ota-flasher/md5.js
git commit -m "chore(web-builder): vendor blueimp-md5 for UID hashing"
```

---

## Task 3: `generateUID` (TDD)

**Files:**
- Create: `tools/dual-ota-flasher/configure.js`
- Test: `tools/dual-ota-flasher/test/configure.test.mjs`

- [ ] **Step 1: Write the failing test**

`tools/dual-ota-flasher/test/configure.test.mjs`:
```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateUID } from "../configure.js";

test("generateUID: comma-separated ints are left-padded to 6 bytes", () => {
  assert.deepEqual([...generateUID("1,2,3,4")], [0, 0, 1, 2, 3, 4]);
});

test("generateUID: phrase falls back to md5[0:6]", () => {
  assert.deepEqual([...generateUID("test")], [79, 4, 253, 130, 33, 85]);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd tools/dual-ota-flasher/test && node --test`
Expected: FAIL — `Cannot find module '../configure.js'` / `generateUID is not a function`.

- [ ] **Step 3: Implement generateUID**

`tools/dual-ota-flasher/configure.js` (start of file):
```js
import { md5 } from "./md5.js";

export function generateUID(phrase) {
  const parts = phrase.split(",").map((s) => (/^\d+$/.test(s.trim()) ? parseInt(s.trim(), 10) : -1));
  if (parts.length >= 4 && parts.length <= 6 && parts.every((n) => n >= 0 && n < 256)) {
    const uid = parts.slice();
    while (uid.length < 6) uid.unshift(0);
    return Uint8Array.from(uid);
  }
  const hex = md5(`-DMY_BINDING_PHRASE="${phrase}"`);
  const bytes = [];
  for (let i = 0; i < 6; i++) bytes.push(parseInt(hex.substr(i * 2, 2), 16));
  return Uint8Array.from(bytes);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd tools/dual-ota-flasher/test && node --test`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add tools/dual-ota-flasher/configure.js tools/dual-ota-flasher/test/configure.test.mjs
git commit -m "feat(web-builder): generateUID with byte-parity tests"
```

---

## Task 4: `domainNumber` + `buildDefines` (TDD)

**Files:**
- Modify: `tools/dual-ota-flasher/configure.js`
- Test: `tools/dual-ota-flasher/test/configure.test.mjs`

- [ ] **Step 1: Add failing tests**

Append to `configure.test.mjs`:
```js
import { domainNumber, buildDefines } from "../configure.js";

test("domainNumber maps per binary_configurator", () => {
  assert.equal(domainNumber("eu_868"), 2);
  assert.equal(domainNumber("fcc_915"), 1);
  assert.equal(domainNumber("us_433_wide"), 7);
});

test("buildDefines emits uid + domain + fixed discriminator as compact JSON", () => {
  const json = buildDefines({ phrase: "1,2,3,4", domain: "eu_868", discriminator: 123 });
  assert.equal(json, '{"uid":[0,0,1,2,3,4],"domain":2,"flash-discriminator":123}');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd tools/dual-ota-flasher/test && node --test`
Expected: FAIL — `domainNumber is not a function`.

- [ ] **Step 3: Implement**

Append to `configure.js`:
```js
const DOMAIN_NUMBERS = { au_915: 0, fcc_915: 1, eu_868: 2, in_866: 3, au_433: 4, eu_433: 5, us_433: 6, us_433_wide: 7 };

export function domainNumber(domain) {
  if (!(domain in DOMAIN_NUMBERS)) throw new Error(`unknown domain ${domain}`);
  return DOMAIN_NUMBERS[domain];
}

// discriminator: pass a fixed value in tests; omit in the browser for a random one.
export function buildDefines({ phrase, domain, discriminator }) {
  const flags = {};
  if (phrase) flags["uid"] = [...generateUID(phrase)];
  if (domain) flags["domain"] = domainNumber(domain);
  flags["flash-discriminator"] =
    discriminator ?? (globalThis.crypto.getRandomValues(new Uint32Array(1))[0] || 1);
  return JSON.stringify(flags);
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd tools/dual-ota-flasher/test && node --test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tools/dual-ota-flasher/configure.js tools/dual-ota-flasher/test/configure.test.mjs
git commit -m "feat(web-builder): domainNumber + buildDefines json_flags"
```

---

## Task 5: `findFirmwareEnd` (TDD)

**Files:**
- Modify: `tools/dual-ota-flasher/configure.js`
- Test: `tools/dual-ota-flasher/test/configure.test.mjs`

- [ ] **Step 1: Add failing test (synthetic ESP32 image)**

Append to `configure.test.mjs`:
```js
import { findFirmwareEnd } from "../configure.js";

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
```

- [ ] **Step 2: Run to verify failure**

Run: `cd tools/dual-ota-flasher/test && node --test`
Expected: FAIL — `findFirmwareEnd is not a function`.

- [ ] **Step 3: Implement**

Append to `configure.js`:
```js
// Mirrors UnifiedConfiguration.findFirmwareEnd for the ESP32 (non-8285) path.
export function findFirmwareEnd(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = dv.getUint8(0);
  if (magic !== 0xe9) throw new Error("not a firmware image (bad magic)");
  let segments = dv.getUint8(1);
  if (segments === 2) throw new Error("ESP8266/85 image not supported by this tool");
  let pos = 24;
  for (let i = 0; i < segments; i++) {
    const size = dv.getUint32(pos + 4, true);
    pos += 8 + size;
  }
  pos = (pos + 16) & ~15;
  pos += 32;
  return pos >>> 0;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd tools/dual-ota-flasher/test && node --test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tools/dual-ota-flasher/configure.js tools/dual-ota-flasher/test/configure.test.mjs
git commit -m "feat(web-builder): findFirmwareEnd ESP32 image scan"
```

---

## Task 6: `appendConfig` + Python field parity (TDD)

> Parity note: the fixed-width fields (`product`, `lua`) and the firmware body are
> byte-identical to Python. The `defines` region is byte-identical (same compact string
> passed in). The `layout` region is compared by **JSON value** (`JSON.parse` deep-equal),
> not raw bytes, because Python's `json.JSONEncoder().encode()` inserts `", "`/`": "`
> spaces while JS `JSON.stringify` is compact — the on-device parser is whitespace-
> agnostic, and the official web-flasher likewise emits compact JSON.

**Files:**
- Modify: `tools/dual-ota-flasher/configure.js`
- Create: `tools/dual-ota-flasher/test/gen_reference.py`
- Test: `tools/dual-ota-flasher/test/configure.test.mjs`

- [ ] **Step 1: Write the Python reference generator**

`tools/dual-ota-flasher/test/gen_reference.py` (run from `src/`, uses the repo's own `UnifiedConfiguration`):
```python
#!/usr/bin/env python3
# Produces a byte-exact reference of UnifiedConfiguration.appendToFirmware for the JS parity test.
import sys, os, struct, json

SRC = os.path.join(os.path.dirname(__file__), "..", "..", "..", "src", "python")
sys.path.insert(0, SRC)
import UnifiedConfiguration as U  # noqa: E402

def make_image(segments, sizes):
    out = bytearray(24)
    out[0] = 0xE9; out[1] = segments
    for s in sizes:
        out += struct.pack("<II", 0, s) + (b"\0" * s)
    return out

def main():
    out_dir = sys.argv[1]
    img = make_image(3, [16, 32, 48])
    fw = os.path.join(out_dir, "fw.bin")
    with open(fw, "wb") as f:
        f.write(img)
    product = "RadioMaster TX15"
    lua = "TX15"
    defines = '{"uid":[0,0,1,2,3,4],"domain":2,"flash-discriminator":123}'
    layout = {"serial_rx": 3, "serial_tx": 1}
    layout_path = os.path.join(out_dir, "layout.json")
    with open(layout_path, "w") as f:
        json.dump(layout, f)
    with open(fw, "r+b") as f:
        U.appendToFirmware(f, product, lua, defines, {}, layout_path, None)
    # echo the inputs so the JS test feeds identical values
    print(json.dumps({"product": product, "lua": lua, "defines": defines, "layout": layout}))

if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Add the failing parity test**

Append to `configure.test.mjs`:
```js
import { appendConfig } from "../configure.js";
import { execFileSync } from "node:child_process";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("appendConfig matches UnifiedConfiguration.appendToFirmware (field parity)", () => {
  const dir = mkdtempSync(join(tmpdir(), "elrs-parity-"));
  const meta = JSON.parse(
    execFileSync("python3", [join(import.meta.dirname, "gen_reference.py"), dir], { encoding: "utf8" })
  );
  const reference = new Uint8Array(readFileSync(join(dir, "fw.bin")));

  // base image = 24-byte header + (8+16)+(8+32)+(8+48) = 144 bytes (must match gen_reference.py)
  const BASE_LEN = 144;
  const base = new Uint8Array(reference.subarray(0, BASE_LEN));
  const out = appendConfig(base, {
    productName: meta.product, luaName: meta.lua, defines: meta.defines, layout: meta.layout,
  });

  // Overall length identical (end 192 + 128 + 16 + 512 + 2048 = 2896).
  assert.equal(out.length, reference.length);

  // findFirmwareEnd offset for this synthetic image: ((144+16)&~15)+32 = 192.
  const END = 192;
  const dec = new TextDecoder();
  const strip = (a) => dec.decode(a).replace(/\0+$/, "");

  // Firmware body + fixed-width product(128) + lua(16) + defines(512): byte-identical.
  assert.deepEqual([...out.subarray(0, END + 128 + 16 + 512)],
                   [...reference.subarray(0, END + 128 + 16 + 512)]);

  // Layout region (2048B): compare by JSON value (whitespace differs by design).
  const layoutStart = END + 128 + 16 + 512;
  assert.deepEqual(JSON.parse(strip(out.subarray(layoutStart, layoutStart + 2048))),
                   JSON.parse(strip(reference.subarray(layoutStart, layoutStart + 2048))));
});
```

- [ ] **Step 3: Run to verify failure**

Run: `cd tools/dual-ota-flasher/test && node --test`
Expected: FAIL — `appendConfig is not a function`.

- [ ] **Step 4: Implement appendConfig**

Append to `configure.js`:
```js
const enc = new TextEncoder();

function fixedField(str, len) {
  const out = new Uint8Array(len); // zero-filled
  const b = enc.encode(str);
  out.set(b.subarray(0, len));
  return out;
}

// Mirrors UnifiedConfiguration.appendToFirmware (first four blocks only).
// base: Uint8Array firmware image. Returns a new Uint8Array with the config appended.
export function appendConfig(base, { productName, luaName, defines, layout }) {
  const end = findFirmwareEnd(base);
  const product = fixedField(productName, 128);
  const device = fixedField(luaName, 16);
  const definesField = fixedField(defines, 512);
  const layoutStr = layout == null ? "" : JSON.stringify(layout);
  const layoutField = fixedField(layoutStr, 2048);

  const out = new Uint8Array(end + product.length + device.length + definesField.length + layoutField.length);
  out.set(base.subarray(0, Math.min(base.length, end)), 0);
  let p = end;
  for (const f of [product, device, definesField, layoutField]) { out.set(f, p); p += f.length; }
  return out;
}
```

Note: `JSON.stringify` on a JS object preserves insertion order, matching Python's `json.JSONEncoder().encode(dict)`; keep `meta.layout` key order identical in `gen_reference.py`.

- [ ] **Step 5: Run to verify pass**

Run: `cd tools/dual-ota-flasher/test && node --test`
Expected: PASS (all configure tests).

- [ ] **Step 6: Commit**

```bash
git add tools/dual-ota-flasher/configure.js tools/dual-ota-flasher/test/configure.test.mjs tools/dual-ota-flasher/test/gen_reference.py
git commit -m "feat(web-builder): appendConfig with Python field-parity test"
```

---

## Task 7: Target helpers (TDD)

**Files:**
- Create: `tools/dual-ota-flasher/targets.js`
- Test: `tools/dual-ota-flasher/test/targets.test.mjs`

- [ ] **Step 1: Write failing tests**

`tools/dual-ota-flasher/test/targets.test.mjs`:
```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { flattenTargets, filterEsp32Targets, targetToEnv, bandBuildFlag } from "../targets.js";

const sample = {
  radiomaster: { tx_dual: {
    tx15: { product_name: "TX15", platform: "esp32", firmware: "Unified_ESP32_2400_TX" },
  }},
  happymodel: { rx_2400: {
    ep1: { product_name: "EP1", platform: "esp8285", firmware: "Unified_ESP8285_2400_RX" },
  }},
  generic: { rx_900: {
    s3: { product_name: "S3", platform: "esp32-s3", firmware: "Unified_ESP32S3_900_RX" },
  }},
};

test("flattenTargets yields dotted ids with the device dict", () => {
  const flat = flattenTargets(sample);
  assert.equal(flat.find((t) => t.id === "radiomaster.tx_dual.tx15").dev.product_name, "TX15");
});

test("filterEsp32Targets keeps only platform === 'esp32'", () => {
  const ids = filterEsp32Targets(flattenTargets(sample)).map((t) => t.id);
  assert.deepEqual(ids, ["radiomaster.tx_dual.tx15"]);
});

test("targetToEnv appends _via_UART", () => {
  assert.equal(targetToEnv({ firmware: "Unified_ESP32_2400_TX" }), "Unified_ESP32_2400_TX_via_UART");
});

test("bandBuildFlag picks ISM_2400 for 2400, FCC_915 otherwise", () => {
  assert.match(bandBuildFlag("Unified_ESP32_2400_TX_via_UART"), /ISM_2400/);
  assert.match(bandBuildFlag("Unified_ESP32_LR1121_TX_via_UART"), /FCC_915/);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd tools/dual-ota-flasher/test && node --test`
Expected: FAIL — `Cannot find module '../targets.js'`.

- [ ] **Step 3: Implement targets.js**

`tools/dual-ota-flasher/targets.js`:
```js
// Pure helpers over hardware/targets.json (no DOM, no fetch).
export function flattenTargets(targets) {
  const out = [];
  for (const [mfr, cats] of Object.entries(targets)) {
    if (typeof cats !== "object") continue;
    for (const [cat, devs] of Object.entries(cats)) {
      if (typeof devs !== "object") continue;
      for (const [dev, body] of Object.entries(devs)) {
        if (body && typeof body === "object" && "platform" in body) {
          out.push({ id: `${mfr}.${cat}.${dev}`, dev: body });
        }
      }
    }
  }
  return out;
}

export function filterEsp32Targets(flat) {
  return flat.filter((t) => t.dev.platform === "esp32");
}

export function targetToEnv(dev) {
  return `${dev.firmware}_via_UART`;
}

export function bandBuildFlag(env) {
  return /_2400_/.test(env) ? "-DRegulatory_Domain_ISM_2400" : "-DRegulatory_Domain_FCC_915";
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd tools/dual-ota-flasher/test && node --test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tools/dual-ota-flasher/targets.js tools/dual-ota-flasher/test/targets.test.mjs
git commit -m "feat(web-builder): ESP32 target filtering + env mapping helpers"
```

---

## Task 8: GitHub API client (TDD with injected fetch)

**Files:**
- Create: `tools/dual-ota-flasher/github.js`
- Test: `tools/dual-ota-flasher/test/github.test.mjs`

- [ ] **Step 1: Write failing tests**

`tools/dual-ota-flasher/test/github.test.mjs`:
```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { dispatchBuild, fetchArtifactBin } from "../github.js";

const repo = { owner: "me", repo: "ELRS" };

test("dispatchBuild POSTs workflow_dispatch with ref + inputs + auth", async () => {
  const calls = [];
  const fetchFn = async (url, opts) => { calls.push({ url, opts }); return { ok: true, status: 204 }; };
  await dispatchBuild({ repo, token: "T", workflow: "flasher-build.yml",
    ref: "lua-slot/v4", inputs: { branch: "v4", env: "E", run_tag: "abc" }, fetchFn });
  assert.equal(calls[0].url, "https://api.github.com/repos/me/ELRS/actions/workflows/flasher-build.yml/dispatches");
  assert.equal(calls[0].opts.method, "POST");
  assert.match(calls[0].opts.headers.Authorization, /Bearer T/);
  const body = JSON.parse(calls[0].opts.body);
  assert.equal(body.ref, "lua-slot/v4");
  assert.equal(body.inputs.run_tag, "abc");
});

test("fetchArtifactBin resolves path -> blob sha -> base64 bytes", async () => {
  const b64 = Buffer.from([1, 2, 3, 4]).toString("base64");
  const fetchFn = async (url) => {
    if (url.includes("/contents/")) return { ok: true, json: async () => ({ sha: "deadbeef" }) };
    if (url.includes("/git/blobs/")) return { ok: true, json: async () => ({ content: b64, encoding: "base64" }) };
    throw new Error("unexpected " + url);
  };
  const bytes = await fetchArtifactBin({ repo, token: "T", branch: "flasher-artifacts",
    path: "v4/E/firmware.bin", fetchFn });
  assert.deepEqual([...bytes], [1, 2, 3, 4]);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd tools/dual-ota-flasher/test && node --test`
Expected: FAIL — `Cannot find module '../github.js'`.

- [ ] **Step 3: Implement github.js**

`tools/dual-ota-flasher/github.js`:
```js
const API = "https://api.github.com";

function headers(token) {
  return { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json",
           "X-GitHub-Api-Version": "2022-11-28" };
}

export async function dispatchBuild({ repo, token, workflow, ref, inputs, fetchFn = fetch }) {
  const url = `${API}/repos/${repo.owner}/${repo.repo}/actions/workflows/${workflow}/dispatches`;
  const res = await fetchFn(url, { method: "POST", headers: { ...headers(token), "Content-Type": "application/json" },
    body: JSON.stringify({ ref, inputs }) });
  if (!res.ok) throw new Error(`dispatch failed: HTTP ${res.status}`);
}

// Poll the workflow's runs and return the one whose name/display embeds run_tag.
export async function findRunByTag({ repo, token, workflow, runTag, fetchFn = fetch }) {
  const url = `${API}/repos/${repo.owner}/${repo.repo}/actions/workflows/${workflow}/runs?per_page=20&event=workflow_dispatch`;
  const res = await fetchFn(url, { headers: headers(token) });
  if (!res.ok) throw new Error(`list runs failed: HTTP ${res.status}`);
  const data = await res.json();
  return (data.workflow_runs || []).find((r) => (r.name || "").includes(runTag) || (r.display_title || "").includes(runTag)) || null;
}

export async function fetchArtifactBin({ repo, token, branch, path, fetchFn = fetch }) {
  const cUrl = `${API}/repos/${repo.owner}/${repo.repo}/contents/${path}?ref=${branch}`;
  const c = await fetchFn(cUrl, { headers: headers(token) });
  if (!c.ok) throw new Error(`artifact not found (${path}@${branch}): HTTP ${c.status}`);
  const { sha } = await c.json();
  const bUrl = `${API}/repos/${repo.owner}/${repo.repo}/git/blobs/${sha}`;
  const b = await fetchFn(bUrl, { headers: headers(token) });
  if (!b.ok) throw new Error(`blob fetch failed: HTTP ${b.status}`);
  const { content } = await b.json();
  const bin = atob(content.replace(/\n/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
```

Note for Node tests: `atob` is global in Node ≥16.

- [ ] **Step 4: Run to verify pass**

Run: `cd tools/dual-ota-flasher/test && node --test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tools/dual-ota-flasher/github.js tools/dual-ota-flasher/test/github.test.mjs
git commit -m "feat(web-builder): GitHub dispatch/poll/blob-fetch client"
```

---

## Task 9: Refactor `flasher.js` to expose `flashData`

**Files:**
- Modify: `tools/dual-ota-flasher/flasher.js`

This is browser/hardware code — verified manually, not via `node:test`.

- [ ] **Step 1: Add `flashData` and export the helpers builder.js needs**

In `flasher.js`, locate `flashSlot(file, address, slotLabel)`. Add a sibling that flashes raw bytes, and make `flashSlot` delegate. Replace the body of `flashSlot` so the write path lives in one place:
```js
export async function flashData(data, address, slotLabel) {
  if (!esploader) { log("Connect first."); return; }
  setBusy(true);
  try {
    log(`Flashing ${slotLabel} (${data.length} bytes) at 0x${address.toString(16)}…`);
    await esploader.writeFlash({
      fileArray: [{ data: esploader.ui8ToBstr(data), address }],
      flashSize: "keep", eraseAll: false, compress: true,
      reportProgress: (i, written, total) => log(`  ${slotLabel}: ${written}/${total}`),
    });
    await esploader.after("hard_reset");
    log(`${slotLabel} done; board reset.`);
  } catch (e) {
    log(`Error flashing ${slotLabel}: ${e.message || e}`);
  } finally {
    setBusy(false);
  }
}

async function flashSlot(file, address, slotLabel) {
  const data = await fileToUint8(file);
  await flashData(data, address, slotLabel);
}
```
(If the existing `writeFlash` call uses a different data encoding — e.g. raw `Uint8Array` rather than `ui8ToBstr` — match the existing convention already used in the "Flash both slots" handler; the point is `flashData` reuses the exact options the current code uses.)

- [ ] **Step 2: Export `log`, `setBusy`, and a connection check**

Add `export` to `log` and `setBusy`, and add:
```js
export function isConnected() { return esploader !== null; }
export { APP0_ADDR, APP1_ADDR };
```

- [ ] **Step 3: Manual verify (no behavior change yet)**

Run:
```bash
cd tools/dual-ota-flasher && python3 -m http.server 8000
```
Open http://localhost:8000, Connect, Flash app0 only with a known file → still works exactly as before (the refactor is behavior-preserving). Confirm in the log.

- [ ] **Step 4: Commit**

```bash
git add tools/dual-ota-flasher/flasher.js
git commit -m "refactor(web-builder): extract flashData, export helpers for the builder"
```

---

## Task 10: Builder UI section in `index.html`

**Files:**
- Modify: `tools/dual-ota-flasher/index.html`

- [ ] **Step 1: Add the token field + Build section above the existing controls**

Insert, just inside the page container before the existing connect/controls markup (use the IDs the builder wires to):
```html
<section id="build-section">
  <h2>Build</h2>
  <label>GitHub token <input type="password" id="ghtoken" placeholder="ghp_… (actions:write)"></label>
  <fieldset>
    <label>Version
      <select id="bld-version"><option value="v4">v4</option><option value="v3.6.3">v3.6.3</option></select>
    </label>
    <label>Target <select id="bld-target"></select></label>
    <label>Domain <select id="bld-domain"></select></label>
    <label>Bind phrase <input type="text" id="bld-phrase" placeholder="optional, stays local"></label>
    <label>Stage into
      <select id="bld-slot"><option value="1">app1 (v4.x)</option><option value="0">app0 (v3.x)</option></select>
    </label>
    <button id="bld-build" type="button">Build &amp; stage</button>
    <span id="bld-status"></span>
  </fieldset>
  <p id="bld-staged">Staged · app0 = (none) · app1 = (none)</p>
</section>
```

- [ ] **Step 2: Load builder.js after flasher.js**

After the existing `<script type="module" src="flasher.js"></script>`, add:
```html
<script type="module" src="builder.js"></script>
```

- [ ] **Step 3: Manual verify the markup renders**

Reload http://localhost:8000 → the Build section shows; target/domain dropdowns are empty until Task 11 populates them. No console errors except the not-yet-created `builder.js` 404 (fixed next task).

- [ ] **Step 4: Commit**

```bash
git add tools/dual-ota-flasher/index.html
git commit -m "feat(web-builder): add Build section + token field to UI"
```

---

## Task 11: Builder orchestration (`builder.js`)

**Files:**
- Create: `tools/dual-ota-flasher/builder.js`

Browser glue — verified manually + end-to-end in Task 14.

- [ ] **Step 1: Implement builder.js**

`tools/dual-ota-flasher/builder.js`:
```js
import { REPO, BRANCHES, BUILD_WORKFLOW, WORKFLOW_REF, ARTIFACT_BRANCH, DOMAINS } from "./config.js";
import { flattenTargets, filterEsp32Targets, targetToEnv } from "./targets.js";
import { buildDefines, appendConfig } from "./configure.js";
import { dispatchBuild, findRunByTag, fetchArtifactBin } from "./github.js";
import { flashData, log, isConnected, APP0_ADDR, APP1_ADDR } from "./flasher.js";

const RAW = (ref, path) => `https://raw.githubusercontent.com/${REPO.owner}/${REPO.repo}/${encodeURIComponent(ref)}/${path}`;
const staged = { 0: null, 1: null };
let esp32 = [];

const $ = (id) => document.getElementById(id);
const setStatus = (m) => { $("bld-status").textContent = m; };

async function loadTargets() {
  const ref = BRANCHES[$("bld-version").value];
  const res = await fetch(RAW(ref, "src/hardware/targets.json"));
  if (!res.ok) throw new Error(`targets.json HTTP ${res.status}`);
  esp32 = filterEsp32Targets(flattenTargets(await res.json())).sort((a, b) => a.id.localeCompare(b.id));
  $("bld-target").innerHTML = esp32.map((t) => `<option value="${t.id}">${t.id}</option>`).join("");
}

async function fetchLayout(ref, dev) {
  const dir = dev.firmware.includes("_TX") ? "TX" : "RX";
  const res = await fetch(RAW(ref, `src/hardware/${dir}/${dev.layout_file}`));
  if (!res.ok) throw new Error(`layout HTTP ${res.status}`);
  return res.json();
}

function renderStaged() {
  const fmt = (s) => (s ? `${s.label} ✓` : "(none)");
  $("bld-staged").textContent = `Staged · app0 = ${fmt(staged[0])} · app1 = ${fmt(staged[1])}`;
}

async function pollUntilDone(token, runTag) {
  for (let i = 0; i < 90; i++) { // ~15 min at 10s
    const run = await findRunByTag({ repo: REPO, token, workflow: BUILD_WORKFLOW, runTag });
    if (run) {
      setStatus(`run #${run.run_number}: ${run.status}…`);
      if (run.status === "completed") {
        if (run.conclusion !== "success") throw new Error(`build ${run.conclusion} — see ${run.html_url}`);
        return run;
      }
    }
    await new Promise((r) => setTimeout(r, 10000));
  }
  throw new Error("build timed out (15 min)");
}

async function buildAndStage() {
  const token = $("ghtoken").value.trim();
  if (!token) { setStatus("enter a GitHub token first"); return; }
  const versionLabel = $("bld-version").value;
  const ref = BRANCHES[versionLabel];
  const targetId = $("bld-target").value;
  const dev = esp32.find((t) => t.id === targetId).dev;
  const env = targetToEnv(dev);
  const domain = $("bld-domain").value;
  const slot = Number($("bld-slot").value);
  const runTag = `flash-${crypto.getRandomValues(new Uint32Array(1))[0].toString(16)}`;

  $("bld-build").disabled = true;
  try {
    setStatus("dispatching build…");
    await dispatchBuild({ repo: REPO, token, workflow: BUILD_WORKFLOW, ref: WORKFLOW_REF,
      inputs: { branch: versionLabel, env, run_tag: runTag, checkout_ref: ref } });
    await pollUntilDone(token, runTag);

    setStatus("downloading build…");
    const generic = await fetchArtifactBin({ repo: REPO, token, branch: ARTIFACT_BRANCH,
      path: `${versionLabel}/${env}/firmware.bin` });

    setStatus("configuring…");
    const layout = await fetchLayout(ref, dev);
    const defines = buildDefines({ phrase: $("bld-phrase").value.trim(), domain });
    const configured = appendConfig(generic, { productName: dev.product_name, luaName: dev.lua_name, defines, layout });

    staged[slot] = { bytes: configured, label: `${versionLabel} · ${targetId} · ${domain}` };
    renderStaged();
    setStatus("staged — ready to flash");
    log(`Staged ${staged[slot].label} → ${slot === 0 ? "app0" : "app1"} (${configured.length} bytes)`);
  } catch (e) {
    setStatus(`error: ${e.message || e}`);
    log(`Build error: ${e.message || e}`);
  } finally {
    $("bld-build").disabled = false;
  }
}

async function flashStaged(slot) {
  if (!staged[slot]) { setStatus(`nothing staged for app${slot}`); return; }
  if (!isConnected()) { setStatus("Connect to the board first"); return; }
  await flashData(staged[slot].bytes, slot === 0 ? APP0_ADDR : APP1_ADDR, `app${slot} (staged)`);
}

function init() {
  $("ghtoken").value = sessionStorage.getItem("ghtoken") || "";
  $("ghtoken").addEventListener("change", () => sessionStorage.setItem("ghtoken", $("ghtoken").value.trim()));
  $("bld-domain").innerHTML = DOMAINS.map((d) => `<option value="${d}">${d}</option>`).join("");
  $("bld-version").addEventListener("change", () => loadTargets().catch((e) => setStatus(e.message)));
  $("bld-build").addEventListener("click", buildAndStage);
  $("bld-flash-staged-0")?.addEventListener("click", () => flashStaged(0));
  $("bld-flash-staged-1")?.addEventListener("click", () => flashStaged(1));
  renderStaged();
  loadTargets().catch((e) => setStatus(e.message));
}

if (document.readyState !== "loading") init();
else document.addEventListener("DOMContentLoaded", init);

window.flashStaged = flashStaged; // allow existing Flash buttons to opt into staged bytes
```

- [ ] **Step 2: Wire the existing Flash buttons to prefer staged bytes**

In `index.html`, add two small buttons inside the existing controls so a staged build can be flashed directly:
```html
<button id="bld-flash-staged-0" type="button">Flash staged → app0</button>
<button id="bld-flash-staged-1" type="button">Flash staged → app1</button>
```

- [ ] **Step 3: Manual verify dropdowns populate**

Reload http://localhost:8000 → target dropdown fills with ESP32-only ids from the selected branch; switching version reloads the list; domain dropdown lists the 8 domains. (No build yet — that needs the workflow in Task 12.)

- [ ] **Step 4: Commit**

```bash
git add tools/dual-ota-flasher/builder.js tools/dual-ota-flasher/index.html
git commit -m "feat(web-builder): build/poll/configure/stage orchestration"
```

---

## Task 12: Build workflow (`flasher-build.yml`)

**Files:**
- Create: `.github/workflows/flasher-build.yml`

- [ ] **Step 1: Write the workflow**

`.github/workflows/flasher-build.yml`:
```yaml
name: Flasher Build
on:
  workflow_dispatch:
    inputs:
      branch:       { description: "Version label (v4 / v3.6.3)", required: true }
      env:          { description: "PlatformIO env", required: true }
      run_tag:      { description: "Correlation tag from the web UI", required: true }
      checkout_ref: { description: "Git ref of the version branch to compile", required: true }

run-name: "flasher-build ${{ inputs.env }} [${{ inputs.run_tag }}]"

permissions:
  contents: write

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
        with: { ref: ${{ inputs.checkout_ref }} }   # compile the version branch
      - uses: actions/setup-python@v6
        with: { python-version: "3.10" }
      - name: Install PlatformIO
        run: |
          python -m pip install --upgrade pip
          pip install platformio wheel
      - name: Build generic firmware
        working-directory: src
        run: |
          case "${{ inputs.env }}" in
            *_2400_*) DOMAIN="-DRegulatory_Domain_ISM_2400" ;;
            *)        DOMAIN="-DRegulatory_Domain_FCC_915" ;;
          esac
          PLATFORMIO_BUILD_FLAGS="$DOMAIN" pio run -e "${{ inputs.env }}"
          cp ".pio/build/${{ inputs.env }}/firmware.bin" "$RUNNER_TEMP/firmware.bin"
      - name: Publish to flasher-artifacts
        env:
          GH_TOKEN: ${{ github.token }}
          DEST: "${{ inputs.branch }}/${{ inputs.env }}/firmware.bin"
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git fetch origin flasher-artifacts || true
          if git rev-parse --verify origin/flasher-artifacts >/dev/null 2>&1; then
            git checkout flasher-artifacts
          else
            git checkout --orphan flasher-artifacts
            git rm -rf . >/dev/null 2>&1 || true
          fi
          mkdir -p "$(dirname "$DEST")"
          cp "$RUNNER_TEMP/firmware.bin" "$DEST"
          git add "$DEST"
          git commit -m "build: ${{ inputs.env }} @ ${{ inputs.branch }} [${{ inputs.run_tag }}]" || echo "no change"
          git push origin flasher-artifacts
```

- [ ] **Step 2: Push the branch so the workflow exists on GitHub**

```bash
git add .github/workflows/flasher-build.yml
git commit -m "ci(web-builder): on-demand build -> flasher-artifacts branch"
git push -u origin dual-ota-builder
```

- [ ] **Step 3: Manual verify the workflow registers and runs**

`workflow_dispatch` requires the workflow file to exist on the **dispatched ref** — that's `WORKFLOW_REF` (`dual-ota-builder` during development; change to the default branch after merge), *not* the version branch. The version branch is compiled via the `checkout_ref` input. In GitHub → Actions → "Flasher Build", use **Run workflow** (branch = `dual-ota-builder`) with `branch=v4`, `env=Unified_ESP32_2400_TX_via_UART`, `run_tag=manual`, `checkout_ref=lua-slot/v4`. Expected: green run; the `flasher-artifacts` branch gains `v4/Unified_ESP32_2400_TX_via_UART/firmware.bin`.

---

## Task 13: Pages deploy workflow + docs

**Files:**
- Create: `.github/workflows/flasher-pages.yml`
- Modify: `tools/dual-ota-flasher/README.md`

- [ ] **Step 1: Write the Pages workflow**

`.github/workflows/flasher-pages.yml`:
```yaml
name: Flasher Pages
on:
  workflow_dispatch:
  push:
    branches: [dual-ota-builder]
    paths: ["tools/dual-ota-flasher/**"]

permissions:
  contents: read
  pages: write
  id-token: write

concurrency: { group: "pages", cancel-in-progress: true }

jobs:
  deploy:
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: actions/configure-pages@v5
      - uses: actions/upload-pages-artifact@v3
        with: { path: "tools/dual-ota-flasher" }
      - id: deployment
        uses: actions/deploy-pages@v4
```

- [ ] **Step 2: Document builder + Pages usage**

Append to `tools/dual-ota-flasher/README.md`:
```markdown
## Build from source (GitHub Actions)

The **Build** section compiles a chosen ESP32 target from the v3.6.3 / v4 branch in
GitHub Actions, configures it in your browser (target / domain / bind phrase — the phrase
never leaves your machine), and stages it into an OTA slot.

1. Paste a GitHub **fine-grained PAT** with **Actions: read/write** and **Contents:
   read/write** on this repo into the *GitHub token* field (kept in `sessionStorage`).
2. Pick **version**, **target** (ESP32-only), **domain**, optional **bind phrase**, and the
   **slot** to stage into; click **Build & stage**. The first build of a given
   `{version, env}` takes a few minutes; subsequent ones reuse the cached PlatformIO toolchain.
3. **Connect** to the board, then **Flash staged → app0/app1** (or **Flash both** after
   staging both slots).

### Host it on GitHub Pages
Enable **Settings → Pages → Build and deployment → GitHub Actions**. The
`Flasher Pages` workflow publishes this folder to
`https://<owner>.github.io/<repo>/`. Web Serial works there (HTTPS), and the GitHub API
calls are CORS-allowed from `*.github.io`. If your fork's owner/repo differ, the page
auto-detects them on `github.io`; for local serving, edit the fallback in `config.js`.
```

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/flasher-pages.yml tools/dual-ota-flasher/README.md
git commit -m "ci(web-builder): GitHub Pages deploy workflow + docs"
```

---

## Task 14: End-to-end verification

- [ ] **Step 1: Run all unit tests**

Run: `cd tools/dual-ota-flasher/test && node --test`
Expected: PASS — configure (UID, domain, defines, findFirmwareEnd, byte-parity), targets, github.

- [ ] **Step 2: Serve and build a real target**

```bash
cd tools/dual-ota-flasher && python3 -m http.server 8000
```
Open http://localhost:8000 (edit `config.js` fallback owner/repo if needed). Paste a PAT, pick `v4` + a real ESP32 TX target + `eu_868`, slot `app1`, **Build & stage**. Expected: status walks dispatch→run→download→configure→staged; log shows the staged byte count.

- [ ] **Step 3: Verify the configured bin matches a local reference**

Build + configure the same target locally per the `build-flash-elrs` skill (`pio run` + `python/binary_configurator.py … --flash dir`), then compare the appended config region of the staged download to the Python output (ignoring the random `flash-discriminator`). Expected: identical target/domain/layout bytes.

- [ ] **Step 4: Flash + boot on hardware**

Connect the board, **Flash staged → app1**, then **Show active slot** / power-cycle and confirm v4 boots and the WebUI version selector reflects it. Repeat with `v3.6.3` → app0; verify dual-OTA switching still works and the existing **Flash slot-switch bootloader** button is unchanged.

- [ ] **Step 5: Verify Pages hosting**

Enable Pages (Actions source), open `https://<owner>.github.io/<repo>/`, and repeat Step 2 from the hosted URL to confirm the token/build/fetch flow works cross-origin.

---

## Verification summary

- **Automated:** `node --test` in `tools/dual-ota-flasher/test/` — the configurator (incl. field-parity vs `UnifiedConfiguration.appendToFirmware`: fixed fields + defines byte-identical, layout JSON-equal), target filtering/env mapping, and the GitHub client (injected `fetch`).
- **Manual:** build→configure→stage→flash on real ESP32 hardware, plus Pages-hosted run.

## Out of scope (unchanged from spec)

`esp32-s3`/`esp32-c3`/`esp8285`/`stm32`; building uncommitted local changes (CI builds the pushed branch ref); a no-token manual-trigger mode; pre-built matrix; changing the bundled bootloader/partition blobs.
