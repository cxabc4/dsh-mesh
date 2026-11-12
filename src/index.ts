// Plugin entry: mounts the mesh runtime into the DSH Host.
//
// Order matters and is mirrored on teardown:
//   1. normalise the Loader config;
//   2. create the state directory and the audit journal;
//   3. build the task ledger, the inbound task runner, and the mesh manager;
//   4. install the RPC handler table on every link (in and out), so both directions work;
//   5. start the manager (listener + peer dialing);
//   6. register the mesh_* tools;
//   7. register the `mesh` subagent provider, so a local agent can delegate to a peer;
//   8. add a short system-prompt section that explains which layer to use when.
//
// One `ctx.effect` owns everything, so plugin unload closes the listener, drops every
// link, cancels running remote tasks, and releases timers in reverse order.
//
// Imports are limited to Node built-ins and relative modules on purpose: a
// profile-installed bundle resolves only what the profile declared, so importing
// `@deepseek-ai/dsh-tools` or `ws` would fail at load time.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { MeshContext, ToolsService } from "./tools/types.ts";
import { resolveConfig, type MeshConfig } from "./config.ts";
import { AuditLog } from "./peer/capabilities.ts";
import { MeshManager, MESH_PATH } from "./peer/manager.ts";
import { createHandlers, MESH_METHODS } from "./peer/handlers.ts";
import { createTools, DELEGATION_TOOL_NAMES } from "./tools/mesh-tools.ts";
import { TaskLedger } from "./sessions/tasks.ts";
import { RemoteTaskRunner } from "./delegation/runner.ts";
import { MESH_PROVIDER_NAME, MeshSubagentProvider, composePrompt } from "./delegation/provider.ts";
import { sha256Hex } from "./security.ts";

export const name = "dsh-mesh";
/** A hard dependency: without `ctx.tools` this plugin has nothing to expose. */
export const inject = ["tools"];

const VERSION = "0.1.0";

/** Resolve the state directory: explicit config, else $DSH_HOME/dsh-mesh, else ~/.dsh/dsh-mesh. */
function resolveStateDir(config: MeshConfig): string {
  if (config.device.stateDir !== undefined) return config.device.stateDir;
  const home = process.env["DSH_HOME"];
  if (typeof home === "string" && home.length > 0) return path.join(home, "dsh-mesh");
  return path.join(os.homedir(), ".dsh", "dsh-mesh");
}

/** Default device name: the OS hostname, so a peer list reads naturally. */
function defaultDeviceName(): string {
  try {
    const host = os.hostname().slice(0, 40);
    return host.length > 0 ? host : "dsh-mesh";
  } catch {
    return "dsh-mesh";
  }
}

/**
 * Optional file trace for a deployment that fails to come up.
 *
 * A plugin that never activates is close to invisible: the Host logs one line and moves on.
 * Setting `MESH_DEBUG_FILE` makes `apply` append each step to a file, which turns "the
 * listener is not there" into "it stopped at step 4 for this reason". Off unless asked.
 */
function makeTracer(): (step: string, detail?: unknown) => void {
  const target = process.env["MESH_DEBUG_FILE"];
  if (typeof target !== "string" || target === "") return () => {};
  return (step, detail) => {
    try {
      const line = `${new Date().toISOString()} ${step}${detail === undefined ? "" : ` ${JSON.stringify(detail)}`}\n`;
      fs.appendFileSync(target, line, "utf8");
    } catch {
      /* tracing must never be the reason a plugin fails */
    }
  };
}

interface SubagentsActivationService {
  startActivation(spec: {
    provider: string;
    label: string;
    request: { prompt: Array<{ type: "text"; text: string }>; parent: unknown; signal: AbortSignal };
    signal: AbortSignal;
    delivery: "parent" | "caller";
  }): Promise<unknown>;
}

interface AgentsInitiatorService {
  currentInitiator?(): unknown;
}

export async function apply(ctx: MeshContext, rawConfig: unknown = {}): Promise<void> {
  const trace = makeTracer();
  trace("apply:enter");
  const config = resolveConfig(rawConfig);
  if (config.device.name === "") config.device.name = defaultDeviceName();
  const stateDir = resolveStateDir(config);
  fs.mkdirSync(stateDir, { recursive: true });
  trace("apply:config", { stateDir, serverEnabled: config.server.enabled, port: config.server.port, peers: config.peers.length });

  const logger = ctx.logger;
  const audit = new AuditLog(config.audit.maxEntries);
  const auditFile = path.join(stateDir, "audit.jsonl");
  audit.setSink((entry) => {
    try {
      fs.appendFileSync(auditFile, `${JSON.stringify(entry)}\n`, "utf8");
    } catch {
      /* auditing must never break the action it records */
    }
  });

  const ledger = new TaskLedger(stateDir);
  const runner = new RemoteTaskRunner({
    ledger,
    agents: () => {
      const agents = ctx.get("agents") as { create?: unknown } | undefined;
      return agents !== undefined && typeof agents.create === "function"
        ? (agents as unknown as Parameters<typeof runner.agents>[0])
        : undefined;
    },
    defaultAgentOptions: () => {
      const selection = ctx.get("agentDefaultModel") as
        | { currentSelection?: () => { provider?: string; model?: string; reasoningEffort?: string } }
        | undefined;
      try {
        return selection?.currentSelection?.() ?? {};
      } catch {
        return {};
      }
    },
    maxConcurrentTasks: config.permissions.maxConcurrentTasks,
    maxTaskMs: config.permissions.maxTaskMs,
    log: logger,
    delegationToolNames: DELEGATION_TOOL_NAMES,
  });

  const manager = new MeshManager({
    config,
    stateDir,
    audit,
    version: VERSION,
    logger,
    capabilities: () => [...MESH_METHODS],
  });

  const handlers = createHandlers({
    config,
    stateDir,
    audit,
    deviceId: () => manager.deviceId,
    capabilityDocument: () => manager.capabilityDocument(),
    taskRunner: () => runner,
  });

  // Handlers live on each link's own RPC peer, so they are installed per handshake. This
  // hook also covers links that were already online when it was registered.
  manager.onLinkReady((link) => {
    for (const [method, handler] of Object.entries(handlers)) {
      try {
        link.rpc.register(method, (params, context) =>
          handler(
            typeof params === "object" && params !== null ? (params as Record<string, unknown>) : {},
            context as Parameters<typeof handler>[1],
          ),
        );
      } catch (error) {
        logger.warn(
          `dsh-mesh: could not register "${method}" on link "${link.alias}": ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  });

  trace("apply:before-manager-start");
  await manager.start();
  trace("apply:manager-started", manager.snapshot().server);

  const disposers: Array<() => void> = [];
  const tools = ctx.get("tools") as ToolsService | undefined;
  if (tools !== undefined) {
    const definitions = createTools({
      manager,
      ledger,
      delegationAvailable: () => ctx.get("subagents") !== undefined,
      delegate: async (options) => delegateViaSubagents(ctx, options),
      log: logger,
    });
    for (const definition of definitions) {
      disposers.push(tools.register(definition));
    }
  }

  const subagents = ctx.get("subagents") as { registerProvider?(provider: unknown): () => void } | undefined;
  if (subagents !== undefined && typeof subagents.registerProvider === "function") {
    disposers.push(subagents.registerProvider(new MeshSubagentProvider({ manager, ledger, config, log: logger })));
  } else {
    logger.info(
      "dsh-mesh: ctx.subagents is not mounted in this composition; mesh_delegate will report DELEGATION_UNAVAILABLE and the file/exec tools still work",
    );
  }

  const prompt = ctx.get("systemPrompt") as
    | {
        section(section: { name: string; order: number; text: (context?: unknown) => string }): () => void;
        getSectionOrder?(name: string): number;
      }
    | undefined;
  if (prompt !== undefined) {
    // `order` is mandatory: dsh-system-prompt throws a TypeError for a non-finite order
    // rather than defaulting. Use the registry's own placement for the tool section when
    // one is declared, and fall back to a number that sorts after the built-in tool text.
    let order = 10_000;
    try {
      const declared = prompt.getSectionOrder?.("TOOL_SUBAGENT");
      if (typeof declared === "number" && Number.isFinite(declared)) order = declared + 1;
    } catch {
      /* keep the fallback order */
    }
    try {
      disposers.push(
        prompt.section({
          name: "tool:dsh-mesh",
          order,
          text: () =>
            "A device mesh is available through mesh_* tools. Start with mesh_status. Use the cheapest layer that fits: mesh_read / mesh_write / mesh_exec / mesh_list / mesh_logs / mesh_transfer for concrete files and commands on the other device; mesh_delegate when the task needs the other device's own agent to explore or decide for itself. Paths belong to the target device — always pass them in that device's own syntax and never translate one platform's path into another's. A delegated task runs exactly once; if a link drops, query the same task id with mesh_task_result instead of delegating again.",
        }),
      );
    } catch (error) {
      // A prompt section that cannot be registered must not cost the tools or the listener.
      logger.warn(
        `dsh-mesh: could not register the prompt section: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // Cordis `ctx.effect` runs its callback IMMEDIATELY and uses the *returned* function as
  // the disposer (see cordis `Fiber._execute`: a returned Promise is awaited and its
  // resolution collected). Passing the cleanup body directly as the callback therefore
  // runs the teardown during apply — the listener opens and closes in the same millisecond,
  // which looks exactly like "the plugin never started". The correct shapes are
  // `() => disposer` or a generator that yields disposers.
  ctx.effect(() => () => {
    trace("teardown:begin");
    for (const dispose of disposers.reverse()) {
      try {
        dispose();
      } catch (error) {
        logger.warn(`dsh-mesh: a registration disposer threw: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    // Returned synchronously: `runner.collect` takes a function, and Cordis drains an
    // effect that returns a Promise only to collect it, not to await arbitrary cleanup
    // work. Detached teardown of the network layer is awaited by the manager itself.
    void runner.dispose().then(() => manager.dispose()).then(() => trace("teardown:done"));
  });

  trace("apply:ready", { deviceId: manager.deviceId, tools: disposers.length });
  logger.info(
    `dsh-mesh ready: device ${manager.deviceId}, listener ${config.server.enabled ? `enabled on ${MESH_PATH}` : "disabled"}, ${config.peers.length} configured peer(s)`,
  );
}

/**
 * Delegate to a peer through the real DSH subagent machinery.
 *
 * The prompt carries a control header (target device, cwd, depth, idempotency key) that
 * only the mesh provider reads; everything else is the ordinary subagent flow, so DSH
 * owns the child's lifecycle, cancellation, and result delivery. `delivery: "caller"`
 * makes the result come back to the invoking turn rather than to the parent's inbox.
 */
async function delegateViaSubagents(
  ctx: MeshContext,
  options: { device: string; task: string; cwd: string | undefined; signal: AbortSignal },
): Promise<{ taskId: string }> {
  const subagents = ctx.get("subagents") as SubagentsActivationService | undefined;
  if (subagents === undefined || typeof subagents.startActivation !== "function") {
    throw new Error("DELEGATION_UNAVAILABLE: ctx.subagents is not mounted in this composition");
  }
  const agents = ctx.get("agents") as AgentsInitiatorService | undefined;
  const parent = agents?.currentInitiator?.();
  if (parent === undefined) {
    throw new Error(
      "NO_INITIATOR: mesh_delegate must be invoked from an agent turn so the delegation has a live parent agent",
    );
  }
  const prompt = composePrompt({
    device: options.device,
    task: options.task,
    cwd: options.cwd,
    depth: 0,
    requestKey: sha256Hex(`${options.device}\u0000${options.task}`).slice(0, 32),
    label: "mesh delegation",
  });
  const activation = await subagents.startActivation({
    provider: MESH_PROVIDER_NAME,
    label: "mesh delegation",
    request: { prompt: [{ type: "text", text: prompt }], parent, signal: options.signal },
    signal: options.signal,
    delivery: "caller",
  });
  const childId = (activation as { childId?: unknown }).childId;
  if (typeof childId !== "string") {
    throw new Error("the subagent service returned no child id for this mesh delegation");
  }
  return { taskId: childId };
}

/** Exported for tests and for the docs examples. */
export { resolveConfig, MESH_PROVIDER_NAME, MESH_METHODS, composePrompt };
