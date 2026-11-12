// Probe: why does the runner's tool-call count stay at zero in the delegation test?
//
// The runner counts from two places: the live session-event observer and the snapshot of
// the child's session log. This script runs the same stub the test uses and prints both
// numbers so the discrepancy is visible instead of guessed at.
//
// Run: node scripts/debug-toolcount.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { TaskLedger } = await import("../lib/sessions/tasks.js");
const { RemoteTaskRunner, attachSessionObserver, extractText, collectFinalText } = await import("../lib/delegation/runner.js");
const { resolveConfig } = await import("../lib/config.js");

const listeners = new Set();
const events = [];
let idleResolve;
const idle = new Promise((resolve) => {
  idleResolve = resolve;
});
const agent = {
  id: "child",
  ctx: {
    on(name, listener) {
      if (name !== "session/event") return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    tools: { restrict: () => () => {} },
  },
  session: { snapshotEvents: () => events },
  followup(message) {
    const text = extractText(message.content);
    setTimeout(() => {
      const emit = (event) => {
        events.push(event);
        for (const listener of listeners) listener(agent, event);
      };
      emit({ type: "tool/call", data: { name: "write", arguments: JSON.stringify({ file_path: "/tmp/made.txt" }) } });
      emit({ type: "assistant/message", data: { message: { content: [{ type: "text", text: `done: ${text}` }] } } });
      emit({ type: "turn/end", data: { reason: { kind: "completed" } } });
      idleResolve();
    }, 5);
  },
  cancel() {},
  whenIdle: () => idle,
};

const observed = [];
attachSessionObserver(agent, (event) => {
  observed.push(event.type);
  console.log("observer saw:", event.type);
});

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-tc-"));
const ledger = new TaskLedger(stateDir);
const runner = new RemoteTaskRunner({
  ledger,
  agents: () => ({ create: async (options) => ({ agent, dispose: async () => {} }) }),
  defaultAgentOptions: () => ({}),
  maxConcurrentTasks: 2,
  maxTaskMs: 30_000,
  log: { info: () => {}, warn: () => {} },
  delegationToolNames: ["mesh_delegate"],
});

const accepted = runner.submit(
  { task: "make a file", label: "t", cwd: undefined, remainingDepth: 0, requestKey: undefined, stream: "s", timeoutMs: 20_000 },
  { from: "peer", signal: new AbortController().signal, emit: (e, d) => console.log("emit:", e, JSON.stringify(d).slice(0, 80)) },
);
console.log("taskId:", accepted.taskId);

const deadline = Date.now() + 5_000;
let result;
while (Date.now() < deadline) {
  result = runner.result(accepted.taskId);
  if (result.summary !== undefined) break;
  await new Promise((resolve) => setTimeout(resolve, 20));
}
console.log("result:", JSON.stringify(result, null, 2));
console.log("snapshot events:", events.map((event) => event.type).join(", "));
console.log("finalText:", collectFinalText(agent));
await runner.dispose();
