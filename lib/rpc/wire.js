// Generated from src/rpc\wire.ts by scripts/build.mjs. Do not edit.
// The encrypted frame layer that sits on top of a handshaken WebSocket.
//
// One frame = one JSON object:
//   { k: "env", from, to, seq, ts, mac, body }
//
// `body` is the AES-256-GCM seal of an inner frame; `mac` is HMAC-SHA256 over
// (from, to, seq, ts, body). Together they give:
//
//   * confidentiality — the Frp tunnel only sees ciphertext;
//   * authenticity      — a frame that was not produced by the paired device fails the
//                         MAC and the link is torn down immediately;
//   * anti-replay       — `seq` must strictly increase, and `ts` is bounded to a small
//                         clock window, so an old frame cannot be replayed by an
//                         observer on the tunnel.
//
// Refusal is always terminal: a single bad frame closes the link rather than being
// skipped, because "skip the bad frame and continue" is how a downgrade slips through.

import { openPayload, sealPayload, deriveEnvelopeMac, macMatches, MAX_CLOCK_SKEW_MS } from "../security.js";
                                                  
                                                              

                        
                                                             
                                                      
                                                                                 
                                                              
                                           

                                                                                                                  

                           
               
                  
                
            
             
                    
                      

export class MeshWire {
           #connection              ;
           #keys             ;
           #localDeviceId        ;
           #peerDeviceId        ;
  #seq = 0;
  #lastInboundSeq = 0;
  #closed = false;
  #onFrame                              = () => {};
  #onClose             = () => {};
  #onError                                                 = () => {};

  constructor(connection              , keys             , localDeviceId        , peerDeviceId        ) {
    this.#connection = connection;
    this.#keys = keys;
    this.#localDeviceId = localDeviceId;
    this.#peerDeviceId = peerDeviceId;
    connection.onMessage((text) => this.#ingest(text));
    connection.onClose(() => this.#shutdown());
    connection.onError((error) => this.#fail("TRANSPORT_ERROR", error.message));
  }

  get closed()          {
    return this.#closed || this.#connection.state !== "open";
  }

  get peerDeviceId()         {
    return this.#peerDeviceId;
  }

  onFrame(handler                             )       {
    this.#onFrame = handler;
  }

  onClose(handler            )       {
    this.#onClose = handler;
  }

  onError(handler                                                )       {
    this.#onError = handler;
  }

  send(frame            )          {
    if (this.closed) return false;
    const seq = this.#seq + 1;
    const ts = Date.now();
    const body = sealPayload(this.#keys, JSON.stringify(frame));
    const mac = deriveEnvelopeMac(this.#keys, {
      from: this.#localDeviceId,
      to: this.#peerDeviceId,
      seq,
      time: ts,
      sealed: body,
    });
    this.#seq = seq;
    const envelope           = { k: "env", from: this.#localDeviceId, to: this.#peerDeviceId, seq, ts, mac, body };
    return this.#connection.send(JSON.stringify(envelope));
  }

  ping()       {
    this.#connection.ping();
  }

  close(code = 1000, reason = "")       {
    if (this.#closed) return;
    this.#closed = true;
    this.#connection.close(code, reason);
    this.#onClose();
  }

  destroy()       {
    if (this.#closed) return;
    this.#closed = true;
    this.#connection.destroy();
    this.#onClose();
  }

  #shutdown()       {
    if (this.#closed) return;
    this.#closed = true;
    this.#onClose();
  }

  #fail(code               , message        )       {
    if (this.#closed) return;
    this.#onError(code, message);
    this.destroy();
  }

  #ingest(text        )       {
    if (this.#closed) return;
    let parsed         ;
    try {
      parsed = JSON.parse(text);
    } catch {
      this.#fail("BAD_FRAME", "the peer sent a frame that is not JSON");
      return;
    }
    const envelope = parsed                     ;
    if (envelope.k !== "env") {
      this.#fail("BAD_FRAME", `the peer sent an unexpected frame kind "${String(envelope.k)}"`);
      return;
    }
    if (envelope.from !== this.#peerDeviceId || envelope.to !== this.#localDeviceId) {
      this.#fail("MISADDRESSED", "the peer frame names a different sender or recipient device");
      return;
    }
    const ts = Number(envelope.ts);
    const skew = Math.abs(Date.now() - ts);
    if (!Number.isFinite(ts) || skew > MAX_CLOCK_SKEW_MS) {
      this.#fail("CLOCK_SKEW", `peer frame timestamp is ${Math.round(skew / 1000)}s away from local time`);
      return;
    }
    const seq = Number(envelope.seq);
    if (!Number.isSafeInteger(seq) || seq <= this.#lastInboundSeq) {
      this.#fail("REPLAY", `peer frame sequence ${String(envelope.seq)} is repeated or out of order`);
      return;
    }
    if (typeof envelope.body !== "string" || typeof envelope.mac !== "string") {
      this.#fail("BAD_FRAME", "peer frame is missing its sealed body or MAC");
      return;
    }
    const expected = deriveEnvelopeMac(this.#keys, {
      from: envelope.from,
      to: envelope.to,
      seq,
      time: ts,
      sealed: envelope.body,
    });
    if (!macMatches(expected, envelope.mac)) {
      this.#fail("BAD_MAC", "peer frame failed authentication (wrong pairing secret or forged frame)");
      return;
    }
    this.#lastInboundSeq = seq;
    let inner            ;
    try {
      inner = JSON.parse(openPayload(this.#keys, envelope.body))              ;
    } catch {
      this.#fail("BAD_CIPHERTEXT", "peer frame could not be decrypted");
      return;
    }
    this.#onFrame(inner);
  }
}


//# sourceURL=src/rpc/wire.ts