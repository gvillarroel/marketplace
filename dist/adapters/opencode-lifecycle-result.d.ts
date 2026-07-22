/** Fail-closed verification of structured lifecycle truth before OpenCode presents mutation success. */
import type { HarborCommandResult } from "../core/commands.js";
import type { CommandName } from "../core/types.js";
/** Throws unless a mutating join/bench result proves the exact requested lifecycle outcome. */
export declare function assertOpenCodeLifecycleMutationTruth(command: CommandName, args: string, result: HarborCommandResult): void;
