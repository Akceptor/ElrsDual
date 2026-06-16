import { ESPLoader, Transport } from "./esptool-bundle.js";

const APP0_ADDR = 0x10000;
const APP1_ADDR = 0x1F0000;
const APP_SIZE  = 0x1E0000;     // 1.875 MB OTA partition
const OTADATA_ADDR = 0xe000;
const OTADATA_SIZE = 0x2000;

let transport = null;
let esploader = null;

const logEl = document.getElementById("log");
export function log(msg) { logEl.textContent += msg + "\n"; logEl.scrollTop = logEl.scrollHeight; }

const terminal = {
  clean() { logEl.textContent = ""; },
  writeLine(data) { log(data); },
  write(data) { logEl.textContent += data; logEl.scrollTop = logEl.scrollHeight; },
};

const ACTION_IDS = ["connect", "flash", "flash0", "flash1", "read0", "read1", "active", "setslot", "flashboot"];
export function isConnected() { return esploader !== null; }
export { APP0_ADDR, APP1_ADDR };
export function setBusy(busy) {
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
  const controls = document.getElementById("controls");
  // Tear down any prior session first: a failed (re)connect must not leave a
  // half-initialized loader behind still-visible controls. The action buttons
  // guard on `esploader`, so it must be null until we have a fully usable one.
  esploader = null;
  transport = null;
  controls.style.display = "none";
  try {
    const port = await navigator.serial.requestPort();
    const baud = parseInt(document.getElementById("baud").value, 10) || 460800;
    const t = new Transport(port, true);
    const loader = new ESPLoader({ transport: t, baudrate: baud, terminal, debugLogging: false });
    const chip = await loader.main();
    if (!loader.chip) throw new Error("chip not detected — hold BOOT and retry");
    transport = t;
    esploader = loader;
    log("Connected: " + chip);
    controls.style.display = "block";
  } catch (e) {
    esploader = null;
    transport = null;
    controls.style.display = "none";
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

// Flash raw bytes into a single OTA slot in place, leaving the bootloader, partition
// table, the other slot, and the active-slot selection (otadata) untouched. Shared by
// the file-picker handlers (flashSlot) and the builder's staged images (builder.js).
export async function flashData(data, address, slotLabel) {
  if (!esploader) { log("Connect first."); return; }
  if (!data) { log("Nothing to flash for " + slotLabel + "."); return; }
  setBusy(true);
  try {
    log("Flashing " + slotLabel + " (" + data.length + " bytes @ 0x" + address.toString(16) + ")…");
    await esploader.writeFlash({
      fileArray: [{ data, address }],
      flashMode: "keep",
      flashFreq: "keep",
      flashSize: "keep",
      eraseAll: false,
      compress: true,
      reportProgress: (i, written, total) => { if (written === total) log("  " + slotLabel + " written"); },
    });
    log("Flash complete. Resetting…");
    await esploader.after("hard_reset");
    log("Done — " + slotLabel + " updated. Board boots the currently-active slot (use Set active to switch).");
  } catch (e) {
    log("Flash error: " + e.message);
  } finally {
    setBusy(false);
  }
}

async function flashSlot(file, address, slotLabel) {
  if (!file) { log("Pick the " + slotLabel + " image first."); return; }
  log("Loading " + slotLabel + " image…");
  await flashData(await fileToUint8(file), address, slotLabel);
}

document.getElementById("flash0").addEventListener("click", () =>
  flashSlot(document.getElementById("v3file").files[0], APP0_ADDR, "app0 (v3.x)"));
document.getElementById("flash1").addEventListener("click", () =>
  flashSlot(document.getElementById("v4file").files[0], APP1_ADDR, "app1 (v4.x)"));

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

const READ_CHUNK = 0x20000; // 128 KB per readFlash call (large single reads stall)

async function readChunk(addr, len) {
  let lastErr;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      return await esploader.readFlash(addr, len, () => {});
    } catch (e) {
      lastErr = e;
      log("  chunk @0x" + addr.toString(16) + " attempt " + attempt + "/4 failed: " + e.message);
      await new Promise((r) => setTimeout(r, 400));
    }
  }
  throw lastErr;
}

async function readSlot(addr, filename) {
  if (!esploader) { log("Connect first."); return; }
  setBusy(true);
  log("Reading " + filename + " (" + APP_SIZE + " bytes) in " + (APP_SIZE / READ_CHUNK) + " chunks…");
  const out = new Uint8Array(APP_SIZE);
  try {
    let off = 0;
    while (off < APP_SIZE) {
      const len = Math.min(READ_CHUNK, APP_SIZE - off);
      const part = await readChunk(addr + off, len);
      out.set(part.length === len ? part : part.subarray(0, len), off);
      off += len;
      log("  " + Math.floor((off / APP_SIZE) * 100) + "%");
    }
    downloadBytes(out, filename);
    log("Saved " + filename);
  } catch (e) {
    log("Read error: " + e.message + "  — try a lower baud (115200) before connecting.");
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
    let msg, slot;
    if (cand.length === 0) {
      msg = "indeterminate (otadata blank) — boots app0 (ELRS v3.x)";
      slot = 0;
    } else {
      slot = (Math.max(...cand) - 1) % 2;
      msg = slot === 0 ? "app0 (ELRS v3.x)" : "app1 (ELRS v4.x)";
    }
    log("Currently boots: " + msg + "   [seq app0=" + s0 + " app1=" + s1 + "]");
    const radio = document.querySelector(`input[name="slotsel"][value="${slot}"]`);
    if (radio) radio.checked = true;
  } catch (e) {
    log("otadata read error: " + e.message);
  } finally {
    setBusy(false);
  }
});

// Standard reflected CRC32, matching ESP-IDF's bootloader_common_crc32
function crc32(data) {
  let crc = 0xFFFFFFFF;
  for (const b of data) {
    crc ^= b;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// Build a fresh 8192-byte otadata that selects the given slot.
// esp_ota_select_entry_t layout: ota_seq (4B) | seq_label (20B, 0xFF) | crc32 (4B)
// Active slot = (max_valid_seq - 1) % 2, so seq=1 → slot 0, seq=2 → slot 1.
function buildOtadata(slot) {
  const buf = new Uint8Array(OTADATA_SIZE).fill(0xFF);
  const seq = slot === 0 ? 1 : 2;
  const dv = new DataView(buf.buffer);
  dv.setUint32(0x0000, seq, true);                          // ota_seq (record 0)
  const seqBytes = new Uint8Array(4);
  new DataView(seqBytes.buffer).setUint32(0, seq, true);
  dv.setUint32(0x0018, crc32(seqBytes), true);              // CRC at offset 24
  // record 1 at 0x1000 stays all 0xFF → invalid
  return buf;
}

document.getElementById("flashboot").addEventListener("click", async () => {
  if (!esploader) { log("Connect first."); return; }
  setBusy(true);
  try {
    log("Loading slot-switch bootloader…");
    const boot = await fetchBin("bootloader-slotswitch.bin");
    log("Writing bootloader to 0x1000 (" + boot.length + " bytes)…");
    await esploader.writeFlash({
      fileArray: [{ data: boot, address: 0x1000 }],
      flashMode: "keep", flashFreq: "keep", flashSize: "keep",
      eraseAll: false, compress: true,
      reportProgress: (i, written, total) => { if (written === total) log("  bootloader written"); },
    });
    await esploader.after("hard_reset");
    log("Slot-switch bootloader installed. 3 quick power cycles now flips the slot.");
  } catch (e) {
    log("Bootloader flash error: " + e.message);
  } finally {
    setBusy(false);
  }
});

document.getElementById("setslot").addEventListener("click", async () => {
  if (!esploader) { log("Connect first."); return; }
  const sel = document.querySelector('input[name="slotsel"]:checked');
  if (!sel) { log("Select a slot first."); return; }
  const slot = parseInt(sel.value, 10);
  setBusy(true);
  try {
    await esploader.writeFlash({
      fileArray: [{ data: buildOtadata(slot), address: OTADATA_ADDR }],
      flashMode: "keep", flashFreq: "keep", flashSize: "keep",
      eraseAll: false, compress: true, reportProgress: () => {},
    });
    await esploader.after("hard_reset");
    log("Active slot → " + (slot === 0 ? "app0 (ELRS v3.x)" : "app1 (ELRS v4.x)") + ". Rebooting…");
  } catch (e) {
    log("Set slot error: " + e.message);
  } finally {
    setBusy(false);
  }
});
