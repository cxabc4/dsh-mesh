// Task ledger: the shared record of delegated work in both directions.
//
// Two things this file is responsible for, and both are safety properties rather than
// bookkeeping:
//
//   1. **No duplicate execution.** Every outbound delegation and every inbound task gets
//      a durable id; retrying the same logical request (after a reconnect, after a tool
//      retry, after the user says "again") is answered from the ledger instead of being
//      run a second time. This is what the spec calls "network retries must not
//      reinstall, re-compile, or re-modify".
//
//   2. **No infinite delegation.** Each task records its `depth` and whether it may
//      delegate further. A task received over the mesh is recorded with its inbound
//      depth, and the remote-executor refuses to start a nested delegation once the
//      configured budget is spent. The root agent may reassign; a child may not bounce
//      the same work back.
//
// The ledger is append-only on disk (JSONL) and folded into memory on load, so a crash
// mid-run leaves something diagnosable rather than an empty table.

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export type TaskState =
  | "submitted"
  | "accepted"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled"
  | "lost";

export interface TaskArtifact {
  kind: "file" | "command" | "text" | "log";
  path?: string;
  command?: string;
  exitCode?: number;
  detail?: string;
}

export interface TaskRecord {
  taskId: string;
  /** "out" = this device delegated it; "in" = a peer delegated it to this device. */
  direction: "out" | "in";
  /** Device id of the other side. */
  peer: string;
  label: string;
  prompt: string;
  cwd: string | undefined;
  state: TaskState;
  depth: number;
  createdAt: number;
  updatedAt: number;
  startedAt: number | undefined;
  finishedAt: number | undefined;
  /** Free-form progress lines, bounded. */
  progress: string[];
  summary: string | undefined;
  error: { code: string; message: string } | undefined;
  artifacts: TaskArtifact[];
  /** The remote session id, when the peer reported one. */
  remoteSessionId: string | undefined;
  /** Monotonic counters the UI can show without re-reading everything. */
  toolCalls: number;
  /** True when the task was cancelled by its originator. */
  cancelRequested: boolean;
}

export interface SubmitOptions {
  direction: "out" | "in";
  peer: string;
  label: string;
  prompt: string;
  cwd?: string;
  depth: number;
}

const MAX_PROGRESS_LINES = 200;

/** Fold one persisted line into the live record map. */
function applyEvent(records: Map<string, TaskRecord>, event: Record<string, unknown>): void {
  const kind = event["kind"];
  const taskId = event["taskId"];
  if (typeof taskId !== "string") return;
  const time = typeof event["time"] === "number" ? event["time"] : Date.now();
  if (kind === "created") {
    const record: TaskRecord = {
      taskId,
      direction: event["direction"] === "in" ? "in" : "out",
      peer: typeof event["peer"] === "string" ? event["peer"] : "",
      label: typeof event["label"] === "string" ? event["label"] : "",
      prompt: typeof event["prompt"] === "string" ? event["prompt"] : "",
      cwd: typeof event["cwd"] === "string" ? event["cwd"] : undefined,
      state: "submitted",
      depth: typeof event["depth"] === "number" ? event["depth"] : 0,
      createdAt: time,
      updatedAt: time,
      startedAt: undefined,
      finishedAt: undefined,
      progress: [],
      summary: undefined,
      error: undefined,
      artifacts: [],
      remoteSessionId: undefined,
      toolCalls: 0,
      cancelRequested: false,
    };
    records.set(taskId, record);
    return;
  }
  const record = records.get(taskId);
  if (record === undefined) return;
  record.updatedAt = time;
  if (kind === "state" && typeof event["state"] === "string") {
    const next = event["state"] as TaskState;
    record.state = next;
    if (next === "running" && record.startedAt === undefined) record.startedAt = time;
    if ((next === "completed" || next === "failed" || next === "cancelled" || next === "lost") && record.finishedAt === undefined) {
      record.finishedAt = time;
    }
    return;
  }
  if (kind === "progress" && typeof event["line"] === "string") {
    record.progress.push(event["line"]);
    while (record.progress.length > MAX_PROGRESS_LINES) record.progress.shift();
    return;
  }
  if (kind === "tool") {
    record.toolCalls += 1;
    if (typeof event["line"] === "string") {
      record.progress.push(event["line"]);
      while (record.progress.length > MAX_PROGRESS_LINES) record.progress.shift();
    }
    return;
  }
  if (kind === "result") {
    if (typeof event["summary"] === "string") record.summary = event["summary"];
    if (typeof event["remoteSessionId"] === "string") record.remoteSessionId = event["remoteSessionId"];
    if (Array.isArray(event["artifacts"])) {
      for (const candidate of event["artifacts"]) {
        if (typeof candidate === "object" && candidate !== null) record.artifacts.push(candidate as TaskArtifact);
      }
    }
    return;
  }
  if (kind === "error") {
    record.error = {
      code: typeof event["code"] === "string" ? event["code"] : "ERROR",
      message: typeof event["message"] === "string" ? event["message"] : "unknown remote failure",
    };
    return;
  }
  if (kind === "cancel-requested") {
    record.cancelRequested = true;
    return;
  }
  if (kind === "session") {
    if (typeof event["remoteSessionId"] === "string") record.remoteSessionId = event["remoteSessionId"];
  }
}

export class TaskLedger {
  readonly #records = new Map<string, TaskRecord>();
  readonly #file: string | undefined;
  readonly #listeners = new Set<(record: TaskRecord) => void>();
  #appendFailed = false;

  constructor(stateDir: string | undefined) {
    this.#file = stateDir === undefined ? undefined : path.join(stateDir, "tasks.jsonl");
    this.#load();
  }

  #load(): void {
    const file = this.#file;
    if (file === undefined || !fs.existsSync(file)) return;
    let text: string;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      return;
    }
    for (const line of text.split(/\r?\n/)) {
      if (line.trim().length === 0) continue;
      try {
        applyEvent(this.#records, JSON.parse(line) as Record<string, unknown>);
      } catch {
        /* one corrupt line must not lose the rest of the ledger */
      }
    }
  }

  #append(event: Record<string, unknown>): void {
    applyEvent(this.#records, event);
    const taskId = typeof event["taskId"] === "string" ? event["taskId"] : "";
    const record = this.#records.get(taskId);
    if (record !== undefined) {
      for (const listener of this.#listeners) {
        try {
          listener(record);
        } catch {
          /* ignore */
        }
      }
    }
    const file = this.#file;
    if (file === undefined || this.#appendFailed) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, `${JSON.stringify({ ...event, time: Date.now() })}\n`, "utf8");
    } catch {
      // Keep running in memory; a full disk must not take delegation down.
      this.#appendFailed = true;
    }
  }

  onChange(listener: (record: TaskRecord) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  create(options: SubmitOptions): TaskRecord {
    const taskId = randomUUID();
    this.#append({
      kind: "created",
      taskId,
      direction: options.direction,
      peer: options.peer,
      label: options.label,
      prompt: options.prompt,
      cwd: options.cwd,
      depth: options.depth,
    });
    const record = this.#records.get(taskId);
    if (record === undefined) throw new Error("task ledger failed to create a record");
    return record;
  }

  get(taskId: string): TaskRecord | undefined {
    return this.#records.get(taskId);
  }

  setState(taskId: string, state: TaskState): void {
    this.#append({ kind: "state", taskId, state });
  }

  progress(taskId: string, line: string): void {
    this.#append({ kind: "progress", taskId, line });
  }

  toolCall(taskId: string, line: string): void {
    this.#append({ kind: "tool", taskId, line });
  }

  result(
    taskId: string,
    summary: string,
    options: { artifacts?: TaskArtifact[]; remoteSessionId?: string } = {},
  ): void {
    this.#append({
      kind: "result",
      taskId,
      summary,
      ...options.artifacts === undefined ? {} : { artifacts: options.artifacts },
      ...options.remoteSessionId === undefined ? {} : { remoteSessionId: options.remoteSessionId },
    });
  }

  error(taskId: string, code: string, message: string): void {
    this.#append({ kind: "error", taskId, code, message });
  }

  requestCancel(taskId: string): void {
    this.#append({ kind: "cancel-requested", taskId });
  }

  setRemoteSession(taskId: string, remoteSessionId: string): void {
    this.#append({ kind: "session", taskId, remoteSessionId });
  }

  list(filter: { direction?: "in" | "out"; states?: TaskState[]; limit?: number } = {}): TaskRecord[] {
    const all = [...this.#records.values()];
    const filtered = all.filter((record) => {
      if (filter.direction !== undefined && record.direction !== filter.direction) return false;
      if (filter.states !== undefined && !filter.states.includes(record.state)) return false;
      return true;
    });
    filtered.sort((left, right) => right.createdAt - left.createdAt);
    return filter.limit === undefined ? filtered : filtered.slice(0, filter.limit);
  }

  active(direction?: "in" | "out"): TaskRecord[] {
    const states: TaskState[] = ["submitted", "accepted", "running", "waiting"];
    return this.list({ direction, states });
  }
}

/**
 * Idempotency guard for non-idempotent remote operations.
 *
 * A `mesh_delegate` retried after a reconnect carries the same `requestKey`; the guard
 * returns the first task id instead of starting a second one. Expired keys are dropped
 * after `windowMs`, which is the point where "retry" stops being plausible and starts
 * being a new request.
 */
export class ReplayGuard {
  readonly #entries = new Map<string, { taskId: string; at: number }>();
  readonly #windowMs: number;
  #lastSweep = 0;

  constructor(windowMs: number) {
    this.#windowMs = windowMs;
  }

  /** Return the previous task id for this key, or claim the key for a new task. */
  claim(key: string, create: () => string): { taskId: string; replayed: boolean } {
    const now = Date.now();
    this.#sweep(now);
    const existing = this.#entries.get(key);
    if (existing !== undefined && now - existing.at <= this.#windowMs) {
      return { taskId: existing.taskId, replayed: true };
    }
    const taskId = create();
    this.#entries.set(key, { taskId, at: now });
    return { taskId, replayed: false };
  }

  #sweep(now: number): void {
    if (now - this.#lastSweep < 60_000) return;
    this.#lastSweep = now;
    for (const [key, entry] of this.#entries) {
      if (now - entry.at > this.#windowMs) this.#entries.delete(key);
    }
  }
}

/** Render a task record as the compact object every mesh_task_* tool returns. */
export function taskView(record: TaskRecord, includePrompt = false): Record<string, unknown> {
  return {
    taskId: record.taskId,
    direction: record.direction,
    peer: record.peer,
    label: record.label,
    state: record.state,
    depth: record.depth,
    createdAt: record.createdAt,
    ...record.startedAt === undefined ? {} : { startedAt: record.startedAt },
    ...record.finishedAt === undefined ? {} : { finishedAt: record.finishedAt, durationMs: record.finishedAt - record.createdAt },
    progressLines: record.progress.length,
    lastProgress: record.progress.slice(-5),
    toolCalls: record.toolCalls,
    ...record.summary === undefined ? {} : { summary: record.summary },
    ...record.error === undefined ? {} : { error: record.error },
    ...record.artifacts.length === 0 ? {} : { artifacts: record.artifacts },
    ...record.remoteSessionId === undefined ? {} : { remoteSessionId: record.remoteSessionId },
    ...record.cancelRequested ? { cancelRequested: true } : {},
    ...includePrompt ? { prompt: record.prompt } : {},
  };
}
