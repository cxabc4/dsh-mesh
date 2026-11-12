#!/usr/bin/env node
// Build dsh-mesh with Node's own TypeScript support.
//
// The plugin has to be installable into a DSH profile whose node_modules contains
// nothing but the bundles that profile declared, so it cannot depend on tsc, esbuild,
// or any @deepseek-ai package at runtime. Node 22.18+ can strip TypeScript types
// natively, and `module.stripTypeScriptTypes` exposes the same transform to a build
// script. That gives a real .ts -> .js compile step with zero dependencies.
//
// Only erasable syntax is allowed (node's "strip" mode): no enums, no namespaces,
// no parameter properties, no `declare` fields. The build fails loudly if a source
// file uses syntax the stripper rejects rather than shipping something untested.
//
// Usage:
//   node scripts/build.mjs           # compile src/**/*.ts -> lib/**/*.js
//   node scripts/build.mjs --check   # compile and verify lib/ is up to date
import fs from "node:fs";
import path from "node:path";
import { stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const srcDir = path.join(root, "src");
const libDir = path.join(root, "lib");
const checkOnly = process.argv.includes("--check");

/** Collect every .ts file under `dir`, in stable order. */
function collect(dir) {
  const out = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith(".ts")) out.push(full);
    }
  };
  walk(dir);
  return out.sort();
}

/**
 * Rewrite relative specifiers from `.ts` to `.js`, and scrub the absolute build-machine
 * path out of the `//# sourceURL` comment the type stripper appends.
 *
 * `sourceUrl` makes Node's stripper emit `//# sourceURL=<absolute path>` so a local stack
 * trace points at the original file. That is useful while developing and wrong to publish:
 * it would put the author's absolute path (and, on another machine, a different one) into
 * every shipped file. The rewrite makes it repo-relative instead.
 */
function rewriteSpecifiers(code) {
  return code
    .replace(/(from\s+"[^"]*)\.ts"/g, '$1.js"')
    .replace(/(import\s+"[^"]*)\.ts"/g, '$1.js"')
    .replace(/(from\s+'[^']*)\.ts'/g, "$1.js'")
    .replace(/(import\s+'[^']*)\.ts'/g, "$1.js'")
    .replace(/\/\/# sourceURL=src\//g, "//# sourceURL=src/");
}

const files = collect(srcDir);
const outputs = [];
for (const file of files) {
  const relative = path.relative(srcDir, file);
  const source = fs.readFileSync(file, "utf8");
  let code;
  try {
    // `sourceUrl` takes a repo-relative path, not the absolute one: the stripper appends it
    // verbatim as a `//# sourceURL` comment, and that comment ships inside lib/*.js.
    code = stripTypeScriptTypes(source, { mode: "strip", sourceUrl: `src/${relative.replace(/\\/g, "/")}` });
  } catch (error) {
    console.error(`build: cannot strip types from ${relative}: ${error.message}`);
    process.exit(1);
  }
  code = rewriteSpecifiers(code);
  outputs.push({ relative: relative.replace(/\.ts$/, ".js"), code, source });
}

let written = 0;
let stale = 0;
fs.mkdirSync(libDir, { recursive: true });
for (const output of outputs) {
  const target = path.join(libDir, output.relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const head = `// Generated from src/${output.relative.replace(/\.js$/, ".ts")} by scripts/build.mjs. Do not edit.\n`;
  const next = head + output.code;
  const previous = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : undefined;
  if (previous === next) continue;
  if (checkOnly) {
    stale += 1;
    console.error(`build --check: stale ${path.relative(root, target)}`);
    continue;
  }
  fs.writeFileSync(target, next);
  written += 1;
}

if (checkOnly) {
  if (stale > 0) process.exit(1);
  console.log(JSON.stringify({ mode: "check", files: outputs.length, stale: 0 }));
} else {
  console.log(JSON.stringify({ mode: "build", files: outputs.length, written }));
}
