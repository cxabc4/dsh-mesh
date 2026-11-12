// Diagnostic: after a full bring-up + dispose cycle, report what is still keeping the
// process alive. A plugin that leaks a handle leaks it in DSH's Host process too, so this
// is worth pinning down rather than papering over with process.exit in the tests.
//
// Run: node scripts/debug-handles.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getActiveResourcesInfo } from "node:process";

const { MeshManager } = await import("../lib/peer/manager.js");
const { createHandlers, MESH_METHODS } = await import("../lib/peer/handlers.js");
const { AuditLog } = await import("../lib/peer/capabilities.js");
const { resolveConfig } = await import("../lib/config.js");

function buildNode(stateDir, { name, peers = [] }) {
  fs.mkdirSync(path.join(stateDir, "workspace"), { recursive: true });
  const config = resolveConfig({
    device: { name, stateDir },
    server: { enabled: true, host: "127.0.0.1", port: 0 },
    peers,
    permissions: { allowedRoots: [path.join(stateDir, "workspace")] },
    heartbeatIntervalMs: 5_000,
  });
  const logger = { info: () => {}, warn: () => {}, error: () => {} };
  const audit = new AuditLog(100);
  const manager = new MeshManager({ config, stateDir, audit, version: "0.1.0", logger, capabilities: () => [...MESH_METHODS] });
  const handlers = createHandlers({
    config,
    stateDir,
    audit,
    deviceId: () => manager.deviceId,
    capabilityDocument: () => manager.capabilityDocument(),
    taskRunner: () => undefined,
  });
  manager.onLinkReady((link) => {
    for (const [method, handler] of Object.entries(handlers)) {
      link.rpc.register(method, (params, context) => handler(params && typeof params === "object" ? params : {}, context));
    }
  });
  return { manager };
}

async function waitFor(predicate, label, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timeout waiting for ${label}`);
}

const rootA = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-h-a-"));
const rootB = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-h-b-"));
const b = buildNode(rootB, { name: "beta" });
await b.manager.start();
const bUrl = `ws://127.0.0.1:${b.manager.snapshot().server.port}/dsh-mesh`;
const a = buildNode(rootA, { name: "alpha", peers: [{ alias: "beta", url: bUrl, autoConnect: false }] });
await a.manager.start();
const offer = b.manager.createPairingOffer(a.manager.deviceId);
a.manager.acceptPairingString(offer.pairingString, "beta");
a.manager.connect("beta");
await waitFor(() => a.manager.resolvePeer("beta").online, "online");
console.log("connected; resources:", getActiveResourcesInfo().join(", "));

await a.manager.dispose();
await b.manager.dispose();
console.log("disposed; resources:", getActiveResourcesInfo().join(", "));

setTimeout(() => {
  console.log("after 2s; resources:", getActiveResourcesInfo().join(", "));
  const handles = process._getActiveHandles?.() ?? [];
  console.log("active handles:", handles.map((handle) => handle.constructor?.name ?? "?").join(", "));
  process.exit(0);
}, 2_000);
