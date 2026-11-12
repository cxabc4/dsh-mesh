// Smoke test: load the plugin with a minimal Cordis-like context and confirm it mounts.
//
// This is not a mock of DSH's tool pipeline — it exercises the real `apply()` entry:
// config normalisation, identity creation, the listener starting on an ephemeral port,
// tool registration, and teardown. It catches the class of failure that only shows up
// when the plugin is actually loaded (bad import paths, missing services, wrong config
// shape).
//
// Every test disposes what it mounted in a `finally`, because the listener keeps the
// process alive: a failed assertion that skips teardown turns a bug report into a hang.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";

const { apply } = await import("../lib/index.js");

/** A minimal stand-in for the parts of `ctx` the plugin touches. */
function makeContext() {
  const disposers = [];
  const registeredTools = [];
  const providers = [];
  const sections = [];
  const logs = [];
  const services = new Map();
  services.set("tools", {
    register(definition) {
      registeredTools.push(definition.name);
      const dispose = () => {};
      disposers.push(dispose);
      return dispose;
    },
  });
  services.set("subagents", {
    registerProvider(provider) {
      providers.push(provider.name);
      const dispose = () => {};
      disposers.push(dispose);
      return dispose;
    },
  });
  services.set("systemPrompt", {
    section(section) {
      sections.push(section.name);
      return () => {};
    },
  });
  const ctx = {
    logger: {
      info: (message) => logs.push(`info:${message}`),
      warn: (message) => logs.push(`warn:${message}`),
      error: (message) => logs.push(`error:${message}`),
    },
    get(name) {
      return services.get(name);
    },
    /**
     * Mirrors Cordis `ctx.effect`: the callback runs IMMEDIATELY, and whatever it RETURNS
     * becomes the disposer (cordis `Fiber._execute`: a returned function is collected, a
     * returned Promise is awaited and its resolution collected). Getting this wrong in the
     * stub would hide exactly the bug this test exists to catch.
     */
    effect(callback) {
      const result = callback();
      if (typeof result === "function") disposers.push(result);
      else if (result !== undefined && result !== null && typeof result.then === "function") {
        let inner;
        result.then((value) => {
          if (typeof value === "function") inner = value;
        });
        disposers.push(() => {
          if (typeof inner === "function") return inner();
          return undefined;
        });
      }
      return () => {};
    },
    on() {
      return () => {};
    },
  };
  return { ctx, disposers, registeredTools, providers, sections, logs };
}

/** Dispose in reverse, as the plugin expects; returns when every async disposer settled. */
async function teardown(disposers) {
  for (const dispose of [...disposers].reverse()) {
    try {
      const result = dispose();
      if (typeof result?.then === "function") await result;
    } catch {
      /* a stub disposer may throw; the real one must not */
    }
  }
}

/** Read the port the plugin logged when its listener came up. */
function listenerPortFromLogs(logs) {
  for (const line of logs) {
    const match = /mesh listener ready at (ws|wss):\/\/[^:\s]+:(\d+)/.exec(line);
    if (match !== null) return Number(match[2]);
  }
  return undefined;
}

/** Try one TCP connection to 127.0.0.1:port; true when the port accepts. */
function probePort(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const done = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    setTimeout(() => done(false), 2_000).unref?.();
  });
}

test("apply mounts the listener, tools, provider, and prompt section", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-mesh-smoke-"));
  const { ctx, disposers, registeredTools, providers, sections, logs } = makeContext();
  try {
    await apply(ctx, {
      device: { name: "smoke-device", stateDir },
      // Port 0 asks the OS for a free port, so the test cannot collide with a real instance.
      server: { enabled: true, host: "127.0.0.1", port: 0 },
      peers: [],
      permissions: { allowedRoots: [stateDir] },
    });

    assert.equal(providers.length, 1, "exactly one subagent provider is registered");
    assert.equal(providers[0], "mesh", "the provider is named mesh");
    assert.ok(registeredTools.includes("mesh_status"), "mesh_status is registered");
    assert.ok(registeredTools.includes("mesh_delegate"), "mesh_delegate is registered");
    assert.ok(registeredTools.includes("mesh_task_result"), "mesh_task_result is registered");
    assert.ok(registeredTools.length >= 17, `all tools registered, got ${registeredTools.length}`);
    assert.equal(sections.length, 1, "one system-prompt section is added");

    const identityFile = path.join(stateDir, "identity.json");
    assert.ok(fs.existsSync(identityFile), "an identity file was created");
    const identity = JSON.parse(fs.readFileSync(identityFile, "utf8"));
    assert.ok(
      /^[a-z2-7]{6}-[a-z2-7]{6}-[a-z2-7]{6}-[a-z2-7]{6}$/.test(identity.deviceId),
      `device id looks durable: ${identity.deviceId}`,
    );
    assert.ok(identity.privateKeyPem.startsWith("-----BEGIN PRIVATE KEY-----"), "the private key is stored");
    if (process.platform !== "win32") {
      const mode = fs.statSync(identityFile).mode & 0o777;
      assert.equal(mode, 0o600, `identity file mode is 0600, got ${String(mode)}`);
    }
    assert.ok(disposers.length > 0, "a teardown effect was installed");

    // The listener must still be alive AFTER apply returns. This is the regression guard
    // for the Cordis effect contract: `ctx.effect(callback)` runs the callback immediately
    // and registers whatever it RETURNS as the disposer, so handing the cleanup body
    // directly to `ctx.effect` tears the listener down inside apply — indistinguishable
    // from "the plugin never started" when viewed from outside.
    const listenerPort = listenerPortFromLogs(logs);
    assert.notEqual(listenerPort, undefined, `the listener reported a bound port in its log: ${logs.join(" | ")}`);
    const accepted = await probePort(listenerPort);
    assert.equal(accepted, true, "the listener is still accepting connections after apply returned");
  } finally {
    await teardown(disposers);
  }
});

test("a second apply on the same state directory reuses the identity", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-mesh-id-"));
  const first = makeContext();
  const second = makeContext();
  try {
    await apply(first.ctx, {
      device: { name: "d1", stateDir },
      server: { enabled: false },
      peers: [],
      permissions: { allowedRoots: [stateDir] },
    });
    const id1 = JSON.parse(fs.readFileSync(path.join(stateDir, "identity.json"), "utf8")).deviceId;
    await teardown(first.disposers);

    await apply(second.ctx, {
      device: { name: "d2", stateDir },
      server: { enabled: false },
      peers: [],
      permissions: { allowedRoots: [stateDir] },
    });
    const id2 = JSON.parse(fs.readFileSync(path.join(stateDir, "identity.json"), "utf8")).deviceId;
    assert.equal(id1, id2, "the device id is durable across restarts");
  } finally {
    await teardown(first.disposers);
    await teardown(second.disposers);
  }
});

test("the listener refuses to start when TLS is enabled but unusable", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-mesh-tls-"));
  const { ctx, disposers } = makeContext();
  try {
    await assert.rejects(
      apply(ctx, {
        device: { name: "tls-device", stateDir },
        server: {
          enabled: true,
          host: "127.0.0.1",
          port: 0,
          tls: { enabled: true, certPath: path.join(stateDir, "missing-cert.pem"), keyPath: path.join(stateDir, "missing-key.pem") },
        },
        peers: [],
        permissions: { allowedRoots: [stateDir] },
      }),
      /TLS certificate not found/,
      "a public listener must never silently downgrade to plaintext",
    );
  } finally {
    await teardown(disposers);
  }
});

test("config normalisation clamps bad values instead of throwing", async () => {
  const { resolveConfig } = await import("../lib/config.js");
  const config = resolveConfig({
    server: { port: 999999, host: "" },
    peers: [{ alias: "", url: "" }, { alias: "phone", url: "ws://127.0.0.1:1/dsh-mesh" }],
    permissions: { allowedRoots: [123, "", "  C:\\x  "], allowExec: "yes" },
    maxDelegationDepth: 99,
  });
  assert.equal(config.server.port, 65535, "port is clamped to the legal range");
  assert.equal(config.server.host, "127.0.0.1", "an empty host falls back to loopback");
  assert.equal(config.peers.length, 1, "a peer with neither alias nor url is dropped");
  assert.equal(config.peers[0].alias, "phone");
  assert.deepEqual(config.permissions.allowedRoots, ["C:\\x"], "roots are trimmed and non-strings dropped");
  assert.equal(config.permissions.allowExec, true, "a non-boolean keeps the default");
  assert.equal(config.maxDelegationDepth, 8, "depth is clamped to 8");
});
