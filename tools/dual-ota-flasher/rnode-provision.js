import { rawBytesMD5 } from "./md5.js";
import { log, getLastPort } from "./flasher.js";

// EEPROM layout — matches liamcottle/rnode-flasher ROM class
const ADDR_PRODUCT   = 0x00;
const ADDR_MODEL     = 0x01;
const ADDR_HW_REV    = 0x02;
const ADDR_SERIAL    = 0x03;  // 4 bytes BE
const ADDR_MADE      = 0x07;  // 4 bytes BE (Unix timestamp)
const ADDR_CHKSUM    = 0x0B;  // 16 bytes MD5
const ADDR_SIGNATURE = 0x1B;  // 128 bytes (zeroed)
const ADDR_INFO_LOCK = 0x9B;
const ADDR_CONF_SF   = 0x9C;
const ADDR_CONF_CR   = 0x9D;
const ADDR_CONF_TXP  = 0x9E;
const ADDR_CONF_BW   = 0x9F;  // 4 bytes BE
const ADDR_CONF_FREQ = 0xA3;  // 4 bytes BE
const ADDR_CONF_OK   = 0xA7;

const INFO_LOCK_BYTE = 0x73;
const CONF_OK_BYTE   = 0x73;

// LilyGo LoRa32 v2.1 product/model (PRODUCT_T32_21 in ROM class)
const PRODUCT_T32_21 = 0xB1;
export const MODEL_B4 = 0xB4;  // 433 MHz
export const MODEL_B9 = 0xB9;  // 868 / 915 / 923 MHz

// Default radio config
const DEFAULT_SF  = 8;
const DEFAULT_CR  = 5;
const DEFAULT_TXP = 17;       // dBm
const DEFAULT_BW  = 125000;   // Hz

const FREQ_433 = 433175000;
const FREQ_868 = 868125000;

// KISS framing
const KISS_FEND  = 0xC0;
const KISS_FESC  = 0xDB;
const KISS_TFEND = 0xDC;
const KISS_TFESC = 0xDD;

const CMD_ROM_WRITE       = 0x52;
const CMD_CONF_SAVE       = 0x53;
const ROM_WRITE_DELAY_MS  = 85;   // EEPROM.commit() time per byte

export function packU32BE(v) {
  return [(v >>> 24) & 0xFF, (v >>> 16) & 0xFF, (v >>> 8) & 0xFF, v & 0xFF];
}

export function kissFrame(cmd, ...data) {
  const raw = [cmd, ...data];
  const out = [KISS_FEND];
  for (const b of raw) {
    if      (b === KISS_FEND) { out.push(KISS_FESC, KISS_TFEND); }
    else if (b === KISS_FESC) { out.push(KISS_FESC, KISS_TFESC); }
    else                      { out.push(b); }
  }
  out.push(KISS_FEND);
  return new Uint8Array(out);
}

// MD5 over 11 raw bytes: [product, model, hwRev, serial×4, made×4]
// Must match Python hashlib.md5(bytes([...])).hexdigest() exactly.
export function deviceChecksum(product, model, hwRev, serialBytes, madeBytes) {
  const bytes = [product, model, hwRev, ...serialBytes, ...madeBytes];
  const hex = rawBytesMD5(bytes);
  const out = [];
  for (let i = 0; i < 32; i += 2) out.push(parseInt(hex.substr(i, 2), 16));
  return out;  // 16 bytes
}

async function portWrite(writable, bytes) {
  const writer = writable.getWriter();
  try { await writer.write(bytes); }
  finally { writer.releaseLock(); }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function writeRom(writable, addr, value) {
  await portWrite(writable, kissFrame(CMD_ROM_WRITE, addr, value));
  await sleep(ROM_WRITE_DELAY_MS);
}

// Provision a LoRa32 v2.1 RNode device.
// band: "433" → MODEL_B4 (433 MHz) | "868" → MODEL_B9 (868/915/923 MHz)
// setStatus: (msg: string) => void — shown in the UI status line
export async function provisionRNode(band, setStatus) {
  if (!navigator.serial) throw new Error("Web Serial not available");

  // Reuse the port from the esptool session (retained after flash/disconnect) so the
  // user is not prompted to select a port again.  Fall back to requestPort() if none.
  const knownPort = getLastPort();
  const port = knownPort ?? await navigator.serial.requestPort();

  // esptool's transport.disconnect() releases reader/writer but may leave the underlying
  // SerialPort open.  Only call open() when the port is actually closed.
  const wasOpen = port.readable !== null;
  if (!wasOpen) await port.open({ baudRate: 115200 });

  try {
    const model       = band === "433" ? MODEL_B4 : MODEL_B9;
    const defaultFreq = band === "433" ? FREQ_433 : FREQ_868;
    const serialBytes = packU32BE(1);
    const madeBytes   = packU32BE(Math.floor(Date.now() / 1000));
    const checksum    = deviceChecksum(PRODUCT_T32_21, model, 0x01, serialBytes, madeBytes);

    // 1 — product info (11 writes × 85 ms ≈ 1 s)
    setStatus("Writing device info (1/4)…");
    log("RNode provision: writing product info");
    await writeRom(port.writable, ADDR_PRODUCT, PRODUCT_T32_21);
    await writeRom(port.writable, ADDR_MODEL,   model);
    await writeRom(port.writable, ADDR_HW_REV,  0x01);
    for (let i = 0; i < 4; i++) await writeRom(port.writable, ADDR_SERIAL + i, serialBytes[i]);
    for (let i = 0; i < 4; i++) await writeRom(port.writable, ADDR_MADE   + i, madeBytes[i]);

    // 2 — checksum (16 writes × 85 ms ≈ 1.4 s)
    setStatus("Writing checksum (2/4)…");
    log("RNode provision: writing checksum");
    for (let i = 0; i < 16; i++) await writeRom(port.writable, ADDR_CHKSUM + i, checksum[i]);

    // 3 — signature zeroed (128 writes × 85 ms ≈ 11 s)
    setStatus("Writing signature (3/4) — ~11 s…");
    log("RNode provision: writing signature (128 bytes, please wait)");
    for (let i = 0; i < 128; i++) await writeRom(port.writable, ADDR_SIGNATURE + i, 0x00);

    await writeRom(port.writable, ADDR_INFO_LOCK, INFO_LOCK_BYTE);

    // 4 — radio config (11 writes × 85 ms ≈ 1 s)
    setStatus("Writing radio config (4/4)…");
    log(`RNode provision: writing radio config — ${band === "433" ? "433 MHz" : "868/915 MHz"}, BW 125 kHz, SF ${DEFAULT_SF}`);
    await writeRom(port.writable, ADDR_CONF_SF,  DEFAULT_SF);
    await writeRom(port.writable, ADDR_CONF_CR,  DEFAULT_CR);
    await writeRom(port.writable, ADDR_CONF_TXP, DEFAULT_TXP);
    for (const [i, b] of packU32BE(DEFAULT_BW).entries())   await writeRom(port.writable, ADDR_CONF_BW   + i, b);
    for (const [i, b] of packU32BE(defaultFreq).entries())  await writeRom(port.writable, ADDR_CONF_FREQ + i, b);
    await writeRom(port.writable, ADDR_CONF_OK, CONF_OK_BYTE);

    // save config
    await portWrite(port.writable, kissFrame(CMD_CONF_SAVE, 0x00));
    await sleep(500);

    setStatus("");
    log(`RNode provision: done ✓  model ${band === "433" ? "B4" : "B9"} · ${band === "433" ? FREQ_433 : FREQ_868} Hz`);
  } finally {
    if (!wasOpen) try { await port.close(); } catch (_) {}
  }
}
