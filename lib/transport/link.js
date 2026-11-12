// Generated from src/transport\link.ts by scripts/build.mjs. Do not edit.
// One live link to one remote device.
//
// The link owns the socket, the handshake, the encrypted wire, and the RPC peer, and it
// owns reconnection: a dialed link retries with backoff; an adopted (inbound) link does
// not, because the peer is expected to dial again — that is what a phone moving between
// Wi-Fi and mobile data does anyway.
//
// Terminology: `alias` is the operator's local name ("pc", "phone"); `deviceId` is the
// verified identity learned from the handshake. The wire is always addressed by ids.

import { RpcError, RpcPeer } from "../rpc/peer.js";
import { MeshWire } from "../rpc/wire.js";
import {
  HANDSHAKE_VERSION,
  performHandshake,
  refuseHandshake,
                      
                        
                  
} from "../rpc/handshake.js";
import { dialPeer } from "./server.js";
                                                   
                                                                                   
                                               

                                                                                       

                             
                
                               
                          
                   
                            
                    
                   
                                  
                                                                       
                                 
                               
                    
                                  
                  
 

                                  
                           
                     
                  
                           
                                                            
                   
                                                                    
                                                                                   
              
 

/** Failures that will not be fixed by retrying. */
const PERMANENT = new Set([
  "NOT_PAIRED",
  "PAIRING_MISMATCH",
  "BAD_PROOF",
  "IDENTITY_MISMATCH",
  "UNEXPECTED_PEER",
  "CERT_MISMATCH",
  "CERT_UNPINNED",
  "CERT_MISSING",
  "BAD_URL",
]);

export class MeshLink {
           #env                 ;
  #alias        ;
  #url                    ;
  #deviceId                    ;
  #state            = "offline";
  #since                    ;
  #outbound = false;
  #attempts = 0;
  #nextRetryAt                    ;
  #retryTimer                            ;
  #heartbeatTimer                            ;
  #roundTripMs                    ;
  #remoteName                    ;
  #remoteCapabilities           = [];
  #lastError                         ;
  #secure = false;
  #connection                          ;
  #wire                      ;
  #rpc                     ;
  #manualStop = false;
  #disposed = false;
  #dialing = false;

  constructor(alias        , url                    , env                 ) {
    this.#alias = alias;
    this.#url = url;
    this.#env = env;
  }

  get alias()         {
    return this.#alias;
  }

  set alias(value        ) {
    this.#alias = value;
  }

  get deviceId()                     {
    return this.#deviceId;
  }

  get url()                     {
    return this.#url;
  }

  set url(value                    ) {
    this.#url = value;
  }

  get online()          {
    return this.#state === "online" && this.#rpc !== undefined && !this.#rpc.disposed && !this.#wire?.closed;
  }

  get rpc()          {
    if (!this.online || this.#rpc === undefined) {
      throw new RpcError(
        "OFFLINE",
        `peer "${this.#alias}" is ${this.#state}${this.#lastError === undefined ? "" : ` (${this.#lastError.code}: ${this.#lastError.message})`}`,
      );
    }
    return this.#rpc;
  }

  status()             {
    return {
      alias: this.#alias,
      deviceId: this.#deviceId,
      url: this.#url,
      state: this.#state,
      since: this.#since,
      outbound: this.#outbound,
      attempts: this.#attempts,
      nextRetryAt: this.#nextRetryAt,
      lastError: this.#lastError,
      remoteName: this.#remoteName,
      remoteCapabilities: this.#remoteCapabilities,
      methods: this.#rpc?.listMethods() ?? [],
      roundTripMs: this.#roundTripMs,
      secure: this.#secure,
    };
  }

  /** Begin dialing; idempotent and harmless when already online. */
  start()       {
    if (this.#disposed) return;
    this.#manualStop = false;
    if (this.#url === undefined) {
      this.#env.log.warn(
        `peer "${this.#alias}" has no url configured, so it cannot be dialed; it can still dial in to this device`,
      );
      return;
    }
    void this.#dialOnce();
  }

  /** Stop retrying and drop the current connection. */
  stop()       {
    this.#manualStop = true;
    this.#clearRetry();
    this.#clearHeartbeat();
    this.#rpc?.dispose();
    this.#rpc = undefined;
    this.#wire?.close(1000, "disconnect requested");
    this.#wire = undefined;
    this.#connection = undefined;
    this.#setState("offline");
  }

  dispose()       {
    this.#disposed = true;
    this.stop();
  }

  /** Round-trip probe for mesh_status. */
  async probe(signal              )                  {
    const started = Date.now();
    await this.rpc.request("mesh.ping", {}, { signal, timeoutMs: 8_000 });
    const elapsed = Date.now() - started;
    this.#roundTripMs = elapsed;
    return elapsed;
  }

  /**
   * Take over a connection a peer dialed in to us. The handshake already ran in the
   * manager, so this installs the verified outcome.
   */
  adopt(connection              , outcome                                                           )       {
    this.#install(connection, outcome, false);
  }

  /** Begin an inbound handshake (used when the manager delegates it to the link). */
  async accept(connection              )                            {
    this.#connection = connection;
    this.#outbound = false;
    this.#setState("handshaking");
    const outcome = await performHandshake(connection, this.#handshakeInput(undefined));
    if (!outcome.ok) {
      refuseHandshake(connection, outcome.code, outcome.message);
      this.#connection = undefined;
      this.#fail(outcome.code, outcome.message);
      return outcome;
    }
    this.#install(connection, outcome, false);
    return outcome;
  }

  /** Publish one event onto a stream of this link's RPC peer. */
  publish(stream        , event        , data         )       {
    this.#wire?.send({ t: "evt", stream, event, data });
  }

  #handshakeInput(expectedPeerId                    )                 {
    return {
      identity: this.#env.identity,
      pairingFor: (deviceId) => this.#env.pairingFor(deviceId),
      expectedPeerId,
      capabilities: [...this.#env.capabilities(), "mesh.ping"],
      version: `${this.#env.version}/${HANDSHAKE_VERSION}`,
      timeoutMs: 15_000,
    };
  }

  #install(
    connection              ,
    outcome                                                           ,
    outbound         ,
  )       {
    this.#clearHeartbeat();
    this.#connection = connection;
    this.#deviceId = outcome.peerId;
    this.#remoteName = outcome.remote.name;
    this.#remoteCapabilities = Array.isArray(outcome.remote.capabilities) ? [...outcome.remote.capabilities] : [];
    this.#outbound = outbound;
    this.#attempts = 0;
    this.#nextRetryAt = undefined;
    this.#lastError = undefined;
    this.#secure = outcome.remote.version.includes("wss") ? true : this.#secure;
    const wire = new MeshWire(connection, outcome.keys, this.#env.identity.deviceId, outcome.peerId);
    const rpc = new RpcPeer(wire, this.#env.config.requestTimeoutMs);
    this.#wire = wire;
    this.#rpc = rpc;
    rpc.register("mesh.ping", async () => ({ pong: Date.now(), device: this.#env.identity.deviceId }));
    wire.onClose(() => {
      this.#clearHeartbeat();
      this.#rpc?.dispose();
      this.#rpc = undefined;
      this.#wire = undefined;
      this.#connection = undefined;
      if (this.#disposed) return;
      if (this.#manualStop) {
        this.#setState("offline");
        return;
      }
      this.#setState("offline", {
        lastError: { code: "LINK_LOST", message: "the peer connection dropped", at: Date.now() },
      });
      // Only the side that dialed retries; the accepting side waits for the peer.
      if (outbound) this.#scheduleRetry();
    });
    this.#setState("online");
    this.#startHeartbeat();
    this.#env.log.info(`mesh link "${this.#alias}" online with ${outcome.peerId}`);
  }

  async #dialOnce()                {
    if (this.#disposed || this.#manualStop || this.#dialing || this.online) return;
    const url = this.#url;
    if (url === undefined) return;
    this.#dialing = true;
    this.#attempts += 1;
    this.#setState("connecting");
    try {
      const secure = url.startsWith("wss://") || url.startsWith("https://");
      const result = await dialPeer({
        url,
        fingerprintSha256: this.#env.config.server.tls.fingerprintSha256,
        // A wss:// peer without a pinned fingerprint is refused: an unpinned server on a
        // public tunnel is exactly the interception this design has to rule out.
        requirePinned: secure,
        timeoutMs: Math.min(this.#env.config.requestTimeoutMs, 30_000),
      });
      if (!result.ok) {
        this.#dialing = false;
        this.#fail(result.code, result.error);
        return;
      }
      this.#secure = result.secure;
      this.#setState("handshaking");
      const expected = this.#deviceId ?? (looksLikeDeviceId(this.#alias) ? this.#alias : undefined);
      const outcome = await performHandshake(result.connection, this.#handshakeInput(expected));
      this.#dialing = false;
      if (!outcome.ok) {
        refuseHandshake(result.connection, outcome.code, outcome.message);
        this.#fail(outcome.code, outcome.message);
        return;
      }
      this.#install(result.connection, outcome, true);
    } catch (error) {
      this.#dialing = false;
      this.#fail(
        error instanceof RpcError ? error.code : "CONNECT_FAILED",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  #startHeartbeat()       {
    this.#clearHeartbeat();
    const interval = this.#env.config.heartbeatIntervalMs;
    this.#heartbeatTimer = setInterval(() => {
      const wire = this.#wire;
      const rpc = this.#rpc;
      if (wire === undefined || rpc === undefined) return;
      // A TCP-level ping keeps NAT mappings and the Frp tunnel warm; the RPC probe
      // additionally proves the *application* peer is responsive, not just the socket.
      wire.ping();
      const started = Date.now();
      rpc
        .request("mesh.ping", {}, { timeoutMs: Math.max(4_000, interval) })
        .then(() => {
          this.#roundTripMs = Date.now() - started;
        })
        .catch(() => {
          // A silent tunnel looks open at the TCP level. A missed application ping means
          // the link is dead, so drop it and let the reconnect path run.
          wire.destroy();
        });
    }, interval);
    this.#heartbeatTimer.unref?.();
  }

  #clearHeartbeat()       {
    if (this.#heartbeatTimer !== undefined) {
      clearInterval(this.#heartbeatTimer);
      this.#heartbeatTimer = undefined;
    }
  }

  #scheduleRetry()       {
    if (this.#disposed || this.#manualStop || this.#url === undefined) return;
    this.#clearRetry();
    const reconnect = this.#env.config.reconnect;
    const exponent = Math.max(0, this.#attempts - 1);
    const base = Math.min(reconnect.maxDelayMs, reconnect.minDelayMs * Math.pow(reconnect.factor, exponent));
    // Jitter stops two devices from retrying in lockstep after a shared tunnel outage.
    const delay = Math.round(base * (0.6 + Math.random() * 0.8));
    this.#nextRetryAt = Date.now() + delay;
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = undefined;
      this.#nextRetryAt = undefined;
      void this.#dialOnce();
    }, delay);
    this.#retryTimer.unref?.();
    this.#env.onChange();
  }

  #clearRetry()       {
    if (this.#retryTimer !== undefined) {
      clearTimeout(this.#retryTimer);
      this.#retryTimer = undefined;
    }
    this.#nextRetryAt = undefined;
  }

  #fail(code        , message        )       {
    this.#lastError = { code, message, at: Date.now() };
    if (PERMANENT.has(code)) {
      this.#setState("failed");
      this.#env.log.warn(`mesh peer "${this.#alias}" refused: ${code}: ${message}`);
      return;
    }
    this.#setState("offline");
    this.#scheduleRetry();
  }

  #setState(state           , extra                                          = {})       {
    this.#state = state;
    this.#since = Date.now();
    if (extra.lastError !== undefined) this.#lastError = extra.lastError;
    this.#env.onChange();
  }
}

/** Whether a string is literally a dsh-mesh device id (base32 groups). */
export function looksLikeDeviceId(value        )          {
  return /^[a-z2-7]{6}-[a-z2-7]{6}-[a-z2-7]{6}-[a-z2-7]{6}$/.test(value.trim());
}


//# sourceURL=src/transport/link.ts