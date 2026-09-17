// Static flash-map diagram for the ESP32-C3 partition layout, derived from
// firmware/variants/esp32c3/unified_esp32c3_lr1121_rx/partitions-dual.csv. Unlike the
// dual-OTA flasher's memmap.js, there's no "active slot" concept here — this is a
// single-slot flash, so cells just flip to "written" once flashed.
const PARTITIONS = [
  { id: "bootloader", label: "Bootloader",       addr: "0x1000",   size: null,      kind: "narrow" },
  { id: "parttable",  label: "Partition table",  addr: "0x8000",   size: null,      kind: "narrow" },
  { id: "nvs",        label: "NVS",              addr: "0x9000",   size: "20K",     kind: "narrow" },
  { id: "otadata",    label: "OTA data",         addr: "0xe000",   size: "8K",      kind: "narrow" },
  { id: "ota_0",      label: "ota_0 (Meshtastic)", addr: "0x10000", size: "1.875M", kind: "slot" },
  { id: "ota_1",      label: "ota_1 (unused)",   addr: "0x1f0000", size: "1.875M",  kind: "free" },
  { id: "spiffs",     label: "SPIFFS / LittleFS", addr: "0x3d0000", size: "128K",   kind: "free" },
  { id: "slotctr",    label: "slotctr",          addr: "0x3f0000", size: "4K",      kind: "narrow" },
];

// Written by a standalone Meshtastic factory-image flash at 0x0: the image itself
// contains bootloader + partition table + app, so those three cells light up together.
const WRITTEN_BY_FACTORY_FLASH = ["bootloader", "parttable", "ota_0"];

const TOOLTIPS = {
  ota_1: "Free — this is ExpressLRS's own min_spiffs layout, so ota_1 is reserved for a possible future ExpressLRS/Meshtastic dual-boot setup. Untouched by this page.",
  slotctr: "Where ElrsDual's slot-switch bootloader keeps its power-cycle counter (SS_CTR_OFFSET in bootloader-slot-switch/bootloader_components/slot_switch/hook.c). Untouched by this page.",
  nvs: "Erased (not written) if you check \"Erase the whole chip first\".",
  otadata: "Erased (not written) if you check \"Erase the whole chip first\".",
};

function render() {
  const mm = document.getElementById("mm");
  if (!mm) return;
  mm.innerHTML = PARTITIONS.map((p) => {
    const cls = ["mm-cell", p.kind === "slot" ? "slot" : p.kind === "free" ? "free" : "narrow"];
    const title = TOOLTIPS[p.id] || "";
    return `<div class="${cls.join(" ")}" id="mm-cell-${p.id}" ${title ? `title="${title}"` : ""}>
      <span class="mm-vlabel">${p.label}</span>
      <span class="mm-addr">${p.addr}</span>
      ${p.size ? `<span class="mm-size">${p.size}</span>` : ""}
      <span class="mm-badge" id="mm-badge-${p.id}">WRITTEN</span>
    </div>`;
  }).join("");
}

export function markFlashed() {
  for (const id of WRITTEN_BY_FACTORY_FLASH) {
    document.getElementById(`mm-cell-${id}`)?.classList.add("written");
    document.getElementById(`mm-badge-${id}`)?.classList.add("show");
  }
}

export function resetMap() {
  for (const p of PARTITIONS) {
    document.getElementById(`mm-cell-${p.id}`)?.classList.remove("written");
    document.getElementById(`mm-badge-${p.id}`)?.classList.remove("show");
  }
}

render();
