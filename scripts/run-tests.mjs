#!/usr/bin/env node
// Run the whole suite the way CI would: build, verify imports, then run every test file
// with a per-file watchdog so a hang is reported instead of stalling the shell.
//
// `node --test` alone cannot do this: a test that leaves a listener open keeps the runner
// alive forever, and its output is buffered until the file finishes. Each file therefore
// runs as its own child process with a hard timeout, and a timeout is a failure.
//
// Usage:
//   node scripts/run-tests.mjs            # all files
//   node scripts/run-tests.mjs e2e        # files whose name contains "e2e"
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const testsDir = path.join(root, "tests");
const filter = process.argv[2];
const perFileTimeoutMs = Number(process.env.MESH_TEST_TIMEOUT_MS ?? 120_000);

function listTestFiles() {
  return fs
    .readdirSync(testsDir)
    .filter((name) => name.endsWith(".test.mjs"))
    .filter((name) => (filter === undefined ? true : name.includes(filter)))
    .sort();
}

/** Run one file and resolve with {name, code, timedOut, output}. */
function runFile(name) {
  return new Promise((resolve) => {
    const file = path.join(testsDir, name);
    const child = spawn(process.execPath, ["--test", file], {
      cwd: root,
      // Capture through pipes: this script is the only consumer, so the confined-sandbox
      // named-pipe restriction does not apply here (it is the harness that forbids it).
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, perFileTimeoutMs);
    child.stdout.on("data", (chunk) => {
      output += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      output += chunk.toString("utf8");
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ name, code: timedOut ? 1 : code ?? 1, timedOut, output });
    });
  });
}

const steps = [
  ["build", [path.join(here, "build.mjs")]],
  ["imports", [path.join(here, "check-imports.mjs")]],
];
for (const [label, args] of steps) {
  const result = await new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      output += chunk.toString("utf8");
    });
    child.on("close", (code) => resolve({ code: code ?? 1, output }));
  });
  process.stdout.write(result.output);
  if (result.code !== 0) {
    console.error(`run-tests: ${label} failed`);
    process.exit(1);
  }
}

const files = listTestFiles();
if (files.length === 0) {
  console.error("run-tests: no test files matched");
  process.exit(1);
}

let failures = 0;
let passed = 0;
for (const name of files) {
  const result = await runFile(name);
  const summary = summarize(result.output);
  if (result.code === 0 && !result.timedOut) {
    passed += 1;
    console.log(`PASS ${name}  ${summary}`);
  } else {
    failures += 1;
    console.log(`FAIL ${name}  ${result.timedOut ? `timed out after ${perFileTimeoutMs}ms` : summary}`);
    process.stdout.write(result.output);
  }
}

console.log(`\nrun-tests: ${passed} file(s) passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);

/** Pull the pass/fail counts out of node --test's summary lines for the one-line report. */
function summarize(output) {
  // node --test prints a counted summary (not TAP) by default: `ℹ tests 4` / `ℹ pass 4`.
  // Both glyph spellings are matched so a locale-escaped console does not hide the numbers.
  const number = (label) => {
    const match = output.match(new RegExp(`(?:^|\\n)\\s*[ℹ#]\\s*${label}\\s+(\\d+)`));
    return match?.[1];
  };
  const tests = number("tests") ?? "?";
  const pass = number("pass") ?? "?";
  const fail = number("fail") ?? "?";
  return `tests=${tests} pass=${pass} fail=${fail}`;
}
