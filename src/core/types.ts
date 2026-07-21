/**
 * Shared domain contracts for commands, harness adapters, players, and skill sources.
 * Keeping these types transport-agnostic lets every adapter enforce the same core rules.
 */

/** Command names accepted by the public Agent Harbor command dispatcher. */
export const commandNames = ["bench", "join", "retire", "contract", "list-skills"] as const;

/** A command accepted by the public Agent Harbor command dispatcher. */
export type CommandName = (typeof commandNames)[number];

/** Commands whose result is produced without asking a model to interpret the request. */
export const deterministicCommandNames = ["bench", "join", "retire", "list-skills"] as const;

/** A command that executes deterministically without a model turn. */
export type DeterministicCommandName = (typeof deterministicCommandNames)[number];

/** A runtime for which Agent Harbor can render and discover player profiles. */
export type HarnessName = "copilot" | "opencode" | "pi";

/** Runtime-independent capabilities that a player may request. */
export type HarborTool = "read" | "search" | "edit" | "execute";

/** Validated, runtime-independent definition of a persistent or contracted player. */
export interface PlayerDefinition {
  name: string;
  description: string;
  prompt: string;
  tools: HarborTool[];
  model?: string;
  replace?: boolean;
  skills?: SkillReference[];
}

/** Disposable-player definition augmented with the one task it must execute. */
export interface ContractDefinition extends PlayerDefinition {
  task: string;
}

/** Filesystem layout and renderer selected for one harness and project pair. */
export interface HarnessSpec {
  name: HarnessName;
  home: string;
  project: string;
  registrationDir: string;
  activeDir: string;
  extension: string;
  renderPlayer(player: PlayerDefinition, roster: "personal" | "sdlc"): string;
}

/** Adapter boundary that runs exactly one disposable contracted child. */
export interface Orchestrator {
  readonly harness: HarnessName;
  run(definition: ContractDefinition, signal?: AbortSignal): Promise<string>;
}

/** Allowlisted GitHub skill location tracked through a named branch reference. */
export interface GithubSkill {
  kind: "github";
  name: string;
  repo: string;
  path: string;
  track: string;
}

/** Read-only GitHub scope whose `SKILL.md` entries may appear in the visible catalog. */
export interface GithubSkillCatalogSource {
  kind: "github";
  scope: "repository" | "folder" | "skill";
  repo: string;
  track: string;
  /** Required for folder/skill scopes and omitted for a whole repository. */
  path?: string;
  /** Optional display override for one exact skill; folder/repository names come from their paths. */
  name?: string;
}

/** One discovered catalog row. Catalog visibility does not grant execution trust. */
export interface GithubSkillCatalogEntry {
  name: string;
  repo: string;
  path: string;
}

/** Reference to one exact, project-root-relative `SKILL.md` file. */
export interface RepositorySkill {
  kind: "repo";
  name: string;
  /** Project-root-relative path to one exact `SKILL.md` file. */
  path: string;
}

/** Supported source for skill guidance assigned to a player. */
export type SkillReference = GithubSkill | RepositorySkill;

/** Resolver that pins a GitHub branch to a commit before inspecting or loading a skill. */
export interface GithubResolver {
  resolve(skill: GithubSkill, signal?: AbortSignal): Promise<{ commit: string; blob: string }>;
  load(skill: GithubSkill, signal?: AbortSignal): Promise<{ commit: string; body: string }>;
  listCatalog?(source: GithubSkillCatalogSource, signal?: AbortSignal): Promise<readonly GithubSkillCatalogEntry[]>;
}
