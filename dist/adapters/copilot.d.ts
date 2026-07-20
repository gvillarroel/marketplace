import type { CommandName } from "../core/types.js";
export declare function runCopilotControl(command: CommandName, args: string, cwd?: string, signal?: AbortSignal): Promise<string>;
