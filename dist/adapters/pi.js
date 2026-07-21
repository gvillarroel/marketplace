/** Pi extension entrypoint, direct controls, player commands, and delegation. */
import * as hostPiSdk from "@earendil-works/pi-coding-agent";
import { listInvocablePlayerIds, listManagedActiveIds, loadPiActivePlayer } from "../core/active.js";
import { executeCommand } from "../core/commands.js";
import { runDeterministicCommand } from "./direct.js";
import { bundledPlayers, rolePlayers } from "../core/defaults.js";
import { commandNames } from "../core/types.js";
import { normalizeDelegatedTaskPaths } from "../core/profiles.js";
import { PiOrchestrator } from "../orchestrators/pi.js";
import { harborContext } from "./shared.js";
const idPattern = /^[a-z0-9][a-z0-9-]{0,47}$/;
/**
 * Registers Agent Harbor's command and tool surface in the active Pi host.
 * Active profiles are read from private Harbor storage and invoked through a
 * real in-memory child; Pi's ambient agent/skill discovery is never trusted.
 */
export default function agentHarbor(pi) {
    const registered = new Set();
    const loadHostSdk = async () => hostPiSdk;
    const currentSessionOptions = (model) => ({
        ...(model === undefined ? {} : { model }),
        thinkingLevel: pi.getThinkingLevel(),
    });
    const createOrchestrator = (cwd, sessionOptions, additionalTools = [], customTools = []) => new PiOrchestrator(cwd, loadHostSdk, additionalTools, undefined, customTools, undefined, sessionOptions);
    const createDelegateTool = (cwd, leadSessionOptions) => {
        // Delegation state is invocation-scoped because a fresh tool is created for
        // each team-lead child. This enforces sequential, at-most-once specialists.
        let calls = 0;
        const delegatedAgents = new Set();
        const delegationTargets = listInvocablePlayerIds("pi", cwd).filter((id) => id !== "team-lead");
        const delegationRoster = delegationTargets.map((id) => {
            const definition = rolePlayers.get(id) ?? bundledPlayers.get(id);
            return `${id}: ${definition?.description ?? "active personal Agent Harbor player"}`;
        }).join("; ");
        return {
            name: "harbor_delegate",
            label: "Agent Harbor Delegate",
            description: `Run one active named Agent Harbor specialist and return its evidence. Active targets: ${delegationRoster}.`,
            executionMode: "sequential",
            parameters: {
                type: "object",
                properties: {
                    agent: { type: "string", enum: delegationTargets, description: "Exact active Agent Harbor agent ID" },
                    task: { type: "string", description: "Complete bounded task for that agent" },
                },
                required: ["agent", "task"],
                additionalProperties: false,
            },
            execute: async (_id, params, signal, _update, context) => {
                const project = context?.cwd || cwd;
                if (typeof params.agent !== "string" || !idPattern.test(params.agent) || params.agent === "team-lead")
                    throw new Error("invalid or recursive delegation target");
                if (typeof params.task !== "string" || !params.task.trim())
                    throw new Error("delegation requires a non-empty task");
                const player = rolePlayers.get(params.agent) ?? loadPiActivePlayer(project, params.agent);
                if (calls >= 6)
                    throw new Error("delegation limit reached (6)");
                if (delegatedAgents.has(params.agent))
                    throw new Error(`already delegated to ${params.agent} in this team-lead run`);
                calls += 1;
                delegatedAgents.add(params.agent);
                const delegateSessionOptions = {
                    ...leadSessionOptions,
                    ...(context.model === undefined ? {} : { model: context.model }),
                };
                const text = await createOrchestrator(project, delegateSessionOptions).run({
                    ...player,
                    task: normalizeDelegatedTaskPaths(params.task, project),
                }, signal);
                return { content: [{ type: "text", text }], details: { harness: "pi", agent: params.agent, call: calls } };
            },
        };
    };
    const runPlayer = async (player, task, cwd, model, thinkingLevel) => {
        if (!task.trim())
            throw new Error(`/${player.name} requires a non-empty task`);
        const sessionOptions = { ...(model === undefined ? {} : { model }), thinkingLevel };
        const customTools = player.name === "team-lead" ? [createDelegateTool(cwd, sessionOptions)] : [];
        const additionalTools = customTools.map((tool) => tool.name);
        return createOrchestrator(cwd, sessionOptions, additionalTools, customTools).run({ ...player, task });
    };
    const registerPlayer = (id, fixed) => {
        if (registered.has(id))
            return;
        pi.registerCommand(id, {
            description: fixed?.description ?? `Run active Agent Harbor player ${id}`,
            handler: async (args, ctx) => {
                try {
                    ctx.ui.notify(await runPlayer(fixed ?? loadPiActivePlayer(ctx.cwd, id), args, ctx.cwd, ctx.model, pi.getThinkingLevel()), "info");
                }
                catch (error) {
                    ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
                }
            },
        });
        registered.add(id);
    };
    const syncActivePlayers = (project) => { for (const id of listManagedActiveIds("pi", project))
        registerPlayer(id); };
    pi.registerTool({
        name: "harbor_contract",
        label: "Agent Harbor Contract",
        description: "Run exactly one invocation-scoped Agent Harbor child through the Pi SDK.",
        executionMode: "sequential",
        parameters: {
            type: "object",
            properties: { definition: { type: "string", description: "Complete /contract JSON object" } },
            required: ["definition"],
            additionalProperties: false,
        },
        execute: async (_id, params, signal, _update, ctx) => {
            const context = harborContext("pi", ctx.cwd, createOrchestrator(ctx.cwd, currentSessionOptions(ctx.model)));
            const text = await executeCommand("contract", params.definition, context, signal);
            return { content: [{ type: "text", text }], details: { harness: "pi" } };
        },
    });
    for (const name of commandNames) {
        pi.registerCommand(name, {
            description: `Agent Harbor ${name} control`,
            handler: async (args, ctx) => {
                try {
                    const result = name === "contract"
                        ? await executeCommand(name, args, harborContext("pi", ctx.cwd, createOrchestrator(ctx.cwd, currentSessionOptions(ctx.model))))
                        : await runDeterministicCommand("pi", name, args, ctx.cwd);
                    if (name === "join" || name === "bench")
                        syncActivePlayers(ctx.cwd);
                    ctx.ui.notify(result, "info");
                }
                catch (error) {
                    ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
                }
            },
        });
        registered.add(name);
    }
    for (const [id, player] of rolePlayers)
        registerPlayer(id, player);
    syncActivePlayers(process.cwd());
}
