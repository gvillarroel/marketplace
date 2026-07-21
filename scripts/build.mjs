/**
 * Performs the single canonical build and mirrors the generated Copilot
 * runtime into both plugins. Each plugin needs its own physical copy because
 * Copilot resolves `${PLUGIN_ROOT}` relative to the selected plugin.
 */
import { cp, mkdir, readdir, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const dist = new URL("../dist/", import.meta.url);
const runtimeTargets = [
  {
    root: new URL("../plugins/agent-foundry/runtime/dist/", import.meta.url),
    adapters: ["shared.js", "copilot.js", "copilot-mcp.js", "direct.js", "copilot-coordinator.js"],
  },
  {
    root: new URL("../plugins/repo-cartographer/runtime/dist/", import.meta.url),
    adapters: ["shared.js", "copilot.js", "copilot-mcp.js"],
  },
];

await Promise.all([dist, ...runtimeTargets.map(({ root }) => root)]
  .map((root) => rm(root, { recursive: true, force: true })));
execFileSync(process.execPath, [fileURLToPath(new URL("../node_modules/typescript/bin/tsc", import.meta.url))], { stdio: "inherit" });

const coreSource = new URL("core/", dist);
const adapterSource = new URL("adapters/", dist);
const coreFiles = (await readdir(coreSource)).filter((name) => name.endsWith(".js"));

async function copyRuntime({ root, adapters }) {
  const coreTarget = new URL("core/", root);
  const adapterTarget = new URL("adapters/", root);
  await Promise.all([
    mkdir(coreTarget, { recursive: true }),
    mkdir(adapterTarget, { recursive: true }),
  ]);
  await Promise.all([
    ...coreFiles.map((name) => cp(new URL(name, coreSource), new URL(name, coreTarget))),
    ...adapters.map((name) => cp(new URL(name, adapterSource), new URL(name, adapterTarget))),
  ]);
}

await Promise.all(runtimeTargets.map(copyRuntime));
