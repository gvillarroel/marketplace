import { cp, mkdir, readdir, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const dist = new URL("../dist/", import.meta.url);
const target = new URL("../plugins/agent-foundry/runtime/dist/", import.meta.url);
await Promise.all([rm(dist, { recursive: true, force: true }), rm(target, { recursive: true, force: true })]);
execFileSync(process.execPath, [fileURLToPath(new URL("../node_modules/typescript/bin/tsc", import.meta.url))], { stdio: "inherit" });
await mkdir(target, { recursive: true });
await mkdir(new URL("core/", target), { recursive: true });
for (const name of await readdir(new URL("../dist/core/", import.meta.url))) {
  if (name.endsWith(".js")) await cp(new URL(`../dist/core/${name}`, import.meta.url), new URL(`core/${name}`, target));
}
await mkdir(new URL("adapters/", target), { recursive: true });
await cp(new URL("../dist/adapters/shared.js", import.meta.url), new URL("adapters/shared.js", target));
await cp(new URL("../dist/adapters/direct.js", import.meta.url), new URL("adapters/direct.js", target));
await cp(new URL("../dist/adapters/copilot.js", import.meta.url), new URL("adapters/copilot.js", target));
await cp(new URL("../dist/adapters/copilot-mcp.js", import.meta.url), new URL("adapters/copilot-mcp.js", target));
await cp(new URL("../dist/adapters/copilot-coordinator.js", import.meta.url), new URL("adapters/copilot-coordinator.js", target));
