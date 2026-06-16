import { test } from "node:test";
import assert from "node:assert/strict";
import { generateUID } from "../configure.js";

test("generateUID: comma-separated ints are left-padded to 6 bytes", () => {
  assert.deepEqual([...generateUID("1,2,3,4")], [0, 0, 1, 2, 3, 4]);
});

test("generateUID: phrase falls back to md5[0:6]", () => {
  assert.deepEqual([...generateUID("test")], [79, 4, 253, 130, 33, 85]);
});
