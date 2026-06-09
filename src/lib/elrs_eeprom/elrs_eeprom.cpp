#include "elrs_eeprom.h"
#include "targets.h"
#include "logging.h"

#if !defined(TARGET_NATIVE)
#if defined(PLATFORM_STM32)
    #if defined(TARGET_USE_EEPROM) && defined(USE_I2C)
        #if !defined(TARGET_EEPROM_ADDR)
            #define TARGET_EEPROM_ADDR 0x51
            #warning "!! Using default EEPROM address (0x51) !!"
        #endif

        #include <Wire.h>
        #include <extEEPROM.h>
        extEEPROM EEPROM(kbits_2, 1, 1, TARGET_EEPROM_ADDR);
    #else
        #define STM32_USE_FLASH
        #include <utility/stm32_eeprom.h>
    #endif
#elif defined(PLATFORM_ESP32)
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
#else
    #include <EEPROM.h>
#endif

void
ELRS_EEPROM::Begin()
{
#if defined(PLATFORM_STM32)
    #if defined(STM32_USE_FLASH)
        eeprom_buffer_fill();
    #else // !STM32_USE_FLASH
        // I2C initialization is the responsibility of the caller
        // e.g. Wire.begin(GPIO_PIN_SDA, GPIO_PIN_SCL);

        /* Initialize EEPROM */
        #if defined(TARGET_EEPROM_400K)
            EEPROM.begin(extEEPROM::twiClock400kHz, &Wire);
        #else
            EEPROM.begin(extEEPROM::twiClock100kHz, &Wire);
        #endif
    #endif // STM32_USE_FLASH
#elif defined(PLATFORM_ESP32)
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
#else /* ESP8266 and others */
    EEPROM.begin(RESERVED_EEPROM_SIZE);
#endif
}

uint8_t
ELRS_EEPROM::ReadByte(const uint32_t address)
{
    if (address >= RESERVED_EEPROM_SIZE)
    {
        // address is out of bounds
        ERRLN("EEPROM address is out of bounds");
        return 0;
    }
#if defined(STM32_USE_FLASH)
    return eeprom_buffered_read_byte(address);
#elif defined(PLATFORM_ESP32)
    return eeprom_buf[address];
#else
    return EEPROM.read(address);
#endif
}

void
ELRS_EEPROM::WriteByte(const uint32_t address, const uint8_t value)
{
    if (address >= RESERVED_EEPROM_SIZE)
    {
        // address is out of bounds
        ERRLN("EEPROM address is out of bounds");
        return;
    }
#if defined(STM32_USE_FLASH)
    eeprom_buffered_write_byte(address, value);
#elif defined(PLATFORM_STM32)
    EEPROM.update(address, value);
#elif defined(PLATFORM_ESP32)
    eeprom_buf[address] = value;
#else
    EEPROM.write(address, value);
#endif
}

void
ELRS_EEPROM::Commit()
{
#if defined(PLATFORM_ESP32)
    if (nvs_set_blob(eeprom_nvs_handle, "data", eeprom_buf, sizeof(eeprom_buf)) != ESP_OK ||
        nvs_commit(eeprom_nvs_handle) != ESP_OK)
    {
        ERRLN("EEPROM commit failed");
    }
#elif defined(PLATFORM_ESP8266)
    if (!EEPROM.commit())
    {
        ERRLN("EEPROM commit failed");
    }
#elif defined(STM32_USE_FLASH)
    eeprom_buffer_flush();
#endif
  // PLATFORM_STM32 with external flash every byte is committed as it is written
}

#endif /* !TARGET_NATIVE */