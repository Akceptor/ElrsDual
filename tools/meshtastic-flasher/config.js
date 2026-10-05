// Static config for the C3 flasher. Safe to serve publicly (no secrets, no token).

// Pre-built standalone Meshtastic "factory" images (bootloader + partition table + app,
// written at 0x0) live here. Same repo/branch the dual-ota-flasher's Meshtastic OTA
// builds come from — see tools/dual-ota-flasher/config.js.
export const MESHTASTIC_REPO = { owner: "Akceptor", repo: "meshtastic_firmware", ref: "develop-2.7.26" };

// Board display label -> board key. Add an entry here (plus matching entries in
// MESHTASTIC_FIRMWARE and MESHTASTIC_CHIPS below) to support another board — no code
// changes needed.
export const MESHTASTIC_BOARDS = {
  "ESP32-C3 + LR1121": "unified_esp32c3_lr1121_rx",
  "ESP32 + LR1121": "unified_esp32_lr1121_rx",
  "ESP32 SX12xx Dual (single radio)": "esp32_sx12xx_dual_single",
};

// Board key -> esptool-js CHIP_NAME the image is built for. Connecting accepts any chip
// listed here; flashing refuses a published build whose chip doesn't match the board.
export const MESHTASTIC_CHIPS = {
  unified_esp32c3_lr1121_rx: "ESP32-C3",
  unified_esp32_lr1121_rx: "ESP32",
  esp32_sx12xx_dual_single: "ESP32",
};

// Board key -> factory-image filename pattern. The commit-hash segment varies with every
// upstream rebuild, so it's a wildcard resolved at runtime against the prebuilt/ directory
// listing (mirrors resolveMeshtasticFilename in tools/dual-ota-flasher/builder.js).
export const MESHTASTIC_FIRMWARE = {
  unified_esp32c3_lr1121_rx: "firmware-unified_esp32c3_lr1121_rx-2.7.26.*.factory.bin",
  unified_esp32_lr1121_rx: "firmware-unified_esp32_lr1121_rx-2.7.26.*.factory.bin",
  esp32_sx12xx_dual_single: "firmware-esp32_sx12xx_dual_single-2.7.26.*.factory.bin",
};
