import { test } from "node:test";
import assert from "node:assert/strict";
import { flattenTargets, filterEsp32Targets, targetToEnv, bandBuildFlag } from "../targets.js";

const sample = {
  radiomaster: { tx_dual: {
    tx15: { product_name: "TX15", platform: "esp32", firmware: "Unified_ESP32_2400_TX" },
  }},
  happymodel: { rx_2400: {
    ep1: { product_name: "EP1", platform: "esp8285", firmware: "Unified_ESP8285_2400_RX" },
  }},
  generic: { rx_900: {
    s3: { product_name: "S3", platform: "esp32-s3", firmware: "Unified_ESP32S3_900_RX" },
  }},
};

test("flattenTargets yields dotted ids with the device dict", () => {
  const flat = flattenTargets(sample);
  assert.equal(flat.find((t) => t.id === "radiomaster.tx_dual.tx15").dev.product_name, "TX15");
});

test("filterEsp32Targets keeps only platform === 'esp32'", () => {
  const ids = filterEsp32Targets(flattenTargets(sample)).map((t) => t.id);
  assert.deepEqual(ids, ["radiomaster.tx_dual.tx15"]);
});

test("targetToEnv appends _via_UART", () => {
  assert.equal(targetToEnv({ firmware: "Unified_ESP32_2400_TX" }), "Unified_ESP32_2400_TX_via_UART");
});

test("bandBuildFlag picks ISM_2400 for 2400, FCC_915 otherwise", () => {
  assert.match(bandBuildFlag("Unified_ESP32_2400_TX_via_UART"), /ISM_2400/);
  assert.match(bandBuildFlag("Unified_ESP32_LR1121_TX_via_UART"), /FCC_915/);
});
