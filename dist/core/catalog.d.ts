/** Project-controlled, read-only skill catalog configuration and terminal rendering. */
import type { GithubSkill, GithubSkillCatalogEntry, GithubSkillCatalogSource } from "./types.js";
/** Returns the project-local file that controls the visible skill catalog. */
export declare function skillCatalogConfigPath(project: string): string;
/** Converts the exact built-in execution allowlist into the default visible catalog. */
export declare function exactCatalogSources(skills: readonly GithubSkill[]): GithubSkillCatalogSource[];
/**
 * Loads a closed-schema project override. A present file replaces the defaults,
 * so an empty `sources` array intentionally displays an empty catalog.
 */
export declare function loadSkillCatalogSources(project: string, defaults: readonly GithubSkillCatalogSource[]): Promise<readonly GithubSkillCatalogSource[]>;
/** Renders only repository, path, and skill name, with optional ANSI terminal color. */
export declare function formatSkillCatalog(entries: readonly GithubSkillCatalogEntry[], color?: boolean): string;
