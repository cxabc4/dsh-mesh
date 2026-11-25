// mesh_configure exists because a device whose only operator is its agent has no settings
// UI. These tests pin the two things that matter: the tool installs the route, and it
// reports what to write so the change survives a restart.

import test from "node:test";
import assert from "node:assert/strict";
import { meshConfigureTool } from "../lib/tools/mesh-tools.js";

/** Minimal manager stub: the tool only calls configurePeer and reads nothing else. */
function fakeDeps() {
  const calls = [];
  return {
    calls,
    deps: {
      manager: {
        configurePeer: (input) => {
          calls.push(input);
          return {
            alias: input.alias,
            url: input.url,
            state: "offline",
            outbound: true,
            attempts: 1,
            remoteCapabilities: [],
            methods: [],
            secure: input.url.startsWith("wss://"),
          };
        },
      },
    },
  };
}

test("takes flat fields and installs the route", async () => {
  const fake = fakeDeps();
  const tool = meshConfigureTool(fake.deps);
  const value = await tool.execute({ alias: "pc", url: "wss://tunnel.example/dsh-mesh" }, { signal: AbortSignal.abort() });
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].alias, "pc");
  assert.equal(fake.calls[0].url, "wss://tunnel.example/dsh-mesh");
  assert.equal(fake.calls[0].autoConnect, true, "defaults to dialing immediately");
  assert.equal(value.peer.alias, "pc");
});

test("takes the peerConfig object from a pairing payload verbatim", async () => {
  // This is the shape a pairing JSON carries, so an agent can paste the nested object
  // straight in without retyping the address.
  const fake = fakeDeps();
  const tool = meshConfigureTool(fake.deps);
  const value = await tool.execute(
    { peerConfig: { alias: "pc", url: "wss://tunnel.example/dsh-mesh", autoConnect: false } },
    { signal: AbortSignal.abort() },
  );
  assert.equal(fake.calls[0].url, "wss://tunnel.example/dsh-mesh");
  assert.equal(fake.calls[0].autoConnect, false);
  assert.equal(value.peer.url, "wss://tunnel.example/dsh-mesh");
});

test("flat fields win over the nested object", () => {
  // An operator correcting one value should not have to rewrite the whole payload.
  const fake = fakeDeps();
  const tool = meshConfigureTool(fake.deps);
  return tool.execute(
    { alias: "home", url: "ws://192.168.1.9:8317/dsh-mesh", peerConfig: { alias: "pc", url: "wss://old/dsh-mesh" } },
    { signal: AbortSignal.abort() },
  ).then((value) => {
    assert.equal(fake.calls[0].alias, "home");
    assert.equal(fake.calls[0].url, "ws://192.168.1.9:8317/dsh-mesh");
    assert.equal(value.durable.peers[0].url, "ws://192.168.1.9:8317/dsh-mesh");
  });
 });

test("refuses an empty url instead of creating an unusable peer", async () => {
  const fake = fakeDeps();
  const tool = meshConfigureTool(fake.deps);
  await assert.rejects(
    tool.execute({ alias: "pc" }, { signal: AbortSignal.abort() }),
    /BAD_PARAMS/,
  );
  assert.equal(fake.calls.length, 0);
});

test("the durable snippet is what makes the route survive a restart", async () => {
  const fake = fakeDeps();
  const tool = meshConfigureTool(fake.deps);
  const value = await tool.execute({ alias: "pc", url: "wss://tunnel.example/dsh-mesh" }, { signal: AbortSignal.abort() });
  assert.deepEqual(value.durable.peers, [{ alias: "pc", url: "wss://tunnel.example/dsh-mesh", autoConnect: true }]);
  assert.match(value.durable.note, /cordis\.patch\.yml/);
});
