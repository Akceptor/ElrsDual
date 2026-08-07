// Static config for the public builder. Safe to serve publicly (no secrets, no token).
export const REPO = detectRepo();

// Pre-built generic firmware lives on this public branch of REPO, fetched via raw:
//   raw.githubusercontent.com/<owner>/<repo>/<ARTIFACT_BRANCH>/<version>/<env>/firmware.bin
// (Populated by .github/workflows/flasher-prebuild.yml — no slash in the branch name, so
// raw resolves it and no token is needed.)
export const ARTIFACT_BRANCH = "flasher-artifacts";

// Target/layout definitions come from the public ExpressLRS targets repo (this is what
// src/hardware is a clone of). Public, default branch, no slash → raw works token-free.
export const TARGETS = { owner: "ExpressLRS", repo: "targets", ref: "master" };

// UI version labels -> the firmware branch the prebuild workflow compiles. The browser
// uses the label as the artifact path segment; the workflow uses the ref to checkout.
export const BRANCHES = {
  "v4.0.1": "lua-slot/v4",
  "v3.6.3": "lua-slot/v3.6.3",
  "rnode":  null,   // built from Akceptor/RNode_Firmware, not this repo
  "meshtastic": null,   // pre-built binaries from Akceptor/meshtastic_firmware, not this repo
};

// Board display label → CI artifact subdirectory (arduino-cli board short-name). Must stay in sync with build-rnode job in flasher-prebuild.yml.
export const RNODE_BOARDS = {
  "LilyGo LoRa32 v2.1 (SX1276 / 433–915 MHz)": "lora32_v21",
};

// Pre-built Meshtastic app-only ("OTA") firmware.
// Published at https://github.com/Akceptor/meshtastic_firmware/tree/develop-2.7.26/prebuilt
export const MESHTASTIC_REPO = { owner: "Akceptor", repo: "meshtastic_firmware", ref: "develop-2.7.26" };

// Board display label -> board key. Add an entry here (plus a matching entry in
// MESHTASTIC_FIRMWARE below) to support another board — no code changes needed.
export const MESHTASTIC_BOARDS = {
  "EMAX 900 OLED TX": "emax_900_tx_oled",
};

// Board key -> sync-word select value -> prebuilt firmware filename.
export const MESHTASTIC_FIRMWARE = {
  emax_900_tx_oled: {
    "0x2b": "firmware-emax_900_tx_oled-2.7.26.8f1666d-sync0x2b.ota.bin",
    "0x12": "firmware-emax_900_tx_oled-2.7.26.8f1666d-sync0x12.ota.bin",
  },
};

export const DOMAINS = ["eu_868", "fcc_915", "au_915", "in_866", "au_433", "eu_433", "us_433", "us_433_wide"];

// Owner/repo for the pre-built firmware (raw.githubusercontent.com).
// On *.github.io this is inferred from the URL; override the fallback for local serving.
function detectRepo() {
  const host = (typeof location !== "undefined" && location.hostname) || "";
  if (host.endsWith(".github.io")) {
    const owner = host.replace(".github.io", "");
    const repo = (location.pathname.split("/").filter(Boolean)[0]) || `${owner}.github.io`;
    return { owner, repo };
  }
  return { owner: "Akceptor", repo: "ElrsDual" }; // fallback for localhost; edit if forked
}
