// The Host validates tool output by requiring a lossless JSON round trip: parse(stringify(v))
// must equal v. An `undefined` property fails that, because stringify drops the key while
// the object still has it — so a handler that ran fine is reported as a failed call. These
// tests walk every tool's output through the same check, using a manager whose optional
// fields are genuinely absent.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MeshManager } from "../lib/peer/manager.js";
import { resolveConfig } from "../lib/config.js";
import { createTools } from "../lib/tools/mesh-tools.js";

/** True when the value survives a JSON round trip unchanged. */
function isLossless(value) {
  const round = JSON.parse(JSON.stringify(value ?? null));
  return JSON.stringify(round) === JSON.stringify(value ?? null);
}

function makeManager() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-lossless-"));
  const manager = new MeshManager({
    config: resolveConfig({ device: { name: "test" }, server: { enabled: false, port: 0 }, peers: [] }),
    stateDir: dir,
    audit: { record() {} },
    version: "0.4.0",
    logger: { info() {}, warn() {}, error() {} },
    capabilities: () => ["mesh.ping"],
  });
  return { manager, dir };
}

test("mesh_status output survives the lossless check with no listener and no peers", async () => {
  const { manager, dir } = makeManager();
  try {
    const tool = createTools({
      manager,
      ledger: { append() {}, list: () => [], get: () => undefined },
      delegationAvailable: () => false,
      delegate: async () => ({ taskId: "x" }),
      log: { info() {}, warn() {}, error() {} },
    }).find((entry) => entry.name === "mesh_status");
    const value = await tool.execute({}, { signal: AbortSignal.abort() });
    assert.equal(isLossless(value), true, "no undefined may survive: " + JSON.stringify(Object.keys(value.server)));
  } finally {
    await manager.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("mesh_pair list output survives the lossless check with no pairings and no peers", async () => {
  const { manager, dir } = makeManager();
  try {
    const tool = createTools({
      manager,
      ledger: { append() {}, list: () => [], get: () => undefined },
      delegationAvailable: () => false,
      delegate: async () => ({ taskId: "x" }),
      log: { info() {}, warn() {}, error() {} },
    }).find((entry) => entry.name === "mesh_pair");
    const value = await tool.execute({ action: "list" }, { signal: AbortSignal.abort() });
    assert.equal(isLossless(value), true);
    assert.equal(value.deviceId, manager.deviceId);
  } finally {
    await manager.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("mesh_pair create output survives the lossless check without an advertised address", async () => {
  const { manager, dir } = makeManager();
  try {
    const tool = createTools({
      manager,
      ledger: { append() {}, list: () => [], get: () => undefined },
      delegationAvailable: () => false,
      delegate: async () => ({ taskId: "x" }),
      log: { info() {}, warn() {}, error() {} },
    }).find((entry) => entry.name === "mesh_pair");
    const value = await tool.execute(
      { action: "create", device: "eeeeee-ffffff-gggggg-hhhhhh" },
      { signal: AbortSignal.abort() },
    );
    assert.equal(isLossless(value), true);
    assert.equal(typeof value.code, "string");
    assert.equal(value.pairingJson.kind, "dsh-mesh.pairing");
  } finally {
    await manager.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
