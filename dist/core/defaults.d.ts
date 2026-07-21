/**
 * Built-in SDLC players, fixed coordination roles, and trusted remote skill references.
 * These definitions are policy-bearing defaults consumed by every harness renderer.
 */
import type { GithubSkill, GithubSkillCatalogSource, PlayerDefinition } from "./types.js";
/** Exact GitHub skill references permitted in player definitions; branch heads are pinned when loaded. */
export declare const trustedSkills: readonly GithubSkill[];
/** Ordered lifecycle peers loaded from editable Markdown definitions. */
export declare const bundledPlayers: ReadonlyMap<string, PlayerDefinition>;
/** Default visible catalog; a project's `.agent-harbor/skill-sources.json` replaces it. */
export declare const skillCatalogSources: readonly GithubSkillCatalogSource[];
/** Fixed recruiter behind `/scout`; host adapters supply only its two scoped tools. */
export declare const scoutPlayer: PlayerDefinition;
/** Fixed, always-invocable roles loaded from editable Markdown definitions. */
export declare const rolePlayers: ReadonlyMap<string, PlayerDefinition>;
