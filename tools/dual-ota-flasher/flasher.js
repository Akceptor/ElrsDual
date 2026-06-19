import { ESPLoader, Transport } from "./esptool-bundle.js";
import { etxPassthrough } from "./passthrough.js";

const APP0_ADDR = 0x10000;
const APP1_ADDR = 0x1F0000;
const APP_SIZE  = 0x1E0000;     // 1.875 MB OTA partition
const OTADATA_ADDR = 0xe000;
const OTADATA_SIZE = 0x2000;

let transport = null;
let esploader = null;
let viaPassthrough = false;   // connected through an EdgeTX radio bridge?
let lastPort = null;          // raw SerialPort — retained after disconnect so provision can reuse it

const logEl = document.getElementById("log");
// Empty log shows a Ukrainian-flag backdrop; reverts to the terminal once anything is logged.
function logFlag(on) { logEl.classList.toggle("flag", on); }
export function log(msg) { logEl.textContent += msg + "\n"; logEl.scrollTop = logEl.scrollHeight; logFlag(false); }

const terminal = {
  clean() { logEl.textContent = ""; logFlag(true); },
  writeLine(data) { log(data); },
  write(data) { logEl.textContent += data; logEl.scrollTop = logEl.scrollHeight; logFlag(false); },
};
logFlag(!logEl.textContent);

const ACTION_IDS = ["connect", "detect", "flash", "flash0", "flash1", "read0", "read1", "active", "setslot", "flashboot",
  "bld-build", "bld-flash-staged-0", "bld-flash-staged-1", "bld-flash-staged-both"];
export function isConnected() { return esploader !== null; }
export function getLastPort() { return lastPort; }
export { APP0_ADDR, APP1_ADDR };
export function setBusy(busy, label) {
  for (const id of ACTION_IDS) {
    const el = document.getElementById(id);
    if (el) el.disabled = busy;
  }
  const act = document.getElementById("log-activity");
  if (act) act.textContent = busy && label ? " (" + label + ")" : "";
  // Let builder.js re-apply staging constraints (which staged buttons should stay disabled).
  if (window.onBusyChange) window.onBusyChange(busy);
}

// Reboot the board. esptool-js after("hard_reset") only releases RTS (it assumes EN was
// already held low), which on these UART adapters doesn't actually cycle the chip — so the
// board never reboots. Do the full pulse ourselves: GPIO0 high (boot app), EN low, release.
async function hardReboot() {
  if (viaPassthrough) {
    // RTS/DTR here toggle the radio's VCP, not the module — can't reset it from here.
    log("Flashed via EdgeTX passthrough — power-cycle the radio to run the new firmware.");
  } else {
    try {
      await transport.setDTR(false);   // GPIO0 high → run the app, not the bootloader
      await transport.setRTS(true);    // EN low → assert reset
      await new Promise((r) => setTimeout(r, 100));
      await transport.setRTS(false);   // EN high → out of reset, boots
    } catch (e) {
      log("Reset error: " + (e.message || e) + " — power-cycle the board to reboot.");
    }
  }
  // The chip has left the bootloader and is running the app — the esptool session is now
  // stale, so drop the connection (reconnect to do more).
  await disconnect();
}

if (!navigator.serial) {
  document.getElementById("unsupported").style.display = "block";
  document.getElementById("connect").disabled = true;
}

// Reflect connection state in the UI: show/hide flashing controls, flip the connect
// button between Connect/Disconnect (via i18n), and enable the Detect button.
function setConnUI(connected) {
  document.getElementById("controls").style.display = connected ? "block" : "none";
  const c = document.getElementById("connect");
  c.setAttribute("data-i18n", connected ? "btn_disconnect" : "btn_connect");
  const d = document.getElementById("detect");
  if (d) d.disabled = !connected;
  if (window.i18nRefresh) window.i18nRefresh();
}

async function disconnect() {
  lastPort = transport?.device ?? lastPort;  // keep port reference for RNode provision reuse
  try { await transport?.disconnect(); } catch (_) {}
  esploader = null;
  transport = null;
  viaPassthrough = false;
  setConnUI(false);
  document.dispatchEvent(new CustomEvent("ui-reset"));   // clear staged state + diagram
  log("Disconnected.");
}

document.getElementById("connect").addEventListener("click", async () => {
  if (esploader) { await disconnect(); return; }   // toggle: disconnect when connected
  esploader = null;
  transport = null;
  setConnUI(false);
  try {
    const port = await navigator.serial.requestPort();
    const baud = parseInt(document.getElementById("baud").value, 10) || 460800;

    // EdgeTX radios expose an STM32 USB CDC (VID 0x0483), not an ESP directly. Run EdgeTX
    // passthrough to bridge the radio's UART to the internal module (held in bootloader),
    // then talk esptool over the same port. The bridge baud is fixed, so pin esptool's
    // connect/stub baud to it (romBaudrate = baud) to avoid a mid-stream baud change.
    const info = (port.getInfo && port.getInfo()) || {};
    const isRadio = info.usbVendorId === 0x0483;
    if (isRadio) {
      log("EdgeTX radio (STM32 VCP) — initialising passthrough to the internal module @ " + baud + "…");
      await etxPassthrough(port, baud, log);
      log("Passthrough ready. Syncing esptool with the module…");
    }

    const t = new Transport(port, true);
    const loader = new ESPLoader({ transport: t, baudrate: baud, terminal, debugLogging: false });
    if (isRadio) loader.romBaudrate = baud;
    const chip = await loader.main();
    if (!loader.chip) throw new Error("chip not detected — hold BOOT and retry");

    // Guard: this dual-OTA tool only supports a plain ESP32 with >= 4 MB flash
    // (bundled bootloader/partitions are esp32 4 MB min_spiffs). Refuse anything else.
    const chipName = (loader.chip.CHIP_NAME || "").toString();
    let mb = 0;
    try {
      const id = await loader.readFlashId();
      const m = /^(\d+)MB$/.exec(loader.DETECTED_FLASH_SIZES[(id >> 16) & 0xff] || "");
      mb = m ? parseInt(m[1], 10) : 0;
    } catch (_) { /* size detection failed — treat as unknown */ }

    if (chipName !== "ESP32") {
      log("Unsupported chip: " + (chipName || "unknown") +
          ". This tool flashes a plain ESP32 (≥4 MB) only — not connecting.");
      try { await t.disconnect(); } catch (_) {}
      return;
    }
    if (mb && mb < 4) {
      log("Flash is only " + mb + " MB — dual-OTA needs ≥4 MB. Not connecting.");
      try { await t.disconnect(); } catch (_) {}
      return;
    }

    transport = t;
    esploader = loader;
    lastPort = port;
    viaPassthrough = isRadio;
    log("Connected: " + chip + "   [" + chipName + ", " + (mb ? mb + " MB flash" : "flash size unknown") +
        (isRadio ? ", via EdgeTX passthrough" : "") + "]");
    setConnUI(true);
  } catch (e) {
    esploader = null;
    transport = null;
    setConnUI(false);
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
  if (!esploader) { log("Connect first."); return false; }
  if (!data) { log("Nothing to flash for " + slotLabel + "."); return false; }
  setBusy(true, "writing " + slotLabel);
  let ok = false;
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
    await hardReboot();
    log("Done — " + slotLabel + " updated. Board boots the currently-active slot (use Set active to switch).");
    ok = true;
  } catch (e) {
    log("Flash error: " + e.message);
  } finally {
    setBusy(false);
  }
  return ok;
}

async function flashSlot(file, address, slotLabel) {
  if (!file) { log("Pick the " + slotLabel + " image first."); return false; }
  log("Loading " + slotLabel + " image…");
  return await flashData(await fileToUint8(file), address, slotLabel);
}

// Notify the flash-map widget (memmap.js) of state changes.
const mm = (detail) => document.dispatchEvent(new CustomEvent("memmap", { detail }));

document.getElementById("flash0").addEventListener("click", async () => {
  if (await flashSlot(document.getElementById("v3file").files[0], APP0_ADDR, "app0 (v3.x)"))
    mm({ type: "flashed", slot: 0, label: "local .bin" });
});
document.getElementById("flash1").addEventListener("click", async () => {
  if (await flashSlot(document.getElementById("v4file").files[0], APP1_ADDR, "app1 (v4.x)"))
    mm({ type: "flashed", slot: 1, label: "local .bin" });
});

// Full provision from raw bytes: bootloader + partition table + otadata (boot app0) +
// both app slots. Use for a fresh/stock board that doesn't yet have the dual-OTA layout.
// Shared by the local-file "Flash both slots" button and the staged "Provision both".
export async function flashFullProvision(app0Data, app1Data, useSlotSwitch = false) {
  if (!esploader) { log("Connect first."); return false; }
  if (!app0Data || !app1Data) { log("Need both a v3.x (app0) and v4.x (app1) image."); return false; }
  setBusy(true, "writing both slots + bootloader");
  let ok = false;
  try {
    const bootName = useSlotSwitch ? "bootloader-slotswitch.bin" : "bootloader.bin";
    log("Loading bundled boot blobs (" + bootName + ")…");
    const [bootloader, partitions, bootApp0] = await Promise.all([
      fetchBin(bootName), fetchBin("partitions.bin"), fetchBin("boot_app0.bin"),
    ]);
    const fileArray = [
      { data: bootloader, address: 0x1000 },
      { data: partitions, address: 0x8000 },
      { data: bootApp0,   address: OTADATA_ADDR },
      { data: app0Data,   address: APP0_ADDR },
      { data: app1Data,   address: APP1_ADDR },
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
    await hardReboot();
    log("Done — board reboots into app0 (ELRS v3.x).");
    ok = true;
  } catch (e) {
    log("Flash error: " + e.message);
  } finally {
    setBusy(false);
  }
  return ok;
}

document.getElementById("flash").addEventListener("click", async () => {
  const f3 = document.getElementById("v3file").files[0];
  const f4 = document.getElementById("v4file").files[0];
  if (!f3 || !f4) { log("Pick both the v3.x and v4.x images first."); return; }
  if (await flashFullProvision(await fileToUint8(f3), await fileToUint8(f4))) {
    mm({ type: "flashed", slot: 0, label: "local .bin" });
    mm({ type: "flashed", slot: 1, label: "local .bin" });
    mm({ type: "active", slot: 0 });
    mm({ type: "bootloader", value: "stock" });
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
  setBusy(true, "reading " + (addr === APP0_ADDR ? "app0" : "app1"));
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

// Read raw flash bytes (with retry). Returns null if not connected. Used by the
// target-detect feature in builder.js.
export async function readFlashBytes(addr, len) {
  if (!esploader) return null;
  return await readChunk(addr, len);
}

// Which OTA slot boots, per the bootloader's otadata rules (CRC-validated entries).
export async function readActiveSlot() {
  if (!esploader) return 0;
  const od = await esploader.readFlash(OTADATA_ADDR, OTADATA_SIZE, () => {});
  const dv = new DataView(od.buffer, od.byteOffset, od.byteLength);
  const seqAt = (base) => {
    const seq = dv.getUint32(base, true);
    const crc = dv.getUint32(base + 0x1C, true);
    return (seq !== 0 && seq !== 0xffffffff && crc === entryCrc(seq)) ? seq : 0;
  };
  const cand = [seqAt(0x0000), seqAt(0x1000)].filter((x) => x > 0);
  return cand.length ? (Math.max(...cand) - 1) % 2 : 0;
}

document.getElementById("active").addEventListener("click", async () => {
  if (!esploader) { log("Connect first."); return; }
  setBusy(true, "reading active slot");
  try {
    const slot = await readActiveSlot();
    log("Currently boots: " + (slot === 0 ? "app0 (ELRS v3.x)" : "app1 (ELRS v4.x)"));
    const radio = document.querySelector(`input[name="slotsel"][value="${slot}"]`);
    if (radio) radio.checked = true;
    mm({ type: "active", slot });
  } catch (e) {
    log("otadata read error: " + e.message);
  } finally {
    setBusy(false);
  }
});

// CRC used by ESP-IDF otadata (esp_rom_crc32_le): reflected poly 0xEDB88320,
// init 0x00000000, final XOR 0xFFFFFFFF. NOTE: init is 0, not 0xFFFFFFFF — that
// distinction is why a slot set with the wrong CRC was ignored by the bootloader.
function crc32(data) {
  let crc = 0x00000000;
  for (const b of data) {
    crc ^= b;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// Build a fresh 8192-byte otadata that selects the given slot.
// esp_ota_select_entry_t (32 B): ota_seq u32 @0 | seq_label[20] @4 | ota_state u32 @24 | crc u32 @28.
// The (stock + slot-switch) bootloader treats an entry as valid only when
// crc == crc32(ota_seq) — the CRC MUST sit at offset 0x1C, not 0x18 (ota_state).
// Active slot = (max_valid_seq - 1) % 2, so seq=1 → slot 0, seq=2 → slot 1.
function entryCrc(seq) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, seq, true);
  return crc32(b);
}
function buildOtadata(slot) {
  const buf = new Uint8Array(OTADATA_SIZE).fill(0xFF);
  const seq = slot === 0 ? 1 : 2;
  const dv = new DataView(buf.buffer);
  dv.setUint32(0x0000, seq, true);              // ota_seq (record 0)
  dv.setUint32(0x001C, entryCrc(seq), true);    // crc @0x1C — what the bootloader validates
  // ota_state @0x18 and seq_label stay 0xFF; record 1 @0x1000 stays all 0xFF → invalid
  return buf;
}

document.getElementById("flashboot").addEventListener("click", async () => {
  if (!esploader) { log("Connect first."); return; }
  setBusy(true, "writing bootloader");
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
    await hardReboot();
    log("Slot-switch bootloader installed. 3 quick power cycles now flips the slot.");
    mm({ type: "bootloader", value: "custom" });
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
  setBusy(true, "setting active slot");
  try {
    await esploader.writeFlash({
      fileArray: [{ data: buildOtadata(slot), address: OTADATA_ADDR }],
      flashMode: "keep", flashFreq: "keep", flashSize: "keep",
      eraseAll: false, compress: true, reportProgress: () => {},
    });
    await hardReboot();
    log("Active slot → " + (slot === 0 ? "app0 (ELRS v3.x)" : "app1 (ELRS v4.x)") + ". Rebooting…");
    mm({ type: "active", slot });
  } catch (e) {
    log("Set slot error: " + e.message);
  } finally {
    setBusy(false);
  }
});
