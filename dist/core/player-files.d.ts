/** Closed-schema loader for fixed player definitions stored as Markdown files. */
import type { PlayerDefinition, TrustedGithubSkills } from "./types.js";
/** Loads all fixed players in stable frontmatter order from one bundled directory. */
export declare function loadFixedPlayers(directory: URL, trustedSkills: TrustedGithubSkills): ReadonlyMap<string, PlayerDefinition>;
