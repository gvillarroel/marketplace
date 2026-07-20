import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import { executeCommand } from "../core/commands.js";
import { rolePlayers, trustedSkills } from "../core/defaults.js";
import { GhResolver, loadTrustedGithubSkill } from "../core/github.js";
import { composePlayerInstructions, openCodeToolPolicy } from "../core/profiles.js";
import { commandNames, type CommandName } from "../core/types.js";
import { OpenCodeOrchestrator } from "../orchestrators/opencode.js";
import { harborContext } from "./shared.js";

export const AgentHarborPlugin: Plugin = async ({ client, directory }) => {
  const teamLead = rolePlayers.get("team-lead")!;
  const repoCartographer = rolePlayers.get("repo-cartographer")!;
  const crafter = rolePlayers.get("crafter")!;
  return {
    config: async (config) => {
      config.command ??= {};
      for (const name of commandNames) config.command[name] = {
        description: `Agent Harbor ${name} control`,
        template: `Call the harbor tool exactly once with command ${JSON.stringify(name)} and args $ARGUMENTS. Return its result verbatim.`,
      };
      config.agent = {
        ...(config.agent ?? {}),
        "team-lead": {
          description: teamLead.description, mode: "subagent",
          prompt: `${teamLead.prompt} The only delegation tool is harbor_contract.`,
          tools: openCodeToolPolicy([], ["harbor_contract"]),
        },
        "repo-cartographer": {
          description: repoCartographer.description, mode: "subagent",
          prompt: composePlayerInstructions(repoCartographer),
          tools: openCodeToolPolicy(repoCartographer.tools),
        },
        crafter: {
          description: crafter.description, mode: "subagent",
          prompt: composePlayerInstructions(crafter, "opencode"),
          tools: openCodeToolPolicy(crafter.tools, ["agent_harbor_skill"]),
        },
      };
    },
    tool: {
      harbor: tool({
        description: "Execute one deterministic Agent Harbor lifecycle or orchestration command.",
        args: { command: tool.schema.enum(commandNames), args: tool.schema.string() },
        execute: async ({ command, args }, execution) => {
          const currentDirectory = execution.directory || directory;
          const context = harborContext("opencode", currentDirectory, new OpenCodeOrchestrator(client, currentDirectory));
          return executeCommand(command as CommandName, args, context, execution.abort);
        },
      }),
      harbor_contract: tool({
        description: "Run exactly one invocation-scoped Agent Harbor contractor; no roster mutation is available.",
        args: { definition: tool.schema.string() },
        execute: async ({ definition }, execution) => {
          const currentDirectory = execution.directory || directory;
          const context = harborContext("opencode", currentDirectory, new OpenCodeOrchestrator(client, currentDirectory));
          return executeCommand("contract", definition, context, execution.abort);
        },
      }),
      agent_harbor_skill: tool({
        description: "Resolve one exact allowlisted GitHub SKILL.md snapshot, validate it, and return invocation-local guidance.",
        args: { reference: tool.schema.string() },
        execute: async ({ reference }, execution) => {
          const loaded = await loadTrustedGithubSkill(JSON.parse(reference), trustedSkills, new GhResolver(), execution.abort);
          return `HARBOR-COMMIT ${loaded.commit}\nHARBOR-SKILL ${loaded.skill.name}\n${loaded.body}`;
        },
      }),
    },
  };
};

export default AgentHarborPlugin;
