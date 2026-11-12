// RPC method table: what this device will do when a paired peer asks.
//
// Every handler re-checks the operator's permissions; a handler never assumes the caller
// was already validated by the handshake. Authentication is not authorization. Denials
// throw a typed `RpcError` whose `code` reaches the caller verbatim, so the far side can
// tell "you may not" from "that file is gone".
//
// Method names are stable and documented in docs/guides/tools.md; the mesh_* tools are
// thin wrappers around them.

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import {
  appendChunk,
  checkCommandPolicy,
  execCommand,
  finalizeTransfer,
  listDirectory,
  readChunk,
  readFilePage,
  readLogPage,
  resolveInsideRoots,
  stagingFile,
  writeFileAtomic,
  type AuditLog,
  type ExecResult,
} from "../peer/capabilities.ts";
import { DeniedError } from "../peer/capabilities.ts";
import { RpcError } from "../rpc/peer.ts";
import type { MeshConfig } from "../config.ts";
import type { RemoteDelegationParams } from "../delegation/provider.ts";
import type { RemoteTaskRunner } from "../delegation/runner.ts";

export interface HandlerContextLike {
  from: string;
  signal: AbortSignal;
  emit(event: string, data: unknown, stream?: string): void;
}

export type Handler = (params: Record<string, unknown>, context: HandlerContextLike) => Promise<unknown>;

export interface HandlerDependencies {
  config: MeshConfig;
  stateDir: string;
  audit: AuditLog;
  deviceId(): string;
  capabilityDocument(): Record<string, unknown>;
  taskRunner(): RemoteTaskRunner | undefined;
}

/** Method names this device serves. Advertised in the hello and in mesh_capabilities. */
export const MESH_METHODS = [
  "mesh.ping",
  "mesh.capabilities",
  "mesh.fs.list",
  "mesh.fs.stat",
  "mesh.fs.read",
  "mesh.fs.write",
  "mesh.fs.mkdir",
  "mesh.exec",
  "mesh.logs.read",
  "mesh.logs.follow",
  "mesh.transfer.read",
  "mesh.transfer.write",
  "mesh.transfer.commit",
  "mesh.delegate",
  "mesh.task.result",
  "mesh.task.cancel",
  "mesh.task.list",
  "mesh.audit",
] as const;

function required(params: Record<string, unknown>, field: string): string {
  const value = params[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new RpcError("BAD_PARAMS", `"${field}" is required and must be a non-empty string`);
  }
  return value;
}

function numeric(params: Record<string, unknown>, field: string, fallback: number): number {
  const value = params[field];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function optionalString(params: Record<string, unknown>, field: string): string | undefined {
  const value = params[field];
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** Re-throw as the wire's typed error so the caller sees a stable code. */
function fail(error: unknown): never {
  if (error instanceof RpcError) throw error;
  if (error instanceof DeniedError) throw new RpcError(error.code, error.message);
  const code = (error as { code?: unknown }).code;
  const message = error instanceof Error ? error.message : String(error);
  throw new RpcError(typeof code === "string" ? code : "INTERNAL", message);
}

/** Build the handler table for one device. */
export function createHandlers(deps: HandlerDependencies): Record<string, Handler> {
  const { config, audit } = deps;
  const roots = config.permissions.allowedRoots;

  const note = (from: string, action: string, detail: string, outcome: "ok" | "denied" | "error"): void => {
    if (!config.audit.enabled) return;
    audit.record({ time: Date.now(), peer: from, action, detail: detail.slice(0, 600), outcome });
  };

  const handlers: Record<string, Handler> = {
    "mesh.ping": async () => ({ pong: Date.now(), device: deps.deviceId() }),

    "mesh.capabilities": async () => deps.capabilityDocument(),

    "mesh.fs.list": async (params, context) => {
      try {
        const { absolute } = resolveInsideRoots(required(params, "path"), roots, { mustExist: true });
        const limit = Math.min(5_000, Math.max(1, numeric(params, "limit", 500)));
        const result = listDirectory(absolute, limit);
        note(context.from, "fs.list", absolute, "ok");
        return { path: absolute, entries: result.entries, truncated: result.truncated };
      } catch (error) {
        note(context.from, "fs.list", String(params["path"] ?? ""), "denied");
        fail(error);
      }
    },

    "mesh.fs.stat": async (params) => {
      try {
        const { absolute } = resolveInsideRoots(required(params, "path"), roots, { mustExist: true });
        const stat = fs.statSync(absolute);
        return {
          path: absolute,
          kind: stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other",
          size: stat.size,
          modified: stat.mtimeMs,
          created: stat.birthtimeMs,
        };
      } catch (error) {
        fail(error);
      }
    },

    "mesh.fs.read": async (params, context) => {
      try {
        const { absolute } = resolveInsideRoots(required(params, "path"), roots, { mustExist: true });
        const offset = Math.max(0, numeric(params, "offset", 0));
        const maxLines = Math.min(20_000, Math.max(1, numeric(params, "maxLines", 2_000)));
        const result = readFilePage(absolute, offset, maxLines, config.permissions.exec.maxOutputBytes);
        note(context.from, "fs.read", `${absolute}@${offset}`, "ok");
        return result;
      } catch (error) {
        note(context.from, "fs.read", String(params["path"] ?? ""), "denied");
        fail(error);
      }
    },

    "mesh.fs.write": async (params, context) => {
      try {
        if (!config.permissions.allowWrite) {
          throw new DeniedError("WRITE_DISABLED", "remote file writes are disabled (permissions.allowWrite is false)");
        }
        const { absolute } = resolveInsideRoots(required(params, "path"), roots, { mustExist: false });
        const content = params["content"];
        if (typeof content !== "string") throw new DeniedError("BAD_PARAMS", `"content" is required`);
        const expected = optionalString(params, "expectedVersion");
        const result = writeFileAtomic(absolute, content, expected);
        note(context.from, "fs.write", absolute, "ok");
        return result;
      } catch (error) {
        note(context.from, "fs.write", String(params["path"] ?? ""), "denied");
        fail(error);
      }
    },

    "mesh.fs.mkdir": async (params, context) => {
      try {
        if (!config.permissions.allowWrite) {
          throw new DeniedError("WRITE_DISABLED", "remote directory creation is disabled (permissions.allowWrite is false)");
        }
        const { absolute } = resolveInsideRoots(required(params, "path"), roots, { mustExist: false });
        fs.mkdirSync(absolute);
        note(context.from, "fs.mkdir", absolute, "ok");
        return { path: absolute, created: true };
      } catch (error) {
        fail(error);
      }
    },

    "mesh.exec": async (params, context) => {
      try {
        if (!config.permissions.allowExec) {
          throw new DeniedError("EXEC_DISABLED", "remote command execution is disabled (permissions.allowExec is false)");
        }
        const command = required(params, "command");
        const cwdParam = optionalString(params, "cwd") ?? roots[0];
        if (cwdParam === undefined) {
          throw new DeniedError("NO_ROOTS", "cannot pick a working directory: permissions.allowedRoots is empty");
        }
        const { absolute: cwd } = resolveInsideRoots(cwdParam, roots, { mustExist: true });
        // Policy runs before the spawn: a denied command never reaches the OS.
        const words = command.trim().split(/\s+/);
        checkCommandPolicy(words[0] ?? "", words.slice(1), config.permissions);
        const timeoutMs = Math.min(
          config.permissions.exec.maxTimeoutMs,
          Math.max(1_000, numeric(params, "timeoutMs", config.permissions.exec.defaultTimeoutMs)),
        );
        const env = typeof params["env"] === "object" && params["env"] !== null ? (params["env"] as Record<string, string>) : undefined;
        const result: ExecResult = await execCommand({
          command,
          cwd,
          timeoutMs,
          maxOutputBytes: config.permissions.exec.maxOutputBytes,
          signal: context.signal,
          env,
        });
        note(context.from, "exec", `${cwd}> ${command}`, result.exitCode === 0 ? "ok" : "error");
        return result;
      } catch (error) {
        note(context.from, "exec", String(params["command"] ?? ""), "denied");
        fail(error);
      }
    },

    "mesh.logs.read": async (params, context) => {
      try {
        const { absolute } = resolveInsideRoots(required(params, "path"), roots, { mustExist: true });
        const offset = Math.max(0, numeric(params, "offset", 0));
        const maxLines = Math.min(5_000, Math.max(1, numeric(params, "maxLines", 200)));
        const page = readLogPage(absolute, offset, maxLines, config.permissions.exec.maxOutputBytes);
        note(context.from, "logs.read", `${absolute}@${offset}`, "ok");
        return page;
      } catch (error) {
        fail(error);
      }
    },

    "mesh.logs.follow": async (params, context) => {
      // A streaming request: the handler stays open, pushes `line` events, and finishes
      // when the caller cancels (the link's `ctl` frame aborts this handler's signal).
      try {
        const { absolute } = resolveInsideRoots(required(params, "path"), roots, { mustExist: true });
        const maxLines = Math.min(2_000, Math.max(1, numeric(params, "maxLines", 200)));
        const size = fs.statSync(absolute).size;
        let offset = Math.max(0, Math.min(numeric(params, "offset", size), size));
        const pollMs = Math.min(5_000, Math.max(250, numeric(params, "pollMs", 750)));
        const deadline =
          Date.now() +
          Math.min(config.permissions.maxTaskMs, Math.max(10_000, numeric(params, "durationMs", 60_000)));
        const stream = optionalString(params, "stream");
        let truncated = false;
        while (!context.signal.aborted && Date.now() < deadline) {
          const current = fs.statSync(absolute);
          if (current.size < offset) {
            // Rotation or truncation: restart from the top and tell the caller why the
            // offsets it already consumed no longer line up.
            offset = 0;
            truncated = true;
            context.emit("truncated", { path: absolute, size: current.size }, stream);
          }
          if (current.size > offset) {
            const page = readLogPage(absolute, offset, maxLines, config.permissions.exec.maxOutputBytes);
            for (const line of page.lines) context.emit("line", { line }, stream);
            offset = page.nextOffset;
            continue;
          }
          await sleep(pollMs, context.signal);
        }
        note(context.from, "logs.follow", `${absolute}@${offset}`, "ok");
        return {
          path: absolute,
          offset,
          truncated,
          stopped: context.signal.aborted ? "cancelled" : "deadline",
        };
      } catch (error) {
        fail(error);
      }
    },

    "mesh.transfer.read": async (params) => {
      try {
        const { absolute } = resolveInsideRoots(required(params, "path"), roots, { mustExist: true });
        const offset = Math.max(0, numeric(params, "offset", 0));
        const length = Math.min(8 * 1024 * 1024, Math.max(1, numeric(params, "length", 1024 * 1024)));
        return readChunk(absolute, offset, length);
      } catch (error) {
        fail(error);
      }
    },

    "mesh.transfer.write": async (params, context) => {
      try {
        if (!config.permissions.allowWrite) {
          throw new DeniedError("WRITE_DISABLED", "inbound transfers are disabled (permissions.allowWrite is false)");
        }
        const { absolute } = resolveInsideRoots(required(params, "path"), roots, { mustExist: false });
        const transferId = required(params, "transferId");
        const chunk = required(params, "chunk");
        const offset = numeric(params, "offset", 0);
        const staged = stagingFile(deps.stateDir, transferId);
        const result = appendChunk(staged, chunk, offset, context.signal);
        note(context.from, "transfer.write", `${absolute}@${offset}`, "ok");
        return { transferId, stagedBytes: result.size, target: absolute };
      } catch (error) {
        note(context.from, "transfer.write", String(params["path"] ?? ""), "denied");
        fail(error);
      }
    },

    "mesh.transfer.commit": async (params, context) => {
      try {
        if (!config.permissions.allowWrite) {
          throw new DeniedError("WRITE_DISABLED", "inbound transfers are disabled (permissions.allowWrite is false)");
        }
        const { absolute } = resolveInsideRoots(required(params, "path"), roots, { mustExist: false });
        const transferId = required(params, "transferId");
        const expectedSha = optionalString(params, "sha256") ?? "";
        const staged = stagingFile(deps.stateDir, transferId);
        if (!fs.existsSync(staged)) {
          throw new DeniedError("NO_STAGED_FILE", `no staging file exists for transfer "${transferId}"`);
        }
        const result = await finalizeTransfer(staged, absolute, expectedSha);
        note(context.from, "transfer.commit", `${absolute} (${result.bytes} bytes)`, "ok");
        return { path: absolute, ...result };
      } catch (error) {
        fail(error);
      }
    },

    "mesh.delegate": async (params, context) => {
      try {
        if (!config.permissions.allowDelegate) {
          throw new DeniedError(
            "DELEGATE_DISABLED",
            "this device does not accept delegated tasks (permissions.allowDelegate is false)",
          );
        }
        const runner = deps.taskRunner();
        if (runner === undefined) {
          throw new DeniedError(
            "NO_TASK_RUNNER",
            "this device cannot run delegated tasks because the agents service is unavailable in this DSH composition",
          );
        }
        const task = required(params, "task");
        const delegation: RemoteDelegationParams = {
          task,
          label: optionalString(params, "label") ?? "mesh delegation",
          cwd: optionalString(params, "cwd"),
          remainingDepth: Math.max(0, numeric(params, "remainingDepth", 0)),
          requestKey: optionalString(params, "requestKey"),
          stream: optionalString(params, "stream") ?? `task:${randomUUID()}`,
          timeoutMs: Math.min(
            config.permissions.maxTaskMs,
            Math.max(10_000, numeric(params, "timeoutMs", config.permissions.maxTaskMs)),
          ),
        };
        const accepted = runner.submit(delegation, context);
        note(context.from, "delegate", `${delegation.label}: ${task.slice(0, 200)}`, "ok");
        return accepted;
      } catch (error) {
        note(context.from, "delegate", String(params["task"] ?? "").slice(0, 200), "denied");
        fail(error);
      }
    },

    "mesh.task.result": async (params) => {
      const runner = deps.taskRunner();
      if (runner === undefined) throw new RpcError("NO_TASK_RUNNER", "this device has no task runner");
      try {
        return runner.result(required(params, "taskId"));
      } catch (error) {
        fail(error);
      }
    },

    "mesh.task.cancel": async (params, context) => {
      const runner = deps.taskRunner();
      if (runner === undefined) throw new RpcError("NO_TASK_RUNNER", "this device has no task runner");
      const taskId = required(params, "taskId");
      try {
        const result = runner.cancel(taskId);
        note(context.from, "task.cancel", taskId, "ok");
        return result;
      } catch (error) {
        fail(error);
      }
    },

    "mesh.task.list": async () => {
      const runner = deps.taskRunner();
      return { running: runner?.listRunning() ?? [] };
    },

    "mesh.audit": async (params) => ({
      entries: audit.recent(Math.min(500, Math.max(1, numeric(params, "limit", 50)))),
    }),
  };

  return handlers;
}

/** Cancel-aware sleep used by the log follower. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    timer.unref?.();
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
