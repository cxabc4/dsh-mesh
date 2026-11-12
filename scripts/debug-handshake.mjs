// Debug probe: trace a two-instance handshake step by step, printing each state.
//
// The e2e test hung rather than failed, which means a promise never settled. This script
// narrows it down: it starts both listeners, pairs, dials, and prints every state change
// with a hard 15s deadline so a stuck path reports itself instead of hanging the shell.
//
// Run: node scripts/debug-handshake.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { MeshManager } = await import("../lib/peer/manager.js");
const { createHandlers, MESH_METHODS } = await import("../lib/peer/handlers.js");
const { AuditLog } = await import("../lib/peer/capabilities.js");
const { resolveConfig } = await import("../lib/config.js");

const log = (line) => console.log(`[${new Date().toISOString().slice(11, 23)}] ${line}`);

function buildNode(stateDir, name, peers = []) {
  fs.mkdirSync(path.join(stateDir, "workspace"), { recursive: true });
  const config = resolveConfig({
    device: { name, stateDir },
    server: { enabled: true, host: "127.0.0.1", port: 0 },
    peers,
    permissions: { allowedRoots: [path.join(stateDir, "workspace")], allowDelegate: false },
    heartbeatIntervalMs: 3_000,
    requestTimeoutMs: 20_000,
  });
  const logger = { info: (m) => log(`  ${name}: ${m}`), warn: (m) => log(`  ${name} WARN: ${m}`), error: () => {} };
  const audit = new AuditLog(100);
  const manager = new MeshManager({
    config,
    stateDir,
    audit,
    version: "0.1.0",
    logger,
    capabilities: () => [...MESH_METHODS],
  });
  const handlers = createHandlers({
    config,
    stateDir,
    audit,
    deviceId: () => manager.deviceId,
    capabilityDocument: () => manager.capabilityDocument(),
    taskRunner: () => undefined,
  });
  manager.onLinkReady((link) => {
    log(`  ${name}: link ready (${link.alias}) -> installing ${Object.keys(handlers).length} handlers`);
    for (const [method, handler] of Object.entries(handlers)) {
      try {
        link.rpc.register(method, (params, context) => handler(params && typeof params === "object" ? params : {}, context));
      } catch (error) {
        log(`  ${name}: register ${method} failed: ${error.message}`);
      }
    }
  });
  manager.onChange(() => {
    try {
      const peers = manager.snapshot().peers.map((peer) => `${peer.alias}=${peer.state}`).join(",");
      log(`  ${name}: change peers[${peers}]`);
    } catch {
      /* ignore */
    }
  });
  return { manager };
}

const roots = {
  a: fs.mkdtempSync(path.join(os.tmpdir(), "mesh-dbg-a-")),
  b: fs.mkdtempSync(path.join(os.tmpdir(), "mesh-dbg-b-")),
};

const deadline = setTimeout(() => {
  log("DEADLINE: something never settled");
  process.exit(1);
}, 15_000);
deadline.unref();

const b = buildNode(roots.b, "beta");
await b.manager.start();
log(`beta listening on port ${b.manager.snapshot().server.port}, id ${b.manager.deviceId}`);

const a = buildNode(roots.a, "alpha");
await a.manager.start();
log(`alpha id ${a.manager.deviceId}`);

const offer = b.manager.createPairingOffer(a.manager.deviceId);
log(`beta offered pairing code ${offer.code}`);
a.manager.acceptPairingString(offer.pairingString, "beta");
log(`alpha accepted the pairing`);

const dialer = buildNode(roots.a, "alpha", [{ alias: "beta", url: `ws://127.0.0.1:${b.manager.snapshot().server.port}/dsh-mesh`, autoConnect: false }]);
await dialer.manager.start();
log(`dialer started with id ${dialer.manager.deviceId}`);

dialer.manager.connect("beta");
log("dialing beta...");

for (let index = 0; index < 100; index += 1) {
  const status = dialer.manager.resolvePeer("beta").status();
  if (status.state === "online") {
    log(`ONLINE: ${JSON.stringify(status.lastError ?? null)} methods=${status.methods.length}`);
    break;
  }
  if (status.state === "failed") {
    log(`FAILED: ${JSON.stringify(status.lastError)}`);
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
}

const online = dialer.manager.resolvePeer("beta").online;
log(`dialer online=${online}`);
if (online) {
  const pong = await dialer.manager.request("beta", "mesh.ping", {}, { timeoutMs: 5_000 }).catch((error) => ({ error: error.message }));
  log(`ping result: ${JSON.stringify(pong)}`);
}

await dialer.manager.dispose();
await a.manager.dispose();
await b.manager.dispose();
clearTimeout(deadline);
log("done");
