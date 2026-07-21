import type { DeterministicCommandName, HarnessName } from "../core/types.js";
/**
 * Executes a lifecycle control without creating a model session or child.
 * The injected orchestrator is a tripwire: deterministic commands must never
 * cross the inference boundary, even if command routing regresses.
 */
export declare function runDeterministicCommand(harness: HarnessName, command: DeterministicCommandName, args: string, project?: string, signal?: AbortSignal, color?: boolean): Promise<string>;
