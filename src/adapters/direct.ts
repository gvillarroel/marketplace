/** Zero-model adapter shared by CLI and native deterministic controls. */
import { executeCommandResult, type HarborCommandResult } from "../core/commands.js";
import type { SkillCatalogStyle } from "../core/catalog.js";
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
  catalogStyle: SkillCatalogStyle = "plain",
): Promise<string> {
  return runDeterministicCommandResult(harness, command, args, project, signal, catalogStyle)
    .then(({ text }) => text);
}

/** Executes a deterministic control while preserving structured lifecycle mutation truth. */
export function runDeterministicCommandResult(
  harness: HarnessName,
  command: DeterministicCommandName,
  args: string,
  project = process.cwd(),
  signal?: AbortSignal,
  catalogStyle: SkillCatalogStyle = "plain",
): Promise<HarborCommandResult> {
  return harborContext(harness, project, noModelOrchestrator(harness), catalogStyle)
    .then((context) => executeCommandResult(command, args, context, signal));
}
