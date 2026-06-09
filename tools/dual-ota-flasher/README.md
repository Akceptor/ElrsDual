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
