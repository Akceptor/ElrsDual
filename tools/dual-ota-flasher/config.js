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
};

// Board display label → PlatformIO env. Must stay in sync with build-rnode matrix in flasher-prebuild.yml.
export const RNODE_BOARDS = {
  "LilyGo LoRa32 v2.1 (SX1276 / 868–915 MHz)": "lora32_v21",
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
