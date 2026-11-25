// One paste should configure everything when the minting device advertised its address:
// the pairing secret, the route, and the trust policy. Without an address it still pairs,
// and says what is missing.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MeshManager } from "../lib/peer/manager.js";
import { resolveConfig } from "../lib/config.js";

/** Two managers with separate state directories; the caller disposes them. */
function pair(publicUrl) {
  const dirA = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-onepaste-a-"));
  const dirB = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-onepaste-b-"));
  const audit = { record() {} };
  const logger = { info() {}, warn() {}, error() {} };
  const a = new MeshManager({
    config: resolveConfig({
      device: { name: "PC" },
      server: { enabled: false, port: 0, ...(publicUrl === undefined ? {} : { publicUrl }), tls: { certificatePolicy: "system" } },
      peers: [],
    }),
    stateDir: dirA, audit, version: "0.4.0", logger, capabilities: () => [],
  });
  const b = new MeshManager({
    config: resolveConfig({ device: { name: "Phone" }, server: { enabled: false, port: 0 }, peers: [] }),
    stateDir: dirB, audit, version: "0.4.0", logger, capabilities: () => [],
  });
  return { a, b, dirs: [dirA, dirB] };
}

async function cleanup(handle) {
  await handle.a.dispose();
  await handle.b.dispose();
  for (const dir of handle.dirs) fs.rmSync(dir, { recursive: true, force: true });
}

test("with an advertised address, one accept installs the route too", async () => {
  const handle = pair("wss://tunnel.example:46999/dsh-mesh");
  try {
    const offer = handle.a.createPairingJson(handle.b.deviceId);
    assert.notEqual(offer.json.peerConfig, undefined, "the payload carries the route");
    assert.equal(offer.json.peerConfig.url, "wss://tunnel.example:46999/dsh-mesh");
    assert.equal(offer.json.peerConfig.certificatePolicy, "system", "trust policy travels with the route");

    const accepted = handle.b.acceptPairingPayload(JSON.stringify(offer.json));
    assert.equal(accepted.peerId, handle.a.deviceId);
    assert.notEqual(accepted.peer, undefined, "accept reports the configured link");
    const peers = handle.b.snapshot().peers;
    assert.equal(peers.length, 1, "exactly one link, not an inbound placeholder plus a route");
    assert.equal(peers[0].alias, offer.json.peerConfig.alias);
    assert.equal(peers[0].url, "wss://tunnel.example:46999/dsh-mesh");
  } finally {
    await cleanup(handle);
  }
});

test("a bare host is completed to the mesh path", async () => {
  const handle = pair("wss://tunnel.example:46999");
  try {
    const offer = handle.a.createPairingJson(handle.b.deviceId);
    assert.equal(offer.json.peerConfig.url, "wss://tunnel.example:46999/dsh-mesh");
  } finally {
    await cleanup(handle);
  }
});

test("without an advertised address the payload still pairs and stays inbound-only", async () => {
  const handle = pair(undefined);
  try {
    const offer = handle.a.createPairingJson(handle.b.deviceId);
    assert.equal(offer.json.peerConfig, undefined);
    assert.equal(offer.json.configureWith, undefined, "no route means nothing to configure");
    const accepted = handle.b.acceptPairingPayload(JSON.stringify(offer.json));
    assert.equal(accepted.peer, undefined);
    const peers = handle.b.snapshot().peers;
    assert.equal(peers.length, 1, "the inbound-only link exists");
    assert.equal(peers[0].url, undefined, "and it has no dial address");
  } finally {
    await cleanup(handle);
  }
});

test("a payload addressed to another device is refused", async () => {
  const handle = pair("wss://tunnel.example:46999/dsh-mesh");
  try {
    const offer = handle.a.createPairingJson(handle.b.deviceId);
    const wrong = { ...offer.json, peer: "zzzzzz-zzzzzz-zzzzzz-zzzzzz" };
    await assert.rejects(
      async () => handle.b.acceptPairingPayload(JSON.stringify(wrong)),
      (error) => error.code === "PAIRING_ADDRESSED_ELSEWHERE",
      "the peer field is checked",
    );
  } finally {
    await cleanup(handle);
  }
});
