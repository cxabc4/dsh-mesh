#!/usr/bin/env node
// Composition check: load the built plugin through a REAL Cordis context, not a stub.
//
// The smoke test uses a hand-written context object, which proves the plugin's own logic
// but not that the real framework accepts it. This script builds an actual Cordis app,
// provides stub services for the ones the plugin injects, and mounts the plugin through
// `ctx.plugin`. If Cordis refuses the plugin (inject mismatch, bad export shape, bad
// effect usage, a resource that never releases), that shows up here rather than inside a
// running DSH.
//
// It resolves @deepseek-ai/cordis from the DSH installation, so no dependency is added to
// this package. Point DSH_ROOT at the DSH runtime directory:
//
//   node scripts/probe-cordis-apply.mjs
//
// The runtime directory is inside app.asar on Desktop, which only the Host's own file reads
// can open. Extract the two packages first (scripts/asar-extract.mjs does this without any
// dependency), then run with DSH_ROOT pointing at the extracted tree.

import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
// No default install path: this machine's DSH location is not everyone's, and a probe
// that silently guesses would fail with a confusing message. DSH_ROOT points at either the
// extracted runtime tree or a plain (non-asar) installation.
const dshRoot = process.env.DSH_ROOT ?? "";
if (dshRoot === "") {
  console.error("probe: set DSH_ROOT to the DSH runtime directory (the one containing node_modules/@deepseek-ai)");
  console.error("probe: on Desktop it lives inside app.asar, so extract it first:");
  console.error("  node scripts/asar-extract.mjs <install>/resources/app.asar <outDir> \"^dsh/node_modules/@deepseek-ai/(cordis|cosmokit)/\"");
  console.error("  DSH_ROOT=<outDir>/dsh node scripts/probe-cordis-apply.mjs");
  process.exit(2);
}
const cordisEntry = path.join(dshRoot, "node_modules", "@deepseek-ai", "cordis", "lib", "index.js");
if (!fs.existsSync(cordisEntry)) {
  console.error(`probe: cordis not found at ${cordisEntry}`);
  console.error("probe: DSH_ROOT must contain node_modules/@deepseek-ai/cordis/lib/index.js");
  process.exit(2);
}

const cordisModule = await import(new URL(`file://${cordisEntry}`).href);
const ContextCtor = cordisModule.Context ?? cordisModule.default;
if (typeof ContextCtor !== "function") {
  console.error("probe: could not find a Context constructor in cordis exports:", Object.keys(cordisModule));
  process.exit(2);
}

const app = new ContextCtor({});
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-cordis-"));
const log = [];
const registeredTools = [];
const providers = [];

// Provide the services the plugin injects. Cordis skips `apply` for a missing declared
// dependency, so these stubs are the difference between "mounted" and silently "skipped".
app.provide("tools", {
  register(definition) {
    registeredTools.push(definition.name);
    return () => {};
  },
  restrict() {
    return () => {};
  },
  get() {
    return undefined;
  },
  schemas() {
    return [];
  },
});
app.provide("subagents", {
  registerProvider(provider) {
    providers.push(provider.name);
    return () => {};
  },
  getProvider() {
    return undefined;
  },
  list() {
    return [];
  },
});
app.provide("systemPrompt", {
  section(section) {
    log.push(`section:${section.name}`);
    return () => {};
  },
  context(context) {
    log.push(`context:${context.name}`);
    return () => {};
  },
});
app.provide("agentDefaultModel", { currentSelection: () => ({ provider: "stub", model: "stub" }) });
app.provide("agents", { currentInitiator: () => undefined });

const plugin = await import(new URL("../lib/index.js", import.meta.url).href);

// Mount through the real framework. Port 0 asks the operating system for a free port, so
// this cannot collide with a running DSH.
const fiber = app.plugin(plugin.default ?? plugin, {
  device: { name: "cordis-probe", stateDir },
  server: { enabled: true, host: "127.0.0.1", port: 0 },
  peers: [],
  permissions: { allowedRoots: [stateDir] },
});

try {
  await fiber;
} catch (error) {
  console.error(`probe: Cordis refused the plugin: ${error instanceof error ? error.message : String(error)}`);
  process.exit(1);
}

const report = {
  mounted: true,
  cordis: cordisModule.default?.name ?? "Context",
  tools: registeredTools.length,
  toolNames: registeredTools,
  providers,
  promptSections: log.filter((line) => line.startsWith("section:")).length,
};
console.log(JSON.stringify(report));

if (registeredTools.length < 17) {
  console.error("probe: expected at least 17 tools, got", registeredTools.length);
  process.exit(1);
}
if (providers[0] !== "mesh") {
  console.error("probe: expected the mesh subagent provider, got", providers);
  process.exit(1);
}

// Teardown through the framework, then assert the process is releasable: if the listener
// or a timer survived, this script would hang instead of exiting, which is exactly what a
// plugin that leaks resources inside the Host would do.
await fiber.dispose?.();
if (typeof fiber.dispose === "function") {
  console.log(JSON.stringify({ disposed: true }));
}
console.log("probe: done");

