/**
 * Built-in SDLC players, fixed coordination roles, and trusted remote skill references.
 * These definitions are policy-bearing defaults consumed by every harness renderer.
 */
import { loadFixedPlayers } from "./player-files.js";
/** Every gvillarroel repository currently containing at least one `SKILL.md`. */
export const trustedSkillRepositories = [
    "knowledge",
    "marketplace",
    "pi-menton",
    "sdlc",
    "skills",
    "slidev-manim",
    "zx-harness",
].map((repository) => ({
    kind: "github",
    scope: "repository",
    repo: `gvillarroel/${repository}`,
    track: "refs/heads/main",
}));
/** Compatibility references decorated with the repository trust roots used by every validator. */
const exactTrustedSkills = [{
        kind: "github",
        name: "zx-example-author",
        repo: "gvillarroel/zx-harness",
        path: "skills/zx-example-author/SKILL.md",
        track: "refs/heads/main",
    }];
Object.defineProperty(exactTrustedSkills, "repositories", { value: trustedSkillRepositories });
export const trustedSkills = exactTrustedSkills;
/** Ordered lifecycle peers loaded from editable Markdown definitions. */
export const bundledPlayers = loadFixedPlayers(new URL("./bundled/", import.meta.url), trustedSkills);
/** Default visible catalog; a project's `.agent-harbor/skill-sources.json` replaces it. */
export const skillCatalogSources = trustedSkillRepositories;
/** Fixed capacity scout behind `/scout`; host adapters supply only its three scoped tools. */
export const scoutPlayer = {
    name: "talent-scout",
    description: "Find and reuse sufficient team capacity or recruit at most one persistent player.",
    prompt: "Act only as the Agent Harbor talent scout. Convert the user's need into one narrowly scoped persistent player only when the enabled team does not already cover it. First call the scoped team-roster tool exactly once with concise capability keywords or an empty query. If one ready teammate is sufficient, report its direct command and stop without filtering or joining. Otherwise call the scoped skill-filter tool with concise capability keywords; you may refine the query at most twice. Select skills only from exact references returned by that tool and never invent or alter kind, name, repo, path, or track. Use the smallest sufficient tool set, include read whenever a skill is selected, choose a unique lowercase hyphenated player name that is not a command or fixed role, and write a bounded description and prompt. Then call the scoped join-player tool exactly once with the complete definition. Do not call any other lifecycle command, create a contractor, delegate, or return an unregistered definition. Report the existing teammate or the join result and selected skill names.",
    tools: [],
};
/** Fixed, always-invocable roles loaded from editable Markdown definitions. */
export const rolePlayers = loadFixedPlayers(new URL("./roles/", import.meta.url), trustedSkills);
