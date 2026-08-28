import { REPO, BRANCHES, ARTIFACT_BRANCH, TARGETS, DOMAINS, RNODE_BOARDS, MESHTASTIC_REPO, MESHTASTIC_BOARDS, MESHTASTIC_FIRMWARE } from "./config.js";
import { flattenTargets, filterEsp32Targets, targetToEnv } from "./targets.js";
import { buildDefines, appendConfig } from "./configure.js";
import { flashData, flashFullProvision, log, isConnected, setBusy, readFlashBytes, readActiveSlot, APP0_ADDR, APP1_ADDR } from "./flasher.js";
import { provisionRNode } from "./rnode-provision.js";

const DOMAIN_BY_NUM = ["au_915", "fcc_915", "eu_868", "in_866", "au_433", "eu_433", "us_433", "us_433_wide"];

// Public raw URLs (no token, CORS *). Path segments are encoded individually so filenames
// with spaces work; the ref segments here have no slashes so they pass through fine.
const encPath = (p) => p.split("/").map(encodeURIComponent).join("/");
const TARGETS_RAW = (path) =>
  `https://raw.githubusercontent.com/${TARGETS.owner}/${TARGETS.repo}/${TARGETS.ref}/${encPath(path)}`;
const FIRMWARE_RAW = (version, env) =>
  `https://raw.githubusercontent.com/${REPO.owner}/${REPO.repo}/${ARTIFACT_BRANCH}/${encPath(`${version}/${env}/firmware.bin`)}`;
const MESHTASTIC_RAW = (file) =>
  `https://raw.githubusercontent.com/${MESHTASTIC_REPO.owner}/${MESHTASTIC_REPO.repo}/${MESHTASTIC_REPO.ref}/${encPath(`prebuilt/${file}`)}`;

// The commit-hash segment in MESHTASTIC_FIRMWARE filenames changes on every upstream
// rebuild, so resolve the wildcard against the actual prebuilt/ directory listing.
let meshtasticListingCache = null;
async function resolveMeshtasticFilename(board, sync) {
  if (!meshtasticListingCache) {
    const url = `https://api.github.com/repos/${MESHTASTIC_REPO.owner}/${MESHTASTIC_REPO.repo}/contents/prebuilt?ref=${encodeURIComponent(MESHTASTIC_REPO.ref)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`meshtastic listing HTTP ${res.status}`);
    meshtasticListingCache = (await res.json()).map((entry) => entry.name);
  }
  const pattern = MESHTASTIC_FIRMWARE[board].replace("{sync}", sync);
  const re = new RegExp(`^${pattern.replace(/[.]/g, "\\.").replace(/\*/g, "[0-9a-f]+")}$`);
  const match = meshtasticListingCache.find((name) => re.test(name));
  if (!match) throw new Error(`no published build for ${board} · sync ${sync} yet`);
  return match;
}

const staged = { 0: null, 1: null };
let esp32 = [];

const $ = (id) => document.getElementById(id);

// Sync-word selector only makes sense for boards whose firmware pattern actually has
// a {sync} slot (LR11xx-capable hardware); plain SX127x boards ship a single build.
function onMeshtasticBoardChange() {
  const board = $("bld-meshtastic-board")?.value;
  const supportsSync = MESHTASTIC_FIRMWARE[board]?.includes("{sync}") ?? true;
  $("meshtastic-sync-field").hidden = !supportsSync;
  $("meshtastic-sync-warning").hidden = !supportsSync || $("bld-meshtastic-sync").value !== "0x12";
}

function onVersionChange() {
  const version = $("bld-version").value;
  const isRNode = version === "rnode";
  const isMeshtastic = version === "meshtastic";
  $("elrs-fields").hidden = isRNode || isMeshtastic;
  $("rnode-fields").hidden = !isRNode;
  $("meshtastic-fields").hidden = !isMeshtastic;
}

const setStatus = (m) => { $("bld-status").textContent = m; };
const mm = (detail) => document.dispatchEvent(new CustomEvent("memmap", { detail }));

// --- cascading target selection: Vendor -> Type -> Device (like the official flasher) ---
const CATEGORY_LABELS = {
  tx_2400: "2.4 GHz Transmitter (TX)", rx_2400: "2.4 GHz Receiver (RX)",
  tx_900: "900 MHz Transmitter (TX)",  rx_900: "900 MHz Receiver (RX)",
  tx_dual: "Dual-band Transmitter (TX)", rx_dual: "Dual-band Receiver (RX)",
};
const catLabel = (c) => CATEGORY_LABELS[c] || c;
const prettyVendor = (m) => m.charAt(0).toUpperCase() + m.slice(1);
const opts = (pairs) => pairs.map(([v, t]) => `<option value="${v}">${t}</option>`).join("");

const vendors = () => [...new Set(esp32.map((t) => t.mfr))].sort((a, b) => a.localeCompare(b));
const categories = (mfr) => [...new Set(esp32.filter((t) => t.mfr === mfr).map((t) => t.cat))].sort();
const devices = (mfr, cat) =>
  esp32.filter((t) => t.mfr === mfr && t.cat === cat).sort((a, b) => a.dev.product_name.localeCompare(b.dev.product_name));

function fillVendors() { $("bld-vendor").innerHTML = opts(vendors().map((m) => [m, prettyVendor(m)])); fillCategories(); }
function fillCategories() {
  $("bld-category").innerHTML = opts(categories($("bld-vendor").value).map((c) => [c, catLabel(c)]));
  fillDevices();
}
function fillDevices() {
  $("bld-device").innerHTML = opts(devices($("bld-vendor").value, $("bld-category").value).map((t) => [t.id, t.dev.product_name]));
}
const selectedTarget = () => esp32.find((t) => t.id === $("bld-device").value);

// Staged-flash buttons are only usable when the relevant slot(s) are staged.
function updateFlashButtons() {
  const b0 = $("bld-flash-staged-0"), b1 = $("bld-flash-staged-1"), bb = $("bld-flash-staged-both");
  if (b0) b0.disabled = !staged[0];
  if (b1) b1.disabled = !staged[1];
  if (bb) bb.disabled = !(staged[0] && staged[1]);
}

async function loadTargets() {
  setStatus("loading targets…");
  const res = await fetch(TARGETS_RAW("targets.json"));
  if (!res.ok) throw new Error(`targets.json HTTP ${res.status}`);
  esp32 = filterEsp32Targets(flattenTargets(await res.json())).map((t) => {
    const [mfr, cat, device] = t.id.split(".");
    return { ...t, mfr, cat, device };
  });
  fillVendors();
  setStatus("");
}

async function fetchLayout(dev) {
  const dir = dev.firmware.includes("_TX") ? "TX" : "RX";
  const res = await fetch(TARGETS_RAW(`${dir}/${dev.layout_file}`));
  if (!res.ok) throw new Error(`layout HTTP ${res.status}`);
  return res.json();
}

async function prepareAndStage() {
  const versionLabel = $("bld-version").value;
  const slot = Number($("bld-slot").value);
  let env, fetchLabel;

  if (versionLabel === "rnode") {
    env = $("bld-rnode-board").value;
    const sel = $("bld-rnode-board");
    fetchLabel = `RNode · ${sel.options[sel.selectedIndex].text}`;
  } else if (versionLabel === "meshtastic") {
    const boardSelect = $("bld-meshtastic-board");
    fetchLabel = "Meshtastic · " + boardSelect.options[boardSelect.selectedIndex].text
      + " · sync " + $("bld-meshtastic-sync").value;
  } else {
    const target = selectedTarget();
    if (!target) { setStatus("no target selected"); return; }
    env = targetToEnv(target.dev);
    fetchLabel = `${versionLabel} · ${target.dev.product_name} (${$("bld-domain").value})`;
  }

  $("bld-build").disabled = true;
  try {
    setStatus(`fetching ${fetchLabel} firmware…`);
    const res = versionLabel === "meshtastic"
      ? await fetch(MESHTASTIC_RAW(await resolveMeshtasticFilename($("bld-meshtastic-board").value, $("bld-meshtastic-sync").value)))
      : await fetch(FIRMWARE_RAW(versionLabel, env));
    if (res.status === 404)
      throw new Error(`no published build for ${fetchLabel} yet — run the prebuild workflow`);
    if (!res.ok) throw new Error(`firmware HTTP ${res.status}`);
    const generic = new Uint8Array(await res.arrayBuffer());

    let configured;
    if (versionLabel === "rnode" || versionLabel === "meshtastic") {
      configured = generic;          // pre-configured for the board; no configure.js step
    } else {
      setStatus("configuring…");
      const target = selectedTarget();
      const layout = await fetchLayout(target.dev);
      const defines = buildDefines({ phrase: $("bld-phrase").value.trim(), domain: $("bld-domain").value });
      configured = appendConfig(generic,
        { productName: target.dev.product_name, luaName: target.dev.lua_name, defines, layout });
    }

    staged[slot] = { bytes: configured, label: fetchLabel };
    updateFlashButtons();
    mm({ type: "staged", slot, label: fetchLabel });
    setStatus("staged ✓ — Connect, then Flash staged");
    log(`Staged ${fetchLabel} → ${slot === 0 ? "app0" : "app1"} (${configured.length} bytes)`);
  } catch (e) {
    setStatus(`error: ${e.message || e}`);
    log(`Prepare error: ${e.message || e}`);
  } finally {
    $("bld-build").disabled = false;
  }
}

// Find an ASCII needle in a byte array (for bootloader signature detection).
function bytesIndexOf(hay, needle) {
  const n = new TextEncoder().encode(needle);
  outer: for (let i = 0; i <= hay.length - n.length; i++) {
    for (let j = 0; j < n.length; j++) if (hay[i + j] !== n[j]) continue outer;
    return i;
  }
  return -1;
}

// ---- detect the target from firmware already on the board ----
// ELRS appends a config block after the firmware: product_name(128) + lua_name(16) +
// defines JSON(512) + layout(2048). Parse product_name + domain and match a known target.
async function readConfigFromSlot(slotAddr) {
  const hdr = await readFlashBytes(slotAddr, 24);
  if (!hdr || hdr[0] !== 0xe9) return null;     // no valid esp image in this slot
  const segs = hdr[1];
  if (segs === 2) return null;                  // 8285 layout — unsupported
  let pos = 24;
  for (let i = 0; i < segs; i++) {
    const sh = await readFlashBytes(slotAddr + pos, 8);
    if (!sh) return null;
    const size = new DataView(sh.buffer, sh.byteOffset, sh.byteLength).getUint32(4, true);
    pos += 8 + size;
    if (pos > 0x1E0000) return null;            // ran past the partition — bail
  }
  pos = ((pos + 16) & ~15) + 32;                // findFirmwareEnd (esp32 path)
  const blk = await readFlashBytes(slotAddr + pos, 128 + 16 + 512);
  if (!blk) return null;
  const dec = new TextDecoder();
  const cstr = (off, len) => dec.decode(blk.subarray(off, off + len)).replace(/\0[\s\S]*$/, "").trim();
  const product = cstr(0, 128);
  // ELRS product names are printable ASCII (32–126).  Anything else means the config block
  // is absent (RNode firmware, stock firmware, etc.) — return a non-ELRS sentinel so the
  // caller can show a clean "non-ELRS" label instead of null (empty) or garbage.
  if (!product || !/^[\x20-\x7e]+$/.test(product)) return { product: null, domain: null };
  let domain = null;
  try {
    const d = JSON.parse(cstr(144, 512) || "{}");
    if (typeof d.domain === "number") domain = DOMAIN_BY_NUM[d.domain] || null;
  } catch (_) { /* defines not JSON / bare firmware */ }
  return { product, domain };
}

// Meshtastic OTA images have no ELRS config block, but they contain the literal ASCII
// string "meshtastic" somewhere in the image — e.g. ~10.7KB in for the two prebuilt
// sync-word variants this repo ships, but as far as ~175KB in for other boards/versions.
// The offset varies, so the read window is intentionally generous (256KB) to comfortably
// cover that range while still being a single bounded flash read. Only called from the
// non-ELRS sentinel branch in detectTarget().
async function isMeshtasticImage(addr) {
  setStatus("checking for Meshtastic signature…");
  log("Scanning slot for Meshtastic signature (this can take a few seconds)…");
  const indicator = document.getElementById("scan-indicator");
  if (indicator) indicator.hidden = false;
  try {
    const chunk = await readFlashBytes(addr, 0x40000);
    return chunk ? bytesIndexOf(chunk, "meshtastic") >= 0 : false;
  } finally {
    if (indicator) indicator.hidden = true;
  }
}

// --- URL query-param sync: lets a link pre-select the Configure form (?version=&board=&
// device=&domain=&slot=) and keeps the URL in sync as the user changes the form. ---
const SLOT_PARAM = { 0: "app0", 1: "app1" };
const PARAM_SLOT = { app0: 0, app1: 1 };

function setSelectIfValid(id, value) {
  const el = $(id);
  if (!el || value == null) return false;
  if (![...el.options].some((o) => o.value === value)) return false;
  el.value = value;
  return true;
}

function applyURLParams() {
  const p = new URLSearchParams(location.search);

  if (setSelectIfValid("bld-version", p.get("version"))) onVersionChange();
  if (PARAM_SLOT[p.get("slot")] !== undefined) setSelectIfValid("bld-slot", String(PARAM_SLOT[p.get("slot")]));

  const version = $("bld-version").value;
  if (version === "rnode") {
    setSelectIfValid("bld-rnode-board", p.get("board"));
  } else if (version === "meshtastic") {
    if (setSelectIfValid("bld-meshtastic-board", p.get("board"))) onMeshtasticBoardChange();
    if (setSelectIfValid("bld-meshtastic-sync", p.get("sync")))
      $("meshtastic-sync-warning").hidden = $("meshtastic-sync-field").hidden || $("bld-meshtastic-sync").value !== "0x12";
  } else {
    const target = p.get("device") && esp32.find((t) => t.id === p.get("device"));
    if (target) selectTarget(target, p.get("domain"));
  }
}

function updateURL() {
  const p = new URLSearchParams();
  const version = $("bld-version").value;
  if (version) p.set("version", version);
  if (version === "rnode") {
    p.set("board", $("bld-rnode-board").value);
  } else if (version === "meshtastic") {
    p.set("board", $("bld-meshtastic-board").value);
    p.set("sync", $("bld-meshtastic-sync").value);
  } else {
    const target = selectedTarget();
    if (target) p.set("device", target.id);
    p.set("domain", $("bld-domain").value);
  }
  p.set("slot", SLOT_PARAM[Number($("bld-slot").value)]);
  const qs = p.toString();
  history.replaceState(null, "", qs ? `?${qs}` : location.pathname);
}

function selectTarget(target, domain) {
  $("bld-vendor").value = target.mfr;
  fillCategories();
  $("bld-category").value = target.cat;
  fillDevices();
  $("bld-device").value = target.id;
  if (domain && [...$("bld-domain").options].some((o) => o.value === domain)) $("bld-domain").value = domain;
}

async function detectTarget() {
  if (!isConnected()) { setStatus("Connect first"); return; }
  setBusy(true, "detecting target");
  try {
    setStatus("reading the board…");

    // Bootloader @0x1000: the custom slot-switch build contains a unique "slot_switch"
    // log tag the stock bootloader doesn't. Read the bootloader region (up to the
    // partition table @0x8000) and look for it.
    try {
      const boot = await readFlashBytes(0x1000, 0x7000);
      if (boot) mm({ type: "bootloader", value: bytesIndexOf(boot, "slot_switch") >= 0 ? "custom" : "stock" });
    } catch (_) { /* leave bootloader state unknown */ }

    const active = await readActiveSlot();
    const addr = { 0: APP0_ADDR, 1: APP1_ADDR };
    const cfg = {};
    const labels = {};
    for (const s of [0, 1]) {
      cfg[s] = await readConfigFromSlot(addr[s]);
      if (cfg[s]) {
        const t = cfg[s].product && esp32.find((x) => x.dev.product_name === cfg[s].product);
        // null product = valid ESP32 image but no ELRS config block (RNode, stock, Meshtastic, etc.)
        let label = t ? t.dev.product_name : (cfg[s].product || "non-ELRS firmware");
        if (!t && !cfg[s].product && (await isMeshtasticImage(addr[s]))) label = "Meshtastic firmware";
        labels[s] = label;
        mm({ type: "flashed", slot: s, label });
      }
    }
    mm({ type: "active", slot: active });

    // Pre-select the Configure form from the active slot's config (fallback to the other).
    const pick = (cfg[active] && cfg[active].product) ? cfg[active] : (cfg[active ^ 1] && cfg[active ^ 1].product ? cfg[active ^ 1] : null);
    const t = pick && esp32.find((x) => x.dev.product_name === pick.product);
    log(`Detected: app0=${labels[0] || "—"} · app1=${labels[1] || "—"} · active=app${active}`);
    if (t) {
      selectTarget(t, pick.domain);
      setStatus(`detected: ${t.dev.product_name}${pick.domain ? " · " + pick.domain : ""}`);
    } else {
      setStatus("no matching ELRS target (empty/stock board, or unknown product)");
    }
  } catch (e) {
    setStatus("detect error: " + (e.message || e));
  } finally {
    setBusy(false);
  }
}

async function flashStaged(slot) {
  if (!staged[slot]) { setStatus(`nothing staged for app${slot}`); return; }
  if (!isConnected()) { setStatus("Connect to the board first"); return; }
  const label = staged[slot].label;   // capture: the flash auto-disconnects + clears staged
  const ok = await flashData(staged[slot].bytes, slot === 0 ? APP0_ADDR : APP1_ADDR, `app${slot} (staged)`);
  if (ok) mm({ type: "flashed", slot, label });
}

// Full provision (bootloader + partitions + otadata + both apps) from the staged bins.
async function provisionBothStaged() {
  if (!staged[0] || !staged[1]) { setStatus("stage BOTH app0 (v3) and app1 (v4) first"); return; }
  if (!isConnected()) { setStatus("Connect to the board first"); return; }
  const useSlotSwitch = $("bld-bootsw")?.checked ?? true;
  const l0 = staged[0].label, l1 = staged[1].label;   // capture before auto-disconnect clears staged
  const ok = await flashFullProvision(staged[0].bytes, staged[1].bytes, useSlotSwitch);
  if (ok) {
    mm({ type: "flashed", slot: 0, label: l0 });
    mm({ type: "flashed", slot: 1, label: l1 });
    mm({ type: "active", slot: 0 });
    mm({ type: "bootloader", value: useSlotSwitch ? "custom" : "stock" });
  }
}

function init() {
  $("bld-domain").innerHTML = opts(DOMAINS.map((d) => [d, d]));
  $("bld-version").innerHTML = opts(Object.keys(BRANCHES).map((v) => [v, v]));
  $("bld-rnode-board").innerHTML = opts(
    Object.entries(RNODE_BOARDS).map(([label, env]) => [env, label])
  );
  $("bld-meshtastic-board").innerHTML = opts(
    Object.entries(MESHTASTIC_BOARDS).map(([label, key]) => [key, label])
  );
  $("bld-version").addEventListener("change", onVersionChange);
  onVersionChange();
  $("bld-meshtastic-board")?.addEventListener("change", onMeshtasticBoardChange);
  onMeshtasticBoardChange();
  $("bld-meshtastic-sync")?.addEventListener("change", () => {
    $("meshtastic-sync-warning").hidden = $("bld-meshtastic-sync").value !== "0x12";
  });
  $("bld-vendor").addEventListener("change", fillCategories);
  $("bld-category").addEventListener("change", fillDevices);
  $("bld-build").addEventListener("click", prepareAndStage);
  applyURLParams();
  document.querySelector(".form").addEventListener("change", updateURL);
  $("detect")?.addEventListener("click", detectTarget);
  $("bld-flash-staged-0")?.addEventListener("click", () => flashStaged(0));
  $("bld-flash-staged-1")?.addEventListener("click", () => flashStaged(1));
  $("bld-flash-staged-both")?.addEventListener("click", provisionBothStaged);
  $("btn-provision-rnode")?.addEventListener("click", async () => {
    const band = (document.querySelector('input[name="rnode-band"]:checked') || {}).value || "868";
    $("btn-provision-rnode").disabled = true;
    try {
      await provisionRNode(band, setStatus);
      setStatus("RNode provisioned ✓");
      log("RNode provisioned successfully");
    } catch (e) {
      setStatus("provision error: " + (e.message || e));
      log("RNode provision error: " + (e.message || e));
    } finally {
      $("btn-provision-rnode").disabled = false;
    }
  });
  // Start from scratch on disconnect: drop staged images + clear status.
  document.addEventListener("ui-reset", () => {
    staged[0] = null;
    staged[1] = null;
    updateFlashButtons();
    setStatus("");
  });
  // Re-apply staging constraints whenever an operation finishes re-enabling buttons.
  window.onBusyChange = (busy) => { if (!busy) updateFlashButtons(); };
  updateFlashButtons();
  loadTargets().then(applyURLParams).catch((e) => setStatus(e.message));
}

if (document.readyState !== "loading") init();
else document.addEventListener("DOMContentLoaded", init);
