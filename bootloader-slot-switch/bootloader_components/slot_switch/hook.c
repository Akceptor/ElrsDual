#include "bootloader_flash_priv.h"  // bootloader_flash_read/write/erase_sector
#include "bootloader_common.h"      // bootloader_common_ota_select_crc/valid
#include "esp_flash_partitions.h"   // esp_ota_select_entry_t
#include "esp_rom_sys.h"            // esp_rom_delay_us
#include "esp_log.h"
#include <stdint.h>
#include <string.h>

static const char *TAG = "slot_switch";

// Fixed offsets (match partitions.csv / real min_spiffs).
#define SS_CTR_OFFSET     0x3F0000u  // slotctr partition
#define SS_OTADATA_OFFSET 0x00E000u  // otadata partition
#define SS_SECTOR_SIZE    0x1000u
#define SS_NUM_OTA        2u
#define SS_THRESHOLD      3u         // power cycles within the settle window to switch
#define SS_SETTLE_MS      2000u      // bootloader-provided "rapid" window

// Anchor symbol forces the linker to keep this (otherwise-weak) hook object.
void bootloader_hooks_include(void) {}
void bootloader_before_init(void) {}

// ---- power-cycle counter (slotctr sector; erased flash 0xFFFFFFFF == 0) ----
static uint32_t ctr_read(void) {
    uint32_t v = 0xFFFFFFFFu;
    bootloader_flash_read(SS_CTR_OFFSET, &v, sizeof(v), false);
    return (v == 0xFFFFFFFFu) ? 0u : v;
}
static void ctr_write(uint32_t v) {
    bootloader_flash_erase_sector(SS_CTR_OFFSET / SS_SECTOR_SIZE);
    if (v != 0u) bootloader_flash_write(SS_CTR_OFFSET, &v, sizeof(v), false);
}

static void settle_delay_ms(uint32_t ms) {
    for (uint32_t i = 0; i < ms; i++) esp_rom_delay_us(1000);
}

// ---- otadata flip: select the other OTA slot for THIS boot ----
// Runs in bootloader_after_init(), before partition selection, so the rewritten
// otadata takes effect immediately. Returns the new target slot (0/1).
static int ss_flip_otadata(void) {
    esp_ota_select_entry_t e0 = {0}, e1 = {0};
    bootloader_flash_read(SS_OTADATA_OFFSET, &e0, sizeof(e0), false);
    bootloader_flash_read(SS_OTADATA_OFFSET + SS_SECTOR_SIZE, &e1, sizeof(e1), false);

    uint32_t s0 = bootloader_common_ota_select_valid(&e0) ? e0.ota_seq : 0u;
    uint32_t s1 = bootloader_common_ota_select_valid(&e1) ? e1.ota_seq : 0u;
    uint32_t maxseq = (s0 > s1) ? s0 : s1;
    uint32_t cur = (maxseq == 0u) ? 0u : ((maxseq - 1u) % SS_NUM_OTA);
    uint32_t tgt = (cur + 1u) % SS_NUM_OTA;

    // Choose a new seq greater than both that selects `tgt`.
    uint32_t nseq = maxseq + 1u;
    if (((nseq - 1u) % SS_NUM_OTA) != tgt) nseq++;

    // Write into the inactive otadata sector (wear alternation).
    uint32_t sec = (s0 >= s1) ? 1u : 0u;
    uint32_t off = SS_OTADATA_OFFSET + sec * SS_SECTOR_SIZE;

    esp_ota_select_entry_t e;
    memset(&e, 0xFF, sizeof(e));     // seq_label + ota_state left as erased/undefined
    e.ota_seq = nseq;
    e.crc = bootloader_common_ota_select_crc(&e);

    bootloader_flash_erase_sector(off / SS_SECTOR_SIZE);
    bootloader_flash_write(off, &e, sizeof(e), false);

    ESP_LOGI(TAG, "otadata flip slot %u->%u (seq %u->%u)",
             (unsigned)cur, (unsigned)tgt, (unsigned)maxseq, (unsigned)nseq);
    return (int)tgt;
}

// Flash counter + settle-window discriminator (no RTC, no app cooperation).
void bootloader_after_init(void) {
    uint32_t n = ctr_read();
    uint32_t next = n + 1u;
    ESP_LOGI(TAG, "power-cycle count=%u (was %u)", (unsigned)next, (unsigned)n);

    if (next >= SS_THRESHOLD) {
        ctr_write(0);
        ss_flip_otadata();           // takes effect this boot
        return;
    }

    ctr_write(next);
    ESP_LOGI(TAG, "settle %u ms -- power OFF now to count this cycle", (unsigned)SS_SETTLE_MS);
    settle_delay_ms(SS_SETTLE_MS);
    ctr_write(0);
    ESP_LOGI(TAG, "settled -> counter cleared, continuing normal boot");
}
