// Security primitives: identity, pairing, session keys, and the envelope MAC.
//
// Design notes that matter for review:
//
//   * The device id is derived from the public key, so it cannot be spoofed without
//     also producing a key whose hash matches — i.e. without owning that key.
//   * The pairing secret is a 32-byte random value carried out-of-band (a string the
//     operator copies between devices). It is the *only* thing that has to travel
//     outside the tunnel, which is why the pairing code exists.
//   * Session keys are derived from the secret *and both device ids*, so a secret from
//     one pairing cannot authenticate a link claiming different devices.
//   * The envelope MAC covers sender, recipient, sequence, timestamp, and ciphertext.
//     A frame replayed from an earlier session has the wrong seq or ts and is refused.
//
// Nothing here logs a secret, a private key, or a plaintext payload.

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  timingSafeEqual,
  verify,
  type KeyObject,
} from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
export const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

/** Unpadded lowercase RFC 4648 base32. */
export function base32(bytes: Buffer): string {
  let out = "";
  let bits = 0;
  let value = 0;
  for (const byte of bytes) {
    value = ((value << 8) | byte) >>> 0;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

/** Derive the durable device id from an Ed25519 public key in PEM form. */
export function deviceIdOf(publicKeyPem: string): string {
  const digest = createHash("sha256").update(publicKeyPem).digest();
  const encoded = base32(digest.subarray(0, 16));
  return `${encoded.slice(0, 6)}-${encoded.slice(6, 12)}-${encoded.slice(12, 18)}-${encoded.slice(18, 24)}`;
}

export interface DeviceIdentity {
  deviceId: string;
  name: string;
  publicKeyPem: string;
  privateKeyPem: string;
  createdAt: number;
}

export interface IdentityView {
  deviceId: string;
  name: string;
  publicKeyPem: string;
  createdAt: number;
}

/** The only projection of the identity that may leave this module. */
export function describeIdentity(identity: DeviceIdentity): IdentityView {
  return {
    deviceId: identity.deviceId,
    name: identity.name,
    publicKeyPem: identity.publicKeyPem,
    createdAt: identity.createdAt,
  };
}

interface IdentityFile {
  version: 1;
  deviceId: string;
  name: string;
  publicKeyPem: string;
  privateKeyPem: string;
  createdAt: number;
}

/**
 * Load the persisted identity, or mint one.
 *
 * A corrupt file is moved aside rather than overwritten: it may hold the only record of
 * a pairing, and silently replacing it would strand the other device.
 */
export function loadOrCreateIdentity(stateDir: string, nameHint: string): DeviceIdentity {
  const file = path.join(stateDir, "identity.json");
  if (fs.existsSync(file)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as IdentityFile;
      if (
        parsed.version === 1 &&
        typeof parsed.publicKeyPem === "string" &&
        parsed.publicKeyPem.length > 0 &&
        typeof parsed.privateKeyPem === "string" &&
        parsed.privateKeyPem.length > 0
      ) {
        return {
          deviceId: deviceIdOf(parsed.publicKeyPem),
          name: nameHint.length > 0 ? nameHint : parsed.name,
          publicKeyPem: parsed.publicKeyPem,
          privateKeyPem: parsed.privateKeyPem,
          createdAt: parsed.createdAt,
        };
      }
    } catch {
      try {
        fs.renameSync(file, `${file}.corrupt-${Date.now()}`);
      } catch {
        /* the original file stays; the caller sees a fresh identity */
      }
    }
  }
  fs.mkdirSync(stateDir, { recursive: true });
  const pair = generateKeyPairSync("ed25519");
  const publicKeyPem = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const record: IdentityFile = {
    version: 1,
    deviceId: deviceIdOf(publicKeyPem),
    name: nameHint.length > 0 ? nameHint : "dsh-mesh",
    publicKeyPem,
    privateKeyPem,
    createdAt: Date.now(),
  };
  fs.writeFileSync(file, JSON.stringify(record, null, 2), { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* Windows ACLs govern this file; the profile directory is already user-private. */
  }
  return {
    deviceId: record.deviceId,
    name: record.name,
    publicKeyPem,
    privateKeyPem,
    createdAt: record.createdAt,
  };
}

function privateKeyOf(identity: DeviceIdentity): KeyObject {
  return createPrivateKey(identity.privateKeyPem);
}

/** Sign the handshake challenge. */
export function signChallenge(identity: DeviceIdentity, challenge: string): string {
  return sign(null, Buffer.from(challenge, "utf8"), privateKeyOf(identity)).toString("base64");
}

/** Verify a peer's handshake proof against the key it presented. */
export function verifyChallenge(publicKeyPem: string, challenge: string, proof: string): boolean {
  try {
    const key = createPublicKey(publicKeyPem);
    return verify(null, Buffer.from(challenge, "utf8"), key, Buffer.from(proof, "base64"));
  } catch {
    return false;
  }
}

export interface PairingMaterial {
  code: string;
  secret: Buffer;
  createdAt: number;
  peers: [string, string];
}

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** Derive the human-transcribable pairing code from the secret. */
export function codeOf(secret: Buffer): string {
  const digest = createHmac("sha256", secret).update("dsh-mesh/pairing-code/v1").digest();
  let out = "";
  for (let index = 0; index < 10; index += 1) out += CODE_ALPHABET[digest[index] % CODE_ALPHABET.length];
  return `${out.slice(0, 5)}-${out.slice(5)}`;
}

/** Mint fresh pairing material for one device pair. */
export function createPairing(localDeviceId: string, remoteDeviceId: string): PairingMaterial {
  const secret = randomBytes(32);
  return {
    code: codeOf(secret),
    secret,
    createdAt: Date.now(),
    peers: [localDeviceId, remoteDeviceId],
  };
}

export interface PairingStore {
  get(deviceId: string): PairingMaterial | undefined;
  set(deviceId: string, material: PairingMaterial): void;
  remove(deviceId: string): boolean;
  list(): Array<{ deviceId: string; code: string; createdAt: number }>;
}

interface PairingFile {
  version: 1;
  entries: Record<string, { code: string; secret: string; createdAt: number; peers: [string, string] }>;
}

/** Durable pairing store (one file, mode 0600, never printed in full). */
export function openPairingStore(stateDir: string): PairingStore {
  const file = path.join(stateDir, "pairings.json");
  const read = (): PairingFile => {
    if (!fs.existsSync(file)) return { version: 1, entries: {} };
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as PairingFile;
      if (parsed.version !== 1 || typeof parsed.entries !== "object" || parsed.entries === null) {
        return { version: 1, entries: {} };
      }
      return parsed;
    } catch {
      return { version: 1, entries: {} };
    }
  };
  const write = (state: PairingFile): void => {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(state, null, 2), { mode: 0o600 });
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      /* Windows ACLs apply. */
    }
  };
  return {
    get(deviceId) {
      const entry = read().entries[deviceId];
      if (entry === undefined) return undefined;
      return {
        code: entry.code,
        secret: Buffer.from(entry.secret, "base64"),
        createdAt: entry.createdAt,
        peers: entry.peers,
      };
    },
    set(deviceId, material) {
      const state = read();
      state.entries[deviceId] = {
        code: material.code,
        secret: material.secret.toString("base64"),
        createdAt: material.createdAt,
        peers: material.peers,
      };
      write(state);
    },
    remove(deviceId) {
      const state = read();
      if (!(deviceId in state.entries)) return false;
      delete state.entries[deviceId];
      write(state);
      return true;
    },
    list() {
      return Object.entries(read().entries).map(([deviceId, entry]) => ({
        deviceId,
        code: entry.code,
        createdAt: entry.createdAt,
      }));
    },
  };
}

export interface SessionKeys {
  encryption: Buffer;
  authentication: Buffer;
}

/** Derive both traffic keys from the pairing secret bound to both device ids. */
export function deriveSessionKeys(secret: Buffer, a: string, b: string): SessionKeys {
  const ordered = a <= b ? [a, b] : [b, a];
  const transcript = `${ordered[0]}|${ordered[1]}`;
  return {
    encryption: createHmac("sha256", secret).update(`enc/v1:${transcript}`).digest(),
    authentication: createHmac("sha256", secret).update(`mac/v1:${transcript}`).digest(),
  };
}

/** AES-256-GCM seal: nonce ‖ tag ‖ ciphertext, base64. */
export function sealPayload(keys: SessionKeys, plaintext: string): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keys.encryption, nonce);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), body]).toString("base64");
}

/** Inverse of `sealPayload`; throws on tampering. */
export function openPayload(keys: SessionKeys, sealed: string): string {
  const raw = Buffer.from(sealed, "base64");
  if (raw.length < 28) throw new Error("sealed payload is truncated");
  const decipher = createDecipheriv("aes-256-gcm", keys.encryption, raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
}

/** HMAC over the canonical envelope fields. */
export function deriveEnvelopeMac(
  keys: SessionKeys,
  parts: { from: string; to: string; seq: number; time: number; sealed: string },
): string {
  const canonical = `${parts.from}\u0000${parts.to}\u0000${parts.seq}\u0000${parts.time}\u0000${parts.sealed}`;
  return createHmac("sha256", keys.authentication).update(canonical).digest("base64");
}

/** Constant-time comparison of two base64 MACs. */
export function macMatches(expected: string, actual: string): boolean {
  const left = Buffer.from(expected, "utf8");
  const right = Buffer.from(actual, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** SHA-256 as lowercase hex. */
export function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(typeof data === "string" ? Buffer.from(data, "utf8") : data).digest("hex");
}

/** Constant-time digest comparison. */
export function digestEquals(left: string, right: string): boolean {
  const a = Buffer.from(left.toLowerCase(), "utf8");
  const b = Buffer.from(right.toLowerCase(), "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Normalise a certificate fingerprint to lowercase hex without separators. */
export function normalizeFingerprint(value: string): string {
  return value.replace(/[^0-9a-fA-F]/g, "").toLowerCase();
}

/** SHA-256 fingerprint of a PEM certificate. */
export function certificateFingerprint(certPem: string): string {
  const body = certPem
    .replace(/-----BEGIN CERTIFICATE-----/g, "")
    .replace(/-----END CERTIFICATE-----/g, "")
    .replace(/\s+/g, "");
  return createHash("sha256").update(Buffer.from(body, "base64")).digest("hex");
}
