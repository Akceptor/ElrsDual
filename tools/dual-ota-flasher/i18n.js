// Minimal i18n for the static page chrome. Elements carry data-i18n (textContent),
// data-i18n-html (innerHTML, for strings with <b>/<code>/<i>) or data-i18n-ph (placeholder).
// The JS log/status messages in flasher.js/builder.js stay in English (technical output).
const STR = {
  en: {
    lede: 'Put <b>two</b> firmwares — ELRS or RNode — on one ESP32 at once and switch between them. Chrome or Edge only.',
    video_h: 'How it works (video)',
    unsupported: '⚠️ Web Serial isn\'t available in this browser. Use <b>Chrome</b> or <b>Edge</b> over <code>https</code> (or <code>http://localhost</code>).',
    step1_h: 'Configure firmware',
    step1_desc: 'Pick a firmware + board. For ELRS, also set the region and optional bind phrase — configuration happens <b>in your browser</b> (bind phrase never leaves this page).',
    lbl_version: 'Version', lbl_vendor: 'Vendor', lbl_type: 'Type', lbl_device: 'Device', lbl_domain: 'Region/domain',
    lbl_phrase: 'Bind phrase', ph_phrase: 'optional — stays local', lbl_slot: 'Stage into slot',
    lbl_rnode_board: 'Board',
    btn_getstage: 'Get & stage',
    info1: '<b>Two slots, kept side by side.</b> Staging v3 into app0 and v4 into app1 does <b>not</b> erase the other — both firmwares live on the board and you choose which one boots (Step 3 → <i>Active slot</i>, or 3 quick power-cycles with the slot-switch bootloader). Stage one slot to keep the other untouched, or stage <b>both</b> to load v3 and v4 together.',
    step2_h: 'Connect your board',
    step2_desc: 'Plug the board in over USB and connect. Hold <b>BOOT</b> while connecting if it won\'t sync. Flashing tools unlock once connected.',
    lbl_baud: 'Baud', btn_connect: 'Connect', btn_disconnect: 'Disconnect', btn_detect: 'Detect target',
    detect_hint: '“Detect target” reads firmware already on the board and pre-selects it below (won\'t work on an empty/stock board).',
    step3_h: 'Flash to the board',
    grp_cloud_h: 'Flash the firmware you staged (from the cloud)',
    grp_cloud_small: 'Use these after Step 1.',
    btn_provision_both: 'Provision both slots (fresh board)',
    use_slotsw: 'Install slot-switch bootloader (3 power-cycles switch slots)',
    btn_update0: 'Update app0 (v3.x) in place', btn_update1: 'Update app1 (v4.x) in place',
    info3: '<b>Provision both</b> sets up a new/stock board — it writes the bootloader, partition table and both slots (needs both v3 and v4 staged), then boots app0. <b>Update appN</b> replaces just that one version, leaving the other slot, the bootloader and the active-slot choice untouched.',
    adv_local_sum: 'Advanced — flash your own local <code>.bin</code> files',
    lbl_v3file: 'v3.x image (→ app0):', lbl_v4file: 'v4.x image (→ app1):',
    btn_flash_both: '⚡ Flash both slots (full provision)', btn_flash0: '⚡ Flash app0 only', btn_flash1: '⚡ Flash app1 only',
    adv_local_small: 'For images you configured yourself with the ELRS Configurator / official web flasher.',
    adv_read_sum: 'Read firmware back from a slot',
    btn_read0: '📥 Read app0 (v3.x)', btn_read1: '📥 Read app1 (v4.x)',
    adv_read_small: 'Downloads the full slot to a <code>.bin</code> (≈1 min each).',
    tools: 'Tools',
    slotsw_h: 'Slot switcher',
    slotsw_desc: 'Choose which firmware boots. <i>Read active</i> shows the current one.',
    btn_readactive: 'Read active', btn_setslot: 'Set active + reboot',
    bootl_h: 'Slot-switch bootloader',
    bootl_desc: 'Installs a custom second-stage bootloader (to <code>0x1000</code> only; app slots untouched). Then <b>3 quick power-cycles</b> (each off/on within ~2&nbsp;s) flip the active slot — no computer needed. Normal boots wait ~2&nbsp;s. 4&nbsp;MB ESP32 / min_spiffs.',
    btn_flashboot: 'Flash slot-switch bootloader (0x1000)',
    rnode_provision_h: 'RNode Provision',
    rnode_provision_desc: 'Write EEPROM identity + radio config to a freshly flashed RNode device. Opens a second serial port — connect the board again when prompted.',
    lbl_rnode_band: 'Band',
    rnode_band_433: '433 MHz',
    rnode_band_868: '868 / 915 MHz',
    btn_provision_rnode: 'Provision RNode (~14 s)',
    log: 'Log',
    mm_title: 'ESP32 flash map',
    mm_caption: '“On board / active” reflect what you do in this session (and Read active); the tool doesn\'t auto-read the chip.',
    mm_bootloader: 'Bootloader', mm_parttable: 'Partition table', mm_nvs: 'NVS settings',
    mm_otadata: 'OTA data', mm_spiffs: 'SPIFFS / filesystem',
    mm_nvs_note: 'your saved settings — left untouched', mm_otadata_note: 'which slot boots',
    mm_stock: 'stock', mm_custom: 'custom (slot-switch)', mm_unknown: '—',
    mm_staged: 'staged:', mm_onboard: 'on board:', mm_active: 'ACTIVE',
    theme_label: 'Theme', theme_light: 'Light', theme_dark: 'Dark', theme_auto: 'Auto',
    join: '▶  Join my YouTube channel',
    explainer: '🎬  Watch the full video explainer',
  },
  uk: {
    lede: 'Запишіть на один ESP32 одразу <b>дві</b> прошивки — ELRS або RNode — і перемикайтесь між ними. Лише Chrome або Edge.',
    video_h: 'Як це працює (відео)',
    unsupported: '⚠️ Web Serial недоступний у цьому браузері. Використовуйте <b>Chrome</b> або <b>Edge</b> через <code>https</code> (або <code>http://localhost</code>).',
    step1_h: 'Налаштування прошивки',
    step1_desc: 'Оберіть прошивку та плату. Для ELRS також вкажіть регіон і бінд фразу — персоналізація відбувається <b>у вашому браузері</b> (бінд фраза не залишає цю сторінку).',
    lbl_version: 'Версія', lbl_vendor: 'Виробник', lbl_type: 'Тип', lbl_device: 'Пристрій', lbl_domain: 'Регіон/домен',
    lbl_phrase: 'Бінд Фраза', ph_phrase: 'необов\'язково — лишається локально', lbl_slot: 'Записати у слот',
    lbl_rnode_board: 'Плата',
    btn_getstage: 'Отримати і підготувати',
    info1: '<b>Два слоти, що зберігаються поруч.</b> Запис v3 у app0 та v4 у app1 <b>не</b> стирає інший — обидві прошивки лишаються на платі, і ви обираєте, яка завантажується (Крок 3 → <i>Активний слот</i>, або 3 швидкі перезавантаження живлення зі спеціальним завантажувачем). Підготуйте один слот, щоб не чіпати інший, або підготуйте <b>обидва</b>, щоб завантажити v3 і v4 разом.',
    step2_h: 'Підключіть плату',
    step2_desc: 'Під\'єднайте плату через USB і натисніть «Підключити». Утримуйте <b>BOOT</b> під час підключення, якщо не синхронізується. Інструменти прошивки розблокуються після підключення.',
    lbl_baud: 'Швидкість', btn_connect: 'Підключити', btn_disconnect: 'Відключити', btn_detect: 'Визначити плату',
    detect_hint: '«Визначити плату» зчитує наявну на платі прошивку й попередньо обирає її нижче (не працює на порожній/стоковій платі).',
    step3_h: 'Прошивка плати',
    grp_cloud_h: 'Прошити підготовлену прошивку (з хмари)',
    grp_cloud_small: 'Використовуйте після Кроку 1.',
    btn_provision_both: 'Записати обидва слоти (нова плата)',
    use_slotsw: 'Встановити завантажувач перемикання (3 перезавантаження = зміна слота)',
    btn_update0: 'Оновити app0 (v3.x) на місці', btn_update1: 'Оновити app1 (v4.x) на місці',
    info3: '<b>Записати обидва</b> налаштовує нову/чисту плату — записує завантажувач, таблицю розділів і обидва слоти (потрібні і v3, і v4), потім завантажує app0. <b>Оновити appN</b> замінює лише цю версію, не чіпаючи інший слот, завантажувач і вибір активного слота.',
    adv_local_sum: 'Розширено — прошити власні локальні файли <code>.bin</code>',
    lbl_v3file: 'Образ v3.x (→ app0):', lbl_v4file: 'Образ v4.x (→ app1):',
    btn_flash_both: '⚡ Прошити обидва слоти (повне налаштування)', btn_flash0: '⚡ Прошити лише app0', btn_flash1: '⚡ Прошити лише app1',
    adv_local_small: 'Для образів, які ви налаштували самостійно в ELRS Configurator / офіційному веб-флешері.',
    adv_read_sum: 'Зчитати прошивку зі слота',
    btn_read0: '📥 Зчитати app0 (v3.x)', btn_read1: '📥 Зчитати app1 (v4.x)',
    adv_read_small: 'Завантажує весь слот у файл <code>.bin</code> (≈1 хв кожен).',
    tools: 'Інструменти',
    slotsw_h: 'Перемикач слотів',
    slotsw_desc: 'Оберіть, яка прошивка завантажується. <i>Зчитати активний</i> показує поточну.',
    btn_readactive: 'Зчитати активний', btn_setslot: 'Зробити активним + перезавантажити',
    bootl_h: 'Завантажувач перемикання слотів',
    bootl_desc: 'Встановлює власний завантажувач другого рівня (лише в <code>0x1000</code>; слоти застосунків не чіпаються). Після цього <b>3 швидкі перезавантаження живлення</b> (кожне off/on протягом ~2&nbsp;с) перемикають активний слот — без комп\'ютера. Звичайне завантаження чекає ~2&nbsp;с. 4&nbsp;МБ ESP32 / min_spiffs.',
    btn_flashboot: 'Прошити завантажувач перемикання слотів (0x1000)',
    rnode_provision_h: 'Провізія RNode',
    rnode_provision_desc: 'Записує ідентифікацію + конфіг радіо в EEPROM щойно прошитого пристрою RNode. Відкриє другий серійний порт — підʼєднайте плату знову за запитом.',
    lbl_rnode_band: 'Діапазон',
    rnode_band_433: '433 МГц',
    rnode_band_868: '868 / 915 МГц',
    btn_provision_rnode: 'Провізія RNode (~14 с)',
    log: 'Журнал',
    mm_title: 'Карта пам\'яті ESP32',
    mm_caption: '«На платі / активний» відображають ваші дії в цій сесії (та «Зчитати активний»); інструмент не зчитує чип автоматично.',
    mm_bootloader: 'Завантажувач', mm_parttable: 'Таблиця розділів', mm_nvs: 'Налаштування NVS',
    mm_otadata: 'OTA-дані', mm_spiffs: 'SPIFFS / файлова система',
    mm_nvs_note: 'ваші збережені налаштування — не змінюються', mm_otadata_note: 'який слот завантажується',
    mm_stock: 'стандартний', mm_custom: 'власний (перемикач)', mm_unknown: '—',
    mm_staged: 'підготовлено:', mm_onboard: 'на платі:', mm_active: 'АКТИВНИЙ',
    theme_label: 'Тема', theme_light: 'Світла', theme_dark: 'Темна', theme_auto: 'Авто',
    join: '▶  Приєднатися до мого каналу YouTube',
    explainer: '🎬  Переглянути повне відеопояснення',
  },
};

let cur = "en";

function apply(lang) {
  cur = STR[lang] ? lang : "en";
  const dict = STR[cur];
  document.documentElement.lang = cur;
  for (const el of document.querySelectorAll("[data-i18n]")) {
    const v = dict[el.getAttribute("data-i18n")]; if (v != null) el.textContent = v;
  }
  for (const el of document.querySelectorAll("[data-i18n-html]")) {
    const v = dict[el.getAttribute("data-i18n-html")]; if (v != null) el.innerHTML = v;
  }
  for (const el of document.querySelectorAll("[data-i18n-ph]")) {
    const v = dict[el.getAttribute("data-i18n-ph")]; if (v != null) el.placeholder = v;
  }
  for (const el of document.querySelectorAll("[data-i18n-title]")) {
    const v = dict[el.getAttribute("data-i18n-title")]; if (v != null) el.title = v;
  }
  const btn = document.getElementById("lang-toggle");
  if (btn) btn.textContent = cur === "uk" ? "🇺🇦 UA" : "🇬🇧 EN";
}

function init() {
  const saved = localStorage.getItem("lang");
  const lang = saved || ((navigator.language || "en").toLowerCase().startsWith("uk") ? "uk" : "en");
  const btn = document.getElementById("lang-toggle");
  if (btn) btn.addEventListener("click", () => {
    const next = cur === "en" ? "uk" : "en";
    localStorage.setItem("lang", next);
    apply(next);
  });
  apply(lang);
}

// Let other modules (memmap.js) re-apply translations after they change data-i18n attrs.
window.i18nRefresh = () => apply(cur);

if (document.readyState !== "loading") init();
else document.addEventListener("DOMContentLoaded", init);
