# Bootloader OTA-Slot Switch (Rapid Power-Cycle) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a custom ESP32 second-stage bootloader that flips the active OTA slot after 3 rapid power cycles, so a user can switch between two opaque stock ELRS firmware images using only the radio — no PC, no source changes to the apps.

**Architecture:** A standalone ESP-IDF v4.4.x bootloader build adds a `bootloader_after_init()` hook. The hook keeps a `{magic,count,last_boot_rtc_us}` struct in the bootloader's reserved RTC retain-memory `custom` area, uses the RTC slow clock to tell rapid cycles (<5 s gap) from normal ones, and on the 3rd rapid cycle rewrites the `otadata` partition (fixed at 0xE000) to select the other OTA slot. The stock partition table and both app images are never modified. Only `bootloader.bin` is flashed to 0x1000.

**Tech Stack:** ESP-IDF v4.4.x (matching arduino-esp32 3.20016's IDF base), C, `bootloader_support` APIs (`bootloader_common_*`, `bootloader_flash_*`), `soc/rtc.h` (`rtc_time_get`), esptool.py for flashing.

**Spec:** `docs/superpowers/specs/2026-06-10-bootloader-slot-switch-design.md`

---

## Domain notes for the implementer (read first)

- **There is no host unit-test harness for bootloader code.** It runs before any OS. "Tests" in this plan are **on-device observations**: flash the bootloader, watch the boot log over UART, power-cycle, and check observable outcomes. Each task gives explicit PASS/FAIL criteria.
- **Do all bench work on the BayckRC Nano Gemini over plain UART** (`/dev/tty.usbserial-2120`). Its USB-serial exposes the ESP32 boot ROM/2nd-stage log directly, which we need to read. The TX15 (internal, ETX passthrough) is validated last, once the logic is proven.
- **The ESP32 boot log is emitted by the 2nd-stage bootloader over GPIO1/U0TXD at 115200.** A custom bootloader with `ESP_LOGx` calls prints during boot — that is our primary instrument.
- **Fixed flash layout (min_spiffs.csv, both targets):** `otadata` partition at offset `0xE000`, size `0x2000` (two 0x1000 sub-sectors); `ota_0` selected when active `ota_seq` is odd, `ota_1` when even (`slot = (ota_seq - 1) % 2`). The bootloader at `0x1000` may occupy up to `0x7000` bytes (table is at `0x8000`).
- **Safety property to preserve:** worst case must be "did not switch," never "switched by accident." Never increment on cold boot or on gaps ≥ 5 s.

### File structure (created under a new top-level dir in the repo)

```
bootloader-slot-switch/                 # standalone ESP-IDF project (NOT built by PlatformIO)
  CMakeLists.txt                        # IDF project file, sets target esp32
  sdkconfig.defaults                    # flash DIO/40m, custom RTC reserve, no secure boot
  main/CMakeLists.txt                   # minimal app (chainloaded only during bring-up tests)
  main/main.c                           # tiny placeholder app for Task 1 bring-up only
  bootloader_components/
    slot_switch/
      CMakeLists.txt                    # registers the bootloader hook component
      slot_switch.h                     # struct + constants + public API
      slot_switch_state.c               # RTC counter state machine (Task 4)
      slot_switch_otadata.c             # otadata read + flip (Task 5)
      hook.c                            # bootloader_after_init() wiring (Task 1 stub, Task 6 full)
  tools/
    backup-bootloader.sh                # Task 2
    flash-bootloader.sh                 # Task 7/8
  README.md                             # Task 9
```

`slot_switch_state.c` owns the "is this a rapid cycle / what's the count" decision. `slot_switch_otadata.c` owns flash reads/writes and CRC. `hook.c` is the thin wiring that the IDF bootloader calls. Splitting state from flash keeps each file small and lets the state machine be reasoned about without flash details.

---

## Task 1: ESP-IDF v4.4 environment + minimal custom bootloader that boots

**Files:**
- Create: `bootloader-slot-switch/CMakeLists.txt`
- Create: `bootloader-slot-switch/sdkconfig.defaults`
- Create: `bootloader-slot-switch/main/CMakeLists.txt`
- Create: `bootloader-slot-switch/main/main.c`
- Create: `bootloader-slot-switch/bootloader_components/slot_switch/CMakeLists.txt`
- Create: `bootloader-slot-switch/bootloader_components/slot_switch/hook.c`

- [ ] **Step 1: Install ESP-IDF v4.4.x**

```bash
mkdir -p ~/esp && cd ~/esp
git clone -b release/v4.4 --depth 1 --recursive https://github.com/espressif/esp-idf.git esp-idf-v4.4
cd esp-idf-v4.4 && ./install.sh esp32
# Confirm the headers this plan depends on exist:
ls components/bootloader_support/include/bootloader_hooks.h \
   components/bootloader_support/include/bootloader_flash_priv.h \
   components/bootloader_support/include/bootloader_common.h
```
Expected: all three paths print (no "No such file").

- [ ] **Step 2: Create the IDF project skeleton**

`bootloader-slot-switch/CMakeLists.txt`:
```cmake
cmake_minimum_required(VERSION 3.16)
include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(slot_switch_boot)
```

`bootloader-slot-switch/main/CMakeLists.txt`:
```cmake
idf_component_register(SRCS "main.c" INCLUDE_DIRS ".")
```

`bootloader-slot-switch/main/main.c` (placeholder app, only used to prove the chain boots during bring-up):
```c
#include <stdio.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
void app_main(void) {
    for (;;) { printf("PLACEHOLDER_APP_RUNNING\n"); vTaskDelay(pdMS_TO_TICKS(1000)); }
}
```

- [ ] **Step 3: Configure flash + RTC reserve to match the ELRS devices**

`bootloader-slot-switch/sdkconfig.defaults`:
```
CONFIG_IDF_TARGET="esp32"
CONFIG_ESPTOOLPY_FLASHMODE_DIO=y
CONFIG_ESPTOOLPY_FLASHFREQ_40M=y
CONFIG_ESPTOOLPY_FLASHSIZE_DETECT=y
CONFIG_SECURE_BOOT=n
CONFIG_SECURE_FLASH_ENC_ENABLED=n
CONFIG_BOOTLOADER_LOG_LEVEL_INFO=y
CONFIG_BOOTLOADER_CUSTOM_RESERVE_RTC=y
CONFIG_BOOTLOADER_CUSTOM_RESERVE_RTC_SIZE=0x18
CONFIG_PARTITION_TABLE_CUSTOM=y
```

- [ ] **Step 4: Register a no-op bootloader hook component**

`bootloader-slot-switch/bootloader_components/slot_switch/CMakeLists.txt`:
```cmake
idf_component_register(SRCS "hook.c"
                       INCLUDE_DIRS "."
                       REQUIRES bootloader_support)
```

`bootloader-slot-switch/bootloader_components/slot_switch/hook.c` (Task 1 stub — just proves the hook links and runs):
```c
#include "bootloader_hooks.h"
#include "esp_log.h"

static const char *TAG = "slot_switch";

void bootloader_before_init(void) {}

void bootloader_after_init(void) {
    ESP_LOGI(TAG, "slot_switch hook alive");
}
```

- [ ] **Step 5: Build**

```bash
cd ~/esp/esp-idf-v4.4 && . ./export.sh
cd /Users/vostapiv/Drones/ExpressLRS/bootloader-slot-switch
idf.py set-target esp32 && idf.py bootloader
ls build/bootloader/bootloader.bin
```
Expected: `bootloader.bin` exists.

- [ ] **Step 6: Verify the hook runs on hardware (bring-up, BayckRC)**

> ⚠️ Back up first if you have not done Task 2 — but for a *brand-new* bench device with nothing precious, you may flash the full project to confirm chainload. On the real dual-OTA device, do Task 2 first and flash ONLY the bootloader.

```bash
# Full flash to a scratch device to prove the chain boots:
idf.py -p /dev/tty.usbserial-2120 flash monitor
```
Expected log sequence (PASS): `slot_switch hook alive` appears during boot, followed by `PLACEHOLDER_APP_RUNNING` repeating. FAIL: boot loop, no hook line, or reset before app.

- [ ] **Step 7: Commit**

```bash
cd /Users/vostapiv/Drones/ExpressLRS
git add bootloader-slot-switch/CMakeLists.txt bootloader-slot-switch/sdkconfig.defaults \
        bootloader-slot-switch/main bootloader-slot-switch/bootloader_components
git commit -m "feat(bootloader): minimal custom bootloader with running after_init hook"
```

---

## Task 2: Back up the stock bootloader from each device

**Files:**
- Create: `bootloader-slot-switch/tools/backup-bootloader.sh`

- [ ] **Step 1: Write the backup script**

`bootloader-slot-switch/tools/backup-bootloader.sh`:
```bash
#!/usr/bin/env bash
# Usage: backup-bootloader.sh <port> <out.bin>
# Reads the second-stage bootloader region (0x1000..0x8000) over UART.
set -euo pipefail
PORT="${1:?port required}"; OUT="${2:?output file required}"
python3 -m esptool --port "$PORT" --baud 460800 --chip esp32 \
  read-flash 0x1000 0x7000 "$OUT"
echo "Backed up stock bootloader to $OUT ($(wc -c < "$OUT") bytes)"
```

- [ ] **Step 2: Make executable and back up BayckRC**

```bash
chmod +x bootloader-slot-switch/tools/backup-bootloader.sh
bootloader-slot-switch/tools/backup-bootloader.sh /dev/tty.usbserial-2120 \
  bootloader-slot-switch/backups/bayckrc-stock-bootloader.bin
```
Expected: prints "Backed up stock bootloader … 28672 bytes".

- [ ] **Step 3: Back up TX15 (via ETX passthrough)**

```bash
cd /Users/vostapiv/Drones/ExpressLRS/src
python3 -c "
import sys; sys.path.insert(0,'python')
import ETXinitPassthrough, esptool
ETXinitPassthrough.etx_passthrough_init('/dev/tty.usbmodem2003645000001', 460800)
esptool.main(['--chip','esp32','--port','/dev/tty.usbmodem2003645000001','--baud','460800',
  '--before','no_reset','--after','hard_reset','read_flash','0x1000','0x7000',
  '../bootloader-slot-switch/backups/tx15-stock-bootloader.bin'])
"
```
Expected: a 28672-byte file is written.

- [ ] **Step 4: Commit the backups and script**

```bash
cd /Users/vostapiv/Drones/ExpressLRS
git add bootloader-slot-switch/tools/backup-bootloader.sh bootloader-slot-switch/backups
git commit -m "chore(bootloader): backup script + stock bootloader images for both devices"
```

---

## Task 3: Bench-test RTC retain memory across power cycles (THE unknown)

This validates the spec's one empirical risk before building real logic: does RTC retain-memory survive a rapid off/on, and does the RTC slow clock advance let us tell rapid from slow?

**Files:**
- Modify: `bootloader-slot-switch/bootloader_components/slot_switch/hook.c`

- [ ] **Step 1: Instrument the hook to log reboot counter + RTC time**

Replace `hook.c` body:
```c
#include "bootloader_hooks.h"
#include "bootloader_common.h"
#include "esp_image_format.h"   // rtc_retain_mem_t
#include "soc/rtc.h"            // rtc_time_get
#include "esp_rom_crc.h"        // esp_rom_crc32_le
#include "esp_log.h"
#include <string.h>

static const char *TAG = "slot_switch";

// Magic marks our custom RTC area as initialized.
#define SS_MAGIC 0x5701A700u

typedef struct {
    uint32_t magic;
    uint32_t count;
    uint64_t last_boot_rtc_ticks;
} ss_state_t;

// Recompute the whole-struct CRC so our writes into rm->custom survive the next
// warm boot (the IDF bootloader validates this CRC and resets the area if stale).
static void ss_commit_rtc(rtc_retain_mem_t *rm) {
    rm->crc = esp_rom_crc32_le(UINT32_MAX, (uint8_t *)rm, sizeof(*rm) - sizeof(rm->crc));
}

void bootloader_before_init(void) {}

void bootloader_after_init(void) {
    rtc_retain_mem_t *rm = bootloader_common_get_rtc_retain_mem();
    ss_state_t *st = (ss_state_t *)rm->custom;          // CUSTOM_RESERVE_RTC area
    uint64_t now = rtc_time_get();                       // RTC slow-clock ticks

    bool valid = (st->magic == SS_MAGIC);
    uint64_t gap = valid ? (now - st->last_boot_rtc_ticks) : 0;
    ESP_LOGI(TAG, "valid=%d count=%u now_ticks=%llu gap_ticks=%llu",
             valid, valid ? st->count : 0, now, gap);

    if (!valid) { st->magic = SS_MAGIC; st->count = 1; }
    else        { st->count += 1; }
    st->last_boot_rtc_ticks = now;
    ss_commit_rtc(rm);
}
```

> The `ss_commit_rtc` CRC refresh is what makes retention observable: without it the IDF bootloader treats the custom area as stale on each warm boot and resets it. This task therefore also de-risks Task 6's persistence. If `valid=0` still appears on every warm boot *despite* the refresh, RTC RAM is genuinely not retained on this board (the real failure mode) — stop and report.

- [ ] **Step 2: Build and flash bootloader only to BayckRC**

```bash
cd ~/esp/esp-idf-v4.4 && . ./export.sh
cd /Users/vostapiv/Drones/ExpressLRS/bootloader-slot-switch && idf.py bootloader
python3 -m esptool --port /dev/tty.usbserial-2120 --baud 460800 --chip esp32 \
  write-flash 0x1000 build/bootloader/bootloader.bin
```
Expected: "Hash of data verified."

- [ ] **Step 3: Observe RAPID cycles (PASS = counter accumulates)**

Open a serial monitor (`idf.py -p /dev/tty.usbserial-2120 monitor`), then power-cycle the module **3 times within ~2 s each** (toggle the radio's Internal RF off/on, or the bench supply).
Expected (PASS): successive boots log `count=1`, `count=2`, `count=3` and `now_ticks` increases by a small amount each time. FAIL: `valid=0` on every boot (RTC RAM not retained) — if so, record it; the gesture cannot work on this board and it must use the alternate-every-boot fallback (out of scope here, but stop and report).

- [ ] **Step 4: Observe NORMAL cycles (PASS = counter resets)**

Power the module on, leave it running **> 10 s**, power off **> 10 s**, power on. Repeat 3×.
Expected (PASS): each boot logs `valid=0` (full power-off drained RTC) **or** a gap `now - last` ≥ the 5 s window — i.e., `count` returns to 1 every time. FAIL: count accumulates across long-gap cycles (would cause accidental switches).

- [ ] **Step 5: Record findings and commit the instrumented hook**

Append a short "RTC retention bench result" note (PASS/FAIL + observed tick rate) to `docs/superpowers/specs/2026-06-10-bootloader-slot-switch-design.md` under "Verification".
```bash
cd /Users/vostapiv/Drones/ExpressLRS
git add bootloader-slot-switch/bootloader_components/slot_switch/hook.c \
        docs/superpowers/specs/2026-06-10-bootloader-slot-switch-design.md
git commit -m "test(bootloader): bench RTC retain-memory retention across power cycles"
```

---

## Task 4: Power-cycle counter state machine

Move the decision logic out of the hook into a testable, flash-free unit with explicit window/min-gap/threshold rules.

**Files:**
- Create: `bootloader-slot-switch/bootloader_components/slot_switch/slot_switch.h`
- Create: `bootloader-slot-switch/bootloader_components/slot_switch/slot_switch_state.c`
- Modify: `bootloader-slot-switch/bootloader_components/slot_switch/CMakeLists.txt`

- [ ] **Step 1: Define the public interface and constants**

`slot_switch.h`:
```c
#pragma once
#include <stdint.h>
#include <stdbool.h>

#define SS_MAGIC      0x5701A700u
#define SS_THRESHOLD  3u          // rapid cycles to trigger a switch
// rtc_time_get() returns RTC slow-clock TICKS. Default RTC slow clock is the
// internal ~150 kHz RC oscillator, so 1 s ≈ 150000 ticks. The RC osc drifts
// (~±7% over temp/voltage), which is irrelevant for a coarse 5 s gesture window.
#define SS_RTC_HZ        150000ull
#define SS_WINDOW_TICKS  (5ull * SS_RTC_HZ)        // ≈ 5 s
#define SS_MIN_GAP_TICKS ((3ull * SS_RTC_HZ) / 10) // ≈ 300 ms

typedef struct {
    uint32_t magic;
    uint32_t count;
    uint64_t last_boot_rtc_ticks;
} ss_state_t;

// Pure decision function (no flash, no RTC reads) — unit-reasoned and bench-checked.
// Given prior state and the gap (in RTC ticks) since last boot, updates state and
// returns whether to switch. `gap_ticks` is UINT64_MAX to denote "RTC was not
// retained" (cold boot).
bool ss_step(ss_state_t *st, uint64_t now_ticks, uint64_t gap_ticks);
```

- [ ] **Step 2: Implement the state machine**

`slot_switch_state.c`:
```c
#include "slot_switch.h"

bool ss_step(ss_state_t *st, uint64_t now_ticks, uint64_t gap_ticks)
{
    // Cold boot or corrupted RTC area: start fresh, never switch.
    if (st->magic != SS_MAGIC || gap_ticks == UINT64_MAX) {
        st->magic = SS_MAGIC;
        st->count = 1;
        st->last_boot_rtc_ticks = now_ticks;
        return false;
    }
    // Chatter guard: too-fast bounce does not count.
    if (gap_ticks < SS_MIN_GAP_TICKS) {
        st->last_boot_rtc_ticks = now_ticks;
        return false;
    }
    // Outside the rapid window: explicit clear point.
    if (gap_ticks >= SS_WINDOW_TICKS) {
        st->count = 1;
        st->last_boot_rtc_ticks = now_ticks;
        return false;
    }
    // Genuine rapid cycle.
    st->count += 1;
    st->last_boot_rtc_ticks = now_ticks;
    if (st->count >= SS_THRESHOLD) {
        st->count = 0;     // consume the gesture; avoid bounce-back
        return true;       // caller performs the flip
    }
    return false;
}
```

- [ ] **Step 3: Add the source to the component build**

`CMakeLists.txt`:
```cmake
idf_component_register(SRCS "hook.c" "slot_switch_state.c"
                       INCLUDE_DIRS "."
                       REQUIRES bootloader_support)
```

- [ ] **Step 4: Bench-verify the transitions on hardware**

Swap the inline increment in `hook.c` for a call to the new `ss_step` (keep the `ss_commit_rtc` refresh and the existing includes; add `#include "slot_switch.h"`). Replace the body of `bootloader_after_init()` with:
```c
    rtc_retain_mem_t *rm = bootloader_common_get_rtc_retain_mem();
    ss_state_t *st = (ss_state_t *)rm->custom;
    uint64_t now = rtc_time_get();
    bool retained = (st->magic == SS_MAGIC);
    uint64_t gap = retained ? (now - st->last_boot_rtc_ticks) : UINT64_MAX;
    bool sw = ss_step(st, now, gap);
    ss_commit_rtc(rm);
    ESP_LOGI(TAG, "count=%u gap_ticks=%llu switch=%d", st->count, retained ? gap : 0, sw);
```
(The local `ss_state_t`/`SS_MAGIC` definitions in `hook.c` are now superseded by `slot_switch.h`; delete the duplicates from `hook.c` so only the header defines them.) Build, flash bootloader, and on BayckRC: 3 rapid cycles (<5 s each) → the third boot logs `switch=1`; a >5 s gap logs `count=1 switch=0`.
Expected (PASS): transitions as described. FAIL: switch fires on slow cycles, or never fires on 3 rapid cycles.
Build, flash bootloader, and confirm on BayckRC: 3 rapid cycles → third boot logs `switch=1`; a >5 s gap resets `count=1`, `switch=0`.
Expected: PASS as described. FAIL: switch fires on slow cycles or never fires on 3 rapid.

- [ ] **Step 5: Commit**

```bash
cd /Users/vostapiv/Drones/ExpressLRS
git add bootloader-slot-switch/bootloader_components/slot_switch/slot_switch.h \
        bootloader-slot-switch/bootloader_components/slot_switch/slot_switch_state.c \
        bootloader-slot-switch/bootloader_components/slot_switch/CMakeLists.txt \
        bootloader-slot-switch/bootloader_components/slot_switch/hook.c
git commit -m "feat(bootloader): rapid power-cycle counter state machine (window/min-gap/threshold)"
```

---

## Task 5: otadata read + flip

**Files:**
- Create: `bootloader-slot-switch/bootloader_components/slot_switch/slot_switch_otadata.c`
- Modify: `bootloader-slot-switch/bootloader_components/slot_switch/slot_switch.h`
- Modify: `bootloader-slot-switch/bootloader_components/slot_switch/CMakeLists.txt`

- [ ] **Step 1: Declare the otadata API**

Append to `slot_switch.h`:
```c
#define SS_OTADATA_OFFSET   0xE000u
#define SS_OTADATA_SECTOR   0x1000u   // each of the two select entries lives in its own 4K sector
#define SS_NUM_OTA_PARTS    2u

// Reads both otadata entries, flips the active selection to the other OTA slot,
// and writes it back. Returns the new active slot (0 or 1), or -1 on error.
int ss_flip_otadata(void);
```

- [ ] **Step 2: Implement read + CRC + flip**

`slot_switch_otadata.c`:
```c
#include "slot_switch.h"
#include "bootloader_common.h"
#include "bootloader_flash_priv.h"
#include "esp_flash_partitions.h"   // esp_ota_select_entry_t
#include "esp_log.h"
#include <string.h>

static const char *TAG = "slot_switch";

int ss_flip_otadata(void)
{
    esp_ota_select_entry_t two[2] = {0};
    if (bootloader_flash_read(SS_OTADATA_OFFSET, &two[0], sizeof(two[0]), true) != ESP_OK) return -1;
    if (bootloader_flash_read(SS_OTADATA_OFFSET + SS_OTADATA_SECTOR, &two[1], sizeof(two[1]), true) != ESP_OK) return -1;

    // Highest valid ota_seq is the active entry.
    uint32_t seq[2] = {0, 0};
    for (int i = 0; i < 2; i++) {
        if (bootloader_common_ota_select_valid(&two[i])) seq[i] = two[i].ota_seq;
    }
    uint32_t max_seq = seq[0] > seq[1] ? seq[0] : seq[1];
    uint32_t cur_slot = (max_seq == 0) ? 0 : ((max_seq - 1) % SS_NUM_OTA_PARTS);
    uint32_t new_slot = (cur_slot + 1) % SS_NUM_OTA_PARTS;

    // Pick a new ota_seq that (a) is greater than both and (b) selects new_slot.
    uint32_t new_seq = max_seq + 1;
    if (((new_seq - 1) % SS_NUM_OTA_PARTS) != new_slot) new_seq += 1;

    // Write into the entry sector that is NOT currently active (wear alternation).
    uint32_t target_sector = (seq[0] >= seq[1]) ? 1 : 0;
    uint32_t target_off = SS_OTADATA_OFFSET + target_sector * SS_OTADATA_SECTOR;

    esp_ota_select_entry_t e = {0};
    e.ota_seq = new_seq;
    memset(e.seq_label, 0xFF, sizeof(e.seq_label));
    e.crc = bootloader_common_ota_select_crc(&e);

    if (bootloader_flash_erase_sector(target_off / SS_OTADATA_SECTOR) != ESP_OK) return -1;
    if (bootloader_flash_write(target_off, &e, sizeof(e), false) != ESP_OK) return -1;

    ESP_LOGI(TAG, "otadata flip: slot %u -> %u (seq %u -> %u)", cur_slot, new_slot, max_seq, new_seq);
    return (int)new_slot;
}
```

- [ ] **Step 3: Add to the component build**

`CMakeLists.txt`:
```cmake
idf_component_register(SRCS "hook.c" "slot_switch_state.c" "slot_switch_otadata.c"
                       INCLUDE_DIRS "."
                       REQUIRES bootloader_support spi_flash)
```

- [ ] **Step 4: Bench-verify the flip in isolation**

Temporarily call `ss_flip_otadata()` unconditionally once at the end of the hook, build, flash bootloader to a **dual-OTA** BayckRC that has different firmware in each slot, and confirm each boot logs `otadata flip: slot X -> Y` and the *other* firmware runs (check ELRS version via Lua/telemetry). Then remove the unconditional call.
Expected: PASS — firmware alternates each boot. FAIL: same firmware every boot, or boot fails (bad otadata/CRC).

- [ ] **Step 5: Commit**

```bash
cd /Users/vostapiv/Drones/ExpressLRS
git add bootloader-slot-switch/bootloader_components/slot_switch/slot_switch_otadata.c \
        bootloader-slot-switch/bootloader_components/slot_switch/slot_switch.h \
        bootloader-slot-switch/bootloader_components/slot_switch/CMakeLists.txt
git commit -m "feat(bootloader): read+flip otadata to select the other OTA slot"
```

---

## Task 6: Wire counter → flip, with CRC-correct RTC persistence

**Files:**
- Modify: `bootloader-slot-switch/bootloader_components/slot_switch/hook.c`

- [ ] **Step 1: Final hook implementation**

Replace `hook.c`:
```c
#include "bootloader_hooks.h"
#include "bootloader_common.h"
#include "esp_image_format.h"   // rtc_retain_mem_t
#include "soc/rtc.h"            // rtc_time_get
#include "esp_rom_crc.h"        // esp_rom_crc32_le (for rtc_retain_mem CRC)
#include "esp_log.h"
#include <string.h>
#include "slot_switch.h"

static const char *TAG = "slot_switch";

// Recompute and store the rtc_retain_mem CRC so our custom-area writes survive the next warm boot.
static void ss_commit_rtc(rtc_retain_mem_t *rm) {
    rm->crc = esp_rom_crc32_le(UINT32_MAX, (uint8_t *)rm, sizeof(*rm) - sizeof(rm->crc));
}

void bootloader_before_init(void) {}

void bootloader_after_init(void) {
    rtc_retain_mem_t *rm = bootloader_common_get_rtc_retain_mem();
    ss_state_t *st = (ss_state_t *)rm->custom;

    uint64_t now = rtc_time_get();
    bool retained = (st->magic == SS_MAGIC);
    uint64_t gap = retained ? (now - st->last_boot_rtc_ticks) : UINT64_MAX;

    bool do_switch = ss_step(st, now, gap);
    ss_commit_rtc(rm);

    ESP_LOGI(TAG, "count=%u gap_ticks=%llu switch=%d", st->count, retained ? gap : 0, do_switch);
    if (do_switch) {
        int slot = ss_flip_otadata();
        ESP_LOGI(TAG, "switched to slot %d", slot);
    }
}
```

- [ ] **Step 2: Build**

```bash
cd ~/esp/esp-idf-v4.4 && . ./export.sh
cd /Users/vostapiv/Drones/ExpressLRS/bootloader-slot-switch && idf.py bootloader
ls build/bootloader/bootloader.bin
```
Expected: bootloader.bin built.

- [ ] **Step 3: Verify warm-boot persistence (CRC correctness)**

Flash bootloader to BayckRC, monitor, do **2** rapid cycles, then read the log on the 3rd boot.
Expected (PASS): boots show `count=1`, `count=2`, `count=3 … switch=1` — i.e., the custom area persisted across warm boots (proves `ss_commit_rtc` works). FAIL: every boot logs `count=1` (CRC invalid → area treated as cold each time).

- [ ] **Step 4: Commit**

```bash
cd /Users/vostapiv/Drones/ExpressLRS
git add bootloader-slot-switch/bootloader_components/slot_switch/hook.c
git commit -m "feat(bootloader): wire rapid-cycle counter to otadata flip with CRC-persisted RTC state"
```

---

## Task 7: Release build + full on-device verification (BayckRC)

**Files:**
- Create: `bootloader-slot-switch/tools/flash-bootloader.sh`
- Modify: `bootloader-slot-switch/sdkconfig.defaults`

- [ ] **Step 1: Quiet the bootloader log for release**

In `sdkconfig.defaults`, change the log level line to:
```
CONFIG_BOOTLOADER_LOG_LEVEL_WARN=y
```
and remove `CONFIG_BOOTLOADER_LOG_LEVEL_INFO=y`. Rebuild:
```bash
cd /Users/vostapiv/Drones/ExpressLRS/bootloader-slot-switch
rm -f sdkconfig && idf.py bootloader
```
Expected: builds; boot log is now quiet.

- [ ] **Step 2: Write the flash helper**

`bootloader-slot-switch/tools/flash-bootloader.sh`:
```bash
#!/usr/bin/env bash
# Usage: flash-bootloader.sh <port>   (UART devices only; writes ONLY 0x1000)
set -euo pipefail
PORT="${1:?port required}"
BIN="$(dirname "$0")/../build/bootloader/bootloader.bin"
python3 -m esptool --port "$PORT" --baud 460800 --chip esp32 \
  write-flash 0x1000 "$BIN"
echo "Flashed custom bootloader to 0x1000 on $PORT (apps untouched)"
```
```bash
chmod +x bootloader-slot-switch/tools/flash-bootloader.sh
bootloader-slot-switch/tools/flash-bootloader.sh /dev/tty.usbserial-2120
```
Expected: "Hash of data verified."

- [ ] **Step 3: Functional test — switch via gesture**

Note current firmware (Lua "FW Slot" value or version). Power-cycle 3× rapidly (<5 s each).
Expected (PASS): after the 3rd cycle the module boots the *other* slot's firmware (verify via Lua version). Repeat 3 rapid cycles → switches back.

- [ ] **Step 4: Negative test — normal use does not switch**

From a known slot: power on, leave running > 10 s, power off > 10 s; repeat 5×.
Expected (PASS): firmware never changes.

- [ ] **Step 5: Recovery test**

Restore the stock bootloader and confirm normal boot:
```bash
python3 -m esptool --port /dev/tty.usbserial-2120 --baud 460800 --chip esp32 \
  write-flash 0x1000 bootloader-slot-switch/backups/bayckrc-stock-bootloader.bin
```
Expected (PASS): device boots the otadata-selected slot; 3 rapid cycles no longer switch. Then re-flash the custom bootloader to leave the feature enabled.

- [ ] **Step 6: Commit**

```bash
cd /Users/vostapiv/Drones/ExpressLRS
git add bootloader-slot-switch/tools/flash-bootloader.sh bootloader-slot-switch/sdkconfig.defaults
git commit -m "feat(bootloader): release (quiet) build + flash helper; verified switch/negative/recovery on BayckRC"
```

---

## Task 8: Verify on RadioMaster TX15 (ETX passthrough)

**Files:** none (uses existing artifacts + tools)

- [ ] **Step 1: Flash custom bootloader to TX15 via ETX passthrough (only 0x1000)**

```bash
cd /Users/vostapiv/Drones/ExpressLRS/src
python3 -c "
import sys; sys.path.insert(0,'python')
import ETXinitPassthrough, esptool
ETXinitPassthrough.etx_passthrough_init('/dev/tty.usbmodem2003645000001', 460800)
esptool.main(['--chip','esp32','--port','/dev/tty.usbmodem2003645000001','--baud','460800',
  '--before','no_reset','--after','hard_reset','write_flash','0x1000',
  '../bootloader-slot-switch/build/bootloader/bootloader.bin'])
"
```
Expected: "Hash of data verified."

- [ ] **Step 2: Gesture test on TX15**

Toggle Internal RF off/on 3× rapidly from the radio's model menu (no PC).
Expected (PASS): module boots the other slot (verify via Lua "FW Slot"/version). Normal single toggles do not switch.

- [ ] **Step 3: Recovery check (TX15)**

Reflash `backups/tx15-stock-bootloader.bin` to 0x1000 via the same passthrough method, confirm normal boot, then reflash the custom bootloader.
Expected (PASS): clean restore and re-enable.

- [ ] **Step 4: Commit (record TX15 result)**

Append a one-line "TX15 verified" note to `docs/superpowers/specs/2026-06-10-bootloader-slot-switch-design.md` Verification section.
```bash
cd /Users/vostapiv/Drones/ExpressLRS
git add docs/superpowers/specs/2026-06-10-bootloader-slot-switch-design.md
git commit -m "test(bootloader): verify rapid-cycle slot switch on RadioMaster TX15"
```

---

## Task 9: Document + fold into the build-flash skill

**Files:**
- Create: `bootloader-slot-switch/README.md`
- Modify: `src/.claude/skills/build-flash-elrs/SKILL.md`

- [ ] **Step 1: Write the project README**

`bootloader-slot-switch/README.md` — cover: what it does (3 rapid cycles flip slot), the fixed layout assumptions (otadata 0xE000, 2 OTA parts, TX-only), constants (`SS_THRESHOLD`/`SS_WINDOW_US`/`SS_MIN_GAP_US` in `slot_switch.h`), build (`idf.py bootloader`), backup-before-flash, flash only 0x1000 (UART and ETX recipes), and recovery. Reference the spec and this plan by path.

- [ ] **Step 2: Add a section to the skill**

Append to `src/.claude/skills/build-flash-elrs/SKILL.md` a "Switching slots with no computer (custom bootloader)" section: the gesture (3 rapid power cycles / Internal-RF toggles within 5 s), that it requires the custom bootloader from `bootloader-slot-switch/` flashed once to 0x1000, that apps are untouched, and the recovery path. Note it is TX-only.

- [ ] **Step 3: Commit**

```bash
cd /Users/vostapiv/Drones/ExpressLRS
git add bootloader-slot-switch/README.md src/.claude/skills/build-flash-elrs/SKILL.md
git commit -m "docs(bootloader): README + build-flash skill section for no-PC slot switching"
```

---

## Final verification checklist

- [ ] `idf.py bootloader` builds cleanly on ESP-IDF v4.4 for target esp32.
- [ ] Stock bootloaders for both devices are backed up and committed.
- [ ] RTC retain memory survives rapid cycles; counter resets on long gaps (Task 3 PASS).
- [ ] 3 rapid cycles switch the slot on BayckRC (UART) and TX15 (ETX) — verified via Lua version.
- [ ] Normal multi-cycle use never switches (negative test PASS on both).
- [ ] Stock bootloader restore returns to normal boot on both devices.
- [ ] Both app images and the partition table are byte-identical before/after (only 0x1000 and, on a switch, 0xE000 change).
