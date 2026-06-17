// Live ESP32 flash-map widget. Listens for `memmap` CustomEvents from flasher.js/builder.js
// and reflects them in the diagram. "On board / active" track what you do in this session
// (plus Read active); the tool does not auto-read the chip.
const $ = (id) => document.getElementById(id);

function setActive(slot) {
  $("mm-row-0")?.classList.toggle("mm-active", slot === 0);
  $("mm-row-1")?.classList.toggle("mm-active", slot === 1);
  $("mm-badge-0")?.classList.toggle("show", slot === 0);
  $("mm-badge-1")?.classList.toggle("show", slot === 1);
}

document.addEventListener("memmap", (e) => {
  const d = e.detail || {};
  if (d.type === "staged") {
    const el = $("mm-staged-" + d.slot);
    if (el) { el.textContent = d.label; el.classList.add("set"); }
  } else if (d.type === "flashed") {
    const el = $("mm-board-" + d.slot);
    if (el) { el.textContent = d.label || "written"; el.classList.add("set"); }
  } else if (d.type === "active") {
    setActive(d.slot);
  } else if (d.type === "bootloader") {
    const el = $("mm-bootloader-state");
    if (el) {
      el.setAttribute("data-i18n", d.value === "custom" ? "mm_custom" : "mm_stock");
      el.classList.toggle("custom", d.value === "custom");
      window.i18nRefresh?.();   // re-translate the new label in the current language
    }
  }
});
