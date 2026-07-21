import { tool } from "@opencode-ai/plugin";
import { assertInvocablePlayer, listInvocablePlayerIds, listManagedActiveIds, listOwnedActiveIds, loadManagedActivePlayer, requireInvocablePlayer } from "../core/active.js";
import { executeCommand } from "../core/commands.js";
import { bundledPlayers, rolePlayers, trustedSkills } from "../core/defaults.js";
import { GhResolver } from "../core/github.js";
import { composePlayerInstructions, normalizeDelegatedTaskPaths, openCodePermissionPolicy, openCodeToolPolicy } from "../core/profiles.js";
import { formatLoadedSkillGroup, loadConfiguredSkills } from "../core/skills.js";
import { commandNames } from "../core/types.js";
import { OpenCodeOrchestrator } from "../orchestrators/opencode.js";
import { harborContext } from "./shared.js";
/**
 * Creates the OpenCode plugin configuration, command tools, named players, and
 * bounded team-lead delegation for the current project directory.
 */
export const AgentHarborPlugin = async ({ client, directory }) => {
    const teamLead = rolePlayers.get("team-lead");
    const repoCartographer = rolePlayers.get("repo-cartographer");
    const crafter = rolePlayers.get("crafter");
    const delegationTargets = listInvocablePlayerIds("opencode", directory).filter((id) => id !== "team-lead");
    const delegationRoster = delegationTargets.map((id) => {
        const definition = rolePlayers.get(id) ?? bundledPlayers.get(id);
        return `${id}: ${definition?.description ?? "active personal Agent Harbor player"}`;
    }).join("; ");
    const delegationCounts = new Map();
    const delegatedAgents = new Map();
    const delegationsInFlight = new Set();
    const directAgentCommands = new Map();
    const turnModels = new Map();
    for (const id of [...rolePlayers.keys(), ...bundledPlayers.keys()])
        directAgentCommands.set(`harbor-${id}`, id);
    const originatingUserMessage = async (sessionID, messageID, currentDirectory) => {
        // SDK-created assistant messages do not reliably repeat the root model.
        // Walk the bounded ancestry and recover the explicit originating user turn.
        const seen = new Set();
        let cursor = messageID;
        for (let depth = 0; depth < 64; depth += 1) {
            if (seen.has(cursor))
                throw new Error("harbor_delegate found a cyclic message ancestry");
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
                const typedInfo = message.data.info;
                const typedModel = model;
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
            if (message.data.info.role !== "assistant" || !message.data.info.parentID)
                break;
            cursor = message.data.info.parentID;
        }
        throw new Error("harbor_delegate could not identify the originating user turn");
    };
    return {
        "chat.message": async (input, output) => {
            const messageID = input.messageID ?? output.message.id;
            const model = input.model ?? output.message.model;
            const typedMessage = output.message;
            const variant = input.variant ?? typedMessage.variant ?? typedMessage.model.variant;
            if (!messageID || !model?.providerID.trim() || !model.modelID.trim())
                return;
            if (turnModels.size >= 1_024 && !turnModels.has(`${input.sessionID}\u0000${messageID}`)) {
                turnModels.delete(turnModels.keys().next().value);
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
            for (const name of commandNames)
                config.command[name] = {
                    description: `Agent Harbor ${name} model-routed fallback; prefer the direct TUI or agent-harbor CLI control`,
                    template: `Call the harbor tool exactly once with command ${JSON.stringify(name)} and args $ARGUMENTS. Return its result verbatim.`,
                };
            for (const id of listInvocablePlayerIds("opencode", directory)) {
                const command = `harbor-${id}`;
                directAgentCommands.set(command, id);
                config.command[command] = {
                    description: `Run Agent Harbor player ${id} in the current session`,
                    template: "$ARGUMENTS",
                    agent: id,
                    subtask: false,
                };
            }
            config.agent = {
                ...(config.agent ?? {}),
                "team-lead": {
                    description: teamLead.description, mode: "subagent",
                    steps: 7,
                    prompt: `${composePlayerInstructions(teamLead)} In OpenCode, harbor_delegate is the named delegation tool; select only an exact active target from its enum and provide a complete non-empty task.`,
                    tools: { ...openCodeToolPolicy([]), harbor_delegate: true },
                    permission: openCodePermissionPolicy([], ["harbor_delegate"], directory),
                },
                "repo-cartographer": {
                    description: repoCartographer.description, mode: "subagent",
                    steps: 4,
                    prompt: composePlayerInstructions(repoCartographer),
                    tools: { ...openCodeToolPolicy(repoCartographer.tools), harbor_delegate: false },
                    permission: openCodePermissionPolicy(repoCartographer.tools, [], directory),
                },
                crafter: {
                    description: crafter.description, mode: "subagent",
                    steps: 4,
                    prompt: composePlayerInstructions(crafter, "opencode"),
                    tools: { ...openCodeToolPolicy(crafter.tools, ["agent_harbor_skills"]), harbor_delegate: false },
                    permission: openCodePermissionPolicy(crafter.tools, ["agent_harbor_skills"], directory),
                },
            };
            const managedIds = new Set(listManagedActiveIds("opencode", directory));
            // Owned-but-stale profiles must be removed from host discovery. Leaving
            // an old host entry could silently retain broader tools than revision 4.
            for (const id of listOwnedActiveIds("opencode", directory)) {
                if (!managedIds.has(id))
                    delete config.agent[id];
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
            if (!id)
                return;
            if (!args.trim())
                throw new Error(`/${command} requires a non-empty task`);
            assertInvocablePlayer("opencode", directory, id);
        },
        tool: {
            harbor: tool({
                description: "Execute one deterministic Agent Harbor lifecycle or orchestration command.",
                args: { command: tool.schema.enum(commandNames), args: tool.schema.string() },
                execute: async ({ command, args }, execution) => {
                    const currentDirectory = execution.directory || directory;
                    const context = await harborContext("opencode", currentDirectory, new OpenCodeOrchestrator(client, currentDirectory));
                    return executeCommand(command, args, context, execution.abort);
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
            harbor_delegate: tool({
                description: `Team-lead only: run one exact active Agent Harbor player in a child session. Active targets: ${delegationRoster}.`,
                args: { agent: tool.schema.enum(delegationTargets), task: tool.schema.string() },
                execute: async ({ agent, task }, execution) => {
                    if (execution.agent !== "team-lead")
                        throw new Error("harbor_delegate is available only to team-lead");
                    if (!task.trim())
                        throw new Error("harbor_delegate requires a non-empty task");
                    if (agent === "team-lead")
                        throw new Error("harbor_delegate cannot recursively invoke team-lead");
                    const currentDirectory = execution.directory || directory;
                    assertInvocablePlayer("opencode", currentDirectory, agent);
                    const originatingTurn = await originatingUserMessage(execution.sessionID, execution.messageID, currentDirectory);
                    const key = `${execution.sessionID}\u0000${originatingTurn.id}`;
                    const count = delegationCounts.get(key) ?? 0;
                    if (count >= 6)
                        throw new Error("harbor_delegate allows at most six delegations per user turn");
                    if (delegationsInFlight.has(key))
                        throw new Error("harbor_delegate calls must run sequentially");
                    const seenAgents = delegatedAgents.get(key) ?? new Set();
                    if (seenAgents.has(agent))
                        throw new Error(`harbor_delegate already delegated to ${agent} in this user turn`);
                    if (!delegationCounts.has(key) && delegationCounts.size >= 1_024) {
                        const oldest = delegationCounts.keys().next().value;
                        delegationCounts.delete(oldest);
                        delegatedAgents.delete(oldest);
                    }
                    delegationCounts.set(key, count + 1);
                    seenAgents.add(agent);
                    delegatedAgents.set(key, seenAgents);
                    delegationsInFlight.add(key);
                    try {
                        return await new OpenCodeOrchestrator(client, currentDirectory).runAgent(agent, normalizeDelegatedTaskPaths(task, currentDirectory), execution.sessionID, originatingTurn.model, execution.abort);
                    }
                    finally {
                        delegationsInFlight.delete(key);
                    }
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
