// EdgeTX serial passthrough: bridge a radio's internal RF module UART to USB so esptool
// can flash it. Mirrors src/python/ETXinitPassthrough.py — a text CLI handshake over the
// radio's USB VCP that powers the module up with BOOT held, then enables passthrough.
// After this returns, the SAME port is a transparent bridge to the module (in bootloader);
// open it with esptool at the same baud.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function etxPassthrough(port, baud, log = () => {}) {
  await port.open({ baudRate: baud });
  const writer = port.writable.getWriter();
  const reader = port.readable.getReader();
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  let buf = "";
  let stop = false;

  const pump = (async () => {
    try {
      while (!stop) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) buf += dec.decode(value);
      }
    } catch (_) { /* reader cancelled on cleanup */ }
  })();

  const send = (cmd) => writer.write(enc.encode(cmd + "\n"));
  const waitFor = async (token, ms) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (buf.includes(token)) return true;
      await sleep(20);
    }
    return false;
  };
  // Send a `set ...` command and wait (best-effort) for the CLI prompt to return.
  const setCmd = async (cmd) => { buf = ""; await send(cmd); await waitFor("> ", 1000); };

  try {
    await setCmd("set pulses 0");
    await setCmd("set rfmod 0 power off");
    await sleep(500);
    await setCmd("set rfmod 0 bootpin 1");   // hold BOOT
    await sleep(100);
    await setCmd("set rfmod 0 power on");     // power up in bootloader
    await sleep(100);
    await setCmd("set rfmod 0 bootpin 0");    // release BOOT
    log("Enabling serial passthrough (rfmod 0 @ " + baud + ")…");
    await send("serialpassthrough rfmod 0 " + baud);
    await sleep(300);
  } finally {
    stop = true;
    try { await reader.cancel(); } catch (_) {}
    try { reader.releaseLock(); } catch (_) {}
    try { writer.releaseLock(); } catch (_) {}
    await pump.catch(() => {});
    await port.close();
  }
}
