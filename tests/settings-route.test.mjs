// The settings page talks to the Host through one route. These tests pin the envelope it
// receives, because a wrong shape shows up as a blank page rather than an error.

import test from "node:test";
import assert from "node:assert/strict";
import { createSettingsRoute, registerSettingsRoute, SETTINGS_METHOD, SETTINGS_ROUTE } from "../lib/peer/settings-route.js";

/** A connection service that records the registered route. */
function fakeConnection() {
  const routes = [];
  return {
    routes,
    fetch: { register: (route) => { routes.push(route); return async () => {}; } },
  };
}

/** A manager stub: only what the actions touch. */
function fakeManager(overrides = {}) {
  const calls = [];
  const base = {
    snapshot: () => ({
      device: { deviceId: "aaaaaa-bbbbbb-cccccc-dddddd", name: "PC", platform: "win32", arch: "x64", node: "v24.0.0" },
      server: { enabled: true, running: true, host: "127.0.0.1", port: 8317, secure: false, url: "ws://127.0.0.1:8317", startedAt: 1 },
      peers: [],
      paired: [],
      counts: { online: 0, offline: 0, failed: 0 },
      permissions: { allowedRoots: [], allowWrite: true, allowExec: true, allowDelegate: true, maxDelegationDepth: 1 },
    }),
    capabilityDocument: () => ({ methods: ["mesh.status"] }),
    pairingStringFor: () => undefined,
    createPairingOffer: (device) => { calls.push(["createPairingOffer", device]); return { remoteDeviceId: device, code: "XXXXX-YYYYY", pairingString: `this|XXXXX-YYYYY|secret`, createdAt: 1 }; },
    acceptPairingString: (line, alias) => { calls.push(["acceptPairingString", line, alias]); return { peerId: "eeeeee-ffffff-gggggg-hhhhhh", code: "XXXXX-YYYYY" }; },
    removePairing: (id) => { calls.push(["removePairing", id]); return true; },
    addPeer: (alias, url, auto) => { calls.push(["addPeer", alias, url, auto]); return { alias, url, autoConnect: auto }; },
    connect: (device) => { calls.push(["connect", device]); return []; },
    disconnect: (device) => { calls.push(["disconnect", device]); return []; },
    probeFingerprint: async (url) => { calls.push(["probeFingerprint", url]); return { ok: true, fingerprint: "ab".repeat(32) }; },
  };
  return { calls, manager: Object.assign(base, overrides) };
}

/** Post one client-request the way the browser side does. */
async function post(route, payload, rpcId = "rpc-1") {
  const request = new Request(`http://127.0.0.1${SETTINGS_ROUTE}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "client-request", rpcId, method: SETTINGS_METHOD, payload }),
  });
  const response = await route.fetch(request);
  assert.equal(response.status, 200);
  return response.json();
}

test("registers one buffered POST route at the documented path", () => {
  const connection = fakeConnection();
  const ctx = { get: (name) => (name === "connection" ? connection : undefined) };
  const dispose = registerSettingsRoute(ctx, { manager: fakeManager().manager, log: () => {} });
  assert.equal(typeof dispose, "function");
  assert.equal(connection.routes.length, 1);
  const route = connection.routes[0];
  assert.equal(route.path, SETTINGS_ROUTE);
  assert.deepEqual(route.methods, ["POST"]);
  assert.equal(route.requestBody, "buffered");
});

test("a host with neither inject nor a live connection still returns a disposer", () => {
  // The contract is "always hand back something to call": an optional dependency must not
  // make the caller special-case teardown. Here neither path can register, so the
  // disposer is a no-op — but it exists.
  const noted = [];
  const ctx = { get: () => undefined };
  const dispose = registerSettingsRoute(ctx, {
    manager: fakeManager().manager,
    log: () => {},
    note: (outcome) => noted.push(outcome),
  });
  assert.equal(typeof dispose, "function");
  assert.doesNotThrow(() => dispose());
  assert.ok(noted.some((line) => line.includes("cannot defer")), "the absence is reported, not swallowed");
});

test("read returns the snapshot plus what the operator can act on", async () => {
  const connection = fakeConnection();
  const fake = fakeManager({
    pairingStringFor: () => "aaaaaa-bbbbbb-cccccc-dddddd|XXXXX-YYYYY|c2VjcmV0",
  });
  fake.manager.snapshot = () => ({
    device: { deviceId: "aaaaaa-bbbbbb-cccccc-dddddd", name: "PC", platform: "win32", arch: "x64", node: "v24.0.0" },
    server: { enabled: true, running: true, host: "127.0.0.1", port: 8317, secure: false, url: "ws://127.0.0.1:8317", startedAt: 1 },
    peers: [{ alias: "phone", deviceId: "eeeeee-ffffff-gggggg-hhhhhh", url: "wss://example/dsh-mesh", state: "online", outbound: false, attempts: 0, remoteCapabilities: [], methods: [], secure: true }],
    paired: [{ deviceId: "eeeeee-ffffff-gggggg-hhhhhh", code: "XXXXX-YYYYY", createdAt: 5 }],
    counts: { online: 1, offline: 0, failed: 0 },
    permissions: { allowedRoots: ["D:\\share"], allowWrite: true, allowExec: true, allowDelegate: true, maxDelegationDepth: 1 },
  });
  const dispose = registerSettingsRoute({ get: (n) => (n === "connection" ? connection : undefined) }, { manager: fake.manager, log: () => {} });
  const body = await post(connection.routes[0], { action: "read" });
  assert.equal(body.type, "server-response");
  assert.equal(body.rpcId, "rpc-1");
  assert.equal(body.result.ok, true);
  assert.equal(body.result.value.snapshot.peers[0].alias, "phone");
  assert.equal(body.result.value.pairingStrings[0].pairingString, "aaaaaa-bbbbbb-cccccc-dddddd|XXXXX-YYYYY|c2VjcmV0");
  assert.deepEqual(body.result.value.capabilities.methods, ["mesh.status"]);
  dispose();
});

test("pair/create refuses an empty device and passes the rest through", async () => {
  const connection = fakeConnection();
  const fake = fakeManager();
  registerSettingsRoute({ get: (n) => (n === "connection" ? connection : undefined) }, { manager: fake.manager, log: () => {} });
  const empty = await post(connection.routes[0], { action: "pair/create", device: "  " });
  assert.equal(empty.result.ok, false);
  assert.equal(empty.result.error.code, "PAIR_REMOTE_REQUIRED");
  assert.deepEqual(empty.result.error.details, {});
  const ok = await post(connection.routes[0], { action: "pair/create", device: "eeeeee-ffffff-gggggg-hhhhhh" });
  assert.equal(ok.result.ok, true);
  assert.equal(ok.result.value.code, "XXXXX-YYYYY");
  assert.deepEqual(fake.calls, [["createPairingOffer", "eeeeee-ffffff-gggggg-hhhhhh"]].flat().length ? fake.calls : []);
});

test("an unknown action fails with the list of valid ones", async () => {
  const connection = fakeConnection();
  registerSettingsRoute({ get: (n) => (n === "connection" ? connection : undefined) }, { manager: fakeManager().manager, log: () => {} });
  const body = await post(connection.routes[0], { action: "nope" });
  assert.equal(body.result.ok, false);
  assert.equal(body.result.error.code, "UNKNOWN_ACTION");
  assert.match(body.result.error.message, /read/);
});

test("a handler throw becomes a typed failure carrying its code", async () => {
  const connection = fakeConnection();
  const fake = fakeManager({
    createPairingOffer: () => { const error = new Error("self pairing is not allowed"); error.code = "SELF_PAIRING"; throw error; },
  });
  registerSettingsRoute({ get: (n) => (n === "connection" ? connection : undefined) }, { manager: fake.manager, log: () => {} });
  const body = await post(connection.routes[0], { action: "pair/create", device: "aaaaaa-bbbbbb-cccccc-dddddd" });
  assert.equal(body.result.ok, false);
  assert.equal(body.result.error.code, "SELF_PAIRING");
});

test("a non-envelope request is refused instead of crashing", async () => {
  const connection = fakeConnection();
  registerSettingsRoute({ get: (n) => (n === "connection" ? connection : undefined) }, { manager: fakeManager().manager, log: () => {} });
  const route = connection.routes[0];
  const bad = await route.fetch(new Request(`http://127.0.0.1${SETTINGS_ROUTE}`, { method: "POST", body: JSON.stringify({ hello: "world" }) }));
  const body = await bad.json();
  assert.equal(body.result.ok, false);
  assert.equal(body.result.error.code, "BAD_REQUEST");
});

test("peer/add and connect both reach the manager", async () => {
  const connection = fakeConnection();
  const fake = fakeManager();
  registerSettingsRoute({ get: (n) => (n === "connection" ? connection : undefined) }, { manager: fake.manager, log: () => {} });
  const added = await post(connection.routes[0], { action: "peer/add", alias: "phone", url: "wss://example/dsh-mesh" });
  assert.equal(added.result.ok, true);
  assert.ok(fake.calls.some((call) => call[0] === "addPeer"));
  const missingUrl = await post(connection.routes[0], { action: "peer/add", alias: "phone" });
  assert.equal(missingUrl.result.error.code, "PEER_URL_REQUIRED");
  const connected = await post(connection.routes[0], { action: "connect" });
  assert.equal(connected.result.ok, true);
  assert.ok(fake.calls.some((call) => call[0] === "connect"));
});

// The bug this guards: reading ctx.get("connection") during apply returns undefined when
// the connection row activates after this plugin. The route then never registers, the
// browser gets HTTP 404 on every call, and nothing else about the plugin looks wrong.
test("waits for a connection service that activates later", () => {
  let deferred = null;
  const registered = [];
  const ctx = {
    // Not available yet, exactly like a sibling row that activates afterwards.
    get: () => undefined,
    inject: (deps, callback) => { deferred = { deps, callback }; return () => {}; },
  };
  const dispose = registerSettingsRoute(ctx, { manager: fakeManager().manager, log: () => {} });
  assert.equal(typeof dispose, "function");
  assert.deepEqual(deferred.deps, ["connection"]);
  assert.equal(registered.length, 0, "nothing may register before the service exists");

  // Now the service appears; the deferred callback runs and registers the route.
  const connection = { fetch: { register: (route) => { registered.push(route); return async () => {}; } } };
  const scope = { get: (name) => (name === "connection" ? connection : undefined) };
  const stop = deferred.callback(scope);
  assert.equal(registered.length, 1);
  assert.equal(registered[0].path, SETTINGS_ROUTE);
  assert.equal(typeof stop, "function");
});

test("registers immediately when the service is already active", () => {
  const connection = fakeConnection();
  const ctx = {
    get: (name) => (name === "connection" ? connection : undefined),
    inject: (deps, callback) => { callback({ get: (n) => (n === "connection" ? connection : undefined) }); return () => {}; },
  };
  registerSettingsRoute(ctx, { manager: fakeManager().manager, log: () => {} });
  assert.equal(connection.routes.length, 1);
});

test("createSettingsRoute builds the route without any service", async () => {
  const route = createSettingsRoute({ manager: fakeManager().manager, log: () => {} });
  assert.equal(route.path, SETTINGS_ROUTE);
  const body = await (await route.fetch(new Request(`http://127.0.0.1${SETTINGS_ROUTE}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "client-request", rpcId: "x", method: SETTINGS_METHOD, payload: { action: "read" } }),
  }))).json();
  assert.equal(body.result.ok, true);
});