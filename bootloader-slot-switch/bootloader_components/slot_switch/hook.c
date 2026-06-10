#include "bootloader_flash_priv.h"  // bootloader_flash_read/write/erase_sector
#include "esp_rom_sys.h"            // esp_rom_delay_us
#include "esp_log.h"
#include <stdint.h>

static const char *TAG = "slot_switch";

// `slotctr` partition offset from partitions.csv (bring-up table).
#define SS_CTR_OFFSET   0x100000u
#define SS_SECTOR_SIZE  0x1000u
#define SS_THRESHOLD    3u          // power cycles within the settle window to switch
#define SS_SETTLE_MS    2000u       // bootloader-provided "rapid" window

// Anchor symbol forces the linker to keep this (otherwise-weak) hook object.
void bootloader_hooks_include(void) {}
void bootloader_before_init(void) {}

// Read the persisted counter (erased flash 0xFFFFFFFF == 0).
static uint32_t ctr_read(void) {
    uint32_t v = 0xFFFFFFFFu;
    bootloader_flash_read(SS_CTR_OFFSET, &v, sizeof(v), false);
    return (v == 0xFFFFFFFFu) ? 0u : v;
}

// Persist the counter. Erase first (flash write only clears bits); value 0 is
// left as the erased state to save a write.
static void ctr_write(uint32_t v) {
    bootloader_flash_erase_sector(SS_CTR_OFFSET / SS_SECTOR_SIZE);
    if (v != 0u) {
        bootloader_flash_write(SS_CTR_OFFSET, &v, sizeof(v), false);
    }
}

static void settle_delay_ms(uint32_t ms) {
    for (uint32_t i = 0; i < ms; i++) {
        esp_rom_delay_us(1000);
    }
}

// Flash counter + settle-window discriminator (no RTC, no app cooperation):
//  - rapid cycle: user powers off DURING the settle wait, before the reset -> counts.
//  - normal boot: runs past the wait, counter is cleared -> never accumulates.
void bootloader_after_init(void) {
    uint32_t n = ctr_read();
    uint32_t next = n + 1u;
    ESP_LOGI(TAG, "power-cycle count=%u (was %u)", (unsigned)next, (unsigned)n);

    if (next >= SS_THRESHOLD) {
        ctr_write(0);
        ESP_LOGI(TAG, ">>> THRESHOLD reached: SWITCH slot here (Task 5 wires the flip) <<<");
        return;
    }

    ctr_write(next);
    ESP_LOGI(TAG, "settle %u ms -- power OFF now to count this cycle", (unsigned)SS_SETTLE_MS);
    settle_delay_ms(SS_SETTLE_MS);
    ctr_write(0);
    ESP_LOGI(TAG, "settled -> counter cleared, continuing normal boot");
}
