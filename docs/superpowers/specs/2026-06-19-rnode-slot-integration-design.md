# RNode firmware as a first-class OTA slot option

**Date:** 2026-06-19
**Status:** Approved (design)
**Target hardware:** ESP32 boards with SX127x radio (LilyGo LoRa32 v2.1 initially)

## Goal

Make RNode firmware (`markqvist/RNode_Firmware`) a first-class option alongside ELRS v3.6.3
and v4.0.1 in the dual-OTA slot system. Any firmware combination must be supported:
`elrs-v3 + elrs-v4`, `elrs-v3 + rnode`, `elrs-v4 + rnode`, `rnode + rnode`.

The user experience mirrors ELRS: pick a firmware, pick a board, click "Get & stage", flash.

## Slot-switching strategy

Two mechanisms, both applied to the RNode fork:

- **Per-reboot alternation** (Option A): every firmware in every slot carries the
  `esp_ota_set_boot_partition(next)` snippet in `setup()`, so the board auto-alternates
  on every reboot regardless of which firmware is running.
- **Serial slot-switch command** (Option C): a new KISS command byte in RNode's serial
  protocol triggers a one-time slot switch + reboot, allowing a connected host to jump
  to the other slot on demand without waiting for the next reboot.

## Component 1 — `Akceptor/RNode_Firmware` fork

Fork `markqvist/RNode_Firmware` as `Akceptor/RNode_Firmware`. Apply four patches:

### 1a. Partition table override

Add `min_spiffs.csv` to the fork root with the layout that matches this repo's flash layout:

```
# Name,     Type, SubType,  Offset,    Size
nvs,        data, nvs,      0x9000,    0x5000
otadata,    data, ota,      0xe000,    0x2000
app0,       app,  ota_0,    0x10000,   0x1E0000
app1,       app,  ota_1,    0x1F0000,  0x1E0000
spiffs,     data, spiffs,   0x3D0000,  0x20000
coredump,   data, coredump, 0x3F0000,  0x10000
```

In `platformio.ini`, add `board_build.partitions = min_spiffs.csv` to every ESP32 env.
This is non-negotiable: both slots share one physical partition table at `0x8000`; a
mismatch corrupts both firmwares.

### 1b. Slot-alternation snippet

In RNode's Arduino `setup()` entry point, prepend:

```cpp
#include "esp_ota_ops.h"

// Per-reboot OTA slot alternation — arms the inactive slot so the next reboot
// runs the other firmware. Must be present in every firmware on every slot.
const esp_partition_t *_nx = esp_ota_get_next_update_partition(NULL);
if (_nx) esp_ota_set_boot_partition(_nx);
```

Identical to the patch applied to ELRS branches. Ensures alternation holds even when
RNode is the running firmware.

### 1c. Serial slot-switch command

RNode uses a KISS-framed serial protocol with 1-byte command codes. Add:

```
CMD_SLOT_SWITCH = 0x73   (verify this byte is unused in the fork before merging)
```

Handler:

```cpp
case CMD_SLOT_SWITCH: {
  const esp_partition_t *nx = esp_ota_get_next_update_partition(NULL);
  if (nx) { esp_ota_set_boot_partition(nx); ESP.restart(); }
  break;
}
```

Allows a connected host to switch slots without waiting for the next auto-alternation
reboot cycle.

### 1d. LittleFS port (conditional)

ELRS uses LittleFS on the shared `spiffs` partition. LittleFS and SPIFFS are incompatible
binary formats: if ELRS formats the partition as LittleFS and RNode mounts it as SPIFFS,
both fail silently.

**Verify first:** inspect the fork for any `#include <SPIFFS.h>` or `SPIFFS.begin()` call.
If RNode uses only NVS/EEPROM for persistence, this patch is not needed. If it uses SPIFFS,
replace every occurrence:

```cpp
// Before
#include <SPIFFS.h>
SPIFFS.begin(true);
SPIFFS.open("/config", "r");

// After
#include <LittleFS.h>
LittleFS.begin(true);
LittleFS.open("/rnode/config", "r");   // use /rnode/ prefix to avoid colliding with ELRS files
```

All `SPIFFS.*` → `LittleFS.*`. The API is a drop-in replacement.

**File path namespacing:** ELRS uses flat root-level paths (`/options.json`,
`/hardware.json`, `/lr1121.txt`). RNode must not use any of those names. Prefix all RNode
files (e.g., `/rnode_config`, `/rnode_channels`) or verify the fork's filenames do not
collide with the ELRS list above.

## Component 2 — CI pre-build extension (`flasher-prebuild.yml`)

### 2a. New `version` input option

Add `"rnode"` to the `version` choice list. The existing ELRS `build` job's scope-check
naturally skips when `version: rnode` (neither `"v4.0.1"` nor `"v3.6.3"` match).

### 2b. New `build-rnode` job

Runs when `inputs.version == 'rnode'`. Differences from the ELRS `build` job:

| Aspect | ELRS `build` | RNode `build-rnode` |
|---|---|---|
| Checkout | this repo @ `lua-slot/*` branch | `Akceptor/RNode_Firmware@main` |
| Hardware targets step | clones `ExpressLRS/targets` | not needed |
| Build flags | `-DRegulatory_Domain_*` injected | none |
| Build working dir | `src/` | repo root |
| Artifact name | `fw-<version>-<env>` | `fw-rnode-<env>` |

Initial env matrix (exact names must be confirmed from the fork's `platformio.ini`):

```yaml
matrix:
  env:
    - TTGO_LORA32_V21_SX1276   # LilyGo LoRa32 v2.1, 868/915 MHz
    - TTGO_LORA32_V21_SX1278   # LilyGo LoRa32 v2.1, 433 MHz
```

Adding a new board later: one line in this matrix + one line in `RNODE_BOARDS` in `config.js`.

### 2c. Publish job — no changes

The existing `publish` job collects all `fw-*` artifacts and commits them to
`flasher-artifacts`. RNode artifacts (`fw-rnode-<env>`) are picked up automatically.

Artifact paths on `flasher-artifacts`:
```
rnode/TTGO_LORA32_V21_SX1276/firmware.bin
rnode/TTGO_LORA32_V21_SX1278/firmware.bin
```

The browser already constructs firmware URLs as `FIRMWARE_RAW(version, env)` →
`flasher-artifacts/<version>/<env>/firmware.bin`. Passing `version = "rnode"` produces
the correct path with no changes to the URL logic.

### Auto-rebuild on fork push

Not wired up initially — `push:` triggers cannot watch a different repo. Manual
`workflow_dispatch` is sufficient. Cross-repo triggering (the fork calls
`workflow_dispatch` on this repo via the GitHub API on push) can be added later.

## Component 3 — Web builder UI and JS

### 3a. `config.js`

```js
// "rnode" added; null branch = built from Akceptor/RNode_Firmware, not this repo
export const BRANCHES = {
  "v4.0.1": "lua-slot/v4",
  "v3.6.3": "lua-slot/v3.6.3",
  "rnode":  null,
};

// Board display label → PlatformIO env. Must stay in sync with the CI matrix.
export const RNODE_BOARDS = {
  "LilyGo LoRa32 v2.1 (SX1276 / 868–915 MHz)": "TTGO_LORA32_V21_SX1276",
  "LilyGo LoRa32 v2.1 (SX1278 / 433 MHz)":    "TTGO_LORA32_V21_SX1278",
};
```

### 3b. `index.html`

Wrap the five ELRS-specific fields in `<div id="elrs-fields">`. Add a new
`<div id="rnode-fields" hidden>` with a single board `<select>`. The slot selector
and "Get & stage" button sit outside both groups and are unchanged.

```html
<div id="elrs-fields">
  <!-- vendor / category / device / domain / phrase rows — unchanged content -->
</div>
<div id="rnode-fields" hidden>
  <div class="ff">
    <label for="bld-rnode-board">Board</label>
    <select id="bld-rnode-board"></select>
  </div>
</div>
```

### 3c. `builder.js`

Import `RNODE_BOARDS`. Three focused changes:

**Init:** populate the RNode board dropdown and wire version-change visibility:

```js
function fillVersions() {
  $("bld-version").innerHTML = opts(Object.keys(BRANCHES).map((v) => [v, v]));
  $("bld-rnode-board").innerHTML = opts(
    Object.entries(RNODE_BOARDS).map(([label, env]) => [env, label])
  );
  onVersionChange();
}

function onVersionChange() {
  const isRNode = $("bld-version").value === "rnode";
  $("elrs-fields").hidden = isRNode;
  $("rnode-fields").hidden = !isRNode;
}
// wire: $("bld-version").addEventListener("change", onVersionChange);
```

**`prepareAndStage`:** branch at the top to resolve `env` and `fetchLabel`; ELRS and
RNode paths rejoin at the fetch. The configure step is conditionally skipped for RNode:

```js
async function prepareAndStage() {
  const versionLabel = $("bld-version").value;
  const slot = Number($("bld-slot").value);
  let env, fetchLabel;

  if (versionLabel === "rnode") {
    env = $("bld-rnode-board").value;
    const boardLabel = $("bld-rnode-board").options[$("bld-rnode-board").selectedIndex].text;
    fetchLabel = `RNode · ${boardLabel}`;
  } else {
    const target = selectedTarget();
    if (!target) { setStatus("no target selected"); return; }
    env = targetToEnv(target.dev);
    fetchLabel = `${versionLabel} · ${target.dev.product_name}`;
  }

  $("bld-build").disabled = true;
  try {
    setStatus(`fetching ${fetchLabel} firmware…`);
    const res = await fetch(FIRMWARE_RAW(versionLabel, env));
    if (res.status === 404)
      throw new Error(`no published build for ${fetchLabel} yet — run the prebuild workflow`);
    if (!res.ok) throw new Error(`firmware HTTP ${res.status}`);
    const generic = new Uint8Array(await res.arrayBuffer());

    let configuredBytes;
    if (versionLabel === "rnode") {
      configuredBytes = generic;          // pre-configured for the board, no configure.js
    } else {
      setStatus("configuring…");
      const layout = await fetchLayout(selectedTarget().dev);
      const defines = buildDefines({
        phrase: $("bld-phrase").value.trim(),
        domain: $("bld-domain").value,
      });
      configuredBytes = appendConfig(generic, {
        productName: selectedTarget().dev.product_name,
        luaName: selectedTarget().dev.lua_name,
        defines,
        layout,
      });
    }

    const label = fetchLabel;
    staged[slot] = { bytes: configuredBytes, label };
    updateFlashButtons();
    mm({ type: "staged", slot, label });
    setStatus("staged ✓ — Connect, then Flash staged");
    log(`Staged ${label} → ${slot === 0 ? "app0" : "app1"} (${configuredBytes.length} bytes)`);
  } catch (e) {
    setStatus(`error: ${e.message || e}`);
    log(`Prepare error: ${e.message || e}`);
  } finally {
    $("bld-build").disabled = false;
  }
}
```

**Files with zero changes:** `configure.js`, `targets.js`, `flasher.js`, `memmap.js`.

**Known limitation:** `readConfigFromSlot` (slot auto-detection) parses the ELRS config
block appended by `configure.js`. An RNode binary has no such block; detection returns
`null` for that slot, which the UI surfaces as "unknown firmware". This is acceptable and
out of scope for this design.

## Verification

1. Fork exists at `Akceptor/RNode_Firmware`; all four patches applied and building cleanly.
2. `pio run -e TTGO_LORA32_V21_SX1276` (and SX1278) produce a `firmware.bin` ≤ 1.875 MB.
3. Partition table in the fork is byte-identical to `min_spiffs.csv` in this repo.
4. `workflow_dispatch` with `version: rnode` on `flasher-prebuild.yml` completes; bins
   appear on `flasher-artifacts` at `rnode/<env>/firmware.bin`.
5. Browser: selecting "RNode" hides vendor/category/device/domain/phrase, shows the board
   dropdown. "Get & stage" fetches and stages without configure.js.
6. Flash an ELRS + RNode combination; confirm per-reboot alternation across firmware types.
7. Send `CMD_SLOT_SWITCH` over serial while running RNode; confirm board reboots into the
   other slot.

## Out of scope

- Firmware other than ESP32 (esp8285, stm32 have no dual-OTA).
- Auto-rebuild on RNode fork push (can be wired up later via cross-repo `workflow_dispatch`).
- Slot auto-detection for RNode slots (`readConfigFromSlot` returns null — acceptable).
- Changing the existing ELRS v3/v4 flow in any way.
- TX-side RNode builds (LilyGo LoRa32 v2.1 is targeted as a node/receiver device in RNode).