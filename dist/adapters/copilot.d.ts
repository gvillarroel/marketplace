import type { CommandName } from "../core/types.js";
/**
 * Runs one Copilot control request.
 *
 * Deterministic controls execute immediately. `/contract` performs all local
 * and remote skill validation, then returns a closed task descriptor for the
 * Copilot extension to invoke exactly once through its native `task` tool.
 */
export declare function runCopilotControl(command: CommandName, args: string, cwd?: string, signal?: AbortSignal): Promise<string>;
