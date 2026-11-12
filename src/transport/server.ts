// The listener a device exposes, plus the client dialer for the other direction.
//
// Topology this is built for (and the only one v0.1 supports):
//
//   PC     : runs the listener on 127.0.0.1:8765; the operator's existing Sakura Frp
//            tunnel republishes that TCP port publicly. TLS, when enabled, terminates
//            here because the tunnel only forwards bytes.
//   Android: dials out to the public address. It never listens, needs no port
//            forwarding, no frpc, and no fixed IP.
//
// Because one WebSocket is full duplex, the PC can call the phone over the socket the
// phone opened. No second tunnel, no reverse listener on the phone.

import net from "node:net";
import tls from "node:tls";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { WsConnection, acceptKey } from "./websocket.ts";
import type { TlsConfig } from "../config.ts";

export const MESH_PATH = "/dsh-mesh";
const MAX_HEADER_BYTES = 16 * 1024;
const HANDSHAKE_GRACE_MS = 15_000;

export interface ListenerInfo {
  host: string;
  port: number;
  secure: boolean;
  startedAt: number;
  url: string;
}

export interface IncomingHandshake {
  requestPath: string;
  protocol: string | undefined;
  remoteAddress: string | undefined;
  secure: boolean;
}

export interface UpgradeDecision {
  accept: boolean;
  protocol?: string;
  reason?: string;
}

export type LinkAcceptor = (connection: WsConnection, handshake: IncomingHandshake) => void;

/** A mutually-authenticated-by-caller TCP/TLS listener with one WebSocket route. */
export class MeshServer {
  readonly #tls: TlsConfig;
  readonly #acceptor: LinkAcceptor;
  readonly #onSocketError: (error: Error) => void;
  #server: net.Server | undefined;
  #info: ListenerInfo | undefined;

  constructor(tlsConfig: TlsConfig, acceptor: LinkAcceptor, onSocketError: (error: Error) => void) {
    this.#tls = tlsConfig;
    this.#acceptor = acceptor;
    this.#onSocketError = onSocketError;
  }

  get info(): ListenerInfo | undefined {
    return this.#info;
  }

  /**
   * Start listening. When TLS is configured but its files are unusable the listener
   * refuses to start: silently downgrading a publicly-exposed port to plaintext is
   * exactly the failure this design cannot allow.
   */
  async start(host: string, port: number): Promise<ListenerInfo> {
    if (this.#server !== undefined) throw new Error("the mesh listener is already running");
    let server: net.Server;
    let secure = false;
    if (this.#tls.enabled) {
      const { certPath, keyPath } = this.#tls;
      if (certPath === undefined || keyPath === undefined) {
        throw new Error("server.tls.enabled requires server.tls.certPath and server.tls.keyPath");
      }
      if (!fs.existsSync(certPath)) throw new Error(`TLS certificate not found: ${certPath}`);
      if (!fs.existsSync(keyPath)) throw new Error(`TLS key not found: ${keyPath}`);
      const cert = fs.readFileSync(certPath);
      const key = fs.readFileSync(keyPath);
      server = tls.createServer({ cert, key, minVersion: "TLSv1.2" }, (socket) => this.#serveSocket(socket, true));
      secure = true;
    } else {
      server = net.createServer((socket) => this.#serveSocket(socket, false));
    }
    this.#server = server;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen({ host, port, exclusive: true });
    });
    server.on("error", (error) => this.#onSocketError(error));
    const address = server.address();
    const actualPort = typeof address === "object" && address !== null ? address.port : port;
    this.#info = {
      host,
      port: actualPort,
      secure,
      startedAt: Date.now(),
      url: `${secure ? "wss" : "ws"}://${host}:${actualPort}${MESH_PATH}`,
    };
    return this.#info;
  }

  async stop(): Promise<void> {
    const server = this.#server;
    this.#server = undefined;
    this.#info = undefined;
    if (server === undefined) return;
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };
      server.close(finish);
      // `close()` waits for open sockets; dsh-mesh closes its links itself on teardown,
      // but unload must not hang on a half-dead socket either.
      setTimeout(finish, 1500).unref?.();
    });
  }

  #serveSocket(socket: net.Socket | tls.TLSSocket, secure: boolean): void {
    socket.setNoDelay(true);
    const chunks: Buffer[] = [];
    // Two separate flags, and they mean different things:
    //   `settled`   — the header block has been consumed; stop parsing further bytes.
    //   `responded` — final response bytes have been queued on this socket.
    // Sharing one flag here was a real bug: the parse step set it before deciding whether
    // to accept, so every refusal (bad upgrade, unknown path) returned early without writing
    // anything and without closing — a public probe against the Frp-exposed port would
    // hang a connection forever.
    let settled = false;
    let responded = false;
    const refuse = (status: number, reason: string) => {
      if (responded) return;
      responded = true;
      settled = true;
      socket.off("data", onData);
      const body = `${status} ${reason}\ndsh-mesh listener\n`;
      try {
        // `end` flushes then sends FIN; `destroy` immediately after it would drop the
        // queued bytes on a slow peer, so the teardown is left to `end` plus the grace
        // timer below.
        socket.end(
          `HTTP/1.1 ${status} ${statusText(status)}\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
        );
      } catch {
        /* socket already gone */
      }
      setTimeout(() => socket.destroy(), 1_000).unref?.();
    };
    const onData = (chunk: Buffer) => {
      if (settled) return;
      chunks.push(chunk);
      const head = Buffer.concat(chunks);
      if (head.length > MAX_HEADER_BYTES) {
        refuse(413, "request headers too large");
        return;
      }
      let end = head.indexOf("\r\n\r\n");
      let consumed = 4;
      if (end < 0) {
        // A request may arrive with bare LF line endings; accept the first double LF as the
        // end of the header block then.
        end = head.indexOf("\n\n");
        consumed = 2;
        if (end < 0) return;
      }
      settled = true;
      socket.off("data", onData);
      const headerText = head.subarray(0, end).toString("utf8").replace(/\r\n/g, "\n");
      const rest = head.subarray(end + consumed);
      const lines = headerText.split("\n");
      const requestLine = lines.shift() ?? "";
      const parts = requestLine.split(" ");
      const requestPath = parts[1] ?? "/";
      const headers: Record<string, string> = {};
      for (const line of lines) {
        const index = line.indexOf(":");
        if (index <= 0) continue;
        headers[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim();
      }
      const upgrade = (headers["upgrade"] ?? "").toLowerCase();
      const clientKey = headers["sec-websocket-key"];
      if (upgrade !== "websocket" || clientKey === undefined) {
        refuse(400, "expected a websocket upgrade");
        return;
      }
      if (requestPath !== MESH_PATH && requestPath !== `${MESH_PATH}/`) {
        // One route only: a peer cannot probe for other endpoints on this port.
        refuse(404, "not found");
        return;
      }
      const protocol = headers["sec-websocket-protocol"];
      const responseHeaders = [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${acceptKey(clientKey)}`,
        `Sec-WebSocket-Protocol: ${protocol ?? "dsh-mesh.v1"}`,
      ];
      responded = true;
      socket.write(`${responseHeaders.join("\r\n")}\r\n\r\n`);
      const connection = new WsConnection(socket, { protocol: protocol ?? "dsh-mesh.v1", maxIdleMs: HANDSHAKE_GRACE_MS });
      if (rest.length > 0) socket.emit("data", rest);
      this.#acceptor(connection, {
        requestPath,
        protocol,
        remoteAddress: socket.remoteAddress ?? undefined,
        secure,
      });
    };
    socket.on("data", onData);
    socket.on("error", (error) => this.#onSocketError(error));
    // A socket that never finishes its header block must not hold a slot forever.
    setTimeout(() => {
      if (!settled) socket.destroy();
    }, HANDSHAKE_GRACE_MS).unref?.();
  }
}

function statusText(status: number): string {
  switch (status) {
    case 400:
      return "Bad Request";
    case 404:
      return "Not Found";
    case 413:
      return "Payload Too Large";
    default:
      return "Error";
  }
}

export interface DialOptions {
  url: string;
  /** Pinned SHA-256 of the server certificate, lowercase hex without separators. */
  fingerprintSha256: string | undefined;
  /** Refuse to talk to a wss:// peer whose certificate is not pinned. */
  requirePinned: boolean;
  timeoutMs: number;
}

export type DialResult =
  | { ok: true; connection: WsConnection; secure: boolean; certificateFingerprint: string | undefined }
  | { ok: false; code: string; error: string };

/**
 * Dial a peer and complete the WebSocket upgrade by hand.
 *
 * No WebSocket client library: the profile that hosts this plugin has none, and the
 * upgrade is a dozen lines of HTTP.
 */
export function dialPeer(options: DialOptions): Promise<DialResult> {
  return new Promise((resolve) => {
    let parsed: URL;
    try {
      parsed = new URL(options.url);
    } catch {
      resolve({ ok: false, code: "BAD_URL", error: `not a URL: ${options.url}` });
      return;
    }
    const scheme = parsed.protocol.replace(":", "").toLowerCase();
    if (scheme !== "ws" && scheme !== "wss") {
      resolve({ ok: false, code: "BAD_URL", error: `peer url must start with ws:// or wss://, got ${parsed.protocol}` });
      return;
    }
    const secure = scheme === "wss";
    const port = parsed.port === "" ? (secure ? 443 : 80) : Number(parsed.port);
    const host = parsed.hostname;
    const requestPath = parsed.pathname === "" || parsed.pathname === "/" ? MESH_PATH : parsed.pathname;
    let settled = false;
    const finish = (result: DialResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const socket = secure
      ? tls.connect({ host, port, servername: host, rejectUnauthorized: false })
      : net.connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      finish({ ok: false, code: "TIMEOUT", error: `timed out connecting to ${options.url} after ${options.timeoutMs}ms` });
    }, options.timeoutMs);
    timer.unref?.();

    const onSocketError = (error: Error) => finish({ ok: false, code: "CONNECT_FAILED", error: error.message });
    socket.once("error", onSocketError);

    const onConnected = () => {
      let certificateFingerprint: string | undefined;
      if (secure) {
        const peer = (socket as tls.TLSSocket).getPeerCertificate();
        certificateFingerprint = peer?.fingerprint256?.replace(/:/g, "").toLowerCase();
        if (options.fingerprintSha256 !== undefined) {
          if (certificateFingerprint === undefined) {
            socket.destroy();
            finish({ ok: false, code: "CERT_MISSING", error: "the peer presented no certificate" });
            return;
          }
          if (certificateFingerprint !== options.fingerprintSha256) {
            socket.destroy();
            finish({
              ok: false,
              code: "CERT_MISMATCH",
              error: `certificate fingerprint mismatch: expected ${options.fingerprintSha256}, got ${certificateFingerprint}`,
            });
            return;
          }
        } else if (options.requirePinned) {
          socket.destroy();
          finish({
            ok: false,
            code: "CERT_UNPINNED",
            error: "this peer is wss:// but server.tls.fingerprintSha256 is not configured, so its certificate cannot be verified",
          });
          return;
        }
      }
      const key = randomUUID().replace(/-/g, "").slice(0, 16);
      socket.write(
        [
          `GET ${requestPath} HTTP/1.1`,
          `Host: ${host}:${port}`,
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Key: ${Buffer.from(key, "utf8").toString("base64")}`,
          "Sec-WebSocket-Version: 13",
          "Sec-WebSocket-Protocol: dsh-mesh.v1",
          "",
          "",
        ].join("\r\n"),
      );
      const buffered: Buffer[] = [];
      const onData = (chunk: Buffer) => {
        buffered.push(chunk);
        const head = Buffer.concat(buffered);
        const end = head.indexOf("\r\n\r\n");
        if (end < 0) return;
        socket.off("data", onData);
        const headerText = head.subarray(0, end).toString("utf8");
        const rest = head.subarray(end + 4);
        const statusLine = headerText.split("\r\n")[0] ?? "";
        if (!/HTTP\/1\.1 101/.test(statusLine)) {
          socket.destroy();
          finish({ ok: false, code: "UPGRADE_REJECTED", error: `the peer refused the upgrade: ${statusLine}` });
          return;
        }
        const accept = headerText
          .split("\r\n")
          .find((line) => line.toLowerCase().startsWith("sec-websocket-accept:"));
        const expected = acceptKey(Buffer.from(key, "utf8").toString("base64"));
        if (accept === undefined || accept.split(":")[1]?.trim() !== expected) {
          socket.destroy();
          finish({ ok: false, code: "BAD_ACCEPT", error: "the peer returned an invalid Sec-WebSocket-Accept" });
          return;
        }
        socket.off("error", onSocketError);
        const connection = new WsConnection(socket, { protocol: "dsh-mesh.v1", maxIdleMs: 0 });
        if (rest.length > 0) socket.emit("data", rest);
        finish({ ok: true, connection, secure, certificateFingerprint });
      };
      socket.on("data", onData);
    };
    socket.once(secure ? "secureConnect" : "connect", onConnected);
  });
}

export { WsConnection, acceptKey };
