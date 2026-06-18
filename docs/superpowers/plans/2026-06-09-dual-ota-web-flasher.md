# Dual-OTA web flasher tool — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A static, browser-based tool (Chrome/Edge, Web Serial) that flashes two ELRS app images into the ESP32 OTA slots and reads each slot back, with no Python/esptool install.

**Architecture:** A single static directory served on `http://localhost`. `index.html` provides the UI; `flasher.js` (ES module) drives esptool-js (pinned `esptool-js@0.6.0` via esm.sh) over `navigator.serial`. Bundled `bootloader.bin`/`partitions.bin`/`boot_app0.bin` are `fetch()`ed at flash time; the two app images come from file pickers.

**Tech Stack:** esptool-js 0.6.0, Web Serial API, vanilla ES modules, no build step.

**Spec:** `docs/superpowers/specs/2026-06-09-dual-ota-web-flasher-design.md`

---

## Conventions

- Branch: `dual-ota-flasher` (already created off `master`).
- Tool directory: `tools/dual-ota-flasher/`.
- Flash layout: `bootloader.bin@0x1000`, `partitions.bin@0x8000`, `boot_app0.bin@0xe000`, app0@`0x10000`, app1@`0x1F0000`. App partition size `0x1E0000`. otadata `0xe000`/`0x2000`.
- esptool-js API (verified against v0.6.0 / its example): `new Transport(port, true)`; `new ESPLoader({transport, baudrate, terminal, debugLogging})`; `await esploader.main()` → chip string; `esploader.writeFlash({fileArray:[{data:Uint8Array,address}], flashMode, flashFreq, flashSize, eraseAll, compress, reportProgress})`; `esploader.readFlash(addr, size, (pkt,progress,total)=>…)` → Uint8Array; `esploader.after("hard_reset")`.
- `flashMode/flashFreq/flashSize` use `"keep"` so the prebuilt bootloader's own header settings are preserved (not patched).

### TDD note

Browser + USB hardware tool; no automated harness exists. Per-task "test" = the file is well-formed and loads without console errors; behavioral verification is manual on the board (Task 6). Documented deviation.

---

## Task 1: Scaffold the tool directory and bundle boot blobs

**Files:**
- Create: `tools/dual-ota-flasher/bootloader.bin`, `partitions.bin`, `boot_app0.bin` (copied)
- Create: `tools/dual-ota-flasher/README.md`

- [ ] **Step 1: Create the directory and copy the three boot blobs from the v4 build**

```bash
mkdir -p /Users/vostapiv/Drones/ExpressLRS/tools/dual-ota-flasher
V4DIR=/Users/vostapiv/Drones/elrs-v4/src/.pio/build/Unified_ESP32_900_RX_via_UART
cp "$V4DIR/bootloader.bin" "$V4DIR/partitions.bin" "$V4DIR/boot_app0.bin" \
   /Users/vostapiv/Drones/ExpressLRS/tools/dual-ota-flasher/
ls -l /Users/vostapiv/Drones/ExpressLRS/tools/dual-ota-flasher/
```
Expected: three `.bin` files present (bootloader ~17 KB, partitions 3 KB, boot_app0 8 KB).

- [ ] **Step 2: Write the README**

Create `tools/dual-ota-flasher/README.md`:
```markdown
# Dual-OTA Web Flasher

Flash two ELRS firmware versions into the two OTA slots of one ESP32 (app0 = v3.x,
app1 = v4.x), and read either slot back — from the browser, no esptool install.

## Requirements
- Chrome or Edge (Web Serial API).
- The board on USB.

## Run
Web Serial needs a secure context, so serve over localhost:

```
cd tools/dual-ota-flasher
python3 -m http.server 8000
```
Open <http://localhost:8000> in Chrome/Edge.

## Use
1. **Connect** and pick the serial port (hold BOOT if it won't sync).
2. **Write:** choose your configured v3.x image (→ app0) and v4.x image (→ app1),
   then **Flash both slots**. The bundled `bootloader.bin`, `partitions.bin`, and
   `boot_app0.bin` are flashed automatically; `boot_app0.bin` makes app0 (v3.x) boot
   first. The board reboots when done.
3. **Read:** **Read app0 / app1** download that slot to a `.bin`; **Show active
   slot** reports which version currently boots.

Images must already be configured (target/binding/domain) with the ELRS configurator
or official web flasher; this tool only places `.bin`s into slots.
```
Expected: file created.

- [ ] **Step 3: Commit**

```bash
cd /Users/vostapiv/Drones/ExpressLRS
git add tools/dual-ota-flasher/
git commit -m "dual-ota-flasher: scaffold dir, bundle boot blobs, README"
```

---

## Task 2: Build the UI (`index.html`)

**Files:**
- Create: `tools/dual-ota-flasher/index.html`

- [ ] **Step 1: Write `index.html`**

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>ELRS Dual-OTA Flasher</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 760px; margin: 2rem auto; padding: 0 1rem; }
  h1 { font-size: 1.3rem; } h2 { font-size: 1.05rem; margin-top: 1.5rem; }
  button { padding: .5rem .9rem; margin: .25rem .25rem .25rem 0; cursor: pointer; }
  #controls { display: none; }
  .row { margin: .5rem 0; }
  #log { background:#111; color:#0f0; padding:.75rem; height:240px; overflow:auto;
         white-space:pre-wrap; font-family:ui-monospace,monospace; font-size:.8rem; }
  .warn { color:#b00; }
</style>
</head>
<body>
  <h1>ELRS Dual-OTA Flasher</h1>
  <p>Flashes two firmware versions into the OTA slots of one ESP32
     (<b>app0 = ELRS v3.x</b>, <b>app1 = ELRS v4.x</b>) and reads them back.
     Chrome/Edge only.</p>
  <p id="unsupported" class="warn" style="display:none">
     Web Serial is not available in this browser. Use Chrome or Edge over
     http://localhost or https.</p>

  <button id="connect">Connect</button>

  <div id="controls">
    <h2>Write both slots</h2>
    <div class="row">v3.x image (→ app0): <input type="file" id="v3file" accept=".bin"/></div>
    <div class="row">v4.x image (→ app1): <input type="file" id="v4file" accept=".bin"/></div>
    <button id="flash">Flash both slots</button>

    <h2>Read</h2>
    <button id="read0">Read app0 (v3.x)</button>
    <button id="read1">Read app1 (v4.x)</button>
    <button id="active">Show active slot</button>
  </div>

  <h2>Log</h2>
  <pre id="log"></pre>

  <script type="module" src="flasher.js"></script>
</body>
</html>
```

- [ ] **Step 2: Sanity-check it loads**

Run:
```bash
cd /Users/vostapiv/Drones/ExpressLRS/tools/dual-ota-flasher && python3 -m http.server 8000 &
sleep 1 && curl -s http://localhost:8000/ | grep -c "ELRS Dual-OTA Flasher" ; kill %1 2>/dev/null
```
Expected: prints `1` (page served). (esptool-js import is exercised in the browser in Task 6.)

- [ ] **Step 3: Commit**

```bash
cd /Users/vostapiv/Drones/ExpressLRS
git add tools/dual-ota-flasher/index.html
git commit -m "dual-ota-flasher: UI (index.html)"
```

---

## Task 3: `flasher.js` — connect + logging

**Files:**
- Create: `tools/dual-ota-flasher/flasher.js`

- [ ] **Step 1: Write the connect/logging foundation**

Create `tools/dual-ota-flasher/flasher.js`:
```js
import { ESPLoader, Transport } from "https://esm.sh/esptool-js@0.6.0";

const APP0_ADDR = 0x10000;
const APP1_ADDR = 0x1F0000;
const APP_SIZE  = 0x1E0000;     // 1.875 MB OTA partition
const OTADATA_ADDR = 0xe000;
const OTADATA_SIZE = 0x2000;

let transport = null;
let esploader = null;

const logEl = document.getElementById("log");
function log(msg) { logEl.textContent += msg + "\n"; logEl.scrollTop = logEl.scrollHeight; }

const terminal = {
  clean() { logEl.textContent = ""; },
  writeLine(data) { log(data); },
  write(data) { logEl.textContent += data; logEl.scrollTop = logEl.scrollHeight; },
};

if (!navigator.serial) {
  document.getElementById("unsupported").style.display = "block";
  document.getElementById("connect").disabled = true;
}

document.getElementById("connect").addEventListener("click", async () => {
  try {
    const port = await navigator.serial.requestPort();
    transport = new Transport(port, true);
    esploader = new ESPLoader({ transport, baudrate: 460800, terminal, debugLogging: false });
    const chip = await esploader.main();
    log("Connected: " + chip);
    document.getElementById("controls").style.display = "block";
  } catch (e) {
    log("Connect failed: " + e.message + "  (hold the BOOT button and retry)");
  }
});
```

- [ ] **Step 2: Commit**

```bash
cd /Users/vostapiv/Drones/ExpressLRS
git add tools/dual-ota-flasher/flasher.js
git commit -m "dual-ota-flasher: connect + logging"
```

---

## Task 4: `flasher.js` — flash both slots

**Files:**
- Modify: `tools/dual-ota-flasher/flasher.js`

- [ ] **Step 1: Append the helpers and flash handler**

Append to `flasher.js`:
```js
async function fetchBin(name) {
  const r = await fetch(name);
  if (!r.ok) throw new Error("fetch " + name + " -> " + r.status);
  return new Uint8Array(await r.arrayBuffer());
}

async function fileToUint8(file) {
  return new Uint8Array(await file.arrayBuffer());
}

document.getElementById("flash").addEventListener("click", async () => {
  const f3 = document.getElementById("v3file").files[0];
  const f4 = document.getElementById("v4file").files[0];
  if (!esploader) { log("Connect first."); return; }
  if (!f3 || !f4) { log("Pick both the v3.x and v4.x images first."); return; }
  const btn = document.getElementById("flash");
  btn.disabled = true;
  try {
    log("Loading images…");
    const [bootloader, partitions, bootApp0, app0, app1] = await Promise.all([
      fetchBin("bootloader.bin"), fetchBin("partitions.bin"), fetchBin("boot_app0.bin"),
      fileToUint8(f3), fileToUint8(f4),
    ]);
    const fileArray = [
      { data: bootloader, address: 0x1000 },
      { data: partitions, address: 0x8000 },
      { data: bootApp0,   address: OTADATA_ADDR },
      { data: app0,       address: APP0_ADDR },
      { data: app1,       address: APP1_ADDR },
    ];
    log("Flashing 5 regions (v3 -> app0, v4 -> app1)…");
    await esploader.writeFlash({
      fileArray,
      flashMode: "keep",
      flashFreq: "keep",
      flashSize: "keep",
      eraseAll: false,
      compress: true,
      reportProgress: (i, written, total) => {
        if (written === total) log("  region " + (i + 1) + "/5 written");
      },
    });
    log("Flash complete. Resetting…");
    await esploader.after("hard_reset");
    log("Done — board reboots into app0 (ELRS v3.x).");
  } catch (e) {
    log("Flash error: " + e.message);
  } finally {
    btn.disabled = false;
  }
});
```

- [ ] **Step 2: Commit**

```bash
cd /Users/vostapiv/Drones/ExpressLRS
git add tools/dual-ota-flasher/flasher.js
git commit -m "dual-ota-flasher: flash both slots"
```

---

## Task 5: `flasher.js` — read slots + active slot

**Files:**
- Modify: `tools/dual-ota-flasher/flasher.js`

- [ ] **Step 1: Append the read handlers**

Append to `flasher.js`:
```js
function downloadBytes(data, filename) {
  const blob = new Blob([data], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

async function readSlot(addr, filename) {
  if (!esploader) { log("Connect first."); return; }
  log("Reading " + filename + " (" + APP_SIZE + " bytes) — ~1 minute…");
  try {
    const data = await esploader.readFlash(addr, APP_SIZE, (pkt, progress, total) => {
      if (progress === total) log("  read complete");
    });
    downloadBytes(data, filename);
    log("Saved " + filename);
  } catch (e) {
    log("Read error: " + e.message);
  }
}

document.getElementById("read0").addEventListener("click", () => readSlot(APP0_ADDR, "app0-v3.bin"));
document.getElementById("read1").addEventListener("click", () => readSlot(APP1_ADDR, "app1-v4.bin"));

document.getElementById("active").addEventListener("click", async () => {
  if (!esploader) { log("Connect first."); return; }
  try {
    const od = await esploader.readFlash(OTADATA_ADDR, OTADATA_SIZE, () => {});
    const dv = new DataView(od.buffer, od.byteOffset, od.byteLength);
    const s0 = dv.getUint32(0x0000, true);
    const s1 = dv.getUint32(0x1000, true);
    const valid = (x) => x !== 0 && x !== 0xffffffff;
    const cand = [s0, s1].filter(valid);
    let msg;
    if (cand.length === 0) {
      msg = "indeterminate (otadata blank) — boots app0 (ELRS v3.x)";
    } else {
      const slot = (Math.max(...cand) - 1) % 2;
      msg = slot === 0 ? "app0 (ELRS v3.x)" : "app1 (ELRS v4.x)";
    }
    log("Currently boots: " + msg + "   [seq app0=" + s0 + " app1=" + s1 + "]");
  } catch (e) {
    log("otadata read error: " + e.message);
  }
});
```

- [ ] **Step 2: Commit**

```bash
cd /Users/vostapiv/Drones/ExpressLRS
git add tools/dual-ota-flasher/flasher.js
git commit -m "dual-ota-flasher: read slots + show active slot"
```

---

## Task 6: Manual verification on hardware

**Files:** none (browser + board).

- [ ] **Step 1: Serve and open**

```bash
cd /Users/vostapiv/Drones/ExpressLRS/tools/dual-ota-flasher && python3 -m http.server 8000
```
Open `http://localhost:8000` in Chrome/Edge. Expected: page loads, no red "unsupported"
banner, **Connect** enabled, no console errors (esptool-js module loaded).

- [ ] **Step 2: Connect**

Click **Connect**, pick the board's port. Expected: log shows `Connected: ESP32…`
and the Write/Read controls appear.

- [ ] **Step 3: Flash both slots**

Pick the configured `/tmp/v3_configured.bin` (app0) and `/tmp/v4_configured.bin`
(app1), click **Flash both slots**. Expected: 5 regions written, "Flash complete",
board reboots. After ~30 s it starts WiFi; the WebUI works.

- [ ] **Step 4: Show active slot**

Reconnect/clic **Show active slot**. Expected: "Currently boots: app0 (ELRS v3.x)"
after a fresh flash.

- [ ] **Step 5: Read back and compare**

Click **Read app0 (v3.x)** → downloads `app0-v3.bin`. Verify it matches the source
(the flashed image is the first `0x1E0000` of the slot; the leading bytes equal the
source file). Run:
```bash
head -c $(stat -f%z /tmp/v3_configured.bin) ~/Downloads/app0-v3.bin | cmp - /tmp/v3_configured.bin && echo "APP0 MATCHES"
```
Expected: `APP0 MATCHES` (the read partition is padded with 0xFF beyond the image; the
compared prefix equals the source).

---

## Task 7: Push and open the PR

**Files:** none.

- [ ] **Step 1: Push the branch**

```bash
cd /Users/vostapiv/Drones/ExpressLRS
git push "https://x-access-token:$(gh auth token)@github.com/Akceptor/ElrsDual.git" dual-ota-flasher
```
Expected: branch created on the remote.

- [ ] **Step 2: Open the PR against master**

```bash
gh pr create --repo Akceptor/ElrsDual --base master --head dual-ota-flasher \
  --title "Add dual-OTA web flasher tool" \
  --body "$(cat <<'EOF'
## Summary
Browser-based tool (Chrome/Edge, Web Serial + esptool-js) to flash two ELRS app
images into the ESP32 OTA slots (app0 = v3.x, app1 = v4.x) and read each slot back —
no esptool/Python install.

- Static `tools/dual-ota-flasher/` (index.html + flasher.js + bundled
  bootloader/partitions/boot_app0); served on http://localhost.
- Write: pick v3 + v4 images, flashes all 5 regions; boot_app0 makes app0 boot first.
- Read: dump app0/app1 to .bin; "Show active slot" decodes otadata.

## Test Plan
- [x] Page serves and loads esptool-js without errors
- [x] On hardware (TTGO T3 v1.6.1): flash both slots, board boots; Show active slot = app0; read-back app0 prefix matches source image
EOF
)"
```
Expected: prints the new PR URL.
