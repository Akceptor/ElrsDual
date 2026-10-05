import { ESPLoader, Transport } from "../dual-ota-flasher/esptool-bundle.js";
import { MESHTASTIC_REPO, MESHTASTIC_BOARDS, MESHTASTIC_FIRMWARE, MESHTASTIC_CHIPS } from "./config.js";
import { markFlashed, resetMap, setChip } from "./memmap.js";

const FLASH_ADDR = 0x0; // factory image = bootloader + partition table + app, all in one blob

let transport = null;
let esploader = null;
let stagedBytes = null;   // Uint8Array ready to flash, from whichever source was last prepared
let stagedBoard = null;   // board key of a fetched published build; null for a local file
let connectedChip = null;

const SUPPORTED_CHIPS = [...new Set(Object.values(MESHTASTIC_CHIPS))];

const $ = (id) => document.getElementById(id);
const logEl = $("log");
export function log(msg) { logEl.textContent += msg + "\n"; logEl.scrollTop = logEl.scrollHeight; }

const terminal = {
  clean() { logEl.textContent = ""; },
  writeLine(data) { log(data); },
  write(data) { logEl.textContent += data; logEl.scrollTop = logEl.scrollHeight; },
};

const ACTION_IDS = ["connect", "fetch-build", "flash"];
function setBusy(busy, label) {
  for (const id of ACTION_IDS) { const el = $(id); if (el) el.disabled = busy; }
  const act = $("log-activity");
  if (act) act.textContent = busy && label ? " (" + label + ")" : "";
  const bar = $("busy-bar");
  if (bar) bar.hidden = !busy;
  if (!busy) updateFlashButton();
}

function updateFlashButton() {
  $("flash").disabled = !(esploader && stagedBytes);
}

if (!navigator.serial) {
  $("unsupported").style.display = "block";
  $("connect").disabled = true;
}

function setConnUI(connected) {
  $("connect").textContent = connected ? "Disconnect" : "Connect";
  updateFlashButton();
}

async function disconnect() {
  try { await transport?.disconnect(); } catch (_) {}
  esploader = null;
  transport = null;
  connectedChip = null;
  setConnUI(false);
}

$("connect").addEventListener("click", async () => {
  if (esploader) { await disconnect(); log("Disconnected."); return; }
  try {
    const port = await navigator.serial.requestPort();
    const baud = parseInt($("baud").value, 10) || 460800;

    // No EdgeTX-passthrough path here (unlike dual-ota-flasher/flasher.js) — this is a
    // plain RX board on a USB-UART bridge (or native USB-JTAG), never behind a TX radio.
    const t = new Transport(port, true);
    const loader = new ESPLoader({ transport: t, baudrate: baud, terminal, debugLogging: false });
    // Leave reset-mode selection to esptool-js's own defaults: it already picks
    // UsbJtagSerialReset vs. classic DTR/RTS reset based on the detected USB descriptor.
    const chip = await loader.main();
    if (!loader.chip) throw new Error("chip not detected — hold BOOT and retry");

    const chipName = (loader.chip.CHIP_NAME || "").toString();
    let mb = 0;
    try {
      const id = await loader.readFlashId();
      const m = /^(\d+)MB$/.exec(loader.DETECTED_FLASH_SIZES[(id >> 16) & 0xff] || "");
      mb = m ? parseInt(m[1], 10) : 0;
    } catch (_) { /* size detection failed — treat as unknown */ }

    // Guard: only chips a configured board is built for, with >= 4 MB flash (the shared
    // partition layout needs it). Refuse anything else.
    if (!SUPPORTED_CHIPS.includes(chipName)) {
      log("Unsupported chip: " + (chipName || "unknown") + ". This tool flashes " +
          SUPPORTED_CHIPS.join(" / ") + " (>=4 MB) only — not connecting.");
      try { await t.disconnect(); } catch (_) {}
      return;
    }
    if (mb && mb < 4) {
      log("Flash is only " + mb + " MB — needs >=4 MB. Not connecting.");
      try { await t.disconnect(); } catch (_) {}
      return;
    }

    transport = t;
    esploader = loader;
    connectedChip = chipName;
    setChip(chipName);
    selectBoardForChip(chipName);
    log("Connected: " + chip + "   [" + chipName + ", " + (mb ? mb + " MB flash" : "flash size unknown") + "]");
    setConnUI(true);
  } catch (e) {
    esploader = null;
    transport = null;
    connectedChip = null;
    setConnUI(false);
    log("Connect failed: " + e.message + "  (hold the BOOT button and retry)");
  }
});

// --- firmware source: published build ---

const encPath = (p) => p.split("/").map(encodeURIComponent).join("/");
const MESHTASTIC_RAW = (file) =>
  `https://raw.githubusercontent.com/${MESHTASTIC_REPO.owner}/${MESHTASTIC_REPO.repo}/${MESHTASTIC_REPO.ref}/${encPath(`prebuilt/${file}`)}`;

// The commit-hash segment in MESHTASTIC_FIRMWARE filenames changes on every upstream
// rebuild, so resolve the wildcard against the actual prebuilt/ directory listing —
// same approach as resolveMeshtasticFilename in tools/dual-ota-flasher/builder.js.
let listingCache = null;
async function resolveMeshtasticFilename(board) {
  if (!listingCache) {
    const url = `https://api.github.com/repos/${MESHTASTIC_REPO.owner}/${MESHTASTIC_REPO.repo}/contents/prebuilt?ref=${encodeURIComponent(MESHTASTIC_REPO.ref)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`meshtastic listing HTTP ${res.status}`);
    listingCache = (await res.json()).map((entry) => entry.name);
  }
  const pattern = MESHTASTIC_FIRMWARE[board];
  const re = new RegExp(`^${pattern.replace(/[.]/g, "\\.").replace(/\*/g, "[0-9a-f]+")}$`);
  const match = listingCache.find((name) => re.test(name));
  if (!match) throw new Error(`no published build for ${board} yet`);
  return match;
}

function fillBoards() {
  $("board").innerHTML = Object.entries(MESHTASTIC_BOARDS)
    .map(([label, key]) => `<option value="${key}">${label}</option>`).join("");
}
fillBoards();

// Keep the selected board in the URL (?board=<key>) so a link pre-selects it.
function applyURLParams() {
  const board = new URLSearchParams(location.search).get("board");
  const sel = $("board");
  if (board && [...sel.options].some((o) => o.value === board)) sel.value = board;
}
function updateURL() {
  const p = new URLSearchParams(location.search);
  p.set("board", $("board").value);
  history.replaceState(null, "", `?${p.toString()}`);
}
applyURLParams();
updateURL();
$("board").addEventListener("change", updateURL);

function selectBoardForChip(chipName) {
  const sel = $("board");
  if (MESHTASTIC_CHIPS[sel.value] === chipName) return;
  const opt = [...sel.options].find((o) => MESHTASTIC_CHIPS[o.value] === chipName);
  if (opt) {
    sel.value = opt.value;
    updateURL();
    log(`Board set to ${opt.text} to match the connected chip.`);
  }
}

$("fetch-build").addEventListener("click", async () => {
  const board = $("board").value;
  const boardLabel = $("board").options[$("board").selectedIndex].text;
  setBusy(true, "fetching build");
  $("fetch-status").textContent = "resolving filename…";
  try {
    const filename = await resolveMeshtasticFilename(board);
    $("fetch-status").textContent = `fetching ${filename}…`;
    const res = await fetch(MESHTASTIC_RAW(filename));
    if (!res.ok) throw new Error(`firmware HTTP ${res.status}`);
    stagedBytes = new Uint8Array(await res.arrayBuffer());
    stagedBoard = board;
    $("fetch-status").textContent = `ready: ${filename} (${stagedBytes.length} bytes)`;
    log(`Fetched ${filename} for ${boardLabel} (${stagedBytes.length} bytes).`);
  } catch (e) {
    $("fetch-status").textContent = "error: " + (e.message || e);
    log("Fetch error: " + (e.message || e));
    stagedBytes = null;
    stagedBoard = null;
  } finally {
    setBusy(false);
  }
});

// --- firmware source: local file ---

$("local-file").addEventListener("change", async () => {
  const file = $("local-file").files[0];
  if (!file) return;
  document.querySelector('input[name="source"][value="local"]').checked = true;
  stagedBytes = new Uint8Array(await file.arrayBuffer());
  stagedBoard = null;
  log(`Loaded local file ${file.name} (${stagedBytes.length} bytes).`);
  updateFlashButton();
});

// A "published" vs. "local" radio pick alone doesn't change stagedBytes — it's just
// which UI half is emphasised. Selecting a local file or fetching a build is what
// actually stages bytes; keep the source radios visually in sync when the user drives
// the underlying controls rather than the radio itself.
$("board").addEventListener("change", () => {
  document.querySelector('input[name="source"][value="published"]').checked = true;
});

// --- flash ---

$("flash").addEventListener("click", async () => {
  if (!esploader) { log("Connect first."); return; }
  if (!stagedBytes) { log("Fetch a published build or pick a local file first."); return; }
  const wantChip = stagedBoard && MESHTASTIC_CHIPS[stagedBoard];
  if (wantChip && wantChip !== connectedChip) {
    log(`Refusing to flash: the fetched build is for ${wantChip} but the connected chip is ${connectedChip}. ` +
        "Pick the matching board and fetch again.");
    return;
  }
  const eraseFirst = $("erase-first").checked;
  setBusy(true, "flashing");
  try {
    if (eraseFirst) {
      log("Erasing chip (clears stale NVS from any prior ExpressLRS install)…");
      await esploader.eraseFlash();
      log("Erase complete.");
    }
    log(`Flashing Meshtastic factory image (${stagedBytes.length} bytes @ 0x${FLASH_ADDR.toString(16)})…`);
    await esploader.writeFlash({
      fileArray: [{ data: stagedBytes, address: FLASH_ADDR }],
      flashMode: "keep",
      flashFreq: "keep",
      flashSize: "keep",
      eraseAll: false,
      compress: true,
      reportProgress: (i, written, total) => {
        if (written === total) log("  written");
        else if (written % (256 * 1024) < 4096) log("  " + Math.floor((written / total) * 100) + "%");
      },
    });
    markFlashed();
    log("Flash complete.");
    // Confirmed on hardware (see firmware repo HANDOFF.md): this board does not reliably
    // auto-restart after an esptool flash, so a normal hard_reset call here would be a
    // silent no-op that looks like a hang. Tell the user instead of guessing at a reset.
    log("IMPORTANT: this board does not reliably auto-restart after flashing. " +
        "Manually reset it or power-cycle it to boot Meshtastic.");
  } catch (e) {
    log("Flash error: " + (e.message || e));
  } finally {
    setBusy(false);
  }
});

resetMap();
