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
