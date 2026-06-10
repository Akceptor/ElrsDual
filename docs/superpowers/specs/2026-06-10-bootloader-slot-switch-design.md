# Bootloader-level OTA-slot switch via rapid power-cycling (no PC, no source)

**Date:** 2026-06-10
**Status:** Approved (design)
**Target hardware:** ExpressLRS **TX** modules on ESP32 — confirmed on
RadioMaster TX15 internal (ESP32-PICO-D4, 4 MB) and BayckRC Nano Gemini
(ESP32, 8 MB). Both use the `min_spiffs.csv` dual-OTA layout.

## Goal

Let a user switch which OTA app slot boots **using only the radio and the TX
module** — no computer, no USB, no WiFi — and **without modifying either app
binary**. The two slots are treated as opaque stock ELRS images (we may not have
their source). The switch gesture is **3 rapid power cycles within a 5 s rolling
window**.

## Why this is possible without touching the apps

The ESP32 boot chain is: ROM bootloader → **2nd-stage bootloader (0x1000)** →
reads `otadata` → jumps to `ota_0` or `ota_1`. The 2nd-stage bootloader is a
**separate binary** from both app slots. We replace only it; the partition table
and both app images are never rewritten.

```
0x01000  2nd-stage bootloader   ← the ONLY thing we replace
0x08000  partition table            (unchanged)
0x0E000  otadata                    (rewritten by bootloader only on a switch)
0x10000  ota_0 = stock ELRS A        (untouched)
0x1F0000 ota_1 = stock ELRS B        (untouched)
```

Existing app-level approaches (Lua menu, WebUI `/slot`, web flasher) all require
either modifying the app or a PC. A custom bootloader needs neither.

## Coexistence with the existing "3× power-cycle" gesture

Confirmed in the codebase: the "3 power cycles → enter binding" counter
(`powerOnCounter`) lives in **`RxConfig`** and is **RX-only**, stored in **flash
config**. TX modules — our only targets — do **not** act on power cycles (WiFi
auto-on is purely time-based via `AUTO_WIFI_ON_INTERVAL`).

Therefore:
- On TX targets there is **no existing power-cycle gesture to collide with**.
- The bootloader counter lives in **RTC-retained RAM**, fully independent of any
  app's flash-based counter — neither can corrupt the other.
- Scope is explicitly **TX-only**. If this bootloader were ever used under an RX
  image, the 3× gesture would overlap RX binding; that is out of scope here.

## Distinguishing 3 *rapid* cycles from 3 *normal* cycles

This is the core correctness requirement: a user who powers the radio on, flies,
and powers off three times across a session must **never** trigger a switch. Only
three deliberate quick off/on cycles should.

### RTC-retained memory does NOT work (bench finding, 2026-06-10)

The original design used an RTC-retained counter + RTC slow clock to measure the
gap between boots. **Bench-tested on the LilyGo v2 (ESP32-PICO-D4) and rejected.**
On every reset the RTC timer (`rtc_time_get()`) read a constant ~14 000 ticks and
our magic sentinel was always absent (`valid=0`), i.e. the RTC domain is zeroed.
The reset reason is `rst:0x1 (POWERON_RESET)` — the same class a real power cycle
produces. ESP32 RTC retention is a **deep-sleep** feature; it does **not** survive
a power-off / POWERON_RESET. (ELRS's own "3 cycles → bind" uses a **flash**
counter, `RxConfig.powerOnCounter`, for exactly this reason.) There is also no
persistent clock across power-off, so gap-based discrimination is impossible at
the bootloader level.

### Adopted mechanism: flash counter + bootloader settle-window

The bootloader provides the "timer" itself, removing the need for RTC or any app
cooperation. State is a single `uint32_t` count in a dedicated flash sector
(erased = 0). On every boot:

1. Read `n`; compute `n+1`.
2. If `n+1 >= THRESHOLD (3)` → flip the slot (see below), reset counter to 0, boot
   the now-selected slot.
3. Otherwise → write `n+1`, **busy-wait `SETTLE_MS` (~2 s)**, then reset the
   counter to 0 and boot normally.

Why this discriminates rapid from normal:
- **Rapid cycle:** the user powers off *during* the ~2 s settle window, before the
  reset-to-0 runs, so the incremented value persists. Three quick cycles reach 3
  → switch.
- **Normal boot:** the device runs past the settle window, the counter is cleared
  to 0, so it never accumulates across normal power-ons — no matter how many.

Properties:
- No RTC, no app cooperation, no partition-table changes to the app images.
- **Worst-case failure is "did not switch," never "switched by accident"** (a
  normal boot always clears; only a deliberate sub-2 s off/on chain accumulates).
- **Cost:** ~2 s added to every normal boot (the settle wait) before the app runs.
- Constants `THRESHOLD = 3`, `SETTLE_MS ≈ 2000` are bootloader build-time `#define`s.

### Counter storage (no app-image change)

The counter needs a flash location that survives power-off and does not collide
with the apps or require moving them:
- **Bring-up (LilyGo):** a dedicated `slotctr` data partition (1 sector) added to
  the project's own partition table.
- **Real targets (min_spiffs):** reuse the first sector of the `coredump`
  partition (present, fixed offset, normally unused on a TX). Re-flashing only the
  partition table at 0x8000 to add a `slotctr` partition is an alternative; either
  way the app images at `ota_0`/`ota_1` are untouched.

Flash wear: up to two erase/writes of one sector per normal boot. At realistic TX
boot rates this is years within the ~100k-cycle endurance; round-robining across
multiple sectors (otadata-style) is an available mitigation if needed.

## Component 1 — Custom bootloader

A standalone **ESP-IDF v4.4.x** bootloader build (matching arduino-esp32 3.20016's
IDF base) that adds the slot-switch logic and chainloads the existing app images
unchanged. Implementation seam (to be confirmed during build — architecture holds
either way):

- Preferred: a project `bootloader_components/elrs_slot_switch/` providing the
  `bootloader_after_init()` hook (runs after flash is configured and **before**
  partition-table load / slot selection). The hook runs the counter logic and, on
  trigger, rewrites `otadata`; the stock selection logic then boots the flipped
  slot, inheriting all normal image validation.
- Fallback if the hook proves insufficient: a minimal patch to
  `bootloader_utility_get_selected_boot_partition()` to override the returned
  index.

RTC-retained storage uses the bootloader's RTC retain-memory region
(`bootloader_common_get_rtc_retain_mem()` custom area, or an equivalent reserved
RTC slot).

**sdkconfig must match the device** so it can read the unencrypted stock images:
ESP32 chip, flash mode **DIO**, freq **40 MHz**, size **detect/auto**, **secure
boot OFF**, **flash encryption OFF**. The bootloader reads the device's existing
partition table at runtime — nothing about the apps or table is baked in.

Output artifact: `bootloader.bin`.

## Component 2 — otadata flip

Identical math to the existing web-flasher branch (`e80501b1 — Set active slot
button … writes otadata via CRC32`), executed from the bootloader:

1. Read both `esp_ota_select_entry_t` entries; the active one is the valid entry
   with the highest `ota_seq`; current slot = `(ota_seq − 1) % num_ota_parts`.
2. Write the **inactive** otadata sector with `ota_seq = max_seq + 1` selecting the
   **other** OTA partition; CRC via `bootloader_common_ota_select_crc()`.
3. One 4 KB sector erase+write per switch; otadata alternates between its two
   sectors by design, so wear is negligible.

## Component 3 — Flashing the bootloader

Replace **only** 0x1000; apps and partition table are left in place.

- **BayckRC (UART):** `esptool … write-flash 0x1000 bootloader.bin`
- **TX15 (ETX passthrough):** same as the build-flash-elrs skill — ETX passthrough
  init, then `esptool … write-flash 0x1000 bootloader.bin`.

**Back up the stock bootloader first:** `esptool … read-flash 0x1000 0x7000
stock-bootloader.bin`.

## Error handling / caveats

- **RTC-RAM retention across the module's power switch is the one empirical
  unknown.** The gesture works only if RTC RAM survives ~3 quick off/on cycles on
  the actual board. If retention is too short on a given module, the gesture
  simply never fires (safe failure) and that board falls back to an
  alternate-every-boot bootloader variant (the rejected "Option B").
- **Bad bootloader cannot be "switched" out**, but the ESP32 ROM loader is always
  reachable over UART / ETX passthrough, so reflashing the backed-up or fixed
  `bootloader.bin` fully recovers. No brick risk beyond a re-flash.
- **No visual confirmation in v1.** These modules use addressable WS2812 RGB LEDs,
  which are impractical to drive from a bootloader. The user confirms the switch
  by observing which firmware booted (version in Lua / telemetry). LED feedback is
  a possible later enhancement, not part of v1.
- **Image-format compatibility** between an IDF-v4.4 bootloader and the
  arduino-esp32 3.20016 app images is low-risk (ESP32 image format is stable
  across 4.x), provided flash settings match.

## Verification

1. **Bench: RTC retention** — flash an instrumented build; perform 3 quick cycles
   (<5 s each) and confirm a switch; confirm 3 *slow* cycles (app running >5 s, or
   >5 s off) do **not** switch. This validates the core unknown before relying on
   it.
2. **Functional** — from a known slot, 3 quick cycles boots the other firmware
   (verify via Lua version string); repeating switches back.
3. **Negative** — normal flying sessions (power on, use minutes, power off) across
   many cycles never switch.
4. **Brownout** — if `MIN_GAP` hardening is enabled, simulate rapid sub-300 ms
   chatter and confirm no switch.
5. **Recovery** — reflash stock bootloader and confirm normal (non-switching)
   boot of the otadata-selected slot.

## Out of scope

- RX targets and any coexistence with RX binding's 3× gesture.
- LED / haptic feedback during the switch.
- Switching to an *absolute* slot (the gesture only toggles to the other slot).
- Any modification of the app images or partition table.
