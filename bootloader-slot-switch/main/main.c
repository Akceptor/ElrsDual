#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_ota_ops.h"
#include "esp_log.h"

// Bring-up app: reports which OTA slot it is running from, so a slot switch is
// visible in the log. The same binary is flashed to both ota_0 and ota_1;
// esp_ota_get_running_partition() reports the actual slot.
void app_main(void) {
    const esp_partition_t *p = esp_ota_get_running_partition();
    for (;;) {
        ESP_LOGI("APP", "RUNNING from slot '%s' @ 0x%06lx",
                 p ? p->label : "?", (unsigned long)(p ? p->address : 0));
        vTaskDelay(pdMS_TO_TICKS(1000));
    }
}
