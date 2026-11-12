// Example: drive dsh-mesh from a plain Node process, outside the DSH Host.
//
// Two uses for this:
//   1. smoke-testing an installed deployment without opening a DSH session;
//   2. a scripted probe for a tunnel: it dials the configured peer, prints the handshake
//      result, then runs one file list and one command so the whole pipe is proven.
//
// It requires the plugin's built lib/ and the same state directory the Host uses, so it
// sees the same identity and pairings. Run:
//   node examples/probe-peer.mjs "ws://127.0.0.1:8765/dsh-mesh"
//
// The peer must already be paired (see docs/guides/security.md); this script deliberately
// does not pair anything, because pairing is a human decision.

import path from "node:path";
import os from "node:os";

const url = process.argv[2];
if (url === undefined) {
  console.error("usage: node examples/probe-peer.mjs <ws:// or wss:// peer url>");
  process.exit(2);
}

// The state directory the Host uses; override with MESH_STATE_DIR when probing a
// non-default deployment.
const stateDir =
  process.env.MESH_STATE_DIR ?? path.join(process.env.DSH_HOME ?? os.homedir(), ".dsh", "mesh-probe");

const { MeshManager } = await import("../lib/peer/manager.js");
const { createHandlers, MESH_METHODS } = await import("../lib/peer/handlers.js");
const { AuditLog } = await import("../lib/peer/capabilities.js");
const { resolveConfig } = await import("../lib/config.js");

const config = resolveConfig({
  device: { name: "probe", stateDir },
  server: { enabled: false },
  peers: [{ alias: "peer", url, autoConnect: false }],
  permissions: { allowedRoots: [] },
  heartbeatIntervalMs: 10_000,
});
const logger = {
  info: (message) => console.log(`[mesh] ${message}`),
  warn: (message) => console.warn(`[mesh] ${message}`),
  error: () => {},
};
const audit = new AuditLog(100, (entry) => console.log(`[audit] ${JSON.stringify(entry)}`));
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
  for (const [method, handler] of Object.entries(handlers)) {
    try {
      link.rpc.register(method, (params, context) =>
        handler(params && typeof params === "object" ? params : {}, context),
      );
    } catch {
      // Already installed by an earlier handshake on this same peer object.
    }
  }
});

await manager.start();
console.log(`[mesh] local device id: ${manager.deviceId}`);
console.log(
  `[mesh] pairings: ${manager.listPairings().map((entry) => entry.deviceId).join(", ") || "(none)"}`,
);

manager.connect("peer");
const deadline = Date.now() + 20_000;
while (Date.now() < deadline) {
  const status = manager.resolvePeer("peer").status();
  if (status.state === "online") break;
  if (status.state === "failed") {
    console.error(`[mesh] link failed: ${status.lastError?.code}: ${status.lastError?.message}`);
    await manager.dispose();
    process.exit(1);
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
}

const status = manager.resolvePeer("peer").status();
if (status.state !== "online") {
  console.error(`[mesh] still ${status.state} after 20s`);
  await manager.dispose();
  process.exit(1);
}
console.log(
  `[mesh] online with ${status.remoteName} (${status.deviceId}), rtt ${status.roundTripMs ?? "?"}ms`,
);
console.log(`[mesh] peer serves ${status.methods.length} methods`);

// One read and one command: enough to prove the pipe end to end. Failures are printed
// rather than thrown, so a partially-permitted deployment still shows what works.
const probes = [
  ["capabilities", "mesh.capabilities", {}],
  ["list", "mesh.fs.list", { path: process.env.MESH_PROBE_PATH ?? "/" }],
  ["exec", "mesh.exec", { command: process.env.MESH_PROBE_COMMAND ?? "git --version" }],
];
for (const [label, method, params] of probes) {
  try {
    const value = await manager.request("peer", method, params, { timeoutMs: 20_000 });
    console.log(`[${label}] ${JSON.stringify(value).slice(0, 400)}`);
  } catch (error) {
    console.log(`[${label}] refused: ${error.code ?? "ERROR"} ${error.message}`);
  }
}

await manager.dispose();
console.log("[mesh] done");
