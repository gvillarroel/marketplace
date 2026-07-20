export const commandNames = ["bench", "join", "retire", "contract", "list-skills"] as const;
export type CommandName = (typeof commandNames)[number];
export const deterministicCommandNames = ["bench", "join", "retire", "list-skills"] as const;
export type DeterministicCommandName = (typeof deterministicCommandNames)[number];
export type HarnessName = "copilot" | "opencode" | "pi";
export type HarborTool = "read" | "search" | "edit" | "execute";

export interface PlayerDefinition {
  name: string;
  description: string;
  prompt: string;
  tools: HarborTool[];
  model?: string;
  replace?: boolean;
  skills?: GithubSkill[];
}

export interface ContractDefinition extends PlayerDefinition {
  task: string;
}

export interface HarnessSpec {
  name: HarnessName;
  home: string;
  project: string;
  registrationDir: string;
  activeDir: string;
  extension: string;
  renderPlayer(player: PlayerDefinition, roster: "personal" | "sdlc"): string;
}

export interface Orchestrator {
  readonly harness: HarnessName;
  run(definition: ContractDefinition, signal?: AbortSignal): Promise<string>;
}

export interface GithubSkill {
  kind: "github";
  name: string;
  repo: string;
  path: string;
  track: string;
}

export interface GithubResolver {
  resolve(skill: GithubSkill, signal?: AbortSignal): Promise<{ commit: string; blob: string }>;
  load(skill: GithubSkill, signal?: AbortSignal): Promise<{ commit: string; body: string }>;
}
