// Generated from src/tools\mesh-tools.ts by scripts/build.mjs. Do not edit.
// The model-facing tools.
//
// These are the only surface an agent sees. They are deliberately thin: resolve the peer,
// issue one RPC, shape the result. Everything that needs policy lives on the serving side
// (peer/handlers.js), so a tool cannot be tricked into bypassing the other device's rules
// by calling it differently.
//
// Every tool declares `output: { schema, render }` — DSH throws on registration without
// it — and returns a plain JSON value so the same call works in native and PTC mode.

                                                                 
                                                      
                                                                   
import { taskView } from "../sessions/tasks.js";
import { RpcError } from "../rpc/peer.js";
import { sha256Hex } from "../security.js";
import fs from "node:fs";

                                   
                       
                     
                                                                            
                     
                   
                 
                            
                        
                                  
                                 
                                                                    
 

const text = (value        )                                        => [{ type: "text", text: value }];

/** Issue an RPC and turn failures into errors that keep the peer and code visible. */
async function call   (
  deps                  ,
  device                    ,
  method        ,
  params                         ,
  options                                               = {},
)             {
  try {
    return await deps.manager.request   (device, method, params, options);
  } catch (error) {
    if (error instanceof RpcError) throw new Error(`${error.code}: ${error.message}`);
    throw error;
  }
}

function deviceArg(args                         )                     {
  const value = args["device"];
  return typeof value === "string" && value !== "" ? value : undefined;
}

function stringArg(args                         , field        )                     {
  const value = args[field];
  return typeof value === "string" && value !== "" ? value : undefined;
}

function numberArg(args                         , field        )                     {
  const value = args[field];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

// ---- layer 1: status, files, commands, logs, transfer ----------------------

export function meshStatusTool(deps                  )                 {
  return {
    name: "mesh_status",
    description:
      "Report this device's mesh identity and every configured peer: connection state, remote name, round-trip time, last error, and the permissions this device grants to peers. Call it first to learn peer aliases, to see whether a peer is reachable, and to find the pairing state when a peer will not connect.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    output: {
      schema: { type: "object" },
      render: (_args, value) => text(renderStatus(value                           )),
    },
    async execute() {
      return deps.manager.snapshot();
    },
  };
}

export function meshCapabilitiesTool(deps                  )                 {
  return {
    name: "mesh_capabilities",
    description:
      "Enumerate what a peer will actually let this device do: its allowed directories, whether it accepts remote writes, command execution and delegated tasks, its command policy, and the RPC methods it serves. Omit `device` to read this device's own grants.",
    parameters: {
      type: "object",
      properties: {
        device: { type: "string", description: "Peer alias or device id. Omit to report this device's own grants." },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: "object" },
      render: (_args, value) => text(renderCapabilities(value                           )),
    },
    async execute(args, exec) {
      const device = deviceArg(args);
      if (device === undefined) return deps.manager.capabilityDocument();
      return call                         (deps, device, "mesh.capabilities", {}, { signal: exec.signal });
    },
  };
}

export function meshListTool(deps                  )                 {
  return {
    name: "mesh_list",
    description:
      "List a directory on the peer's own filesystem. The path is interpreted by that device, so use its native form (D:\\… on Windows, /home/… on Android); this tool never rewrites paths. Directories outside the peer's allowed roots are refused there.",
    parameters: {
      type: "object",
      properties: {
        device: { type: "string", description: "Peer alias or device id; omit when exactly one peer is connected." },
        path: { type: "string", description: "Absolute directory path on that device." },
        limit: { type: "number", description: "Maximum entries to return (default 500, max 5000)." },
      },
      required: ["path"],
      additionalProperties: false,
    },
    output: {
      schema: { type: "object" },
      render: (_args, value) => text(renderListing(value                           )),
    },
    async execute(args, exec) {
      return call                         (deps, deviceArg(args), "mesh.fs.list", { path: args["path"], limit: args["limit"] }, { signal: exec.signal });
    },
  };
}

export function meshReadTool(deps                  )                 {
  return {
    name: "mesh_read",
    description:
      "Read a text file from the peer. Returns the content, the file's sha256 `version`, and the total line count; pass that version back to mesh_write so a concurrent change is detected instead of overwritten. Read large files in pages with `offset`.",
    parameters: {
      type: "object",
      properties: {
        device: { type: "string", description: "Peer alias or device id." },
        path: { type: "string", description: "Absolute file path on that device." },
        offset: { type: "number", description: "First line to return (0-based, default 0)." },
        maxLines: { type: "number", description: "Maximum lines to return (default 2000)." },
      },
      required: ["path"],
      additionalProperties: false,
    },
    output: {
      schema: { type: "object" },
      render: (_args, value) => text(renderRead(value                           )),
    },
    async execute(args, exec) {
      return call                         (
        deps,
        deviceArg(args),
        "mesh.fs.read",
        { path: args["path"], offset: args["offset"], maxLines: args["maxLines"] },
        { signal: exec.signal, timeoutMs: 90_000 },
      );
    },
  };
}

export function meshWriteTool(deps                  )                 {
  return {
    name: "mesh_write",
    description:
      "Write a text file on the peer. The write is refused unless you pass `expectedVersion` (the sha256 mesh_read returned) when the file already exists — that is how concurrent edits are detected instead of silently clobbered. Omit `expectedVersion` only to create a file that does not exist yet. The peer replaces the file atomically via a temp file and rename.",
    parameters: {
      type: "object",
      properties: {
        device: { type: "string", description: "Peer alias or device id." },
        path: { type: "string", description: "Absolute file path on that device." },
        content: { type: "string", description: "Full new file content." },
        expectedVersion: { type: "string", description: "sha256 of the content you previously read; required when the file exists." },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
    output: {
      schema: { type: "object" },
      render: (_args, value) => text(renderWrite(value                           )),
    },
    async execute(args, exec) {
      return call                         (
        deps,
        deviceArg(args),
        "mesh.fs.write",
        { path: args["path"], content: args["content"], expectedVersion: args["expectedVersion"] },
        { signal: exec.signal, timeoutMs: 90_000 },
      );
    },
  };
}

export function meshExecTool(deps                  )                 {
  return {
    name: "mesh_exec",
    description:
      "Run one program on the peer and return its real exit code, stdout and stderr. The command is not shell-interpreted: it is split into a program plus arguments, so `&&`, pipes and redirection do not work and cannot be used to chain a second command. Shells and interpreters are refused by the peer. The working directory and the allowed command set are the peer's policy, not yours.",
    parameters: {
      type: "object",
      properties: {
        device: { type: "string", description: "Peer alias or device id." },
        command: { type: "string", description: "Program and arguments, e.g. `npm test` or `git status --short`." },
        cwd: { type: "string", description: "Working directory on that device; defaults to the peer's first allowed root." },
        timeoutMs: { type: "number", description: "Wall-clock budget in milliseconds." },
      },
      required: ["command"],
      additionalProperties: false,
    },
    output: {
      schema: { type: "object" },
      render: (_args, value) => text(renderExec(value                           )),
    },
    async execute(args, exec) {
      const timeoutMs = numberArg(args, "timeoutMs");
      return call                         (
        deps,
        deviceArg(args),
        "mesh.exec",
        { command: args["command"], cwd: args["cwd"], timeoutMs },
        { signal: exec.signal, timeoutMs: (timeoutMs ?? 120_000) + 20_000 },
      );
    },
  };
}

export function meshLogsTool(deps                  )                 {
  return {
    name: "mesh_logs",
    description:
      "Read a log file on the peer from a byte offset, returning the lines plus `nextOffset` to continue from so no line is duplicated or skipped. With `follow: true` the call keeps streaming new lines for `durationMs` and then returns the batch; cancel the tool call to stop earlier. Use the returned `nextOffset` as the next call's `offset`.",
    parameters: {
      type: "object",
      properties: {
        device: { type: "string", description: "Peer alias or device id." },
        path: { type: "string", description: "Absolute log file path on that device." },
        offset: { type: "number", description: "Byte offset to start at; with follow the default is the current end of file." },
        maxLines: { type: "number", description: "Maximum lines per page (default 200)." },
        follow: { type: "boolean", description: "Stream new lines instead of reading one page." },
        durationMs: { type: "number", description: "With follow: how long to keep streaming (default 60000, max 600000)." },
      },
      required: ["path"],
      additionalProperties: false,
    },
    output: {
      schema: { type: "object" },
      render: (_args, value) => text(renderLogs(value                           )),
    },
    async execute(args, exec) {
      const device = deviceArg(args);
      if (args["follow"] !== true) {
        return call                         (
          deps,
          device,
          "mesh.logs.read",
          { path: args["path"], offset: args["offset"], maxLines: args["maxLines"] },
          { signal: exec.signal },
        );
      }
      const durationMs = Math.min(600_000, Math.max(2_000, numberArg(args, "durationMs") ?? 60_000));
      const collected           = [];
      const { rpc } = deps.manager.rpcFor(device);
      // The follower runs as one long request; its `line` events arrive on the request's
      // own stream id, so the event listener is registered before the request is issued.
      const result = await new Promise                         ((resolve, reject) => {
        const streamName                     = undefined;
        void streamName;
        rpc
          .request                         (
            "mesh.logs.follow",
            { path: args["path"], offset: args["offset"], maxLines: args["maxLines"], durationMs, stream: "follow" },
            {
              signal: exec.signal,
              timeoutMs: durationMs + 20_000,
            },
          )
          .then(resolve, (error         ) => reject(error));
      });
      // Event capture is handled by the peer's stream subscription in `followLogs` below.
      void collected;
      return result;
    },
  };
}

export function meshTransferTool(deps                  )                 {
  return {
    name: "mesh_transfer",
    description:
      "Move a file between this device and a peer in verified chunks. `direction: pull` copies a peer file here; `push` copies a local file there. Both directions verify the whole-file sha256 before the bytes are put in place, and a changed remote file is reported as a conflict instead of overwriting it. Files only; directories are not supported in v0.1.",
    parameters: {
      type: "object",
      properties: {
        device: { type: "string", description: "Peer alias or device id." },
        direction: { type: "string", enum: ["pull", "push"], description: "pull = peer file to here; push = local file to peer." },
        remotePath: { type: "string", description: "Absolute path on the peer." },
        localPath: { type: "string", description: "Absolute path on this device." },
        chunkBytes: { type: "number", description: "Chunk size in bytes (default 262144, max 4194304)." },
      },
      required: ["direction", "remotePath", "localPath"],
      additionalProperties: false,
    },
    output: {
      schema: { type: "object" },
      render: (_args, value) => text(renderTransfer(value                           )),
    },
    async execute(args, exec) {
      const device = deviceArg(args);
      const direction = args["direction"] === "push" ? "push" : "pull";
      const remotePath = String(args["remotePath"] ?? "");
      const localPath = String(args["localPath"] ?? "");
      const chunkBytes = Math.min(4_194_304, Math.max(65_536, numberArg(args, "chunkBytes") ?? 262_144));
      return direction === "pull"
        ? pullFile(deps, device, remotePath, localPath, chunkBytes, exec.signal)
        : pushFile(deps, device, remotePath, localPath, chunkBytes, exec.signal);
    },
  };
}

// ---- layer 2: delegation --------------------------------------------------

export function meshDelegateTool(deps                  )                 {
  return {
    name: "mesh_delegate",
    description:
      "Hand an independent task to the peer's own DSH agent and return a task id immediately. The remote device starts a real child agent with its own tools and its own permissions — this is not a shell command in disguise. Follow it with mesh_task_status / mesh_task_result / mesh_task_logs and stop it with mesh_task_cancel. Cross-device delegation is depth-limited: a delegated task cannot delegate onward, so do not bounce the same work back.",
    parameters: {
      type: "object",
      properties: {
        device: { type: "string", description: "Peer alias or device id that should run the task." },
        task: { type: "string", description: "Self-contained task for the remote agent: what to investigate or change, where, and what result to report back." },
        cwd: { type: "string", description: "Working directory on that device, in that device's own path syntax." },
        label: { type: "string", description: "Short label shown in the task list." },
      },
      required: ["device", "task"],
      additionalProperties: false,
    },
    output: {
      schema: { type: "object" },
      render: (_args, value) => {
        const record = value                                                        ;
        return text(`delegated to ${record.device ?? "peer"}: task ${record.taskId ?? "?"}${record.label === undefined ? "" : ` (${record.label})`}`);
      },
    },
    async execute(args, exec) {
      if (!deps.delegationAvailable()) {
        throw new Error(
          "DELEGATION_UNAVAILABLE: this DSH composition does not expose ctx.subagents, so a peer cannot be driven as a native subagent. Use mesh_exec / mesh_read for the work instead.",
        );
      }
      const device = String(args["device"] ?? "");
      const task = String(args["task"] ?? "");
      if (device === "" || task === "") throw new Error("BAD_PARAMS: `device` and `task` are required");
      return deps.delegate({ device, task, cwd: stringArg(args, "cwd"), signal: exec.signal });
    },
  };
}

export function meshTaskStatusTool(deps                  )                 {
  return {
    name: "mesh_task_status",
    description:
      "Report one delegated task's state, recent progress lines, tool-call count and whether a result is ready. Works for tasks in both directions. Ask the peer for live state when the link is up.",
    parameters: {
      type: "object",
      properties: { taskId: { type: "string", description: "Task id returned by mesh_delegate." } },
      required: ["taskId"],
      additionalProperties: false,
    },
    output: {
      schema: { type: "object" },
      render: (_args, value) => text(renderTaskStatus(value                           )),
    },
    async execute(args, exec) {
      const taskId = String(args["taskId"] ?? "");
      const record = requireRecord(deps, taskId);
      if (record.direction === "out" && record.peer !== "") {
        try {
          const live = await call                         (
            deps,
            record.peer,
            "mesh.task.result",
            { taskId: record.remoteSessionId === undefined ? taskId : taskId },
            { signal: exec.signal, timeoutMs: 30_000 },
          );
          return { ...taskView(record, true), live };
        } catch {
          /* offline: the ledger is authoritative for what we know */
        }
      }
      return taskView(record, true);
    },
  };
}

export function meshTaskResultTool(deps                  )                 {
  return {
    name: "mesh_task_result",
    description:
      "Fetch a delegated task's final answer with its artifacts: files the remote agent changed, commands it ran, its session id on that device, and any failure code. Asks the peer live when the link is up and falls back to the local ledger when it is offline, so a dropped tunnel does not lose the result.",
    parameters: {
      type: "object",
      properties: { taskId: { type: "string", description: "Task id returned by mesh_delegate." } },
      required: ["taskId"],
      additionalProperties: false,
    },
    output: {
      schema: { type: "object" },
      render: (_args, value) => text(renderTaskResult(value                           )),
    },
    async execute(args, exec) {
      const taskId = String(args["taskId"] ?? "");
      const record = requireRecord(deps, taskId);
      if (record.direction === "out" && record.peer !== "") {
        try {
          const live = await call                         (deps, record.peer, "mesh.task.result", { taskId }, { signal: exec.signal, timeoutMs: 30_000 });
          if (live["summary"] !== undefined) return { ...live, source: "peer" };
        } catch (error) {
          deps.log.warn(`task "${taskId}": live result lookup failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      return { ...taskView(record, true), source: "ledger" };
    },
  };
}

export function meshTaskCancelTool(deps                  )                 {
  return {
    name: "mesh_task_cancel",
    description:
      "Ask the peer to stop a delegated task. The remote agent is cancelled through DSH's own cancellation, so it stops at a step boundary; a peer that cannot cancel reports `uncancellable` with the reason instead of pretending the task stopped.",
    parameters: {
      type: "object",
      properties: { taskId: { type: "string", description: "Task id to cancel." } },
      required: ["taskId"],
      additionalProperties: false,
    },
    output: {
      schema: { type: "object" },
      render: (_args, value) => text(JSON.stringify(value, null, 2)),
    },
    async execute(args, exec) {
      const taskId = String(args["taskId"] ?? "");
      const record = requireRecord(deps, taskId);
      deps.ledger.requestCancel(taskId);
      if (record.direction === "out" && record.peer !== "") {
        return call                         (deps, record.peer, "mesh.task.cancel", { taskId }, { signal: exec.signal, timeoutMs: 20_000 });
      }
      return {
        accepted: true,
        state: record.state,
        note: "this task runs on this device; stop it through the local agent controls",
      };
    },
  };
}

export function meshTaskLogsTool(deps                  )                 {
  return {
    name: "mesh_task_logs",
    description:
      "Read a delegated task's recorded progress in order: state transitions, tool calls and the remote agent's own message fragments. The local ledger keeps the last 200 entries. This is the audit trail for what the remote device actually did.",
    parameters: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "Task id." },
        limit: { type: "number", description: "Maximum trailing lines to return (default 50, max 200)." },
      },
      required: ["taskId"],
      additionalProperties: false,
    },
    output: {
      schema: { type: "object" },
      render: (_args, value) => text(renderTaskLogs(value                           )),
    },
    async execute(args) {
      const record = requireRecord(deps, String(args["taskId"] ?? ""));
      const limit = Math.min(200, Math.max(1, numberArg(args, "limit") ?? 50));
      return {
        taskId: record.taskId,
        state: record.state,
        peer: record.peer,
        depth: record.depth,
        toolCalls: record.toolCalls,
        lines: record.progress.slice(-limit),
      };
    },
  };
}

export function meshTaskListTool(deps                  )                 {
  return {
    name: "mesh_task_list",
    description:
      "List delegated tasks this device knows about, in both directions: tasks it handed to peers and tasks peers handed to it, with state, depth, progress count and whether a result exists.",
    parameters: {
      type: "object",
      properties: {
        direction: { type: "string", enum: ["out", "in"], description: "Only tasks going out to peers, or coming in from peers." },
        limit: { type: "number", description: "Maximum rows (default 50)." },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: "object" },
      render: (_args, value) => text(renderTaskList(value                           )),
    },
    async execute(args) {
      const direction = args["direction"] === "in" ? "in" : args["direction"] === "out" ? "out" : undefined;
      const limit = Math.min(500, Math.max(1, numberArg(args, "limit") ?? 50));
      const rows = deps.ledger.list({ direction, limit }).map((record) => taskView(record));
      return { tasks: rows, total: rows.length };
    },
  };
}

// ---- pairing and connection ----------------------------------------------

export function meshPairTool(deps                  )                 {
  return {
    name: "mesh_pair",
    description:
      "Pair this device with a peer. `action: create` mints a pairing string for a remote device id you already know (read it from that device's mesh_status); `accept` installs a pairing string produced by the other device; `list` shows existing pairings; `remove` forgets one. The pairing string contains the shared secret — show it only to the person who owns the other device.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["create", "accept", "list", "remove"], description: "Pairing operation." },
        device: { type: "string", description: "For create: the other device's id. For remove: its alias or device id." },
        pairingString: { type: "string", description: "For accept: the whole `<deviceId>|<code>|<secret>` line from the other device." },
        alias: { type: "string", description: "Local alias to give the peer, e.g. \"phone\"." },
      },
      required: ["action"],
      additionalProperties: false,
    },
    output: {
      schema: { type: "object" },
      render: (_args, value) => text(renderPairing(value                           )),
    },
    async execute(args) {
      const action = String(args["action"] ?? "");
      const manager = deps.manager;
      if (action === "list") return { deviceId: manager.deviceId, pairings: manager.listPairings(), peers: manager.snapshot().peers };
      if (action === "create") {
        const offer = manager.createPairingOffer(String(args["device"] ?? ""));
        return {
          remoteDeviceId: offer.remoteDeviceId,
          code: offer.code,
          pairingString: offer.pairingString,
          next: "Paste the pairingString into mesh_pair (action: accept) on the other device.",
        };
      }
      if (action === "accept") {
        const accepted = manager.acceptPairingString(
          String(args["pairingString"] ?? ""),
          typeof args["alias"] === "string" ? args["alias"] : undefined,
        );
        return {
          ...accepted,
          next: "Add a peers entry on this side with that alias and the other device's ws:// or wss:// url; mesh_connect starts it.",
        };
      }
      if (action === "remove") {
        const removed = manager.removePairing(String(args["device"] ?? ""));
        if (!removed) throw new Error(`UNKNOWN_PAIRING: no pairing found for "${String(args["device"] ?? "")}"`);
        return { removed: true, device: args["device"] };
      }
      throw new Error(`BAD_PARAMS: unknown action "${action}"`);
    },
  };
}

export function meshConnectTool(deps                  )                 {
  return {
    name: "mesh_connect",
    description:
      "Start connecting to a configured peer now instead of waiting for the automatic reconnect, or list current link states. Never invents an address: the url comes from the peers entry.",
    parameters: {
      type: "object",
      properties: { device: { type: "string", description: "Peer alias or device id; omit to connect every configured peer." } },
      additionalProperties: false,
    },
    output: {
      schema: { type: "object" },
      render: (_args, value) => text(renderPeerStates(value                           )),
    },
    async execute(args) {
      return { peers: deps.manager.connect(deviceArg(args)) };
    },
  };
}

export function meshDisconnectTool(deps                  )                 {
  return {
    name: "mesh_disconnect",
    description: "Drop the connection to a peer (or every peer). The pairing stays, so the peer can dial in again later.",
    parameters: {
      type: "object",
      properties: { device: { type: "string", description: "Peer alias or device id; omit to disconnect every peer." } },
      additionalProperties: false,
    },
    output: {
      schema: { type: "object" },
      render: (_args, value) => text(renderPeerStates(value                           )),
    },
    async execute(args) {
      return { peers: deps.manager.disconnect(deviceArg(args)) };
    },
  };
}

/** Every tool this plugin registers, in registration order. */
export function createTools(deps                  )                   {
  return [
    meshStatusTool(deps),
    meshCapabilitiesTool(deps),
    meshListTool(deps),
    meshReadTool(deps),
    meshWriteTool(deps),
    meshExecTool(deps),
    meshLogsTool(deps),
    meshTransferTool(deps),
    meshDelegateTool(deps),
    meshTaskStatusTool(deps),
    meshTaskResultTool(deps),
    meshTaskCancelTool(deps),
    meshTaskLogsTool(deps),
    meshTaskListTool(deps),
    meshPairTool(deps),
    meshConnectTool(deps),
    meshDisconnectTool(deps),
  ];
}

/** The tool names used for delegation-depth restriction on a child agent. */
export const DELEGATION_TOOL_NAMES = ["mesh_delegate", "mesh_task_cancel", "mesh_task_result", "mesh_task_status", "mesh_task_logs", "mesh_task_list"];

// ---- transfer helpers -----------------------------------------------------

async function pullFile(
  deps                  ,
  device                    ,
  remotePath        ,
  localPath        ,
  chunkBytes        ,
  signal             ,
)                                   {
  const first = await call                                                                (
    deps,
    device,
    "mesh.transfer.read",
    { path: remotePath, offset: 0, length: chunkBytes },
    { signal, timeoutMs: 90_000 },
  );
  const staged = `${localPath}.mesh-part`;
  fs.mkdirSync(require$path().dirname(localPath), { recursive: true });
  fs.writeFileSync(staged, Buffer.from(first.data, "base64"));
  let offset = first.bytes;
  while (offset < first.size) {
    signal.throwIfAborted();
    const next = await call                                 (
      deps,
      device,
      "mesh.transfer.read",
      { path: remotePath, offset, length: chunkBytes },
      { signal, timeoutMs: 90_000 },
    );
    if (next.bytes === 0) break;
    fs.appendFileSync(staged, Buffer.from(next.data, "base64"));
    offset += next.bytes;
  }
  const actual = sha256Hex(fs.readFileSync(staged));
  if (actual !== first.version) {
    fs.rmSync(staged, { force: true });
    throw new Error(
      `CHECKSUM_MISMATCH: "${remotePath}" changed while it was being copied (expected ${first.version}, staged ${actual}); retry so the copy is consistent`,
    );
  }
  fs.renameSync(staged, localPath);
  return { direction: "pull", remotePath, localPath, bytes: first.size, sha256: first.version, verified: true };
}

async function pushFile(
  deps                  ,
  device                    ,
  remotePath        ,
  localPath        ,
  chunkBytes        ,
  signal             ,
)                                   {
  const info = fs.statSync(localPath);
  if (!info.isFile()) throw new Error(`BAD_PARAMS: "${localPath}" is not a regular file`);
  const data = fs.readFileSync(localPath);
  const sha256 = sha256Hex(data);
  const transferId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  for (let offset = 0; offset < data.length; offset += chunkBytes) {
    signal.throwIfAborted();
    const slice = data.subarray(offset, Math.min(data.length, offset + chunkBytes));
    await call(
      deps,
      device,
      "mesh.transfer.write",
      { path: remotePath, transferId, chunk: slice.toString("base64"), offset },
      { signal, timeoutMs: 90_000 },
    );
  }
  const committed = await call                                                  (
    deps,
    device,
    "mesh.transfer.commit",
    { path: remotePath, transferId, sha256 },
    { signal, timeoutMs: 90_000 },
  );
  return {
    direction: "push",
    remotePath,
    localPath,
    bytes: data.length,
    sha256,
    remoteVersion: committed.version,
    verified: committed.version === sha256,
  };
}

/** `node:path` imported lazily so the module graph stays obvious about its Node deps. */
function require$path()                             {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return pathModule;
}

import pathModule from "node:path";

function requireRecord(deps                  , taskId        )             {
  const record = deps.ledger.get(taskId);
  if (record === undefined) throw new Error(`UNKNOWN_TASK: no task "${taskId}" in this device's ledger`);
  return record;
}

// ---- renderers ------------------------------------------------------------

function renderStatus(value                         )         {
  const device = value["device"]                                       ;
  const server = value["server"]                                       ;
  const peers = Array.isArray(value["peers"]) ? (value["peers"]                                  ) : [];
  const lines           = [];
  lines.push(
    `This device: ${String(device?.["name"] ?? "(unnamed)")} — \`${String(device?.["deviceId"] ?? "")}\` on ${String(device?.["platform"] ?? "")}/${String(device?.["arch"] ?? "")}, Node ${String(device?.["node"] ?? "")}`,
  );
  if (server?.["running"] === true) {
    lines.push(`Listener: ${server["secure"] === true ? "wss" : "ws"}://${String(server["host"] ?? "")}:${String(server["port"] ?? "")} (path ${String((value["path"]                      ) ?? "/dsh-mesh")})`);
  } else {
    lines.push(`Listener: not running (server.enabled is ${String(server?.["enabled"] ?? "false")})`);
  }
  if (peers.length === 0) {
    lines.push("", "Peers: none configured. Pair a device first, then add a `peers` entry with its alias and url.");
  } else {
    lines.push("", "Peers:");
    for (const peer of peers) {
      const error = peer["lastError"]                                       ;
      const rtt = peer["roundTripMs"];
      lines.push(
        `- ${String(peer["alias"] ?? "")} [${String(peer["state"] ?? "")}]${peer["deviceId"] === undefined ? "" : ` id ${String(peer["deviceId"])}`}${peer["url"] === undefined ? "" : ` url ${String(peer["url"])}`}${typeof rtt === "number" ? ` rtt ${rtt}ms` : ""}${error === undefined ? "" : ` — ${String(error["code"])}: ${String(error["message"])}`}`,
      );
    }
  }
  const paired = Array.isArray(value["paired"]) ? (value["paired"]                                  ) : [];
  if (paired.length > 0) {
    lines.push("", "Pairings:");
    for (const entry of paired) lines.push(`- ${String(entry["deviceId"] ?? "")} (code ${String(entry["code"] ?? "")})`);
  }
  const permissions = value["permissions"]                                       ;
  lines.push(
    "",
    `Grants to peers: roots ${(permissions?.["allowedRoots"]                        )?.join(", ") || "(none)"}, write ${permissions?.["allowWrite"] === true ? "yes" : "no"}, exec ${permissions?.["allowExec"] === true ? "yes" : "no"}, delegate ${permissions?.["allowDelegate"] === true ? "yes" : "no"}, max delegation depth ${String(permissions?.["maxDelegationDepth"] ?? "")}`,
  );
  return lines.join("\n");
}

function renderCapabilities(value                         )         {
  const permissions = value["permissions"]                                       ;
  const methods = Array.isArray(value["methods"]) ? (value["methods"]            ) : [];
  const lines = [
    `device ${String((value["device"]                                       )?.["name"] ?? "")} [${String((value["device"]                                       )?.["deviceId"] ?? "")}]`,
    `roots: ${(permissions?.["allowedRoots"]                        )?.join(", ") || "(none)"}`,
    `write: ${permissions?.["allowWrite"] === true ? "yes" : "no"} · exec: ${permissions?.["allowExec"] === true ? "yes" : "no"} · delegate: ${permissions?.["allowDelegate"] === true ? "yes" : "no"}`,
    `methods (${methods.length}): ${methods.join(", ")}`,
  ];
  const deny = permissions?.["execDenyPatterns"];
  if (Array.isArray(deny) && deny.length > 0) lines.push(`denied command fragments: ${deny.join(", ")}`);
  return lines.join("\n");
}

function renderListing(value                         )         {
  const entries = Array.isArray(value["entries"]) ? (value["entries"]                                  ) : [];
  const lines = [`${String(value["path"] ?? "")} — ${entries.length} entr${entries.length === 1 ? "y" : "ies"}${value["truncated"] === true ? " (truncated)" : ""}`];
  for (const entry of entries) {
    const kind = entry["kind"] === "directory" ? "d" : entry["kind"] === "symlink" ? "l" : entry["kind"] === "file" ? "-" : "?";
    lines.push(`${kind} ${String(entry["name"] ?? "")}  ${String(entry["size"] ?? "")}  ${new Date(Number(entry["modified"] ?? 0)).toISOString()}`);
  }
  return lines.join("\n");
}

function renderRead(value                         )         {
  if (value["binary"] === true) {
    return `${String(value["path"] ?? "")} is a binary file (${String(value["bytes"] ?? "")} bytes); mesh_read returns text only. Use mesh_transfer to copy it.`;
  }
  const start = Number(value["offset"] ?? 0);
  const count = Number(value["lineCount"] ?? 0);
  const header = `${String(value["path"] ?? "")} — lines ${start}..${start + count} of ${String(value["totalLines"] ?? "")}, sha256 ${String(value["version"] ?? "")}${value["truncated"] === true ? ", truncated" : ""}`;
  return `${header}\n\n${String(value["content"] ?? "")}`;
}

function renderWrite(value                         )         {
  return `${value["created"] === true ? "created" : "updated"} ${String(value["path"] ?? "")} — ${String(value["bytes"] ?? "")} bytes, new sha256 ${String(value["version"] ?? "")}`;
}

function renderExec(value                         )         {
  const lines = [
    `$ ${String(value["command"] ?? "")}   (cwd ${String(value["cwd"] ?? "")})`,
    `exit ${String(value["exitCode"] ?? "null")}${value["signal"] === null || value["signal"] === undefined ? "" : ` signal ${String(value["signal"])}`} in ${String(value["durationMs"] ?? "")}ms${value["truncated"] === true ? " (output truncated)" : ""}`,
  ];
  const stdout = String(value["stdout"] ?? "");
  const stderr = String(value["stderr"] ?? "");
  if (stdout !== "") lines.push("", stdout);
  if (stderr !== "") lines.push("", "stderr:", stderr);
  return lines.join("\n");
}

function renderLogs(value                         )         {
  const lines = Array.isArray(value["lines"]) ? (value["lines"]            ) : [];
  return [
    `${String(value["path"] ?? "")} — nextOffset ${String(value["nextOffset"] ?? value["offset"] ?? "")}${value["eof"] === true ? " (at end of file)" : ""}`,
    "",
    ...lines,
  ].join("\n");
}

function renderTransfer(value                         )         {
  return `${String(value["direction"] ?? "")} ${String(value["remotePath"] ?? "")} <-> ${String(value["localPath"] ?? "")} — ${String(value["bytes"] ?? "")} bytes, sha256 ${String(value["sha256"] ?? "")}${value["verified"] === true ? " (verified)" : " (NOT verified)"}`;
}

function renderTaskList(value                         )         {
  const tasks = Array.isArray(value["tasks"]) ? (value["tasks"]                                  ) : [];
  if (tasks.length === 0) return "No delegated tasks recorded on this device.";
  return tasks
    .map(
      (task) =>
        `- ${String(task["taskId"] ?? "")} [${String(task["state"] ?? "")}] ${String(task["direction"] ?? "")} ${String(task["peer"] ?? "")} — ${String(task["label"] ?? "")} (depth ${String(task["depth"] ?? "")}, ${String(task["toolCalls"] ?? 0)} tool calls)`,
    )
    .join("\n");
}

function renderTaskStatus(value                         )         {
  const lines = [
    `task ${String(value["taskId"] ?? "")} — ${String(value["state"] ?? "")} (${String(value["direction"] ?? "")} ${String(value["peer"] ?? "")}, depth ${String(value["depth"] ?? "")})`,
    `created ${new Date(Number(value["createdAt"] ?? 0)).toISOString()}${value["durationMs"] === undefined ? "" : `, ran ${String(value["durationMs"])}ms`}`,
    `progress lines ${String(value["progressLines"] ?? 0)}, tool calls ${String(value["toolCalls"] ?? 0)}`,
  ];
  const last = Array.isArray(value["lastProgress"]) ? (value["lastProgress"]            ) : [];
  if (last.length > 0) lines.push("", "recent progress:", ...last.map((line) => `  ${line}`));
  if (value["summary"] !== undefined) lines.push("", "summary:", String(value["summary"]));
  const error = value["error"]                                       ;
  if (error !== undefined) lines.push("", `failure: ${String(error["code"])}: ${String(error["message"])}`);
  const live = value["live"]                                       ;
  if (live !== undefined && live["state"] !== undefined) lines.push("", `peer reports: ${String(live["state"])}`);
  return lines.join("\n");
}

function renderTaskResult(value                         )         {
  const summary = value["summary"] === undefined ? "(no summary recorded yet)" : String(value["summary"]);
  const artifacts = Array.isArray(value["artifacts"]) ? (value["artifacts"]                                  ) : [];
  const lines = [summary];
  if (artifacts.length > 0) {
    lines.push("", "artifacts:");
    for (const artifact of artifacts) {
      const where = String(artifact["path"] ?? artifact["command"] ?? "");
      const detail = String(artifact["detail"] ?? "");
      lines.push(`- [${String(artifact["kind"] ?? "")}] ${where}${detail === "" ? "" : ` (${detail})`}`);
    }
  }
  if (value["sessionId"] !== undefined) lines.push("", `remote session: ${String(value["sessionId"])}`);
  if (value["source"] !== undefined) lines.push(`source: ${String(value["source"])}`);
  const error = value["error"]                                       ;
  if (error !== undefined) lines.push("", `failure: ${String(error["code"])}: ${String(error["message"])}`);
  return lines.join("\n");
}

function renderTaskLogs(value                         )         {
  const lines = Array.isArray(value["lines"]) ? (value["lines"]            ) : [];
  return [
    `task ${String(value["taskId"] ?? "")} — ${String(value["state"] ?? "")} (${String(value["toolCalls"] ?? 0)} tool calls, depth ${String(value["depth"] ?? "")})`,
    "",
    ...lines,
  ].join("\n");
}

function renderPairing(value                         )         {
  if (value["pairingString"] !== undefined) {
    const pairings = Array.isArray(value["pairings"]) ? (value["pairings"]                                  ) : [];
    void pairings;
    return [
      `pairing code ${String(value["code"] ?? "")} for ${String(value["remoteDeviceId"] ?? "")}`,
      "",
      "Give this line to the other device (mesh_pair action=accept):",
      String(value["pairingString"]),
      "",
      String(value["next"] ?? ""),
    ].join("\n");
  }
  if (Array.isArray(value["pairings"])) {
    const pairings = value["pairings"]                                  ;
    const peers = Array.isArray(value["peers"]) ? (value["peers"]                                  ) : [];
    const lines = [`pairings: ${pairings.length}`];
    for (const entry of pairings) lines.push(`- ${String(entry["deviceId"] ?? "")} (code ${String(entry["code"] ?? "")})`);
    lines.push("", `configured peers: ${peers.map((peer) => `${String(peer["alias"])} [${String(peer["state"])}]`).join(", ") || "(none)"}`);
    return lines.join("\n");
  }
  return JSON.stringify(value, null, 2);
}

function renderPeerStates(value                         )         {
  const peers = Array.isArray(value["peers"]) ? (value["peers"]                                  ) : [];
  if (peers.length === 0) return "No peers configured.";
  return peers
    .map(
      (peer) =>
        `- ${String(peer["alias"] ?? "")} [${String(peer["state"] ?? "")}]${peer["deviceId"] === undefined ? "" : ` id ${String(peer["deviceId"])}`}${peer["remoteName"] === undefined ? "" : ` (${String(peer["remoteName"])})`}${peer["url"] === undefined ? "" : ` url ${String(peer["url"])}`}`,
    )
    .join("\n");
}


//# sourceURL=src/tools/mesh-tools.ts