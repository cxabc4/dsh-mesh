// Mesh manager: owns the listener, every link, pairing, and the tool-facing surface.
//
// Teardown is the reason this class exists. One `dispose()` stops the listener, closes
// every link, aborts in-flight remote tasks, and clears timers — that is what makes
// "plugin unload releases all resources" true instead of aspirational.

import { MeshServer, MESH_PATH, dialPeer, type IncomingHandshake, type ListenerInfo } from "../transport/server.ts";
import { MeshLink, looksLikeDeviceId, type LinkStatus } from "../transport/link.ts";
import { RpcError, type RpcPeer } from "../rpc/peer.ts";
import { performHandshake, refuseHandshake, HANDSHAKE_VERSION, type HandshakeInput, type HelloFrame } from "../rpc/handshake.ts";
import {
  codeOf,
  matchesCode,
  createPairing,
  describeIdentity,
  loadOrCreateIdentity,
  normalizeFingerprint,
  openPairingStore,
  type DeviceIdentity,
  type PairingMaterial,
  type PairingStore,
} from "../security.ts";
import type { MeshConfig } from "../config.ts";
import type { AuditLog } from "./capabilities.ts";
import { platformFacts } from "./capabilities.ts";
import type { WsConnection } from "../transport/websocket.ts";

export const PROTOCOL = "dsh-mesh.v1";

export interface ManagerLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface ManagerDependencies {
  config: MeshConfig;
  stateDir: string;
  audit: AuditLog;
  version: string;
  logger: ManagerLogger;
  /** Every RPC method this device serves (advertised in the hello and mesh_capabilities). */
  capabilities(): string[];
}

export interface PairingOffer {
  remoteDeviceId: string;
  code: string;
  /** The full string the other device must paste. Contains the secret, so it is shown once. */
  pairingString: string;
  createdAt: number;
}

/**
 * The structured pairing payload, in the shape the other device's agent reads.
 *
 * Every field is named for what it is rather than for where it sits in a wire format:
 * an agent that finds `kind: "dsh-mesh.pairing"` knows what it holds without extra prose,
 * and `acceptWith` names the exact tool call that installs it. The short `code` is the
 * string two people compare by eye; `secret` is the key material and is the only part that
 * must not be pasted into anything public.
 */
export interface PairingJson {
  kind: "dsh-mesh.pairing";
  version: 1;
  /** This device: the one that minted the pairing. */
  deviceId: string;
  name: string;
  /** The device this pairing is offered to. */
  peer: string;
  /** Short checksum over `secret`, for eyeball comparison. Not a key. */
  code: string;
  /** Base64 of the 32-byte shared secret. */
  secret: string;
  createdAt: number;
  /** The tool call the receiving agent makes. */
  acceptWith: string;
  /** The tool call that installs the peer route, once the pairing is accepted. */
  configureWith?: string;
  /**
   * The `peers` entry the receiving device needs, when the minting side knows its own
   * public address. Empty when it does not — a plugin listening on loopback cannot see the
   * tunnel in front of it, so the operator fills this in the settings page.
   */
  peerConfig?: { alias: string; url: string; autoConnect: boolean; certificatePolicy?: "system" };
  note: string;
}

/** A fresh offer carrying both encodings: the legacy line and the structured payload. */
export interface PairingJsonOffer extends PairingOffer {
  json: PairingJson;
}

export interface MeshSnapshot {
  device: { deviceId: string; name: string; platform: string; arch: string; node: string };
  server: { enabled: boolean; running: boolean; host: string; port: number; secure: boolean; url: string | undefined; publicUrl: string | undefined; startedAt: number | undefined };
  peers: LinkStatus[];
  paired: Array<{ deviceId: string; code: string; createdAt: number }>;
  counts: { online: number; offline: number; failed: number };
  permissions: {
    allowedRoots: string[];
    allowWrite: boolean;
    allowExec: boolean;
    allowDelegate: boolean;
    maxDelegationDepth: number;
  };
}

/** A connection a peer dialed into us, plus the link that adopted it. */
interface AcceptedLink {
  link: MeshLink;
  peerId: string;
  remote: HelloFrame;
}

export class MeshManager {
  readonly #deps: ManagerDependencies;
  readonly #identity: DeviceIdentity;
  readonly #pairings: PairingStore;
  readonly #links = new Map<string, MeshLink>();
  readonly #accepted: WsConnection[] = [];
  readonly #readyListeners = new Set<(link: MeshLink) => void>();
  #server: MeshServer | undefined;
  #serverInfo: ListenerInfo | undefined;
  #disposed = false;
  #onChange: () => void = () => {};
  #linkCounter = 0;

  constructor(deps: ManagerDependencies) {
    this.#deps = deps;
    this.#identity = loadOrCreateIdentity(deps.stateDir, deps.config.device.name);
    this.#pairings = openPairingStore(deps.stateDir);
  }

  get identity(): DeviceIdentity {
    return this.#identity;
  }

  get deviceId(): string {
    return this.#identity.deviceId;
  }

  onChange(listener: () => void): void {
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
  onLinkReady(listener: (link: MeshLink) => void): () => void {
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

  #notifyReady(link: MeshLink): void {
    for (const listener of this.#readyListeners) {
      try {
        listener(link);
      } catch {
        /* ignore */
      }
    }
  }

  /** Start the listener and dial every auto-connect peer. */
  async start(): Promise<void> {
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

  async dispose(): Promise<void> {
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

  snapshot(): MeshSnapshot {
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
        // What peers should dial, when the operator declared it. Distinct from `url`, which
        // is the loopback listener this process actually bound.
        publicUrl: config.server.publicUrl,
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
  capabilityDocument(): Record<string, unknown> {
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
  resolvePeer(device: string | undefined): MeshLink {
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
  async request<T>(
    device: string | undefined,
    method: string,
    params: unknown,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<T> {
    const link = this.resolvePeer(device);
    return link.rpc.request<T>(method, params, options);
  }

  /** Resolve a peer's RPC facade (needed by callers that subscribe to streams). */
  rpcFor(device: string | undefined): { link: MeshLink; rpc: RpcPeer } {
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
  publish(device: string | undefined, stream: string, event: string, data: unknown): void {
    const link = this.resolvePeer(device);
    if (!link.online) return;
    link.rpc.wire.send({ t: "evt", stream, event, data });
  }

  /** Create a pairing this device offers to a named remote device. */
  createPairingOffer(remoteDeviceId: string): PairingOffer {
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

  /** Removed: superseded by `acceptPairingPayload`, which accepts both formats. */

  removePairing(deviceId: string): boolean {
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

  listPairings(): Array<{ deviceId: string; code: string; createdAt: number }> {
    return this.#pairings.list();
  }

  /**
   * Rebuild the pairing material for an existing pairing.
   *
   * This exists so an operator can re-show a pairing they lost; it is deliberately not
   * part of `mesh_status` (which is read by an agent and may end up in a transcript).
   */
  pairingMaterialFor(deviceId: string): PairingMaterial | undefined {
    return this.#pairings.get(deviceId);
  }

  /**
   * The structured pairing offer: one JSON object the other device's agent can read.
   *
   * A pasted line is fine for a human copying between two chat windows, but on a device
   * with no settings UI the reader is an agent — and an agent does better with fields
   * than with a delimiter-separated string it has to split. The shape is deliberately
   * self-describing: `kind` says what it is, `acceptWith` says which tool call installs
   * it, `peer` says who is on the other end, and `code` is the short string two people
   * compare by eye.
   *
   * `secret` is the actual key material. It travels only through this one-time copy,
   * exactly like the line it replaces — the JSON wrapper changes the encoding, not the
   * exposure.
   */
  pairingOfferFor(deviceId: string): PairingJson | undefined {
    const material = this.#pairings.get(deviceId);
    if (material === undefined) return undefined;
    const config = this.#deps.config;
    // When the operator has declared a public address, the receiving device gets the
    // complete route as well as the secret, so one paste configures everything. Without it
    // the payload still pairs, and the route is filled in on the other side.
    const publicUrl = config.server.publicUrl;
    const peerConfig =
      publicUrl === undefined
        ? undefined
        : {
            alias: "pc",
            url: publicUrl.includes("/dsh-mesh") ? publicUrl : `${publicUrl.replace(/\/+$/, "")}${MESH_PATH}`,
            autoConnect: true,
            ...(config.server.tls.certificatePolicy === "system" ? { certificatePolicy: "system" as const } : {}),
          };
    return {
      kind: "dsh-mesh.pairing",
      version: 1,
      deviceId: this.#identity.deviceId,
      name: this.#identity.name,
      peer: deviceId,
      code: material.code,
      secret: material.secret.toString("base64"),
      createdAt: material.createdAt,
      acceptWith: `mesh_pair action="accept" pairingString="<this JSON as a single line>"`,
      ...(peerConfig === undefined ? {} : { configureWith: `mesh_configure config=<the peerConfig object above>` }),
      ...(peerConfig === undefined ? {} : { peerConfig }),
      note:
        "Give this JSON to the other device. One paste installs the pairing, and when peerConfig is present the route too.",
    };
  }

  /**
   * A fresh offer addressed to a remote device, including the JSON form.
   *
   * One call so every caller (tool, settings page) shows the same three things: the short
   * code for eyeball comparison, the pasteable JSON, and the legacy one-line string that
   * older builds of this plugin still accept.
   */
  createPairingJson(remoteDeviceId: string): PairingJsonOffer {
    const offer = this.createPairingOffer(remoteDeviceId);
    const json = this.pairingOfferFor(remoteDeviceId);
    if (json === undefined) {
      throw new RpcError("PAIRING_LOST", `the pairing for "${remoteDeviceId}" disappeared immediately after creation`);
    }
    return { ...offer, json };
  }

  /** Parse a pairing payload in either accepted form. */
  parsePairingPayload(text: string): {
    deviceId: string;
    code: string;
    secret: string;
    /** The route the minting device says it is reachable at, when it declared one. */
    peerConfig: { alias: string; url: string; autoConnect: boolean; certificatePolicy?: "system" } | undefined;
  } {
    const trimmed = text.trim();
    if (trimmed.startsWith("{")) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch (error) {
        throw new RpcError(
          "BAD_PAIRING_JSON",
          `the pasted JSON does not parse (${error instanceof Error ? error.message : String(error)}); copy the whole object`,
        );
      }
      const body = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
      if (body["kind"] !== "dsh-mesh.pairing") {
        throw new RpcError("BAD_PAIRING_JSON", `this JSON is not a dsh-mesh pairing (kind is "${String(body["kind"])}")`);
      }
      const deviceId = typeof body["deviceId"] === "string" ? body["deviceId"].trim() : "";
      const code = typeof body["code"] === "string" ? body["code"].trim() : "";
      const secret = typeof body["secret"] === "string" ? body["secret"].trim() : "";
      if (deviceId === "" || code === "" || secret === "") {
        throw new RpcError("BAD_PAIRING_JSON", "the pairing JSON is missing deviceId, code, or secret");
      }
      // `peer` names the device this pairing was minted FOR. Checking it catches the
      // ordinary mistake of pasting a payload addressed to someone else; it is advisory
      // rather than fatal for a hand-written payload, so an absent field is accepted.
      const peer = typeof body["peer"] === "string" ? body["peer"].trim() : "";
      if (peer !== "" && peer !== this.#identity.deviceId) {
        throw new RpcError(
          "PAIRING_ADDRESSED_ELSEWHERE",
          `this pairing is addressed to device "${peer}", but this device is "${this.#identity.deviceId}"`,
        );
      }
      const rawConfig = body["peerConfig"];
      const configBody = typeof rawConfig === "object" && rawConfig !== null ? (rawConfig as Record<string, unknown>) : {};
      const configUrl = typeof configBody["url"] === "string" ? configBody["url"].trim() : "";
      const peerConfig =
        configUrl === ""
          ? undefined
          : {
              alias: typeof configBody["alias"] === "string" && configBody["alias"].trim() !== "" ? configBody["alias"].trim() : "pc",
              url: configUrl,
              autoConnect: configBody["autoConnect"] !== false,
              ...(configBody["certificatePolicy"] === "system" ? { certificatePolicy: "system" as const } : {}),
            };
      return { deviceId, code, secret, peerConfig };
    }
    const parts = trimmed.split("|");
    if (parts.length !== 3) {
      throw new RpcError(
        "BAD_PAIRING_STRING",
        "a pairing is either the JSON object from the other device, or `<deviceId>|<code>|<base64 secret>`; copy the whole thing",
      );
    }
    const [deviceId, code, secret] = parts.map((part) => part.trim());
    // The line form carries no route, so the caller keeps whatever is configured already.
    return { deviceId, code, secret, peerConfig: undefined };
  }

  /**
   * Accept a pairing produced by the other device, in either the JSON or the line form.
   *
   * The code is re-derived from the secret and compared, so a truncated paste is refused
   * instead of installing a key that can never authenticate. That check is what makes the
   * short code useful: it is a checksum over the secret, not a substitute for it.
   */
  acceptPairingPayload(text: string, alias?: string): { peerId: string; code: string; peer?: LinkStatus } {
    const { deviceId: peerId, code, secret: secretText, peerConfig } = this.parsePairingPayload(text);
    if (!looksLikeDeviceId(peerId)) {
      throw new RpcError("BAD_PAIRING_STRING", `"${peerId}" is not a dsh-mesh device id`);
    }
    if (peerId === this.#identity.deviceId) throw new RpcError("SELF_PAIRING", "a device cannot pair with itself");
    const secret = Buffer.from(secretText, "base64");
    if (secret.length !== 32) {
      throw new RpcError("BAD_PAIRING_STRING", `the pairing secret must decode to 32 bytes, got ${secret.length}`);
    }
    // Accept both derivations: a pairing minted by an older build carries the longer code,
    // and comparing only against the short one would reject a correct paste.
    if (!matchesCode(code, secret)) {
      throw new RpcError(
        "CODE_MISMATCH",
        `the pairing code "${code}" does not belong to this secret (expected "${codeOf(secret)}"); re-copy the whole thing`,
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
    // A payload that carries the minting device's address configures the route too, so one
    // paste does both. That route entry becomes the link; adding a second inbound-only link
    // first would leave the peer listed twice.
    if (peerConfig !== undefined) {
      const configured = this.addPeer(peerConfig.alias, peerConfig.url, peerConfig.autoConnect);
      return { peerId, code, peer: configured };
    }
    // Without an address the link stays inbound-only: this side can be dialed, not dial.
    const link = this.#linkFor(alias === undefined ? peerId : alias, undefined);
    if (alias !== undefined) link.alias = alias;
    return { peerId, code };
  }

  /**
   * Install a peer route at runtime (mesh_configure tool).
   *
   * The settings page has its own route for this; the tool exists because a device whose
   * agent is the only operator (no settings UI) otherwise has to hand-edit a config file
   * and restart. This changes the running composition only — the durable copy is the
   * `peers` entry in the profile patch, which the caller is told to write.
   */
  configurePeer(input: { alias: string; url: string; autoConnect?: boolean }): LinkStatus {
    return this.addPeer(input.alias, input.url, input.autoConnect !== false);
  }

  /**
   * Accept a pairing line produced by an older build of this plugin.
   *
   * Kept because a device that has not been upgraded yet still emits the line form; the
   * JSON path above handles both, and this is the compatibility shim for call sites that
   * only know about strings.
   */
  acceptPairingString(pairingString: string, alias?: string): { peerId: string; code: string } {
    return this.acceptPairingPayload(pairingString, alias);
  }

  /**
   * Signal that something outside the link table changed.
   *
   * Used when the operator edits a value the snapshot reports (the advertised public
   * address), so the settings page re-reads it instead of showing a stale copy.
   */
  notifyChange(): void {
    this.#onChange();
  }

  /** Connect a configured peer now (mesh_connect tool). */
  connect(device: string | undefined): LinkStatus[] {
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
  disconnect(device: string | undefined): LinkStatus[] {
    if (device === undefined || device.trim() === "") {
      for (const link of this.#links.values()) link.stop();
      return [...this.#links.values()].map((link) => link.status());
    }
    const link = this.resolvePeer(device);
    link.stop();
    return [link.status()];
  }

  #linkFor(alias: string, url: string | undefined): MeshLink {
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
  #acceptInbound(connection: WsConnection, handshake: IncomingHandshake): void {
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
      } satisfies HandshakeInput);
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
    })().catch((error: unknown) => {
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
  addPeer(alias: string, url: string, autoConnect = true): LinkStatus {
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
  #aliasForDevice(peerId: string, remoteName: string): string {
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

  /** Diagnostics helper: read a peer's certificate fingerprint without keeping the link. */
  probeFingerprint(url: string): Promise<{ ok: boolean; fingerprint?: string; error?: string }> {
    return dialPeer({
      url,
      fingerprintSha256: undefined,
      // A diagnostic probe must reach the peer to report its fingerprint, so it always
      // asks the TLS layer for the certificate without a policy verdict.
      certificatePolicy: "system",
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

function describeLinkError(link: MeshLink): string {
  const status = link.status();
  return status.lastError === undefined
    ? ""
    : ` (${status.lastError.code}: ${status.lastError.message})`;
}

export { MESH_PATH, normalizeFingerprint };
