# Meshtastic firmware option for EMAX 900 OLED TX

Date: 2026-08-07

## Goal

Let users flash Meshtastic app-only ("OTA") firmware onto an EMAX 900 OLED TX
board from the existing ELRS Dual-OTA web flasher (`tools/dual-ota-flasher/`),
without building a separate tool. The option must only be reachable for this
one board — no generic "flash any Meshtastic firmware" UI.

## Non-goals

- Building Meshtastic firmware in CI. Both binaries already exist and are
  published at
  `https://github.com/Akceptor/meshtastic_firmware/tree/develop-2.7.26/prebuilt`.
- Factory/full-image flashing (offset `0x0`, erases config, needs bootloader +
  partition table). Only the app-only `.ota.bin` images (offset `0x10000`) are
  exposed, per the source repo's own flashing docs.
- Any new device picker. The existing `bld-device` cascading selector
  (Vendor → Type → Device) is not reused for this path at all — see below.

## Gate: version, not device picker

`bld-version` already has non-ELRS entries (`rnode`) that hide the ELRS
vendor/category/device/domain/phrase fields and show a board-specific field
group instead. Meshtastic follows the same pattern: add a `"meshtastic"` key
to `BRANCHES` in `config.js`. Picking it *is* the "my TX is EMAX 900 OLED TX"
confirmation — there is nothing else it could mean, since only one board's
binaries are offered.

`onVersionChange()` in `builder.js` extends from a boolean (rnode vs elrs) to
a three-way switch: hide `#elrs-fields` whenever version is `rnode` or
`meshtastic`; show `#rnode-fields` only for `rnode`; show a new
`#meshtastic-fields` only for `meshtastic`.

## New fields

`#meshtastic-fields` (sibling of `#elrs-fields` / `#rnode-fields` in
`index.html`), containing one select, `#bld-meshtastic-sync`:

- `0x2b — stock Meshtastic (talks to any stock node)` — **default/selected**
- `0x12 — LR11xx-compatible (all mesh nodes must use this override)`

When `0x12` is selected, show an inline `.warn` block (existing CSS class)
with the compatibility note, condensed from `firmware/prebuilt/README.md`:

> Nodes flashed with `0x12` cannot talk to stock Meshtastic nodes. Every
> node in the mesh must use this same override. Only needed if your mesh
> includes LR1121/LR1110/LR1120 hardware.

The existing `#bld-slot` select (app0 / app1) stays visible and applies
unchanged — same as it already does for `rnode`.

## Fetching + staging

New raw-URL builder in `builder.js`, parallel to the existing `FIRMWARE_RAW`:

```js
const MESHTASTIC_REPO = { owner: "Akceptor", repo: "meshtastic_firmware", ref: "develop-2.7.26" };
const MESHTASTIC_RAW = (file) =>
  `https://raw.githubusercontent.com/${MESHTASTIC_REPO.owner}/${MESHTASTIC_REPO.repo}/${MESHTASTIC_REPO.ref}/${encPath(`prebuilt/${file}`)}`;
```

`config.js` gets a small map from sync-word select value to filename:

```js
export const MESHTASTIC_FIRMWARE = {
  "0x2b": "firmware-emax_900_tx_oled-2.7.26.8f1666d-sync0x2b.ota.bin",
  "0x12": "firmware-emax_900_tx_oled-2.7.26.8f1666d-sync0x12.ota.bin",
};
```

`prepareAndStage()` gets a third branch (`versionLabel === "meshtastic"`):
fetch `MESHTASTIC_RAW(MESHTASTIC_FIRMWARE[syncSelectValue])`, use the bytes
as-is (no `appendConfig` — that step is ELRS-specific config-block
injection and doesn't apply to Meshtastic images), `fetchLabel = "Meshtastic ·
sync " + syncSelectValue`. The result is stored in the same `staged[slot]`
shape (`{ bytes, label }`) already used by ELRS/rnode staging, so Step 3's
existing "Update app0/app1 in place" and "Provision both slots" buttons work
against it with no changes.

## Error handling

Same as the existing ELRS/rnode fetch path: on non-200, surface
`firmware HTTP ${res.status}` via `setStatus` + `log`. No new error handling
needed — 404s, network failures, etc. are already handled generically in
`prepareAndStage()`'s try/catch.

## Testing

`test/targets.test.mjs` / `test/configure.test.mjs` cover ELRS-specific pure
functions and are unaffected. No new pure-function logic is introduced here
beyond the filename lookup map, which doesn't warrant a dedicated test file —
it's exercised via manual verification (stage each sync word, confirm byte
length matches the known `.ota.bin` size of 1,656,944 bytes, confirm write to
0x10000 on real hardware).
