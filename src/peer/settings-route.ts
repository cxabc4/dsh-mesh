// Host half of the settings page: one HTTP route the browser half calls.
//
// The page needs live data (device id, listener, links, pairings) and a few actions
// (create a pairing, accept one, add a peer, connect). None of that is reachable from
// the browser directly, so this registers a single buffered route on the Host's
// connection service and answers the documented client request envelope.
//
// `ctx.connection` is read optionally. A composition without it (a CLI-only profile)
// must still get the listener and the tools, so the route is simply absent there and
// the page reports that instead of taking the plugin down.

import type { MeshContext } from "../tools/types.ts";
import type { MeshManager } from "./manager.ts";

/** The browser caller posts to `/api` with this endpoint name. */
export const SETTINGS_METHOD = "dsh-mesh/settings";
export const SETTINGS_ROUTE = "/api/dsh-mesh/settings";

interface ConnectionFetchRoute {
  path: string;
  methods: readonly string[];
  requestBody: "buffered" | "streaming";
  fetch(request: Request): Promise<Response>;
}

interface ConnectionService {
  fetch?: { register(route: ConnectionFetchRoute): () => Promise<void> };
  rpc?: unknown;
}

/** The subset of the manager the page drives. */
export interface SettingsTargets {
  manager: MeshManager;
  /** Called after a change so the page can show the effect on the next read. */
  log(message: string): void;
}

type ActionRunner = (payload: Record<string, unknown>) => unknown;

/**
 * Answer one client request.
 *
 * `result` is the documented envelope: `{ ok: true, value }` or
 * `{ ok: false, error: { code, message, details } }`. `details` must be an object —
 * the browser side validates it — so every failure path supplies `{}`.
 */
function respond(rpcId: string, result: unknown): Response {
  return Response.json({ type: "server-response", rpcId, result });
}

function failure(code: string, message: string): unknown {
  return { ok: false, error: { code, message, details: {} } };
}

/** Trim a value to a string, or "" when it is not one. */
function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * A refusal the page should show verbatim, carrying the stable code the client checks.
 *
 * Plain `Error("CODE: message")` would lose the code: the route reads `.code` off the
 * thrown value, so a code buried in the message becomes `INTERNAL` and the page can no
 * longer explain what to fix.
 */
class SettingsError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "SettingsError";
    this.code = code;
  }
}

/** Build the actions the page can call. Each one either succeeds or returns a typed failure. */
function createActions(targets: SettingsTargets): Record<string, ActionRunner> {
  const { manager } = targets;
  return {
    read() {
      const snapshot = manager.snapshot();
      return {
        snapshot,
        // What the operator would paste into the other device, when a pairing exists.
        pairingStrings: snapshot.paired.map((entry) => ({
          deviceId: entry.deviceId,
          code: entry.code,
          createdAt: entry.createdAt,
          pairingString: manager.pairingStringFor(entry.deviceId) ?? undefined,
        })),
        // The method list the other side will see; useful to explain what a peer can do.
        capabilities: manager.capabilityDocument(),
      };
    },
    "pair/create"(payload) {
      const remote = text(payload["device"]);
      if (remote === "") throw new SettingsError("PAIR_REMOTE_REQUIRED", "enter the other device's id");
      const offer = manager.createPairingOffer(remote);
      targets.log(`pairing created for ${remote}`);
      return offer;
    },
    "pair/accept"(payload) {
      const line = text(payload["pairingString"]);
      if (line === "") throw new SettingsError("PAIR_STRING_REQUIRED", "paste the whole line from the other device");
      const alias = text(payload["alias"]) || undefined;
      const accepted = manager.acceptPairingString(line, alias);
      targets.log(`pairing accepted for ${accepted.peerId}`);
      return accepted;
    },
    "pair/remove"(payload) {
      const deviceId = text(payload["deviceId"]);
      if (deviceId === "") throw new SettingsError("PAIR_DEVICE_REQUIRED", "the pairing entry has no device id");
      return { removed: manager.removePairing(deviceId) };
    },
    "peer/add"(payload) {
      const alias = text(payload["alias"]);
      const url = text(payload["url"]);
      if (alias === "") throw new SettingsError("PEER_ALIAS_REQUIRED", "give this device a short name");
      if (url === "") throw new SettingsError("PEER_URL_REQUIRED", "enter the ws:// or wss:// address");
      const status = manager.addPeer(alias, url, payload["autoConnect"] !== false);
      targets.log(`peer ${alias} added`);
      return status;
    },
    connect(payload) {
      const device = text(payload["device"]) || undefined;
      return manager.connect(device);
    },
    disconnect(payload) {
      const device = text(payload["device"]) || undefined;
      return manager.disconnect(device);
    },
    async probe(payload) {
      const url = text(payload["url"]);
      if (url === "") throw new SettingsError("PROBE_URL_REQUIRED", "enter an address to probe");
      return manager.probeFingerprint(url);
    },
  };
}

/**
 * Register the settings route on `ctx.connection.fetch`.
 *
 * @returns a disposer, or undefined when this composition has no connection service.
 */
export function registerSettingsRoute(ctx: MeshContext, targets: SettingsTargets): (() => void) | undefined {
  const connection = ctx.get("connection") as ConnectionService | undefined;
  const fetch = connection?.fetch;
  if (fetch === undefined || typeof fetch.register !== "function") return undefined;
  const actions = createActions(targets);
  const dispose = fetch.register({
    path: SETTINGS_ROUTE,
    methods: ["POST"],
    requestBody: "buffered",
    async fetch(request: Request): Promise<Response> {
      let envelope: unknown;
      try {
        envelope = await request.json();
      } catch {
        return respond("", failure("BAD_REQUEST", "the request body is not JSON"));
      }
      const body = typeof envelope === "object" && envelope !== null ? (envelope as Record<string, unknown>) : {};
      const rpcId = typeof body["rpcId"] === "string" ? body["rpcId"] : "";
      if (body["type"] !== "client-request" || body["method"] !== SETTINGS_METHOD || rpcId === "") {
        return respond(rpcId, failure("BAD_REQUEST", `expected a client-request for ${SETTINGS_METHOD}`));
      }
      const payload = typeof body["payload"] === "object" && body["payload"] !== null ? (body["payload"] as Record<string, unknown>) : {};
      const action = typeof payload["action"] === "string" ? payload["action"] : "read";
      const run = actions[action];
      if (run === undefined) {
        return respond(rpcId, failure("UNKNOWN_ACTION", `"${action}" is not one of: ${Object.keys(actions).join(", ")}`));
      }
      try {
        const value = await run(payload);
        return respond(rpcId, { ok: true, value });
      } catch (error) {
        // RpcError carries a stable `code`; anything else becomes INTERNAL so the page
        // still shows a message instead of a blank failure.
        const candidate = error as { code?: unknown; message?: unknown };
        const code = typeof candidate?.code === "string" ? candidate.code : "INTERNAL";
        const message = typeof candidate?.message === "string" ? candidate.message : String(error);
        targets.log(`settings action ${action} failed: ${code}: ${message}`);
        return respond(rpcId, failure(code, message));
      }
    },
  });
  return () => {
    // The registered disposer returns a Promise; the plugin's teardown is synchronous.
    void dispose();
  };
}
