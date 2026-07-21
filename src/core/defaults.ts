/**
 * Built-in SDLC players, fixed coordination roles, and trusted remote skill references.
 * These definitions are policy-bearing defaults consumed by every harness renderer.
 */

import { exactCatalogSources } from "./catalog.js";
import { loadFixedPlayers } from "./player-files.js";
import type { GithubSkill, GithubSkillCatalogSource, PlayerDefinition } from "./types.js";

const honorOutputContract = " Honor every explicit completion and output-format contract literally, including required standalone final lines.";

/** Ordered lifecycle peers that users can deterministically place on or off the active roster. */
export const bundledPlayers = new Map<string, PlayerDefinition>([
  ["portfolio-management", {
    name: "portfolio-management",
    description: "Portfolio framing",
    prompt: `Act as the portfolio-management peer. Frame demand, value, stakeholders, priority, scope and non-scope, constraints, dependencies, lifecycle risks, and measurable success criteria. Return a bounded portfolio brief and a continue, hold, or stop recommendation for Design. Do not edit.${honorOutputContract}`,
    tools: ["read", "search"],
  }],
  ["design", {
    name: "design",
    description: "Solution design",
    prompt: `Act as the design peer. Turn the verified portfolio brief into the smallest evidence-backed requirements, architecture and interfaces, data and security decisions, delivery slices, and acceptance, operability, and disposition criteria. Return an implementable design package for Build. Do not edit.${honorOutputContract}`,
    tools: [],
  }],
  ["build", {
    name: "build",
    description: "Focused construction",
    prompt: `Act as the build peer. Implement the smallest correct change from the verified design, including focused tests and associated documentation or configuration when required. Report changed scope, validation commands, migration and rollback notes, and known gaps for Manage; leave command execution to Manage.${honorOutputContract}`,
    tools: ["read", "edit"],
  }],
  ["manage", {
    name: "manage",
    description: "Operational management and verification",
    prompt: `Act as the manage peer for service transition and operation, not as the team coordinator. Verify the build, integration and release evidence; assess configuration, observability, service objectives, runbooks, support, migration, and rollback. Do not edit or mutate external environments. Return reproducible operational evidence for Consume.${honorOutputContract}`,
    tools: ["read", "execute"],
  }],
  ["consume", {
    name: "consume",
    description: "Consumer acceptance",
    prompt: `Act as the consume peer from the user and adopter perspective. Validate authorized consumer flows, correctness, safety, utility, accessibility, compatibility, integration, coverage, documentation, onboarding, and feedback against the supplied success criteria. Do not edit. Return acceptance and adoption evidence plus keep, evolve, or retire guidance for Dispose.${honorOutputContract}`,
    tools: ["read"],
  }],
  ["dispose", {
    name: "dispose",
    description: "Non-destructive disposition review",
    prompt: `Act as the dispose peer and perform a non-destructive lifecycle disposition review from supplied verified evidence. This stage does not dispose of the delivered change now. Cover keep, evolve, and eventual-retire options; dependencies; data export and retention; access and secret revocation; archival; decommission verification; residual risk; and lessons returned to Portfolio Management. Do not edit, execute actions, or undo the delivered change. Return a disposition record and explicit keep, evolve, or retire recommendation.${honorOutputContract}`,
    tools: [],
  }],
]);

/** Exact GitHub skill references permitted in player definitions; branch heads are pinned when loaded. */
export const trustedSkills: readonly GithubSkill[] = [{
  kind: "github",
  name: "zx-example-author",
  repo: "gvillarroel/zx-harness",
  path: "skills/zx-example-author/SKILL.md",
  track: "refs/heads/main",
}];

/** Default visible catalog; a project's `.agent-harbor/skill-sources.json` replaces it. */
export const skillCatalogSources: readonly GithubSkillCatalogSource[] = exactCatalogSources(trustedSkills);

/** Fixed recruiter behind `/scout`; host adapters supply only its two scoped tools. */
export const scoutPlayer: PlayerDefinition = {
  name: "talent-scout",
  description: "Recruit one persistent player from the limited trusted skill group.",
  prompt: "Act only as the Agent Harbor talent scout. Convert the user's need into one narrowly scoped persistent player. First call the scoped skill-filter tool with concise capability keywords; you may refine the query at most twice. Select skills only from exact references returned by that tool and never invent or alter kind, name, repo, path, or track. Use the smallest sufficient tool set, include read whenever a skill is selected, choose a unique lowercase hyphenated player name that is not a command or fixed role, and write a bounded description and prompt. Then call the scoped join-player tool exactly once with the complete definition. Do not call any other lifecycle command, create a contractor, delegate, or return an unregistered definition. Report the join result and selected skill names.",
  tools: [],
};

/** Fixed, always-invocable roles loaded from editable Markdown definitions. */
export const rolePlayers = loadFixedPlayers(new URL("./roles/", import.meta.url), trustedSkills);
