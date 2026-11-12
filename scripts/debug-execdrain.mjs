// Diagnostic: replicate the "commands run remotely" scenario WITHOUT process.exit, to see
// whether the event loop drains on its own. If this script exits, the leak is in the test
// harness usage; if it hangs, the plugin really is holding something after exec.
//
// Run: node scripts/debug-execdrain.mjs

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

const rootA = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-ed-a-"));
const rootB = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-ed-b-"));
const b = buildNode(rootB, { name: "beta" });
await b.manager.start();
const bUrl = `ws://127.0.0.1:${b.manager.snapshot().server.port}/dsh-mesh`;
const a = buildNode(rootA, { name: "alpha", peers: [{ alias: "beta", url: bUrl, autoConnect: false }] });
await a.manager.start();
const offer = b.manager.createPairingOffer(a.manager.deviceId);
a.manager.acceptPairingString(offer.pairingString, "beta");
a.manager.connect("beta");
await waitFor(() => a.manager.resolvePeer("beta").online, "online");

const ok = await a.manager.request("beta", "mesh.exec", { command: "git --version", timeoutMs: 15_000 }, { timeoutMs: 25_000 });
console.log("exec ok:", ok.exitCode, JSON.stringify(ok.stdout.trim()));

const bad = await a.manager.request("beta", "mesh.exec", { command: "git --definitely-not-a-flag", timeoutMs: 15_000 }, { timeoutMs: 25_000 });
console.log("exec bad:", bad.exitCode, JSON.stringify(bad.stderr.trim().slice(0, 60)));

for (const command of ["powershell -NoProfile -Command whoami", "bash -c id", "node -e 1"]) {
  await a.manager.request("beta", "mesh.exec", { command, timeoutMs: 5_000 }, { timeoutMs: 8_000 }).then(
    () => console.log("PROBLEM accepted:", command),
    (error) => console.log("refused:", command, error.code),
  );
}

await a.manager.dispose();
await b.manager.dispose();
console.log("disposed; waiting for the loop to drain (no process.exit)");
