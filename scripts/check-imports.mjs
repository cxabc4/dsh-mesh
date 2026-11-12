#!/usr/bin/env node
// Developer check: verify that every relative import inside src/ resolves to a real .ts
// file, and that every lib/*.js import points at a file the build actually produced.
//
// This exists because a wrong relative path (`.manager.ts` importing `./server.ts` when
// the file lives in `../transport/`) survives type stripping and only fails at runtime,
// after the plugin is already installed. Catching it here is cheaper than catching it
// inside a running DSH.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

function walk(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(full));
    else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(full);
  }
  return files;
}

const problems = [];
for (const file of walk(path.join(root, "src"))) {
  const relative = path.relative(root, file);
  const source = fs.readFileSync(file, "utf8");
  const specifiers = [...source.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]);
  for (const specifier of specifiers) {
    if (!specifier.startsWith(".")) continue;
    const target = path.resolve(path.dirname(file), specifier);
    if (!fs.existsSync(target)) {
      problems.push(`${relative}: cannot resolve "${specifier}" -> ${path.relative(root, target)}`);
      continue;
    }
    // A relative import must land inside src/, otherwise the build cannot compile it.
    if (!path.relative(root, target).startsWith("src" + path.sep)) {
      problems.push(`${relative}: "${specifier}" escapes src/ -> ${path.relative(root, target)}`);
    }
  }
}

// Cross-check: every file that produced a lib artifact must have no import pointing at a
// lib path that does not exist.
const libRoot = path.join(root, "lib");
if (fs.existsSync(libRoot)) {
  const jsFiles = [];
  const walkJs = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walkJs(full);
      else if (entry.isFile() && entry.name.endsWith(".js")) jsFiles.push(full);
    }
  };
  walkJs(libRoot);
  for (const file of jsFiles) {
    const source = fs.readFileSync(file, "utf8");
    for (const match of source.matchAll(/from\s+"([^"]+)"/g)) {
      const specifier = match[1];
      if (!specifier.startsWith(".")) continue;
      const target = path.resolve(path.dirname(file), specifier);
      if (!fs.existsSync(target)) {
        problems.push(`${path.relative(root, file)}: broken compiled import "${specifier}"`);
      }
    }
  }
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`imports: ${problem}`);
  console.error(`imports: ${problems.length} problem(s)`);
  process.exit(1);
}
console.log(JSON.stringify({ mode: "imports", problems: 0 }));
