// Generated from src/rpc\handshake.ts by scripts/build.mjs. Do not edit.
// The mesh handshake, in one place because both directions run it.
//
// Sequence (identical on both sides, which is what makes one connection usable in both
// directions without a designated client):
//
//   1. Immediately after the WebSocket upgrade, each side sends one cleartext `hello`:
//      its device id, its Ed25519 public key, a fresh nonce, a signature over that
//      nonce, its display name, and the capability list it serves.
//   2. Each side verifies the other: the claimed device id must be the hash of the
//      presented key, the signature must verify, and *a stored pairing must already
//      exist for that device id*. There is no trust-on-first-use fallback — an unknown
//      device is refused, which is the "first connection requires explicit pairing"
//      requirement expressed in code.
//   3. Both sides derive the same AES/HMAC keys from the pairing secret bound to both
//      device ids, and every later frame is an authenticated encrypted envelope.
//
// A refusal is reported with a stable code so the operator's log says why.

import { randomBytes } from "node:crypto";
import {
  deriveSessionKeys,
  deviceIdOf,
  signChallenge,
  verifyChallenge,
                      
                       
                   
} from "../security.js";
                                                              

export const PROTOCOL = "dsh-mesh.v1";
export const HANDSHAKE_VERSION = "1.0.0";

                             
             
       
               
             
                
                
               
                         
                  
 

                                  
                   
               
                  
 

                                 
                           
                                                        
                                                            
                                                                                      
                                     
                         
                  
                    
 

                              
                                                                       
                                                 

/** Build this side's hello. */
export function makeHello(input                , nonce        )             {
  const { identity } = input;
  return {
    k: "hello",
    v: 1,
    from: identity.deviceId,
    pk: identity.publicKeyPem,
    nonce,
    proof: signChallenge(identity, nonce),
    name: identity.name,
    capabilities: [...input.capabilities],
    version: input.version,
  };
}

/** Verify a peer's hello against the local pairing store. */
export function checkHello(
  frame            ,
  input                ,
)                                                                                                 {
  if (frame.k !== "hello") return { ok: false, code: "BAD_FRAME", message: "expected a hello frame" };
  if (typeof frame.pk !== "string" || typeof frame.from !== "string" || typeof frame.proof !== "string") {
    return { ok: false, code: "BAD_FRAME", message: "hello is missing identity fields" };
  }
  if (typeof frame.nonce !== "string" || frame.nonce.length < 8) {
    return { ok: false, code: "BAD_FRAME", message: "hello nonce is too short to be a challenge" };
  }
  const claimed = deviceIdOf(frame.pk);
  if (claimed !== frame.from) {
    return {
      ok: false,
      code: "IDENTITY_MISMATCH",
      message: "the presented public key does not hash to the claimed device id",
    };
  }
  if (input.expectedPeerId !== undefined && input.expectedPeerId !== frame.from) {
    return {
      ok: false,
      code: "UNEXPECTED_PEER",
      message: `this link expects device "${input.expectedPeerId}" but "${frame.from}" answered`,
    };
  }
  if (!verifyChallenge(frame.pk, frame.nonce, frame.proof)) {
    return { ok: false, code: "BAD_PROOF", message: "the peer failed to prove possession of its device key" };
  }
  const pairing = input.pairingFor(frame.from);
  if (pairing === undefined) {
    return {
      ok: false,
      code: "NOT_PAIRED",
      message: `device "${frame.from}" is not paired with this device; pair it first (mesh_status shows the pairing command)`,
    };
  }
  if (!pairing.peers.includes(frame.from) || !pairing.peers.includes(input.identity.deviceId)) {
    return { ok: false, code: "PAIRING_MISMATCH", message: "the stored pairing does not name these two devices" };
  }
  const keys = deriveSessionKeys(pairing.secret, input.identity.deviceId, frame.from);
  return { ok: true, peerId: frame.from, keys };
}

/**
 * Run the full handshake over an already-upgraded connection.
 *
 * Both sides call this concurrently; the two hellos cross on the wire and neither can
 * be mistaken for the other because each is a complete frame.
 */
export function performHandshake(connection              , input                )                            {
  const nonce = randomBytes(18).toString("base64");
  const hello = makeHello(input, nonce);
  connection.send(JSON.stringify(hello));
  return new Promise                  ((resolve) => {
    let settled = false;
    // `stop` is assigned only after the subscription exists, but `WsConnection.onMessage`
    // replays frames that arrived before anyone listened — synchronously, before it returns.
    // The peer's hello can land in that replay window, so `finish` must tolerate being
    // called before `stop` exists rather than throwing on an uninitialised binding.
    let stop             = () => {};
    const finish = (outcome                  ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stop();
      resolve(outcome);
    };
    const timer = setTimeout(() => {
      finish({ ok: false, code: "HANDSHAKE_TIMEOUT", message: `peer did not answer within ${input.timeoutMs}ms` });
    }, input.timeoutMs);
    timer.unref?.();
    stop = connection.onMessage((text) => {
      if (settled) return;
      let parsed         ;
      try {
        parsed = JSON.parse(text);
      } catch {
        finish({ ok: false, code: "BAD_FRAME", message: "peer sent a non-JSON handshake frame" });
        return;
      }
      const candidate = parsed                                                                   ;
      if (candidate.k === "hello-error") {
        finish({
          ok: false,
          code: typeof candidate.code === "string" ? candidate.code : "HELLO_ERROR",
          message: typeof candidate.message === "string" ? candidate.message : "the peer refused this connection",
        });
        return;
      }
      if (candidate.k !== "hello") {
        finish({ ok: false, code: "BAD_FRAME", message: `expected a hello frame, received "${String(candidate.k)}"` });
        return;
      }
      const verdict = checkHello(candidate              , input);
      if (!verdict.ok) {
        finish(verdict);
        return;
      }
      finish({ ok: true, peerId: verdict.peerId, keys: verdict.keys, remote: candidate               });
    });
    // A synchronous replay may already have settled the promise above, in which case the
    // subscription created no longer has a consumer.
    if (settled) stop();
  });
}

/** Send a refusal to the peer, then close. The peer's log will name the reason. */
export function refuseHandshake(connection              , code        , message        )       {
  try {
    const frame                  = { k: "hello-error", code, message };
    connection.send(JSON.stringify(frame));
  } catch {
    /* the socket may already be gone */
  }
  connection.destroy();
}


//# sourceURL=src/rpc/handshake.ts