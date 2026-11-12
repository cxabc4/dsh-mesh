// Local capability surface: everything a *remote* peer is allowed to make this device do.
//
// Security model, stated once because it is the whole point of this file:
//
//   * Nothing here trusts the request. Each entry point re-validates the path against
//     the operator's configured `permissions.allowedRoots`; a path that escapes a root
//     is refused even if the caller computed it from a listing we handed it.
//   * Commands run through a policy gate (deny patterns + optional allowlist) and never
//     through a shell: argv is built explicitly, so a command string cannot smuggle
//     `&& rm -rf` past the policy.
//   * Every write is version-checked. The caller sends the SHA-256 it last read; a
//     mismatch is returned as a conflict instead of overwriting somebody's work.
//   * Every denied or accepted action is recorded in the audit journal with the peer
//     device id, so a later review can say who did what on this machine.
//
// The peer never gets a raw shell and never gets to pick its own working directory
// outside the allowed roots.

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { sha256Hex, digestEquals } from "../security.ts";
import { deniedPattern, type PermissionsConfig } from "../config.ts";

export class DeniedError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "DeniedError";
    this.code = code;
  }
}

export interface AuditEntry {
  time: number;
  peer: string;
  action: string;
  detail: string;
  outcome: "ok" | "denied" | "error";
}

/** Bounded in-memory audit journal; the plugin also mirrors it to disk. */
export class AuditLog {
  readonly #entries: AuditEntry[] = [];
  readonly #max: number;
  #sink: ((entry: AuditEntry) => void) | undefined;

  constructor(max: number, sink?: (entry: AuditEntry) => void) {
    this.#max = max;
    this.#sink = sink;
  }

  setSink(sink: (entry: AuditEntry) => void): void {
    this.#sink = sink;
  }

  record(entry: AuditEntry): void {
    this.#entries.push(entry);
    while (this.#entries.length > this.#max) this.#entries.shift();
    try {
      this.#sink?.(entry);
    } catch {
      /* auditing must never break the action it records */
    }
  }

  recent(limit = 50): AuditEntry[] {
    return this.#entries.slice(-limit);
  }

  size(): number {
    return this.#entries.length;
  }
}

/** Canonicalise a caller-supplied path and prove it stays inside an allowed root. */
export function resolveInsideRoots(
  requestPath: string,
  roots: readonly string[],
  { mustExist }: { mustExist: boolean },
): { absolute: string; root: string } {
  if (roots.length === 0) {
    throw new DeniedError("NO_ROOTS", "this device grants no remote file access (permissions.allowedRoots is empty)");
  }
  if (typeof requestPath !== "string" || requestPath.length === 0) {
    throw new DeniedError("BAD_PATH", "path must be a non-empty string");
  }
  if (requestPath.includes("\u0000")) throw new DeniedError("BAD_PATH", "path contains a NUL byte");
  // A relative path is refused outright: the remote has no idea what our cwd is, and
  // resolving one against the plugin's own directory would be a surprise, not a feature.
  if (!path.isAbsolute(requestPath)) {
    throw new DeniedError("RELATIVE_PATH", "remote paths must be absolute on the target device");
  }
  const normalized = path.resolve(requestPath);
  let matchedRoot: string | undefined;
  for (const rawRoot of roots) {
    const root = path.resolve(rawRoot);
    // Compare on the normalised absolute form. Windows path case is folded by
    // toLowerCase on both sides; POSIX paths are already case-sensitive.
    const samePlatformFold = (value: string) =>
      process.platform === "win32" ? value.toLowerCase() : value;
    const candidate = samePlatformFold(normalized);
    const base = samePlatformFold(root);
    if (candidate === base || candidate.startsWith(base + path.sep)) {
      matchedRoot = root;
      break;
    }
  }
  if (matchedRoot === undefined) {
    throw new DeniedError(
      "OUTSIDE_ROOTS",
      `path "${requestPath}" is outside every allowed root (allowed: ${roots.join(", ")})`,
    );
  }
  if (mustExist) {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(normalized);
    } catch {
      throw new DeniedError("NOT_FOUND", `path "${requestPath}" does not exist on this device`);
    }
    // A symlink inside a root may point anywhere; following it would escape the
    // containment check above, so the real path is verified against the same roots.
    if (stat.isSymbolicLink()) {
      const real = fs.realpathSync(normalized);
      return resolveInsideRoots(real, roots, { mustExist: true });
    }
  }
  return { absolute: normalized, root: matchedRoot };
}

export interface DirEntry {
  name: string;
  path: string;
  kind: "file" | "directory" | "symlink" | "other";
  size: number;
  modified: number;
}

export interface ReadResult {
  path: string;
  version: string;
  bytes: number;
  totalLines: number;
  /** UTF-8 content; text files only. Binary files are reported without content. */
  content: string | undefined;
  truncated: boolean;
  binary: boolean;
  offset: number;
  lineCount: number;
}

export interface WriteResult {
  path: string;
  version: string;
  bytes: number;
  created: boolean;
  /** True when the caller's expected version matched and the file was replaced atomically. */
  replaced: boolean;
}

export interface ExecResult {
  command: string;
  cwd: string;
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  truncated: boolean;
}

export interface LogPage {
  path: string;
  /** Byte offset the page starts at; pass it back to continue reading. */
  offset: number;
  nextOffset: number;
  eof: boolean;
  lines: string[];
  /** File size when the page was served, so a caller can detect truncation. */
  size: number;
}

const BINARY_PROBE_BYTES = 512;
const MAX_LINE_BYTES = 4096;

/** Read a bounded text page from a file, resuming at a byte offset. */
export function readFilePage(
  absolute: string,
  offset: number,
  maxLines: number,
  maxBytes: number,
): ReadResult {
  const stat = fs.statSync(absolute);
  if (!stat.isFile()) throw new DeniedError("NOT_A_FILE", `"${absolute}" is not a regular file`);
  const size = stat.size;
  const head = readHead(absolute, Math.min(BINARY_PROBE_BYTES, size));
  const binary = looksBinary(head);
  if (binary) {
    return {
      path: absolute,
      version: sha256Hex(fs.readFileSync(absolute).length ? hashOfFile(absolute) : ""),
      bytes: size,
      totalLines: 0,
      content: undefined,
      truncated: true,
      binary: true,
      offset: 0,
      lineCount: 0,
    };
  }
  const buffer = fs.readFileSync(absolute);
  const text = buffer.toString("utf8");
  const allLines = text.split(/\r?\n/);
  const totalLines = allLines.length;
  const start = Math.max(0, offset);
  const page = allLines.slice(start, start + maxLines);
  let joined = page.join("\n");
  let truncated = start + page.length < totalLines;
  if (Buffer.byteLength(joined, "utf8") > maxBytes) {
    joined = joined.slice(0, maxBytes);
    truncated = true;
  }
  return {
    path: absolute,
    version: sha256Hex(buffer),
    bytes: size,
    totalLines,
    content: joined,
    truncated,
    binary: false,
    offset: start,
    lineCount: page.length,
  };
}

function readHead(absolute: string, bytes: number): Buffer {
  const fd = fs.openSync(absolute, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    fs.readSync(fd, buffer, 0, bytes, 0);
    return buffer;
  } finally {
    fs.closeSync(fd);
  }
}

function looksBinary(probe: Buffer): boolean {
  if (probe.length === 0) return false;
  for (const byte of probe) {
    // NUL or any C0 control other than \t \n \v \f \r marks a binary payload.
    if (byte === 0) return true;
    if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0b && byte !== 0x0c && byte !== 0x0d) return true;
  }
  return false;
}

function hashOfFile(absolute: string): string {
  return sha256Hex(fs.readFileSync(absolute));
}

/**
 * Write text with optimistic concurrency.
 *
 * `expectedVersion` is the hash the caller last observed. When it is absent and the
 * file exists we refuse: overwriting a file the caller never read is exactly the
 * silent-clobber the spec forbids. The replacement itself goes through a temp file in
 * the same directory plus a rename, so a crash mid-write cannot leave a torn file.
 */
export function writeFileAtomic(
  absolute: string,
  content: string,
  expectedVersion: string | undefined,
): WriteResult {
  const existed = fs.existsSync(absolute);
  const currentVersion = existed ? hashOfFile(absolute) : undefined;
  if (existed) {
    if (expectedVersion === undefined || expectedVersion === "") {
      throw new DeniedError(
        "VERSION_REQUIRED",
        `"${absolute}" already exists; pass the version you read (sha256) so a concurrent change is not overwritten`,
      );
    }
    if (!digestEquals(expectedVersion, currentVersion ?? "")) {
      throw new DeniedError(
        "VERSION_CONFLICT",
        `"${absolute}" changed since it was read: expected ${expectedVersion}, current ${currentVersion}`,
      );
    }
  } else if (expectedVersion !== undefined && expectedVersion !== "") {
    throw new DeniedError(
      "VERSION_CONFLICT",
      `"${absolute}" does not exist, but the caller expected version ${expectedVersion}`,
    );
  }
  const directory = path.dirname(absolute);
  const temporary = path.join(directory, `.dsh-mesh-${Math.random().toString(36).slice(2)}.tmp`);
  fs.mkdirSync(directory, { recursive: true });
  try {
    fs.writeFileSync(temporary, content, "utf8");
    fs.renameSync(temporary, absolute);
  } catch (error) {
    try {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    } catch {
      /* ignore */
    }
    throw error;
  }
  return {
    path: absolute,
    version: sha256Hex(Buffer.from(content, "utf8")),
    bytes: Buffer.byteLength(content, "utf8"),
    created: !existed,
    replaced: existed,
  };
}

/** List one directory, sorted by name. */
export function listDirectory(absolute: string, maxEntries: number): { entries: DirEntry[]; truncated: boolean } {
  const stat = fs.statSync(absolute);
  if (!stat.isDirectory()) throw new DeniedError("NOT_A_DIRECTORY", `"${absolute}" is not a directory`);
  const names = fs.readdirSync(absolute, { withFileTypes: true });
  const entries: DirEntry[] = [];
  for (const entry of names.slice(0, maxEntries)) {
    const full = path.join(absolute, entry.name);
    let info: fs.Stats | undefined;
    try {
      info = fs.lstatSync(full);
    } catch {
      continue;
    }
    entries.push({
      name: entry.name,
      path: full,
      kind: entry.isDirectory()
        ? "directory"
        : entry.isSymbolicLink()
          ? "symlink"
          : entry.isFile()
            ? "file"
            : "other",
      size: info.size,
      modified: info.mtimeMs,
    });
  }
  return { entries, truncated: names.length > maxEntries };
}

/** Resolve the program to run and split it from the argument list. */
function splitCommand(command: string): { program: string; args: string[] } {
  // No shell: the caller supplies a program plus arguments. Quoted forms are accepted
  // for convenience, but nothing is expanded, globbed, or chained.
  const trimmed = command.trim();
  if (trimmed.length === 0) throw new DeniedError("BAD_COMMAND", "command is empty");
  const parts: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  for (const character of trimmed) {
    if (quote !== undefined) {
      if (character === quote) quote = undefined;
      else current += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === " " || character === "\t") {
      if (current.length > 0) {
        parts.push(current);
        current = "";
      }
      continue;
    }
    current += character;
  }
  if (current.length > 0) parts.push(current);
  if (parts.length === 0) throw new DeniedError("BAD_COMMAND", "command has no program");
  return { program: parts[0], args: parts.slice(1) };
}

/** Whether the command is permitted by the deployment policy. */
export function checkCommandPolicy(program: string, args: string[], policy: PermissionsConfig): void {
  const normalized = program.toLowerCase();
  const base = path.basename(normalized).replace(/\.(exe|com|ps1)$/i, "");

  // Script files are refused by extension, not just by interpreter name. On Windows a
  // `.bat`/`.cmd` is executed by cmd.exe even when the parent spawns it with `shell: false`
  // (Node raises EINVAL only under some conditions, and `.cmd` generally runs), so allowing
  // the file would hand a peer an arbitrary script — exactly the shell the policy bans.
  if (/\.(bat|cmd|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|msi|scr|com|pif)$/i.test(normalized)) {
    throw new DeniedError(
      "SCRIPT_NOT_ALLOWED",
      `script and installer files are not runnable on behalf of a peer (refused: ${path.basename(normalized)}); invoke an executable program instead`,
    );
  }

  const allow = policy.exec.allowCommands;
  if (allow.length > 0) {
    const allowed = allow.some((entry) => entry.toLowerCase() === base || entry.toLowerCase() === normalized);
    if (!allowed) {
      throw new DeniedError(
        "COMMAND_NOT_ALLOWED",
        `command "${base}" is not in permissions.exec.allowCommands (${allow.join(", ")})`,
      );
    }
  }
  const denied = deniedPattern([base, ...args].join(" "), policy.exec.denyPatterns);
  if (denied !== undefined) {
    throw new DeniedError("COMMAND_DENIED", `command matches denied pattern "${denied}"`);
  }
  // Shells and interpreters are refused explicitly: accepting `bash -c ...` would hand the
  // peer an unreviewed script and bypass every argument-level check above.
  const shells = new Set(["sh", "bash", "zsh", "dash", "ksh", "cmd", "powershell", "pwsh", "python", "python3", "node", "perl", "ruby"]);
  if (shells.has(base)) {
    throw new DeniedError(
      "SHELL_NOT_ALLOWED",
      `interpreters and shells are not runnable on behalf of a peer (refused: ${base}); invoke the program directly`,
    );
  }
}

export interface ExecOptions {
  command: string;
  cwd: string;
  timeoutMs: number;
  maxOutputBytes: number;
  signal?: AbortSignal;
  env?: Record<string, string>;
}

/**
 * Run one command and collect bounded output.
 *
 * The child inherits a scrubbed environment (no DSH_* facts, no credential-shaped
 * names) so a remote caller cannot read this device's secrets out of `env`.
 */
export function execCommand(options: ExecOptions): Promise<ExecResult> {
  const { program, args } = splitCommand(options.command);
  return new Promise((resolve, reject) => {
    const started = Date.now();
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let settled = false;
    const env = scrubbedEnv(options.env);
    let child;
    try {
      child = spawn(program, args, {
        cwd: options.cwd,
        env,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      reject(error);
      return;
    }
    const kill = () => {
      try {
        child.kill(process.platform === "win32" ? undefined : "SIGTERM");
        if (process.platform === "win32") child.kill();
      } catch {
        /* ignore */
      }
    };
    const timer = setTimeout(() => {
      truncated = true;
      kill();
    }, options.timeoutMs);
    timer.unref?.();
    const onAbort = () => {
      kill();
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const onOut = (chunk: Buffer) => {
      if (Buffer.byteLength(stdout) >= options.maxOutputBytes) {
        truncated = true;
        return;
      }
      stdout += chunk.toString("utf8");
    };
    const onErr = (chunk: Buffer) => {
      if (Buffer.byteLength(stderr) >= options.maxOutputBytes) {
        truncated = true;
        return;
      }
      stderr += chunk.toString("utf8");
    };
    child.stdout?.on("data", onOut);
    child.stderr?.on("data", onErr);
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.on("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if (Buffer.byteLength(stdout) > options.maxOutputBytes) {
        stdout = stdout.slice(0, options.maxOutputBytes);
        truncated = true;
      }
      if (Buffer.byteLength(stderr) > options.maxOutputBytes) {
        stderr = stderr.slice(0, options.maxOutputBytes);
        truncated = true;
      }
      resolve({
        command: options.command,
        cwd: options.cwd,
        exitCode,
        signal,
        stdout,
        stderr,
        durationMs: Date.now() - started,
        truncated,
      });
    });
  });
}

/** The environment a remote-requested child process starts from. */
export function scrubbedEnv(overrides: Record<string, string> | undefined): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = {};
  const keep = ["PATH", "HOME", "USERPROFILE", "SystemRoot", "windir", "TEMP", "TMP", "LANG", "LC_ALL", "ComSpec", "PATHEXT"];
  for (const key of keep) {
    const value = process.env[key];
    if (value !== undefined) base[key] = value;
  }
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (!isCredentialShaped(key)) base[key] = value;
  }
  // Caller-supplied overrides go through the same filter. A peer may pick build flags, but
  // it may not hand this device's child process a credential-shaped variable — that would
  // let a remote request route secrets into a process it also controls.
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (isCredentialShaped(key)) continue;
    base[key] = value;
  }
  return base;
}

/**
 * Whether a variable name looks like a secret or a deployment fact.
 *
 * Deliberately conservative: a false positive costs a child process one environment
 * variable, a false negative leaks a credential into a process a remote peer asked for.
 */
export function isCredentialShaped(key: string): boolean {
  if (key.startsWith("DSH_")) return true;
  if (/^(AWS|AZURE|GCP|GOOGLE|OPENAI|ANTHROPIC|DEEPSEEK|HUGGING|HF|GH|GITHUB|NPM|DOCKER|DATABASE|DB|REDIS|MYSQL|PG|POSTGRES|SMTP|MAIL|SLACK|DISCORD|TELEGRAM|QQ|WECHAT|STRIPE|TWILIO|SENDGRID|SENTRY|S3|OBS|OK)_/i.test(key)) return true;
  if (/^(API|ACCESS|SECRET|PRIVATE|PUBLIC)_?KEY/i.test(key)) return true;
  if (/^(TOKEN|PASSWORD|PASSWD|CREDENTIAL|COOKIE|SESSION_SECRET|AUTH)/i.test(key)) return true;
  return false;
}

/** Read the tail of a log file and return the bytes after `offset`. */
export function readLogPage(absolute: string, offset: number, maxLines: number, maxBytes: number): LogPage {
  const stat = fs.statSync(absolute);
  const size = stat.size;
  const start = Math.max(0, Math.min(offset, size));
  const length = Math.max(0, size - start);
  const sliceBytes = Math.min(length, maxBytes * 4);
  const fd = fs.openSync(absolute, "r");
  try {
    const buffer = Buffer.alloc(sliceBytes);
    fs.readSync(fd, buffer, 0, sliceBytes, start);
    let text = buffer.toString("utf8");
    // If the read stopped mid-file, drop a possibly split trailing line.
    const completeUntil = start + sliceBytes < size ? Math.max(0, text.lastIndexOf("\n")) : text.length;
    text = text.slice(0, completeUntil);
    const lines = text.split(/\r?\n/).filter((line, index, array) => !(index === array.length - 1 && line === ""));
    const clipped: string[] = [];
    let bytes = 0;
    let nextOffset = start + Buffer.byteLength(text, "utf8");
    for (const line of lines.slice(0, maxLines)) {
      const lineBytes = Buffer.byteLength(line, "utf8") + 1;
      if (bytes + lineBytes > maxBytes) {
        nextOffset -= Buffer.byteLength(clipped.slice(clipped.length).join("\n"), "utf8");
        break;
      }
      bytes += lineBytes;
      clipped.push(line.length > MAX_LINE_BYTES ? `${line.slice(0, MAX_LINE_BYTES)}…` : line);
    }
    if (clipped.length < lines.length && clipped.length === 0) {
      nextOffset = start;
    }
    return {
      path: absolute,
      offset: start,
      nextOffset: Math.min(nextOffset, size),
      eof: nextOffset >= size,
      lines: clipped,
      size,
    };
  } finally {
    fs.closeSync(fd);
  }
}

export interface FileChunk {
  path: string;
  offset: number;
  bytes: number;
  /** Base64 of the chunk. */
  data: string;
  version: string;
  size: number;
}

/** Read one chunk of a file for transfer, with the whole-file version for verification. */
export function readChunk(absolute: string, offset: number, length: number): FileChunk {
  const stat = fs.statSync(absolute);
  if (!stat.isFile()) throw new DeniedError("NOT_A_FILE", `"${absolute}" is not a regular file`);
  const size = stat.size;
  const start = Math.max(0, Math.min(offset, size));
  const take = Math.max(0, Math.min(length, size - start));
  const fd = fs.openSync(absolute, "r");
  try {
    const buffer = Buffer.alloc(take);
    fs.readSync(fd, buffer, 0, take, start);
    return {
      path: absolute,
      offset: start,
      bytes: take,
      data: buffer.toString("base64"),
      version: sha256Hex(fs.readFileSync(absolute)),
      size,
    };
  } finally {
    fs.closeSync(fd);
  }
}

/** Write one chunk of an inbound transfer into a staging file. */
export function appendChunk(stagingPath: string, chunkBase64: string, expectedOffset: number, signal?: AbortSignal): { size: number } {
  if (signal?.aborted) throw new DeniedError("CANCELLED", "transfer was cancelled");
  const existing = fs.existsSync(stagingPath) ? fs.statSync(stagingPath).size : 0;
  if (expectedOffset !== existing) {
    throw new DeniedError(
      "OFFSET_CONFLICT",
      `chunk offset ${expectedOffset} does not match the staged size ${existing}`,
    );
  }
  const data = Buffer.from(chunkBase64, "base64");
  fs.appendFileSync(stagingPath, data);
  return { size: existing + data.length };
}

/** Move a verified staging file into its final location, version-checked. */
async function finalizeTransfer(stagingPath: string, target: string, expectedSha: string): Promise<{ version: string; bytes: number }> {
  const actual = hashOfFile(stagingPath);
  if (expectedSha !== "" && !digestEquals(expectedSha, actual)) {
    await fsp.rm(stagingPath, { force: true });
    throw new DeniedError(
      "CHECKSUM_MISMATCH",
      `staged file hash ${actual} does not match the transfer checksum ${expectedSha}`,
    );
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.renameSync(stagingPath, target);
  return { version: actual, bytes: fs.statSync(target).size };
}

export { finalizeTransfer };

/** Default staging directory inside the plugin state dir. */
export function stagingFile(stateDir: string, transferId: string): string {
  return path.join(stateDir, "transfers", `${transferId}.part`);
}

/** Human-readable platform summary advertised in capabilities. */
export function platformFacts(): {
  platform: string;
  arch: string;
  release: string;
  node: string;
  home: string;
  cwd: string;
  pathSeparator: string;
  shell: string | undefined;
} {
  return {
    platform: process.platform,
    arch: process.arch,
    release: os.release(),
    node: process.version,
    home: os.homedir(),
    cwd: process.cwd(),
    pathSeparator: path.sep,
    shell: process.env.ComSpec ?? process.env.SHELL,
  };
}
