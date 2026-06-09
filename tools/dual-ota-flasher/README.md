# Dual-OTA Web Flasher

Flash two ELRS firmware versions into the two OTA slots of one ESP32 (app0 = v3.x,
app1 = v4.x), and read either slot back — from the browser, no esptool install.

## Requirements
- Chrome or Edge (Web Serial API).
- The board on USB.

## Run
Web Serial needs a secure context, so serve over localhost:

```
cd tools/dual-ota-flasher
python3 -m http.server 8000
```
Open <http://localhost:8000> in Chrome/Edge.

## Use
1. **Connect** and pick the serial port (hold BOOT if it won't sync).
2. **Write:** choose your configured v3.x image (→ app0) and v4.x image (→ app1),
   then **Flash both slots**. The bundled `bootloader.bin`, `partitions.bin`, and
   `boot_app0.bin` are flashed automatically; `boot_app0.bin` makes app0 (v3.x) boot
   first. The board reboots when done.
3. **Read:** **Read app0 / app1** download that slot to a `.bin`; **Show active
   slot** reports which version currently boots.

Images must already be configured (target/binding/domain) with the ELRS configurator
or official web flasher; this tool only places `.bin`s into slots.

---

## Building firmware from source

### Prerequisites

```
pip install platformio
# Python deps for the configurator
pip install jmespath mmap-lib
```

### 1 — Check out the two version branches

```bash
git worktree add ../elrs-v3 dual-ota/v3.6.3
git worktree add ../elrs-v4 dual-ota/v4.0.1
```

### 2 — Enable your regulatory domain

Edit `user_defines.txt` in **both** `../elrs-v3/src/` and `../elrs-v4/src/` and
uncomment exactly one `Regulatory_Domain_*` line (all others must be commented out):

```
-DRegulatory_Domain_EU_433
```

### 3 — Build

Replace `RX` with `TX` for a transmitter build.

```bash
# v3
cd ../elrs-v3/src
pio run -e Unified_ESP32_900_RX_via_UART   # or _TX_

# v4
cd ../elrs-v4/src
pio run -e Unified_ESP32_900_RX_via_UART   # or _TX_
```

Output binary: `.pio/build/Unified_ESP32_900_<RX|TX>_via_UART/firmware.bin`

### 4 — Configure (bind phrase, domain, auto-wifi)

Run from the `src/` directory so `hardware/targets.json` is found. The configurator
**patches the binary in place** — copy it first if you want to keep an unconfigured
original.

```bash
# RX
cd ../elrs-v3/src
python3 python/binary_configurator.py \
  --target diy.rx_900.ttgov2 \
  --domain eu_433 \
  --phrase 'YourBindPhrase' \
  --auto-wifi 30 \
  .pio/build/Unified_ESP32_900_RX_via_UART/firmware.bin

# TX
cd ../elrs-v3/src
python3 python/binary_configurator.py \
  --target diy.tx_900.ttgov2 \
  --domain eu_433 \
  --phrase 'YourBindPhrase' \
  --auto-wifi 30 \
  --tx \
  .pio/build/Unified_ESP32_900_TX_via_UART/firmware.bin
```

Repeat for `../elrs-v4/src/`.

### 5 — Flash via esptool (CLI)

```bash
esptool.py --port /dev/cu.usbserial-XXXX --baud 460800 --chip esp32 write_flash \
  0x1000   /path/to/ElrsDual/tools/dual-ota-flasher/bootloader.bin \
  0x8000   /path/to/ElrsDual/tools/dual-ota-flasher/partitions.bin \
  0xe000   /path/to/ElrsDual/tools/dual-ota-flasher/boot_app0.bin \
  0x10000  ../elrs-v3/src/.pio/build/Unified_ESP32_900_RX_via_UART/firmware.bin \
  0x1F0000 ../elrs-v4/src/.pio/build/Unified_ESP32_900_RX_via_UART/firmware.bin
```

The board reboots into **app0 (v3.x)** after a fresh flash. Switch versions from
the **Options** tab in either version's WebUI.

---

## Gotchas

**Configurator must receive the firmware path as a positional argument.**
Running without a file argument makes it look for a `FCC/<target>/firmware.bin`
distribution layout that doesn't exist in a source build — it will exit with
"Firmware files not found".

**Run the configurator from the `src/` directory.**
It opens `hardware/targets.json` relative to CWD. Running from anywhere else
produces a `FileNotFoundError`.

**The configurator patches in place.**
There is no `--out` flag for a file path. If you need a pristine copy, duplicate
the binary before running the configurator.

**`--auto-wifi 30` is required for standalone RX use.**
Without it the board never enters WiFi mode (it waits indefinitely for a TX
connection). 30 seconds is a reasonable timeout; omit it only for non-standalone
deployments where WiFi access is not needed.

**`user_defines.txt` must have exactly one domain uncommented.**
Multiple active `Regulatory_Domain_*` lines cause a build error. All others must
be prefixed with `#`.

**Use `--tx` flag with the configurator for TX targets.**
Without it the configurator treats the target as RX and may embed the wrong
device-type discriminator.

**Boot blobs come from the v4 build, not v3.**
`bootloader.bin`, `partitions.bin`, and `boot_app0.bin` in `tools/dual-ota-flasher/`
were copied from the v4.0.1 SX127x build. Do not replace them with v3 blobs; the
partition table must be identical to what both firmware images expect.

**Hold BOOT during connect if esptool fails to sync.**
The CH9102 USB-serial adapter on the LiLiGo board occasionally misses the reset
strobe. Hold the BOOT button before running esptool and release after "Connecting…"
appears.

**Reading flash at high baud rates may time out on CH9102.**
460800 baud works reliably for writes. For reads (`read_flash`) drop to 115200 if
you get "No serial data received" errors.
