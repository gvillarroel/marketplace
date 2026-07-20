import { executeCommand } from "../core/commands.js";
import type { DeterministicCommandName, HarnessName, Orchestrator } from "../core/types.js";
import { harborContext } from "./shared.js";

function noModelOrchestrator(harness: HarnessName): Orchestrator {
  return {
    harness,
    run: async () => { throw new Error("deterministic controls cannot invoke a model"); },
  };
}

/** Execute a lifecycle control without creating a model session or child. */
export function runDeterministicCommand(
  harness: HarnessName,
  command: DeterministicCommandName,
  args: string,
  project = process.cwd(),
  signal?: AbortSignal,
): Promise<string> {
  return executeCommand(command, args, harborContext(harness, project, noModelOrchestrator(harness)), signal);
}
