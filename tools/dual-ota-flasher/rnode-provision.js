import { rawBytesMD5 } from "./md5.js";
import { log, getLastPort, isConnected, releaseEsptool } from "./flasher.js";

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

const CMD_ROM_WRITE  = 0x52;
const CMD_RESET      = 0x55;  // soft-reset command byte
const CMD_RESET_BYTE = 0xF8;  // subcommand to trigger hard_reset()
const CMD_HASHES     = 0x60;  // query/report firmware hashes
const CMD_FW_HASH    = 0x58;  // write firmware hash target to EEPROM (triggers hard_reset)

const DEV_HASH_LEN       = 32;  // SHA-256
const ROM_WRITE_DELAY_MS = 85;  // EEPROM.commit() time per byte

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

// Read one KISS frame from port.readable matching expectedCmd.
// Discards frames with other command bytes until timeout.
async function readKissFrame(readable, expectedCmd, timeoutMs = 3000) {
  const reader = readable.getReader();
  try {
    let inFrame = false;
    let frameCmd = null;
    let frameData = [];
    let escape = false;

    const readLoop = async () => {
      while (true) {
        const { value, done } = await reader.read();
        if (done) throw new Error('port closed');
        for (const b of value) {
          if (b === KISS_FEND) {
            if (inFrame && frameCmd === expectedCmd && frameData.length > 0) {
              return new Uint8Array(frameData);
            }
            inFrame = true; frameCmd = null; frameData = []; escape = false;
          } else if (inFrame) {
            if (b === KISS_FESC) { escape = true; continue; }
            const byte = escape ? (b === KISS_TFEND ? KISS_FEND : KISS_FESC) : b;
            escape = false;
            if (frameCmd === null) { frameCmd = byte; }
            else                   { frameData.push(byte); }
          }
        }
      }
    };

    return await Promise.race([
      readLoop(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout waiting for KISS response')), timeoutMs)),
    ]);
  } finally {
    reader.releaseLock();
  }
}

// Provision a LoRa32 v2.1 RNode device.
// band: "433" → MODEL_B4 (433 MHz) | "868" → MODEL_B9 (868/915/923 MHz)
// setStatus: (msg: string) => void — shown in the UI status line
export async function provisionRNode(band, setStatus) {
  if (!navigator.serial) throw new Error("Web Serial not available");

  // The esptool Transport holds reader/writer locks on the SerialPort while connected.
  // Release it first so we can open our own reader for the CMD_HASHES response.
  // releaseEsptool() closes the port (via transport.disconnect()) but leaves the controls
  // panel visible and saves lastPort for reuse below.
  if (isConnected()) await releaseEsptool();

  // Reuse the port from the esptool session (retained by releaseEsptool / disconnect) so
  // the user is not prompted to select a port again.  Fall back to requestPort() if none.
  const knownPort = getLastPort();
  const port = knownPort ?? await navigator.serial.requestPort();

  // transport.disconnect() closes the underlying SerialPort — reopen at 115200 for KISS.
  let shouldClose = false;
  if (port.readable === null) {
    await port.open({ baudRate: 115200 });
    // De-assert DTR and RTS immediately to stop the auto-reset capacitors on the LoRa32
    // v2.1 from pulsing EN/GPIO0 and dropping the device into ROM bootloader mode.
    await port.setSignals({ dataTerminalReady: false, requestToSend: false });
    await sleep(2000);  // wait for any transient reset to finish and firmware to start
    shouldClose = true;
  }

  try {
    const model       = band === "433" ? MODEL_B4 : MODEL_B9;
    const defaultFreq = band === "433" ? FREQ_433 : FREQ_868;
    const serialBytes = packU32BE(1);
    const madeBytes   = packU32BE(Math.floor(Date.now() / 1000));
    const checksum    = deviceChecksum(PRODUCT_T32_21, model, 0x01, serialBytes, madeBytes);

    // 1 — product info (11 writes × 85 ms ≈ 1 s)
    setStatus("Writing device info (1/6)…");
    log("RNode provision: writing product info");
    await writeRom(port.writable, ADDR_PRODUCT, PRODUCT_T32_21);
    await writeRom(port.writable, ADDR_MODEL,   model);
    await writeRom(port.writable, ADDR_HW_REV,  0x01);
    for (let i = 0; i < 4; i++) await writeRom(port.writable, ADDR_SERIAL + i, serialBytes[i]);
    for (let i = 0; i < 4; i++) await writeRom(port.writable, ADDR_MADE   + i, madeBytes[i]);

    // 2 — checksum (16 writes × 85 ms ≈ 1.4 s)
    setStatus("Writing checksum (2/6)…");
    log("RNode provision: writing checksum");
    for (let i = 0; i < 16; i++) await writeRom(port.writable, ADDR_CHKSUM + i, checksum[i]);

    // 3 — signature zeroed (128 writes × 85 ms ≈ 11 s)
    setStatus("Writing signature (3/6) — ~11 s…");
    log("RNode provision: writing signature (128 bytes, please wait)");
    for (let i = 0; i < 128; i++) await writeRom(port.writable, ADDR_SIGNATURE + i, 0x00);

    // 4 — radio config BEFORE locking (eeprom_write() rejects all writes once INFO_LOCK is set)
    setStatus("Writing radio config (4/6)…");
    log(`RNode provision: writing radio config — ${band === "433" ? "433 MHz" : "868/915 MHz"}, BW 125 kHz, SF ${DEFAULT_SF}`);
    await writeRom(port.writable, ADDR_CONF_SF,  DEFAULT_SF);
    await writeRom(port.writable, ADDR_CONF_CR,  DEFAULT_CR);
    await writeRom(port.writable, ADDR_CONF_TXP, DEFAULT_TXP);
    for (const [i, b] of packU32BE(DEFAULT_BW).entries())   await writeRom(port.writable, ADDR_CONF_BW   + i, b);
    for (const [i, b] of packU32BE(defaultFreq).entries())  await writeRom(port.writable, ADDR_CONF_FREQ + i, b);
    await writeRom(port.writable, ADDR_CONF_OK, CONF_OK_BYTE);

    // Lock device info last — after this, CMD_ROM_WRITE is blocked for all addresses
    await writeRom(port.writable, ADDR_INFO_LOCK, INFO_LOCK_BYTE);

    // 5 — reboot so device_init() → device_validate_partitions() runs with INFO_LOCK set.
    // Until this reboot, dev_firmware_hash is all-zeros (never computed). After it, the
    // device hashes the running partition and stores the result in dev_firmware_hash.
    setStatus("Rebooting device for hash computation (5/6) — ~4 s…");
    log("RNode provision: rebooting device to compute firmware hash");
    await portWrite(port.writable, kissFrame(CMD_RESET, CMD_RESET_BYTE));
    await sleep(4000);  // wait for ESP32 to reboot and run device_validate_partitions()

    // 6 — firmware hash: read actual SHA-256 of running partition, write it back as target.
    // kiss_indicate_fw_hash() sends: FEND, CMD_HASHES(0x60), 0x02, [32 hash bytes], FEND
    // readKissFrame returns frameData = [0x02, hash_bytes…] (33 bytes) — slice off sub-cmd.
    // device_save_firmware_hash() uses eeprom_update() (bypasses INFO_LOCK), then calls
    // hard_reset() because fw_signature_validated is still false at this point.
    // After that reboot the target matches → firmware validated.
    setStatus("Setting firmware hash (6/6) — device will reboot…");
    log("RNode provision: reading firmware hash");
    await portWrite(port.writable, kissFrame(CMD_HASHES, 0x02));
    const fwHashFrame = await readKissFrame(port.readable, CMD_HASHES, 10000);
    if (fwHashFrame.length !== DEV_HASH_LEN + 1) throw new Error(`unexpected hash frame length ${fwHashFrame.length}`);
    const fwHash = fwHashFrame.slice(1);  // drop 0x02 sub-command byte
    log(`RNode provision: firmware hash ${Array.from(fwHash).map(b => b.toString(16).padStart(2,'0')).join('')}`);
    await portWrite(port.writable, kissFrame(CMD_FW_HASH, ...fwHash));
    // Device calls hard_reset() — serial port will go quiet; give it time to reboot
    await sleep(3000);

    setStatus("");
    log(`RNode provision: done ✓  model ${band === "433" ? "B4" : "B9"} · ${band === "433" ? FREQ_433 : FREQ_868} Hz`);
  } finally {
    if (shouldClose) try { await port.close(); } catch (_) {}
  }
}
