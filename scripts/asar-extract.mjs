#!/usr/bin/env node
// Developer tool: read files out of an Electron .asar archive with plain Node.
//
// Why this exists: the installed DeepSeek Harness ships as `app.asar`, which ripgrep,
// node's fs and the glob/grep tools all refuse to look inside. Reading single files
// through the Host is possible but slow, and we need to grep the whole implementation
// to design dsh-mesh against the real API instead of a guessed one. This extractor
// parses the asar header directly and writes a selected subtree to disk so ordinary
// tooling works on it.
//
// Usage:
//   node scripts/asar-extract.mjs <archive> <outDir> [filterRegex]
import fs from "node:fs";
import path from "node:path";

const [, , archiveArg, outArg, filterArg] = process.argv;
if (!archiveArg || !outArg) {
  console.error("usage: node scripts/asar-extract.mjs <archive.asar> <outDir> [filterRegex]");
  process.exit(2);
}

const archive = path.resolve(archiveArg);
const outDir = path.resolve(outArg);
const filter = filterArg === undefined ? null : new RegExp(filterArg);

const fd = fs.openSync(archive, "r");
// Electron/Chromium "Pickle" framing, exactly as the asar reader parses it:
//   bytes 0..7   pickle #1: [uint32 payloadSize=4][uint32 headerBufSize]
//   bytes 8..    pickle #2 of `headerBufSize` bytes: [uint32 payloadSize][uint32 jsonLen][JSON]
// File data begins at 8 + headerBufSize (4-byte aligned) and every entry's `offset`
// is relative to that base.
const lead = Buffer.alloc(8);
fs.readSync(fd, lead, 0, 8, 0);
const leadPayload = lead.readUInt32LE(0);
const headerBufSize = lead.readUInt32LE(4);
if (leadPayload !== 4) throw new Error(`unexpected asar leading payload size: ${leadPayload}`);
const headerBuf = Buffer.alloc(headerBufSize);
fs.readSync(fd, headerBuf, 0, headerBufSize, 8);
const jsonLen = headerBuf.readUInt32LE(4);
const jsonBuf = headerBuf.subarray(8, 8 + jsonLen);
const header = JSON.parse(jsonBuf.toString("utf8"));
const alignedOffset = Math.ceil((8 + headerBufSize) / 4) * 4;

let written = 0;
let skipped = 0;
let bytes = 0;

/** Walk the asar header tree and copy every regular file whose path matches. */
function walk(node, prefix) {
  for (const [name, entry] of Object.entries(node.files ?? {})) {
    const rel = prefix === "" ? name : `${prefix}/${name}`;
    if (entry.files !== undefined) {
      walk(entry, rel);
      continue;
    }
    if (entry.link !== undefined) { skipped += 1; continue; }
    if (filter !== null && !filter.test(rel)) { skipped += 1; continue; }
    const target = path.join(outDir, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const start = alignedOffset + Number(entry.offset);
    const length = Number(entry.size);
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, start);
    fs.writeFileSync(target, buf);
    written += 1;
    bytes += length;
    if (entry.executable) fs.chmodSync(target, 0o755);
  }
}

fs.mkdirSync(outDir, { recursive: true });
walk(header, "");
fs.closeSync(fd);
console.log(JSON.stringify({ archive, outDir, written, skipped, bytes, headerBufSize, jsonLen, alignedOffset }));
