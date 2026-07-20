#!/usr/bin/env node
import { executeCommand } from "./core/commands.js";
import type { CommandName, HarnessName } from "./core/types.js";
import { harborContext } from "./adapters/shared.js";
import { CopilotOrchestrator } from "./orchestrators/copilot.js";

const [, , harnessRaw, commandRaw, ...rest] = process.argv;
if (!(["copilot"] as string[]).includes(harnessRaw) || !(["bench", "join", "retire", "contract", "list-skills"] as string[]).includes(commandRaw)) {
  console.error("usage: agent-harbor copilot <bench|join|retire|contract|list-skills> [arguments]");
  process.exitCode = 2;
} else {
  const harness = harnessRaw as HarnessName;
  const command = commandRaw as CommandName;
  const context = harborContext(harness, process.cwd(), new CopilotOrchestrator());
  try { console.log(await executeCommand(command, rest.join(" "), context)); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
