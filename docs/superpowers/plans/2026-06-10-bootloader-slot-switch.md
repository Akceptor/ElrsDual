# Bootloader OTA-Slot Switch (Rapid Power-Cycle) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a custom ESP32 second-stage bootloader that flips the active OTA slot after 3 rapid power cycles, so a user can switch between two opaque stock ELRS firmware images using only the radio — no PC, no source changes to the apps.

**Architecture (as built):** A standalone ESP-IDF bootloader adds a `bootloader_after_init()` hook. The hook keeps a `uint32_t` power-cycle counter in a dedicated flash sector; on each boot it increments the counter, and either (a) on reaching 3 rewrites the `otadata` partition (fixed at `0xE000`) to select the other OTA slot, or (b) **busy-waits ~2 s then clears the counter**. A *rapid* cycle interrupts that settle window before the clear (so the count sticks); a *normal* boot runs past it (counter clears). No RTC, no app cooperation. The stock partition table and both app images are never modified — only `bootloader.bin` is written to `0x1000`.

> **Why not RTC?** The original design used an RTC-retained counter + RTC clock. Bench-tested and **rejected**: RTC FAST memory does not survive `POWERON_RESET` on ESP32 (it's a deep-sleep feature). See the spec's "RTC-retained memory does NOT work" finding. The flash-counter + settle-window mechanism replaced it and is verified working.

**Tech Stack:** ESP-IDF (v6 used; v4.4 also fine — the IDF v6 bootloader chainloads arduino-esp32 3.20016 / IDF-4.4 app images, **verified on hardware**), C, `bootloader_support` APIs (`bootloader_common_ota_select_crc/valid`, `bootloader_flash_read/write/erase_sector`), `esp_rom_delay_us`, esptool for flashing.

**Spec:** `docs/superpowers/specs/2026-06-10-bootloader-slot-switch-design.md`

---

## Implementation status (2026-06-10)

Built and verified on a **LilyGo v2 TX (ESP32-PICO-D4, 4 MB)**. Project lives at
repo-root `bootloader-slot-switch/` (committed on branch `design/bootloader-slot-switch`).

| Task | Status |
|------|--------|
| 1 — custom bootloader + running hook | ✅ done, verified (`slot_switch hook alive` → app chainloads) |
| 3 — power-cycle detector | ✅ **done as flash-counter + settle window** (RTC pivot); rapid→count 1·2·3, normal→steady |
| 4 — detection logic | ✅ folded into the hook (no separate state-machine file) |
| 5/6 — otadata flip + wiring | ✅ done, verified (ota_0↔ota_1 alternates on 3 rapid cycles, persists) |
| LilyGo full deploy | ✅ ELRS v3.6.3→ota_0, v4→ota_1, our bootloader@0x1000, EU_433 (bonus, done) |
| web flasher button | ✅ done on `dual-ota-flasher` (`Flash slot-switch bootloader (0x1000)`) |
| 7/8 — real-target deploy (BayckRC/TX15) | ⏳ remaining (8 MB BayckRC: rebuild bootloader `FLASHSIZE_8MB`) |
| 9 — docs / build-flash skill section | ⏳ remaining |

**The actual implementation is `bootloader-slot-switch/bootloader_components/slot_switch/hook.c`** (single file: counter + settle + otadata flip). Tasks 3–6 below are kept for history; the "as built" code is in that file and summarized in Task 3.

---

## Domain notes for the implementer (read first)

- **There is no host unit-test harness for bootloader code.** It runs before any OS. "Tests" in this plan are **on-device observations**: flash the bootloader, watch the boot log over UART, power-cycle, and check observable outcomes. Each task gives explicit PASS/FAIL criteria.
- **Bench work was done on a LilyGo v2 (ESP32-PICO-D4) over plain UART**, whose USB-serial exposes the ESP32 boot ROM / 2nd-stage log directly. Any plain-ESP32 board with a readable UART works; ETX-passthrough boards (TX15 internal) are validated last.
- **The ESP32 boot log is emitted by the 2nd-stage bootloader over GPIO1/U0TXD at 115200.** A custom bootloader with `ESP_LOGx` calls prints during boot — that is our primary instrument. (Flash-counter behavior is testable deterministically with timed EN resets, since flash persists across reset — no physical power cycling needed.)
- **Fixed flash layout (min_spiffs.csv):** `otadata` at `0xE000` (two `0x1000` sub-sectors); `ota_0` active when `ota_seq` is odd, `ota_1` when even (`slot = (ota_seq - 1) % 2`); counter sector reuses `coredump` at `0x3F0000`. The bootloader at `0x1000` may occupy up to `0x7000` bytes (table at `0x8000`).
- **Safety property:** worst case must be "did not switch," never "switched by accident." A normal boot always clears the counter; only a sub-2 s rapid off/on chain accumulates.

### File structure (as built, under a top-level dir in the repo)

The RTC-era multi-file split was unnecessary — the logic is small and lives in one hook file:

```
bootloader-slot-switch/                 # standalone ESP-IDF project (NOT built by PlatformIO)
  CMakeLists.txt                        # IDF project file, sets target esp32
  sdkconfig.defaults                    # flash DIO/40m/4MB, no secure boot, custom partition table
  partitions.csv                        # dual-OTA bring-up table (mirrors min_spiffs offsets) + slotctr
  main/CMakeLists.txt
  main/main.c                           # bring-up app: prints its running OTA slot
  bootloader_components/
    slot_switch/
      CMakeLists.txt                    # idf_component_register(... PRIV_REQUIRES bootloader_support esp_rom spi_flash)
      hook.c                            # counter + settle window + otadata flip (the whole feature)
```

`hook.c` is the single source of truth for the mechanism. Still to create (Task 9): a `README.md` and an optional flash helper.

---

## Task 1: ESP-IDF v4.4 environment + minimal custom bootloader that boots

**Files:**
- Create: `bootloader-slot-switch/CMakeLists.txt`
- Create: `bootloader-slot-switch/sdkconfig.defaults`
- Create: `bootloader-slot-switch/main/CMakeLists.txt`
- Create: `bootloader-slot-switch/main/main.c`
- Create: `bootloader-slot-switch/bootloader_components/slot_switch/CMakeLists.txt`
- Create: `bootloader-slot-switch/bootloader_components/slot_switch/hook.c`

> **Bring-up executed 2026-06-10 — PASS.** Done on a **LilyGo v2 TX
> (ESP32-PICO-D4, 4 MB)**, port `/dev/tty.usbserial-595D0219001`, using an
> already-installed **ESP-IDF v6.0-dev** (not v4.4 — v6 is fine for bring-up and
> avoids a cmake-4.x/v4.4 clash; the v4.4 pin matters only when chainloading the
> stock arduino-esp32 ELRS images in Tasks 5+). `bootloader_hooks.h` in v6 lives
> at `components/bootloader/subproject/main/` and must NOT be included (see Step
> 4). The USB-serial adapter is flaky above ~115200 — **flash at `-b 115200`**
> (460800 failed at `flash_id`). Boot log confirmed `slot_switch hook alive` then
> `PLACEHOLDER_APP_RUNNING`.

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
idf_component_register(SRCS "hook.c")
```
> Do NOT add `REQUIRES bootloader_support` or `INCLUDE_DIRS` here for the Task 1
> stub — the official IDF hook example registers only the source. (Later tasks
> that call `bootloader_common_*`/`bootloader_flash_*` add `PRIV_REQUIRES` as
> needed; validate against the IDF version in use.)

`bootloader-slot-switch/bootloader_components/slot_switch/hook.c` (Task 1 stub — just proves the hook links and runs):
```c
#include "esp_log.h"

static const char *TAG = "slot_switch";

// Anchor symbol forces the linker to keep this (otherwise-weak) hook object in
// the bootloader image — REQUIRED by the bootloader_components mechanism.
void bootloader_hooks_include(void) {}

// Do NOT #include "bootloader_hooks.h" — it lives in the bootloader subproject's
// private main/ dir and is not on the component include path. The hooks are weak
// symbols; defining them here with the exact signature overrides the defaults.
void bootloader_before_init(void) {}

void bootloader_after_init(void) {
    ESP_LOGI(TAG, "slot_switch hook alive");
}
```

- [ ] **Step 5: Build**

```bash
cd ~/esp/esp-idf-v4.4 && . ./export.sh
cd bootloader-slot-switch
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
cd <repo-root>
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
cd src
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
cd <repo-root>
git add bootloader-slot-switch/tools/backup-bootloader.sh bootloader-slot-switch/backups
git commit -m "chore(bootloader): backup script + stock bootloader images for both devices"
```

---

## Task 3 (as built): Flash counter + settle-window detector + otadata flip

> Supersedes the original RTC-based Tasks 3–6. Implemented as a single hook file
> and verified on hardware. Files: `bootloader-slot-switch/partitions.csv`,
> `.../bootloader_components/slot_switch/{hook.c,CMakeLists.txt}`,
> `.../main/main.c`, `sdkconfig.defaults`. The authoritative code is `hook.c`.

**Mechanism** (no RTC, no app cooperation):
- Counter `uint32_t` in a dedicated flash sector (erased = 0).
- Each boot: `n = read; next = n + 1`.
  - `next >= SS_THRESHOLD (3)` → `ss_flip_otadata()`, clear counter, boot.
  - else → write `next`, busy-wait `SS_SETTLE_MS (2000)`, clear counter, boot.
- A rapid cycle powers off *during* the settle wait → the increment persists.
  A normal boot runs past it → counter clears. Worst case is "didn't switch",
  never a wrong switch.

**otadata flip** runs in `bootloader_after_init` (before partition selection, so it
takes effect the *same* boot): read both `esp_ota_select_entry_t` at `0xE000`/`0xF000`,
take the highest valid `ota_seq`, write the inactive sector with `seq = max+1` chosen
so `(seq-1) % 2 == other_slot`, CRC via `bootloader_common_ota_select_crc`.

**Counter storage:** a dedicated `slotctr` sector. The bring-up table places it at
`0x3F0000` (= min_spiffs `coredump` slot), so the same offset works on real targets
without changing the partition table.

**Component CMake:**
`idf_component_register(SRCS "hook.c" PRIV_REQUIRES bootloader_support esp_rom spi_flash)`
— `spi_flash` is required because `bootloader_flash_priv.h` transitively includes
`spi_flash_mmap.h`.

**`sdkconfig.defaults`:** `FLASHMODE_DIO`, `FLASHFREQ_40M`, `FLASHSIZE_4MB` (use
`FLASHSIZE_8MB` for 8 MB targets like BayckRC), secure boot/enc off,
`BOOTLOADER_LOG_LEVEL_INFO`, custom partition table (`partitions.csv`).

- [x] Verified: rapid 3× → `count 1·2·3` → `otadata flip` → other slot boots same cycle.
- [x] Verified: normal boots stay at count 1, never switch.
- [x] Verified: IDF-v6 bootloader chainloads ELRS IDF-4.4 images.

### End-to-end deploy recipe (used for the LilyGo; template for real targets)

```bash
# 1. Build both ELRS firmwares for the target (e.g. diy.tx_900.ttgov2), one domain:
#    Build v4 from a branch that has the vendored-esptool relative-import fix
#    (e.g. lua-slot/v4) or the build fails with "cannot import name 'make_image'".
pio run -e Unified_ESP32_900_TX_via_UART          # in each of the v3 and v4 trees
# 2. Bake hardware layout + domain into each app image:
python3 python/binary_configurator.py .pio/build/Unified_ESP32_900_TX_via_UART/firmware.bin \
  --target <tgt> --domain eu_433 --flash dir --out /tmp/out-vN
# 3. Flash. Only 0x1000 differs from a stock ELRS flash — our bootloader:
python3 -m esptool --chip esp32 -p <port> -b 115200 write-flash --flash-size <4MB|8MB> \
  0x1000   bootloader-slot-switch/build/bootloader/bootloader.bin \
  0x8000   <build>/partitions.bin \
  0xe000   <build>/boot_app0.bin \
  0x10000  /tmp/out-v3/firmware.bin \
  0x1f0000 /tmp/out-v4/firmware.bin
python3 -m esptool --chip esp32 -p <port> -b 115200 erase-region 0x3f0000 0x1000   # clean counter
```

On UART boards flash directly; on ETX-passthrough boards, init passthrough first
(see the build-flash-elrs skill). To upgrade only the bootloader on a board that
already has v3/v4, write just `0x1000` — or use the web flasher's
**Flash slot-switch bootloader** button.

> The original RTC-based Tasks 3–6 (state machine, RTC retain memory, CRC
> persistence) are removed: that approach was bench-disproven. History is in git
> and in the spec's RTC finding.
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
cd bootloader-slot-switch
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
cd <repo-root>
git add bootloader-slot-switch/tools/flash-bootloader.sh bootloader-slot-switch/sdkconfig.defaults
git commit -m "feat(bootloader): release (quiet) build + flash helper; verified switch/negative/recovery on BayckRC"
```

---

## Task 8: Verify on RadioMaster TX15 (ETX passthrough)

**Files:** none (uses existing artifacts + tools)

- [ ] **Step 1: Flash custom bootloader to TX15 via ETX passthrough (only 0x1000)**

```bash
cd src
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
cd <repo-root>
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
cd <repo-root>
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
