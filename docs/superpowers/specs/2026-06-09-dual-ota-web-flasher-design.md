# Dual-OTA web flasher tool

**Date:** 2026-06-09
**Status:** Approved (design)
**Targets:** ESP32 (esp32dev) ELRS RX with the `min_spiffs` two-slot OTA layout.

## Goal

A browser-based tool (Chrome/Edge, Web Serial API) that flashes two already-configured
ELRS app images into the two OTA slots of one ESP32, and reads each slot back to a
file — without installing Python/esptool. It mirrors, in the browser, the manual
`esptool write_flash` / `read_flash` steps used to build the dual-version board.

## Flash layout (fixed)

```
0x1000     bootloader.bin    (bundled)
0x8000     partitions.bin    (bundled, min_spiffs)
0xe000     boot_app0.bin     (bundled; initializes otadata so app0 boots first)
0x10000    app0  = ELRS v3.x (user-selected image)
0x1F0000   app1  = ELRS v4.x (user-selected image)
```
App partition size: `0x1E0000` (1.875 MB) each. otadata: `0xe000`, size `0x2000`.

## Location & delivery

New directory **`tools/dual-ota-flasher/`** containing:
- `index.html` — UI + log pane.
- `flasher.js` — all logic (connect / write / read / otadata decode).
- `bootloader.bin`, `partitions.bin`, `boot_app0.bin` — bundled boot blobs, copied
  from the v4.0.1 SX127x build (`.pio/build/Unified_ESP32_900_RX_via_UART/`).
- `README.md` — how to run.

**Pure static HTML/JS, no build step.** esptool-js is imported as an ES module from a
**pinned CDN URL** (e.g. `https://unpkg.com/esptool-js@<version>/...` or `esm.sh`).
Web Serial requires a secure context, so the tool runs on **`http://localhost`**:
the README instructs `python3 -m http.server` inside the directory, then open
`http://localhost:8000`. (localhost is a Web-Serial secure context; `file://` is not
reliable.) Hosting on GitHub Pages is optional and not enabled as part of this work.

## Components (`flasher.js`)

- **Connect** — uses `navigator.serial.requestPort()` + esptool-js `ESPLoader`
  (`Transport` wrapper) to connect and sync. On success, prints chip type/MAC to the
  log and enables the Write/Read controls.
- **Write panel** — two `<input type="file">`: "v3.x image (app0)" and
  "v4.x image (app1)". A **Flash both slots** button reads the bundled blobs via
  `fetch()` and the two picked files as ArrayBuffers, then calls esptool-js
  `writeFlash` with the five `{data, address}` regions above (compression on),
  reporting per-region progress to the log. After success it triggers a hard reset.
- **Read panel** —
  - **Read app0 (v3.x)** / **Read app1 (v4.x)**: `readFlash` the full `0x1E0000`
    bytes at `0x10000` / `0x1F0000` (≈ 1 min each; progress shown) and download the
    result as `app0-v3.bin` / `app1-v4.bin` via a Blob URL.
  - **Show active slot**: `readFlash` `0x2000` at `0xe000`, decode the two
    `esp_ota_select_entry` records (uint32 `ota_seq` at offsets `0x0` and `0x1000`),
    active = entry with the highest valid (non-0, non-0xFFFFFFFF) seq, slot =
    `(seq-1) % 2`; display "Currently boots: app0 (ELRS v3.x)" or
    "app1 (ELRS v4.x)" (or "indeterminate" if both entries are blank).

## Data flow

Boot blobs are fetched from the tool's own directory at flash time; the two app
images come from the file pickers. All processing is client-side; nothing is
uploaded anywhere.

## Error handling

- No `navigator.serial` (unsupported browser) → show a prominent message; controls
  stay disabled.
- Connect/sync failure → log the error plus a "hold the BOOT button and retry" hint.
- **Flash both slots** pressed before connecting, or before both images are chosen →
  button disabled, with an inline notice explaining what's missing.
- Any esptool-js write/read error → surfaced in the log; the operation aborts without
  leaving the UI in a "busy" state (controls re-enabled in a `finally`).

## Testing / verification

No automated harness (browser + USB hardware). Manual verification on the LiLiGo
board:
1. Serve on localhost, open in Chrome, **Connect** → chip type appears.
2. Pick the configured v3 and v4 images, **Flash both slots** → completes, board boots.
3. **Show active slot** → reports app0 (v3.x) after a fresh flash.
4. **Read app0 / Read app1** → downloaded `.bin`s match the source images (hash).
5. Board's WebUI works and the version selector reflects the active slot.

## Scope / PR

Implemented on branch **`dual-ota-flasher`** off `master`, opened as its **own PR**
against ElrsDual `master`. The tool is generic (not v3/v4-specific) and lives in the
main tree, not the per-version branches.

## Out of scope

- Configuring images (binding phrase, target, regulatory domain) — use the existing
  ELRS configurator / official web flasher; this tool flashes already-configured
  `.bin`s into slots.
- Non-ESP32 targets (ESP8266/STM32).
- Auto-detecting which slot/version an arbitrary image belongs to.
- Parsing the app image to dump only used bytes (full-partition read by design).
