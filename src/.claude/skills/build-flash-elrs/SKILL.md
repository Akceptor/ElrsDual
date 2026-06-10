---
name: build-flash-elrs
description: Use when building and flashing ExpressLRS firmware to a TX device (dual-OTA setup with v3.6.3 in OTA_1 and v4 in OTA_0)
---

# Build and Flash ExpressLRS (Dual-OTA)

## Overview

This repo maintains two firmware trees:
- **v4** (`lua-slot/v4` branch, working dir: `src`)
- **v3.6.3** (`lua-slot/v3.6.3` branch, worktree: `../elrs-v3/src`)

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
pio run -e Unified_ESP32_LR1121_TX_via_UART -d ../elrs-v3/src

# Restore
sed -i '' 's/-DRegulatory_Domain_EU_868/#-DRegulatory_Domain_EU_868/' user_defines.txt
```

Built binaries land at:
- v4: `.pio/build/Unified_ESP32_LR1121_TX_via_UART/firmware.bin`
- v3: `../elrs-v3/src/.pio/build/Unified_ESP32_LR1121_TX_via_UART/firmware.bin`

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
  ../elrs-v3/src/.pio/build/Unified_ESP32_LR1121_TX_via_UART/firmware.bin \
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

## Web UI artifacts (v4 only — CI gate)

The v4 WebUI is a Lit/Vite SPA. The compiled output is committed as gzipped
C byte-array headers under `src/html/headers/*.h`. CI (`build-and-validate-artifacts`
in `.github/workflows/build.yml`) rebuilds them and fails the PR if the committed
headers don't match freshly built ones:

```bash
cd src/html
cp -r headers out      # snapshot committed headers
npm run build:all      # regenerate all 10 headers
diff -qr out headers   # must be identical
```

**If you change any WebUI source (e.g. `src/html/src/pages/tx-options-panel.js`),
you MUST rebuild and commit the headers.** Shared UI code compiles into *every*
matching header, not just one:

| Source change scope | Headers that must be rebuilt |
|---------------------|------------------------------|
| TX-only panel (e.g. `tx-options-panel.js`) | `web-{lr1121,sx128x,sx127x}-tx.h` **and** `*-tx-8285.h` (5 files) |
| RX-only panel | the matching `*-rx*.h` files |
| Shared component | potentially all 10 headers |

A common mistake is rebuilding only `web-lr1121-tx.h` and forgetting the
sx127x/sx128x TX variants — CI will catch the stale ones.

### Rebuilding to match CI exactly

CI uses **Node 20**. Vite/rollup output can differ between Node majors, producing
spurious diffs that fail CI. If your local Node differs, build in a container:

```bash
cd src   # repo root containing html/
docker run --rm -v "$PWD/html:/work" -w /work node:20 bash -c \
  "npm ci && npm run build:all"
git status --short html/headers/   # shows which headers actually changed
rm -rf html/out                    # out/ is a CI snapshot, never committed
git add html/headers/web-*.h
```

Then commit only the changed `headers/*.h` files. RX headers won't change for a
TX-only edit — if they do, your Node version is producing non-deterministic output
and you should rely on the `node:20` container result.

v3.6.3 uses the older multi-file HTML web UI compiled at PlatformIO build time —
there are no pre-committed header artifacts and no CI artifact gate, so this section
does not apply to the v3 branch.

---

## Partition layout (both devices)

```
0x01000   bootloader
0x08000   partition table (min_spiffs.csv — dual OTA)
0x0e000   boot_app0 (otadata — marks OTA_0 as active by default)
0x10000   OTA_0 → v4 firmware   (1920 KB)
0x1F0000  OTA_1 → v3.6.3 firmware (1920 KB)
```

Slot switching (three independent ways): the Lua menu "FW Slot" selector, the
WebUI → Options → Firmware Version selector, or — with the slot-switch bootloader
below — **3 rapid power cycles** (no computer at all).

## Slot-switch bootloader (no-computer switching)

A custom second-stage bootloader that flips the active OTA slot on **3 quick power
cycles** (each off/on within ~2 s). It writes only `0x1000`; the partition table and
both app images are untouched. Project: `bootloader-slot-switch/` (standalone
ESP-IDF, not built by PlatformIO). Source: `branch design/bootloader-slot-switch`.

### How it works
Each boot it increments a counter in the `coredump` flash sector (`0x3f0000`), then
either flips `otadata` to the other slot (on the 3rd cycle) or busy-waits ~2 s and
clears the counter. A *rapid* cycle interrupts the wait so the count sticks; a
*normal* boot runs past it and clears. Worst case is "didn't switch", never a wrong
switch. Cost: ~2 s added to every normal boot. Tuning `#define`s
(`SS_THRESHOLD`, `SS_SETTLE_MS`) live in `bootloader_components/slot_switch/hook.c`.

### Build it
```bash
. ~/esp-idf/export.sh                       # ESP-IDF v5/v6 ok; bootloader chainloads IDF-4.4 ELRS images
cd bootloader-slot-switch
idf.py set-target esp32 && idf.py bootloader
# -> build/bootloader/bootloader.bin
```
The build is for plain ESP32; the same binary works on any plain-ESP32 min_spiffs
board (4 MB or 8 MB) — flash mode/size/freq are patched into the header at flash
time. Different chip families (S3/C3/…) need `idf.py set-target <chip>`.

### Flash it — via the web flasher (easiest, no toolchain)
1. `cd tools/dual-ota-flasher && python3 -m http.server 8000`, open in Chrome/Edge.
2. **Connect**, then click **Flash slot-switch bootloader (0x1000)**. It writes the
   bundled `bootloader-slotswitch.bin` to `0x1000` only — apps stay. (Rebuild that
   bundled blob from `bootloader-slot-switch/` for non-4 MB boards.)

### Flash it — via esptool (only 0x1000)
```bash
# UART board:
python3 -m esptool --chip esp32 -p <port> -b 460800 write-flash \
  --flash-size <4MB|8MB> 0x1000 bootloader-slot-switch/build/bootloader/bootloader.bin

# ETX passthrough board (run from src/, on a branch with the vendored-esptool fix):
python3 -c "
import sys; sys.path.insert(0,'python')
import ETXinitPassthrough, esptool
ETXinitPassthrough.etx_passthrough_init('<port>', 460800)
esptool.main(['--chip','esp32','--port','<port>','--baud','460800',
  '--before','no_reset','--after','hard_reset','write_flash',
  '-z','--flash_mode','dio','--flash_freq','40m','--flash_size','detect',
  '0x1000','../bootloader-slot-switch/build/bootloader/bootloader.bin'])
"
```
To revert to stock behavior, reflash a normal ELRS build (restores the stock
bootloader at `0x1000`).