// Static config for the builder. Safe to serve publicly (no secrets).
export const REPO = detectRepo();
export const ARTIFACT_BRANCH = "flasher-artifacts";
export const BUILD_WORKFLOW = "flasher-build.yml";
// Branch that HOSTS the workflow file — this is the ref we dispatch (workflow_dispatch
// requires the file to exist on the dispatched ref). The version branch to *compile* is
// passed separately as the checkout_ref input. Set to your default branch after merge.
export const WORKFLOW_REF = "dual-ota-builder";

// branch label shown in UI -> git ref the workflow checks out
export const BRANCHES = {
  "v3.6.3": "lua-slot/v3.6.3",
  "v4": "lua-slot/v4",
};

export const DOMAINS = ["eu_868", "fcc_915", "au_915", "in_866", "au_433", "eu_433", "us_433", "us_433_wide"];

// Owner/repo for api.github.com + raw.githubusercontent.com.
// On *.github.io this is inferred; override the fallback for local serving.
function detectRepo() {
  const host = (typeof location !== "undefined" && location.hostname) || "";
  if (host.endsWith(".github.io")) {
    const owner = host.replace(".github.io", "");
    const repo = (location.pathname.split("/").filter(Boolean)[0]) || `${owner}.github.io`;
    return { owner, repo };
  }
  return { owner: "Akceptor", repo: "ElrsDual" }; // fallback for localhost; edit if forked
}
