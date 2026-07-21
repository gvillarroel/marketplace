/**
 * Command parsing and dispatch for deterministic roster operations and one-shot contracts.
 * This layer contains no harness-specific rendering or lifecycle mutation logic.
 */

import { Roster, validatePlayer } from "./lifecycle.js";
import type { CommandName, ContractDefinition, GithubResolver, GithubSkill, Orchestrator, PlayerDefinition } from "./types.js";

/** Dependencies required to dispatch every public Agent Harbor command. */
export interface HarborContext {
  roster: Roster;
  bundled: ReadonlyMap<string, PlayerDefinition>;
  orchestrator: Orchestrator;
  github: GithubResolver;
  trustedSkills: readonly GithubSkill[];
}

/** Parses and validates the single JSON object accepted by `/contract`. */
export function parseContractDefinition(args: string): ContractDefinition {
  const raw = JSON.parse(args) as Record<string, unknown>;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("expected one JSON object");
  if ("replace" in raw) throw new Error("contract does not accept replace");
  const { task, ...playerInput } = raw;
  if (typeof task !== "string" || !task.trim()) throw new Error("contract requires a non-empty task");
  return { ...validatePlayer(playerInput), task };
}

/**
 * Routes one validated command to its deterministic service or contract orchestrator.
 * Skill listing resolves each configured branch to immutable commit and blob identities.
 */
export async function executeCommand(name: CommandName, args: string, context: HarborContext, signal?: AbortSignal): Promise<string> {
  switch (name) {
    case "bench": return context.roster.bench(args, context.bundled);
    case "join": return context.roster.join(JSON.parse(args));
    case "retire": return context.roster.retire(args.trim());
    case "contract": return context.orchestrator.run(parseContractDefinition(args), signal);
    case "list-skills": {
      const filter = args.trim().toLowerCase();
      const selected = context.trustedSkills.filter((skill) => !filter || skill.name.toLowerCase().includes(filter));
      const rows = await Promise.all(selected.map(async (skill) => {
        const snapshot = await context.github.resolve(skill, signal);
        return `${skill.name} | ${skill.repo} | ${skill.path} | ${skill.track} | ${snapshot.commit} | ${snapshot.blob}`;
      }));
      return rows.join("\n");
    }
  }
}
