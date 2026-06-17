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
      // Icon + tooltip instead of a long text pill (too wide for the narrow cell).
      el.textContent = d.value === "custom" ? "🔁" : d.value === "stock" ? "▪" : "—";
      el.setAttribute("data-i18n-title", d.value === "custom" ? "mm_custom" : d.value === "stock" ? "mm_stock" : "mm_unknown");
      window.i18nRefresh?.();   // apply the tooltip in the current language
    }
    $("mm-cell-boot")?.classList.toggle("custom", d.value === "custom");
  }
});
