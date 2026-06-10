# Lua "Switch FW Slot" Command — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Switch FW Slot" command to the TX Lua menu (after Telem Ratio) that flips the active OTA boot partition and reboots, enabling the user to switch between the two dual-firmware slots without using the WebUI.

**Architecture:** A new public `setSwitchFirmwareSlot()` function is added to `devWIFI.cpp` (alongside `setWifiUpdateMode()`) — it finds the non-running OTA partition, calls `esp_ota_set_boot_partition()`, and schedules a reboot. `TXModuleParameters.cpp` declares it `extern`, defines a `commandParameter` struct for the Lua item, adds a `handleFirmwareSlot()` handler that mirrors the WiFi/BLE confirm-then-execute pattern, and registers the parameter after `luaTlmRate`. Everything is guarded by `#if defined(PLATFORM_ESP32)`.

**Tech Stack:** C++, ESP-IDF `esp_ota_ops.h`, ExpressLRS CRSF Lua parameter framework.

---

## File Map

| File | Change |
|------|--------|
| `src/lib/WIFI/devWIFI.cpp` | Add `setSwitchFirmwareSlot()` after `setWifiUpdateMode()` (~line 105) |
| `src/lib/tx-crsf/TXModuleParameters.cpp` | Add struct (~line 100), extern decl (~line 326), handler (~line 525), registration (~line 838) |

---

### Task 1: Add `setSwitchFirmwareSlot()` to `devWIFI.cpp`

**Files:**
- Modify: `src/lib/WIFI/devWIFI.cpp` (after line 105, after `setWifiUpdateMode()`)

`esp_ota_ops.h` is already included at line 15. `scheduleRebootTime()` is already used in this file.

- [ ] **Add the function** — insert immediately after the closing `}` of `setWifiUpdateMode()` (after line 105):

```cpp
#if defined(PLATFORM_ESP32)
void setSwitchFirmwareSlot()
{
  const esp_partition_t *running = esp_ota_get_running_partition();
  esp_partition_subtype_t targetSub =
      (running && running->subtype == ESP_PARTITION_SUBTYPE_APP_OTA_0)
          ? ESP_PARTITION_SUBTYPE_APP_OTA_1
          : ESP_PARTITION_SUBTYPE_APP_OTA_0;
  const esp_partition_t *target =
      esp_partition_find_first(ESP_PARTITION_TYPE_APP, targetSub, NULL);
  if (target)
    esp_ota_set_boot_partition(target);
  scheduleRebootTime(400);
}
#endif
```

- [ ] **Verify build compiles** (ESP32 target only — non-ESP32 targets have no OTA):

```bash
cd /Users/vostapiv/Drones/ExpressLRS/src
pio run -e Unified_ESP32_900_TX_via_UART 2>&1 | tail -5
```

Expected: `SUCCESS` with no errors.

- [ ] **Commit:**

```bash
git add src/lib/WIFI/devWIFI.cpp
git commit -m "feat: add setSwitchFirmwareSlot() to devWIFI — flips OTA boot partition and reboots"
```

---

### Task 2: Add `luaFirmwareSlot` struct and extern declaration to `TXModuleParameters.cpp`

**Files:**
- Modify: `src/lib/tx-crsf/TXModuleParameters.cpp`

- [ ] **Add the `commandParameter` struct** — insert after the closing `};` of `luaTlmRate` (after line 99, before the `//---POWER---` comment at line 101):

```cpp
#if defined(PLATFORM_ESP32)
static commandParameter luaFirmwareSlot = {
    {"Switch FW Slot", CRSF_COMMAND},
    lcsIdle, // step
    STR_EMPTYSPACE
};
#endif
```

- [ ] **Add the extern declaration** — insert after line 325 (`extern void setWifiUpdateMode();`):

```cpp
#if defined(PLATFORM_ESP32)
extern void setSwitchFirmwareSlot();
#endif
```

- [ ] **Verify build still compiles:**

```bash
cd /Users/vostapiv/Drones/ExpressLRS/src
pio run -e Unified_ESP32_900_TX_via_UART 2>&1 | tail -5
```

Expected: `SUCCESS`.

- [ ] **Commit:**

```bash
git add src/lib/tx-crsf/TXModuleParameters.cpp
git commit -m "feat: declare luaFirmwareSlot command parameter and extern setSwitchFirmwareSlot"
```

---

### Task 3: Add `handleFirmwareSlot()` handler

**Files:**
- Modify: `src/lib/tx-crsf/TXModuleParameters.cpp` (after line 525, after closing `}` of `handleWifiBle()`)

The handler always asks for confirmation on click (unlike WiFi which skips confirm when disconnected — a reboot should always confirm).

- [ ] **Add the handler** — insert immediately after the closing `}` of `handleWifiBle()` (~line 525):

```cpp
#if defined(PLATFORM_ESP32)
void TXModuleEndpoint::handleFirmwareSlot(propertiesCommon *item, uint8_t arg)
{
  commandParameter *cmd = (commandParameter *)item;
  switch ((commandStep_e)arg)
  {
    case lcsClick:
      sendCommandResponse(cmd, lcsAskConfirm, "Switch FW Slot?");
      break;

    case lcsConfirmed:
      sendCommandResponse(cmd, lcsExecuting, "Switching...");
      setSwitchFirmwareSlot();
      break;

    case lcsCancel:
      sendCommandResponse(cmd, lcsIdle, STR_EMPTYSPACE);
      break;

    default:
      sendCommandResponse(cmd, cmd->step, cmd->info);
      break;
  }
}
#endif
```

- [ ] **Declare the method in the header** — open `src/lib/tx-crsf/TXModuleEndpoint.h` and find where `handleWifiBle` is declared, then add alongside it:

```cpp
#if defined(PLATFORM_ESP32)
void handleFirmwareSlot(propertiesCommon *item, uint8_t arg);
#endif
```

- [ ] **Verify build still compiles:**

```bash
cd /Users/vostapiv/Drones/ExpressLRS/src
pio run -e Unified_ESP32_900_TX_via_UART 2>&1 | tail -5
```

Expected: `SUCCESS`.

- [ ] **Commit:**

```bash
git add src/lib/tx-crsf/TXModuleParameters.cpp src/lib/tx-crsf/TXModuleEndpoint.h
git commit -m "feat: add handleFirmwareSlot() Lua command handler (confirm → setSwitchFirmwareSlot)"
```

---

### Task 4: Register `luaFirmwareSlot` in the Lua menu after `luaTlmRate`

**Files:**
- Modify: `src/lib/tx-crsf/TXModuleParameters.cpp` (~line 838, in `registerParameters()`)

Current sequence at ~line 836:
```cpp
registerParameter(&luaTlmRate, [this](propertiesCommon *item, uint8_t arg) {
    SetTlmRatio(arg);
});
// next: luaSwitch registration (line 839)
```

- [ ] **Insert registration after `luaTlmRate`** — add immediately after the closing `});` of the `luaTlmRate` registration and before the `if (!firmwareOptions.is_airport)` block:

```cpp
#if defined(PLATFORM_ESP32)
    registerParameter(&luaFirmwareSlot, [this](propertiesCommon *item, uint8_t arg) {
        handleFirmwareSlot(item, arg);
    });
#endif
```

- [ ] **Verify the full build compiles:**

```bash
cd /Users/vostapiv/Drones/ExpressLRS/src
pio run -e Unified_ESP32_900_TX_via_UART 2>&1 | tail -5
```

Expected: `SUCCESS`.

- [ ] **Commit:**

```bash
git add src/lib/tx-crsf/TXModuleParameters.cpp
git commit -m "feat: register Switch FW Slot in Lua menu after Telem Ratio"
```

---

## Manual Verification Checklist

After flashing to hardware (LiLyGo TTGO T3 v1.6.1 or any dual-OTA ESP32 TX):

- [ ] Lua menu shows "Switch FW Slot" immediately after "Telem Ratio"
- [ ] Pressing the item shows "Switch FW Slot?" confirmation prompt
- [ ] Confirming shows "Switching..." then device reboots into the other slot
- [ ] Cancelling returns to idle with no reboot
- [ ] After reboot, running slot has flipped (verify via WebUI `/slot` or the Options tab)
- [ ] Switching back works correctly (round-trip v3→v4→v3)
- [ ] Non-ESP32 targets (STM32) still build cleanly:

```bash
pio run -e Unified_ESP32_2400_TX_via_UART 2>&1 | tail -5
```
