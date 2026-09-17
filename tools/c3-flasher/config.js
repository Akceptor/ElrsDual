// Static config for the C3 flasher. Safe to serve publicly (no secrets, no token).

// Pre-built standalone Meshtastic "factory" images (bootloader + partition table + app,
// written at 0x0) live here. Same repo/branch the dual-ota-flasher's Meshtastic OTA
// builds come from — see tools/dual-ota-flasher/config.js.
export const MESHTASTIC_REPO = { owner: "Akceptor", repo: "meshtastic_firmware", ref: "develop-2.7.26" };

// Board display label -> board key. Add an entry here (plus a matching entry in
// MESHTASTIC_FIRMWARE below) to support another board — no code changes needed.
export const MESHTASTIC_BOARDS = {
  "BAYCKRC C3 900/2400 Dual Band Nano RX": "unified_esp32c3_lr1121_rx",
};

// Board key -> factory-image filename pattern. The commit-hash segment varies with every
// upstream rebuild, so it's a wildcard resolved at runtime against the prebuilt/ directory
// listing (mirrors resolveMeshtasticFilename in tools/dual-ota-flasher/builder.js).
export const MESHTASTIC_FIRMWARE = {
  unified_esp32c3_lr1121_rx: "firmware-unified_esp32c3_lr1121_rx-2.7.26.*.factory.bin",
};
