import type { DeterministicCommandName, HarnessName } from "../core/types.js";
/** Execute a lifecycle control without creating a model session or child. */
export declare function runDeterministicCommand(harness: HarnessName, command: DeterministicCommandName, args: string, project?: string, signal?: AbortSignal): Promise<string>;
