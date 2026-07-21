/** Deterministic, execution-allowlist-only skill discovery for the talent scout. */
import type { GithubResolver, GithubSkill } from "./types.js";
export interface ScoutSkillMatch extends GithubSkill {
    description: string;
}
/**
 * Searches only exact execution-trusted references. It loads bounded frontmatter
 * descriptions, never instruction bodies or project-configured visible sources.
 */
export declare function filterTrustedSkills(query: string, trusted: readonly GithubSkill[], resolver: GithubResolver, signal?: AbortSignal): Promise<readonly ScoutSkillMatch[]>;
/** Serializes the bounded public match set for model-facing recruiter tools. */
export declare function formatScoutSkillMatches(matches: readonly ScoutSkillMatch[]): string;
