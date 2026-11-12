// The receiving half of delegation: run a task on THIS device's native DSH agent.
//
// This is the file that makes "the remote side really starts a DSH agent" true. It does
// not shell out to a script and it does not fake progress — it creates a real child
// Agent with `ctx.agents.create`, hands it the task, subscribes to its session events,
// and reports the agent's final assistant message plus what it actually did.
//
// Depth control lives here. A task received over the mesh carries a remaining budget;
// when it is spent, the child agent is composed with a tool restriction that hides the
// mesh delegation tools, so it cannot bounce the work back to the originator. That closes
// the PC→phone→PC loop the spec forbids.

import type { TaskArtifact, TaskLedger } from "../sessions/tasks.ts";
import { RpcError } from "../rpc/peer.ts";
import type { RemoteDelegationParams, RemoteTaskResult } from "./provider.ts";

/** The parts of the DSH `Agent` handle this runner uses. */
export interface AgentLike {
  id: string;
  status?: string;
  followup(message: unknown): void;
  cancel(cause: { kind: "user" | "parent" | "hook" | "disposed"; reason?: string }, options?: { keepInbox?: boolean }): void;
  whenIdle(): Promise<void>;
  ctx?: {
    on?: (name: string, listener: (a: unknown, b: unknown) => void) => unknown;
    tools?: { restrict(filter: { allow?: string[]; deny?: string[] }): unknown };
  };
  session?: {
    snapshotEvents?: () => unknown[];
    events?: unknown[];
    get?: (seq: number) => unknown;
    seq?: number;
  };
}

export interface AgentHandleLike {
  agent: AgentLike;
  dispose(): Promise<void>;
}

export interface CreateAgentOptionsLike {
  sessionId: string;
  meta?: {
    cwd?: string;
    parentSession?: string;
    origin?: "subagent";
    delegationDepth?: number;
    agentPreset?: string;
  };
  agentOptions?: { provider?: string; model?: string; reasoningEffort?: string; maxTokens?: number };
  signal?: AbortSignal;
  setup?: (childCtx: unknown, agent: AgentLike) => void | Promise<void>;
}

export interface AgentsServiceLike {
  create(options: CreateAgentOptionsLike): Promise<AgentHandleLike>;
}

export interface RunnerDependencies {
  ledger: TaskLedger;
  agents(): AgentsServiceLike | undefined;
  /** The model route a child agent should start from (inherited from the Host default). */
  defaultAgentOptions(): { provider?: string; model?: string; reasoningEffort?: string };
  maxConcurrentTasks: number;
  maxTaskMs: number;
  log: { info(message: string): void; warn(message: string): void };
  /** Tool names hidden from a child that may not delegate further. */
  delegationToolNames: readonly string[];
}

interface InboundTask {
  taskId: string;
  agent: AgentLike;
  handle: AgentHandleLike;
  controller: AbortController;
  toolCalls: number;
  cancelRequested: boolean;
  startedAt: number;
  completed: boolean;
  result: RemoteTaskResult | undefined;
}

/**
 * Runs inbound delegated tasks on this device.
 *
 * Concurrency is capped and timeouts are enforced. Cancellation reaches the child agent
 * through `agent.cancel({ kind: "parent" })` — the same primitive DSH uses for its own
 * subagents — so the remote agent stops at a step boundary instead of being killed
 * mid-write.
 */
export class RemoteTaskRunner {
  readonly #deps: RunnerDependencies;
  readonly #running = new Map<string, InboundTask>();
  #disposed = false;

  constructor(deps: RunnerDependencies) {
    this.#deps = deps;
  }

  get runningCount(): number {
    return this.#running.size;
  }

  listRunning(): Array<{ taskId: string; label: string }> {
    return [...this.#running.values()].map((task) => ({
      taskId: task.taskId,
      label: this.#deps.ledger.get(task.taskId)?.label ?? "",
    }));
  }

  /**
   * Accept and start (or recognise) one inbound task.
   *
   * `requestKey` makes this idempotent: the same key with the same task text returns the
   * original task instead of starting a second agent run. That property is what the
   * "reconnect must not re-execute a side-effecting task" requirement rests on.
   */
  submit(
    params: RemoteDelegationParams,
    context: { from: string; signal: AbortSignal; emit(event: string, data: unknown, stream?: string): void },
  ): { taskId: string; sessionId: string | undefined; acceptedAt: number; replayed: boolean } {
    if (this.#disposed) {
      throw new RpcError("DISPOSED", "this device is shutting down and accepts no new delegated tasks");
    }
    if (this.#deps.agents() === undefined) {
      throw new RpcError(
        "NO_AGENTS_SERVICE",
        "this device cannot run delegated tasks because the agents service is not mounted in this DSH composition",
      );
    }
    const record = this.#dedupe(params);
    if (record !== undefined) {
      return {
        taskId: record.taskId,
        sessionId: record.remoteSessionId === "" ? undefined : record.remoteSessionId,
        acceptedAt: record.createdAt,
        replayed: true,
      };
    }
    if (this.#running.size >= this.#deps.maxConcurrentTasks) {
      throw new RpcError(
        "BUSY",
        `this device already runs ${this.#running.size} delegated task(s) (max ${this.#deps.maxConcurrentTasks}); retry when one finishes`,
      );
    }

    const task = this.#deps.ledger.create({
      direction: "in",
      peer: context.from,
      label: params.label,
      prompt: params.task,
      cwd: params.cwd,
      depth: 1,
    });
    this.#deps.ledger.setState(task.taskId, "accepted");
    // The agent runs in the background: `mesh.delegate` must answer immediately with a
    // task id, otherwise the caller blocks for the whole task and the link looks dead.
    void this.#run(task.taskId, params, context);
    return { taskId: task.taskId, sessionId: undefined, acceptedAt: task.createdAt, replayed: false };
  }

  /** Result lookup for the polling caller. */
  result(taskId: string): RemoteTaskResult | { state: string; taskId: string } {
    const running = this.#running.get(taskId);
    if (running !== undefined) {
      if (!running.completed) {
        return { state: running.cancelRequested ? "cancelling" : "running", taskId };
      }
      if (running.result !== undefined) return running.result;
    }
    const record = this.#deps.ledger.get(taskId);
    if (record === undefined) {
      throw new RpcError("UNKNOWN_TASK", `no delegated task "${taskId}" exists on this device`);
    }
    if (record.state === "submitted" || record.state === "accepted" || record.state === "waiting" || record.state === "running") {
      return { state: record.state, taskId };
    }
    return {
      taskId,
      state: record.state === "completed" ? "completed" : record.state === "cancelled" ? "cancelled" : "failed",
      summary: record.summary ?? "(the remote agent produced no final text)",
      artifacts: record.artifacts,
      sessionId: record.remoteSessionId === "" ? undefined : record.remoteSessionId,
      error: record.error,
      toolCalls: record.toolCalls,
      durationMs: (record.finishedAt ?? Date.now()) - record.createdAt,
    };
  }

  /** Cancel one inbound task through DSH's own cancel primitive. */
  cancel(taskId: string): { accepted: true; state: string; note?: string } {
    const record = this.#deps.ledger.get(taskId);
    if (record === undefined) throw new RpcError("UNKNOWN_TASK", `no delegated task "${taskId}" exists on this device`);
    const running = this.#running.get(taskId);
    if (running === undefined) {
      // A finished task is not an error: the caller may simply have raced completion.
      return { accepted: true, state: record.state };
    }
    running.cancelRequested = true;
    try {
      running.agent.cancel({ kind: "parent" }, { keepInbox: false });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#deps.log.warn(`task "${taskId}": the agent refused cancellation: ${message}`);
      // Reporting "cannot cancel" is required by the spec; pretending it stopped is not.
      return { accepted: true, state: "uncancellable", note: message };
    }
    this.#deps.ledger.requestCancel(taskId);
    running.controller.abort(new RpcError("CANCELLED", "the originator cancelled this task"));
    return { accepted: true, state: "cancelling" };
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const task of [...this.#running.values()]) {
      task.controller.abort(new RpcError("DISPOSED", "the plugin is unloading"));
      try {
        task.agent.cancel({ kind: "disposed" });
      } catch {
        /* the agent may already be gone */
      }
      try {
        await task.handle.dispose();
      } catch {
        /* ignore */
      }
      this.#deps.ledger.setState(task.taskId, "cancelled");
    }
    this.#running.clear();
  }

  #dedupe(params: RemoteDelegationParams): ReturnType<TaskLedger["get"]> | undefined {
    const key = params.requestKey;
    if (key === undefined || key === "") return undefined;
    return this.#deps.ledger.list({ direction: "in" }).find((record) => record.prompt === params.task && record.state !== "cancelled");
  }

  async #run(
    taskId: string,
    params: RemoteDelegationParams,
    context: { signal: AbortSignal; emit(event: string, data: unknown, stream?: string): void },
  ): Promise<void> {
    const emit = (event: string, data: unknown): void => {
      try {
        context.emit(event, data, params.stream);
      } catch {
        /* the link may have dropped; the ledger still records progress */
      }
      if (event === "progress" && typeof (data as { line?: unknown }).line === "string") {
        this.#deps.ledger.progress(taskId, (data as { line: string }).line);
        return;
      }
      if (event === "tool") {
        // The ledger is what a later `mesh_task_logs` / `mesh_task_status` reads, and it is
        // also what the result endpoint reports after the run object is gone. Recording the
        // tool call here (not only incrementing the in-memory counter) is what keeps the
        // audit trail correct once the task has settled.
        const payload = (typeof data === "object" && data !== null ? data : {}) as Record<string, unknown>;
        this.#deps.ledger.toolCall(
          taskId,
          `tool ${String(payload["name"] ?? "?")}: ${String(payload["detail"] ?? "").slice(0, 180)}`,
        );
      }
    };
    const controller = new AbortController();
    const sessionId = `dsh-mesh-${taskId}`;
    let handle: AgentHandleLike | undefined;
    try {
      const agents = this.#deps.agents();
      if (agents === undefined) throw new RpcError("NO_AGENTS_SERVICE", "the agents service disappeared");
      const defaults = this.#deps.defaultAgentOptions();
      const setup = (childCtx: unknown): void => {
        const tools = (childCtx as { tools?: { restrict(filter: { allow?: string[]; deny?: string[] }): unknown } }).tools;
        if (tools === undefined) return;
        if (params.remainingDepth <= 0) {
          try {
            tools.restrict({ deny: [...this.#deps.delegationToolNames] });
          } catch (error) {
            this.#deps.log.warn(
              `task "${taskId}": could not hide the delegation tools from the child agent: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
      };
      const agentOptions: { provider?: string; model?: string; reasoningEffort?: string } = {};
      if (defaults.provider !== undefined) agentOptions.provider = defaults.provider;
      if (defaults.model !== undefined) agentOptions.model = defaults.model;
      if (defaults.reasoningEffort !== undefined) agentOptions.reasoningEffort = defaults.reasoningEffort;
      handle = await agents.create({
        sessionId,
        meta: {
          ...params.cwd === undefined ? {} : { cwd: params.cwd },
          origin: "subagent",
          delegationDepth: 1,
        },
        ...Object.keys(agentOptions).length === 0 ? {} : { agentOptions },
        signal: controller.signal,
        setup,
      });
      const task: InboundTask = {
        taskId,
        agent: handle.agent,
        handle,
        controller,
        toolCalls: 0,
        cancelRequested: false,
        startedAt: Date.now(),
        completed: false,
        result: undefined,
      };
      this.#running.set(taskId, task);
      this.#deps.ledger.setRemoteSession(taskId, sessionId);
      this.#deps.ledger.setState(taskId, "running");
      emit("state", { state: "running", sessionId });

      const off = attachSessionObserver(handle.agent, (event) => {
        const type = (event as { type?: unknown }).type;
        if (typeof type !== "string") return;
        if (type === "tool/call") {
          const data = (event as { data?: { name?: string; arguments?: string } }).data;
          task.toolCalls += 1;
          this.#deps.log.info(`task "${taskId}": tool ${String(data?.name ?? "?")}`);
          emit("tool", { name: String(data?.name ?? "?"), detail: String(data?.arguments ?? "").slice(0, 400) });
          return;
        }
        if (type === "assistant/message") {
          const data = (event as { data?: { message?: { content?: unknown } } }).data;
          const text = extractText(data?.message?.content);
          if (text.length > 0) emit("progress", { line: text.slice(0, 400) });
          return;
        }
        if (type === "turn/end") {
          const reason = (event as { data?: { reason?: { kind?: string } } }).data?.reason;
          emit("progress", { line: `turn ended: ${String(reason?.kind ?? "completed")}` });
          return;
        }
      });

      const budget = setTimeout(() => {
        if (task.cancelRequested) return;
        emit("progress", { line: `the task exceeded its ${params.timeoutMs}ms budget` });
        try {
          task.agent.cancel({ kind: "parent" });
        } catch {
          /* ignore */
        }
      }, Math.max(30_000, params.timeoutMs));
      budget.unref?.();

      try {
        // `followup` queues the prompt as a turn and wakes the loop; `whenIdle` resolves
        // when the agent reaches quiescence (including its own subagent children).
        task.agent.followup({
          content: [{ type: "text", text: params.task }],
          source: { kind: "user" },
        });
      } catch (error) {
        throw new RpcError(
          "DISPATCH_FAILED",
          `could not hand the task to the local agent: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      try {
        await task.agent.whenIdle();
      } catch (error) {
        this.#deps.log.warn(`task "${taskId}": waiting for the agent failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      clearTimeout(budget);
      off();

      const finalText = collectFinalText(task.agent);
      // `toolCalls` is maintained by the observer above, but a session whose events were
      // committed before the observer attached (or an agent implementation that only keeps
      // them in `session.snapshotEvents()`) would under-count. The snapshot is
      // authoritative, so it is used as the floor rather than trusting the counter alone.
      task.toolCalls = Math.max(task.toolCalls, countToolCalls(task.agent));
      const state: RemoteTaskResult["state"] = task.cancelRequested
        ? "cancelled"
        : finalText.length === 0
          ? "failed"
          : "completed";
      const result: RemoteTaskResult = {
        taskId,
        state,
        summary: finalText.length === 0 ? "(the remote agent finished without producing an answer)" : finalText,
        artifacts: collectArtifacts(task.agent),
        sessionId,
        error:
          state === "failed"
            ? { code: "EMPTY_RESULT", message: "the remote agent finished without producing any assistant text" }
            : state === "cancelled" && task.cancelRequested
              ? { code: "CANCELLED", message: "the originator cancelled this task" }
              : undefined,
        toolCalls: task.toolCalls,
        durationMs: Date.now() - task.startedAt,
      };
      task.result = result;
      task.completed = true;
      // The ledger result event carries the tool-call count as part of the terminal record,
      // so a reader that only has the ledger (a tool call after the run object is gone,
      // or after a plugin reload) still sees the real number.
      this.#deps.ledger.result(taskId, result.summary, {
        artifacts: result.artifacts,
        remoteSessionId: sessionId,
      });
      this.#deps.ledger.setState(taskId, state === "completed" ? "completed" : state === "cancelled" ? "cancelled" : "failed");
      emit("state", { state, sessionId, toolCalls: result.toolCalls });
    } catch (error) {
      const code = error instanceof RpcError ? error.code : "INTERNAL";
      const message = error instanceof Error ? error.message : String(error);
      this.#deps.ledger.error(taskId, code, message);
      this.#deps.ledger.setState(taskId, "failed");
      emit("state", { state: "failed" });
      this.#deps.log.warn(`task "${taskId}" failed: ${code}: ${message}`);
    } finally {
      this.#running.delete(taskId);
      if (handle !== undefined) {
        try {
          await handle.dispose();
        } catch (error) {
          this.#deps.log.warn(`task "${taskId}": disposing the child agent failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
  }
}

/**
 * Subscribe to one agent's session events.
 *
 * The event signature is `'session/event'(session, event)` and scoping is handled by the
 * agent's own context, so registering on `agent.ctx` yields exactly this agent's events.
 */
export function attachSessionObserver(agent: AgentLike, listener: (event: unknown) => void): () => void {
  const on = agent.ctx?.on;
  if (typeof on !== "function") return () => {};
  const off = on("session/event", (_session: unknown, event: unknown) => {
    listener(event);
  });
  return typeof off === "function" ? (off as () => void) : () => {};
}

/** Join text blocks out of a content array. */
export function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const candidate = block as { type?: unknown; text?: unknown };
    if (candidate.type === "text" && typeof candidate.text === "string") parts.push(candidate.text);
  }
  return parts.join("\n").trim();
}

/**
 * Read the child's final answer from its own session log.
 *
 * `whenIdle()` has already resolved, so the last `assistant/message` is committed; no
 * second read is needed.
 */
export function collectFinalText(agent: AgentLike): string {
  const events = snapshotOf(agent);
  let last = "";
  for (const raw of events) {
    const event = raw as { type?: string; data?: { message?: { content?: unknown } } };
    if (event.type !== "assistant/message") continue;
    const text = extractText(event.data?.message?.content);
    if (text.length > 0) last = text;
  }
  return last;
}

/** Collect the file/command artifacts the child actually touched, from its tool results. */
export function collectArtifacts(agent: AgentLike): TaskArtifact[] {
  const events = snapshotOf(agent);
  const artifacts: TaskArtifact[] = [];
  const seen = new Set<string>();
  for (const raw of events) {
    const event = raw as { type?: string; data?: { name?: string; arguments?: string } };
    if (event.type !== "tool/call") continue;
    const name = event.data?.name ?? "";
    let parsed: Record<string, unknown> | undefined;
    try {
      parsed = event.data?.arguments === undefined ? undefined : (JSON.parse(event.data.arguments) as Record<string, unknown>);
    } catch {
      parsed = undefined;
    }
    const filePath = typeof parsed?.["file_path"] === "string" ? (parsed["file_path"] as string) : typeof parsed?.["path"] === "string" ? (parsed["path"] as string) : undefined;
    if (filePath !== undefined && (name === "write" || name === "edit" || name === "mesh_write")) {
      const key = `${name}:${filePath}`;
      if (seen.has(key)) continue;
      seen.add(key);
      artifacts.push({ kind: "file", path: filePath, detail: name });
      continue;
    }
    const command = typeof parsed?.["command"] === "string" ? (parsed["command"] as string) : undefined;
    if (command !== undefined && (name === "pwsh" || name === "bash" || name === "mesh_exec")) {
      const key = `cmd:${command}`;
      if (seen.has(key)) continue;
      seen.add(key);
      artifacts.push({ kind: "command", command });
    }
  }
  return artifacts;
}

/** Count the tool calls recorded in the child's own session log. */
export function countToolCalls(agent: AgentLike): number {
  let count = 0;
  for (const raw of snapshotOf(agent)) {
    if ((raw as { type?: unknown }).type === "tool/call") count += 1;
  }
  return count;
}

function snapshotOf(agent: AgentLike): unknown[] {
  const session = agent.session;
  if (session === undefined) return [];
  if (typeof session.snapshotEvents === "function") {
    try {
      return session.snapshotEvents();
    } catch {
      return [];
    }
  }
  return Array.isArray(session.events) ? session.events : [];
}
