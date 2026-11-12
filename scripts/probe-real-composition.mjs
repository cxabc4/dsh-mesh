#!/usr/bin/env node
// Real-composition probe: boot a minimal DSH profile that contains dsh-mesh and prove the
// plugin actually activates inside the real Loader.
//
// Why this is separate from the tests: the tests mount the plugin into a Cordis context
// built by the test, which proves the plugin's contracts but not that a *profile composed
// by DSH's own Loader* accepts this bundle (manifest, patch path, row id, journal). That is
// a different failure class — a malformed `cordis.patch.yml` is silently skipped with a
// warning and the plugin never loads — so it gets its own probe.
//
// The probe builds an isolated `$DSH_HOME`, copies the base + web bundles, links this
// package in, runs `dsh --profile <name> --dump-config`, and asserts the row is present.
// Then it boots the profile on a free port and asserts the mesh listener is listening.
//
// Usage:
//   node scripts/probe-real-composition.mjs
//   MESH_PROBE_KEEP=1 node scripts/probe-real-composition.mjs   # leave the home behind
//
// Requirements: a DSH desktop installation (set DSH_CLI to dsh.cmd) and this package built.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
// The dsh launcher path differs per installation (Desktop ships it as a .cmd next to the
// packaged app; a plain install has it on PATH). Requiring DSH_CLI keeps this probe honest
// instead of guessing a path that will not exist on another machine.
const dshCli = process.env.DSH_CLI ?? "";
const dshHome = process.env.DSH_HOME_REAL ?? path.join(os.homedir(), ".dsh");

if (dshCli === "") {
  console.error("probe: set DSH_CLI to the DSH launcher, e.g. DSH_CLI=<install>/resources/runtime/cli/bin/dsh.cmd");
  process.exit(2);
}
if (!fs.existsSync(dshCli)) {
  console.error(`probe: DSH_CLI does not exist at ${dshCli}`);
  process.exit(2);
}
if (!fs.existsSync(path.join(root, "lib", "index.js"))) {
  console.error("probe: build first: node scripts/build.mjs");
  process.exit(2);
}

/** Ask the OS for a free TCP port. */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

/** Whether nothing is currently bound to 127.0.0.1:port. */
function isPortFree(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(true));
    setTimeout(() => {
      socket.destroy();
      resolve(true);
    }, 800).unref?.();
  });
}

function writeProfile(dir, bundleNames, port) {
  fs.mkdirSync(path.join(dir, "node_modules"), { recursive: true });
  fs.writeFileSync(path.join(dir, "cordis.yml"), "# probe profile: empty entry list, composed from patches\n[]\n");
  fs.writeFileSync(path.join(dir, "cordis.patch.yml"), "# probe profile: no user patch layer\n[]\n");
  fs.writeFileSync(
    path.join(dir, "pnpm-workspace.yaml"),
    "packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n",
  );
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify(
      {
        name: `dsh-profile-${path.basename(dir)}`,
        private: true,
        dsh: { profile: { bundles: bundleNames } },
      },
      null,
      2,
    ),
  );
  // The mesh listener port is fixed by the plugin's own patch; this helper only records it
  // so the probe knows which port to watch.
  fs.writeFileSync(path.join(dir, "probe-port.txt"), `${port}\n`);
}

/** Link this package into a profile's node_modules the way `pnpm add <dir>` does. */
function linkPackage(profileDir) {
  const target = path.join(profileDir, "node_modules", "dsh-mesh");
  if (fs.existsSync(target)) return;
  try {
    fs.symlinkSync(root, target, "junction");
  } catch (error) {
    console.error(`probe: could not link the package (${error.message}); falling back to copying lib/`);
    fs.mkdirSync(path.join(target, "lib"), { recursive: true });
    fs.copyFileSync(path.join(root, "package.json"), path.join(target, "package.json"));
    fs.copyFileSync(path.join(root, "cordis.patch.yml"), path.join(target, "cordis.patch.yml"));
    for (const entry of fs.readdirSync(path.join(root, "lib"), { recursive: true })) {
      const source = path.join(root, "lib", entry);
      const destination = path.join(target, "lib", entry);
      if (fs.statSync(source).isDirectory()) continue;
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(source, destination);
    }
  }
}

/**
 * Run one command and collect its output.
 *
 * A `.cmd` launcher cannot be spawned directly on Windows (Node raises EINVAL for a batch
 * file when `shell` is false), so it is routed through cmd.exe. The argv is still fixed and
 * fully controlled — no user input reaches the command line.
 */
function run(command, args, options = {}) {
  const isBatch = process.platform === "win32" && /\.(cmd|bat)$/i.test(command);
  const spawnCommand = isBatch ? process.env.ComSpec ?? "cmd.exe" : command;
  const spawnArgs = isBatch ? ["/d", "/s", "/c", command, ...args] : args;
  return new Promise((resolve) => {
    const child = spawn(spawnCommand, spawnArgs, { ...options, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      output += chunk.toString("utf8");
    });
    child.on("close", (code) => resolve({ code: code ?? 1, output }));
    child.on("error", (error) => resolve({ code: 1, output: `${output}\nspawn error: ${error.message}` }));
  });
}

/** Spawn a long-running command; the caller owns its lifetime. */
function start(command, args, options = {}) {
  const isBatch = process.platform === "win32" && /\.(cmd|bat)$/i.test(command);
  const spawnCommand = isBatch ? process.env.ComSpec ?? "cmd.exe" : command;
  const spawnArgs = isBatch ? ["/d", "/s", "/c", command, ...args] : args;
  return spawn(spawnCommand, spawnArgs, { ...options, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-mesh-compose-"));
console.log(`probe: isolated DSH_HOME = ${home}`);

// Copy the profile scaffolding from the real home so the bundles resolve; the profile itself
// is fresh, so nothing from the operator's configuration leaks into this check.
const bundles = ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-mesh"];
const profileName = "meshcompose";
const profileDir = path.join(home, "profiles", profileName);
writeProfile(profileDir, bundles, 8765);
linkPackage(profileDir);

const env = { ...process.env, DSH_HOME: home };
const dumped = await run(dshCli, ["--profile", profileName, "--dump-config"], { env });
const hasRow = /- id: dsh-mesh/.test(dumped.output);
console.log(JSON.stringify({ step: "dump-config", exit: dumped.code, hasRow }));
if (!hasRow) {
  console.error("probe: the Loader did NOT compose the dsh-mesh row. Output tail:");
  console.error(dumped.output.split("\n").slice(-30).join("\n"));
  process.exit(1);
}

// Boot the profile on a free port. The web app needs a model credential to start an agent,
// but not to boot, so this is expected to reach "listening" and then sit idle.
//
// The mesh listener port is fixed by the plugin's own patch (8765). If something else on
// this machine already holds it, the probe would report a false negative, so the occupancy
// is checked first and reported rather than silently mis-measured.
const meshPortFree = await isPortFree(8765);
console.log(JSON.stringify({ step: "preflight", meshPortFree }));
if (!meshPortFree) {
  console.error(
    "probe: 127.0.0.1:8765 is already in use; stop the other instance (or change the plugin port) before re-running",
  );
  process.exit(1);
}

const port = await freePort();
const booted = start(dshCli, ["--profile", profileName, "--port", String(port)], { env });
let bootOutput = "";
booted.stdout.on("data", (chunk) => {
  bootOutput += chunk.toString("utf8");
});
booted.stderr.on("data", (chunk) => {
  bootOutput += chunk.toString("utf8");
});

const deadline = Date.now() + 25_000;
let meshListening = false;
while (Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 500));
  const probe = await new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port: 8765 });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
    setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, 800).unref?.();
  });
  if (probe) {
    meshListening = true;
    break;
  }
  if (booted.exitCode !== null) break;
}

console.log(JSON.stringify({ step: "boot", meshListening, exit: booted.exitCode, logs: bootOutput.split("\n").filter((line) => line.includes("dsh-mesh") || line.includes("listening")).slice(0, 6) }));

// Stop the booted app. A `.cmd` launcher runs through cmd.exe, so killing only that pid
// leaves the real process behind; `taskkill /T` takes the whole tree, which is what makes
// this probe safe to run repeatedly.
await stopTree(booted.pid);
await new Promise((resolve) => setTimeout(resolve, 1_000));
if (booted.exitCode === null) {
  try {
    booted.kill("SIGKILL");
  } catch {
    /* already gone */
  }
}

if (process.env.MESH_PROBE_KEEP !== "1") {
  fs.rmSync(home, { recursive: true, force: true });
}
if (!meshListening) {
  console.error("probe: the plugin did not open its listener inside a real composition");
  process.exit(1);
}
console.log("probe: dsh-mesh activates and listens in a real DSH composition");
process.exit(0);

/** Stop one process and every child it started. */
async function stopTree(pid) {
  if (pid === undefined) return;
  if (process.platform !== "win32") {
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        /* already gone */
      }
    }
    return;
  }
  await run(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"), ["/PID", String(pid), "/T", "/F"]);
}
