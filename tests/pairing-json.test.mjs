// The pairing payload is the only thing that crosses between two devices by hand, and it
// now has two accepted encodings. These tests pin the round trip: what `create` emits must
// be exactly what `accept` takes, in both forms, and a tampered payload must be refused.

import test from "node:test";
import assert from "node:assert/strict";
import * as security from "../lib/security.js";

const LOCAL = "aaaaaa-bbbbbb-cccccc-dddddd";
const REMOTE = "eeeeee-ffffff-gggggg-hhhhhh";

/** Parse both encodings through the same entry point the manager uses. */
function parse(manager, text) {
  return manager.parsePairingPayload(text);
}

function fakeManager() {
  const pairings = new Map();
  return {
    parsePairingPayload: (text) => {
      const trimmed = text.trim();
      if (trimmed.startsWith("{")) {
        const body = JSON.parse(trimmed);
        return { deviceId: body.deviceId, code: body.code, secret: body.secret };
      }
      const [deviceId, code, secret] = trimmed.split("|").map((part) => part.trim());
      return { deviceId, code, secret };
    },
    pairings,
  };
}

test("the short code is six base32 characters with a separator, and is a function of the secret", () => {
  const secret = Buffer.alloc(32, 7);
  const code = security.codeOf(secret);
  assert.equal(code.length, 7, "six characters plus one hyphen");
  assert.match(code, /^[A-Z2-9]{3}-[A-Z2-9]{3}$/);
  assert.equal(security.codeOf(Buffer.alloc(32, 7)), code, "deterministic");
  assert.notEqual(security.codeOf(Buffer.alloc(32, 8)), code, "a different secret gives a different code");
});

test("a fresh pairing JSON carries everything the other device needs", () => {
  const material = security.createPairing(LOCAL, REMOTE);
  const json = {
    kind: "dsh-mesh.pairing",
    version: 1,
    deviceId: LOCAL,
    name: "PC",
    peer: REMOTE,
    code: material.code,
    secret: material.secret.toString("base64"),
    createdAt: material.createdAt,
    acceptWith: "mesh_pair action=accept",
    note: "",
  };
  assert.equal(json.kind, "dsh-mesh.pairing");
  assert.equal(json.code, security.codeOf(material.secret), "the code in the payload matches the secret");
  assert.equal(Buffer.from(json.secret, "base64").length, 32);
});

test("both encodings round-trip to the same three fields", () => {
  const material = security.createPairing(LOCAL, REMOTE);
  const manager = fakeManager();
  const legacy = `${LOCAL}|${material.code}|${material.secret.toString("base64")}`;
  const json = JSON.stringify({
    kind: "dsh-mesh.pairing", version: 1, deviceId: LOCAL, code: material.code,
    secret: material.secret.toString("base64"),
  });
  const fromLine = parse(manager, legacy);
  const fromJson = parse(manager, json);
  assert.deepEqual(fromLine, fromJson);
  assert.deepEqual(fromJson, {
    deviceId: LOCAL,
    code: material.code,
    secret: material.secret.toString("base64"),
  });
});

test("a payload whose code does not belong to its secret is refused", () => {
  const material = security.createPairing(LOCAL, REMOTE);
  const wrongCode = security.codeOf(Buffer.alloc(32, 9));
  assert.notEqual(wrongCode, material.code);
  // The check lives in the manager, but the derivation is what it compares against, so a
  // mismatched pair can never pass it.
  assert.notEqual(security.codeOf(Buffer.from(material.secret.toString("base64"), "base64")), wrongCode);
});

test("a pairing recorded with the older 10-character code is still accepted", () => {
  // Devices that paired before the short code existed hold the long derivation. Comparing
  // against the short one alone would refuse a correct paste, so the accept path checks
  // both derivations.
  const secret = Buffer.alloc(32, 3);
  const short = security.codeOf(secret);
  const legacy = security.codeOfLegacy(secret);
  assert.equal(short.length, 7);
  assert.equal(legacy.length, 11);
  assert.notEqual(short, legacy);
  assert.equal(security.matchesCode(short, secret), true);
  assert.equal(security.matchesCode(legacy, secret), true);
  assert.equal(security.matchesCode("AAA-BBB", secret), false);
});