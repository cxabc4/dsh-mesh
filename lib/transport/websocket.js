// Generated from src/transport\websocket.ts by scripts/build.mjs. Do not edit.
// Minimal, dependency-free RFC 6455 WebSocket implementation.
//
// Why not `ws`: dsh-mesh installs into a DSH *profile*, whose node_modules only holds
// the bundles the profile declared. A plugin cannot import `ws` (or any @deepseek-ai
// package) unless the profile happens to hoist it, so the transport has to be built
// from Node built-ins. This is a deliberately small implementation: text frames out,
// text + ping/pong/close in, fragmentation reassembled, masks enforced per RFC.
//
// It speaks exactly what dsh-mesh needs (one JSON frame = one message) and nothing
// more: no permessage-deflate, no binary payloads, no extensions.

import { createHash, randomBytes } from "node:crypto";
                                       

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const OPCODE_CONTINUATION = 0x0;
const OPCODE_TEXT = 0x1;
const OPCODE_BINARY = 0x2;
const OPCODE_CLOSE = 0x8;
const OPCODE_PING = 0x9;
const OPCODE_PONG = 0xa;

                            
                                                                                           
                    
                                                                                          
                     
                                                                               
                           
 

                                    
                               
                      
                                  
 

                                                    

/** One WebSocket connection over an already-connected stream socket. */
export class WsConnection {
           socket        ;
  state          = "open";
  handshake                               ;

  #protocol                    ;
  #maxMessageBytes        ;
  #idleTimer                            ;
  #maxIdleMs        ;
  #pending           = [];
  #fragments           = [];
  #fragmentOpcode = 0;
  #messageHandlers                                = [];
  #closeHandlers                                                = [];
  #errorHandlers                                = [];
  #pongHandlers                    = [];
  #controlBuffer = Buffer.alloc(0);
  /**
   * Frames that arrived before anyone subscribed.
   *
   * This is not an optimisation: it is a correctness requirement. A peer's first frame
   * (its handshake hello) goes out the instant the upgrade completes, and on the dialing
   * side that frame can arrive in the same tick the socket is handed over — before the
   * caller has attached its listener. Dropping it would leave every outbound connection
   * stuck in "handshaking" until it timed out.
   */
  #inbox           = [];

  constructor(socket        , options            = {}) {
    this.socket = socket;
    this.#protocol = options.protocol;
    this.#maxIdleMs = options.maxIdleMs ?? 0;
    this.#maxMessageBytes = options.maxMessageBytes ?? 8 * 1024 * 1024;
    socket.setNoDelay(true);
    socket.on("data", (chunk        ) => this.#onData(chunk));
    socket.on("error", (error       ) => this.#emitError(error));
    socket.on("close", () => this.#onSocketClose(0, "socket closed"));
    socket.on("end", () => this.#onSocketClose(1006, "peer ended the stream"));
    if (this.#maxIdleMs > 0) this.#armIdle();
  }

  onMessage(handler                        )             {
    this.#messageHandlers.push(handler);
    // Hand over anything that arrived before this subscription existed, in order.
    if (this.#inbox.length > 0) {
      const pending = this.#inbox;
      this.#inbox = [];
      for (const text of pending) {
        try {
          handler(text);
        } catch {
          /* a throwing early listener must not break the connection */
        }
      }
    }
    return () => {
      const index = this.#messageHandlers.indexOf(handler);
      if (index >= 0) this.#messageHandlers.splice(index, 1);
    };
  }

  onClose(handler                                        )             {
    this.#closeHandlers.push(handler);
    return () => {
      const index = this.#closeHandlers.indexOf(handler);
      if (index >= 0) this.#closeHandlers.splice(index, 1);
    };
  }

  onError(handler                        )             {
    this.#errorHandlers.push(handler);
    return () => {
      const index = this.#errorHandlers.indexOf(handler);
      if (index >= 0) this.#errorHandlers.splice(index, 1);
    };
  }

  onPong(handler            )             {
    this.#pongHandlers.push(handler);
    return () => {
      const index = this.#pongHandlers.indexOf(handler);
      if (index >= 0) this.#pongHandlers.splice(index, 1);
    };
  }

  /** Send one text frame. Returns false when the connection is no longer writable. */
  send(text        )          {
    if (this.state !== "open" || this.socket.destroyed) return false;
    const payload = Buffer.from(text, "utf8");
    this.#writeFrame(OPCODE_TEXT, payload);
    return true;
  }

  ping()       {
    if (this.state !== "open") return;
    this.#writeFrame(OPCODE_PING, Buffer.alloc(0));
  }

  /** Close politely: send the close frame, then destroy after a short grace period. */
  close(code = 1000, reason = "")       {
    if (this.state !== "open") return;
    this.state = "closing";
    const reasonBuf = Buffer.from(reason, "utf8");
    const payload = Buffer.concat([Buffer.from([code >> 8, code & 0xff]), reasonBuf]);
    this.#writeFrame(OPCODE_CLOSE, payload);
    const socket = this.socket;
    setTimeout(() => {
      if (!socket.destroyed) socket.destroy();
    }, 250).unref?.();
  }

  /** Tear down immediately (used on teardown paths where politeness would block). */
  destroy()       {
    this.state = "closed";
    this.#disarmIdle();
    if (!this.socket.destroyed) this.socket.destroy();
  }

  #armIdle()       {
    this.#disarmIdle();
    this.#idleTimer = setTimeout(() => {
      this.#emitError(new Error("websocket idle timeout"));
      this.destroy();
    }, this.#maxIdleMs);
    this.#idleTimer.unref?.();
  }

  #disarmIdle()       {
    if (this.#idleTimer !== undefined) {
      clearTimeout(this.#idleTimer);
      this.#idleTimer = undefined;
    }
  }

  #touch()       {
    if (this.#maxIdleMs > 0) this.#armIdle();
  }

  #emitError(error       )       {
    for (const handler of this.#errorHandlers) {
      try {
        handler(error);
      } catch {
        /* a broken observer must not break the socket */
      }
    }
  }

  #onSocketClose(code        , reason        )       {
    this.#disarmIdle();
    if (this.state === "closed") return;
    this.state = "closed";
    for (const handler of this.#closeHandlers) {
      try {
        handler(code, reason);
      } catch {
        /* ignore */
      }
    }
  }

  #onData(chunk        )       {
    this.#touch();
    this.#pending.push(chunk);
    this.#drain();
  }

  #drain()       {
    while (this.state !== "closed") {
      if (this.#pending.length === 0) return;
      const joined = this.#pending.length === 1 ? this.#pending[0] : Buffer.concat(this.#pending);
      const consumed = this.#parseFrame(joined);
      if (consumed === 0) {
        this.#pending = [joined];
        return;
      }
      if (consumed >= joined.length) {
        this.#pending = [];
        return;
      }
      this.#pending = [joined.subarray(consumed)];
    }
  }

  /** Parse at most one frame from `buffer`; returns bytes consumed (0 = need more). */
  #parseFrame(buffer        )         {
    if (buffer.length < 2) return 0;
    const first = buffer[0];
    const fin = (first & 0x80) !== 0;
    const opcode = first & 0x0f;
    const second = buffer[1];
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (buffer.length < offset + 2) return 0;
      length = buffer.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      if (buffer.length < offset + 8) return 0;
      const high = buffer.readUInt32BE(offset);
      const low = buffer.readUInt32BE(offset + 4);
      length = high * 4294967296 + low;
      offset += 8;
    }
    if (length > this.#maxMessageBytes) {
      this.close(1009, "message too large");
      return buffer.length;
    }
    let maskKey                    ;
    if (masked) {
      if (buffer.length < offset + 4) return 0;
      maskKey = buffer.subarray(offset, offset + 4);
      offset += 4;
    }
    if (buffer.length < offset + length) return 0;
    let payload = buffer.subarray(offset, offset + length);
    if (maskKey !== undefined) payload = unmask(payload, maskKey);
    const consumed = offset + length;

    if (opcode === OPCODE_PING) {
      this.#writeFrame(OPCODE_PONG, payload);
      return consumed;
    }
    if (opcode === OPCODE_PONG) {
      for (const handler of this.#pongHandlers) {
        try {
          handler();
        } catch {
          /* ignore */
        }
      }
      return consumed;
    }
    if (opcode === OPCODE_CLOSE) {
      const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
      const reason = payload.length > 2 ? payload.subarray(2).toString("utf8") : "";
      this.close(code === 1005 ? 1000 : 1000, "");
      this.#onSocketClose(code, reason);
      return consumed;
    }
    if (opcode === OPCODE_BINARY) {
      // dsh-mesh only carries JSON text; a binary frame is a protocol violation.
      this.close(1003, "binary frames are not supported");
      return consumed;
    }
    if (opcode === OPCODE_TEXT || opcode === OPCODE_CONTINUATION) {
      if (opcode === OPCODE_TEXT) {
        this.#fragments = [payload];
        this.#fragmentOpcode = OPCODE_TEXT;
      } else {
        if (this.#fragmentOpcode !== OPCODE_TEXT) {
          this.close(1002, "unexpected continuation frame");
          return consumed;
        }
        this.#fragments.push(payload);
      }
      const total = this.#fragments.reduce((sum, part) => sum + part.length, 0);
      if (total > this.#maxMessageBytes) {
        this.close(1009, "message too large");
        return consumed;
      }
      if (fin) {
        const text = Buffer.concat(this.#fragments).toString("utf8");
        this.#fragments = [];
        this.#fragmentOpcode = 0;
        if (this.#messageHandlers.length === 0) {
          // Nobody is listening yet (the handshake listener is attached a tick later on
          // the dialing side). Buffer it instead of losing the peer's first frame.
          this.#inbox.push(text);
          return consumed;
        }
        for (const handler of this.#messageHandlers) {
          try {
            handler(text);
          } catch {
            /* ignore */
          }
        }
      }
      return consumed;
    }
    this.close(1002, `unsupported opcode ${opcode}`);
    return consumed;
  }

  #writeFrame(opcode        , payload        )       {
    const socket = this.socket;
    if (socket.destroyed) return;
    const first = 0x80 | opcode;
    const length = payload.length;
    // The extended-length bytes live *inside* the same header buffer as the two fixed
    // bytes, so they are written into that buffer, not into `header[1]` (which does not
    // exist until a second element is pushed).
    let head        ;
    if (length < 126) {
      head = Buffer.from([first, 0x80 | length]);
    } else if (length < 65536) {
      head = Buffer.from([first, 0x80 | 126, 0, 0]);
      head.writeUInt16BE(length, 2);
    } else {
      head = Buffer.from([first, 0x80 | 127, 0, 0, 0, 0, 0, 0, 0, 0]);
      head.writeUInt32BE(Math.floor(length / 4294967296), 2);
      head.writeUInt32BE(length % 4294967296, 6);
    }
    // Client-to-server frames must be masked; servers mask their frames too here for
    // symmetry with our own parser (a peer masking server frames is harmless, and
    // every dsh-mesh peer runs both roles at different times).
    const maskKey = randomBytes(4);
    const masked = Buffer.alloc(length);
    for (let index = 0; index < length; index += 1) {
      masked[index] = payload[index] ^ maskKey[index & 3];
    }
    socket.write(Buffer.concat([head, maskKey, masked]));
    this.#touch();
  }
}

function unmask(payload        , maskKey        )         {
  const out = Buffer.alloc(payload.length);
  for (let index = 0; index < payload.length; index += 1) {
    out[index] = payload[index] ^ maskKey[index & 3];
  }
  return out;
}

export function acceptKey(clientKey        )         {
  return createHash("sha1").update(clientKey + GUID).digest("base64");
}


//# sourceURL=src/transport/websocket.ts