/**
 * Loading and invocation-scoped isolation of configured repository and GitHub skills.
 * Only each referenced `SKILL.md` body crosses the boundary: sibling files and ambient skills are
 * deliberately excluded, and remote content is loaded from an allowlisted pinned commit.
 */
import type { GithubResolver, PlayerDefinition, RepositorySkill, SkillReference, TrustedGithubSkills } from "./types.js";
/** Validated skill guidance loaded from its configured source. */
export interface LoadedConfiguredSkill {
    /** Canonical source coordinates supplied by the player definition. */
    readonly reference: SkillReference;
    /** Instruction body with validated frontmatter removed. */
    readonly body: string;
    /** Immutable source commit for GitHub skills; absent for project-local skills. */
    readonly commit?: string;
}
/** Loaded skill plus the isolated `SKILL.md` path exposed to a child invocation. */
export interface MaterializedConfiguredSkill extends LoadedConfiguredSkill {
    readonly filePath: string;
}
/** Temporary, invocation-scoped collection of exact configured skill documents. */
export interface SkillCapsule {
    /** Unique root under the operating-system temporary directory; absent for an empty capsule. */
    readonly root?: string;
    readonly skills: readonly MaterializedConfiguredSkill[];
    /** Idempotently removes the entire capsule after validating its cleanup boundary. */
    cleanup(): Promise<void>;
}
/** Validates a project-relative reference to one traversal-safe `SKILL.md` file. */
export declare function validateRepositorySkill(value: unknown): RepositorySkill;
/** Dispatches strict validation according to the skill reference discriminator. */
export declare function validateSkillReference(value: unknown): SkillReference;
/**
 * Validates the canonical player skill array used by JSON commands and Markdown definitions.
 * Local references are project-relative; GitHub references must match the execution allowlist.
 */
export declare function validateConfiguredSkillReferences(value: unknown, tools: readonly unknown[], trusted: TrustedGithubSkills): SkillReference[];
/**
 * Loads every explicitly configured skill after validating unique names and source trust.
 * Repository sources are confined to the project, GitHub sources are pinned by the resolver, and
 * the combined instruction bodies are capped before being exposed to a child.
 */
export declare function loadConfiguredSkills(definition: PlayerDefinition, project: string, github: GithubResolver, trusted: TrustedGithubSkills, signal?: AbortSignal): Promise<readonly LoadedConfiguredSkill[]>;
/**
 * Materializes configured skills into a private, uniquely named temporary capsule.
 * Each skill receives only its canonical `SKILL.md`; no source siblings are copied. Preparation is
 * all-or-cleaned-up, and the returned cleanup is idempotent and refuses paths outside the expected
 * operating-system temporary-root prefix.
 */
export declare function createSkillCapsule(definition: PlayerDefinition, project: string, github: GithubResolver, trusted: TrustedGithubSkills, signal?: AbortSignal): Promise<SkillCapsule>;
/**
 * Inlines already validated skill guidance into a player prompt for runtimes without capsules.
 * The original `skills` references are removed from the returned executable definition so loaders
 * cannot fetch them again, and the final prompt has its own UTF-8 size bound.
 */
export declare function withLoadedSkillGuidance<T extends PlayerDefinition>(definition: T, loaded: readonly LoadedConfiguredSkill[]): T;
/** Formats loaded skills as a deterministic, provenance-labelled bootstrap response. */
export declare function formatLoadedSkillGroup(loaded: readonly LoadedConfiguredSkill[]): string;
