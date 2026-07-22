/**
 * Command parsing and dispatch for deterministic roster operations and one-shot contracts.
 * This layer contains no harness-specific rendering or lifecycle mutation logic.
 */
import { Roster, type LifecycleMutationStatus, type RosterBenchMutationRow } from "./lifecycle.js";
import { type SkillCatalogStyle } from "./catalog.js";
import type { CommandName, ContractDefinition, GithubResolver, GithubSkillCatalogSource, Orchestrator, PlayerDefinition, TrustedGithubSkills } from "./types.js";
/** Dependencies required to dispatch every public Agent Harbor command. */
export interface HarborContext {
    roster: Roster;
    bundled: ReadonlyMap<string, PlayerDefinition>;
    orchestrator: Orchestrator;
    github: GithubResolver;
    trustedSkills: TrustedGithubSkills;
    catalogSources?: readonly GithubSkillCatalogSource[];
    loadCatalogSources?: () => Promise<readonly GithubSkillCatalogSource[]>;
    catalogStyle?: SkillCatalogStyle;
}
/** Structured deterministic lifecycle metadata consumed by native adapters. */
export type HarborLifecycleOutcome = {
    readonly command: "join";
    readonly player: string;
    readonly status: LifecycleMutationStatus;
} | {
    readonly command: "bench";
    readonly status: LifecycleMutationStatus;
    readonly rows: readonly RosterBenchMutationRow[];
} | {
    readonly command: "retire";
    readonly player: string;
    readonly status: LifecycleMutationStatus;
};
/** Command text plus optional mutation truth; `executeCommand()` preserves the string API. */
export interface HarborCommandResult {
    readonly text: string;
    readonly lifecycle?: HarborLifecycleOutcome;
}
/** Parses and validates the single JSON object accepted by `/contract`. */
export declare function parseContractDefinition(args: string): ContractDefinition;
/**
 * Routes one validated command to its deterministic service or contract orchestrator.
 * Skill listing resolves each configured branch to immutable commit and blob identities.
 */
export declare function executeCommandResult(name: CommandName, args: string, context: HarborContext, signal?: AbortSignal): Promise<HarborCommandResult>;
/** Backwards-compatible text command API. */
export declare function executeCommand(name: CommandName, args: string, context: HarborContext, signal?: AbortSignal): Promise<string>;
