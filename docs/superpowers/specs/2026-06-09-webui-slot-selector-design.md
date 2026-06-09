# WebUI firmware-version (OTA-slot) selector

**Date:** 2026-06-09
**Status:** Approved (design)
**Target hardware:** LiLiGo TTGO LoRa32 T3 v1.6.1 (433 MHz, SX127x), ELRS RX,
target `diy.rx_900.ttgov2`, EU_433.

## Goal

Replace the per-reboot OTA-slot **auto-alternation** with an explicit **WebUI
control**. Below the binding phrase, show two options — **ELRS v3.x** (app0) and
**ELRS v4.x** (app1) — with **"(this)"** appended to the currently running one. On
**Save**, set the boot partition to the chosen slot and reboot into it. The control
must exist in **both** firmwares' WebUIs, because either version may be the one
running when the user opens the page.

Fixed mapping (from the flash layout): **app0 = ELRS v3.x**, **app1 = ELRS v4.x**.

## Background

- v3.6.3 WebUI: classic hand-written `html/index.html`; the build regenerates the
  embedded HTML header automatically (`build_html.py`).
- v4.0.1 WebUI: a Lit-based Vite SPA under `html/src/`; the firmware build only
  *copies* a prebuilt header (`python/copy_html.py` → `include/WebContent.h`), so
  changing it requires a Vite rebuild that regenerates `html/headers/web-sx127x-rx.h`.
  Node 24 / npm 11 are available.
- Both versions' `devWIFI.cpp` use `server.on("/path", handler)` and a deferred
  reboot via `rebootTime = millis() + N`.

## Component 1 — Remove the auto-alternation

In both `src/src/rx_main.cpp` (v3.6.3 and v4.0.1 worktrees), delete the snippet we
added earlier:
- the `esp_ota_set_boot_partition(...)` block at the top of `setup()`, and
- the one-shot `DBGLN("[OTA-TOGGLE] ...")` block at the top of `loop()`.

Keep the `#include "esp_ota_ops.h"` (still needed by the new endpoint). The board
then stays on whichever slot booted until the user switches it via the WebUI.

## Component 2 — Backend endpoints (`devWIFI.cpp`, both versions)

Add two routes. Map running partition subtype `ESP_PARTITION_SUBTYPE_APP_OTA_0 → 0`,
`OTA_1 → 1`.

- **GET `/slot`** → `{"running": 0|1}` from `esp_ota_get_running_partition()`.
  The UI uses this to append "(this)".
- **POST `/slot`** with body `{"slot": 0|1}`:
  1. If `slot` equals the running slot → respond `200 {"status":"current"}`, do
     nothing (no-op + message; no reboot).
  2. Else find the target partition with
     `esp_partition_find_first(ESP_PARTITION_TYPE_APP, subtype, NULL)` and call
     `esp_ota_set_boot_partition(target)`.
     - On success → respond `200 "Rebooting…"` and set `rebootTime = millis() + 200`
       (graceful deferred reboot, matching existing patterns).
     - On failure (null target or bad image) → respond `4xx` with an error message;
       do **not** reboot.

## Component 3 — v4 frontend (Lit SPA)

In `html/src/pages/binding-panel.js`, render a small selector immediately after the
binding `<form>`:
- A "Firmware Version" panel with two radio inputs: "ELRS v3.x" (slot 0) and
  "ELRS v4.x" (slot 1).
- On `firstUpdated`, fetch `GET /slot`; append " (this)" to the label whose index
  equals `running`, and pre-select it.
- A Save button that `POST`s `{"slot": <selected>}` to `/slot`; on `200` show
  "Rebooting…"; if response is `{"status":"current"}` show "Already running this
  version."

Then rebuild the SPA: `cd html && npm ci && npm run build`, which regenerates the
headers; commit the updated `html/headers/web-sx127x-rx.h` (the only header our
target uses). The firmware build's `copy_html.py` then embeds it.

## Component 4 — v3 frontend (classic HTML)

In `html/index.html`, add a section directly below the Binding Phrase block:
- A "Firmware Version" fieldset with two radios ("ELRS v3.x" / "ELRS v4.x") and a
  Save button.
- A few lines of JS (in `html/scan.js` or an inline `<script>`) to `fetch('/slot')`,
  append " (this)" to the running entry and pre-select it, and on Save `POST` the
  choice to `/slot`, then show "Rebooting…" / "Already running this version."

The v3 build regenerates its HTML header automatically — no extra tooling.

## Error handling

- Picking the already-running version → no-op with "Already running this version."
- `esp_ota_set_boot_partition` failure (corrupt/missing target image) → error shown
  in the UI, no reboot.
- `/slot` POST with a missing/invalid `slot` value → `400`.

## Testing / verification

1. Both firmwares build; v4 SPA rebuilds and the regenerated header is committed.
2. Flash both slots; open the WebUI of the running version.
3. The selector shows both versions with "(this)" on the running one.
4. Select the other version → Save → board reboots into it.
5. Reconnect to the WebUI → "(this)" is now on the newly running version.
6. Plain power-cycles no longer alternate — `otadata` stays on the selected slot
   (confirms the auto-alternation was removed).
7. Selecting the already-running version → "Already running this version", no reboot.

## Out of scope

- Showing the exact running firmware version string (labels stay static "v3.x"/"v4.x").
- Any change to the slot↔version mapping or the flash layout.
- TX-side WebUI.
