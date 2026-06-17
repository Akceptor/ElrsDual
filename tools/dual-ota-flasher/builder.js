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

async function loadTargets() {
  setStatus("loading targets…");
  const res = await fetch(TARGETS_RAW("targets.json"));
  if (!res.ok) throw new Error(`targets.json HTTP ${res.status}`);
  esp32 = filterEsp32Targets(flattenTargets(await res.json())).sort((a, b) => a.id.localeCompare(b.id));
  $("bld-target").innerHTML = esp32.map((t) => `<option value="${t.id}">${t.id}</option>`).join("");
  setStatus(`${esp32.length} ESP32 targets`);
}

async function fetchLayout(dev) {
  const dir = dev.firmware.includes("_TX") ? "TX" : "RX";
  const res = await fetch(TARGETS_RAW(`${dir}/${dev.layout_file}`));
  if (!res.ok) throw new Error(`layout HTTP ${res.status}`);
  return res.json();
}

function renderStaged() {
  const fmt = (s) => (s ? `${s.label} ✓` : "(none)");
  $("bld-staged").textContent = `Staged · app0 = ${fmt(staged[0])} · app1 = ${fmt(staged[1])}`;
}

async function prepareAndStage() {
  const versionLabel = $("bld-version").value;
  const targetId = $("bld-target").value;
  if (!targetId) { setStatus("no target selected"); return; }
  const dev = esp32.find((t) => t.id === targetId).dev;
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

    staged[slot] = { bytes: configured, label: `${versionLabel} · ${targetId} · ${domain}` };
    renderStaged();
    setStatus("staged — Connect, then Flash staged");
    log(`Staged ${staged[slot].label} → ${slot === 0 ? "app0" : "app1"} (${configured.length} bytes)`);
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
  await flashData(staged[slot].bytes, slot === 0 ? APP0_ADDR : APP1_ADDR, `app${slot} (staged)`);
}

// Full provision (bootloader + partitions + otadata + both apps) from the staged bins.
// Use on a fresh board that doesn't have the dual-OTA layout yet.
async function provisionBothStaged() {
  if (!staged[0] || !staged[1]) { setStatus("stage BOTH app0 (v3) and app1 (v4) first"); return; }
  if (!isConnected()) { setStatus("Connect to the board first"); return; }
  await flashFullProvision(staged[0].bytes, staged[1].bytes);
}

function init() {
  $("bld-domain").innerHTML = DOMAINS.map((d) => `<option value="${d}">${d}</option>`).join("");
  $("bld-version").innerHTML = Object.keys(BRANCHES).map((v) => `<option value="${v}">${v}</option>`).join("");
  $("bld-build").addEventListener("click", prepareAndStage);
  $("bld-flash-staged-0")?.addEventListener("click", () => flashStaged(0));
  $("bld-flash-staged-1")?.addEventListener("click", () => flashStaged(1));
  $("bld-flash-staged-both")?.addEventListener("click", provisionBothStaged);
  renderStaged();
  loadTargets().catch((e) => setStatus(e.message));
}

if (document.readyState !== "loading") init();
else document.addEventListener("DOMContentLoaded", init);
