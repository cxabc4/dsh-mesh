#!/usr/bin/env node
// Small documentation editor: apply literal text replacements to a UTF-8 file.
//
// Used during development to keep the guides in sync with the code. It exists as a script
// (rather than a shell one-liner) because the docs contain backticks, quotes, and CJK text
// that PowerShell 5.1 mangles on the command line.
//
// Usage:
//   node scripts/doc-replace.mjs <file> <oldPath> <newPath>
import fs from "node:fs";

const [, , fileArg, oldArg, newArg] = process.argv;
if (!fileArg || !oldArg || !newArg) {
  console.error("usage: node scripts/doc-replace.mjs <file> <old-text-file> <new-text-file>");
  process.exit(2);
}

const file = fs.readFileSync(fileArg, "utf8");
const oldText = fs.readFileSync(oldArg, "utf8");
const newText = fs.readFileSync(newArg, "utf8");
if (!file.includes(oldText)) {
  console.error("doc-replace: the old text was not found; nothing changed");
  process.exit(1);
}
fs.writeFileSync(fileArg, file.replace(oldText, newText), "utf8");
console.log(JSON.stringify({ file: fileArg, replaced: true }));
