#include "elrs_eeprom.h"
#include "targets.h"
#include "logging.h"

#if !defined(TARGET_NATIVE)

#if defined(PLATFORM_ESP32)

#include <nvs_flash.h>
#include <nvs.h>
#include <esp_ota_ops.h>
#include <string.h>

static uint8_t eeprom_buf[RESERVED_EEPROM_SIZE];
static nvs_handle_t eeprom_nvs_handle;

static const char* nvsEepromNamespace()
{
    const esp_partition_t *p = esp_ota_get_running_partition();
    return (p && p->subtype == ESP_PARTITION_SUBTYPE_APP_OTA_1) ? "eeprom_1" : "eeprom_0";
}

void
ELRS_EEPROM::Begin()
{
    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND)
    {
        nvs_flash_erase();
        nvs_flash_init();
    }
    nvs_open(nvsEepromNamespace(), NVS_READWRITE, &eeprom_nvs_handle);
    memset(eeprom_buf, 0xFF, sizeof(eeprom_buf));
    size_t len = sizeof(eeprom_buf);
    nvs_get_blob(eeprom_nvs_handle, "data", eeprom_buf, &len);
}

uint8_t
ELRS_EEPROM::ReadByte(const uint32_t address)
{
    if (address >= RESERVED_EEPROM_SIZE)
    {
        ERRLN("EEPROM address is out of bounds");
        return 0;
    }
    return eeprom_buf[address];
}

void
ELRS_EEPROM::WriteByte(const uint32_t address, const uint8_t value)
{
    if (address >= RESERVED_EEPROM_SIZE)
    {
        ERRLN("EEPROM address is out of bounds");
        return;
    }
    eeprom_buf[address] = value;
}

void
ELRS_EEPROM::Commit()
{
    if (nvs_set_blob(eeprom_nvs_handle, "data", eeprom_buf, sizeof(eeprom_buf)) != ESP_OK ||
        nvs_commit(eeprom_nvs_handle) != ESP_OK)
    {
        ERRLN("EEPROM commit failed");
    }
}

#else /* !PLATFORM_ESP32 */

#include <EEPROM.h>

void
ELRS_EEPROM::Begin()
{
    EEPROM.begin(RESERVED_EEPROM_SIZE);
}

uint8_t
ELRS_EEPROM::ReadByte(const uint32_t address)
{
    if (address >= RESERVED_EEPROM_SIZE)
    {
        ERRLN("EEPROM address is out of bounds");
        return 0;
    }
    return EEPROM.read(address);
}

void
ELRS_EEPROM::WriteByte(const uint32_t address, const uint8_t value)
{
    if (address >= RESERVED_EEPROM_SIZE)
    {
        ERRLN("EEPROM address is out of bounds");
        return;
    }
    EEPROM.write(address, value);
}

void
ELRS_EEPROM::Commit()
{
    if (!EEPROM.commit())
    {
        ERRLN("EEPROM commit failed");
    }
}

#endif /* PLATFORM_ESP32 */

#endif /* !TARGET_NATIVE */