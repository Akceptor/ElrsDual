#include "esp_log.h"

static const char *TAG = "slot_switch";

// Anchor symbol: forces the linker to keep this (otherwise-weak) hook object
// in the bootloader image. Required by the IDF bootloader_components mechanism.
void bootloader_hooks_include(void) {}

// The IDF second-stage bootloader calls these weak hooks during init.
// Defining them here overrides the defaults.
// Task 1: prove the component links and the hook actually runs on hardware.
void bootloader_before_init(void) {}

void bootloader_after_init(void) {
    ESP_LOGI(TAG, "slot_switch hook alive");
}
