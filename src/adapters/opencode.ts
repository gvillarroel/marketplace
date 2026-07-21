/** OpenCode plugin entrypoint and translation to Agent Harbor's shared core. */
import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import { assertInvocablePlayer, listInvocablePlayerIds, listManagedActiveIds, listOwnedActiveIds, loadManagedActivePlayer, requireInvocablePlayer } from "../core/active.js";
import { executeCommand } from "../core/commands.js";
import { bundledPlayers, rolePlayers, scoutPlayer, trustedSkills } from "../core/defaults.js";
import { GhResolver } from "../core/github.js";
import { composePlayerInstructions, normalizeDelegatedTaskPaths, openCodePermissionPolicy, openCodeToolPolicy } from "../core/profiles.js";
import { formatLoadedSkillGroup, loadConfiguredSkills } from "../core/skills.js";
import { filterTrustedSkills, formatScoutSkillMatches } from "../core/scout.js";
import { commandNames, type CommandName } from "../core/types.js";
import { OpenCodeOrchestrator, type OpenCodeModel } from "../orchestrators/opencode.js";
import { harborContext } from "./shared.js";

/**
 * Creates the OpenCode plugin configuration, command tools, named players, and
 * bounded team-lead delegation for the current project directory.
 */
export const AgentHarborPlugin: Plugin = async ({ client, directory }) => {
  const teamLead = rolePlayers.get("team-lead")!;
  const crafter = rolePlayers.get("crafter")!;
  const delegationCounts = new Map<string, number>();
  const delegatedAgents = new Map<string, Set<string>>();
  const delegationsInFlight = new Set<string>();
  const directAgentCommands = new Map<string, string>();
  const turnModels = new Map<string, OpenCodeModel>();
  for (const id of [...rolePlayers.keys(), ...bundledPlayers.keys()]) directAgentCommands.set(id, id);
  directAgentCommands.set("scout", scoutPlayer.name);
  const originatingUserMessage = async (
    sessionID: string,
    messageID: string,
    currentDirectory: string,
  ): Promise<{ readonly id: string; readonly model: OpenCodeModel }> => {
    // SDK-created assistant messages do not reliably repeat the root model.
    // Walk the bounded ancestry and recover the explicit originating user turn.
    const seen = new Set<string>();
    let cursor = messageID;
    for (let depth = 0; depth < 64; depth += 1) {
      if (seen.has(cursor)) throw new Error("harbor_delegate found a cyclic message ancestry");
      seen.add(cursor);
      const message = await client.session.message({
        path: { id: sessionID, messageID: cursor },
        query: { directory: currentDirectory },
        throwOnError: true,
      });
      if (message.data.info.role === "user") {
        const { model } = message.data.info;
        if (!model?.providerID.trim() || !model.modelID.trim()) {
          throw new Error("harbor_delegate originating user turn has no explicit model");
        }
        const remembered = turnModels.get(`${sessionID}\u0000${message.data.info.id}`);
        const typedInfo = message.data.info as typeof message.data.info & { readonly variant?: string };
        const typedModel = model as typeof model & { readonly variant?: string };
        return {
          id: message.data.info.id,
          model: {
            providerID: model.providerID,
            modelID: model.modelID,
            ...(remembered?.variant === undefined && typedInfo.variant === undefined && typedModel.variant === undefined
              ? {}
              : { variant: remembered?.variant ?? typedInfo.variant ?? typedModel.variant }),
          },
        };
      }
      if (message.data.info.role !== "assistant" || !message.data.info.parentID) break;
      cursor = message.data.info.parentID;
    }
    throw new Error("harbor_delegate could not identify the originating user turn");
  };
  return {
    "chat.message": async (input, output) => {
      const messageID = input.messageID ?? output.message.id;
      const model = input.model ?? output.message.model;
      const typedMessage = output.message as typeof output.message & {
        readonly variant?: string;
        readonly model: typeof output.message.model & { readonly variant?: string };
      };
      const variant = input.variant ?? typedMessage.variant ?? typedMessage.model.variant;
      if (!messageID || !model?.providerID.trim() || !model.modelID.trim()) return;
      if (turnModels.size >= 1_024 && !turnModels.has(`${input.sessionID}\u0000${messageID}`)) {
        turnModels.delete(turnModels.keys().next().value!);
      }
      turnModels.set(`${input.sessionID}\u0000${messageID}`, {
        providerID: model.providerID,
        modelID: model.modelID,
        ...(variant === undefined ? {} : { variant }),
      });
    },
    "chat.params": async (input, output) => {
      if (input.model.providerID === "openai" &&
          (input.model.id === "gpt-5.3-codex-spark" || input.model.id === "gpt-5.6-luna")) {
        // The Codex OAuth Responses endpoint rejects metadata injected for SDK-created sessions.
        delete output.options.metadata;
      }
    },
    config: async (config) => {
      config.command ??= {};
      for (const name of commandNames) config.command[name] = {
        description: `Agent Harbor ${name} model-routed fallback; prefer the direct TUI or agent-harbor CLI control`,
        template: `Call the harbor tool exactly once with command ${JSON.stringify(name)} and args $ARGUMENTS. Return its result verbatim.`,
      };
      for (const id of listInvocablePlayerIds("opencode", directory)) {
        directAgentCommands.set(id, id);
        config.command[id] = {
          description: `Run Agent Harbor player ${id} in the current session`,
          template: "$ARGUMENTS",
          agent: id,
          subtask: false,
        };
      }
      config.command.scout = {
        description: "Recruit and join one player from Agent Harbor's limited trusted skill group",
        template: "$ARGUMENTS",
        agent: scoutPlayer.name,
        subtask: false,
      };
      config.agent = {
        ...(config.agent ?? {}),
        "team-lead": {
          description: teamLead.description, mode: "subagent",
          steps: 7,
          prompt: `${composePlayerInstructions(teamLead)} In OpenCode, harbor_delegate is the named delegation tool; provide an exact active player ID and a complete non-empty task. The tool validates the target against the live roster at invocation time.`,
          tools: { ...openCodeToolPolicy([]), harbor_delegate: true },
          permission: openCodePermissionPolicy([], ["harbor_delegate"], directory),
        },
        crafter: {
          description: crafter.description, mode: "subagent",
          steps: 4,
          prompt: composePlayerInstructions(crafter, "opencode"),
          tools: { ...openCodeToolPolicy(crafter.tools, ["agent_harbor_skills"]), harbor_delegate: false },
          permission: openCodePermissionPolicy(crafter.tools, ["agent_harbor_skills"], directory),
        },
        [scoutPlayer.name]: {
          description: scoutPlayer.description, mode: "subagent",
          steps: 5,
          prompt: `${composePlayerInstructions(scoutPlayer)} In OpenCode, call harbor_filter_skills with a query string, then call harbor_join_player exactly once with the complete player definition serialized as JSON.`,
          tools: openCodeToolPolicy([], ["harbor_filter_skills", "harbor_join_player"]),
          permission: openCodePermissionPolicy([], ["harbor_filter_skills", "harbor_join_player"], directory),
        },
      };
      for (const [id, player] of rolePlayers) {
        if (Object.hasOwn(config.agent, id)) continue;
        const additional = player.skills?.length ? ["agent_harbor_skills"] : [];
        config.agent[id] = {
          description: player.description,
          mode: "subagent",
          steps: 4,
          ...(player.model ? { model: player.model } : {}),
          prompt: composePlayerInstructions(player, "opencode"),
          tools: openCodeToolPolicy(player.tools, additional),
          permission: openCodePermissionPolicy(player.tools, additional, directory),
        };
      }
      const managedIds = new Set(listManagedActiveIds("opencode", directory));
      // Owned-but-stale profiles must be removed from host discovery. Leaving
      // an old host entry could silently retain broader tools than revision 4.
      for (const id of listOwnedActiveIds("opencode", directory)) {
        if (!managedIds.has(id)) delete config.agent[id];
      }
      for (const id of managedIds) {
        const player = loadManagedActivePlayer("opencode", directory, id);
        const additional = player.skills?.length ? ["agent_harbor_skills"] : [];
        config.agent[id] = {
          description: player.description,
          mode: "subagent",
          steps: 4,
          ...(player.model ? { model: player.model } : {}),
          prompt: composePlayerInstructions(player, "opencode"),
          tools: openCodeToolPolicy(player.tools, additional),
          permission: openCodePermissionPolicy(player.tools, additional, directory),
        };
      }
    },
    "command.execute.before": async ({ command, arguments: args }) => {
      const id = directAgentCommands.get(command);
      if (!id) return;
      if (!args.trim()) throw new Error(`/${command} requires a non-empty task`);
      if (id !== scoutPlayer.name) assertInvocablePlayer("opencode", directory, id);
    },
    tool: {
      harbor: tool({
        description: "Execute one deterministic Agent Harbor lifecycle or orchestration command.",
        args: { command: tool.schema.enum(commandNames), args: tool.schema.string() },
        execute: async ({ command, args }, execution) => {
          const currentDirectory = execution.directory || directory;
          const context = await harborContext("opencode", currentDirectory, new OpenCodeOrchestrator(client, currentDirectory));
          return executeCommand(command as CommandName, args, context, execution.abort);
        },
      }),
      harbor_contract: tool({
        description: "Run exactly one invocation-scoped Agent Harbor contractor; no roster mutation is available.",
        args: { definition: tool.schema.string() },
        execute: async ({ definition }, execution) => {
          const currentDirectory = execution.directory || directory;
          const context = await harborContext("opencode", currentDirectory, new OpenCodeOrchestrator(client, currentDirectory));
          return executeCommand("contract", definition, context, execution.abort);
        },
      }),
      harbor_filter_skills: tool({
        description: "Talent-scout only: filter the exact execution-trusted skill group by public metadata.",
        args: { query: tool.schema.string() },
        execute: async ({ query }, execution) => {
          if (execution.agent !== scoutPlayer.name) throw new Error("harbor_filter_skills is available only to talent-scout");
          return formatScoutSkillMatches(await filterTrustedSkills(query, trustedSkills, new GhResolver(), execution.abort));
        },
      }),
      harbor_join_player: tool({
        description: "Talent-scout only: validate, register, and activate exactly one persistent player.",
        args: { definition: tool.schema.string() },
        execute: async ({ definition }, execution) => {
          if (execution.agent !== scoutPlayer.name) throw new Error("harbor_join_player is available only to talent-scout");
          const currentDirectory = execution.directory || directory;
          const context = await harborContext("opencode", currentDirectory, new OpenCodeOrchestrator(client, currentDirectory));
          return executeCommand("join", definition, context, execution.abort);
        },
      }),
      harbor_delegate: tool({
        description: "Team-lead only: run one exact active Agent Harbor player in a child session. The target is ownership-validated against the live roster at invocation time, including players added by /join during this session.",
        args: { agent: tool.schema.string(), task: tool.schema.string() },
        execute: async ({ agent, task }, execution) => {
          if (execution.agent !== "team-lead") throw new Error("harbor_delegate is available only to team-lead");
          if (!task.trim()) throw new Error("harbor_delegate requires a non-empty task");
          if (agent === "team-lead") throw new Error("harbor_delegate cannot recursively invoke team-lead");
          const currentDirectory = execution.directory || directory;
          assertInvocablePlayer("opencode", currentDirectory, agent);
          const originatingTurn = await originatingUserMessage(execution.sessionID, execution.messageID, currentDirectory);
          const key = `${execution.sessionID}\u0000${originatingTurn.id}`;
          const count = delegationCounts.get(key) ?? 0;
          if (count >= 6) throw new Error("harbor_delegate allows at most six delegations per user turn");
          if (delegationsInFlight.has(key)) throw new Error("harbor_delegate calls must run sequentially");
          const seenAgents = delegatedAgents.get(key) ?? new Set<string>();
          if (seenAgents.has(agent)) throw new Error(`harbor_delegate already delegated to ${agent} in this user turn`);
          if (!delegationCounts.has(key) && delegationCounts.size >= 1_024) {
            const oldest = delegationCounts.keys().next().value!;
            delegationCounts.delete(oldest);
            delegatedAgents.delete(oldest);
          }
          delegationCounts.set(key, count + 1);
          seenAgents.add(agent);
          delegatedAgents.set(key, seenAgents);
          delegationsInFlight.add(key);
          try {
            return await new OpenCodeOrchestrator(client, currentDirectory).runAgent(
              agent,
              normalizeDelegatedTaskPaths(task, currentDirectory),
              execution.sessionID,
              originatingTurn.model,
              execution.abort,
            );
          }
          finally { delegationsInFlight.delete(key); }
        },
      }),
      agent_harbor_skills: tool({
        description: "Load only the complete skill group configured for the current Agent Harbor player.",
        args: {},
        execute: async (_args, execution) => {
          const currentDirectory = execution.directory || directory;
          const player = requireInvocablePlayer("opencode", currentDirectory, execution.agent).definition;
          const loaded = await loadConfiguredSkills(player, currentDirectory, new GhResolver(), trustedSkills, execution.abort);
          return formatLoadedSkillGroup(loaded);
        },
      }),
    },
  };
};

export default AgentHarborPlugin;
