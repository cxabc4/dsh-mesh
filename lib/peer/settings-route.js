// Generated from src/peer\settings-route.ts by scripts/build.mjs. Do not edit.
// Host half of the settings page: one HTTP route the browser half calls.
//
// The page needs live data (device id, listener, links, pairings) and a few actions
// (create a pairing, accept one, add a peer, connect). None of that is reachable from
// the browser directly, so this registers a single buffered route on the Host's
// connection service and answers the documented client request envelope.
//
// The connection service is an OPTIONAL dependency, and it must not be listed in the
// plugin's static `inject`: a CLI-only composition has no `connection`, and a hard
// dependency there would stop the plugin from applying at all — taking the listener and
// the mesh tools down with it. Instead this waits for the service through `ctx.inject`,
// which runs the callback when (and only when) the service becomes active, and falls
// back to a one-shot `ctx.get` for hosts that do not expose `inject`.
//
// That deferred form is not cosmetic: reading `ctx.get("connection")` during `apply` can
// legitimately return undefined, because the service is provided by a sibling Loader row
// that may activate after this one. An early read registers nothing, and the browser sees
// HTTP 404 on every call while everything else about the plugin looks healthy.

                                                     
                                                

/** The browser caller posts to `/api` with this endpoint name. */
export const SETTINGS_METHOD = "dsh-mesh/settings";
export const SETTINGS_ROUTE = "/api/dsh-mesh/settings";

                                
               
                             
                                        
                                             
 

                             
                                                                         
                
 

/** The subset of the manager the page drives. */
                                  
                       
                                                                                
                             
 

                                                                  

/**
 * Answer one client request.
 *
 * `result` is the documented envelope: `{ ok: true, value }` or
 * `{ ok: false, error: { code, message, details } }`. `details` must be an object —
 * the browser side validates it — so every failure path supplies `{}`.
 */
function respond(rpcId        , result         )           {
  return Response.json({ type: "server-response", rpcId, result });
}

function failure(code        , message        )          {
  return { ok: false, error: { code, message, details: {} } };
}

/** Trim a value to a string, or "" when it is not one. */
function text(value         )         {
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
           code        ;
  constructor(code        , message        ) {
    super(message);
    this.name = "SettingsError";
    this.code = code;
  }
}

/** Build the actions the page can call. Each one either succeeds or returns a typed failure. */
function createActions(targets                 )                               {
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

/** Build the fetch route body. Exported so the tests can drive it without a live service. */
export function createSettingsRoute(targets                 )                       {
  const actions = createActions(targets);
  return {
    path: SETTINGS_ROUTE,
    methods: ["POST"],
    requestBody: "buffered",
    async fetch(request         )                    {
      let envelope         ;
      try {
        envelope = await request.json();
      } catch {
        return respond("", failure("BAD_REQUEST", "the request body is not JSON"));
      }
      const body = typeof envelope === "object" && envelope !== null ? (envelope                           ) : {};
      const rpcId = typeof body["rpcId"] === "string" ? body["rpcId"] : "";
      if (body["type"] !== "client-request" || body["method"] !== SETTINGS_METHOD || rpcId === "") {
        return respond(rpcId, failure("BAD_REQUEST", `expected a client-request for ${SETTINGS_METHOD}`));
      }
      const payload = typeof body["payload"] === "object" && body["payload"] !== null ? (body["payload"]                           ) : {};
      const action = typeof payload["action"] === "string" ? payload["action"] : "read";
      const run = actions[action];
      if (run === undefined) {
        return respond(rpcId, failure("UNKNOWN_ACTION", `"${action}" is not one of: ${Object.keys(actions).join(", ")}`));
      }
      try {
        const value = await run(payload);
        return respond(rpcId, { ok: true, value });
      } catch (error) {
        // SettingsError and RpcError carry a stable `code`; anything else becomes INTERNAL
        // so the page still shows a message instead of a blank failure.
        const candidate = error                                         ;
        const code = typeof candidate?.code === "string" ? candidate.code : "INTERNAL";
        const message = typeof candidate?.message === "string" ? candidate.message : String(error);
        targets.log(`settings action ${action} failed: ${code}: ${message}`);
        return respond(rpcId, failure(code, message));
      }
    },
  };
}

/**
 * Register the settings route on `ctx.connection.fetch`.
 *
 * Prefers the deferred `ctx.inject` form so the route appears even when the connection
 * service activates after this plugin. Returns a disposer that also tears down whatever
 * the deferred registration produced.
 */
export function registerSettingsRoute(ctx             , targets                 )                           {
  const route = createSettingsRoute(targets);
  const disposers                    = [];
  const settle = (connection                               )          => {
    const fetch = connection?.fetch;
    if (fetch === undefined || typeof fetch.register !== "function") return false;
    try {
      const dispose = fetch.register(route);
      disposers.push(() => {
        // The registered disposer returns a Promise; plugin teardown is synchronous.
        void dispose();
      });
      return true;
    } catch (error) {
      targets.log(`could not register the settings route: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  };

  if (typeof ctx.inject === "function") {
    // Deferred: the callback runs now if the service is already active, or later when it
    // becomes active. Either way it is scoped to this plugin's fiber and torn down with it.
    ctx.inject(["connection"], (scope) => {
      const connection = scope.get("connection")                                 ;
      if (!settle(connection)) {
        targets.log(
          "connection is active but exposes no fetch registry; the settings page will report that it cannot read state",
        );
      }
      return () => {
        for (const dispose of disposers.splice(0).reverse()) {
          try {
            dispose();
          } catch {
            /* a failed teardown must not mask the first error */
          }
        }
      };
    });
    return () => {
      for (const dispose of disposers.splice(0).reverse()) {
        try {
          dispose();
        } catch {
          /* ignore */
        }
      }
    };
  }

  // Hosts without `ctx.inject`: one synchronous attempt, best effort.
  if (!settle(ctx.get("connection")                                 )) {
    targets.log("this host cannot defer a connection dependency; the settings page will report that it cannot read state");
  }
  return () => {
    for (const dispose of disposers.splice(0).reverse()) {
      try {
        dispose();
      } catch {
        /* ignore */
      }
    }
  };
}


//# sourceURL=src/peer/settings-route.ts