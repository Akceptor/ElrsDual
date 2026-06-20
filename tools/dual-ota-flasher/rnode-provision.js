import { rawBytesMD5 } from "./md5.js";
import { log, getLastPort, isConnected, releaseEsptool } from "./flasher.js";

// EEPROM address map — matches liamcottle/rnode-flasher ROM class
const ADDR_PRODUCT   = 0x00;
const ADDR_MODEL     = 0x01;
const ADDR_HW_REV    = 0x02;
const ADDR_SERIAL    = 0x03;  // 4 bytes BE
const ADDR_MADE      = 0x07;  // 4 bytes BE (Unix timestamp)
const ADDR_CHKSUM    = 0x0B;  // 16 bytes MD5
const ADDR_SIGNATURE = 0x1B;  // 128 bytes (zeroed)
const ADDR_INFO_LOCK = 0x9B;

// Radio config — written separately via CMD_FREQUENCY etc. + CMD_CONF_SAVE
// (eeprom_conf_save bypasses INFO_LOCK; CMD_ROM_WRITE cannot be used after lock)
const ADDR_CONF_SF   = 0x9C;
const ADDR_CONF_CR   = 0x9D;
const ADDR_CONF_TXP  = 0x9E;
const ADDR_CONF_BW   = 0x9F;  // 4 bytes BE
const ADDR_CONF_FREQ = 0xA3;  // 4 bytes BE

const INFO_LOCK_BYTE = 0x73;

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

const CMD_DETECT     = 0x08;  // detect request/response
const DETECT_REQ     = 0x73;
const DETECT_RESP    = 0x46;

const CMD_FREQUENCY  = 0x01;
const CMD_BANDWIDTH  = 0x02;
const CMD_TXPOWER    = 0x03;
const CMD_SF         = 0x04;
const CMD_CR         = 0x05;
const CMD_RADIO_STATE = 0x06;
const RADIO_STATE_ON = 0x01;

const CMD_ROM_READ   = 0x51;
const CMD_ROM_WRITE  = 0x52;
const CMD_CONF_SAVE  = 0x53;
const CMD_RESET      = 0x55;
const CMD_RESET_BYTE = 0xF8;
const CMD_FW_HASH    = 0x58;  // write firmware hash target → triggers hard_reset()
const CMD_HASHES     = 0x60;  // query/report firmware hashes
const HASH_TYPE_FIRMWARE = 0x02;

const DEV_HASH_LEN       = 32;  // SHA-256
const EEPROM_RESERVED    = 200; // bytes returned by CMD_ROM_READ
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
export function deviceChecksum(product, model, hwRev, serialBytes, madeBytes) {
  const bytes = [product, model, hwRev, ...serialBytes, ...madeBytes];
  const hex = rawBytesMD5(bytes);
  const out = [];
  for (let i = 0; i < 32; i += 2) out.push(parseInt(hex.substr(i, 2), 16));
  return out;  // 16 bytes
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Event-driven KISS port — mirrors the original liamcottle/rnode-flasher RNode class.
// Runs a persistent readLoop so responses are never missed due to timing.
class KissPort {
  constructor(port) {
    this._port     = port;
    this.writable  = port.writable;
    this._callbacks = {};
    this._reader   = port.readable.getReader();
    this._run();
  }

  async _run() {
    let buf = [], inFrame = false;
    try {
      while (true) {
        const { value, done } = await this._reader.read();
        if (done) break;
        for (const b of value) {
          if (b === KISS_FEND) {
            if (inFrame && buf.length) {
              const frame = this._decode(buf);
              if (frame) this._dispatch(frame);
            }
            buf = []; inFrame = !inFrame;
          } else if (inFrame) {
            buf.push(b);
          }
        }
      }
    } catch (e) {
      if (!(e instanceof TypeError)) console.error('KissPort read error', e);
    } finally {
      try { this._reader.releaseLock(); } catch (_) {}
    }
  }

  _decode(raw) {
    const out = []; let esc = false;
    for (const b of raw) {
      if (esc) {
        if      (b === KISS_TFEND) out.push(KISS_FEND);
        else if (b === KISS_TFESC) out.push(KISS_FESC);
        else return null;
        esc = false;
      } else if (b === KISS_FESC) { esc = true; }
      else { out.push(b); }
    }
    return esc ? null : out;
  }

  _dispatch(data) {
    const [cmd, ...bytes] = data;
    const cb = this._callbacks[cmd];
    if (!cb) return;
    delete this._callbacks[cmd];
    cb(bytes);
  }

  // Send a command and await one response frame for that command.
  sendCommand(cmd, ...data) {
    return new Promise((resolve, reject) => {
      this._callbacks[cmd] = resolve;
      this._write(kissFrame(cmd, ...data)).catch(reject);
    });
  }

  // Fire-and-forget (no response expected).
  sendKissCommand(cmd, ...data) {
    return this._write(kissFrame(cmd, ...data));
  }

  async _write(bytes) {
    const w = this.writable.getWriter();
    try { await w.write(bytes); } finally { w.releaseLock(); }
  }

  async close() {
    try { await this._reader.cancel(); } catch (_) {}
  }
}

// Open (or reuse) the serial port; de-assert DTR/RTS to suppress LoRa32 v2.1 auto-reset.
async function openPort() {
  if (isConnected()) await releaseEsptool();
  const port = getLastPort() ?? await navigator.serial.requestPort();
  let shouldClose = false;
  if (port.readable === null) {
    await port.open({ baudRate: 115200 });
    // De-assert immediately before the 100 nF caps on GPIO0/EN can charge.
    await port.setSignals({ dataTerminalReady: false, requestToSend: false });
    await sleep(2000);  // wait for any transient reset + firmware boot
    shouldClose = true;
  }
  return { port, shouldClose };
}

// Verify the device is an RNode (matches original askForRNode → detect()).
async function detectRNode(kiss) {
  const response = await Promise.race([
    kiss.sendCommand(CMD_DETECT, DETECT_REQ),
    new Promise((_, rej) => setTimeout(() => rej(new Error("timeout: device did not respond to CMD_DETECT — is RNode firmware running?")), 3000)),
  ]);
  const [resp] = response;
  if (resp !== DETECT_RESP) throw new Error(`CMD_DETECT: unexpected response 0x${resp?.toString(16)}`);
}

// Parse 200-byte EEPROM dump — mirrors liamcottle/rnode-flasher ROM.parse().
function parseRom(eeprom) {
  if (eeprom[ADDR_INFO_LOCK] !== INFO_LOCK_BYTE) return null;

  const stored = eeprom.slice(ADDR_CHKSUM, ADDR_CHKSUM + 16);
  const calc   = deviceChecksum(
    eeprom[ADDR_PRODUCT], eeprom[ADDR_MODEL], eeprom[ADDR_HW_REV],
    Array.from(eeprom.slice(ADDR_SERIAL, ADDR_SERIAL + 4)),
    Array.from(eeprom.slice(ADDR_MADE,   ADDR_MADE   + 4)),
  );
  const ok = calc.every((b, i) => b === stored[i]);
  return { isProvisioned: ok };
}

async function writeRom(kiss, addr, value) {
  await kiss.sendKissCommand(CMD_ROM_WRITE, addr, value);
  await sleep(ROM_WRITE_DELAY_MS);
}

// ─── Public API ─────────────────────────────────────────────────────────────

// Provision a LoRa32 v2.1 RNode device.
// Matches liamcottle/rnode-flasher provision() exactly:
//   writes identity + checksum + zeroed signature + INFO_LOCK,
//   sleeps 5 s, resets. Radio config is NOT written here — use configureRNodeRadio().
export async function provisionRNode(band, setStatus) {
  if (!navigator.serial) throw new Error("Web Serial not available");

  const { port, shouldClose } = await openPort();
  const kiss = new KissPort(port);
  try {
    const model       = band === "433" ? MODEL_B4 : MODEL_B9;
    const defaultFreq = band === "433" ? FREQ_433 : FREQ_868;
    const serialBytes = packU32BE(1);
    const madeBytes   = packU32BE(Math.floor(Date.now() / 1000));
    const checksum    = deviceChecksum(PRODUCT_T32_21, model, 0x01, serialBytes, madeBytes);

    // Verify device before writing anything
    setStatus("Detecting device (1/5)…");
    await detectRNode(kiss);

    // 2 — product info
    setStatus("Writing device info (2/5)…");
    log("RNode provision: writing product info");
    await writeRom(kiss, ADDR_PRODUCT, PRODUCT_T32_21);
    await writeRom(kiss, ADDR_MODEL,   model);
    await writeRom(kiss, ADDR_HW_REV,  0x01);
    for (let i = 0; i < 4; i++) await writeRom(kiss, ADDR_SERIAL + i, serialBytes[i]);
    for (let i = 0; i < 4; i++) await writeRom(kiss, ADDR_MADE   + i, madeBytes[i]);

    // 3 — checksum
    setStatus("Writing checksum (3/5)…");
    log("RNode provision: writing checksum");
    for (let i = 0; i < 16; i++) await writeRom(kiss, ADDR_CHKSUM + i, checksum[i]);

    // 4 — signature zeroed (128 writes × 85 ms ≈ 11 s)
    setStatus("Writing signature (4/5) — ~11 s…");
    log("RNode provision: writing signature (128 bytes, please wait)");
    for (let i = 0; i < 128; i++) await writeRom(kiss, ADDR_SIGNATURE + i, 0x00);

    // 5 — lock
    setStatus("Locking and rebooting (5/5) — ~5 s…");
    log("RNode provision: writing INFO_LOCK, waiting 5 s, rebooting");
    await writeRom(kiss, ADDR_INFO_LOCK, INFO_LOCK_BYTE);
    // Give EEPROM writes time to fully commit before reset (matches original 5 s sleep)
    await sleep(5000);
    await kiss.sendKissCommand(CMD_RESET, CMD_RESET_BYTE);

    setStatus("Done — wait for device to boot, then click Write firmware hash");
    log(`RNode provision: EEPROM written ✓  model ${band === "433" ? "B4" : "B9"} · ${defaultFreq} Hz  — device rebooting`);
  } finally {
    await kiss.close();
    if (shouldClose) try { await port.close(); } catch (_) {}
  }
}

// Write the running firmware hash to EEPROM as the target hash.
// Matches liamcottle/rnode-flasher setFirmwareHash() exactly:
//   verifies provisioning via CMD_ROM_READ, reads hash via CMD_HASHES/0x02,
//   writes via CMD_FW_HASH (device calls hard_reset()), waits 5 s.
// Call this after provisionRNode() once the device has finished booting (~5 s).
export async function writeRNodeFirmwareHash(setStatus) {
  if (!navigator.serial) throw new Error("Web Serial not available");

  const { port, shouldClose } = await openPort();
  const kiss = new KissPort(port);
  try {
    // Verify device
    setStatus("Detecting device…");
    await detectRNode(kiss);

    // Read EEPROM and verify provisioning (matches original setFirmwareHash guard)
    setStatus("Verifying provisioning…");
    log("RNode provision: reading EEPROM to verify provisioning");
    const romData = await Promise.race([
      kiss.sendCommand(CMD_ROM_READ, 0x00),
      new Promise((_, rej) => setTimeout(() => rej(new Error("timeout: CMD_ROM_READ")), 5000)),
    ]);
    if (romData.length < EEPROM_RESERVED) throw new Error(`unexpected EEPROM length ${romData.length}`);
    const rom = parseRom(romData);
    if (!rom?.isProvisioned) throw new Error("EEPROM is not provisioned — run Provision RNode first");

    // Read firmware hash from device (CMD_HASHES/0x02 → [0x02, hash×32])
    setStatus("Reading firmware hash…");
    log("RNode provision: reading firmware hash");
    const hashFrame = await Promise.race([
      kiss.sendCommand(CMD_HASHES, HASH_TYPE_FIRMWARE),
      new Promise((_, rej) => setTimeout(() => rej(new Error("timeout: CMD_HASHES")), 10000)),
    ]);
    // hashFrame = [0x02, hash_byte_0 … hash_byte_31]
    if (hashFrame.length !== DEV_HASH_LEN + 1) throw new Error(`unexpected hash frame length ${hashFrame.length}`);
    const fwHash = hashFrame.slice(1);  // drop 0x02 sub-command byte
    log(`RNode provision: firmware hash ${Array.from(fwHash).map(b => b.toString(16).padStart(2,'0')).join('')}`);

    // Write hash target → device calls hard_reset() (fw_signature_validated was false)
    setStatus("Writing firmware hash — device will reboot…");
    log("RNode provision: writing firmware hash (device will reboot)");
    await kiss.sendKissCommand(CMD_FW_HASH, ...fwHash);

    // Wait for device to reboot (matches original 5 s sleep)
    await sleep(5000);

    // Try explicit reset in case device didn't auto-reset (matches original)
    try { await kiss.sendKissCommand(CMD_RESET, CMD_RESET_BYTE); } catch (_) {}

    setStatus("");
    log("RNode provision: firmware hash written ✓  device rebooted and validated");
  } finally {
    await kiss.close();
    if (shouldClose) try { await port.close(); } catch (_) {}
  }
}

// Configure radio parameters via CMD_FREQUENCY/CMD_BW/etc. + CMD_CONF_SAVE.
// eeprom_conf_save() uses eeprom_update() directly, bypassing INFO_LOCK, so this
// works after provisionRNode(). Matches original enableTncMode() sequence.
export async function configureRNodeRadio(band, setStatus) {
  if (!navigator.serial) throw new Error("Web Serial not available");

  const freq = band === "433" ? FREQ_433 : FREQ_868;
  const { port, shouldClose } = await openPort();
  const kiss = new KissPort(port);
  try {
    setStatus("Detecting device…");
    await detectRNode(kiss);

    setStatus(`Configuring radio — ${band === "433" ? "433" : "868/915"} MHz…`);
    log(`RNode provision: configuring radio — ${freq} Hz, BW ${DEFAULT_BW} Hz, SF ${DEFAULT_SF}, CR ${DEFAULT_CR}, TXP ${DEFAULT_TXP} dBm`);

    // Set runtime radio params (these work even after INFO_LOCK)
    const freqBytes = packU32BE(freq);
    const bwBytes   = packU32BE(DEFAULT_BW);
    await kiss.sendKissCommand(CMD_FREQUENCY,  ...freqBytes);
    await kiss.sendKissCommand(CMD_BANDWIDTH,  ...bwBytes);
    await kiss.sendKissCommand(CMD_TXPOWER,    DEFAULT_TXP);
    await kiss.sendKissCommand(CMD_SF,         DEFAULT_SF);
    await kiss.sendKissCommand(CMD_CR,         DEFAULT_CR);
    await kiss.sendKissCommand(CMD_RADIO_STATE, RADIO_STATE_ON);

    // CMD_CONF_SAVE calls eeprom_conf_save() which bypasses INFO_LOCK.
    // Original flasher sends it twice (observed to miss bytes when sent once).
    await sleep(500);
    await kiss.sendKissCommand(CMD_CONF_SAVE, 0x00);
    await sleep(200);
    await kiss.sendKissCommand(CMD_CONF_SAVE, 0x00);
    await sleep(500);

    await kiss.sendKissCommand(CMD_RESET, CMD_RESET_BYTE);
    setStatus("");
    log("RNode provision: radio configured ✓");
  } finally {
    await kiss.close();
    if (shouldClose) try { await port.close(); } catch (_) {}
  }
}
