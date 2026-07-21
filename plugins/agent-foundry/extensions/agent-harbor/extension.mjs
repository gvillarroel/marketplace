/**
 * Copilot extension bootstrap. It registers zero-model lifecycle commands,
 * direct player invocations, and the coordinator hook guard while delegating
 * all business rules to the generated TypeScript runtime.
 */
import { joinSession } from "@github/copilot-sdk/extension";
import {
  copilotFixedAgentIds,
  createCopilotCoordinatorGuard,
  listCopilotActiveProfileIds,
  resolveCopilotPlayer,
} from "../../runtime/dist/adapters/copilot-coordinator.js";
import { runDeterministicCommand } from "../../runtime/dist/adapters/direct.js";
import { bundledPlayers, rolePlayers, scoutPlayer } from "../../runtime/dist/core/defaults.js";

const controls = [
  ["bench", "List, activate, or deactivate Agent Harbor players without a model request."],
  ["join", "Register an Agent Harbor player without a model request."],
  ["retire", "Retire an Agent Harbor player without a model request."],
  ["list-skills", "List trusted Agent Harbor skill snapshots without a model request."],
];

function activeProfileIds(project) { return listCopilotActiveProfileIds(project); }

let selectionQueue = Promise.resolve();
function withSelectionLock(action) {
  // Direct invocations temporarily change the host's selected agent. Serialize
  // them so every call can restore the selection it actually observed.
  const result = selectionQueue.then(action, action);
  selectionQueue = result.then(() => undefined, () => undefined);
  return result;
}

let session;

async function runPlayer(id, rawTask, command = id) {
  const task = rawTask?.trim() ?? "";
  if (!task) throw new Error(`usage: /${command} <task>`);

  return withSelectionLock(async () => {
    const metadata = await session.rpc.metadata.snapshot();
    const project = metadata.workingDirectory ?? process.cwd();
    if (id !== scoutPlayer.name && !copilotFixedAgentIds.has(id) && !(await activeProfileIds(project)).includes(id)) {
      throw new Error(`Agent Harbor player is not active: ${id}; run /bench on ${id}`);
    }

    const previous = await session.rpc.agent.getCurrent();
    await session.rpc.agent.reload();
    const listed = await session.rpc.agent.list();
    const agent = resolveCopilotPlayer(id, listed.agents, project);
    if (agent.userInvocable === false) throw new Error(`Agent Harbor player is not directly invocable: ${id}`);

    let selectionAttempted = false;
    let failure;
    try {
      selectionAttempted = true;
      await session.rpc.agent.select({ name: agent.id });
      await session.sendAndWait({ prompt: task });
    } catch (error) {
      failure = error;
    }

    if (selectionAttempted) {
      // Restoring host selection is part of the operation. Preserve both the
      // task and restoration failures when they happen together.
      try {
        if (previous.agent) await session.rpc.agent.select({ name: previous.agent.id });
        else await session.rpc.agent.deselect();
      } catch (restoreError) {
        if (failure) throw new AggregateError([failure, restoreError], `Agent Harbor task and selection restore failed: ${id}`);
        throw restoreError;
      }
    }
    if (failure) throw failure;
  });
}

const knownPlayers = new Map([...rolePlayers, ...bundledPlayers]);
const startupActiveIds = activeProfileIds(process.cwd());
const callableIds = [...new Set([...knownPlayers.keys(), ...startupActiveIds])];

const guardEvidenceQueue = [];
let guardEvidenceLogging = Promise.resolve();
const coordinator = createCopilotCoordinatorGuard(() => session, (event) => {
  // Only bounded fingerprints and correlation metadata are logged; raw tasks
  // and child responses never enter the extension evidence stream.
  if (event.phase !== "target.resolved") return;
  guardEvidenceQueue.push({
    schema: event.schema,
    source: event.source,
    basis: event.basis,
    phase: event.phase,
    harness: event.harness,
    agent: event.agent,
    runtimeAgent: event.runtimeAgent,
    invocationId: event.invocationId,
    outcome: event.outcome,
    task: event.task,
  });
});
session = await joinSession({
  hooks: coordinator.hooks,
  commands: [
    ...controls.map(([name, description]) => ({
      name,
      description,
      handler: async ({ args }) => {
        try {
          const metadata = await session.rpc.metadata.snapshot();
          const result = await runDeterministicCommand("copilot", name, args ?? "", metadata.workingDirectory ?? process.cwd(), undefined, name === "list-skills" ? "copilot" : "plain");
          const value = (args ?? "").trim();
          if (name === "join" || name === "retire" || (name === "bench" && /^(on|off)\b/.test(value))) {
            await coordinator.refresh();
          }
          const heading = name === "list-skills" ? "Agent Harbor · skill catalog · 0 model tokens" : "Agent Harbor direct · 0 model tokens";
          await session.log(`[${heading}]\n${result || "Done."}`, { level: "info", ephemeral: true });
        } catch (error) {
          await session.log(`[Agent Harbor direct · no model request]\n${error instanceof Error ? error.message : String(error)}`, { level: "error", ephemeral: true });
          throw error;
        }
      },
    })),
    {
      name: "scout",
      description: "Recruit and join one player from Agent Harbor's limited trusted skill group.",
      handler: async ({ args }) => {
        try { await runPlayer(scoutPlayer.name, args, "scout"); }
        catch (error) {
          await session.log(`[Agent Harbor scout]\n${error instanceof Error ? error.message : String(error)}`, { level: "error", ephemeral: true });
          throw error;
        }
      },
    },
    ...callableIds.map((id) => ({
      name: id,
      description: knownPlayers.get(id)?.description ?? `Run active Agent Harbor player ${id} for one explicit task.`,
      handler: async ({ args }) => {
        try {
          await runPlayer(id, args);
        } catch (error) {
          await session.log(`[Agent Harbor player · ${id}]\n${error instanceof Error ? error.message : String(error)}`, { level: "error", ephemeral: true });
          throw error;
        }
      },
    })),
  ],
});
session.on((event) => {
  coordinator.observeEvent(event);
  if (event.type !== "hook.end" || event.data.hookType !== "preToolUse") return;
  const evidence = guardEvidenceQueue.shift();
  if (!evidence) return;
  const message = JSON.stringify(evidence);
  const logEvidence = async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await session.log(message, { level: "info", type: "agent-harbor-guard", ephemeral: true });
        return;
      } catch {
        if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
      }
    }
  };
  guardEvidenceLogging = guardEvidenceLogging.then(logEvidence, logEvidence);
});
await coordinator.refresh();
