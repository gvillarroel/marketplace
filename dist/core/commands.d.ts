/**
 * Command parsing and dispatch for deterministic roster operations and one-shot contracts.
 * This layer contains no harness-specific rendering or lifecycle mutation logic.
 */
import { Roster } from "./lifecycle.js";
import type { CommandName, ContractDefinition, GithubResolver, GithubSkill, GithubSkillCatalogSource, Orchestrator, PlayerDefinition } from "./types.js";
/** Dependencies required to dispatch every public Agent Harbor command. */
export interface HarborContext {
    roster: Roster;
    bundled: ReadonlyMap<string, PlayerDefinition>;
    orchestrator: Orchestrator;
    github: GithubResolver;
    trustedSkills: readonly GithubSkill[];
    catalogSources?: readonly GithubSkillCatalogSource[];
    color?: boolean;
}
/** Parses and validates the single JSON object accepted by `/contract`. */
export declare function parseContractDefinition(args: string): ContractDefinition;
/**
 * Routes one validated command to its deterministic service or contract orchestrator.
 * Skill listing resolves each configured branch to immutable commit and blob identities.
 */
export declare function executeCommand(name: CommandName, args: string, context: HarborContext, signal?: AbortSignal): Promise<string>;
