// Generated from src/peer\manager.ts by scripts/build.mjs. Do not edit.
// Mesh manager: owns the listener, every link, pairing, and the tool-facing surface.
//
// Teardown is the reason this class exists. One `dispose()` stops the listener, closes
// every link, aborts in-flight remote tasks, and clears timers — that is what makes
// "plugin unload releases all resources" true instead of aspirational.

import { MeshServer, MESH_PATH, dialPeer,                                           } from "../transport/server.js";
import { MeshLink, looksLikeDeviceId,                 } from "../transport/link.js";
import { RpcError,              } from "../rpc/peer.js";
import { performHandshake, refuseHandshake, HANDSHAKE_VERSION,                                      } from "../rpc/handshake.js";
import {
  codeOf,
  createPairing,
  describeIdentity,
  loadOrCreateIdentity,
  normalizeFingerprint,
  openPairingStore,
                      
                       
                    
} from "../security.js";
                                               
                                                  
import { platformFacts } from "./capabilities.js";
                                                              

export const PROTOCOL = "dsh-mesh.v1";

                                
                              
                              
                               
 

                                      
                     
                   
                  
                  
                        
                                                                                             
                           
 

                               
                         
               
                                                                                               
                        
                    
 

                               
                                                                                           
                                                                                                                                                      
                      
                                                                       
                                                              
                
                           
                        
                       
                           
                               
    
 

/** A connection a peer dialed into us, plus the link that adopted it. */
                        
                 
                 
                     
 

export class MeshManager {
           #deps                     ;
           #identity                ;
           #pairings              ;
           #links = new Map                  ();
           #accepted                 = [];
           #readyListeners = new Set                          ();
  #server                        ;
  #serverInfo                          ;
  #disposed = false;
  #onChange             = () => {};
  #linkCounter = 0;

  constructor(deps                     ) {
    this.#deps = deps;
    this.#identity = loadOrCreateIdentity(deps.stateDir, deps.config.device.name);
    this.#pairings = openPairingStore(deps.stateDir);
  }

  get identity()                 {
    return this.#identity;
  }

  get deviceId()         {
    return this.#identity.deviceId;
  }

  onChange(listener            )       {
    this.#onChange = listener;
  }

  /**
   * Run `listener` once for every link that comes online, including links that were
   * already online when the listener was installed.
   *
   * Handlers live on each link's own RPC peer, so registering them is a per-link concern.
   * The manager keeps this hook so the plugin entry can install the handler table without
   * knowing when handshakes happen.
   */
  onLinkReady(listener                          )             {
    this.#readyListeners.add(listener);
    for (const link of this.#links.values()) {
      if (link.online) {
        try {
          listener(link);
        } catch {
          /* the caller's failure must not take the link down */
        }
      }
    }
    return () => {
      this.#readyListeners.delete(listener);
    };
  }

  #notifyReady(link          )       {
    for (const listener of this.#readyListeners) {
      try {
        listener(link);
      } catch {
        /* ignore */
      }
    }
  }

  /** Start the listener and dial every auto-connect peer. */
  async start()                {
    if (this.#disposed) throw new Error("the mesh manager is disposed");
    const config = this.#deps.config;
    if (config.server.enabled) {
      const server = new MeshServer(
        config.server.tls,
        (connection, handshake) => this.#acceptInbound(connection, handshake),
        (error) => this.#deps.logger.warn(`mesh listener socket error: ${error.message}`),
      );
      this.#serverInfo = await server.start(config.server.host, config.server.port);
      this.#server = server;
      this.#deps.logger.info(
        `mesh listener ready at ${this.#serverInfo.url} as ${this.#identity.deviceId}`,
      );
    }
    for (const peer of config.peers) {
      const link = this.#linkFor(peer.alias, peer.url);
      if (peer.autoConnect) link.start();
    }
  }

  async dispose()                {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const link of this.#links.values()) link.dispose();
    this.#links.clear();
    for (const connection of this.#accepted) {
      try {
        connection.destroy();
      } catch {
        /* already gone */
      }
    }
    this.#accepted.length = 0;
    const server = this.#server;
    this.#server = undefined;
    this.#serverInfo = undefined;
    if (server !== undefined) await server.stop();
  }

  snapshot()               {
    const peers = [...this.#links.values()].map((link) => link.status());
    const online = peers.filter((peer) => peer.state === "online").length;
    const failed = peers.filter((peer) => peer.state === "failed").length;
    const config = this.#deps.config;
    const server = this.#deps.config.server;
    return {
      device: {
        deviceId: this.#identity.deviceId,
        name: this.#identity.name,
        platform: process.platform,
        arch: process.arch,
        node: process.version,
      },
      server: {
        enabled: server.enabled,
        running: this.#serverInfo !== undefined,
        host: this.#serverInfo?.host ?? server.host,
        port: this.#serverInfo?.port ?? server.port,
        secure: this.#serverInfo?.secure === true,
        url: this.#serverInfo?.url,
        startedAt: this.#serverInfo?.startedAt,
      },
      peers,
      paired: this.#pairings.list(),
      counts: { online, offline: peers.length - online - failed, failed },
      permissions: {
        allowedRoots: config.permissions.allowedRoots,
        allowWrite: config.permissions.allowWrite,
        allowExec: config.permissions.allowExec,
        allowDelegate: config.permissions.allowDelegate,
        maxDelegationDepth: config.maxDelegationDepth,
      },
    };
  }

  /** The capability document a peer receives from `mesh.capabilities`. */
  capabilityDocument()                          {
    const config = this.#deps.config;
    return {
      device: {
        deviceId: this.#identity.deviceId,
        name: this.#identity.name,
        publicKeyPem: describeIdentity(this.#identity).publicKeyPem,
      },
      platform: platformFacts(),
      protocol: PROTOCOL,
      handshake: HANDSHAKE_VERSION,
      methods: this.#deps.capabilities(),
      permissions: {
        allowedRoots: config.permissions.allowedRoots,
        allowWrite: config.permissions.allowWrite,
        allowExec: config.permissions.allowExec,
        allowDelegate: config.permissions.allowDelegate,
        execAllowCommands: config.permissions.exec.allowCommands,
        execDenyPatterns: config.permissions.exec.denyPatterns,
        maxConcurrentTasks: config.permissions.maxConcurrentTasks,
        maxTaskMs: config.permissions.maxTaskMs,
      },
      server: { listening: this.#serverInfo !== undefined, secure: this.#serverInfo?.secure === true },
      at: Date.now(),
    };
  }

  /** Resolve a peer by alias or device id. */
  resolvePeer(device                    )           {
    if (this.#links.size === 0) {
      throw new RpcError("NO_PEERS", "no peers are configured on this device; add one with peers[].alias and peers[].url");
    }
    if (device === undefined || device.trim() === "") {
      const online = [...this.#links.values()].filter((link) => link.online);
      if (online.length === 1) return online[0];
      if (online.length === 0) {
        const known = [...this.#links.values()].map((link) => `${link.alias} (${link.status().state})`).join(", ");
        throw new RpcError("NO_ONLINE_PEER", `no peer is connected right now; known peers: ${known}`);
      }
      throw new RpcError(
        "AMBIGUOUS_PEER",
        `several peers are connected (${online.map((link) => link.alias).join(", ")}); name one explicitly`,
      );
    }
    const needle = device.trim().toLowerCase();
    const match = [...this.#links.values()].find(
      (link) => link.alias.toLowerCase() === needle || (link.deviceId ?? "").toLowerCase() === needle,
    );
    if (match === undefined) {
      throw new RpcError(
        "UNKNOWN_PEER",
        `no peer named "${device}"; known peers: ${[...this.#links.values()].map((link) => link.alias).join(", ") || "(none)"}`,
      );
    }
    return match;
  }

  /** Issue one RPC against a named peer. */
  async request   (
    device                    ,
    method        ,
    params         ,
    options                                               = {},
  )             {
    const link = this.resolvePeer(device);
    return link.rpc.request   (method, params, options);
  }

  /** Resolve a peer's RPC facade (needed by callers that subscribe to streams). */
  rpcFor(device                    )                                   {
    const link = this.resolvePeer(device);
    if (!link.online) {
      throw new RpcError(
        "OFFLINE",
        `peer "${link.alias}" is ${link.status().state}${describeLinkError(link)}`,
      );
    }
    return { link, rpc: link.rpc };
  }

  /** Publish an event on the peer's stream (used by task-progress fan-out). */
  publish(device                    , stream        , event        , data         )       {
    const link = this.resolvePeer(device);
    if (!link.online) return;
    link.rpc.wire.send({ t: "evt", stream, event, data });
  }

  /** Create a pairing this device offers to a named remote device. */
  createPairingOffer(remoteDeviceId        )               {
    const normalized = remoteDeviceId.trim();
    if (normalized === "") {
      throw new RpcError(
        "REMOTE_ID_REQUIRED",
        "creating a pairing needs the other device's id; run mesh_status on that device and copy its deviceId",
      );
    }
    if (normalized === this.#identity.deviceId) {
      throw new RpcError("SELF_PAIRING", "a device cannot pair with itself");
    }
    const material = createPairing(this.#identity.deviceId, normalized);
    this.#pairings.set(normalized, material);
    this.#deps.audit.record({
      time: Date.now(),
      peer: normalized,
      action: "pairing/create",
      detail: `code ${material.code}`,
      outcome: "ok",
    });
    this.#linkFor(normalized);
    const link = this.#links.get(normalized);
    if (link !== undefined) link.alias = link.alias === normalized ? link.alias : link.alias;
    return {
      remoteDeviceId: normalized,
      code: material.code,
      pairingString: `${this.#identity.deviceId}|${material.code}|${material.secret.toString("base64")}`,
      createdAt: material.createdAt,
    };
  }

  /**
   * Accept a pairing string produced by the other device.
   *
   * Format: `<deviceId>|<code>|<base64 32-byte secret>`. The code is re-derived from
   * the secret and compared, so a truncated paste is refused instead of installing a
   * key that will never authenticate.
   */
  acceptPairingString(pairingString        , alias         )                                   {
    const parts = pairingString.trim().split("|");
    if (parts.length !== 3) {
      throw new RpcError(
        "BAD_PAIRING_STRING",
        "a pairing string looks like <deviceId>|<code>|<base64 secret>; copy the whole line from the other device",
      );
    }
    const [peerId, code, secretText] = parts.map((part) => part.trim());
    if (!looksLikeDeviceId(peerId)) {
      throw new RpcError("BAD_PAIRING_STRING", `"${peerId}" is not a dsh-mesh device id`);
    }
    if (peerId === this.#identity.deviceId) throw new RpcError("SELF_PAIRING", "a device cannot pair with itself");
    const secret = Buffer.from(secretText, "base64");
    if (secret.length !== 32) {
      throw new RpcError("BAD_PAIRING_STRING", `the pairing secret must decode to 32 bytes, got ${secret.length}`);
    }
    const expectedCode = codeOf(secret);
    if (code !== expectedCode) {
      throw new RpcError(
        "CODE_MISMATCH",
        `the pairing code "${code}" does not belong to this secret (expected "${expectedCode}"); re-copy the full line`,
      );
    }
    this.#pairings.set(peerId, {
      code,
      secret,
      createdAt: Date.now(),
      peers: [this.#identity.deviceId, peerId],
    });
    this.#deps.audit.record({
      time: Date.now(),
      peer: peerId,
      action: "pairing/accept",
      detail: `code ${code}`,
      outcome: "ok",
    });
    const link = this.#linkFor(alias === undefined ? peerId : alias, undefined);
    if (alias !== undefined) link.alias = alias;
    return { peerId, code };
  }

  removePairing(deviceId        )          {
    const removed = this.#pairings.remove(deviceId);
    for (const [alias, link] of [...this.#links]) {
      if (link.deviceId === deviceId) {
        link.dispose();
        this.#links.delete(alias);
      }
    }
    if (removed) {
      this.#deps.audit.record({
        time: Date.now(),
        peer: deviceId,
        action: "pairing/remove",
        detail: "pairing removed by the operator",
        outcome: "ok",
      });
    }
    return removed;
  }

  listPairings()                                                               {
    return this.#pairings.list();
  }

  /**
   * Rebuild the pairing string for an existing pairing.
   *
   * This exists so an operator can re-show a string they lost; it is deliberately not
   * part of `mesh_status` (which is read by an agent and may end up in a transcript).
   */
  pairingStringFor(deviceId        )                     {
    const material = this.#pairings.get(deviceId);
    if (material === undefined) return undefined;
    return `${this.#identity.deviceId}|${material.code}|${material.secret.toString("base64")}`;
  }

  /** Connect a configured peer now (mesh_connect tool). */
  connect(device                    )               {
    if (device === undefined || device.trim() === "") {
      for (const link of this.#links.values()) if (link.url !== undefined) link.start();
      return [...this.#links.values()].map((link) => link.status());
    }
    const link = this.resolvePeer(device);
    if (link.url === undefined) {
      throw new RpcError(
        "NO_URL",
        `peer "${link.alias}" has no configured url; set peers[].url for it, or wait for it to dial in`,
      );
    }
    link.start();
    return [link.status()];
  }

  /** Disconnect a peer without removing its pairing (mesh_disconnect tool). */
  disconnect(device                    )               {
    if (device === undefined || device.trim() === "") {
      for (const link of this.#links.values()) link.stop();
      return [...this.#links.values()].map((link) => link.status());
    }
    const link = this.resolvePeer(device);
    link.stop();
    return [link.status()];
  }

  #linkFor(alias        , url                    )           {
    const existing = [...this.#links.values()].find((link) => link.alias === alias);
    if (existing !== undefined) {
      if (url !== undefined) existing.url = url;
      return existing;
    }
    this.#linkCounter += 1;
    const link = new MeshLink(alias, url, {
      identity: this.#identity,
      config: this.#deps.config,
      version: this.#deps.version,
      capabilities: () => this.#deps.capabilities(),
      pairingFor: (deviceId) => this.#pairings.get(deviceId),
      onChange: () => {
        this.#onChange();
        if (link.online) this.#notifyReady(link);
      },
      log: this.#deps.logger,
      tag: this.#linkCounter,
    });
    this.#links.set(alias, link);
    return link;
  }

  /**
   * A peer reached our listener, completed the upgrade, and now must prove identity.
   *
   * The link is keyed by the verified device id (not by anything the peer claimed in
   * HTTP headers), so an unpaired dialer costs us one handshake and nothing else.
   */
  #acceptInbound(connection              , handshake                   )       {
    void handshake;
    this.#accepted.push(connection);
    void (async () => {
      const outcome = await performHandshake(connection, {
        identity: this.#identity,
        pairingFor: (deviceId) => this.#pairings.get(deviceId),
        expectedPeerId: undefined,
        capabilities: [...this.#deps.capabilities(), "mesh.ping"],
        version: `${this.#deps.version}/${HANDSHAKE_VERSION}`,
        timeoutMs: 15_000,
      }                         );
      if (!outcome.ok) {
        refuseHandshake(connection, outcome.code, outcome.message);
        this.#deps.audit.record({
          time: Date.now(),
          peer: "(unknown dialer)",
          action: "link/refused",
          detail: `${outcome.code}: ${outcome.message}`,
          outcome: "denied",
        });
        return;
      }
      const alias = this.#aliasForDevice(outcome.peerId, outcome.remote.name);
      const link = this.#linkFor(alias, undefined);
      link.adopt(connection, outcome);
      this.#deps.logger.info(`mesh peer dialed in: ${outcome.remote.name} (${outcome.peerId})`);
      this.#notifyReady(link);
      this.#onChange();
    })().catch((error         ) => {
      this.#deps.logger.warn(`mesh inbound handshake failed: ${error instanceof Error ? error.message : String(error)}`);
      connection.destroy();
    });
  }

  /**
   * Register a peer at runtime: alias plus the ws:// or wss:// address it is reachable at.
   *
   * This exists because a device's listener port is only known after it starts (port 0 asks
   * the OS), and because an operator may add a peer without restarting DSH. It never
   * invents an address — the url is required.
   */
  addPeer(alias        , url        , autoConnect = true)             {
    const trimmedAlias = alias.trim();
    const trimmedUrl = url.trim();
    if (trimmedAlias === "") throw new RpcError("BAD_PARAMS", "a peer needs a non-empty alias");
    if (!/^(wss?|https?):\/\//.test(trimmedUrl)) {
      throw new RpcError("BAD_PARAMS", `peer url must start with ws://, wss://, http:// or https://: ${trimmedUrl}`);
    }
    const link = this.#linkFor(trimmedAlias, trimmedUrl);
    this.#deps.config.peers.push({ alias: trimmedAlias, url: trimmedUrl, autoConnect });
    if (autoConnect) link.start();
    this.#onChange();
    return link.status();
  }

  /**
   * Choose the local alias for a peer we just verified.
   *
   * A configured `peers[].alias` wins, because that is the name the operator and the agent
   * already use. Only an unconfigured device falls back to its reported name, and the
   * device id is appended when two peers would otherwise share an alias.
   */
  #aliasForDevice(peerId        , remoteName        )         {
    for (const link of this.#links.values()) {
      if (link.deviceId === peerId) return link.alias;
    }
    for (const peer of this.#deps.config.peers) {
      // An outbound entry that never learned its device id yet still owns this device once
      // the handshake lands; match by url-independent identity when the link already knows.
      const link = this.#links.get(peer.alias);
      if (link !== undefined && link.deviceId === peerId) return peer.alias;
    }
    const base = remoteName.trim() === "" ? peerId : remoteName.trim();
    for (const link of this.#links.values()) {
      if (link.alias === base && link.deviceId !== peerId) return `${base}:${peerId.slice(0, 8)}`;
    }
    return base;
  }

  /** Diagnostics helper used by the CLI probe script. */
  probeFingerprint(url        )                                                                 {
    return dialPeer({
      url,
      fingerprintSha256: undefined,
      requirePinned: false,
      timeoutMs: 10_000,
    }).then((result) => {
      if (result.ok) {
        result.connection.destroy();
        return { ok: true, fingerprint: result.certificateFingerprint };
      }
      return { ok: false, error: result.error };
    });
  }
}

function describeLinkError(link          )         {
  const status = link.status();
  return status.lastError === undefined
    ? ""
    : ` (${status.lastError.code}: ${status.lastError.message})`;
}

export { MESH_PATH, normalizeFingerprint };


//# sourceURL=src/peer/manager.ts