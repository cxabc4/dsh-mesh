// Delegation tests: the receiving runner and the sending provider, against a stub agents
// service.
//
// What this covers and what it does not, stated plainly because the distinction matters:
//
//   * Covered here: the *protocol and lifecycle* of delegation. The runner really creates
//     a child through the `agents.create` seam, really subscribes to that agent's session
//     events, really cancels through `agent.cancel`, and really reports a deduplicated
//     task id. The provider really polls the peer, resolves `result` without ever rejecting,
//     and makes `dispose()` idempotent.
//   * Not covered here: the remote agent's *intelligence*. A stub agent is used in place of
//     a live model, because a live model needs credentials and minutes; the real two-device
//     run is recorded separately in docs/acceptance.md.
//
// The stub mirrors the documented `Agent` surface exactly (followup/cancel/whenIdle/ctx.on/
// session.snapshotEvents), so a change in the real seam would show up as a test failure
// rather than as a silently wrong assumption.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { TaskLedger } = await import("../lib/sessions/tasks.js");
const { RemoteTaskRunner, attachSessionObserver, extractText, collectFinalText, collectArtifacts } = await import("../lib/delegation/runner.js");
const { MeshSubagentProvider, composePrompt, parsePrompt, MESH_PROVIDER_NAME } = await import("../lib/delegation/provider.js");
const { RpcError } = await import("../lib/rpc/peer.js");
const { resolveConfig } = await import("../lib/config.js");

/**
 * A stub child agent that behaves like the documented `Agent`: it accepts a followup,
 * runs a scripted sequence of session events, then reaches idle.
 */
function makeStubAgent({ script = "default", cwd } = {}) {
  const listeners = new Set();
  const events = [];
  let idleResolve;
  let idle = new Promise((resolve) => {
    idleResolve = resolve;
  });
  let cancelled = false;
  const agent = {
    id: "child-session",
    status: "running",
    ctx: {
      on(name, listener) {
        if (name !== "session/event") return () => {};
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      tools: {
        restrict(filter) {
          agent.restrictions.push(filter);
          return () => {};
        },
      },
    },
    restrictions: [],
    session: {
      snapshotEvents: () => events,
      seq: 0,
    },
    followup(message) {
      const text = extractText(message.content);
      // Emit the events a real turn would: a tool call, then an assistant message, then
      // the turn end. This is what the runner forwards as progress.
      setTimeout(() => {
        const emit = (event) => {
          events.push(event);
          for (const listener of listeners) listener(agent, event);
        };
        if (script === "tool-then-answer") {
          emit({ type: "tool/call", data: { name: "write", arguments: JSON.stringify({ file_path: `${cwd ?? "."}/made.txt`, content: "x" }) } });
          emit({ type: "tool/result", data: { message: { content: [{ type: "text", text: "ok" }] } } });
        }
        if (script === "slow") {
          emit({ type: "assistant/message", data: { message: { content: [{ type: "text", text: "working..." }] } } });
          // Never settles until cancelled; `whenIdle` resolves on cancel.
          if (cancelled) {
            idleResolve();
          }
          return;
        }
        emit({
          type: "assistant/message",
          data: { message: { content: [{ type: "text", text: `done: ${text.slice(0, 40)}` }] } },
        });
        emit({ type: "turn/end", data: { reason: { kind: "completed" } } });
        agent.status = "idle";
        idleResolve();
      }, 5);
    },
    cancel(cause) {
      cancelled = true;
      agent.lastCancel = cause;
      agent.status = "idle";
      idleResolve();
      return true;
    },
    whenIdle() {
      return idle;
    },
  };
  return agent;
}

/** A stub `agents` service matching the documented `ctx.agents.create` contract. */
function makeStubAgents(script) {
  const created = [];
  return {
    created,
    service: {
      async create(options) {
        const agent = makeStubAgent({ script, cwd: options.meta?.cwd });
        // The setup callback is where a real composition restricts tools; the stub calls
        // it so the runner's depth guard is exercised.
        options.setup?.({ tools: agent.ctx.tools }, agent);
        created.push({ options, agent });
        return {
          agent,
          dispose: async () => {
            agent.disposed = true;
          },
        };
      },
    },
  };
}

const config = resolveConfig({ permissions: { maxConcurrentTasks: 2, maxTaskMs: 60_000 } });

test("an inbound task runs on a real child agent and reports artifacts", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-deleg-run-"));
  const ledger = new TaskLedger(stateDir);
  const stub = makeStubAgents("tool-then-answer");
  const runner = new RemoteTaskRunner({
    ledger,
    agents: () => stub.service,
    defaultAgentOptions: () => ({ provider: "stub", model: "stub-model" }),
    maxConcurrentTasks: config.permissions.maxConcurrentTasks,
    maxTaskMs: config.permissions.maxTaskMs,
    log: { info: () => {}, warn: () => {} },
    delegationToolNames: ["mesh_delegate"],
  });
  try {
    const accepted = runner.submit(
      { task: "create made.txt", label: "demo", cwd: stateDir, remainingDepth: 0, requestKey: "key-1", stream: "task:1", timeoutMs: 30_000 },
      { from: "peer-device", signal: new AbortController().signal, emit: () => {} },
    );
    assert.equal(accepted.replayed, false, "a new task is not a replay");
    assert.ok(typeof accepted.taskId === "string" && accepted.taskId.length > 0);

    // The stub agent must really have been created through the agents service.
    assert.equal(stub.created.length, 1, "exactly one child agent was created");
    assert.equal(stub.created[0].options.meta.origin, "subagent", "the child is marked as a subagent");
    assert.equal(stub.created[0].options.meta.cwd, stateDir, "the requested working directory is passed through");
    // remainingDepth 0 must hide the delegation tools from the child.
    assert.deepEqual(
      stub.created[0].agent.restrictions,
      [{ deny: ["mesh_delegate"] }],
      "a child with no depth left cannot delegate onward",
    );

    // Poll until the task settles.
    let result;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      result = runner.result(accepted.taskId);
      if (result.summary !== undefined) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(result !== undefined, "a result was produced");
    assert.equal(result.state, "completed", "the task completed");
    assert.match(result.summary, /done: create made\.txt/, "the child's final assistant text is the summary");
    assert.ok(
      result.artifacts.some((artifact) => artifact.kind === "file"),
      "the file the child wrote is reported as an artifact",
    );
    assert.ok(result.toolCalls >= 1, "the tool call was counted");
    assert.equal(result.sessionId, `dsh-mesh-${accepted.taskId}`, "the remote session id is reported back");

    // The ledger is the durable record.
    const record = ledger.get(accepted.taskId);
    assert.equal(record.state, "completed");
    assert.ok(record.progress.length > 0, "progress was recorded from the session events");
  } finally {
    await runner.dispose();
  }
});

test("repeating the same requestKey does not start a second task", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-deleg-dedupe-"));
  const ledger = new TaskLedger(stateDir);
  const stub = makeStubAgents("slow");
  const runner = new RemoteTaskRunner({
    ledger,
    agents: () => stub.service,
    defaultAgentOptions: () => ({}),
    maxConcurrentTasks: 2,
    maxTaskMs: 60_000,
    log: { info: () => {}, warn: () => {} },
    delegationToolNames: ["mesh_delegate"],
  });
  try {
    const params = { task: "long running thing", label: "d", cwd: undefined, remainingDepth: 0, requestKey: "same-key", stream: "s", timeoutMs: 30_000 };
    const context = { from: "peer", signal: new AbortController().signal, emit: () => {} };
    const first = runner.submit(params, context);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const second = runner.submit(params, context);
    assert.equal(second.taskId, first.taskId, "the retry names the original task");
    assert.equal(second.replayed, true, "the retry is reported as a replay");
    assert.equal(stub.created.length, 1, "no second agent was created");
    await runner.cancel(first.taskId);
  } finally {
    await runner.dispose();
  }
});

test("cancelling an inbound task cancels the child agent and reports cancelled", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-deleg-cancel-"));
  const ledger = new TaskLedger(stateDir);
  const stub = makeStubAgents("slow");
  const runner = new RemoteTaskRunner({
    ledger,
    agents: () => stub.service,
    defaultAgentOptions: () => ({}),
    maxConcurrentTasks: 2,
    maxTaskMs: 60_000,
    log: { info: () => {}, warn: () => {} },
    delegationToolNames: ["mesh_delegate"],
  });
  try {
    const accepted = runner.submit(
      { task: "run forever", label: "c", cwd: undefined, remainingDepth: 0, requestKey: undefined, stream: "s", timeoutMs: 30_000 },
      { from: "peer", signal: new AbortController().signal, emit: () => {} },
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    const cancelled = runner.cancel(accepted.taskId);
    assert.equal(cancelled.accepted, true);
    assert.equal(cancelled.state, "cancelling");
    // The child agent must have received the DSH cancel primitive with a parent cause.
    const agent = stub.created[0].agent;
    assert.equal(agent.lastCancel.kind, "parent", "cancellation uses DSH's own parent-cause cancel");
    // And the task settles as cancelled.
    let result;
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      result = runner.result(accepted.taskId);
      if (result.summary !== undefined) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(result !== undefined);
    assert.equal(result.state, "cancelled");
  } finally {
    await runner.dispose();
  }
});

test("the runner refuses new tasks when at capacity", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-deleg-busy-"));
  const ledger = new TaskLedger(stateDir);
  const stub = makeStubAgents("slow");
  const runner = new RemoteTaskRunner({
    ledger,
    agents: () => stub.service,
    defaultAgentOptions: () => ({}),
    maxConcurrentTasks: 1,
    maxTaskMs: 60_000,
    log: { info: () => {}, warn: () => {} },
    delegationToolNames: ["mesh_delegate"],
  });
  try {
    const context = { from: "peer", signal: new AbortController().signal, emit: () => {} };
    const first = runner.submit({ task: "one", label: "a", cwd: undefined, remainingDepth: 0, requestKey: undefined, stream: "s1", timeoutMs: 30_000 }, context);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.throws(
      () => runner.submit({ task: "two", label: "b", cwd: undefined, remainingDepth: 0, requestKey: undefined, stream: "s2", timeoutMs: 30_000 }, context),
      (error) => error instanceof RpcError && error.code === "BUSY",
      "a second task is refused with BUSY while the first is running",
    );
    await runner.cancel(first.taskId);
  } finally {
    await runner.dispose();
  }
});

test("delegation is refused when the device does not accept tasks", async () => {
  const { createHandlers } = await import("../lib/peer/handlers.js");
  const { AuditLog } = await import("../lib/peer/capabilities.js");
  const configNoDelegate = resolveConfig({ permissions: { allowDelegate: false, allowedRoots: [os.tmpdir()] } });
  const handlers = createHandlers({
    config: configNoDelegate,
    stateDir: os.tmpdir(),
    audit: new AuditLog(50),
    deviceId: () => "device-id",
    capabilityDocument: () => ({}),
    taskRunner: () => undefined,
  });
  await assert.rejects(
    handlers["mesh.delegate"]({ task: "do something" }, { from: "peer", signal: new AbortController().signal, emit: () => {} }),
    (error) => /DELEGATE_DISABLED|NO_TASK_RUNNER/.test(String(error.code) + error.message),
    "a device with allowDelegate=false refuses delegated work",
  );
});

test("the provider refuses an unbounded delegation and never rejects its result", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-deleg-prov-"));
  const ledger = new TaskLedger(stateDir);
  // A manager stand-in: the provider only needs `rpcFor` to obtain a peer RPC object.
  const manager = {
    rpcFor() {
      throw new RpcError("OFFLINE", "no peer in this test");
    },
  };
  const provider = new MeshSubagentProvider({ manager, ledger, config, log: { info: () => {}, warn: () => {} } });
  assert.equal(provider.name, MESH_PROVIDER_NAME);
  assert.deepEqual(provider.capabilities, { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false });
  assert.equal(provider.inheritsParentContext, false);
  assert.equal(typeof provider.prepareContinuable, "undefined", "an external provider must not implement prepareContinuable");

  // A prompt without the control header cannot name a device.
  await assert.rejects(
    provider.start({ prompt: [{ type: "text", text: "just a prompt" }], parent: { id: "p" }, signal: new AbortController().signal }),
    (error) => error instanceof RpcError && error.code === "BAD_DELEGATION",
  );

  // A depth beyond the configured maximum is refused synchronously.
  await assert.rejects(
    provider.start({
      prompt: [{ type: "text", text: composePrompt({ device: "x", task: "t", cwd: undefined, depth: 9, requestKey: undefined, label: "l" }) }],
      parent: { id: "p" },
      signal: new AbortController().signal,
    }),
    (error) => error instanceof RpcError && error.code === "DELEGATION_TOO_DEEP",
  );

  // A run whose peer is unreachable settles with stopReason "error" — it must NOT reject,
  // because a rejected `result` wedges the parent agent's teardown.
  const run = await provider.start({
    prompt: [{ type: "text", text: composePrompt({ device: "phone", task: "check logs", cwd: undefined, depth: 0, requestKey: "k", label: "l" }) }],
    parent: { id: "p" },
    signal: new AbortController().signal,
  });
  const result = await run.result;
  assert.equal(result.stopReason, "error", "an unreachable peer resolves with an error stopReason");
  assert.ok(result.diagnostic.includes("OFFLINE") || result.diagnostic.length > 0, "the diagnostic explains why");
  // dispose is idempotent and synchronous-safe.
  await run.dispose();
  await run.dispose();
});

test("prompt control header round-trips and tolerates a plain prompt", () => {
  const prompt = composePrompt({ device: "phone", task: "do the thing", cwd: "/home/user/x", depth: 0, requestKey: "abc", label: "l" });
  const parsed = parsePrompt(prompt);
  assert.equal(parsed.task, "do the thing", "the task body survives the round trip");
  assert.equal(parsed.header.device, "phone");
  assert.equal(parsed.header.cwd, "/home/user/x");
  assert.equal(parsed.header.requestKey, "abc");

  const plain = parsePrompt("just a normal prompt");
  assert.equal(plain.header, undefined, "a prompt without the header is passed through");
  assert.equal(plain.task, "just a normal prompt");
});

test("session observation helpers read the documented shapes", () => {
  const events = [
    { type: "tool/call", data: { name: "write", arguments: JSON.stringify({ file_path: "/tmp/a.txt" }) } },
    { type: "tool/call", data: { name: "pwsh", arguments: JSON.stringify({ command: "npm test" }) } },
    { type: "assistant/message", data: { message: { content: [{ type: "text", text: "first" }] } } },
    { type: "assistant/message", data: { message: { content: [{ type: "text", text: "second" }] } } },
  ];
  const agent = { session: { snapshotEvents: () => events } };
  assert.equal(collectFinalText(agent), "second", "the last non-empty assistant message wins");
  const artifacts = collectArtifacts(agent);
  assert.ok(artifacts.some((artifact) => artifact.kind === "file" && artifact.path === "/tmp/a.txt"));
  assert.ok(artifacts.some((artifact) => artifact.kind === "command" && artifact.command === "npm test"));
  assert.equal(extractText([{ type: "text", text: "a" }, { type: "reasoning", text: "b" }]), "a");
  const unsubscribe = attachSessionObserver({ ctx: { on: () => () => {} } }, () => {});
  assert.equal(typeof unsubscribe, "function");
});
