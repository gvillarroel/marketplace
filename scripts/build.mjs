/**
 * Performs the single canonical build and mirrors the generated Copilot
 * runtime into the single Copilot plugin.
 */
import { cp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const dist = new URL("../dist/", import.meta.url);
const runtimeTargets = [
  {
    root: new URL("../plugins/agent-foundry/runtime/dist/", import.meta.url),
    adapters: [
      "shared.js",
      "copilot.js",
      "direct.js",
      "copilot-coordinator.js",
      "copilot-team-runtime.js",
      "copilot-team-view.js",
    ],
  },
];

await Promise.all([dist, ...runtimeTargets.map(({ root }) => root)]
  .map((root) => rm(root, { recursive: true, force: true })));
execFileSync(process.execPath, [fileURLToPath(new URL("../node_modules/typescript/bin/tsc", import.meta.url))], { stdio: "inherit" });

const coreSource = new URL("core/", dist);
const bundledSource = new URL("../src/core/bundled/", import.meta.url);
const bundledDist = new URL("core/bundled/", dist);
const roleSource = new URL("../src/core/roles/", import.meta.url);
const roleDist = new URL("core/roles/", dist);
const adapterSource = new URL("adapters/", dist);
const coreFiles = (await readdir(coreSource)).filter((name) => name.endsWith(".js"));
await Promise.all([
  cp(bundledSource, bundledDist, { recursive: true }),
  cp(roleSource, roleDist, { recursive: true }),
]);

async function copyRuntime({ root, adapters }) {
  const coreTarget = new URL("core/", root);
  const adapterTarget = new URL("adapters/", root);
  const bundledTarget = new URL("bundled/", coreTarget);
  const roleTarget = new URL("roles/", coreTarget);
  await Promise.all([
    mkdir(coreTarget, { recursive: true }),
    mkdir(adapterTarget, { recursive: true }),
    mkdir(bundledTarget, { recursive: true }),
    mkdir(roleTarget, { recursive: true }),
  ]);
  await Promise.all([
    ...coreFiles.map((name) => cp(new URL(name, coreSource), new URL(name, coreTarget))),
    cp(bundledSource, bundledTarget, { recursive: true }),
    cp(roleSource, roleTarget, { recursive: true }),
    ...adapters.map((name) => cp(new URL(name, adapterSource), new URL(name, adapterTarget))),
  ]);
}

await Promise.all(runtimeTargets.map(copyRuntime));

// Hand-tuned roles retain their plugin assets. Every other Markdown role gets
// a deterministic least-privilege Copilot asset so adding a file to
// src/core/roles is sufficient after rebuilding.
const generatedAgentRoot = new URL("../plugins/agent-foundry/agents/", import.meta.url);
const generatedSuffix = ".generated.agent.md";
const existing = await readdir(generatedAgentRoot);
await Promise.all(existing.filter((name) => name.endsWith(generatedSuffix))
  .map((name) => rm(new URL(name, generatedAgentRoot), { force: true })));
const { rolePlayers } = await import(new URL("core/defaults.js", dist));
const { harborPlayerSkillToolName } = await import(new URL("core/custom-tools.js", dist));
const { composePlayerInstructions, nativeTools } = await import(new URL("core/profiles.js", dist));
const specialized = new Set(["team-lead", "crafter"]);
for (const [id, player] of rolePlayers) {
  if (specialized.has(id)) continue;
  const tools = [...nativeTools("copilot", player.tools), ...(player.skills?.length ? [harborPlayerSkillToolName(player)] : [])];
  const frontmatter = [
    "---",
    `name: ${JSON.stringify(id)}`,
    `description: ${JSON.stringify(player.description)}`,
    `tools: ${JSON.stringify(tools)}`,
    ...(player.model ? [`model: ${JSON.stringify(player.model)}`] : []),
    "disable-model-invocation: false",
    "user-invocable: true",
    "---",
    "",
    composePlayerInstructions(player, "copilot"),
    "",
  ].join("\n");
  await writeFile(new URL(`${id}${generatedSuffix}`, generatedAgentRoot), frontmatter, "utf8");
}
