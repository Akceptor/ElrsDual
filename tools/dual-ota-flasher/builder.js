import { REPO, BRANCHES, BUILD_WORKFLOW, WORKFLOW_REF, ARTIFACT_BRANCH, DOMAINS } from "./config.js";
import { flattenTargets, filterEsp32Targets, targetToEnv } from "./targets.js";
import { buildDefines, appendConfig } from "./configure.js";
import { dispatchBuild, findRunByTag, fetchArtifactBin } from "./github.js";
import { flashData, log, isConnected, APP0_ADDR, APP1_ADDR } from "./flasher.js";

// Branch refs may contain slashes (e.g. "lua-slot/v4") which must stay literal in the raw
// URL; path segments (layout filenames have spaces) must be percent-encoded individually.
const RAW = (ref, path) =>
  `https://raw.githubusercontent.com/${REPO.owner}/${REPO.repo}/${ref}/${path.split("/").map(encodeURIComponent).join("/")}`;
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
    const configured = appendConfig(generic,
      { productName: dev.product_name, luaName: dev.lua_name, defines, layout });

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
