// Configuration surface and normalisation.
//
// The plugin's Loader row supplies `config`. Nothing below trusts the shape of that
// object: every field is validated, clamped, and defaulted here so a stale or partial
// config cannot crash the Host at load time.

export interface TlsConfig {
  enabled: boolean;
  certPath: string | undefined;
  keyPath: string | undefined;
  /** Pinned SHA-256 of the peer certificate, lowercase hex without separators. */
  fingerprintSha256: string | undefined;
}

export interface ServerConfig {
  enabled: boolean;
  host: string;
  port: number;
  tls: TlsConfig;
}

export interface PeerConfig {
  /** Local alias used by the mesh_* tools, e.g. "phone". */
  alias: string;
  /** ws:// or wss:// address this peer is reachable at (empty for inbound-only peers). */
  url: string;
  autoConnect: boolean;
}

export interface ExecPolicyConfig {
  allowCommands: string[];
  denyPatterns: string[];
  defaultTimeoutMs: number;
  maxTimeoutMs: number;
  maxOutputBytes: number;
}

export interface PermissionsConfig {
  allowedRoots: string[];
  allowWrite: boolean;
  allowExec: boolean;
  allowDelegate: boolean;
  maxTaskMs: number;
  maxConcurrentTasks: number;
  exec: ExecPolicyConfig;
}

export interface DeviceConfig {
  name: string;
  stateDir: string | undefined;
}

export interface MeshConfig {
  device: DeviceConfig;
  server: ServerConfig;
  peers: PeerConfig[];
  permissions: PermissionsConfig;
  /** Depth budget for cross-device delegation. 1 = a delegated task may not delegate again. */
  maxDelegationDepth: number;
  replayWindowMs: number;
  heartbeatIntervalMs: number;
  requestTimeoutMs: number;
  reconnect: { minDelayMs: number; maxDelayMs: number; factor: number };
  audit: { enabled: boolean; maxEntries: number };
}

const DEFAULT_DENY_PATTERNS = [
  "rm -rf /",
  "rm -rf ~",
  "mkfs",
  "dd if=",
  "del /s /q c:\\",
  "rd /s /q c:\\",
  "format c:",
  "shutdown",
  "reboot",
  "poweroff",
  "halt",
  "chmod 777 /",
];

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

function flag(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function numberIn(value: unknown, fallback: number, min: number, max: number): number {
  const candidate = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, candidate));
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function strings(value: unknown): string[] {
  return list(value)
    .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    .map((entry) => entry.trim());
}

/** Normalise the Loader row config into a fully-defaulted MeshConfig. */
export function resolveConfig(raw: unknown): MeshConfig {
  const input = record(raw);
  const device = record(input["device"]);
  const server = record(input["server"]);
  const tls = record(server["tls"]);
  const permissions = record(input["permissions"]);
  const exec = record(permissions["exec"]);
  const reconnect = record(input["reconnect"]);
  const audit = record(input["audit"]);

  const peers: PeerConfig[] = [];
  for (const candidate of list(input["peers"])) {
    const peer = record(candidate);
    const alias = text(peer["alias"], "");
    const url = text(peer["url"], "");
    // A peer with neither an alias nor a URL cannot be used or addressed; it is dropped
    // rather than kept as a confusing ghost entry.
    if (alias === "" && url === "") continue;
    peers.push({ alias: alias === "" ? url : alias, url, autoConnect: flag(peer["autoConnect"], true) });
  }

  const denyPatterns = strings(exec["denyPatterns"]);

  return {
    device: {
      name: text(device["name"], ""),
      stateDir: typeof device["stateDir"] === "string" && device["stateDir"].trim() !== "" ? device["stateDir"].trim() : undefined,
    },
    server: {
      enabled: flag(server["enabled"], true),
      host: text(server["host"], "127.0.0.1"),
      // Port 0 is legal and asks the OS for a free port; the test suite and any
      // "just try it" deployment rely on it. Anything above 65535 is clamped.
      port: numberIn(server["port"], 8765, 0, 65535),
      tls: {
        enabled: flag(tls["enabled"], false),
        certPath: text(tls["certPath"], "") || undefined,
        keyPath: text(tls["keyPath"], "") || undefined,
        fingerprintSha256: text(tls["fingerprintSha256"], "").replace(/[^0-9a-fA-F]/g, "").toLowerCase() || undefined,
      },
    },
    peers,
    permissions: {
      allowedRoots: strings(permissions["allowedRoots"]),
      allowWrite: flag(permissions["allowWrite"], true),
      allowExec: flag(permissions["allowExec"], true),
      allowDelegate: flag(permissions["allowDelegate"], true),
      maxTaskMs: numberIn(permissions["maxTaskMs"], 30 * 60 * 1000, 5_000, 24 * 60 * 60 * 1000),
      maxConcurrentTasks: numberIn(permissions["maxConcurrentTasks"], 3, 1, 16),
      exec: {
        allowCommands: strings(exec["allowCommands"]),
        denyPatterns: denyPatterns.length > 0 ? denyPatterns : [...DEFAULT_DENY_PATTERNS],
        defaultTimeoutMs: numberIn(exec["defaultTimeoutMs"], 120_000, 1_000, 24 * 60 * 60 * 1000),
        maxTimeoutMs: numberIn(exec["maxTimeoutMs"], 30 * 60 * 1000, 1_000, 24 * 60 * 60 * 1000),
        maxOutputBytes: numberIn(exec["maxOutputBytes"], 256 * 1024, 4_096, 64 * 1024 * 1024),
      },
    },
    maxDelegationDepth: numberIn(input["maxDelegationDepth"], 1, 0, 8),
    replayWindowMs: numberIn(input["replayWindowMs"], 10 * 60 * 1000, 10_000, 24 * 60 * 60 * 1000),
    heartbeatIntervalMs: numberIn(input["heartbeatIntervalMs"], 20_000, 2_000, 300_000),
    requestTimeoutMs: numberIn(input["requestTimeoutMs"], 30_000, 1_000, 24 * 60 * 60 * 1000),
    reconnect: {
      minDelayMs: numberIn(reconnect["minDelayMs"], 1_000, 250, 60_000),
      maxDelayMs: numberIn(reconnect["maxDelayMs"], 30_000, 1_000, 600_000),
      factor: numberIn(reconnect["factor"], 2, 1.1, 8),
    },
    audit: {
      enabled: flag(audit["enabled"], true),
      maxEntries: numberIn(audit["maxEntries"], 5_000, 100, 100_000),
    },
  };
}

/** Match a command line against the deployment's deny patterns. */
export function deniedPattern(commandLine: string, denyPatterns: readonly string[]): string | undefined {
  const normalized = commandLine.toLowerCase();
  for (const pattern of denyPatterns) {
    if (pattern.length === 0) continue;
    if (normalized.includes(pattern.toLowerCase())) return pattern;
  }
  return undefined;
}
