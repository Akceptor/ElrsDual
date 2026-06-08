# Dual-version ELRS with per-reboot OTA-slot alternation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Flash ELRS v3.6.3 and v4.0.1 into the two OTA slots of one LiLiGo ESP32 (900 MHz / SX127x, RX) so the board alternates which version runs on every reboot, using an app-level otadata toggle (no bootloader modification).

**Architecture:** The ELRS ESP32 partition table (`min_spiffs.csv`) already defines two slot-agnostic app partitions (`app0` @ 0x10000, `app1` @ 0x1F0000) plus `otadata`. The same ~6-line snippet is added to both source trees: at the top of `setup()` it calls `esp_ota_set_boot_partition()` on the *inactive* slot, so the next reboot runs the other version. Both images carry the snippet, so they ping-pong app0 ↔ app1. v3 lives in app0, v4 in app1.

**Tech Stack:** ExpressLRS firmware (Arduino-ESP32 / ESP-IDF), PlatformIO (`espressif32` platform), `esp_ota_ops.h` API, `esptool.py`, git worktrees.

**Spec:** `docs/superpowers/specs/2026-06-08-dual-ota-boot-toggle-design.md`

---

## Layout & conventions (read first)

- **Repo root:** `/Users/vostapiv/Drones/ExpressLRS`
- **PlatformIO project root:** `src/` (contains `platformio.ini`, `targets/`, `python/`)
- **C++ sources:** `src/src/` (e.g. `src/src/rx_main.cpp`)
- **Build env:** `Unified_ESP32_900_RX_via_UART`
- **Build artifacts dir (relative to `src/`):** `.pio/build/Unified_ESP32_900_RX_via_UART/`
  contains `firmware.bin`, `bootloader.bin`, `partitions.bin`, and `boot_app0.bin`
  (ELRS copies `boot_app0.bin` into the build dir during the build).

### TDD note for this plan

This is embedded firmware whose core behavior (`esp_ota_set_boot_partition`) is an
ESP-IDF runtime call against real flash; there is no practical native unit test for
it in this codebase. The "test" for each code task is therefore **a clean compile of
the target env**, and the behavioral verification is **on-device** (Task 8). This is
a deliberate, documented deviation from unit-test-first — not an oversight.

### The snippet (identical in both source trees)

**(A) Include** — add near the top of `src/src/rx_main.cpp`, after the existing
`#include` block (the includes end around line 47 on master; place it right after
the last `#include` line):

```c
#if defined(PLATFORM_ESP32)
#include "esp_ota_ops.h"
#endif
```

**(B) Toggle** — the first statement inside `void setup()` (immediately after the
opening `{`, before `if (!options_init())`):

```c
#if defined(PLATFORM_ESP32)
    // --- per-reboot OTA slot alternation ---
    // Arm the *other* OTA slot so the next reboot runs the other firmware
    // version. Done first thing in setup() so it holds even if later init hangs.
    {
        const esp_partition_t *nextSlot = esp_ota_get_next_update_partition(NULL);
        if (nextSlot != NULL)
        {
            esp_ota_set_boot_partition(nextSlot);
        }
    }
#endif
```

**(C) Optional serial confirmation** — the first statement inside the ESP32
`void loop()` (the definition guarded by `#else` against `PLATFORM_ESP32_C3`, i.e.
the plain `void loop()` body — NOT the `[[noreturn]] void loop()` C3 variant),
immediately after its opening `{`:

```c
#if defined(PLATFORM_ESP32)
    // One-shot: report which OTA slot (= firmware version) is running.
    // app0 == v3.6.3, app1 == v4.0.1 per the flash layout.
    // Only emits when built with -DDEBUG_LOG; otherwise DBGLN is a no-op.
    static bool reportedBootSlot = false;
    if (!reportedBootSlot)
    {
        reportedBootSlot = true;
        DBGLN("[OTA-TOGGLE] running slot=%s", esp_ota_get_running_partition()->label);
    }
#endif
```

`DBGLN` is already in scope in `rx_main.cpp` (no extra include). It compiles to
nothing unless the build defines `DEBUG_LOG`.

> On older tags the exact line numbers differ. Always locate `void setup()` and the
> plain (non-C3) `void loop()` by name; the insertion points are "first statement in
> the body", not fixed line numbers.

---

## Task 1: Verify toolchain and board connection

**Files:** none (environment check)

- [ ] **Step 1: Confirm PlatformIO and esptool are available**

Run:
```bash
pio --version
python3 -m esptool version
```
Expected: a PlatformIO version (e.g. `PlatformIO Core, version 6.x`) and an esptool
version string. If `esptool` is missing, install with `python3 -m pip install esptool`.

- [ ] **Step 2: Confirm the LiLiGo board's serial port**

Run (macOS):
```bash
ls /dev/cu.usb*
```
Expected: at least one device, e.g. `/dev/cu.usbserial-0001` or `/dev/cu.SLAB_USBtoUART`.
Record it; this plan refers to it as `$PORT`. Set it for the session:
```bash
export PORT=/dev/cu.usbserial-0001   # replace with the real device
```

- [ ] **Step 3: Confirm the chip identifies as ESP32**

Run:
```bash
python3 -m esptool --port "$PORT" chip_id
```
Expected: `Chip is ESP32-...` and `Features: ...`. (Hold the BOOT button if it
fails to enter download mode.) If it reports a different chip (S3/C3), STOP — this
plan targets plain ESP32; the env and flash offsets would need revisiting.

---

## Task 2: Create isolated worktrees for both tags

**Files:**
- Create worktree: `../elrs-v3` (branch `dual-ota/v3.6.3` from tag `3.6.3`)
- Create worktree: `../elrs-v4` (branch `dual-ota/v4.0.1` from tag `4.0.1`)

We cannot have both tag checkouts in one working tree, so we use git worktrees.

- [ ] **Step 1: Confirm the tags exist**

Run:
```bash
cd /Users/vostapiv/Drones/ExpressLRS
git tag | grep -E '^(3\.6\.3|4\.0\.1)$'
```
Expected output:
```
3.6.3
4.0.1
```

- [ ] **Step 2: Create the v3 worktree**

Run:
```bash
cd /Users/vostapiv/Drones/ExpressLRS
git worktree add -b dual-ota/v3.6.3 ../elrs-v3 3.6.3
```
Expected: `Preparing worktree ... HEAD is now at <sha> ...`.

- [ ] **Step 3: Create the v4 worktree**

Run:
```bash
git worktree add -b dual-ota/v4.0.1 ../elrs-v4 4.0.1
```
Expected: `Preparing worktree ...`.

- [ ] **Step 4: Verify both worktrees and that the env exists in each**

Run:
```bash
git worktree list
grep -l "Unified_ESP32_900_RX_via_UART" ../elrs-v3/src/targets/*.ini ../elrs-v4/src/targets/*.ini
```
Expected: three worktrees listed; both `esp32-rx.ini` files matched. If the env name
differs in the v3 tree, list candidates with
`grep -h '^\[env:.*900_RX' ../elrs-v3/src/targets/esp32-rx.ini` and use that exact
name in place of `Unified_ESP32_900_RX_via_UART` for all v3 steps below.

---

## Task 3: Add the snippet to v4.0.1 and build

**Files:**
- Modify: `../elrs-v4/src/src/rx_main.cpp` (add include A, setup block B, loop block C)

- [ ] **Step 1: Locate the insertion points**

Run:
```bash
grep -n "void setup()" ../elrs-v4/src/src/rx_main.cpp
grep -n "void loop()" ../elrs-v4/src/src/rx_main.cpp
grep -nm1 "^#include" ../elrs-v4/src/src/rx_main.cpp
```
Expected: line numbers for `void setup()`, one or two `void loop()` matches (use the
one immediately preceded by `#else`/`#endif`, not the `[[noreturn]]` C3 one), and the
first include line. Note them.

- [ ] **Step 2: Insert include A**

Add block **(A)** from the conventions section after the last `#include` line near
the top of `../elrs-v4/src/src/rx_main.cpp`.

- [ ] **Step 3: Insert toggle block B**

Add block **(B)** as the first statement inside `void setup()`'s body.

- [ ] **Step 4: Insert optional confirmation block C**

Add block **(C)** as the first statement inside the plain (non-C3) `void loop()`'s body.

- [ ] **Step 5: Build the v4 image (with serial logging for bring-up)**

Run:
```bash
cd ../elrs-v4/src
PLATFORMIO_BUILD_FLAGS="-DDEBUG_LOG" pio run -e Unified_ESP32_900_RX_via_UART
```
Expected: `SUCCESS` and a built `.pio/build/Unified_ESP32_900_RX_via_UART/firmware.bin`.
Compile errors about `esp_ota_ops.h` mean the include is misplaced; about `DBGLN`
mean block C was put in the wrong (C3) loop.

- [ ] **Step 6: Commit the v4 change**

```bash
cd ../elrs-v4
git add src/src/rx_main.cpp
git commit -m "feat: per-reboot OTA slot alternation toggle (v4.0.1)"
```

---

## Task 4: Add the identical snippet to v3.6.3 and build

**Files:**
- Modify: `../elrs-v3/src/src/rx_main.cpp` (add include A, setup block B, loop block C)

- [ ] **Step 1: Locate the insertion points in the v3 tree**

Run:
```bash
grep -n "void setup()" ../elrs-v3/src/src/rx_main.cpp
grep -n "void loop()" ../elrs-v3/src/src/rx_main.cpp
grep -nm1 "^#include" ../elrs-v3/src/src/rx_main.cpp
```
Expected: line numbers (they will differ from v4 — that's fine). If the v3 tree has
only one `void loop()` and no `PLATFORM_ESP32_C3` guard, use that single `void loop()`.

- [ ] **Step 2: Insert include A**

Add the SAME block **(A)** after the last `#include` near the top of
`../elrs-v3/src/src/rx_main.cpp`.

- [ ] **Step 3: Insert toggle block B**

Add the SAME block **(B)** as the first statement inside `void setup()`'s body.

- [ ] **Step 4: Insert confirmation block C**

Add the SAME block **(C)** as the first statement inside the plain `void loop()`'s body.

- [ ] **Step 5: Build the v3 image**

Run:
```bash
cd ../elrs-v3/src
PLATFORMIO_BUILD_FLAGS="-DDEBUG_LOG" pio run -e Unified_ESP32_900_RX_via_UART
```
Expected: `SUCCESS`. If `esp_ota_ops.h` is not found in the v3 toolchain, confirm
the platform downloaded (first build pulls it); re-run. If `esp_ota_get_next_update_partition`
is reported missing, verify the include path — the symbol exists in both IDF 4.x and
5.x cores, so a missing symbol means the include didn't take effect.

- [ ] **Step 6: Commit the v3 change**

```bash
cd ../elrs-v3
git add src/src/rx_main.cpp
git commit -m "feat: per-reboot OTA slot alternation toggle (v3.6.3)"
```

---

## Task 5: Verify the two builds share an identical partition table

**Files:** none (artifact comparison)

The flash layout assumes both images use the same `min_spiffs.csv` offsets. Confirm
the compiled partition tables are byte-identical.

- [ ] **Step 1: Compare partitions.bin**

Run:
```bash
cmp ../elrs-v3/src/.pio/build/Unified_ESP32_900_RX_via_UART/partitions.bin \
    ../elrs-v4/src/.pio/build/Unified_ESP32_900_RX_via_UART/partitions.bin \
  && echo "PARTITIONS MATCH"
```
Expected: `PARTITIONS MATCH`.

- [ ] **Step 2: If they differ, inspect both tables**

Run (only if Step 1 reported a difference):
```bash
python3 -m esptool image_info ../elrs-v3/src/.pio/build/Unified_ESP32_900_RX_via_UART/partitions.bin 2>/dev/null || true
diff <(xxd ../elrs-v3/src/.pio/build/Unified_ESP32_900_RX_via_UART/partitions.bin) \
     <(xxd ../elrs-v4/src/.pio/build/Unified_ESP32_900_RX_via_UART/partitions.bin) | head
```
Expected: shows where the offsets diverge. If app0/app1 offsets differ between
versions, STOP and reconcile (the two apps must agree on slot offsets, or one app
won't run from its slot). Do not proceed to flashing until they match.

---

## Task 6 (optional, for a functional RX): Configure each image for the LiLiGo target

**Files:** none (uses ELRS configurator); produces configured `.bin` files

The unified `firmware.bin` boots and alternates as-is, but to function as a real RX
it must be configured for the LiLiGo hardware target (pins, power, radio). Skip this
task if you only want to demonstrate the alternation; flash the raw `firmware.bin`
instead in Task 7.

- [ ] **Step 1: Identify the LiLiGo target name**

Run:
```bash
cd ../elrs-v4/src
python3 python/binary_configurator.py --help 2>&1 | head -40
```
Expected: usage including a `--target` option. Choose the LiLiGo target identifier
that matches your board (the same one you'd pick in the ExpressLRS web flasher). If
unsure, use the web flasher (https://expresslrs.github.io/web-flasher/) to identify
the exact target string for your board, then supply it as `<LILYGO_TARGET>` below.

- [ ] **Step 2: Configure the v4 image**

Run (replace `<LILYGO_TARGET>` and binding `<PHRASE>`):
```bash
python3 python/binary_configurator.py \
  --target <LILYGO_TARGET> \
  --phrase "<PHRASE>" \
  .pio/build/Unified_ESP32_900_RX_via_UART/firmware.bin
```
Expected: a configured output `.bin` (the configurator reports the output path).
Copy it to a known name:
```bash
cp .pio/build/Unified_ESP32_900_RX_via_UART/firmware.bin /tmp/v4_configured.bin
```
(Adjust if the configurator writes to a different file.)

- [ ] **Step 3: Configure the v3 image**

Run:
```bash
cd ../elrs-v3/src
python3 python/binary_configurator.py \
  --target <LILYGO_TARGET> \
  --phrase "<PHRASE>" \
  .pio/build/Unified_ESP32_900_RX_via_UART/firmware.bin
cp .pio/build/Unified_ESP32_900_RX_via_UART/firmware.bin /tmp/v3_configured.bin
```
Expected: a configured v3 `.bin` at `/tmp/v3_configured.bin`.

> Use the SAME `--phrase` for both so both versions bind to the same TX.

---

## Task 7: Flash both versions into the two OTA slots

**Files:** none (esptool write to hardware). Requires the physical board in download mode.

Choose the app images:
- If Task 6 was done: `V3_BIN=/tmp/v3_configured.bin`, `V4_BIN=/tmp/v4_configured.bin`.
- If Task 6 was skipped: use the raw builds:
  `V3_BIN=../elrs-v3/src/.pio/build/Unified_ESP32_900_RX_via_UART/firmware.bin`,
  `V4_BIN=../elrs-v4/src/.pio/build/Unified_ESP32_900_RX_via_UART/firmware.bin`.

Bootloader/partition/otadata artifacts come from the v4 build dir.

- [ ] **Step 1: Set artifact variables**

Run (from `/Users/vostapiv/Drones/ExpressLRS`):
```bash
cd /Users/vostapiv/Drones/ExpressLRS
export V4DIR=$PWD/../elrs-v4/src/.pio/build/Unified_ESP32_900_RX_via_UART
export V3DIR=$PWD/../elrs-v3/src/.pio/build/Unified_ESP32_900_RX_via_UART
# Default to the raw unified builds. If Task 6 was done, instead set:
#   export V3_BIN=/tmp/v3_configured.bin ; export V4_BIN=/tmp/v4_configured.bin
export V3_BIN=$V3DIR/firmware.bin
export V4_BIN=$V4DIR/firmware.bin
ls -l "$V4DIR/bootloader.bin" "$V4DIR/partitions.bin" "$V4DIR/boot_app0.bin" "$V3_BIN" "$V4_BIN"
```
Expected: all five files listed with non-zero size. If `boot_app0.bin` is absent,
copy it from the framework:
`find ~/.platformio -path '*tools/partitions/boot_app0.bin' | head -1`.

- [ ] **Step 2: Flash the combined layout**

Run (board in download mode; hold BOOT if needed):
```bash
python3 -m esptool --chip esp32 --port "$PORT" --baud 460800 write_flash \
  0x1000   "$V4DIR/bootloader.bin" \
  0x8000   "$V4DIR/partitions.bin" \
  0xe000   "$V4DIR/boot_app0.bin" \
  0x10000  "$V3_BIN" \
  0x1F0000 "$V4_BIN"
```
Expected: esptool writes all five regions and reports `Hash of data verified.` for
each, then `Hard resetting via RTS pin...`. `boot_app0.bin` at 0xe000 initializes
otadata so **app0 (v3) boots first**.

- [ ] **Step 3: Sanity-check the flash contents**

Run:
```bash
python3 -m esptool --chip esp32 --port "$PORT" read_flash 0x10000 0x20 /tmp/app0_head.bin
python3 -m esptool --chip esp32 --port "$PORT" read_flash 0x1F0000 0x20 /tmp/app1_head.bin
xxd /tmp/app0_head.bin | head -1; xxd /tmp/app1_head.bin | head -1
```
Expected: both dumps start with the ESP32 app image magic byte `e9`. (Different
following bytes confirm two distinct images are present.)

---

## Task 8: On-device verification of alternation

**Files:** none (observation on hardware)

- [ ] **Step 1: First boot — confirm v3**

Power-cycle the board. Connect to its ExpressLRS WiFi access point (it appears when
the RX has no link; for an unconfigured image it comes up promptly). Open the web UI
(`http://10.0.0.1/` or `http://elrs_rx.local/`). 
Expected: the web UI reports firmware version **3.6.3** (app0 booted first).

- [ ] **Step 2: Second boot — confirm v4**

Power-cycle again, reconnect to the WiFi AP, reload the web UI.
Expected: version now reports **4.0.1**.

- [ ] **Step 3: Confirm it keeps alternating**

Power-cycle two more times, checking the version each boot.
Expected: 3.6.3 → 4.0.1 → 3.6.3 → 4.0.1 (strict alternation).

- [ ] **Step 4 (optional): Serial confirmation**

If you flashed `-DDEBUG_LOG` builds, attach a serial monitor at 420000 baud to the
logging UART and power-cycle:
```bash
pio device monitor -p "$PORT" -b 420000
```
Expected: once per boot, a line like `[OTA-TOGGLE] running slot=app0` then `app1` on
the next boot, alternating. (No line appears if `-DDEBUG_LOG` was not set — that's
expected; rely on the web UI in that case.)

- [ ] **Step 5: Record the result**

If alternation is confirmed, the feature is complete. If it sticks on one version,
the most likely cause is that one image is missing the snippet (re-check Task 3/4
edits and that both were the `-DDEBUG_LOG` rebuilds actually flashed).

---

## Cleanup (after verification passes)

- [ ] **Step 1: Remove the worktrees (keeps the branches)**

```bash
cd /Users/vostapiv/Drones/ExpressLRS
git worktree remove ../elrs-v3
git worktree remove ../elrs-v4
```
Expected: no output; `git worktree list` shows only the main worktree. The
`dual-ota/v3.6.3` and `dual-ota/v4.0.1` branches remain for reference.
