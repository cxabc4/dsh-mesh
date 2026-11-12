// End-to-end test: two real plugin runtimes, one real WebSocket, both directions.
//
// This is the acceptance test for the transport and the environment-sharing layer. Two
// independent identities are created in two state directories, they pair, one dials the
// other, and then over that single socket:
//
//   1. RPC works dialer → listener;
//   2. RPC works listener → dialer (the property that removes the need for a second
//      tunnel, and the one the phone-has-no-public-IP constraint depends on);
//   3. files can be listed / read / written across the link with conflict detection;
//   4. a command runs and returns its real exit code;
//   5. an out-of-root path is refused;
//   6. an interpreter is refused;
//   7. the remote audit journal records the calls;
//   8. disconnect + reconnect keeps the pairing and RPC resumes;
//   9. an unpaired peer is refused before any request can be made.
//
// The tests drive `MeshManager` directly (the same object `apply()` builds and hands to the
// tools), so the tool layer's behaviour is what is being exercised minus the JSON shaping.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { MeshManager } = await import("../lib/peer/manager.js");
const { createHandlers, MESH_METHODS } = await import("../lib/peer/handlers.js");
const { AuditLog } = await import("../lib/peer/capabilities.js");
const { resolveConfig } = await import("../lib/config.js");

const KEEP = new Set(["PATH", "HOME", "USERPROFILE", "SystemRoot", "windir", "TEMP", "TMP", "ComSpec", "PATHEXT", "LANG", "LC_ALL"]);

/** Build one full mesh runtime: manager + handler table, no Cordis involved. */
function buildNode(stateDir, { name, peers = [] }) {
  fs.mkdirSync(path.join(stateDir, "workspace"), { recursive: true });
  const config = resolveConfig({
    device: { name, stateDir },
    server: { enabled: true, host: "127.0.0.1", port: 0 },
    peers,
    permissions: {
      allowedRoots: [path.join(stateDir, "workspace")],
      allowWrite: true,
      allowExec: true,
      allowDelegate: false,
    },
    heartbeatIntervalMs: 5_000,
    requestTimeoutMs: 20_000,
    audit: { enabled: true, maxEntries: 500 },
  });
  const logs = [];
  const logger = {
    info: (message) => logs.push(`info:${message}`),
    warn: (message) => logs.push(`warn:${message}`),
    error: (message) => logs.push(`error:${message}`),
  };
  const audit = new AuditLog(config.audit.maxEntries);
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
          handler(typeof params === "object" && params !== null ? params : {}, context),
        );
      } catch {
        /* a reconnect re-uses the peer object only after a fresh one is built; a duplicate
           here means the same link reported ready twice, which is harmless */
      }
    }
  });
  return { manager, config, audit, logger, logs, handlers, stateDir };
}

async function waitFor(predicate, description, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return;
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${description}${last === undefined ? "" : ` (last error: ${last.message})`}`);
}

/** Bring up two nodes where only the second listens and the first dials it. */
async function bringUpPair({ unpaired = false } = {}) {
  const rootA = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-e2e-a-"));
  const rootB = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-e2e-b-"));
  // B is the "PC": it listens. A is the "phone": it dials out.
  const b = buildNode(rootB, { name: "beta" });
  await b.manager.start();
  const bUrl = `ws://127.0.0.1:${b.manager.snapshot().server.port}/dsh-mesh`;

  const a = buildNode(rootA, { name: "alpha", peers: [{ alias: "beta", url: bUrl, autoConnect: false }] });
  await a.manager.start();

  if (!unpaired) {
    const offer = b.manager.createPairingOffer(a.manager.deviceId);
    a.manager.acceptPairingString(offer.pairingString, "beta");
    a.manager.connect("beta");
    await waitFor(() => a.manager.resolvePeer("beta").online, "A's outbound link to B");
    await waitFor(() => b.manager.snapshot().peers.some((peer) => peer.state === "online"), "B to see the inbound link");
  }
  return { a, b, rootA, rootB, bUrl };
}

test("one socket carries RPC in both directions", async () => {
  const { a, b } = await bringUpPair();
  try {
    const aId = a.manager.deviceId;
    const bId = b.manager.deviceId;
    assert.notEqual(aId, bId, "each device has its own durable id");

    // 1. dialer -> listener
    const caps = await a.manager.request("beta", "mesh.capabilities", {}, { timeoutMs: 10_000 });
    assert.equal(caps.device.deviceId, bId, "A reached B");

    // 2. listener -> dialer over the SAME socket
    const inbound = b.manager.resolvePeer(undefined);
    assert.equal(inbound.online, true, "B sees the inbound link");
    const reverse = await inbound.rpc.request("mesh.capabilities", {}, { timeoutMs: 10_000 });
    assert.equal(reverse.device.deviceId, aId, "B called A back down the socket A opened");

    // 3. the peer's status confirms who dialed whom
    const aPeerToB = a.manager.snapshot().peers.find((peer) => peer.alias === "beta");
    assert.equal(aPeerToB.outbound, true, "A dialed out");
    const bPeerToA = b.manager.snapshot().peers.find((peer) => peer.state === "online");
    assert.equal(bPeerToA.outbound, false, "B accepted the connection");
  } finally {
    await a.manager.dispose();
    await b.manager.dispose();
  }
});

test("files cross the link with version conflict detection", async () => {
  const { a, b, rootB } = await bringUpPair();
  try {
    const remoteFile = path.join(rootB, "workspace", "notes.txt");
    const created = await a.manager.request(
      "beta",
      "mesh.fs.write",
      { path: remoteFile, content: "first line\n" },
      { timeoutMs: 10_000 },
    );
    assert.equal(created.created, true, "the remote device created the file");
    assert.equal(fs.readFileSync(remoteFile, "utf8"), "first line\n", "the bytes really landed on B's disk");

    const read = await a.manager.request("beta", "mesh.fs.read", { path: remoteFile }, { timeoutMs: 10_000 });
    assert.equal(read.content, "first line\n", "content round-trips byte for byte, trailing newline included");
    assert.equal(read.version, created.version, "the version we wrote is the version we read");

    // A stale expectedVersion must be refused, and the file must not change.
    await assert.rejects(
      a.manager.request(
        "beta",
        "mesh.fs.write",
        { path: remoteFile, content: "clobbered\n", expectedVersion: "0".repeat(64) },
        { timeoutMs: 10_000 },
      ),
      (error) => /VERSION_CONFLICT/.test(`${String(error.code)}: ${error.message}`),
      "a stale version is reported as a conflict",
    );
    assert.equal(fs.readFileSync(remoteFile, "utf8"), "first line\n", "the refused write left the file alone");

    // A write without any version must be refused when the file already exists.
    await assert.rejects(
      a.manager.request("beta", "mesh.fs.write", { path: remoteFile, content: "blind\n" }, { timeoutMs: 10_000 }),
      (error) => /VERSION_REQUIRED/.test(`${String(error.code)}: ${error.message}`),
      "overwriting without naming a version is refused",
    );

    // A correct version succeeds.
    const updated = await a.manager.request(
      "beta",
      "mesh.fs.write",
      { path: remoteFile, content: "second line\n", expectedVersion: read.version },
      { timeoutMs: 10_000 },
    );
    assert.equal(updated.replaced, true);
    assert.equal(fs.readFileSync(remoteFile, "utf8"), "second line\n");

    // Listing sees the file.
    const listing = await a.manager.request(
      "beta",
      "mesh.fs.list",
      { path: path.join(rootB, "workspace") },
      { timeoutMs: 10_000 },
    );
    assert.ok(listing.entries.some((entry) => entry.name === "notes.txt"), "the listing contains the file");

    // A path outside the allowed roots is refused, and so is escaping via "..".
    await assert.rejects(
      a.manager.request("beta", "mesh.fs.read", { path: path.join(rootB, "secret.txt") }, { timeoutMs: 8_000 }),
      (error) => /OUTSIDE_ROOTS|NOT_FOUND/.test(`${String(error.code)}: ${error.message}`),
      "a path outside allowedRoots is refused",
    );
    await assert.rejects(
      a.manager.request(
        "beta",
        "mesh.fs.read",
        { path: path.join(rootB, "workspace", "..", "..", "etc", "passwd") },
        { timeoutMs: 8_000 },
      ),
      (error) => /OUTSIDE_ROOTS|NOT_FOUND/.test(`${String(error.code)}: ${error.message}`),
      "traversal out of the root is refused",
    );
    await assert.rejects(
      a.manager.request("beta", "mesh.fs.read", { path: "relative/path.txt" }, { timeoutMs: 8_000 }),
      (error) => /RELATIVE_PATH/.test(`${String(error.code)}: ${error.message}`),
      "a relative path is refused (each device owns its own path semantics)",
    );
  } finally {
    await a.manager.dispose();
    await b.manager.dispose();
  }
});

test("commands run remotely and report their real exit code", async () => {
  const { a, b } = await bringUpPair();
  try {
    const ok = await a.manager.request(
      "beta",
      "mesh.exec",
      { command: "git --version", timeoutMs: 15_000 },
      { timeoutMs: 25_000 },
    );
    assert.equal(typeof ok.exitCode, "number", "a real exit code came back");
    assert.equal(ok.exitCode, 0, "git --version succeeds");
    assert.match(ok.stdout, /git version/i, "the real stdout of the remote process came back");

    // A failing command reports a non-zero exit code rather than an exception.
    const bad = await a.manager.request(
      "beta",
      "mesh.exec",
      { command: "git --definitely-not-a-flag", timeoutMs: 15_000 },
      { timeoutMs: 25_000 },
    );
    assert.notEqual(bad.exitCode, 0, "a failing command returns its non-zero exit code");
    assert.ok(bad.stderr.length > 0, "the failure explains itself on stderr");

    // Shells, interpreters, and script files are refused before a process is spawned.
    for (const command of [
      "powershell -NoProfile -Command whoami",
      "bash -c id",
      "node -e 1",
      "deploy.bat",
      "run.cmd",
    ]) {
      await assert.rejects(
        a.manager.request("beta", "mesh.exec", { command, timeoutMs: 5_000 }, { timeoutMs: 8_000 }),
        (error) =>
          /SHELL_NOT_ALLOWED|SCRIPT_NOT_ALLOWED|COMMAND_NOT_ALLOWED|COMMAND_DENIED/.test(
            `${String(error.code)}: ${error.message}`,
          ),
        `"${command}" is refused because a peer may not get a shell or a script`,
      );
    }
  } finally {
    await a.manager.dispose();
    await b.manager.dispose();
  }
});

test("the remote audit journal records who did what", async () => {
  const { a, b } = await bringUpPair();
  try {
    await a.manager.request("beta", "mesh.fs.list", { path: path.dirname(path.resolve(".")) }, { timeoutMs: 8_000 }).catch(() => {});
    const audit = await a.manager.request("beta", "mesh.audit", { limit: 50 }, { timeoutMs: 8_000 });
    assert.ok(audit.entries.length > 0, "the remote device recorded the peer's requests");
    assert.ok(
      audit.entries.every((entry) => typeof entry.peer === "string" && entry.peer.length > 0),
      "every audit row names the peer device",
    );
  } finally {
    await a.manager.dispose();
    await b.manager.dispose();
  }
});

test("disconnect and reconnect keeps the pairing and resumes RPC", async () => {
  const { a, b } = await bringUpPair();
  try {
    a.manager.disconnect("beta");
    await waitFor(() => !a.manager.resolvePeer("beta").online, "A to disconnect");
    // No RPC is possible while disconnected.
    await assert.rejects(
      a.manager.request("beta", "mesh.ping", {}, { timeoutMs: 3_000 }),
      (error) => /OFFLINE/.test(`${String(error.code)}: ${error.message}`),
      "a disconnected peer cannot be called",
    );
    a.manager.connect("beta");
    await waitFor(() => a.manager.resolvePeer("beta").online, "A to reconnect");
    const pong = await a.manager.request("beta", "mesh.ping", {}, { timeoutMs: 8_000 });
    assert.equal(typeof pong.pong, "number", "RPC resumes after a reconnect");
  } finally {
    await a.manager.dispose();
    await b.manager.dispose();
  }
});

test("an unpaired peer is refused before any request can run", async () => {
  const { a, b } = await bringUpPair({ unpaired: true });
  try {
    a.manager.connect("beta");
    await waitFor(() => {
      const status = a.manager.resolvePeer("beta").status();
      return status.state === "failed" || status.lastError?.code === "NOT_PAIRED";
    }, "the unpaired link to be refused");
    const status = a.manager.resolvePeer("beta").status();
    assert.equal(status.state, "failed", `unpaired peer is refused, not retried forever (${status.lastError?.code})`);
    assert.match(String(status.lastError?.code), /NOT_PAIRED|PAIRING/);
    await assert.rejects(
      a.manager.request("beta", "mesh.ping", {}, { timeoutMs: 3_000 }),
      (error) => /OFFLINE/.test(`${String(error.code)}: ${error.message}`),
      "no RPC is possible over an unauthenticated link",
    );
    // And the refusing side must not have accepted anything: the listener refused the
    // handshake, so B holds no online link for A.
    assert.equal(b.manager.snapshot().counts.online, 0, "the listener refused the handshake");
  } finally {
    await a.manager.dispose();
    await b.manager.dispose();
  }
});

test("a legitimate frame keeps the link healthy", async () => {
  const { a, b } = await bringUpPair();
  try {
    const link = a.manager.resolvePeer("beta");
    assert.equal(link.online, true);
    // Envelope-level rejection (bad MAC, replay, skew) is unit-tested in transport.test.mjs
    // where the crypto is reachable; here the point is that a normal frame does not disturb
    // the link, and that the reverse direction still answers afterwards.
    const pong = await a.manager.request("beta", "mesh.ping", {}, { timeoutMs: 8_000 });
    assert.equal(typeof pong.pong, "number");
    await waitFor(() => link.online, "the link to survive a legitimate frame");
    const inbound = b.manager.resolvePeer(undefined);
    const reverse = await inbound.rpc.request("mesh.ping", {}, { timeoutMs: 8_000 });
    assert.equal(reverse.device, a.manager.deviceId, "the reverse direction still works");
  } finally {
    await a.manager.dispose();
    await b.manager.dispose();
  }
});

export { KEEP };
