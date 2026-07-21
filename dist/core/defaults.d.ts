/**
 * Built-in SDLC players, fixed coordination roles, and trusted remote skill references.
 * These definitions are policy-bearing defaults consumed by every harness renderer.
 */
import type { GithubSkillCatalogSource, GithubSkillRepositoryTrust, PlayerDefinition, TrustedGithubSkills } from "./types.js";
/** Every gvillarroel repository currently containing at least one `SKILL.md`. */
export declare const trustedSkillRepositories: readonly GithubSkillRepositoryTrust[];
export declare const trustedSkills: TrustedGithubSkills;
/** Ordered lifecycle peers loaded from editable Markdown definitions. */
export declare const bundledPlayers: ReadonlyMap<string, PlayerDefinition>;
/** Default visible catalog; a project's `.agent-harbor/skill-sources.json` replaces it. */
export declare const skillCatalogSources: readonly GithubSkillCatalogSource[];
/** Fixed capacity scout behind `/scout`; host adapters supply only its three scoped tools. */
export declare const scoutPlayer: PlayerDefinition;
/** Fixed, always-invocable roles loaded from editable Markdown definitions. */
export declare const rolePlayers: ReadonlyMap<string, PlayerDefinition>;
