# Dual-OTA web builder + flasher

**Date:** 2026-06-16
**Status:** Approved (design)
**Targets:** ESP32 (`platform == 'esp32'`, 4 MB, min_spiffs dual-OTA) ELRS TX/RX.

## Goal

Extend the existing browser flasher (`tools/dual-ota-flasher/`) so it can **build** an
ELRS firmware image on demand — from the `v3.6.3` or `v4` branch, for a chosen ESP32
target — and flash it into the desired OTA slot, without a local toolchain. Compilation
runs in **GitHub Actions**; the browser triggers it, downloads the generic build,
configures it (target / domain / bind phrase) in-JS, and flashes it.

This mirrors the official ExpressLRS web-flasher (CI builds firmware; the browser
configures + flashes), adapted to this fork's dual-OTA (app0 = v3.x, app1 = v4.x) layout.

The builder is **purely additive**: every existing capability of `flasher.js` is retained.

## Key decisions (from brainstorming)

- **Compiler location:** GitHub Actions, **on-demand** via `workflow_dispatch` (not a
  pre-built matrix — active branches, hundreds of targets, build only what's asked).
- **Trigger:** a **Build** button in the web UI, authenticated with a user-pasted GitHub
  **PAT** (`sessionStorage`, never committed).
- **Artifact delivery:** the workflow commits the generic `firmware.bin` to a
  force-pushed orphan branch; the browser pulls it back via the **Git Blobs API**
  (`api.github.com`, base64, CORS-safe, works for private repos). This sidesteps the
  CORS wall on downloading Actions *artifacts* / Release assets from a browser.
- **Configuration:** happens **in-browser** (bind phrase never leaves the machine),
  **adapted from the official `ExpressLRS/web-flasher` JS configurator** (GPL), with
  byte-parity tests against this repo's `binary_configurator.py`.
- **Target visibility:** only `platform == 'esp32'`. `esp8285`/`stm32` excluded (no dual
  OTA); `esp32-s3`/`esp32-c3` excluded for now (bundled boot blobs are plain-ESP32).

## Architecture (3 layers)

### 1. CI build workflow — `.github/workflows/flasher-build.yml`
- Trigger: `workflow_dispatch` with inputs `{ branch: v3.6.3 | v4, env: <pio env>, run_tag }`.
  `run_tag` is a caller-supplied nonce echoed into the run name so the browser can
  correlate the dispatch to its run (workflow_dispatch returns no run id).
- Steps: checkout the branch → set up PlatformIO → `pio run -e <env>` → commit the
  **generic, unconfigured** `firmware.bin` to orphan branch
  `flasher-artifacts` at path `<branch>/<env>/firmware.bin` (force-pushed; single commit,
  no history bloat).
- No target / domain / phrase inputs — one generic bin per `{branch, env}` serves all
  targets that share that env; the browser specializes it.

### 2. Builder panel — new files in `tools/dual-ota-flasher/`
- **`github.js`** — `dispatchBuild(branch, env, runTag)`, `pollRun(runTag)` (find the run
  by matching `run_tag` in the run name, poll `conclusion`), `fetchBlob(path)` (resolve
  path → blob SHA via the trees/contents API, GET `git/blobs/{sha}` → base64 → bytes).
  All over `api.github.com` with the PAT.
- **`configure.js`** — adapted from the official web-flasher: `generateUID(phrase)`
  (digit-CSV or MD5 of `-DMY_BINDING_PHRASE="…"`), assemble `json_flags`
  (domain/wifi/tlm/rx-baud/lock/etc.), `findFirmwareEnd` (parse the ESP image header at
  `0x0`, fall back to `0x1000`, walk segments), and append the unified config block
  (product/lua name, defines JSON, the target's hardware-layout JSON, discriminator).
  The one piece with **automated tests**.
- **`builder.js`** — orchestrates the panel: load + filter `targets.json` (ESP32 only),
  map target → env (read the target's `firmware` field, append `_via_UART`), drive
  dispatch → poll → fetch → configure, then **stage** the configured bin into app0 or
  app1 and hand off to `flasher.js`.

### 3. Existing flasher core — `flasher.js` (unchanged behavior)
Slot placement + Web Serial logic is reused as-is. The builder feeds it a configured
`ArrayBuffer` + a target slot; existing buttons keep accepting a **local file** too.

## Data flow

```
UI {branch, env, runTag} ──PAT──> workflow_dispatch ──> Actions: pio run
                                          └─> commit generic firmware.bin → flasher-artifacts
UI pollRun(runTag) (api.github.com) ──> success ──> fetchBlob → base64 → bytes (generic bin)
fetch targets.json + layout JSON (raw.githubusercontent, CORS *) 
   ──> configure.js (UID / domain / layout / defines) ──> configured bin
   ──> stage → app0 | app1 ──> flasher.js writeFlash
```

## UI

A new **Build** section is added above the existing controls. Layout (see
`tools/dual-ota-flasher/ui-mockup.html` for the clickable draft):

```
┌───────────────────────────────────────────────────────────────┐
│ Dual-OTA Builder + Flasher                                      │
├───────────────────────────────────────────────────────────────┤
│ GitHub token  [ ghp_******************** ]  (stored in session) │
├───────────────────────────────────────────────────────────────┤
│ BUILD                                                           │
│  Version   ( ) v3.6.3   (•) v4                                  │
│  Target    [ radiomaster.tx_dual.tx15            ▾ ] ESP32 only │
│  Domain    [ eu_868 ▾ ]    Bind phrase [ ............ ] (local) │
│  Slot      ( ) app0 (v3.x)   (•) app1 (v4.x)                    │
│  [ Build & stage → app1 ]            status: building… ⏳ (2:14) │
│  Staged:  app0 = (none)        app1 = v4 tx15 eu_868 ✓          │
├───────────────────────────────────────────────────────────────┤
│ FLASH (existing)                                                │
│  [ Connect ]   chip: ESP32-D0WD  MAC: …                         │
│  app0 image [ file… | staged ]   app1 image [ file… | staged ]  │
│  [ Flash both ] [ Flash app0 only ] [ Flash app1 only ]         │
│  [ Flash slot-switch bootloader (0x1000) ]                      │
│  [ Read app0 ] [ Read app1 ] [ Show active slot ] [ Set active ]│
├───────────────────────────────────────────────────────────────┤
│ Log                                                             │
│  …                                                              │
└───────────────────────────────────────────────────────────────┘
```

Each slot's image source is **file** (existing) or **staged** (freshly built). "Build &
stage" fills the staged slot; the existing Flash buttons then write file-or-staged.

## Error handling

- No / invalid PAT, or PAT missing `actions:write` → inline message; no dispatch.
- Build failure or timeout (poll cap ~15 min) → show run `conclusion` + link to the run.
- Blob fetch failure (CORS / scope / missing branch) → explicit message.
- Config errors (bad phrase format, unknown target/layout) → caught before flashing.
- All operations re-enable controls in a `finally` (existing pattern preserved).

## Testing / verification

- **Automated (`configure.js`):** Node test configures a known `firmware.bin` in JS and
  diffs the bytes against `python/binary_configurator.py` output for identical inputs
  (target, domain, phrase). Byte-parity is the pass condition.
- **Manual e2e** on the tx15 / LiLiGo board: build v4 → stage app1 → flash; build v3 →
  stage app0 → flash; verify boot, WebUI version selector, and slot switching.

## Scope / out of scope

- **In:** Build section UI, `flasher-build.yml`, `github.js`, `configure.js` (with
  byte-parity tests), ESP32-only target filtering, staging into the existing flash paths.
- **Out:** `esp32-s3` / `esp32-c3` / `esp8285` / `stm32`; building uncommitted local
  changes (CI builds pushed branch HEAD — push first); a no-token manual-trigger mode;
  pre-built matrix; changing the bundled bootloader/partition blobs.

## PR

Implemented on a branch off `dual-ota-flasher`, opened as its own PR. Tool stays generic
and in the main tree, not the per-version branches.
