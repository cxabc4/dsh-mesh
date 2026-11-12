// Delegation: run a task on the *other* device's native DSH agent.
//
// This is the feature the spec calls out as the real point of the project: the remote
// side must start a genuine DSH Agent in its own environment, not run a canned script.
// Two halves:
//
//   * `MeshSubagentProvider` (this file) plugs into `ctx.subagents`, so a local parent
//     agent sees the remote device as an ordinary subagent provider named "mesh". DSH then
//     owns activation, cancellation (an AbortSignal), result delivery, and teardown.
//   * `RemoteTaskRunner` (./runner.ts) is the receiving half: it creates a real child
//     Agent with `ctx.agents.create` on the other device, feeds it the task, streams its
//     progress back over the wire, and returns the agent's final answer plus artifacts.
//
// Contract details that matter for correctness, all verified against the shipped
// `@deepseek-ai/dsh-subagent` implementation:
//
//   * A provider WITHOUT `prepareContinuable` is dispatched as an *external* backend: the
//     manager calls `start()` once and treats the run as one-shot. Implementing
//     `prepareContinuable` would silently switch the plugin to the local path, so this
//     provider deliberately does not implement it.
//   * `run.result` must never reject once published — a rejected result wedges the parent
//     agent's teardown. Cancellation therefore *resolves* with `stopReason: "aborted"`.
//   * After `start()` returns, DSH stops forwarding the caller's abort signal into this
//     provider (the listener is removed once the run is returned). Cancellation instead
//     arrives as `interrupt()`, which aborts the run's own controller and then calls
//     `dispose()`. Both paths settle `result`, and `dispose()` is idempotent.
//   * All four capabilities are false because the child runs in another process on
//     another device: this provider cannot enforce an agent preset, a model route, a
//     structured-output schema, or a depth limit *inside* that child. DSH refuses such
//     requests up front instead of accepting and ignoring them — but that also means the
//     tool that drives this provider must be composed with `maxDepth: 'provider-managed'`,
//     which is documented in docs/guides/install-desktop.md.
//
// The devices need metadata a `SubagentStartRequest` does not carry (target device,
// remote working directory, delegation depth, idempotency key). Those travel as one
// leading control line in the prompt, which only this provider parses. Keeping them out
// of `cwd` matters: `cwd` would be resolved against the *local* filesystem by the
// subagent manager, and a Windows path is not absolute on Android (or vice versa) — each
// device must interpret its own paths.

import type { MeshManager } from "../peer/manager.ts";
import type { TaskLedger, TaskArtifact } from "../sessions/tasks.ts";
import { RpcError } from "../rpc/peer.ts";
import type { MeshConfig } from "../config.ts";

export const MESH_PROVIDER_NAME = "mesh";
const CONTROL_PREFIX = "[mesh-delegate]";
const CONTROL_END = "[/mesh-delegate]";

export interface DelegationRequest {
  device: string;
  task: string;
  cwd: string | undefined;
  /** Depth of the task being started; a value above maxDelegationDepth is refused. */
  depth: number;
  /** Idempotency key: retrying the same key never starts a second remote task. */
  requestKey: string | undefined;
  label: string;
}

/** Compose the prompt handed to `startActivation`. */
export function composePrompt(request: DelegationRequest): string {
  const header = {
    device: request.device,
    cwd: request.cwd ?? null,
    depth: request.depth,
    requestKey: request.requestKey ?? null,
  };
  return [`${CONTROL_PREFIX}${JSON.stringify(header)}${CONTROL_END}`, request.task].join("\n");
}

/** Read the control line back out; a prompt without one is passed through unchanged. */
export function parsePrompt(prompt: string): { header: Record<string, unknown> | undefined; task: string } {
  if (!prompt.startsWith(CONTROL_PREFIX)) return { header: undefined, task: prompt };
  const endIndex = prompt.indexOf(CONTROL_END);
  if (endIndex < 0) return { header: undefined, task: prompt };
  const encoded = prompt.slice(CONTROL_PREFIX.length, endIndex);
  const task = prompt.slice(endIndex + CONTROL_END.length).replace(/^\r?\n/, "");
  try {
    const parsed = JSON.parse(encoded) as Record<string, unknown>;
    return { header: parsed, task };
  } catch {
    return { header: undefined, task: prompt };
  }
}

/** What the caller asks the remote device to run (`mesh.delegate` params). */
export interface RemoteDelegationParams {
  task: string;
  label: string;
  cwd: string | undefined;
  /** Depth budget left for this task's own children; 0 means "may not delegate onward". */
  remainingDepth: number;
  requestKey: string | undefined;
  /** Stream name the remote publishes progress events on. */
  stream: string;
  /** Wall-clock cap enforced by both sides. */
  timeoutMs: number;
}

export interface RemoteDelegationAccepted {
  taskId: string;
  sessionId: string | undefined;
  acceptedAt: number;
  replayed: boolean;
}

export interface RemoteTaskResult {
  taskId: string;
  state: "completed" | "failed" | "cancelled";
  summary: string;
  artifacts: TaskArtifact[];
  sessionId: string | undefined;
  error: { code: string; message: string } | undefined;
  toolCalls: number;
  durationMs: number;
}

/** The run handle DSH expects back from `start()`. */
export interface SubagentRunLike {
  id: string;
  result: Promise<{
    output: Array<{ type: "text"; text: string }>;
    structured?: unknown;
    diagnostic?: string;
    stopReason: "completed" | "aborted" | "error" | "max-tokens" | "refusal";
  }>;
  dispose(): Promise<void>;
}

export interface ProviderDependencies {
  manager: MeshManager;
  ledger: TaskLedger;
  config: MeshConfig;
  log: { info(message: string): void; warn(message: string): void };
}

export class MeshSubagentProvider {
  readonly name = MESH_PROVIDER_NAME;
  readonly capabilities = {
    agentOptions: false,
    agentPreset: false,
    outputSchema: false,
    depthLimit: false,
  };
  readonly inheritsParentContext = false;
  readonly #deps: ProviderDependencies;

  constructor(deps: ProviderDependencies) {
    this.#deps = deps;
  }

  /**
   * Start one delegation and return immediately with its identity and result promise.
   *
   * Everything that can be validated synchronously is validated here, so a bad request
   * fails at the tool call instead of asynchronously in a task the caller already got an
   * id for.
   */
  async start(request: {
    prompt: Array<{ type: string; text?: string }>;
    label?: string;
    parent: { id: string };
    signal: AbortSignal;
  }): Promise<SubagentRunLike> {
    const promptText = request.prompt
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text ?? "")
      .join("\n");
    const parsed = parsePrompt(promptText);
    const header = parsed.header ?? {};
    const device = typeof header["device"] === "string" ? header["device"] : undefined;
    if (device === undefined) {
      throw new RpcError(
        "BAD_DELEGATION",
        "the mesh subagent provider must be started through mesh_delegate so the target device is known",
      );
    }
    const cwd = typeof header["cwd"] === "string" ? header["cwd"] : undefined;
    const depth = typeof header["depth"] === "number" ? header["depth"] : 0;
    const requestKey = typeof header["requestKey"] === "string" ? header["requestKey"] : undefined;
    const label = request.label ?? "mesh delegation";
    const { manager, ledger, config } = this.#deps;
    if (depth > config.maxDelegationDepth) {
      throw new RpcError(
        "DELEGATION_TOO_DEEP",
        `cross-device delegation depth ${depth} exceeds maxDelegationDepth ${config.maxDelegationDepth}; carry the task out locally instead`,
      );
    }

    const task = ledger.create({ direction: "out", peer: device, label, prompt: parsed.task, cwd, depth });
    ledger.setState(task.taskId, "submitted");
    const stream = `task:${task.taskId}`;
    const abort = new AbortController();
    let unsubscribe: (() => void) | undefined;
    let disposePromise: Promise<void> | undefined;

    // `result` must never reject after publication; every failure path resolves it with a
    // terminal stopReason and a diagnostic instead.
    const settle = (async () => {
      let remoteTaskId: string | undefined;
      try {
        const { rpc } = manager.rpcFor(device);
        unsubscribe = rpc.subscribe(stream, (event, data) => {
          const payload = (typeof data === "object" && data !== null ? data : {}) as Record<string, unknown>;
          if (event === "progress" && typeof payload["line"] === "string") {
            ledger.progress(task.taskId, payload["line"]);
            return;
          }
          if (event === "tool" && typeof payload["name"] === "string") {
            ledger.toolCall(
              task.taskId,
              `tool ${payload["name"]}: ${String(payload["detail"] ?? "").slice(0, 180)}`,
            );
            return;
          }
          if (event === "state" && typeof payload["state"] === "string") {
            const next = payload["state"];
            if (["running", "waiting", "completed", "failed", "cancelled"].includes(next)) {
              ledger.setState(task.taskId, next as "running");
            }
          }
        });

        const accepted = await rpc.request<RemoteDelegationAccepted>(
          "mesh.delegate",
          {
            task: parsed.task,
            label,
            cwd,
            remainingDepth: Math.max(0, config.maxDelegationDepth - depth - 1),
            requestKey,
            stream,
            timeoutMs: config.permissions.maxTaskMs,
          } satisfies RemoteDelegationParams,
          { timeoutMs: Math.min(30_000, config.requestTimeoutMs) },
        );
        remoteTaskId = accepted.taskId;
        ledger.setRemoteSession(task.taskId, accepted.sessionId ?? accepted.taskId);
        ledger.setState(task.taskId, "running");
        if (accepted.replayed) {
          ledger.progress(task.taskId, "the remote device recognised this request and is already running it");
        }

        const deadline = Date.now() + config.permissions.maxTaskMs;
        while (!abort.signal.aborted) {
          if (Date.now() > deadline) {
            try {
              await rpc.request("mesh.task.cancel", { taskId: remoteTaskId }, { timeoutMs: 10_000 });
            } catch {
              /* the remote may already be gone */
            }
            ledger.error(task.taskId, "TIMEOUT", `the remote task exceeded the ${config.permissions.maxTaskMs}ms budget`);
            ledger.setState(task.taskId, "failed");
            return failure(remoteTaskId, "TIMEOUT", "the remote task exceeded its time budget");
          }
          try {
            const snapshot = await rpc.request<RemoteTaskResult | { state: string; taskId: string }>(
              "mesh.task.result",
              { taskId: remoteTaskId },
              { timeoutMs: 20_000, signal: abort.signal },
            );
            if ("summary" in snapshot) {
              record(ledger, task.taskId, snapshot);
              return finished(snapshot);
            }
          } catch (error) {
            if (abort.signal.aborted) break;
            const code = error instanceof RpcError ? error.code : "INTERNAL";
            if (code === "OFFLINE" || code === "TIMEOUT") {
              // The link died mid-task. The remote keeps running; the ledger says "lost"
              // so a retry queries the same task instead of starting a second one.
              ledger.setState(task.taskId, "lost");
              return failure(
                remoteTaskId,
                "LINK_LOST",
                "the connection dropped while the task was running; it continues on the peer, query the same task id later",
              );
            }
            // Anything else is a real answer failure; retry the poll once more via the
            // loop, but do not spin forever.
            await new Promise((resolve) => setTimeout(resolve, 1_000));
            continue;
          }
          await new Promise((resolve) => setTimeout(resolve, 2_000));
        }
        // Cancellation path: tell the peer to stop, then report aborted.
        if (remoteTaskId !== undefined) {
          try {
            await rpc.request("mesh.task.cancel", { taskId: remoteTaskId }, { timeoutMs: 10_000 });
          } catch {
            /* the link may already be gone */
          }
        }
        ledger.requestCancel(task.taskId);
        ledger.setState(task.taskId, "cancelled");
        return aborted(remoteTaskId);
      } catch (error) {
        const code = error instanceof RpcError ? error.code : "INTERNAL";
        const message = error instanceof Error ? error.message : String(error);
        ledger.error(task.taskId, code, message);
        ledger.setState(task.taskId, "failed");
        return failure(undefined, code, message);
      }
    })();

    return {
      id: task.taskId,
      result: settle,
      dispose: () => {
        if (disposePromise !== undefined) return disposePromise;
        disposePromise = (async () => {
          abort.abort(new RpcError("CANCELLED", "the delegation was disposed"));
          unsubscribe?.();
          // Do not await `settle` here: DSH calls dispose from teardown paths that are
          // already waiting on `result`, and awaiting it would deadlock.
        })();
        return disposePromise;
      },
    };
  }

  /** Called when the parent agent is interrupted: forward the cancel to the peer. */
  interrupt(): void {
    /* Interruption reaches this provider through `dispose()`; see docs/guides/limits.md. */
  }
}

/** Terminal run value for a task that failed on the remote side. */
function failure(
  remoteTaskId: string | undefined,
  code: string,
  message: string,
): { output: Array<{ type: "text"; text: string }>; diagnostic: string; stopReason: "error" } {
  return {
    output: [{ type: "text", text: `mesh delegation ${remoteTaskId ?? "(unstarted)"} failed: ${code}: ${message}` }],
    diagnostic: `${code}: ${message}`,
    stopReason: "error",
  };
}

/** Terminal run value for a task the caller cancelled. */
function aborted(remoteTaskId: string | undefined) {
  return {
    output: [{ type: "text" as const, text: `mesh delegation ${remoteTaskId ?? "(unstarted)"} was cancelled` }],
    stopReason: "aborted" as const,
  };
}

/** Terminal run value for a completed (or peer-reported failed) task. */
function finished(result: RemoteTaskResult) {
  return {
    output: [{ type: "text" as const, text: formatResult(result) }],
    ...result.error === undefined ? {} : { diagnostic: `${result.error.code}: ${result.error.message}` },
    stopReason: result.state === "completed" ? ("completed" as const) : result.state === "cancelled" ? ("aborted" as const) : ("error" as const),
  };
}

function record(ledger: TaskLedger, taskId: string, result: RemoteTaskResult): void {
  ledger.result(taskId, result.summary, {
    artifacts: result.artifacts,
    remoteSessionId: result.sessionId ?? "",
  });
  ledger.setState(
    taskId,
    result.state === "completed" ? "completed" : result.state === "cancelled" ? "cancelled" : "failed",
  );
  if (result.error !== undefined) ledger.error(taskId, result.error.code, result.error.message);
}

/** Render a remote result as the text the parent agent receives. */
export function formatResult(result: RemoteTaskResult): string {
  const lines = [result.summary];
  if (result.artifacts.length > 0) {
    lines.push("", "Artifacts:");
    for (const artifact of result.artifacts) {
      const where = artifact.path ?? "";
      const detail = artifact.detail ?? artifact.command ?? "";
      lines.push(`- [${artifact.kind}] ${where} ${detail}`.trim());
    }
  }
  if (result.sessionId !== undefined) lines.push("", `Remote session: ${result.sessionId}`);
  if (result.error !== undefined) lines.push("", `Failure: ${result.error.code}: ${result.error.message}`);
  return lines.join("\n");
}
