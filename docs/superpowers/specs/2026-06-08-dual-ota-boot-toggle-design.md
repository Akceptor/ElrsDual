# Dual-version ELRS with per-reboot OTA-slot alternation

**Date:** 2026-06-08
**Status:** Approved (design)
**Target hardware:** Single LiLiGo ESP32 board, 900 MHz / SX127x, acting as **RX**

## Goal

Flash ExpressLRS **v3.6.3** and **v4.0.1** into the two OTA app slots of one LiLiGo
ESP32 board, and have the board alternate which firmware version runs on every
reboot. The slot-toggle logic lives in the application (app-level otadata toggle);
the stock Arduino second-stage bootloader is **not** modified.

## Background / why this works out of the box

ELRS ESP32 targets build with `board = esp32dev` and partition table
`min_spiffs.csv` (referenced from `src/targets/common.ini`). That table already
defines two application slots plus an OTA-data partition:

```
# Name,   Type, SubType, Offset,   Size
nvs,      data, nvs,     0x9000,   0x5000
otadata,  data, ota,     0xe000,   0x2000
app0,     app,  ota_0,   0x10000,  0x1E0000   (~1.875 MB)
app1,     app,  ota_1,   0x1F0000, 0x1E0000   (~1.875 MB)
spiffs,   data, spiffs,  0x3D0000, 0x20000
coredump, data, coredump,0x3F0000, 0x10000
```

ESP32 app images are slot-agnostic: the second-stage bootloader maps whichever
OTA slot is selected to the same virtual address via the flash-cache MMU (this is
exactly how ELRS's own WiFi OTA update works). So a v3 image runs unchanged from
`app0` and a v4 image runs unchanged from `app1` — no relinking, no per-slot build.

The ESP32 boot chain is: ROM bootloader → second-stage `bootloader.bin` → reads
`otadata` → jumps to `app0` or `app1`. We never touch the bootloader; instead each
running firmware rewrites `otadata` at startup to point at the *other* slot.

## Component 1 — The toggle snippet (added to BOTH source trees)

The same snippet is added to both the v3.6.3 and v4.0.1 source trees, at the very
top of `setup()` in `src/src/rx_main.cpp` (the PlatformIO project root is `src/`;
C++ sources live in `src/src/`). On master `void setup()` is at line 1958; locate
the equivalent `void setup()` in each tag.

```c
#include "esp_ota_ops.h"
...
void setup()
{
    // --- per-reboot OTA slot alternation ---
    const esp_partition_t *next = esp_ota_get_next_update_partition(NULL);
    if (next != NULL) {
        esp_ota_set_boot_partition(next);   // next reboot runs the other slot
    }
    // (optional) serial log: running partition label -> armed partition label
    ...
}
```

Rationale and properties:

- `esp_ota_get_next_update_partition(NULL)` returns the *inactive* OTA slot
  relative to the currently running one. Setting the boot partition to it means
  the next reboot runs the other version. Because **both** firmwares carry this
  code, the board ping-pongs `app0` ↔ `app1` on every reboot.
- It runs **first thing** in `setup()`. The next slot is armed before any
  later/riskier init, so alternation holds even if a firmware hangs after this
  point.
- Arduino-ESP32 ships with app rollback **disabled** (no
  `CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE`), so `esp_ota_set_boot_partition`
  takes effect immediately — no `esp_ota_mark_app_valid_cancel_rollback()` needed.
- The `esp_ota_*` API is stable across the IDF versions used by both ELRS lines
  (v3.6.3 on the older `espressif32` platform / IDF 4.x, v4.0.1 on
  `espressif32@6.12.0` / IDF 5.x), so the identical snippet compiles in both.

**Critical constraint:** the snippet MUST be present in both images. If a firmware
without the snippet boots, it never re-arms the other slot and the board gets stuck
on that version.

## Component 2 — Two builds

For each tag (`3.6.3`, `4.0.1`):

1. Check out the tag, apply the Component-1 snippet.
2. Build: `pio run -e Unified_ESP32_900_RX_via_UART` (from `src/`).
   Output app image at `.pio/build/Unified_ESP32_900_RX_via_UART/firmware.bin`,
   alongside `bootloader.bin` and `partitions.bin`.
3. Configure the unified firmware for the LiLiGo hardware target using the standard
   ELRS configurator (`python/binary_configurator.py` or the web flasher) so the RX
   is actually functional (pins, power, radio config). Configuration patches the
   options region only and remains slot-agnostic.

Produces `v3_configured.bin` and `v4_configured.bin`.

## Component 3 — Flash layout (single esptool write_flash)

```
0x1000    bootloader.bin     # from the v4.0.1 build (newer IDF; boots both apps)
0x8000    partitions.bin     # min_spiffs table; must be byte-identical between builds
0xe000    boot_app0.bin      # initializes otadata so app0 boots first
0x10000   v3_configured.bin  # app0
0x1F0000  v4_configured.bin  # app1
```

- `boot_app0.bin` (from the Arduino framework `tools/partitions/`) initializes
  `otadata` to select `app0` on first boot → first boot runs **v3** (first-boot
  version was specified as "doesn't matter"; v3-first is the default).
- After the first boot, the Component-1 snippet drives the alternation.

Example (chip esp32):
```
esptool.py --chip esp32 write_flash \
  0x1000   v4/bootloader.bin \
  0x8000   v4/partitions.bin \
  0xe000   boot_app0.bin \
  0x10000  v3_configured.bin \
  0x1F0000 v4_configured.bin
```

## Error handling / caveats

- If `esp_ota_set_boot_partition` rejects a slot (e.g. corrupt/missing image), the
  call returns an error; we log it and continue running the current slot. Result:
  alternation stalls on that slot — surfaced via log, not silent.
- Writing `otadata` on every boot causes flash wear. The `otadata` region is two
  sectors (~100k erase cycles each, alternated) → 200k+ reboot cycles before this
  is a concern. Fine for testing; noted.
- ELRS's **WiFi OTA update** feature also rewrites the boot partition. Using it on
  this board would overwrite a slot and break the alternation scheme until
  reflashed. Avoid WiFi updates on this board.

## Verification

1. Both builds compile cleanly for `Unified_ESP32_900_RX_via_UART`.
2. Confirm `partitions.bin` is byte-identical between the v3.6.3 and v4.0.1 builds
   (both use `min_spiffs.csv`); if they differ, reconcile before flashing.
3. Flash the layout above and power on.
4. **Primary signal — WiFi web UI:** the running ELRS firmware exposes a WiFi
   access point; its web UI displays the firmware version. `DBGLN`/serial logging
   is compiled out by default in RX builds, and on a `_via_UART` RX the main
   `Serial` is the CRSF link to the flight controller, so the web UI is the
   build-flag-free way to read the running version.
5. Power-cycle several times and confirm the displayed version alternates
   3.6.3 ↔ 4.0.1 on each reboot.
6. **Optional serial signal:** build each image with `-DDEBUG_LOG` so the
   one-shot `DBGLN("[OTA-TOGGLE] running slot=...")` in `loop()` prints the running
   OTA slot label (`app0` = v3, `app1` = v4) to the logging UART at 420000 baud.

## Implementation outcome (2026-06-09)

Implemented and verified on hardware (LiLiGo/TTGO V2 LoRa32, 433 MHz).

- **Regulatory domain (spec gap):** 900 MHz builds require a `Regulatory_Domain`
  define that the original spec did not capture. Resolved by enabling
  `-DRegulatory_Domain_EU_433` in `user_defines.txt` in both worktrees (the board
  is a 433 MHz LoRa board).
- **Configuration:** both unified images configured with
  `binary_configurator.py --target diy.rx_900.ttgov2 --domain eu_433 --phrase ...`
  (the `--out` flag expects a directory; the tool configures the file in place).
- **Flash:** `esptool write_flash` of `bootloader.bin` @0x1000, `partitions.bin`
  @0x8000, `boot_app0.bin` @0xe000, v3.6.3 @0x10000 (app0), v4.0.1 @0x1F0000 (app1).
- **Verification (stronger than the WiFi-UI plan):** read the `otadata` partition
  (`0xe000`, 0x2000) and decoded the `ota_seq` of both select entries across
  reboots. Observed `seq` advance `1 → 2 → 3` with the active slot flipping
  `app0 → app1 → app0`, proving the per-reboot alternation directly. The WiFi-UI
  version check (below) remains valid as a human-readable confirmation.
- **Published:** branches `dual-ota/v3.6.3` and `dual-ota/v4.0.1` pushed to
  `Akceptor/ElrsDual`.

## Out of scope

- Modifying the second-stage bootloader (explicitly rejected in favor of the
  app-level approach).
- Coexistence with the WiFi OTA updater (mutually exclusive with this scheme).
- TX-side builds (board is configured as RX).