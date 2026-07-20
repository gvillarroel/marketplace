import { Roster } from "./lifecycle.js";
import type { CommandName, ContractDefinition, GithubResolver, GithubSkill, Orchestrator, PlayerDefinition } from "./types.js";
export interface HarborContext {
    roster: Roster;
    bundled: ReadonlyMap<string, PlayerDefinition>;
    orchestrator: Orchestrator;
    github: GithubResolver;
    trustedSkills: readonly GithubSkill[];
}
export declare function parseContractDefinition(args: string): ContractDefinition;
export declare function executeCommand(name: CommandName, args: string, context: HarborContext, signal?: AbortSignal): Promise<string>;
