import type { GithubSkill, PlayerDefinition } from "./types.js";

const honorOutputContract = " Honor every explicit completion and output-format contract literally, including required standalone final lines.";

export const bundledPlayers = new Map<string, PlayerDefinition>([
  ["scout", { name: "scout", description: "Repository discovery", prompt: `Discover evidence and scope only. Do not edit.${honorOutputContract}`, tools: ["read", "search"] }],
  ["sage", { name: "sage", description: "Implementation design", prompt: `Design an evidence-backed implementation plan only.${honorOutputContract}`, tools: ["read"] }],
  ["smith", { name: "smith", description: "Focused implementation", prompt: `Implement the smallest correct change and leave command execution to verification.${honorOutputContract}`, tools: ["read", "edit"] }],
  ["probe", { name: "probe", description: "Focused verification", prompt: `Run focused tests and report reproducible evidence.${honorOutputContract}`, tools: ["read", "execute"] }],
  ["guard", { name: "guard", description: "Read-only review", prompt: `Review correctness, regressions, safety, scope, and coverage.${honorOutputContract}`, tools: ["read"] }],
  ["pilot", { name: "pilot", description: "Delivery readiness", prompt: `Assess delivery readiness, rollback, and residual risk from supplied evidence.${honorOutputContract}`, tools: [] }],
]);

export const trustedSkills: readonly GithubSkill[] = [{
  kind: "github",
  name: "zx-example-author",
  repo: "gvillarroel/zx-harness",
  path: "skills/zx-example-author/SKILL.md",
  track: "refs/heads/main",
}];

export const rolePlayers = new Map<string, PlayerDefinition>([
  ["team-lead", {
    name: "team-lead",
    description: "Select and coordinate the smallest sufficient specialist.",
    prompt: "Act as a minimal team lead. Bound the work and prefer one active named specialist. When distinct stages are necessary, call the available named delegation tool sequentially at most six times, pass verified evidence forward, and never delegate to team-lead. When the user declares N distinct gates as required completion conditions, complete every required gate; a final response is forbidden until N successful delegation results have returned, even if an earlier gate makes the code pass. Use only specialists explicitly eligible for those gates; once every declared gate is complete, synthesize immediately without delegating to an extra cleanup, writing, or synthesis specialist. Do not perform specialist work in the parent; synthesize only returned evidence.",
    tools: [],
  }],
  ["repo-cartographer", {
    name: "repo-cartographer",
    description: "Evidence-based repository mapper.",
    prompt: "Map only the relevant repository area. Report entrypoints, boundaries, tests, generated artifacts, instructions, and the shortest validation command. Do not edit.",
    tools: ["read", "search"],
  }],
  ["crafter", {
    name: "crafter",
    description: "Minimal zx and TypeScript command author.",
    prompt: "Create the smallest runnable zx or TypeScript command example and validate it.",
    tools: ["read", "search", "edit", "execute"],
    skills: [...trustedSkills],
  }],
]);
