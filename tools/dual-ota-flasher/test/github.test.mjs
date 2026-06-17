import { test } from "node:test";
import assert from "node:assert/strict";
import { dispatchBuild, fetchArtifactBin } from "../github.js";

const repo = { owner: "me", repo: "ELRS" };

test("dispatchBuild POSTs workflow_dispatch with ref + inputs + auth", async () => {
  const calls = [];
  const fetchFn = async (url, opts) => { calls.push({ url, opts }); return { ok: true, status: 204 }; };
  await dispatchBuild({ repo, token: "T", workflow: "flasher-build.yml",
    ref: "dual-ota-builder", inputs: { branch: "v4", env: "E", run_tag: "abc", checkout_ref: "lua-slot/v4" }, fetchFn });
  assert.equal(calls[0].url, "https://api.github.com/repos/me/ELRS/actions/workflows/flasher-build.yml/dispatches");
  assert.equal(calls[0].opts.method, "POST");
  assert.match(calls[0].opts.headers.Authorization, /Bearer T/);
  const body = JSON.parse(calls[0].opts.body);
  assert.equal(body.ref, "dual-ota-builder");
  assert.equal(body.inputs.run_tag, "abc");
});

test("fetchArtifactBin resolves path -> blob sha -> base64 bytes", async () => {
  const b64 = Buffer.from([1, 2, 3, 4]).toString("base64");
  const fetchFn = async (url) => {
    if (url.includes("/contents/")) return { ok: true, json: async () => ({ sha: "deadbeef" }) };
    if (url.includes("/git/blobs/")) return { ok: true, json: async () => ({ content: b64, encoding: "base64" }) };
    throw new Error("unexpected " + url);
  };
  const bytes = await fetchArtifactBin({ repo, token: "T", branch: "flasher-artifacts",
    path: "v4/E/firmware.bin", fetchFn });
  assert.deepEqual([...bytes], [1, 2, 3, 4]);
});
