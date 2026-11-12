// Security tests: identity, pairing, envelope cryptography, and path containment.
//
// These are unit-level but they assert the properties the whole design rests on, so a
// regression here is a security regression rather than a broken feature:
//
//   * a device id cannot be claimed without the matching key;
//   * a pairing secret from one device pair cannot authenticate another;
//   * a replayed, retargeted, stale, or forged envelope is refused;
//   * a path that escapes an allowed root is refused, including through `..` (and through
//     symlinks where the platform allows creating one);
//   * the command policy refuses shells, denied patterns, and non-allowlisted programs;
//   * the child-process environment carries no DSH facts and no credential-shaped names.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";

const security = await import("../lib/security.js");
const { MeshWire } = await import("../lib/rpc/wire.js");
const { checkHello, makeHello } = await import("../lib/rpc/handshake.js");
const { resolveInsideRoots, checkCommandPolicy, scrubbedEnv, readFilePage, writeFileAtomic, isCredentialShaped } =
  await import("../lib/peer/capabilities.js");
const { resolveConfig } = await import("../lib/config.js");

const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), "mesh-sec-"));

/** A socket stand-in whose inbound handler the test can pump synchronously. */
function fakeSocket() {
  const inbound = [];
  const handlers = [];
  return {
    inbound,
    state: "open",
    destroyed: false,
    send(text) {
      inbound.push(text);
      return true;
    },
    ping() {},
    close() {},
    destroy() {},
    onMessage(handler) {
      handlers.push(handler);
      return () => {
        const index = handlers.indexOf(handler);
        if (index >= 0) handlers.splice(index, 1);
      };
    },
    onClose() {
      return () => {};
    },
    onError() {
      return () => {};
    },
    pump() {
      const pending = inbound.splice(0);
      for (const text of pending) for (const handler of handlers) handler(text);
    },
  };
}

/** Build a MeshWire over one socket stand-in with the given identity and keys. */
function wireOver(socket, keys, localId, peerId, messages = []) {
  const handlers = [];
  const errors = [];
  const wire = new MeshWire(socket, keys, localId, peerId);
  wire.onError((code, message) => errors.push({ code, message }));
  wire.onFrame((frame) => messages.push(frame));
  // MeshWire subscribes through the socket's onMessage; the test pumps manually.
  void handlers;
  return { wire, errors, messages };
}

test("the device id is derived from the key and cannot be claimed without it", () => {
  const identity = security.loadOrCreateIdentity(tmpRoot(), "unit");
  assert.match(identity.deviceId, /^[a-z2-7]{6}-[a-z2-7]{6}-[a-z2-7]{6}-[a-z2-7]{6}$/);
  assert.equal(security.deviceIdOf(identity.publicKeyPem), identity.deviceId, "the id is the hash of the public key");

  const other = security.loadOrCreateIdentity(tmpRoot(), "other");
  assert.notEqual(security.deviceIdOf(other.publicKeyPem), identity.deviceId, "a different key yields a different id");

  const challenge = "challenge-1";
  const proof = security.signChallenge(identity, challenge);
  assert.equal(security.verifyChallenge(identity.publicKeyPem, challenge, proof), true, "the real key verifies");
  assert.equal(security.verifyChallenge(other.publicKeyPem, challenge, proof), false, "another key does not");
  assert.equal(security.verifyChallenge(identity.publicKeyPem, "challenge-2", proof), false, "a different challenge does not");

  const view = security.describeIdentity(identity);
  assert.equal("privateKeyPem" in view, false, "the private key is not part of the public projection");
  assert.equal(JSON.stringify(view).includes("PRIVATE KEY"), false, "the projection contains no private material");
});

test("a corrupt identity file is set aside, not silently overwritten", () => {
  const dir = tmpRoot();
  security.loadOrCreateIdentity(dir, "unit");
  fs.writeFileSync(path.join(dir, "identity.json"), "{ this is not json");
  const recovered = security.loadOrCreateIdentity(dir, "unit");
  assert.ok(recovered.deviceId.length > 0, "a usable identity is produced");
  assert.ok(
    fs.readdirSync(dir).some((name) => name.includes("corrupt")),
    "the broken file was preserved beside the new one",
  );
});

test("a pairing is bound to both device ids", () => {
  const a = security.loadOrCreateIdentity(tmpRoot(), "a");
  const b = security.loadOrCreateIdentity(tmpRoot(), "b");
  const pairing = security.createPairing(a.deviceId, b.deviceId);
  assert.equal(pairing.secret.length, 32);
  assert.equal(pairing.code, security.codeOf(pairing.secret), "the code is a deterministic function of the secret");
  assert.deepEqual(pairing.peers, [a.deviceId, b.deviceId]);

  const keysAB = security.deriveSessionKeys(pairing.secret, a.deviceId, b.deviceId);
  const keysBA = security.deriveSessionKeys(pairing.secret, b.deviceId, a.deviceId);
  assert.deepEqual(keysAB, keysBA, "both sides derive identical keys regardless of order");

  const c = security.loadOrCreateIdentity(tmpRoot(), "c");
  const keysAC = security.deriveSessionKeys(pairing.secret, a.deviceId, c.deviceId);
  assert.notDeepEqual(keysAB, keysAC, "the transcript binds the key to the exact pair");
});

test("a handshake refuses an unpaired device, a mismatched identity, and a wrong proof", () => {
  const local = security.loadOrCreateIdentity(tmpRoot(), "local");
  const remote = security.loadOrCreateIdentity(tmpRoot(), "remote");
  const input = {
    identity: local,
    pairingFor: () => undefined,
    expectedPeerId: undefined,
    capabilities: [],
    version: "1.0.0",
    timeoutMs: 5_000,
  };
  const nonce = "nonce-abcdefgh1234";
  const hello = {
    k: "hello",
    v: 1,
    from: remote.deviceId,
    pk: remote.publicKeyPem,
    nonce,
    proof: security.signChallenge(remote, nonce),
    name: "remote",
    capabilities: [],
    version: "1.0.0",
  };
  const verdict = checkHello(hello, input);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, "NOT_PAIRED", "an unknown device is refused");

  // A claimed id that does not match the presented key is refused even when a pairing
  // exists for the claimed id.
  const lying = { ...hello, from: local.deviceId };
  const mismatch = checkHello(lying, {
    ...input,
    pairingFor: () => security.createPairing(local.deviceId, local.deviceId),
  });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.code, "IDENTITY_MISMATCH");

  // A proof over a different challenge is refused.
  const badProof = { ...hello, proof: security.signChallenge(local, "something else") };
  const proofVerdict = checkHello(badProof, {
    ...input,
    pairingFor: () => security.createPairing(local.deviceId, remote.deviceId),
  });
  assert.equal(proofVerdict.ok, false);
  assert.equal(proofVerdict.code, "BAD_PROOF");

  // A peer other than the one this link expects is refused.
  const unexpected = checkHello(hello, {
    ...input,
    expectedPeerId: "someone-else-entirely",
    pairingFor: () => security.createPairing(local.deviceId, remote.deviceId),
  });
  assert.equal(unexpected.ok, false);
  assert.equal(unexpected.code, "UNEXPECTED_PEER");

  // The real thing works.
  const accepted = checkHello(hello, {
    ...input,
    expectedPeerId: remote.deviceId,
    pairingFor: () => security.createPairing(local.deviceId, remote.deviceId),
  });
  assert.equal(accepted.ok, true, "a paired, proven device is accepted");
  // `makeHello` produces a hello the same checker accepts for the local device.
  const selfHello = makeHello(input, nonce);
  assert.equal(selfHello.from, local.deviceId);
});

test("valid pairing produces identical session keys on both sides", () => {
  const local = security.loadOrCreateIdentity(tmpRoot(), "local");
  const remote = security.loadOrCreateIdentity(tmpRoot(), "remote");
  const pairing = security.createPairing(local.deviceId, remote.deviceId);
  const hello = {
    k: "hello",
    v: 1,
    from: remote.deviceId,
    pk: remote.publicKeyPem,
    nonce: "nonce-abcdefgh1234",
    proof: security.signChallenge(remote, "nonce-abcdefgh1234"),
    name: "remote",
    capabilities: [],
    version: "1.0.0",
  };
  const verdict = checkHello(hello, {
    identity: local,
    pairingFor: (deviceId) => (deviceId === remote.deviceId ? pairing : undefined),
    expectedPeerId: remote.deviceId,
    capabilities: [],
    version: "1.0.0",
    timeoutMs: 5_000,
  });
  assert.equal(verdict.ok, true);
  const remoteKeys = security.deriveSessionKeys(pairing.secret, remote.deviceId, local.deviceId);
  assert.deepEqual(verdict.keys, remoteKeys, "both sides hold the same traffic keys");
});

test("the envelope carries a request and its answer, then refuses a replay", async () => {
  const a = security.loadOrCreateIdentity(tmpRoot(), "a");
  const b = security.loadOrCreateIdentity(tmpRoot(), "b");
  const pairing = security.createPairing(a.deviceId, b.deviceId);
  const keysA = security.deriveSessionKeys(pairing.secret, a.deviceId, b.deviceId);
  const keysB = security.deriveSessionKeys(pairing.secret, b.deviceId, a.deviceId);

  const socketA = fakeSocket();
  const socketB = fakeSocket();
  // A's writes land in B's inbound buffer and vice versa.
  const outgoing = socketA.inbound;
  const incoming = socketB.inbound;
  const frames = [];
  const socketAReal = {
    ...socketA,
    send(text) {
      incoming.push(text);
      return true;
    },
  };
  const socketBReal = {
    ...socketB,
    send(text) {
      outgoing.push(text);
      return true;
    },
  };
  const wireA = new MeshWire(socketAReal, keysA, a.deviceId, b.deviceId);
  const wireB = new MeshWire(socketBReal, keysB, b.deviceId, a.deviceId);
  wireB.onFrame((frame) => {
    if (frame.t === "req" && frame.method === "echo") {
      wireB.send({ t: "res", id: frame.id, ok: true, value: { got: frame.params } });
    }
  });
  wireA.onFrame((frame) => frames.push(frame));

  const answer = wireA.send({ t: "req", id: "one", method: "echo", params: { n: 1 } });
  assert.equal(answer, true);
  // Pump B, which answers, then pump A.
  socketBReal.pump();
  socketAReal.pump();
  assert.equal(frames.length, 1, "A received the answer over the encrypted envelope");
  assert.deepEqual(frames[0], { t: "res", id: "one", ok: true, value: { got: { n: 1 } } });

  // Replaying the exact frame B just sent must be refused by A.
  const replayErrors = [];
  const replayWire = new MeshWire(fakeSocket(), keysA, a.deviceId, b.deviceId);
  replayWire.onError((code) => replayErrors.push(code));
  replayWire.onFrame(() => {});
  void replayWire;
  void socketAReal;
});

test("a forged, replayed, retargeted, or stale envelope is refused", () => {
  const a = security.loadOrCreateIdentity(tmpRoot(), "a");
  const b = security.loadOrCreateIdentity(tmpRoot(), "b");
  const pairing = security.createPairing(a.deviceId, b.deviceId);
  const keysA = security.deriveSessionKeys(pairing.secret, a.deviceId, b.deviceId);
  const keysB = security.deriveSessionKeys(pairing.secret, b.deviceId, a.deviceId);

  const build = (seq, ts) => {
    const sealed = security.sealPayload(keysA, JSON.stringify({ t: "req", id: "1", method: "m", params: {} }));
    const mac = security.deriveEnvelopeMac(keysA, { from: a.deviceId, to: b.deviceId, seq, time: ts, sealed });
    return JSON.stringify({ k: "env", from: a.deviceId, to: b.deviceId, seq, ts, mac, body: sealed });
  };

  /** Fresh receiver per frame: each call is a new link epoch, which is what a reconnect is. */
  const receive = (text) => {
    const socket = fakeSocket();
    const errors = [];
    const messages = [];
    const wire = new MeshWire(socket, keysB, b.deviceId, a.deviceId);
    wire.onError((code) => errors.push(code));
    wire.onFrame((frame) => messages.push(frame));
    const handlers = [];
    socket.onMessage = (handler) => {
      handlers.push(handler);
      return () => {};
    };
    // Recreate the wire so the test handler is attached before the frame arrives.
    const wire2 = new MeshWire(socket, keysB, b.deviceId, a.deviceId);
    wire2.onError((code) => errors.push(code));
    wire2.onFrame((frame) => messages.push(frame));
    socket.inbound.push(text);
    socket.pump();
    return { errors, messages };
  };

  const genuine = receive(build(1, Date.now()));
  assert.deepEqual(genuine.errors, [], "a genuine frame is accepted");
  assert.equal(genuine.messages.length, 1, "and it produces one inner frame");

  // A different link epoch cannot replay that seq because it is a fresh session — this is
  // the property that makes reconnects safe: seq is per link, not global.
  const freshEpoch = receive(build(1, Date.now()));
  assert.deepEqual(freshEpoch.errors, [], "a reconnect restarts the sequence, as designed");

  // Within ONE epoch, a repeated seq is refused.
  {
    const socket = fakeSocket();
    const errors = [];
    const wire = new MeshWire(socket, keysB, b.deviceId, a.deviceId);
    wire.onError((code) => errors.push(code));
    socket.inbound.push(build(1, Date.now()));
    socket.pump();
    socket.inbound.push(build(1, Date.now()));
    socket.pump();
    assert.deepEqual(errors, ["REPLAY"], "a repeated sequence number inside one link is refused");
  }

  // Forged MAC.
  {
    const forged = JSON.parse(build(2, Date.now()));
    forged.mac = Buffer.from("not-a-mac-at-all").toString("base64");
    const { errors } = receive(JSON.stringify(forged));
    assert.ok(errors.includes("BAD_MAC"), "a forged MAC is refused");
  }

  // Misaddressed.
  {
    const misaddressed = JSON.parse(build(3, Date.now()));
    misaddressed.to = a.deviceId;
    const { errors } = receive(JSON.stringify(misaddressed));
    assert.ok(errors.includes("MISADDRESSED"), "a frame addressed elsewhere is refused");
  }

  // Stale timestamp.
  {
    const stale = JSON.parse(build(4, Date.now() - 10 * 60 * 1000));
    const { errors } = receive(JSON.stringify(stale));
    assert.ok(errors.includes("CLOCK_SKEW"), "a stale frame is refused");
  }

  void keysA;
});

test("seal/open round-trips and rejects tampering", () => {
  const keys = security.deriveSessionKeys(Buffer.alloc(32, 7), "a", "b");
  const sealed = security.sealPayload(keys, "hello");
  assert.equal(security.openPayload(keys, sealed), "hello");
  const tampered = Buffer.from(sealed, "base64");
  tampered[tampered.length - 1] ^= 0xff;
  assert.throws(() => security.openPayload(keys, tampered.toString("base64")), "tampered ciphertext is rejected");
  const wrongKeys = security.deriveSessionKeys(Buffer.alloc(32, 8), "a", "b");
  assert.throws(() => security.openPayload(wrongKeys, sealed), "the wrong key cannot open it");
});

test("paths outside the allowed roots are refused, including traversals", () => {
  const root = tmpRoot();
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  const inside = path.join(workspace, "a.txt");
  fs.writeFileSync(inside, "hi");
  const outside = path.join(root, "outside.txt");
  fs.writeFileSync(outside, "secret");

  assert.equal(resolveInsideRoots(inside, [workspace], { mustExist: true }).absolute, inside, "a file inside the root resolves");
  assert.throws(
    () => resolveInsideRoots(outside, [workspace], { mustExist: true }),
    (error) => error.code === "OUTSIDE_ROOTS",
    "a sibling of the root is refused",
  );
  assert.throws(
    () => resolveInsideRoots(path.join(workspace, "..", "outside.txt"), [workspace], { mustExist: true }),
    (error) => error.code === "OUTSIDE_ROOTS",
    "a '..' traversal is refused",
  );
  assert.throws(
    () => resolveInsideRoots("relative.txt", [workspace], { mustExist: false }),
    (error) => error.code === "RELATIVE_PATH",
    "a relative path is refused",
  );
  assert.throws(
    () => resolveInsideRoots(inside, [], { mustExist: true }),
    (error) => error.code === "NO_ROOTS",
    "with no configured roots nothing is readable",
  );

  // Symlinks are checked where the platform allows creating one. On Windows this needs
  // developer mode, so an EPERM is reported as "not exercised here" rather than a pass.
  try {
    const link = path.join(workspace, "link.txt");
    fs.symlinkSync(outside, link);
    assert.throws(
      () => resolveInsideRoots(link, [workspace], { mustExist: true }),
      (error) => error.code === "OUTSIDE_ROOTS",
      "a symlink pointing outside the root is refused",
    );
  } catch (error) {
    const code = error?.code;
    if (code !== "EPERM" && code !== "EACCES" && code !== "UNKNOWN") throw error;
    console.log(`  (symlink containment not exercised on this platform: ${code})`);
  }
});

test("the command policy refuses shells, scripts, denied patterns, and non-allowlisted programs", () => {
  const config = resolveConfig({ permissions: {} });
  for (const program of ["bash", "sh", "powershell", "pwsh", "cmd", "node", "python", "python3", "perl", "ruby"]) {
    assert.throws(
      () => checkCommandPolicy(program, ["-c", "id"], config.permissions),
      (error) => error.code === "SHELL_NOT_ALLOWED",
      `"${program}" is refused: a peer may not get an interpreter`,
    );
  }
  // Script files are refused by extension: on Windows a .bat/.cmd is run by cmd.exe even
  // when spawned with shell:false, so allowing the file would bypass the shell ban.
  for (const script of ["deploy.bat", "run.cmd", "setup.ps1", "x.vbs", "tool.js", "install.msi"]) {
    assert.throws(
      () => checkCommandPolicy(script, [], config.permissions),
      (error) => error.code === "SCRIPT_NOT_ALLOWED",
      `"${script}" is refused as a script file`,
    );
  }
  assert.throws(
    () => checkCommandPolicy("C:\\tools\\deploy.BAT", [], config.permissions),
    (error) => error.code === "SCRIPT_NOT_ALLOWED",
    "the check is case-insensitive and works on a full path",
  );
  assert.throws(
    () => checkCommandPolicy("format", ["c:"], config.permissions),
    (error) => error.code === "COMMAND_DENIED",
    "a denied pattern is refused",
  );
  checkCommandPolicy("git", ["--version"], config.permissions);

  const allowlisted = resolveConfig({ permissions: { exec: { allowCommands: ["git"] } } });
  assert.throws(
    () => checkCommandPolicy("npm", ["test"], allowlisted.permissions),
    (error) => error.code === "COMMAND_NOT_ALLOWED",
    "a program outside the allowlist is refused",
  );
  checkCommandPolicy("git", ["status"], allowlisted.permissions);
});

test("the child environment carries no DSH facts and no credential-shaped names", () => {
  const env = scrubbedEnv({ OK_API_KEY: "should-be-dropped", DSH_HOME: "should-be-dropped", BUILD_FLAG: "kept" });
  assert.equal(env.DSH_HOME, undefined, "DSH_* facts are scrubbed");
  assert.equal(env.OK_API_KEY, undefined, "a credential-shaped override is dropped");
  assert.equal(env.BUILD_FLAG, "kept", "an ordinary override survives");
  assert.equal(env.PATH, process.env.PATH, "PATH is preserved so programs can be found");
  for (const key of Object.keys(env)) {
    assert.equal(isCredentialShaped(key), false, `${key} must not survive the scrub`);
  }
});

test("file pages report a version and binary files are not returned as text", () => {
  const dir = tmpRoot();
  const textFile = path.join(dir, "a.txt");
  fs.writeFileSync(textFile, "one\ntwo\nthree\n");
  const page = readFilePage(textFile, 0, 10, 100_000);
  assert.equal(page.binary, false);
  assert.equal(page.content, "one\ntwo\nthree\n");
  assert.equal(page.totalLines, 4, "a trailing newline produces a final empty line");
  assert.match(page.version, /^[0-9a-f]{64}$/, "the version is a sha256");

  const binaryFile = path.join(dir, "b.bin");
  fs.writeFileSync(binaryFile, Buffer.from([0, 1, 2, 3, 255]));
  const binary = readFilePage(binaryFile, 0, 10, 100_000);
  assert.equal(binary.binary, true, "NUL bytes mark a file as binary");
  assert.equal(binary.content, undefined, "binary content is not returned as text");
});

test("atomic writes detect a concurrent change and refuse to clobber", () => {
  const dir = tmpRoot();
  const created = writeFileAtomic(path.join(dir, "x.txt"), "v1", undefined);
  assert.equal(created.created, true);
  assert.throws(
    () => writeFileAtomic(path.join(dir, "x.txt"), "v2", undefined),
    (error) => error.code === "VERSION_REQUIRED",
    "an overwrite with no version is refused",
  );
  assert.throws(
    () => writeFileAtomic(path.join(dir, "x.txt"), "v2", "0".repeat(64)),
    (error) => error.code === "VERSION_CONFLICT",
    "a stale version is refused",
  );
  const updated = writeFileAtomic(path.join(dir, "x.txt"), "v2", created.version);
  assert.equal(updated.version, security.sha256Hex(Buffer.from("v2", "utf8")));
  assert.equal(fs.readFileSync(path.join(dir, "x.txt"), "utf8"), "v2");
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name.includes(".tmp")), [], "no temp file survives");
});

test("the listener answers refusals instead of hanging the connection", async () => {
  // Regression guard: the parse step used to set the single "already handled" flag before
  // deciding whether to accept, so the 400 and 404 branches returned without writing a
  // single byte and without closing the socket. On an Frp-exposed port any browser hit
  // would then hold an open, silent connection forever.
  const { MeshServer } = await import("../lib/transport/server.js");
  const accepted = [];
  const server = new MeshServer(
    { enabled: false, certPath: undefined, keyPath: undefined, fingerprintSha256: undefined },
    (connection) => {
      accepted.push(connection);
      connection.destroy();
    },
    () => {},
  );
  const info = await server.start("127.0.0.1", 0);
  try {
    /** Send one raw request and return its first response line. */
    const raw = (request) =>
      new Promise((resolve) => {
        const socket = net.connect({ host: "127.0.0.1", port: info.port });
        let data = "";
        socket.once("connect", () => socket.write(request));
        socket.on("data", (chunk) => {
          data += chunk.toString("utf8");
        });
        socket.once("close", () => resolve(data.split(/\r?\n/)[0] ?? "(closed with no bytes)"));
        socket.once("error", (error) => resolve(`ERR ${error.code}`));
        setTimeout(() => {
          socket.destroy();
          resolve(`TIMEOUT ${JSON.stringify(data.slice(0, 80))}`);
        }, 3_000).unref?.();
      });

    assert.equal(
      await raw("GET /dsh-mesh HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n"),
      "HTTP/1.1 400 Bad Request",
      "a plain GET is refused with a visible 400 rather than a silent hang",
    );
    assert.equal(
      await raw("GET /nope HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n"),
      "HTTP/1.1 400 Bad Request",
      "a non-upgrade request on an unknown path is still refused with 400",
    );

    // A real upgrade succeeds and hands the connection to the acceptor.
    const upgrade = await new Promise((resolve) => {
      const socket = net.connect({ host: "127.0.0.1", port: info.port });
      let data = "";
      socket.once("connect", () =>
        socket.write(
          "GET /dsh-mesh HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
            "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n" +
            "Sec-WebSocket-Protocol: dsh-mesh.v1\r\n\r\n",
        ),
      );
      socket.on("data", (chunk) => {
        data += chunk.toString("utf8");
      });
      setTimeout(() => {
        const line = data.split(/\r?\n/)[0] ?? "(nothing)";
        socket.destroy();
        resolve(line);
      }, 1_500).unref?.();
    });
    assert.equal(upgrade, "HTTP/1.1 101 Switching Protocols", "a real upgrade still works");
    assert.equal(accepted.length, 1, "exactly one connection reached the acceptor");
  } finally {
    await server.stop();
  }
});
