// Requests, responses, streams, and cancellation over one mesh wire.
//
// Both directions are symmetric: the same `RpcPeer` serves handlers and issues requests
// on every link. That is what makes "the PC can call the phone through the connection
// the phone opened" a property of the protocol rather than a special case.

import { randomUUID } from "node:crypto";
import type { InnerFrame } from "./wire.ts";
import type { MeshWire } from "./wire.ts";

export class RpcError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "RpcError";
    this.code = code;
  }
}

export interface HandlerContext {
  /** The verified device id that issued this request. */
  from: string;
  signal: AbortSignal;
  /** Push progress to the caller's stream for this request. */
  emit(event: string, data: unknown, stream?: string): void;
}

export type RpcHandler = (params: unknown, context: HandlerContext) => Promise<unknown>;

export interface RequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

interface Pending {
  method: string;
  resolve(value: unknown): void;
  reject(error: RpcError): void;
  timer: NodeJS.Timeout;
  signal: AbortSignal | undefined;
  onAbort: () => void;
}

export class RpcPeer {
  readonly #wire: MeshWire;
  readonly #handlers = new Map<string, RpcHandler>();
  readonly #pending = new Map<string, Pending>();
  readonly #streams = new Map<string, Set<(event: string, data: unknown) => void>>();
  readonly #inflight = new Map<string, AbortController>();
  #defaultTimeoutMs: number;
  #disposed = false;

  constructor(wire: MeshWire, defaultTimeoutMs: number) {
    this.#wire = wire;
    this.#defaultTimeoutMs = defaultTimeoutMs;
    wire.onFrame((frame) => void this.#dispatch(frame));
    wire.onClose(() => this.#failAll("link closed"));
  }

  get wire(): MeshWire {
    return this.#wire;
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  setDefaultTimeout(ms: number): void {
    this.#defaultTimeoutMs = ms;
  }

  register(method: string, handler: RpcHandler): () => void {
    // Replacing is deliberate: a link outlives a plugin reload, and the same method table
    // is installed again on every handshake. Throwing on the second install would turn a
    // reconnect into a hard failure; last writer wins is the behaviour the callers expect.
    const previous = this.#handlers.get(method);
    this.#handlers.set(method, handler);
    return () => {
      if (previous !== undefined && this.#handlers.get(method) === handler) {
        this.#handlers.set(method, previous);
        return;
      }
      if (this.#handlers.get(method) === handler) this.#handlers.delete(method);
    };
  }

  unregister(method: string): void {
    this.#handlers.delete(method);
  }

  listMethods(): string[] {
    return [...this.#handlers.keys()].sort();
  }

  subscribe(stream: string, listener: (event: string, data: unknown) => void): () => void {
    let listeners = this.#streams.get(stream);
    if (listeners === undefined) {
      listeners = new Set();
      this.#streams.set(stream, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.#streams.delete(stream);
    };
  }

  request<T = unknown>(method: string, params: unknown, options: RequestOptions = {}): Promise<T> {
    if (this.#disposed) return Promise.reject(new RpcError("DISPOSED", "this link is disposed"));
    if (this.#wire.closed) return Promise.reject(new RpcError("OFFLINE", "the peer link is not connected"));
    const id = randomUUID();
    const timeoutMs = options.timeoutMs ?? this.#defaultTimeoutMs;
    const signal = options.signal;
    if (signal?.aborted === true) {
      return Promise.reject(new RpcError("CANCELLED", `request "${method}" was cancelled before it was sent`));
    }
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#settle(id);
        this.#wire.send({ t: "ctl", op: "cancel", id });
        reject(new RpcError("TIMEOUT", `request "${method}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
      const onAbort = () => {
        this.#settle(id);
        this.#wire.send({ t: "ctl", op: "cancel", id });
        reject(new RpcError("CANCELLED", `request "${method}" was cancelled`));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#pending.set(id, {
        method,
        resolve: (value) => resolve(value as T),
        reject,
        timer,
        signal,
        onAbort,
      });
      const sent = this.#wire.send({ t: "req", id, method, params });
      if (!sent) {
        this.#settle(id);
        reject(new RpcError("OFFLINE", "the peer link closed while the request was being sent"));
      }
    });
  }

  dispose(): void {
    this.#disposed = true;
    this.#failAll("rpc peer disposed");
    for (const controller of this.#inflight.values()) controller.abort(new RpcError("DISPOSED", "link disposed"));
    this.#inflight.clear();
  }

  #settle(id: string): void {
    const pending = this.#pending.get(id);
    if (pending === undefined) return;
    this.#pending.delete(id);
    clearTimeout(pending.timer);
    pending.signal?.removeEventListener("abort", pending.onAbort);
  }

  #failAll(reason: string): void {
    for (const [id, pending] of [...this.#pending]) {
      this.#settle(id);
      pending.reject(new RpcError("OFFLINE", `request "${pending.method}" failed: ${reason}`));
    }
  }

  async #dispatch(frame: InnerFrame): Promise<void> {
    switch (frame.t) {
      case "res": {
        const pending = this.#pending.get(frame.id);
        // A late answer (after a timeout or a cancel) is discarded: the caller already
        // moved on, and resolving it twice would be a bug.
        if (pending === undefined) return;
        this.#settle(frame.id);
        if (frame.ok) pending.resolve(frame.value);
        else pending.reject(new RpcError(frame.error.code, frame.error.message));
        return;
      }
      case "ctl": {
        const controller = this.#inflight.get(frame.id);
        controller?.abort(new RpcError("CANCELLED", "the caller cancelled this request"));
        return;
      }
      case "evt": {
        const listeners = this.#streams.get(frame.stream);
        if (listeners === undefined) return;
        for (const listener of listeners) {
          try {
            listener(frame.event, frame.data);
          } catch {
            /* a broken observer must not break the link */
          }
        }
        return;
      }
      case "req": {
        const controller = new AbortController();
        this.#inflight.set(frame.id, controller);
        const context: HandlerContext = {
          from: this.#wire.peerDeviceId,
          signal: controller.signal,
          emit: (event, data, stream) => {
            this.#wire.send({ t: "evt", stream: stream ?? frame.id, event, data });
          },
        };
        try {
          if (this.#disposed) throw new RpcError("DISPOSED", "this link is disposed");
          const handler = this.#handlers.get(frame.method);
          if (handler === undefined) {
            throw new RpcError("UNKNOWN_METHOD", `this device does not serve rpc method "${frame.method}"`);
          }
          const value = await handler(frame.params, context);
          this.#wire.send({ t: "res", id: frame.id, ok: true, value });
        } catch (error) {
          const code = error instanceof RpcError ? error.code : "INTERNAL";
          const message = error instanceof Error ? error.message : String(error);
          this.#wire.send({ t: "res", id: frame.id, ok: false, error: { code, message } });
        } finally {
          this.#inflight.delete(frame.id);
        }
        return;
      }
      default:
        return;
    }
  }
}
