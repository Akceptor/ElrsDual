import { ESPLoader, Transport } from "./esptool-bundle.js";

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

const ACTION_IDS = ["connect", "flash", "read0", "read1", "active"];
function setBusy(busy) {
  for (const id of ACTION_IDS) {
    const el = document.getElementById(id);
    if (el) el.disabled = busy;
  }
}

if (!navigator.serial) {
  document.getElementById("unsupported").style.display = "block";
  document.getElementById("connect").disabled = true;
}

document.getElementById("connect").addEventListener("click", async () => {
  try {
    const port = await navigator.serial.requestPort();
    const baud = parseInt(document.getElementById("baud").value, 10) || 460800;
    transport = new Transport(port, true);
    esploader = new ESPLoader({ transport, baudrate: baud, terminal, debugLogging: false });
    const chip = await esploader.main();
    log("Connected: " + chip);
    document.getElementById("controls").style.display = "block";
  } catch (e) {
    log("Connect failed: " + e.message + "  (hold the BOOT button and retry)");
  }
});

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
  setBusy(true);
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
    setBusy(false);
  }
});

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
  setBusy(true);
  log("Reading " + filename + " (" + APP_SIZE + " bytes) — ~1 minute…");
  let lastPct = -10;
  try {
    const data = await esploader.readFlash(addr, APP_SIZE, (pkt, progress, total) => {
      const pct = Math.floor((progress / total) * 100);
      if (pct >= lastPct + 10) { lastPct = pct; log("  " + pct + "%"); }
    });
    downloadBytes(data, filename);
    log("Saved " + filename);
  } catch (e) {
    log("Read error: " + e.message);
  } finally {
    setBusy(false);
  }
}

document.getElementById("read0").addEventListener("click", () => readSlot(APP0_ADDR, "app0-v3.bin"));
document.getElementById("read1").addEventListener("click", () => readSlot(APP1_ADDR, "app1-v4.bin"));

document.getElementById("active").addEventListener("click", async () => {
  if (!esploader) { log("Connect first."); return; }
  setBusy(true);
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
  } finally {
    setBusy(false);
  }
});
