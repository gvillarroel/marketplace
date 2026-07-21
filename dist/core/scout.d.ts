/** Deterministic, execution-allowlist-only skill discovery for the talent scout. */
import type { GithubResolver, GithubSkill, TrustedGithubSkills } from "./types.js";
export interface ScoutSkillMatch extends GithubSkill {
    description: string;
}
/**
 * Searches exact execution-trusted references plus skills discovered in trusted
 * repositories. It loads bounded frontmatter descriptions, never instruction bodies
 * or project-configured visible sources.
 */
export declare function filterTrustedSkills(query: string, trusted: TrustedGithubSkills, resolver: GithubResolver, signal?: AbortSignal): Promise<readonly ScoutSkillMatch[]>;
/** Serializes the bounded public match set for model-facing recruiter tools. */
export declare function formatScoutSkillMatches(matches: readonly ScoutSkillMatch[]): string;
