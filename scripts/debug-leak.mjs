// Diagnostic: does running a remote command leave a live handle behind?
//
// The e2e "commands run remotely" scenario passes its assertions and then the test runner
// never exits, which means something is still attached to the event loop. This script
// reproduces just that path and prints the surviving handles; it deliberately does NOT call
// process.exit, so a leak shows up as the process simply staying alive.
//
// Run: node scripts/debug-leak.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
    permissions: { allowedRoots: [path.join(stateDir, "workspace")], allowExec: true },
    heartbeatIntervalMs: 5_000,
    requestTimeoutMs: 20_000,
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

const describe = (label) => {
  const handles = process._getActiveHandles?.() ?? [];
  console.log(
    `${label}: ${handles.map((handle) => handle.constructor?.name ?? "?").join(", ") || "(none)"} | resources: ${process.getActiveResourcesInfo().join(", ") || "(none)"}`,
  );
};

describe("baseline");
const rootA = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-leak-a-"));
const rootB = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-leak-b-"));
const b = buildNode(rootB, { name: "beta" });
await b.manager.start();
const bUrl = `ws://127.0.0.1:${b.manager.snapshot().server.port}/dsh-mesh`;
const a = buildNode(rootA, { name: "alpha", peers: [{ alias: "beta", url: bUrl, autoConnect: false }] });
await a.manager.start();
const offer = b.manager.createPairingOffer(a.manager.deviceId);
a.manager.acceptPairingString(offer.pairingString, "beta");
a.manager.connect("beta");
await waitFor(() => a.manager.resolvePeer("beta").online, "online");
describe("after connect");

const result = await a.manager.request("beta", "mesh.exec", { command: "git --version", timeoutMs: 10_000 }, { timeoutMs: 20_000 });
console.log("exec:", result.exitCode, JSON.stringify(result.stdout.trim()));
describe("after exec");

await a.manager.dispose();
await b.manager.dispose();
describe("after dispose");

setTimeout(() => {
  describe("2s later");
  const handles = process._getActiveHandles?.() ?? [];
  for (const handle of handles) {
    const name = handle.constructor?.name ?? "?";
    console.log("  handle", name, {
      destroyed: handle.destroyed,
      localPort: handle.localPort,
      remotePort: handle.remotePort,
      fd: handle.fd,
      hasRef: typeof handle.hasRef === "function" ? handle.hasRef() : undefined,
    });
  }
}, 2_000);
