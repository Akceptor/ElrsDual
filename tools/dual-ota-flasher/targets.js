// Pure helpers over hardware/targets.json (no DOM, no fetch).
export function flattenTargets(targets) {
  const out = [];
  for (const [mfr, cats] of Object.entries(targets)) {
    if (typeof cats !== "object") continue;
    for (const [cat, devs] of Object.entries(cats)) {
      if (typeof devs !== "object") continue;
      for (const [dev, body] of Object.entries(devs)) {
        if (body && typeof body === "object" && "platform" in body) {
          out.push({ id: `${mfr}.${cat}.${dev}`, dev: body });
        }
      }
    }
  }
  return out;
}

export function filterEsp32Targets(flat) {
  return flat.filter((t) => t.dev.platform === "esp32");
}

export function targetToEnv(dev) {
  return `${dev.firmware}_via_UART`;
}

export function bandBuildFlag(env) {
  return /_2400_/.test(env) ? "-DRegulatory_Domain_ISM_2400" : "-DRegulatory_Domain_FCC_915";
}
