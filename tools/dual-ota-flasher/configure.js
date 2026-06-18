import { md5 } from "./md5.js";

export function generateUID(phrase) {
  const parts = phrase.split(",").map((s) => (/^\d+$/.test(s.trim()) ? parseInt(s.trim(), 10) : -1));
  if (parts.length >= 4 && parts.length <= 6 && parts.every((n) => n >= 0 && n < 256)) {
    const uid = parts.slice();
    while (uid.length < 6) uid.unshift(0);
    return Uint8Array.from(uid);
  }
  const hex = md5(`-DMY_BINDING_PHRASE="${phrase}"`);
  const bytes = [];
  for (let i = 0; i < 6; i++) bytes.push(parseInt(hex.substr(i * 2, 2), 16));
  return Uint8Array.from(bytes);
}

const DOMAIN_NUMBERS = { au_915: 0, fcc_915: 1, eu_868: 2, in_866: 3, au_433: 4, eu_433: 5, us_433: 6, us_433_wide: 7 };

export function domainNumber(domain) {
  if (!(domain in DOMAIN_NUMBERS)) throw new Error(`unknown domain ${domain}`);
  return DOMAIN_NUMBERS[domain];
}

// discriminator: pass a fixed value in tests; omit in the browser for a random one.
export function buildDefines({ phrase, domain, discriminator }) {
  const flags = {};
  if (phrase) flags["uid"] = [...generateUID(phrase)];
  if (domain) flags["domain"] = domainNumber(domain);
  flags["flash-discriminator"] =
    discriminator ?? (globalThis.crypto.getRandomValues(new Uint32Array(1))[0] || 1);
  return JSON.stringify(flags);
}

// Mirrors UnifiedConfiguration.findFirmwareEnd for the ESP32 (non-8285) path.
export function findFirmwareEnd(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = dv.getUint8(0);
  if (magic !== 0xe9) throw new Error("not a firmware image (bad magic)");
  const segments = dv.getUint8(1);
  if (segments === 2) throw new Error("ESP8266/85 image not supported by this tool");
  let pos = 24;
  for (let i = 0; i < segments; i++) {
    const size = dv.getUint32(pos + 4, true);
    pos += 8 + size;
  }
  pos = (pos + 16) & ~15;
  pos += 32;
  return pos >>> 0;
}

const enc = new TextEncoder();

function fixedField(str, len) {
  const out = new Uint8Array(len); // zero-filled
  const b = enc.encode(str);
  out.set(b.subarray(0, len));
  return out;
}

// Mirrors UnifiedConfiguration.appendToFirmware (first four blocks only).
// base: Uint8Array firmware image. Returns a new Uint8Array with the config appended.
export function appendConfig(base, { productName, luaName, defines, layout }) {
  const end = findFirmwareEnd(base);
  const product = fixedField(productName, 128);
  const device = fixedField(luaName, 16);
  const definesField = fixedField(defines, 512);
  const layoutStr = layout == null ? "" : JSON.stringify(layout);
  const layoutField = fixedField(layoutStr, 2048);

  const out = new Uint8Array(end + product.length + device.length + definesField.length + layoutField.length);
  out.set(base.subarray(0, Math.min(base.length, end)), 0);
  let p = end;
  for (const f of [product, device, definesField, layoutField]) { out.set(f, p); p += f.length; }
  return out;
}
