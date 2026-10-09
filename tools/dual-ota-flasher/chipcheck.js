export const IMAGE_CHIP_IDS = { 0: "ESP32", 5: "ESP32-C3" };

// Returns null if the ESP app image header matches chipName, else a human-readable reason.
export function checkImageChip(data, chipName) {
  if (!data || data.length < 14 || data[0] !== 0xE9) return "not an ESP app image (bad magic/size)";
  const id = data[12] | (data[13] << 8);
  const imgChip = IMAGE_CHIP_IDS[id] || ("unknown chip_id " + id);
  return imgChip === chipName ? null : "image is built for " + imgChip + " but the connected chip is " + chipName;
}
