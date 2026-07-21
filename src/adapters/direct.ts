/** Zero-model adapter shared by CLI and native deterministic controls. */
import { executeCommand } from "../core/commands.js";
import type { DeterministicCommandName, HarnessName, Orchestrator } from "../core/types.js";
import { harborContext } from "./shared.js";

function noModelOrchestrator(harness: HarnessName): Orchestrator {
  return {
    harness,
    run: async () => { throw new Error("deterministic controls cannot invoke a model"); },
  };
}

/**
 * Executes a lifecycle control without creating a model session or child.
 * The injected orchestrator is a tripwire: deterministic commands must never
 * cross the inference boundary, even if command routing regresses.
 */
export function runDeterministicCommand(
  harness: HarnessName,
  command: DeterministicCommandName,
  args: string,
  project = process.cwd(),
  signal?: AbortSignal,
): Promise<string> {
  return executeCommand(command, args, harborContext(harness, project, noModelOrchestrator(harness)), signal);
}
