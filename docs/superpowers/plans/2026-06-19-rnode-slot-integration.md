# RNode Slot Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add RNode firmware as a first-class OTA slot option so any combination of ELRS v3, ELRS v4, and RNode can be flashed into the two ESP32 OTA slots via the existing web builder tool.

**Architecture:** Three tracks. Track A (Tasks 1–4): patch `Akceptor/RNode_Firmware` fork with partition table override, slot-alternation snippet, serial slot-switch command, and LittleFS port. Track B (Task 5): extend `flasher-prebuild.yml` to build RNode and publish to `flasher-artifacts`. Track C (Tasks 6–8): update the web builder UI (`config.js`, `index.html`, `builder.js`, `i18n.js`) to show RNode as a version option with its own board dropdown.

**Tech Stack:** Arduino/PlatformIO (fork), GitHub Actions YAML (CI), Vanilla ES modules + `node --test` (web builder)

## Global Constraints

- Track A executes inside the fork repo `Akceptor/RNode_Firmware`, not this repo.
- Track B and C execute inside this repo (`Akceptor/ElrsDual`).
- App slot max size: 1.875 MB (0x1E0000). Reject if `pio run` output shows firmware.bin larger than this.
- Partition table (both repos): `ota_0 @ 0x10000 / 1.875 MB`, `ota_1 @ 0x1F0000 / 1.875 MB`, `spiffs @ 0x3D0000 / 128 KB`.
- LittleFS paths in RNode must not collide with ELRS: `/options.json`, `/hardware.json`, `/lr1121.txt`.
- `RNODE_BOARDS` values in `config.js` must stay in sync with the `build-rnode` env matrix in `flasher-prebuild.yml`.
- No changes to the existing ELRS v3/v4 build or flash flow.

---

### Task 1: Create fork, add partition table, update platformio.ini

**Track:** A — run inside `Akceptor/RNode_Firmware` (fork repo)

**Files:**
- Create: `min_spiffs.csv` (fork root)
- Modify: `platformio.ini` (fork root) — add `board_build.partitions` to every ESP32 env

- [ ] **Step 1: Fork the upstream repo on GitHub**

  Go to https://github.com/markqvist/RNode_Firmware and click **Fork**. Set owner to `Akceptor`, name to `RNode_Firmware`. Clone locally:

  ```bash
  git clone git@github.com:Akceptor/RNode_Firmware.git
  cd RNode_Firmware
  ```

- [ ] **Step 2: Identify all ESP32 environments in platformio.ini**

  ```bash
  grep -n "^\[env:" platformio.ini
  ```

  Note every env that targets `platform = espressif32` (i.e., is an ESP32 board). We patch only those.

  Expected: you see envs like `[env:TTGO_LORA32_V21_SX1276]`, `[env:TTGO_LORA32_V21_SX1278]`, and possibly others. Skip STM32 / nRF envs.

- [ ] **Step 3: Create `min_spiffs.csv`**

  Create the file `min_spiffs.csv` in the repo root with exactly this content:

  ```csv
  # Name,     Type, SubType,  Offset,    Size
  nvs,        data, nvs,      0x9000,    0x5000
  otadata,    data, ota,      0xe000,    0x2000
  app0,       app,  ota_0,    0x10000,   0x1E0000
  app1,       app,  ota_1,    0x1F0000,  0x1E0000
  spiffs,     data, spiffs,   0x3D0000,  0x20000
  coredump,   data, coredump, 0x3F0000,  0x10000
  ```

- [ ] **Step 4: Add `board_build.partitions` to every ESP32 env in `platformio.ini`**

  For each ESP32 env identified in step 2, add `board_build.partitions = min_spiffs.csv` inside that env section. Example (repeat for each env):

  ```ini
  [env:TTGO_LORA32_V21_SX1276]
  board = ttgo-lora32-v21
  framework = arduino
  platform = espressif32
  board_build.partitions = min_spiffs.csv
  ; ... rest of existing lines unchanged
  ```

- [ ] **Step 5: Verify the partition file is picked up**

  ```bash
  pio run -e TTGO_LORA32_V21_SX1276 --target envdump 2>&1 | grep -i partition
  ```

  Expected: output includes `min_spiffs.csv` in the partition path.

- [ ] **Step 6: Commit**

  ```bash
  git add min_spiffs.csv platformio.ini
  git commit -m "build: override partition table to min_spiffs for dual-OTA compatibility"
  ```

---

### Task 2: Add slot-alternation snippet and CMD_SLOT_SWITCH serial command

**Track:** A — run inside `Akceptor/RNode_Firmware`

**Files:**
- Modify: `RNode_Firmware.ino` (or equivalent main `.ino`) — add slot-toggle to `setup()`
- Modify: command constants header (likely `ROM.h` or the main `.ino`) — add `CMD_SLOT_SWITCH`
- Modify: KISS command dispatch (likely `KISS.h`, `Serial.h`, or the main `.ino`) — add handler

- [ ] **Step 1: Locate `void setup()` and the KISS command dispatch**

  ```bash
  grep -rn "void setup()" .
  grep -rn "CMD_\|case 0x" . --include="*.h" --include="*.ino" | head -30
  ```

  Note the file containing `void setup()` (call it `MAIN_FILE`) and the file/switch containing KISS command cases (call it `KISS_FILE`).

- [ ] **Step 2: Verify `0x73` is unused**

  ```bash
  grep -rn "0x73" . --include="*.h" --include="*.ino"
  ```

  Expected: no matches. If `0x73` is already defined, pick the next unused byte in `0x70`–`0x7F` range and use that instead throughout this task.

- [ ] **Step 3: Add `CMD_SLOT_SWITCH` constant**

  In the same file where other `CMD_*` constants are defined, add:

  ```cpp
  #define CMD_SLOT_SWITCH 0x73
  ```

  (If constants are defined with `const uint8_t`, use the same style as the surrounding code.)

- [ ] **Step 4: Add the slot-alternation snippet to `setup()`**

  In `MAIN_FILE`, at the very first line of `void setup()` (before any other code), add:

  ```cpp
  #include "esp_ota_ops.h"

  void setup() {
    // Per-reboot OTA slot alternation — arms the inactive slot so the next reboot
    // runs the other firmware. Must be present in every firmware in every slot.
    const esp_partition_t *_nx = esp_ota_get_next_update_partition(NULL);
    if (_nx) esp_ota_set_boot_partition(_nx);

    // ... rest of existing setup() code unchanged
  ```

  Note: `#include "esp_ota_ops.h"` goes at the top of the file with the other includes, not inside `setup()`.

- [ ] **Step 5: Add CMD_SLOT_SWITCH handler to the KISS dispatch**

  In `KISS_FILE`, in the command dispatch switch/if-chain, add a new case:

  ```cpp
  case CMD_SLOT_SWITCH: {
    const esp_partition_t *nx = esp_ota_get_next_update_partition(NULL);
    if (nx) {
      esp_ota_set_boot_partition(nx);
      ESP.restart();
    }
    break;
  }
  ```

- [ ] **Step 6: Build and check for compile errors**

  ```bash
  pio run -e TTGO_LORA32_V21_SX1276 2>&1 | tail -20
  ```

  Expected: `SUCCESS` with no errors. If `esp_ota_ops.h` is not found, add to `platformio.ini` under the env: `build_flags = -DARDUINO_ESP32_OTA`.

- [ ] **Step 7: Commit**

  ```bash
  git add .
  git commit -m "feat: dual-OTA slot alternation + CMD_SLOT_SWITCH (0x73) serial command"
  ```

---

### Task 3: SPIFFS → LittleFS port (conditional)

**Track:** A — run inside `Akceptor/RNode_Firmware`

**Files:**
- Modify: any `.ino` or `.h` file that uses `SPIFFS` (found by grep below)

- [ ] **Step 1: Check if RNode uses SPIFFS**

  ```bash
  grep -rn "SPIFFS" . --include="*.ino" --include="*.h" --include="*.cpp"
  ```

  **If no output:** RNode does not use SPIFFS. This task is complete — skip to commit with a note.

  **If output:** continue below.

- [ ] **Step 2: Replace all `SPIFFS` headers**

  ```bash
  grep -rl "#include.*SPIFFS" . --include="*.ino" --include="*.h" --include="*.cpp"
  ```

  In each listed file, replace:
  ```cpp
  #include <SPIFFS.h>
  ```
  with:
  ```cpp
  #include <LittleFS.h>
  ```

- [ ] **Step 3: Replace all `SPIFFS.` method calls**

  ```bash
  grep -rn "SPIFFS\." . --include="*.ino" --include="*.h" --include="*.cpp"
  ```

  For each occurrence, replace `SPIFFS.` with `LittleFS.`. The LittleFS API is a drop-in replacement: `begin()`, `open()`, `remove()`, `exists()`, `mkdir()`, `format()` all have identical signatures.

- [ ] **Step 4: Namespace RNode's file paths**

  For every `LittleFS.open(path, ...)` call, check whether `path` collides with ELRS's paths: `/options.json`, `/hardware.json`, `/lr1121.txt`. If any RNode path matches, prepend `/rnode_` (e.g., `/config` → `/rnode_config`). 

  If RNode had no SPIFFS at all (step 1 was empty), skip this step.

- [ ] **Step 5: Build**

  ```bash
  pio run -e TTGO_LORA32_V21_SX1276 2>&1 | tail -20
  ```

  Expected: `SUCCESS`.

- [ ] **Step 6: Commit**

  ```bash
  git add .
  git commit -m "feat: port SPIFFS to LittleFS for shared-partition compatibility with ELRS"
  # If no SPIFFS was found:
  # git commit --allow-empty -m "chore: verified RNode uses no SPIFFS (no LittleFS port needed)"
  ```

---

### Task 4: Build verification — both LilyGo LoRa32 v2.1 envs

**Track:** A — run inside `Akceptor/RNode_Firmware`

**Files:** None (verification only)

- [ ] **Step 1: Identify the two LilyGo LoRa32 v2.1 env names**

  ```bash
  grep -n "lora32\|LORA32\|lilygo\|LILYGO" platformio.ini -i
  ```

  Note the exact env names. They likely contain `V21` or `v21`. These are the values that must go into the CI matrix and `RNODE_BOARDS` in Task 6.

- [ ] **Step 2: Build both envs**

  ```bash
  pio run -e TTGO_LORA32_V21_SX1276
  pio run -e TTGO_LORA32_V21_SX1278
  ```

  (Replace the env names with what you found in step 1.)

  Expected: both succeed.

- [ ] **Step 3: Verify binary sizes are within the slot limit**

  ```bash
  ls -lh .pio/build/TTGO_LORA32_V21_SX1276/firmware.bin
  ls -lh .pio/build/TTGO_LORA32_V21_SX1278/firmware.bin
  ```

  Expected: both < 1,966,080 bytes (1.875 MB = 0x1E0000). If either exceeds this, the firmware will not fit in a slot and must be trimmed before proceeding.

- [ ] **Step 4: Push fork to GitHub**

  ```bash
  git push origin main
  ```

---

### Task 5: CI workflow — add `rnode` version and `build-rnode` job

**Track:** B — run inside this repo (`Akceptor/ElrsDual`)

**Files:**
- Modify: `.github/workflows/flasher-prebuild.yml`

- [ ] **Step 1: Add `"rnode"` to the version input choices**

  In `.github/workflows/flasher-prebuild.yml`, find the `inputs.version.options` list:

  ```yaml
        options: ["both", "v4.0.1", "v3.6.3"]
  ```

  Replace with:

  ```yaml
        options: ["both", "v4.0.1", "v3.6.3", "rnode"]
  ```

- [ ] **Step 2: Add the `build-rnode` job**

  After the closing of the existing `build:` job and before the `publish:` job, add:

  ```yaml
    build-rnode:
      runs-on: ubuntu-latest
      if: ${{ inputs.version == 'rnode' }}
      strategy:
        fail-fast: false
        matrix:
          env:
            - TTGO_LORA32_V21_SX1276
            - TTGO_LORA32_V21_SX1278
      steps:
        - uses: actions/checkout@v6
          with:
            repository: Akceptor/RNode_Firmware
            ref: main

        - uses: actions/setup-python@v6
          with: { python-version: "3.10" }

        - name: Cache PlatformIO
          uses: actions/cache@v5
          with:
            path: ~/.platformio
            key: ${{ runner.os }}-platformio-rnode-${{ matrix.env }}

        - name: Install PlatformIO
          run: |
            python -m pip install --upgrade pip
            pip install platformio wheel

        - name: Build RNode firmware
          run: |
            pio run -e "${{ matrix.env }}"
            mkdir -p "$RUNNER_TEMP/out/rnode/${{ matrix.env }}"
            cp ".pio/build/${{ matrix.env }}/firmware.bin" \
               "$RUNNER_TEMP/out/rnode/${{ matrix.env }}/firmware.bin"

        - name: Upload built bin
          uses: actions/upload-artifact@v4
          with:
            name: fw-rnode-${{ matrix.env }}
            path: ${{ runner.temp }}/out/
  ```

  **Important:** replace the env names in the `matrix.env` list with the exact names confirmed in Task 4 Step 1.

- [ ] **Step 3: Update `publish` job's `needs` to include `build-rnode`**

  Find the `publish:` job header:

  ```yaml
    publish:
      needs: build
      if: ${{ !cancelled() }}
  ```

  Replace with:

  ```yaml
    publish:
      needs: [build, build-rnode]
      if: ${{ !cancelled() }}
  ```

  The `if: ${{ !cancelled() }}` already handles the case where `build-rnode` is skipped (when `version != rnode`).

- [ ] **Step 4: Verify YAML is valid**

  ```bash
  python3 -c "import yaml, sys; yaml.safe_load(open('.github/workflows/flasher-prebuild.yml'))" && echo "YAML OK"
  ```

  Expected: `YAML OK`.

- [ ] **Step 5: Commit**

  ```bash
  git add .github/workflows/flasher-prebuild.yml
  git commit -m "ci: add rnode version option and build-rnode job to flasher-prebuild"
  ```

---

### Task 6: `config.js` — add `RNODE_BOARDS` and test

**Track:** C — run inside this repo

**Files:**
- Modify: `tools/dual-ota-flasher/config.js`
- Create: `tools/dual-ota-flasher/test/config.test.mjs`

- [ ] **Step 1: Write the failing test**

  Create `tools/dual-ota-flasher/test/config.test.mjs`:

  ```js
  import { test } from "node:test";
  import assert from "node:assert/strict";
  import { BRANCHES, RNODE_BOARDS } from "../config.js";

  test("BRANCHES includes rnode key", () => {
    assert.ok("rnode" in BRANCHES, "BRANCHES must have a 'rnode' key");
  });

  test("RNODE_BOARDS is non-empty", () => {
    assert.ok(Object.keys(RNODE_BOARDS).length > 0, "RNODE_BOARDS must have at least one entry");
  });

  test("RNODE_BOARDS values are valid PlatformIO env names (alphanumeric + underscore)", () => {
    for (const [label, env] of Object.entries(RNODE_BOARDS)) {
      assert.match(env, /^[A-Za-z0-9_]+$/, `invalid env for "${label}": "${env}"`);
    }
  });

  test("RNODE_BOARDS values do not look like ELRS Unified envs", () => {
    for (const env of Object.values(RNODE_BOARDS)) {
      assert.doesNotMatch(env, /^Unified_/, `RNode env "${env}" looks like an ELRS env — check RNODE_BOARDS`);
    }
  });
  ```

- [ ] **Step 2: Run the test to confirm it fails**

  ```bash
  cd tools/dual-ota-flasher/test && node --test config.test.mjs
  ```

  Expected: all four tests fail (`BRANCHES must have a 'rnode' key`, `RNODE_BOARDS must have at least one entry`, etc.).

- [ ] **Step 3: Add `RNODE_BOARDS` to `config.js` and update `BRANCHES`**

  In `tools/dual-ota-flasher/config.js`, replace the existing `BRANCHES` export:

  ```js
  export const BRANCHES = {
    "v4.0.1": "lua-slot/v4",
    "v3.6.3": "lua-slot/v3.6.3",
  };
  ```

  with:

  ```js
  export const BRANCHES = {
    "v4.0.1": "lua-slot/v4",
    "v3.6.3": "lua-slot/v3.6.3",
    "rnode":  null,   // built from Akceptor/RNode_Firmware, not this repo
  };

  // Board display label → PlatformIO env. Must stay in sync with build-rnode matrix in flasher-prebuild.yml.
  export const RNODE_BOARDS = {
    "LilyGo LoRa32 v2.1 (SX1276 / 868–915 MHz)": "TTGO_LORA32_V21_SX1276",
    "LilyGo LoRa32 v2.1 (SX1278 / 433 MHz)":    "TTGO_LORA32_V21_SX1278",
  };
  ```

  **Replace the env names** with the exact names confirmed in Task 4 Step 1 if they differ.

- [ ] **Step 4: Run tests to confirm they pass**

  ```bash
  cd tools/dual-ota-flasher/test && node --test config.test.mjs
  ```

  Expected: all four tests pass.

- [ ] **Step 5: Run the full test suite to confirm no regressions**

  ```bash
  cd tools/dual-ota-flasher/test && node --test
  ```

  Expected: all tests pass (configure, targets, and config).

- [ ] **Step 6: Commit**

  ```bash
  git add tools/dual-ota-flasher/config.js tools/dual-ota-flasher/test/config.test.mjs
  git commit -m "feat(web-builder): add RNODE_BOARDS to config and rnode to BRANCHES"
  ```

---

### Task 7: `index.html` and `i18n.js` — RNode board row + updated copy

**Track:** C — run inside this repo

**Files:**
- Modify: `tools/dual-ota-flasher/index.html`
- Modify: `tools/dual-ota-flasher/i18n.js`

- [ ] **Step 1: Wrap ELRS-specific fields in `index.html`**

  In `tools/dual-ota-flasher/index.html`, find the `<div class="form">` block inside `#build-section`. The five ELRS-specific rows (vendor, category, device, domain, phrase) currently look like:

  ```html
      <div class="ff"><label for="bld-vendor" data-i18n="lbl_vendor">Vendor</label>
        <select id="bld-vendor"></select></div>
      <div class="ff"><label for="bld-category" data-i18n="lbl_type">Type</label>
        <select id="bld-category"></select></div>
      <div class="ff"><label for="bld-device" data-i18n="lbl_device">Device</label>
        <select id="bld-device"></select></div>
      <div class="ff"><label for="bld-domain" data-i18n="lbl_domain">Region/domain</label>
        <select id="bld-domain"></select></div>
      <div class="ff"><label for="bld-phrase" data-i18n="lbl_phrase">Bind phrase</label>
        <input type="text" id="bld-phrase" data-i18n-ph="ph_phrase" placeholder="optional — stays local"/></div>
  ```

  Replace those five rows with:

  ```html
      <div id="elrs-fields">
        <div class="ff"><label for="bld-vendor" data-i18n="lbl_vendor">Vendor</label>
          <select id="bld-vendor"></select></div>
        <div class="ff"><label for="bld-category" data-i18n="lbl_type">Type</label>
          <select id="bld-category"></select></div>
        <div class="ff"><label for="bld-device" data-i18n="lbl_device">Device</label>
          <select id="bld-device"></select></div>
        <div class="ff"><label for="bld-domain" data-i18n="lbl_domain">Region/domain</label>
          <select id="bld-domain"></select></div>
        <div class="ff"><label for="bld-phrase" data-i18n="lbl_phrase">Bind phrase</label>
          <input type="text" id="bld-phrase" data-i18n-ph="ph_phrase" placeholder="optional — stays local"/></div>
      </div>
      <div id="rnode-fields" hidden>
        <div class="ff"><label for="bld-rnode-board" data-i18n="lbl_rnode_board">Board</label>
          <select id="bld-rnode-board"></select></div>
      </div>
  ```

- [ ] **Step 2: Update the slot `<option>` labels in `index.html`**

  Find the slot selector (inside the same `<div class="form">`):

  ```html
        <select id="bld-slot">
          <option value="1">app1 (v4.x)</option>
          <option value="0">app0 (v3.x)</option>
        </select>
  ```

  Replace with:

  ```html
        <select id="bld-slot">
          <option value="1">app1</option>
          <option value="0">app0</option>
        </select>
  ```

- [ ] **Step 3: Add `lbl_rnode_board` and update `lede` + `step1_desc` in `i18n.js` (English)**

  In `tools/dual-ota-flasher/i18n.js`, in the `en:` block, make three changes:

  **3a.** Replace the `lede` line:
  ```js
      lede: 'Put <b>two</b> ELRS firmwares on one ESP32 at once — <b>app0 = v3.x</b> and <b>app1 = v4.x</b> — and switch between them. Chrome or Edge only.',
  ```
  with:
  ```js
      lede: 'Put <b>two</b> firmwares — ELRS or RNode — on one ESP32 at once and switch between them. Chrome or Edge only.',
  ```

  **3b.** Replace the `step1_desc` line:
  ```js
      step1_desc: 'Pick a version + your board, set the region and (optionally) a bind phrase. It downloads the matching pre-built firmware and personalises it <b>in your browser</b> (the bind phrase never leaves this page).',
  ```
  with:
  ```js
      step1_desc: 'Pick a firmware + board. For ELRS, also set the region and optional bind phrase — configuration happens <b>in your browser</b> (bind phrase never leaves this page).',
  ```

  **3c.** On the `lbl_version:` line, add `lbl_rnode_board` at the end:
  ```js
      lbl_version: 'Version', lbl_vendor: 'Vendor', lbl_type: 'Type', lbl_device: 'Device', lbl_domain: 'Region/domain',
      lbl_phrase: 'Bind phrase', ph_phrase: 'optional — stays local', lbl_slot: 'Stage into slot',
      lbl_rnode_board: 'Board',
  ```

- [ ] **Step 4: Update the `uk:` block in `i18n.js` (Ukrainian)**

  In the `uk:` block, make the same three changes:

  **4a.** Replace `lede`:
  ```js
      lede: 'Запишіть на один ESP32 одразу <b>дві</b> прошивки ELRS — <b>app0 = v3.x</b> та <b>app1 = v4.x</b> — і перемикайтесь між ними. Лише Chrome або Edge.',
  ```
  with:
  ```js
      lede: 'Запишіть на один ESP32 одразу <b>дві</b> прошивки — ELRS або RNode — і перемикайтесь між ними. Лише Chrome або Edge.',
  ```

  **4b.** Replace `step1_desc`:
  ```js
      step1_desc: 'Оберіть версію та свою плату, вкажіть регіон і (за бажанням) бінд фразу. Інструмент завантажить відповідну готову прошивку та персоналізує її <b>у вашому браузері</b> (бінд фраза не залишає цю сторінку).',
  ```
  with:
  ```js
      step1_desc: 'Оберіть прошивку та плату. Для ELRS також вкажіть регіон і бінд фразу — персоналізація відбувається <b>у вашому браузері</b> (бінд фраза не залишає цю сторінку).',
  ```

  **4c.** After the `lbl_slot` line, add:
  ```js
      lbl_rnode_board: 'Плата',
  ```

- [ ] **Step 5: Verify all existing tests still pass**

  ```bash
  cd tools/dual-ota-flasher/test && node --test
  ```

  Expected: all tests pass (i18n changes are not covered by tests, but this confirms no JS was broken).

- [ ] **Step 6: Commit**

  ```bash
  git add tools/dual-ota-flasher/index.html tools/dual-ota-flasher/i18n.js
  git commit -m "feat(web-builder): add RNode board row, generalize slot labels and copy"
  ```

---

### Task 8: `builder.js` — version-change toggle and RNode fetch path

**Track:** C — run inside this repo

**Files:**
- Modify: `tools/dual-ota-flasher/builder.js`

- [ ] **Step 1: Add `RNODE_BOARDS` to the import line**

  Find the first line of `tools/dual-ota-flasher/builder.js`:

  ```js
  import { REPO, BRANCHES, ARTIFACT_BRANCH, TARGETS, DOMAINS } from "./config.js";
  ```

  Replace with:

  ```js
  import { REPO, BRANCHES, ARTIFACT_BRANCH, TARGETS, DOMAINS, RNODE_BOARDS } from "./config.js";
  ```

- [ ] **Step 2: Add `onVersionChange` function**

  After the line `const $ = (id) => document.getElementById(id);`, add the new function:

  ```js
  function onVersionChange() {
    const isRNode = $("bld-version").value === "rnode";
    $("elrs-fields").hidden = isRNode;
    $("rnode-fields").hidden = !isRNode;
  }
  ```

- [ ] **Step 3: Update `init()` to populate the RNode board dropdown and wire the version-change listener**

  Find the `init()` function. It currently contains:

  ```js
    $("bld-domain").innerHTML = opts(DOMAINS.map((d) => [d, d]));
    $("bld-version").innerHTML = opts(Object.keys(BRANCHES).map((v) => [v, v]));
    $("bld-vendor").addEventListener("change", fillCategories);
  ```

  Replace those three lines with:

  ```js
    $("bld-domain").innerHTML = opts(DOMAINS.map((d) => [d, d]));
    $("bld-version").innerHTML = opts(Object.keys(BRANCHES).map((v) => [v, v]));
    $("bld-rnode-board").innerHTML = opts(
      Object.entries(RNODE_BOARDS).map(([label, env]) => [env, label])
    );
    $("bld-version").addEventListener("change", onVersionChange);
    onVersionChange();
    $("bld-vendor").addEventListener("change", fillCategories);
  ```

- [ ] **Step 4: Replace the opening of `prepareAndStage` to branch on RNode vs ELRS**

  Find the start of `async function prepareAndStage()`. It currently reads:

  ```js
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
  ```

  Replace that entire opening block (down to and including the `staged[slot] = ...` line) with:

  ```js
  async function prepareAndStage() {
    const versionLabel = $("bld-version").value;
    const slot = Number($("bld-slot").value);
    let env, fetchLabel;

    if (versionLabel === "rnode") {
      env = $("bld-rnode-board").value;
      const sel = $("bld-rnode-board");
      fetchLabel = `RNode · ${sel.options[sel.selectedIndex].text}`;
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

      let configured;
      if (versionLabel === "rnode") {
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
  ```

  The rest of `prepareAndStage` (after `staged[slot] = ...`) stays unchanged.

- [ ] **Step 5: Run the full test suite**

  ```bash
  cd tools/dual-ota-flasher/test && node --test
  ```

  Expected: all tests pass.

- [ ] **Step 6: Commit**

  ```bash
  git add tools/dual-ota-flasher/builder.js
  git commit -m "feat(web-builder): RNode version support — board dropdown, skip configure.js"
  ```

---

### Self-review notes

- **Spec §1a** (partition table): covered by Task 1.
- **Spec §1b** (slot-alternation): covered by Task 2.
- **Spec §1c** (CMD_SLOT_SWITCH): covered by Task 2.
- **Spec §1d** (LittleFS port): covered by Task 3.
- **Spec §2a** (rnode input option): covered by Task 5 step 1.
- **Spec §2b** (build-rnode job): covered by Task 5 step 2.
- **Spec §2c** (publish job unchanged): covered by Task 5 step 3 (needs update only).
- **Spec §3a** (config.js RNODE_BOARDS + BRANCHES): covered by Task 6.
- **Spec §3b** (index.html elrs-fields / rnode-fields): covered by Task 7 step 1.
- **Spec §3c** (builder.js onVersionChange + prepareAndStage): covered by Task 8.
- **Spec verification §1–3** (fork builds, CI run, browser UI): manual end-to-end after all tasks complete — run the prebuild workflow with `version: rnode` and verify bins appear on `flasher-artifacts/rnode/`.
- **Spec verification §6–7** (flash + alternation + serial CMD): requires hardware — verify on the LilyGo LoRa32 v2.1 board after flashing.