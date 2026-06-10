---
name: build-flash-elrs
description: Use when building and flashing ExpressLRS firmware to a TX device (dual-OTA setup with v3.6.3 in OTA_1 and v4 in OTA_0)
---

# Build and Flash ExpressLRS (Dual-OTA)

## Overview

This repo maintains two firmware trees:
- **v4** (`lua-slot/v4` branch, working dir: `/Users/vostapiv/Drones/ExpressLRS/src`)
- **v3.6.3** (`lua-slot/v3.6.3` branch, worktree: `/Users/vostapiv/Drones/elrs-v3/src`)

Both are flashed to the same device: v4 → OTA_0 (0x10000), v3.6.3 → OTA_1 (0x1F0000).

All commands run from `src/` as the working directory.

---

## Step 1 — Find the target name

Target format: `manufacturer.category.device`

```bash
python3 -c "
import json
t = json.load(open('hardware/targets.json'))
for mfr in t:
    for cat in t[mfr]:
        if isinstance(t[mfr][cat], dict):
            for dev in t[mfr][cat]:
                print(f'{mfr}.{cat}.{dev}')
" | grep -i <keyword>
```

To inspect a specific target (shows firmware, upload_methods, layout_file):
```bash
python3 -c "
import json, pprint
t = json.load(open('hardware/targets.json'))
pprint.pprint(t['radiomaster']['tx_dual']['tx15'])
"
```

The `upload_methods` field determines how to flash:
- `["uart"]` → direct esptool via serial
- `["etx", "wifi"]` → EdgeTX passthrough or WiFi OTA

---

## Step 2 — Find the build environment

The `firmware` field in the target maps to a PlatformIO env. Check `targets/esp32-tx.ini`:

| firmware value             | env to use                            |
|----------------------------|---------------------------------------|
| `Unified_ESP32_LR1121_TX`  | `Unified_ESP32_LR1121_TX_via_UART`    |
| `Unified_ESP32_2400_TX`    | `Unified_ESP32_2400_TX_via_UART`      |
| `Unified_ESP32_900_TX`     | `Unified_ESP32_900_TX_via_UART`       |

Always use the `_via_UART` variant — it works for both UART and ETX passthrough targets.

---

## Step 3 — Build

The build system requires exactly one regulatory domain uncommented in `user_defines.txt`.
For unified firmware the domain is baked in at configure time (step 4), not compile time,
but the build script still needs one defined.

```bash
# Temporarily enable EU_868 (or whichever domain)
sed -i '' 's/#-DRegulatory_Domain_EU_868/-DRegulatory_Domain_EU_868/' user_defines.txt

# Build v4
pio run -e Unified_ESP32_LR1121_TX_via_UART

# Build v3 (separate worktree, EU_868 already enabled there)
pio run -e Unified_ESP32_LR1121_TX_via_UART -d /Users/vostapiv/Drones/elrs-v3/src

# Restore
sed -i '' 's/-DRegulatory_Domain_EU_868/#-DRegulatory_Domain_EU_868/' user_defines.txt
```

Built binaries land at:
- v4: `.pio/build/Unified_ESP32_LR1121_TX_via_UART/firmware.bin`
- v3: `/Users/vostapiv/Drones/elrs-v3/src/.pio/build/Unified_ESP32_LR1121_TX_via_UART/firmware.bin`

---

## Step 4 — Configure binaries

Bake in hardware config, domain, and optional bind phrase using `binary_configurator.py`:

```bash
mkdir -p /tmp/out-v4 /tmp/out-v3

python3 python/binary_configurator.py \
  .pio/build/Unified_ESP32_LR1121_TX_via_UART/firmware.bin \
  --target radiomaster.tx_dual.tx15 \
  --domain eu_868 \
  --phrase "YourBindPhrase" \
  --flash dir --out /tmp/out-v4

python3 python/binary_configurator.py \
  /Users/vostapiv/Drones/elrs-v3/src/.pio/build/Unified_ESP32_LR1121_TX_via_UART/firmware.bin \
  --target radiomaster.tx_dual.tx15 \
  --domain eu_868 \
  --phrase "YourBindPhrase" \
  --flash dir --out /tmp/out-v3
```

Omit `--phrase` if no bind phrase is needed.

---

## Step 5 — Flash

### UART devices (`upload_methods: ["uart"]`)

```bash
PORT=/dev/tty.usbserial-XXXX

# OTA_0 — v4
python3 -m esptool --port $PORT --baud 460800 --chip esp32 \
  write-flash 0x10000 /tmp/out-v4/firmware.bin

# OTA_1 — v3
python3 -m esptool --port $PORT --baud 460800 --chip esp32 \
  write-flash 0x1F0000 /tmp/out-v3/firmware.bin
```

For the first flash on a bare device (no partition table yet), flash the full stack for v4:
```bash
python3 python/binary_configurator.py \
  .pio/build/Unified_ESP32_LR1121_TX_via_UART/firmware.bin \
  --target <target> --domain eu_868 --phrase "..." \
  --flash uart --port $PORT
```
This writes bootloader + partitions + firmware. Then flash v3 to 0x1F0000 manually.

### ETX passthrough devices (`upload_methods: ["etx", "wifi"]`)

PORT is the radio's USB-CDC port (`/dev/tty.usbmodemXXX`).

**v4 → OTA_0** (full stack via binary_configurator):
```bash
python3 python/binary_configurator.py \
  .pio/build/Unified_ESP32_LR1121_TX_via_UART/firmware.bin \
  --target radiomaster.tx_dual.tx15 \
  --domain eu_868 \
  --phrase "YourBindPhrase" \
  --flash etx \
  --port /dev/tty.usbmodemXXX
```

**v3 → OTA_1** (ETX passthrough + manual esptool):
```bash
# Wait ~5s after previous flash for EdgeTX to reboot, then:
python3 -c "
import sys; sys.path.insert(0, 'python')
import ETXinitPassthrough, esptool
ETXinitPassthrough.etx_passthrough_init('/dev/tty.usbmodemXXX', 460800)
esptool.main(['--chip', 'esp32', '--port', '/dev/tty.usbmodemXXX', '--baud', '460800',
  '--before', 'no_reset', '--after', 'hard_reset', 'write_flash',
  '-z', '--flash_mode', 'dio', '--flash_freq', '40m', '--flash_size', 'detect',
  '0x1F0000', '/tmp/out-v3/firmware.bin'])
"
```

If ETX passthrough times out, EdgeTX hasn't finished booting yet — wait 5s and retry.

---

## Known devices

| Device | Target | Port type | Flash chip |
|--------|--------|-----------|------------|
| BayckRC 900/2400 Nano Gemini TX | `bayckrc.tx_dual.nano_gemini` | UART (`/dev/tty.usbserial-*`) | ESP32 8MB |
| Radiomaster TX15 internal | `radiomaster.tx_dual.tx15` | ETX (`/dev/tty.usbmodem*`) | ESP32-PICO-D4 4MB |

---

## Partition layout (both devices)

```
0x01000   bootloader
0x08000   partition table (min_spiffs.csv — dual OTA)
0x0e000   boot_app0 (otadata — marks OTA_0 as active by default)
0x10000   OTA_0 → v4 firmware   (1920 KB)
0x1F0000  OTA_1 → v3.6.3 firmware (1920 KB)
```

Slot switching: Lua menu "FW Slot" selector, or WebUI → Options → Firmware Version.