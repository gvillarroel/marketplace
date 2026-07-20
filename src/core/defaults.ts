import type { GithubSkill, PlayerDefinition } from "./types.js";

export const bundledPlayers = new Map<string, PlayerDefinition>([
  ["scout", { name: "scout", description: "Repository discovery", prompt: "Discover evidence and scope only. Do not edit.", tools: ["read", "search"] }],
  ["sage", { name: "sage", description: "Implementation design", prompt: "Design an evidence-backed implementation plan only.", tools: ["read", "search"] }],
  ["smith", { name: "smith", description: "Focused implementation", prompt: "Implement the smallest correct change and validate it.", tools: ["read", "search", "edit", "execute"] }],
  ["probe", { name: "probe", description: "Focused verification", prompt: "Run focused tests and report reproducible evidence.", tools: ["read", "search", "execute"] }],
  ["guard", { name: "guard", description: "Read-only review", prompt: "Review correctness, regressions, safety, scope, and coverage.", tools: ["read", "search"] }],
  ["pilot", { name: "pilot", description: "Delivery readiness", prompt: "Assess delivery readiness, rollback, and residual risk.", tools: ["read", "search"] }],
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
    prompt: "Act as a minimal team lead. Bound the work, then call the available contract tool exactly once with one complete least-privilege contractor definition. Synthesize only verified returned evidence.",
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
