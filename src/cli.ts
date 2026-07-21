#!/usr/bin/env node
/**
 * Portable command-line entrypoint for Agent Harbor.
 *
 * Lifecycle commands use the deterministic core directly. A programmatic
 * contract is allowed only for Copilot, whose SDK can be constructed without
 * an enclosing host; OpenCode and Pi contracts must inherit their host model.
 */
import { executeCommand } from "./core/commands.js";
import type { CommandName, HarnessName } from "./core/types.js";
import { deterministicCommandNames } from "./core/types.js";
import { runDeterministicCommand } from "./adapters/direct.js";
import { harborContext } from "./adapters/shared.js";

const [, , harnessRaw, commandRaw, ...rest] = process.argv;
const harnesses: readonly HarnessName[] = ["copilot", "opencode", "pi"];
const commands: readonly CommandName[] = ["bench", "join", "retire", "contract", "list-skills"];
if (!(harnesses as readonly string[]).includes(harnessRaw) || !(commands as readonly string[]).includes(commandRaw)) {
  console.error("usage: agent-harbor <copilot|opencode|pi> <bench|join|retire|contract|list-skills> [arguments]");
  process.exitCode = 2;
} else {
  const harness = harnessRaw as HarnessName;
  const command = commandRaw as CommandName;
  const args = rest.join(" ");
  try {
    if ((deterministicCommandNames as readonly string[]).includes(command)) {
      console.log(await runDeterministicCommand(harness, command as (typeof deterministicCommandNames)[number], args));
    } else if (harness === "copilot") {
      const { CopilotOrchestrator } = await import("./orchestrators/copilot.js");
      console.log(await executeCommand(command, args, harborContext(harness, process.cwd(), new CopilotOrchestrator())));
    } else {
      throw new Error(`/contract must run inside ${harness}; the direct CLI never starts a hidden model session`);
    }
  }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
