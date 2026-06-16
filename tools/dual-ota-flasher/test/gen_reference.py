#!/usr/bin/env python3
# Produces a byte-exact reference of UnifiedConfiguration.appendToFirmware for the JS parity test.
import sys, os, struct, json

SRC = os.path.join(os.path.dirname(__file__), "..", "..", "..", "src", "python")
sys.path.insert(0, SRC)
import UnifiedConfiguration as U  # noqa: E402


def make_image(segments, sizes):
    out = bytearray(24)
    out[0] = 0xE9
    out[1] = segments
    for s in sizes:
        out += struct.pack("<II", 0, s) + (b"\0" * s)
    return out


def main():
    out_dir = sys.argv[1]
    img = make_image(3, [16, 32, 48])
    fw = os.path.join(out_dir, "fw.bin")
    with open(fw, "wb") as f:
        f.write(img)
    product = "RadioMaster TX15"
    lua = "TX15"
    defines = '{"uid":[0,0,1,2,3,4],"domain":2,"flash-discriminator":123}'
    layout = {"serial_rx": 3, "serial_tx": 1}
    layout_path = os.path.join(out_dir, "layout.json")
    with open(layout_path, "w") as f:
        json.dump(layout, f)
    with open(fw, "r+b") as f:
        U.appendToFirmware(f, product, lua, defines, {}, layout_path, None)
    # echo the inputs so the JS test feeds identical values
    print(json.dumps({"product": product, "lua": lua, "defines": defines, "layout": layout}))


if __name__ == "__main__":
    main()
