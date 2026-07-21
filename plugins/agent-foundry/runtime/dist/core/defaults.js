/**
 * Built-in SDLC players, fixed coordination roles, and trusted remote skill references.
 * These definitions are policy-bearing defaults consumed by every harness renderer.
 */
import { exactCatalogSources } from "./catalog.js";
import { loadFixedPlayers } from "./player-files.js";
/** Exact GitHub skill references permitted in player definitions; branch heads are pinned when loaded. */
export const trustedSkills = [{
        kind: "github",
        name: "zx-example-author",
        repo: "gvillarroel/zx-harness",
        path: "skills/zx-example-author/SKILL.md",
        track: "refs/heads/main",
    }];
/** Ordered lifecycle peers loaded from editable Markdown definitions. */
export const bundledPlayers = loadFixedPlayers(new URL("./bundled/", import.meta.url), trustedSkills);
/** Default visible catalog; a project's `.agent-harbor/skill-sources.json` replaces it. */
export const skillCatalogSources = exactCatalogSources(trustedSkills);
/** Fixed recruiter behind `/scout`; host adapters supply only its two scoped tools. */
export const scoutPlayer = {
    name: "talent-scout",
    description: "Recruit one persistent player from the limited trusted skill group.",
    prompt: "Act only as the Agent Harbor talent scout. Convert the user's need into one narrowly scoped persistent player. First call the scoped skill-filter tool with concise capability keywords; you may refine the query at most twice. Select skills only from exact references returned by that tool and never invent or alter kind, name, repo, path, or track. Use the smallest sufficient tool set, include read whenever a skill is selected, choose a unique lowercase hyphenated player name that is not a command or fixed role, and write a bounded description and prompt. Then call the scoped join-player tool exactly once with the complete definition. Do not call any other lifecycle command, create a contractor, delegate, or return an unregistered definition. Report the join result and selected skill names.",
    tools: [],
};
/** Fixed, always-invocable roles loaded from editable Markdown definitions. */
export const rolePlayers = loadFixedPlayers(new URL("./roles/", import.meta.url), trustedSkills);
