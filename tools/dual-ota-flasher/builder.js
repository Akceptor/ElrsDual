import { REPO, BRANCHES, ARTIFACT_BRANCH, TARGETS, DOMAINS } from "./config.js";
import { flattenTargets, filterEsp32Targets, targetToEnv } from "./targets.js";
import { buildDefines, appendConfig } from "./configure.js";
import { flashData, flashFullProvision, log, isConnected, APP0_ADDR, APP1_ADDR } from "./flasher.js";

// Public raw URLs (no token, CORS *). Path segments are encoded individually so filenames
// with spaces work; the ref segments here have no slashes so they pass through fine.
const encPath = (p) => p.split("/").map(encodeURIComponent).join("/");
const TARGETS_RAW = (path) =>
  `https://raw.githubusercontent.com/${TARGETS.owner}/${TARGETS.repo}/${TARGETS.ref}/${encPath(path)}`;
const FIRMWARE_RAW = (version, env) =>
  `https://raw.githubusercontent.com/${REPO.owner}/${REPO.repo}/${ARTIFACT_BRANCH}/${encPath(`${version}/${env}/firmware.bin`)}`;

const staged = { 0: null, 1: null };
let esp32 = [];

const $ = (id) => document.getElementById(id);
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
  setStatus(`${esp32.length} ESP32 targets`);
}

async function fetchLayout(dev) {
  const dir = dev.firmware.includes("_TX") ? "TX" : "RX";
  const res = await fetch(TARGETS_RAW(`${dir}/${dev.layout_file}`));
  if (!res.ok) throw new Error(`layout HTTP ${res.status}`);
  return res.json();
}

async function prepareAndStage() {
  const versionLabel = $("bld-version").value;
  const target = selectedTarget();
  if (!target) { setStatus("no target selected"); return; }
  const dev = target.dev;
  const env = targetToEnv(dev);
  const domain = $("bld-domain").value;
  const slot = Number($("bld-slot").value);

  $("bld-build").disabled = true;
  try {
    setStatus(`fetching ${versionLabel} firmware…`);
    const res = await fetch(FIRMWARE_RAW(versionLabel, env));
    if (res.status === 404) {
      throw new Error(`no published ${versionLabel} build for ${env} yet — ask the maintainer to run the prebuild workflow`);
    }
    if (!res.ok) throw new Error(`firmware HTTP ${res.status}`);
    const generic = new Uint8Array(await res.arrayBuffer());

    setStatus("configuring…");
    const layout = await fetchLayout(dev);
    const defines = buildDefines({ phrase: $("bld-phrase").value.trim(), domain });
    const configured = appendConfig(generic,
      { productName: dev.product_name, luaName: dev.lua_name, defines, layout });

    const label = `${versionLabel} · ${dev.product_name}`;
    staged[slot] = { bytes: configured, label };
    updateFlashButtons();
    mm({ type: "staged", slot, label });   // shown on the flash-map diagram, not as text
    setStatus("staged ✓ — Connect, then Flash staged");
    log(`Staged ${label} (${domain}) → ${slot === 0 ? "app0" : "app1"} (${configured.length} bytes)`);
  } catch (e) {
    setStatus(`error: ${e.message || e}`);
    log(`Prepare error: ${e.message || e}`);
  } finally {
    $("bld-build").disabled = false;
  }
}

async function flashStaged(slot) {
  if (!staged[slot]) { setStatus(`nothing staged for app${slot}`); return; }
  if (!isConnected()) { setStatus("Connect to the board first"); return; }
  const ok = await flashData(staged[slot].bytes, slot === 0 ? APP0_ADDR : APP1_ADDR, `app${slot} (staged)`);
  if (ok) mm({ type: "flashed", slot, label: staged[slot].label });
}

// Full provision (bootloader + partitions + otadata + both apps) from the staged bins.
async function provisionBothStaged() {
  if (!staged[0] || !staged[1]) { setStatus("stage BOTH app0 (v3) and app1 (v4) first"); return; }
  if (!isConnected()) { setStatus("Connect to the board first"); return; }
  const useSlotSwitch = $("bld-bootsw")?.checked ?? true;
  const ok = await flashFullProvision(staged[0].bytes, staged[1].bytes, useSlotSwitch);
  if (ok) {
    mm({ type: "flashed", slot: 0, label: staged[0].label });
    mm({ type: "flashed", slot: 1, label: staged[1].label });
    mm({ type: "active", slot: 0 });
    mm({ type: "bootloader", value: useSlotSwitch ? "custom" : "stock" });
  }
}

function init() {
  $("bld-domain").innerHTML = opts(DOMAINS.map((d) => [d, d]));
  $("bld-version").innerHTML = opts(Object.keys(BRANCHES).map((v) => [v, v]));
  $("bld-vendor").addEventListener("change", fillCategories);
  $("bld-category").addEventListener("change", fillDevices);
  $("bld-build").addEventListener("click", prepareAndStage);
  $("bld-flash-staged-0")?.addEventListener("click", () => flashStaged(0));
  $("bld-flash-staged-1")?.addEventListener("click", () => flashStaged(1));
  $("bld-flash-staged-both")?.addEventListener("click", provisionBothStaged);
  // Re-apply staging constraints whenever an operation finishes re-enabling buttons.
  window.onBusyChange = (busy) => { if (!busy) updateFlashButtons(); };
  updateFlashButtons();
  loadTargets().catch((e) => setStatus(e.message));
}

if (document.readyState !== "loading") init();
else document.addEventListener("DOMContentLoaded", init);
