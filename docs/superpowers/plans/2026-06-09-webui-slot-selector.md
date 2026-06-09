# WebUI firmware-version (OTA-slot) selector — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the per-reboot OTA-slot auto-alternation with an explicit WebUI selector (ELRS v3.x / v4.x, "(this)" on the running one) that switches the boot slot and reboots on Save, in both firmwares.

**Architecture:** Remove the `setup()`/`loop()` toggle snippets. Add a `/slot` GET (reports running slot) + POST (sets boot partition + deferred reboot) endpoint to `devWIFI.cpp` in both versions. Add a "Firmware Version" selector below the binding phrase — natively in v3's `index.html` (build regenerates the header) and in v4's Lit SPA `binding-panel.js` (regenerate the committed Vite header).

**Tech Stack:** ESP-IDF `esp_ota_ops.h`/`esp_partition.h`, ESPAsyncWebServer + AsyncJson, Lit/Vite (v4 SPA), classic HTML/JS (v3), PlatformIO, esptool.

**Spec:** `docs/superpowers/specs/2026-06-09-webui-slot-selector-design.md`

---

## Layout & conventions (read first)

- Worktrees: v4 = `/Users/vostapiv/Drones/elrs-v4`, v3 = `/Users/vostapiv/Drones/elrs-v3`.
- PlatformIO root in each: `<worktree>/src`. Build env: `Unified_ESP32_900_RX_via_UART`.
- Build command (per worktree `src`): `pio run -e Unified_ESP32_900_RX_via_UART`
  (no `-DDEBUG_LOG` needed anymore; the debug log is being removed).
- Slot↔version mapping: **app0 / ota_0 = ELRS v3.x**, **app1 / ota_1 = ELRS v4.x**.
- esptool: `~/.platformio/penv/bin/python ~/.platformio/packages/tool-esptoolpy@1.40501.0/esptool.py`
- Board port: `/dev/tty.usbserial-595D0219001`. Configurator target `diy.rx_900.ttgov2`,
  domain `eu_433`, phrase `Akcept0rD0es!`, `--auto-wifi 30`.

### TDD note

Same as the prior plan: this is embedded firmware + browser UI with no native test
harness for `esp_ota`/WebUI. "Test" per code task = clean compile; behavioral
verification is on-device (Task 7). Deliberate, documented deviation.

### The backend handler code (used in Tasks 2 and 3 — identical logic)

```c
#if defined(PLATFORM_ESP32)
static int getRunningSlot()
{
    const esp_partition_t *r = esp_ota_get_running_partition();
    return (r != nullptr && r->subtype == ESP_PARTITION_SUBTYPE_APP_OTA_1) ? 1 : 0;
}

static void WebGetSlot(AsyncWebServerRequest *request)
{
    char buf[24];
    snprintf(buf, sizeof(buf), "{\"running\":%d}", getRunningSlot());
    request->send(200, "application/json", buf);
}

static void WebSetSlot(AsyncWebServerRequest *request, JsonVariant &json)
{
    int slot = json["slot"] | -1;
    if (slot != 0 && slot != 1)
    {
        request->send(400, "application/json", "{\"status\":\"bad-slot\"}");
        return;
    }
    if (slot == getRunningSlot())
    {
        request->send(200, "application/json", "{\"status\":\"current\"}");
        return;
    }
    esp_partition_subtype_t sub = (slot == 1) ? ESP_PARTITION_SUBTYPE_APP_OTA_1
                                              : ESP_PARTITION_SUBTYPE_APP_OTA_0;
    const esp_partition_t *target = esp_partition_find_first(ESP_PARTITION_TYPE_APP, sub, NULL);
    if (target == nullptr || esp_ota_set_boot_partition(target) != ESP_OK)
    {
        request->send(500, "application/json", "{\"status\":\"error\"}");
        return;
    }
    request->send(200, "application/json", "{\"status\":\"rebooting\"}");
    rebootTime = millis() + 200;
}
#endif
```

### The registration lines (used in Tasks 2 and 3 — identical)

Add near the other `server.on(...)` calls in the web-server setup function:
```c
#if defined(PLATFORM_ESP32)
    server.on("/slot", HTTP_GET, WebGetSlot);
    server.addHandler(new AsyncCallbackJsonWebHandler("/slot", WebSetSlot));
#endif
```

---

## Task 1: Remove the auto-alternation from both firmwares

**Files:**
- Modify: `/Users/vostapiv/Drones/elrs-v4/src/src/rx_main.cpp`
- Modify: `/Users/vostapiv/Drones/elrs-v3/src/src/rx_main.cpp`

- [ ] **Step 1: Delete the setup() toggle block in v4**

In `/Users/vostapiv/Drones/elrs-v4/src/src/rx_main.cpp`, remove the block that begins
with `// --- per-reboot OTA slot alternation ---` inside `setup()` (the
`esp_ota_get_next_update_partition` / `esp_ota_set_boot_partition` block and its
`#if defined(PLATFORM_ESP32)` / `#endif` wrapper). Leave the `#include "esp_ota_ops.h"`
near the top in place (no longer used by rx_main, but harmless; the endpoint needs the
ESP-IDF headers in devWIFI). Actually remove the now-unused include too:
delete the lines
```c
#if defined(PLATFORM_ESP32)
#include "esp_ota_ops.h"
#endif
```

- [ ] **Step 2: Delete the loop() one-shot log block in v4**

Remove the block beginning `// One-shot: report which OTA slot` (the
`static bool reportedBootSlot` block and its `#if`/`#endif`) from the ESP32 `loop()`.

- [ ] **Step 3: Repeat Steps 1–2 in v3**

Apply the identical deletions in `/Users/vostapiv/Drones/elrs-v3/src/src/rx_main.cpp`
(`setup()` toggle block, `loop()` one-shot block, and the `esp_ota_ops.h` include block).

- [ ] **Step 4: Build both to confirm they still compile**

Run:
```bash
cd /Users/vostapiv/Drones/elrs-v4/src && pio run -e Unified_ESP32_900_RX_via_UART 2>&1 | tail -3
cd /Users/vostapiv/Drones/elrs-v3/src && pio run -e Unified_ESP32_900_RX_via_UART 2>&1 | tail -3
```
Expected: `SUCCESS` for both.

- [ ] **Step 5: Commit in each worktree**

```bash
cd /Users/vostapiv/Drones/elrs-v4 && git add src/src/rx_main.cpp && git commit -m "Remove per-reboot OTA auto-alternation (replaced by WebUI selector)"
cd /Users/vostapiv/Drones/elrs-v3 && git add src/src/rx_main.cpp && git commit -m "Remove per-reboot OTA auto-alternation (replaced by WebUI selector)"
```

---

## Task 2: Add `/slot` endpoints to v4 `devWIFI.cpp`

**Files:**
- Modify: `/Users/vostapiv/Drones/elrs-v4/src/lib/WIFI/devWIFI.cpp`

- [ ] **Step 1: Add ESP-IDF includes**

After the existing `#include "config.h"` near the top of
`/Users/vostapiv/Drones/elrs-v4/src/lib/WIFI/devWIFI.cpp`, add:
```c
#if defined(PLATFORM_ESP32)
#include "esp_ota_ops.h"
#include "esp_partition.h"
#endif
```

- [ ] **Step 2: Add the handler functions**

Paste the **backend handler code** block (from the conventions section above) into the
file at file scope, just above the web-server setup function (search for
`server.on("/config", HTTP_GET, GetConfiguration)` to locate that function; place the
handlers above it).

- [ ] **Step 3: Register the routes**

Immediately after the line
`server.on("/config", HTTP_GET, GetConfiguration);`
add the **registration lines** block from the conventions section.

- [ ] **Step 4: Build v4**

Run: `cd /Users/vostapiv/Drones/elrs-v4/src && pio run -e Unified_ESP32_900_RX_via_UART 2>&1 | tail -3`
Expected: `SUCCESS`. If `AsyncCallbackJsonWebHandler` is undefined, confirm
`#include <AsyncJson.h>` is already present in the file (it is used elsewhere); if not,
add it with the other includes.

- [ ] **Step 5: Commit**

```bash
cd /Users/vostapiv/Drones/elrs-v4 && git add src/lib/WIFI/devWIFI.cpp && git commit -m "Add /slot GET+POST endpoints for WebUI version selector"
```

---

## Task 3: Add `/slot` endpoints to v3 `devWIFI.cpp`

**Files:**
- Modify: `/Users/vostapiv/Drones/elrs-v3/src/lib/WIFI/devWIFI.cpp`

v3 already includes `<esp_partition.h>` and `<esp_ota_ops.h>` (no include change needed).

- [ ] **Step 1: Add the handler functions**

Paste the same **backend handler code** block at file scope, above the web-server
setup function. Locate the registration area by searching for a `server.on(` cluster
(e.g. `server.on("/config"` or `server.on("/reboot"`).

- [ ] **Step 2: Register the routes**

Add the **registration lines** block next to the other `server.on(...)` calls in the
same setup function where the existing routes are registered.

- [ ] **Step 3: Build v3**

Run: `cd /Users/vostapiv/Drones/elrs-v3/src && pio run -e Unified_ESP32_900_RX_via_UART 2>&1 | tail -3`
Expected: `SUCCESS`.

- [ ] **Step 4: Commit**

```bash
cd /Users/vostapiv/Drones/elrs-v3 && git add src/lib/WIFI/devWIFI.cpp && git commit -m "Add /slot GET+POST endpoints for WebUI version selector"
```

---

## Task 4: v4 SPA — add the selector and regenerate the Vite header

**Files:**
- Modify: `/Users/vostapiv/Drones/elrs-v4/src/html/src/pages/binding-panel.js`
- Regenerate: `/Users/vostapiv/Drones/elrs-v4/src/html/headers/web-sx127x-rx.h`

- [ ] **Step 1: Add component state + bind the save handler**

In `binding-panel.js`, add these accessors next to the existing `@state()` lines:
```js
    @state() accessor bootSlot = 0
    @state() accessor runningSlot = 0
    @state() accessor slotMsg = ''
```
And in `createRenderRoot()`, add the bind line next to the existing
`this._submitOptions = this._submitOptions.bind(this)`:
```js
        this._saveSlot = this._saveSlot.bind(this)
```

- [ ] **Step 2: Fetch the running slot on load**

At the end of `firstUpdated(_changedProperties)`, add:
```js
        fetch('/slot').then(r => r.json()).then(d => {
            this.runningSlot = d.running
            this.bootSlot = d.running
        })
```

- [ ] **Step 3: Add the save method**

Add this method to the class:
```js
    async _saveSlot(e) {
        e.preventDefault()
        const resp = await fetch('/slot', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({slot: this.bootSlot})
        })
        const data = await resp.json().catch(() => ({}))
        this.slotMsg = data.status === 'current' ? 'Already running this version'
                     : data.status === 'rebooting' ? 'Rebooting…'
                     : 'Error switching version'
    }
```

- [ ] **Step 4: Render the selector below the binding form**

In `render()`, immediately after the closing `</div>` of the binding `mui-panel`
(the one containing the binding `<form>`), add a second panel inside the same
returned `html\`...\`` template:
```js
            <div class="mui-panel mui--text-title">Firmware Version</div>
            <div class="mui-panel">
                <form class="mui-form">
                    <div class="mui-radio">
                        <label>
                            <input type="radio" name="bootslot" .checked=${this.bootSlot === 0}
                                   @change=${() => { this.bootSlot = 0 }}/>
                            ELRS v3.x${this.runningSlot === 0 ? ' (this)' : ''}
                        </label>
                    </div>
                    <div class="mui-radio">
                        <label>
                            <input type="radio" name="bootslot" .checked=${this.bootSlot === 1}
                                   @change=${() => { this.bootSlot = 1 }}/>
                            ELRS v4.x${this.runningSlot === 1 ? ' (this)' : ''}
                        </label>
                    </div>
                    <button class="mui-btn mui-btn--primary" @click=${this._saveSlot}>Save</button>
                    <span style="margin-left:1em">${this.slotMsg}</span>
                </form>
            </div>
```

- [ ] **Step 5: Rebuild the SPA and regenerate headers**

Run (the per-target script builds the SPA and copies `dist/esp32_fs.h` to
`headers/web-sx127x-rx.h` — that exact header is what our target embeds):
```bash
cd /Users/vostapiv/Drones/elrs-v4/src/html
npm ci
npm run build:sx127x-rx
git -C /Users/vostapiv/Drones/elrs-v4 status --short src/html/headers/web-sx127x-rx.h
```
Expected: the build completes and `git status` shows `web-sx127x-rx.h` as modified
(regenerated with the new UI). Only this header matters for the 900 MHz SX127x RX
target; do not run `build:all`.

- [ ] **Step 6: Rebuild v4 firmware so it embeds the new header**

Run: `cd /Users/vostapiv/Drones/elrs-v4/src && pio run -e Unified_ESP32_900_RX_via_UART 2>&1 | tail -3`
Expected: `SUCCESS` (the `copy_html.py` pre-script copies the regenerated
`web-sx127x-rx.h` into `include/WebContent.h`).

- [ ] **Step 7: Commit**

```bash
cd /Users/vostapiv/Drones/elrs-v4
git add src/html/src/pages/binding-panel.js src/html/headers/web-sx127x-rx.h
git commit -m "WebUI: add firmware-version selector below binding phrase (v4 SPA)"
```

---

## Task 5: v3 classic HTML — add the selector

**Files:**
- Modify: `/Users/vostapiv/Drones/elrs-v3/src/html/index.html`

- [ ] **Step 1: Locate the binding phrase section**

Run: `grep -n "Binding Phrase\|bindphrase\|id=\"phrase\"" /Users/vostapiv/Drones/elrs-v3/src/html/index.html`
Note the end of the binding block (the `</div>` closing the section that contains
`id="bindphrase"`). Insert the new markup immediately after that section's closing tag.

- [ ] **Step 2: Add the selector markup**

Insert (match the surrounding indentation/section wrapper used by neighbouring
sections — e.g. the same wrapping `<div>`/`<fieldset>` class the binding section uses):
```html
<div id="fwversion">
    <h2>Firmware Version</h2>
    <div class="mui-radio">
        <label><input type="radio" name="bootslot" value="0"/> ELRS v3.x <span id="slot0this"></span></label>
    </div>
    <div class="mui-radio">
        <label><input type="radio" name="bootslot" value="1"/> ELRS v4.x <span id="slot1this"></span></label>
    </div>
    <button type="button" class="mui-btn mui-btn--primary" id="saveslot">Save</button>
    <span id="slotmsg"></span>
</div>
```

- [ ] **Step 3: Add the JS**

At the end of `index.html` (before `</body>`, or appended to the existing trailing
`<script>` block — check with `grep -n "<script" index.html`), add:
```html
<script>
(function () {
    fetch('/slot').then(r => r.json()).then(d => {
        document.getElementById('slot' + d.running + 'this').textContent = '(this)';
        var el = document.querySelector('input[name=bootslot][value="' + d.running + '"]');
        if (el) el.checked = true;
    });
    document.getElementById('saveslot').addEventListener('click', function () {
        var sel = document.querySelector('input[name=bootslot]:checked');
        if (!sel) return;
        fetch('/slot', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({slot: parseInt(sel.value, 10)})
        }).then(r => r.json()).then(function (d) {
            document.getElementById('slotmsg').textContent =
                d.status === 'current' ? 'Already running this version' :
                d.status === 'rebooting' ? 'Rebooting…' : 'Error switching version';
        });
    });
})();
</script>
```

- [ ] **Step 4: Build v3 (regenerates the HTML header automatically)**

Run: `cd /Users/vostapiv/Drones/elrs-v3/src && pio run -e Unified_ESP32_900_RX_via_UART 2>&1 | tail -3`
Expected: `SUCCESS` (the `build_html.py` pre-script gzips `index.html` into the header).

- [ ] **Step 5: Commit**

```bash
cd /Users/vostapiv/Drones/elrs-v3
git add src/html/index.html && git commit -m "WebUI: add firmware-version selector below binding phrase (v3)"
```

---

## Task 6: Configure and flash both slots

**Files:** none (uses configurator + esptool; requires the board).

- [ ] **Step 1: Configure both firmwares (fresh copies)**

```bash
cd /Users/vostapiv/Drones/elrs-v4/src
cp .pio/build/Unified_ESP32_900_RX_via_UART/firmware.bin /tmp/v4_configured.bin
~/.platformio/penv/bin/python python/binary_configurator.py --dir . \
  --target diy.rx_900.ttgov2 --domain eu_433 --phrase 'Akcept0rD0es!' --auto-wifi 30 \
  /tmp/v4_configured.bin
cd /Users/vostapiv/Drones/elrs-v3/src
cp .pio/build/Unified_ESP32_900_RX_via_UART/firmware.bin /tmp/v3_configured.bin
~/.platformio/penv/bin/python python/binary_configurator.py --dir . \
  --target diy.rx_900.ttgov2 --domain eu_433 --phrase 'Akcept0rD0es!' --auto-wifi 30 \
  /tmp/v3_configured.bin
```
Expected: both commands exit 0; `/tmp/v3_configured.bin` and `/tmp/v4_configured.bin` exist.

- [ ] **Step 2: Flash both slots**

```bash
V4DIR=/Users/vostapiv/Drones/elrs-v4/src/.pio/build/Unified_ESP32_900_RX_via_UART
~/.platformio/penv/bin/python ~/.platformio/packages/tool-esptoolpy@1.40501.0/esptool.py \
  --chip esp32 --port /dev/tty.usbserial-595D0219001 --baud 460800 write_flash \
  0x1000 "$V4DIR/bootloader.bin" 0x8000 "$V4DIR/partitions.bin" \
  0xe000 "$V4DIR/boot_app0.bin" \
  0x10000 /tmp/v3_configured.bin 0x1F0000 /tmp/v4_configured.bin 2>&1 | tail -6
```
Expected: `Hash of data verified.` and `Hard resetting via RTS pin...`. boot_app0 sets
app0 (v3.x) to boot first.

---

## Task 7: On-device verification

**Files:** none (observation on hardware).

- [ ] **Step 1: First boot stays on v3 (no auto-alternation)**

Power-cycle the board twice. After ~30 s with no TX it starts WiFi (`ExpressLRS RX`,
password `expresslrs`). Connect, open `http://10.0.0.1`.
Expected: the "Firmware Version" selector shows **ELRS v3.x (this)** on every boot —
it no longer alternates by itself.

- [ ] **Step 2: Switch to v4 via the WebUI**

In the selector, choose **ELRS v4.x** and click **Save**.
Expected: page shows "Rebooting…"; the board reboots.

- [ ] **Step 3: Confirm it switched and stays**

Reconnect to WiFi after ~30 s, open the WebUI.
Expected: selector now shows **ELRS v4.x (this)**. Power-cycle again → still v4.x
(it stays on the selected slot).

- [ ] **Step 4: Switch back and check the no-op path**

Select **ELRS v3.x** → Save → reboots → comes up v3.x. Then select **ELRS v3.x** again
(already running) → Save.
Expected: message "Already running this version", **no reboot**.

- [ ] **Step 5: (optional) Confirm via otadata**

With the board freshly booted on a chosen version, put it in download mode and read
otadata:
```bash
~/.platformio/penv/bin/python ~/.platformio/packages/tool-esptoolpy@1.40501.0/esptool.py \
  --chip esp32 --port /dev/tty.usbserial-595D0219001 read_flash 0xe000 0x2000 /tmp/od.bin
```
Decode entry seqs (entry0 @0x0, entry1 @0x1000): the active slot should match the
selection and **not** change across plain power-cycles.

---

## Cleanup / publish (after verification passes)

- [ ] **Step 1: Push the branches to ElrsDual**

```bash
cd /Users/vostapiv/Drones/ExpressLRS
TOK=$(gh auth token)
git -C /Users/vostapiv/Drones/elrs-v3 push "https://x-access-token:$TOK@github.com/Akceptor/ElrsDual.git" dual-ota/v3.6.3
git -C /Users/vostapiv/Drones/elrs-v4 push "https://x-access-token:$TOK@github.com/Akceptor/ElrsDual.git" dual-ota/v4.0.1
```
Expected: both branches updated on the remote.
