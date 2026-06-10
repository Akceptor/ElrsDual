#include <stdio.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

// Placeholder app used only during Task 1 bring-up to prove the custom
// bootloader chainloads an application. Replaced by the real ELRS images later.
void app_main(void) {
    for (;;) {
        printf("PLACEHOLDER_APP_RUNNING\n");
        vTaskDelay(pdMS_TO_TICKS(1000));
    }
}
