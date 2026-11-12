// Probe: run the e2e scenarios one at a time from a plain script, so a hang names itself.
//
// `node --test` buffers output until the file finishes, so a hang tells you nothing. This
// script prints each step and installs a watchdog; run it to see exactly which scenario
// stalls and where.
//
// Run: node scripts/debug-e2e.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { MeshManager } = await import("../lib/peer/manager.js");
const { createHandlers, MESH_METHODS } = await import("../lib/peer/handlers.js");
const { AuditLog } = await import("../lib/peer/capabilities.js");
const { resolveConfig } = await import("../lib/config.js");

const step = (label) => console.log(`>>> ${label}`);

function buildNode(stateDir, { name, peers = [] }) {
  fs.mkdirSync(path.join(stateDir, "workspace"), { recursive: true });
  const config = resolveConfig({
    device: { name, stateDir },
    server: { enabled: true, host: "127.0.0.1", port: 0 },
    peers,
    permissions: { allowedRoots: [path.join(stateDir, "workspace")], allowWrite: true, allowExec: true, allowDelegate: false },
    heartbeatIntervalMs: 5_000,
    requestTimeoutMs: 20_000,
  });
  const logger = { info: () => {}, warn: () => {}, error: () => {} };
  const audit = new AuditLog(500);
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
      try {
        link.rpc.register(method, (params, context) => handler(typeof params === "object" && params !== null ? params : {}, context));
      } catch (error) {
        console.log(`register ${method} failed: ${error.message}`);
      }
    }
  });
  return { manager };
}

async function waitFor(predicate, label, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return;
    } catch {
      /* keep polling */
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timeout waiting for ${label}`);
}

const watchdog = setTimeout(() => {
  console.log("!!! WATCHDOG: hung");
  process.exit(2);
}, 40_000);
watchdog.unref();

const rootA = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-ee-a-"));
const rootB = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-ee-b-"));
const b = buildNode(rootB, { name: "beta" });
await b.manager.start();
const bUrl = `ws://127.0.0.1:${b.manager.snapshot().server.port}/dsh-mesh`;
step(`B listening at ${bUrl}`);

const a = buildNode(rootA, { name: "alpha", peers: [{ alias: "beta", url: bUrl, autoConnect: false }] });
await a.manager.start();
step(`A identity ${a.manager.deviceId}, B identity ${b.manager.deviceId}`);

const offer = b.manager.createPairingOffer(a.manager.deviceId);
a.manager.acceptPairingString(offer.pairingString, "beta");
step("paired");
a.manager.connect("beta");
step("dialing");
await waitFor(() => a.manager.resolvePeer("beta").online, "A online");
step("A is online");
await waitFor(() => b.manager.snapshot().peers.some((peer) => peer.state === "online"), "B inbound online");
step("B sees inbound link");

step("1. dialer -> listener capabilities");
const caps = await a.manager.request("beta", "mesh.capabilities", {}, { timeoutMs: 10_000 });
step(`   ok: ${caps.device.deviceId}`);

step("2. listener -> dialer over the same socket");
const inbound = b.manager.resolvePeer(undefined);
const reverse = await inbound.rpc.request("mesh.capabilities", {}, { timeoutMs: 10_000 });
step(`   ok: ${reverse.device.deviceId}`);

step("3. write a file remotely");
const remoteFile = path.join(rootB, "workspace", "notes.txt");
const created = await a.manager.request("beta", "mesh.fs.write", { path: remoteFile, content: "first line\n" }, { timeoutMs: 10_000 });
step(`   ok: created=${created.created} version=${String(created.version).slice(0, 12)}`);
step(`   disk says: ${JSON.stringify(fs.readFileSync(remoteFile, "utf8"))}`);

step("4. read it back");
const read = await a.manager.request("beta", "mesh.fs.read", { path: remoteFile }, { timeoutMs: 10_000 });
step(`   ok: content=${JSON.stringify(read.content)}`);

step("5. stale write is refused");
try {
  await a.manager.request("beta", "mesh.fs.write", { path: remoteFile, content: "x", expectedVersion: "0".repeat(64) }, { timeoutMs: 8_000 });
  step("   PROBLEM: stale write was accepted");
} catch (error) {
  step(`   ok: ${error.code} ${error.message.slice(0, 60)}`);
}

step("6. out-of-root read is refused");
try {
  await a.manager.request("beta", "mesh.fs.read", { path: path.join(rootB, "secret.txt") }, { timeoutMs: 8_000 });
  step("   PROBLEM: out-of-root read was accepted");
} catch (error) {
  step(`   ok: ${error.code}`);
}

step("7. run git --version remotely");
const exec = await a.manager.request("beta", "mesh.exec", { command: "git --version", timeoutMs: 15_000 }, { timeoutMs: 25_000 });
step(`   ok: exit=${exec.exitCode} out=${JSON.stringify(exec.stdout.trim())}`);

step("8. a shell is refused");
try {
  await a.manager.request("beta", "mesh.exec", { command: "powershell -Command whoami" }, { timeoutMs: 8_000 });
  step("   PROBLEM: shell was accepted");
} catch (error) {
  step(`   ok: ${error.code}`);
}

step("9. audit");
const auditResult = await a.manager.request("beta", "mesh.audit", { limit: 20 }, { timeoutMs: 8_000 });
step(`   ok: ${auditResult.entries.length} rows`);

step("10. disconnect");
a.manager.disconnect("beta");
await waitFor(() => !a.manager.resolvePeer("beta").online, "A offline");
step("   ok: offline");
step("11. reconnect");
a.manager.connect("beta");
await waitFor(() => a.manager.resolvePeer("beta").online, "A reconnected");
const pong = await a.manager.request("beta", "mesh.ping", {}, { timeoutMs: 8_000 });
step(`   ok: ${JSON.stringify(pong)}`);

step("12. dispose");
await a.manager.dispose();
await b.manager.dispose();
clearTimeout(watchdog);
step("done");
process.exit(0);
