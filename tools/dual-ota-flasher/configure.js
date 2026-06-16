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
