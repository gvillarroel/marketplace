/** Closed-schema loader for fixed player definitions stored as Markdown files. */
import type { GithubSkill, PlayerDefinition } from "./types.js";
/** Loads all fixed players in stable frontmatter order from one bundled directory. */
export declare function loadFixedPlayers(directory: URL, trustedSkills: readonly GithubSkill[]): ReadonlyMap<string, PlayerDefinition>;
