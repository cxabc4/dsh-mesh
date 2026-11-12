#!/usr/bin/env node
// Developer tool: fetch upstream repository facts for dsh-mesh research.
//
// This exists so the research subagents stop hand-rolling GitHub API calls (that is
// what failed in earlier attempts). It fetches a repository tree and writes a
// per-repository listing into docs/research, which then becomes greppable evidence.
//
// Usage:
//   node scripts/fetch-upstream.mjs tree <owner/repo> [ref]      -> docs/research/_trees/<owner>_<repo>.json
//   node scripts/fetch-upstream.mjs file <owner/repo> <path> [ref]-> stdout
//   node scripts/fetch-upstream.mjs list <owner/repo> [substr] [ref] -> matching paths
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const treesDir = path.join(root, "docs", "research", "_trees");

const [, , command, repo, ...rest] = process.argv;
if (command === undefined || repo === undefined) {
  console.error("usage: node scripts/fetch-upstream.mjs tree|file|list <owner/repo> ...");
  process.exit(2);
}

const headers = {
  accept: "application/vnd.github+json",
  "user-agent": "dsh-mesh-research",
};
if (process.env.GITHUB_TOKEN !== undefined) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

async function getTree(ownerRepo, ref) {
  const encoded = ownerRepo.replace("/", "_");
  const cache = path.join(treesDir, `${encoded}@${ref ?? "HEAD"}.json`);
  if (fs.existsSync(cache)) {
    const parsed = JSON.parse(fs.readFileSync(cache, "utf8"));
    if (Array.isArray(parsed.tree)) return parsed;
  }
  const url = `https://api.github.com/repos/${ownerRepo}/git/trees/${ref ?? "HEAD"}?recursive=1`;
  const response = await fetch(url, { headers });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub API ${response.status} for ${url}: ${body.slice(0, 300)}`);
  }
  const parsed = await response.json();
  fs.mkdirSync(treesDir, { recursive: true });
  fs.writeFileSync(cache, JSON.stringify(parsed));
  return parsed;
}

async function getFile(ownerRepo, filePath, ref) {
  const url = `https://raw.githubusercontent.com/${ownerRepo}/${ref ?? "HEAD"}/${filePath}`;
  const response = await fetch(url, { headers: { "user-agent": "dsh-mesh-research" } });
  if (!response.ok) throw new Error(`raw fetch ${response.status} for ${url}`);
  return response.text();
}

try {
  if (command === "tree") {
    const ref = rest[0];
    const tree = await getTree(repo, ref);
    const files = tree.tree.filter((entry) => entry.type === "blob");
    console.log(JSON.stringify({ repo, ref: ref ?? "HEAD", truncated: tree.truncated === true, files: files.length }));
    for (const entry of files.slice(0, 40)) console.log(entry.path);
    if (files.length > 40) console.log(`... ${files.length - 40} more (use "list")`);
  } else if (command === "file") {
    const [filePath, ref] = rest;
    if (filePath === undefined) throw new Error("file path required");
    process.stdout.write(await getFile(repo, filePath, ref));
  } else if (command === "list") {
    const [substr, ref] = rest;
    const tree = await getTree(repo, ref);
    const needle = substr === undefined ? "" : substr;
    const matches = tree.tree
      .filter((entry) => entry.type === "blob" && entry.path.includes(needle))
      .map((entry) => entry.path);
    console.log(matches.slice(0, 400).join("\n"));
    console.log(`# ${matches.length} match(es) for "${needle}" in ${repo}`);
  } else {
    throw new Error(`unknown command: ${command}`);
  }
} catch (error) {
  console.error(`fetch-upstream: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
