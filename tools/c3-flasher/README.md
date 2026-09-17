# ESP32-C3 Meshtastic Flasher

Flashes a **standalone Meshtastic** firmware image onto an ESP32-C3 board, from the
browser (esptool-js over Web Serial, no install).

## What this does

- Writes a Meshtastic **factory** image (bootloader + partition table + app, all in one
  blob) to offset `0x0`.
- Optionally erases the whole chip first (recommended, and on by default) — these
  boards typically ship freshly flashed with ExpressLRS, and a stale/corrupt NVS
  partition left behind by that can cause an intermittent NimBLE crash loop on
  Meshtastic that looks like a radio fault (see the firmware repo's `HANDOFF.md`).
- Shows a static diagram of the C3 partition table
  (`firmware/variants/esp32c3/unified_esp32c3_lr1121_rx/partitions-dual.csv`) and marks
  the cells this page actually writes.

## What this does NOT do

- **No dual-boot.** This is not the dual-OTA tool. The factory image overwrites
  whatever ExpressLRS firmware is on the board — its bootloader, partition table and
  app all get replaced. There is no slot-switching here; `ota_1` is left untouched
  (reserved for a possible future ExpressLRS/Meshtastic dual-boot setup) and
  `slotctr` (the dual-OTA slot-switch bootloader's power-cycle counter) is left
  untouched too.
- **ESP32-C3 only.** The connect handler refuses any other chip (including plain
  ESP32 — use [`../dual-ota-flasher/`](../dual-ota-flasher/) for that).
- No EdgeTX passthrough. This board is a plain RX on a USB-UART bridge (or native
  USB-JTAG), never behind a TX radio, so that code path from the dual-OTA flasher was
  dropped entirely.
- No bind-phrase/region configuration step — Meshtastic images are flashed as
  published or as supplied; there's nothing to personalize in the browser here.

## After flashing

This board does not reliably auto-restart after an esptool flash — **manually reset
or power-cycle it** to boot the new firmware. This is a confirmed hardware quirk, not
a guess (see the firmware repo's `HANDOFF.md`, "this board doesn't auto-restart after
an esptool flash without a manual reset").

## Adding another board

`config.js` has two maps: `MESHTASTIC_BOARDS` (display label → board key) and
`MESHTASTIC_FIRMWARE` (board key → factory-image filename pattern, with `*` standing
in for the commit-hash segment that changes on every upstream rebuild). Add one entry
to each to support a new board — no other code changes needed.

## Run / stop

Web Serial needs a secure context, so serve the folder over localhost.

**Start (foreground):**
```
cd tools/c3-flasher
python3 -m http.server 8000
```
Then open <http://localhost:8000> in Chrome/Edge. **Stop** with `Ctrl+C`.

**Start (background):**
```
cd tools/c3-flasher
python3 -m http.server 8000 &        # note the PID it prints
```
**Stop:**
```
kill %1
# or:
lsof -ti tcp:8000 | xargs kill       # macOS/Linux
```

Serving must be over `localhost`/`127.0.0.1` (or https) — opening `index.html` as a
`file://` URL disables Web Serial.

## Use

1. **Connect** and pick the serial port (hold BOOT if it won't sync).
2. Pick a firmware source: a **published build** (choose the board, click **Fetch
   build**) or a **local `.factory.bin`** you built yourself.
3. Leave **Erase the whole chip first** checked unless you have a specific reason not
   to, then **Flash**.
4. Manually reset or power-cycle the board when it's done.
