// Focused probe: does a bare WebSocket + handshake actually complete in one process?
//
// The plugin-level debug script shows the listener going online while the dialer never
// does. This strips away manager/link bookkeeping and tests the three moving parts in
// isolation: the raw frame codec, the upgrade negotiation, and the handshake exchange.
//
// Run: node scripts/debug-ws.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { MeshServer, dialPeer } = await import("../lib/transport/server.js");
const { performHandshake } = await import("../lib/rpc/handshake.js");
const { loadOrCreateIdentity, openPairingStore, createPairing } = await import("../lib/security.js");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-ws-"));
const dirA = path.join(tmp, "a");
const dirB = path.join(tmp, "b");
fs.mkdirSync(dirA, { recursive: true });
fs.mkdirSync(dirB, { recursive: true });

const idA = loadOrCreateIdentity(dirA, "a");
const idB = loadOrCreateIdentity(dirB, "b");
const pairA = openPairingStore(dirA);
const pairB = openPairingStore(dirB);
const pairing = createPairing(idA.deviceId, idB.deviceId);
pairA.set(idB.deviceId, pairing);
pairB.set(idA.deviceId, pairing);

console.log("identity A:", idA.deviceId);
console.log("identity B:", idB.deviceId);

const inboundConnection = new Promise((resolve) => {
  const server = new MeshServer({ enabled: false, certPath: undefined, keyPath: undefined, fingerprintSha256: undefined }, (connection) => resolve(connection), (error) => console.error("listener error", error.message));
  server.start("127.0.0.1", 0).then(async (info) => {
    console.log("listening on", info.port);
    const dial = await dialPeer({ url: `ws://127.0.0.1:${info.port}/dsh-mesh`, fingerprintSha256: undefined, requirePinned: false, timeoutMs: 8000 });
    console.log("dial result:", dial.ok ? "ok" : `${dial.code} ${dial.error}`);
    if (!dial.ok) return;

    const clientOutcome = performHandshake(dial.connection, {
      identity: idA,
      pairingFor: (deviceId) => pairA.get(deviceId),
      expectedPeerId: idB.deviceId,
      capabilities: ["test"],
      version: "probe",
      timeoutMs: 8000,
    });
    const serverConnection = await inboundConnection;
    const serverOutcome = performHandshake(serverConnection, {
      identity: idB,
      pairingFor: (deviceId) => pairB.get(deviceId),
      expectedPeerId: undefined,
      capabilities: ["test"],
      version: "probe",
      timeoutMs: 8000,
    });

    const [a, b] = await Promise.all([clientOutcome, serverOutcome]);
    console.log("client handshake:", a.ok ? `ok peer=${a.peerId}` : `${a.code} ${a.message}`);
    console.log("server handshake:", b.ok ? `ok peer=${b.peerId}` : `${b.code} ${b.message}`);

    // Now prove the encrypted wire works in both directions on this one socket.
    if (a.ok && b.ok) {
      const { MeshWire } = await import("../lib/rpc/wire.js");
      const { RpcPeer } = await import("../lib/rpc/peer.js");
      const wireA = new MeshWire(dial.connection, a.keys, idA.deviceId, idB.deviceId);
      const wireB = new MeshWire(serverConnection, b.keys, idB.deviceId, idA.deviceId);
      const rpcA = new RpcPeer(wireA, 8000);
      const rpcB = new RpcPeer(wireB, 8000);
      rpcB.register("probe.echo", async (params) => ({ echoed: params }));
      rpcA.register("probe.ping", async () => ({ from: "A" }));
      const echo = await rpcA.request("probe.echo", { hello: "world" }, { timeoutMs: 5000 });
      console.log("A -> B:", JSON.stringify(echo));
      const ping = await rpcB.request("probe.ping", {}, { timeoutMs: 5000 });
      console.log("B -> A (same socket):", JSON.stringify(ping));
    }
    await server.stop();
    process.exit(0);
  });
});
