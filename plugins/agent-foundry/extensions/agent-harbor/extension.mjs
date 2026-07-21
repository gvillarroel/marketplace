/**
 * Copilot extension bootstrap. Deterministic controls never send a prompt;
 * explicit player commands select one validated native agent for one bounded
 * host turn and expose process-local activity through `/team`.
 */
import { joinSession } from "@github/copilot-sdk/extension";
import {
  copilotFixedAgentIds,
  createCopilotCoordinatorGuard,
  listCopilotActiveProfileIds,
  resolveCopilotPlayer,
} from "../../runtime/dist/adapters/copilot-coordinator.js";
import {
  copilotPublicIdentifier,
  CopilotTeamRuntime,
  formatCopilotMissionReport,
} from "../../runtime/dist/adapters/copilot-team-runtime.js";
import {
  formatCopilotDegradedTeamView,
  formatCopilotTeamView,
} from "../../runtime/dist/adapters/copilot-team-view.js";
import { runDeterministicCommand } from "../../runtime/dist/adapters/direct.js";
import { bundledPlayers, rolePlayers, scoutPlayer } from "../../runtime/dist/core/defaults.js";
import { isHarborId } from "../../runtime/dist/core/identity.js";
import { wrapPlainText } from "../../runtime/dist/core/text-layout.js";

const controls = [
  ["bench", "0 model tokens · Inspect, activate, or deactivate Agent Harbor teammates."],
  ["join", "0 model tokens · Validate, persist, and activate one personal teammate."],
  ["retire", "0 model tokens · Unregister one personal teammate and deactivate it here."],
  ["list-skills", "0 model tokens · Search trusted skill snapshots and optional public descriptions."],
];
const directTimeoutMs = boundedEnvironmentNumber("AGENT_HARBOR_COPILOT_TIMEOUT_MS", 180_000, 1_000, 600_000);
const abortSettlementMs = boundedEnvironmentNumber("AGENT_HARBOR_COPILOT_SETTLE_MS", 10_000, 250, 60_000);
const hostRpcTimeoutMs = boundedEnvironmentNumber("AGENT_HARBOR_COPILOT_RPC_TIMEOUT_MS", 15_000, 250, 60_000);
const logRpcTimeoutMs = boundedEnvironmentNumber("AGENT_HARBOR_COPILOT_LOG_TIMEOUT_MS", 3_000, 100, 15_000);
const teamBudgetMs = boundedEnvironmentNumber("AGENT_HARBOR_COPILOT_TEAM_BUDGET_MS", 2_200, 500, 3_000);
const teamFormatTimeoutMs = boundedEnvironmentNumber(
  "AGENT_HARBOR_COPILOT_TEAM_FORMAT_TIMEOUT_MS",
  teamBudgetMs,
  1,
  3_000,
);
const startupRefreshTimeoutMs = Math.min(300, teamBudgetMs);

function boundedEnvironmentNumber(name, fallback, minimum, maximum) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, Math.floor(value))) : fallback;
}

class HostRpcTimeoutError extends Error {
  constructor(label, timeoutMs) {
    super(`${label} timed out after ${timeoutMs}ms`);
    this.name = "HostRpcTimeoutError";
  }
}

class PlayerPreflightError extends Error {
  constructor(message, cause) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "PlayerPreflightError";
  }
}

async function boundedHostCall(label, action, timeoutMs = hostRpcTimeoutMs) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(action),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new HostRpcTimeoutError(label, timeoutMs)), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function boundedTeamCall(label, action, deadline, maximumSliceMs) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new HostRpcTimeoutError(label, 0);
  return boundedHostCall(label, action, Math.max(1, Math.min(remaining, maximumSliceMs)));
}

function activeProfileIds(project) { return listCopilotActiveProfileIds(project); }
function errorMessage(error) { return error instanceof Error ? error.message : String(error); }
function memberKind(id) {
  if (id === "contract") return "utility";
  if (id === "team-lead") return "manager";
  if (rolePlayers.has(id)) return "fixed";
  if (id === scoutPlayer.name) return "utility";
  if (bundledPlayers.has(id)) return "bundled";
  return "personal";
}

function benchListFilter(args) {
  const value = args?.trim() ?? "";
  if (!value || value === "list") return "";
  return value.startsWith("list ") ? value.slice(5).trim() : undefined;
}

function conciseCopilotJoinResult(args) {
  const input = JSON.parse(args);
  const id = copilotPublicIdentifier(input.name, 48) ?? "joined-player";
  const role = copilotPublicIdentifier(input.description, 240) ?? "Personal Agent Harbor teammate";
  const tools = Array.isArray(input.tools)
    ? input.tools.flatMap((tool) => copilotPublicIdentifier(tool, 80) ?? [])
    : [];
  const skills = Array.isArray(input.skills)
    ? input.skills.flatMap((skill) => copilotPublicIdentifier(skill?.name, 80) ? [`skill:${copilotPublicIdentifier(skill.name, 80)}`] : [])
    : [];
  const capacity = [...tools, ...skills].join(", ") || "advisory";
  return [
    `✓ ${id} joined · personal · ready in this project`,
    `Role: ${role}`,
    `Capacity: ${capacity}`,
    `Run now: /player ${id} <task>`,
    `After restarting Copilot: /${id} <task>`,
  ].join("\n");
}

async function inactivePlayerError(id, project) {
  if (bundledPlayers.has(id)) {
    return `Agent Harbor player is benched: ${id}; run /bench on ${id}`;
  }
  try {
    const inventory = await runDeterministicCommand("copilot", "bench", `list ${id}`, project);
    if (new RegExp(`^${id} \\| personal \\| bench$`, "mu").test(inventory)) {
      return `Agent Harbor personal player is benched: ${id}; run /bench on ${id}`;
    }
    if (new RegExp(`^${id} \\| personal \\| (?:stale|conflict)$`, "mu").test(inventory)) {
      return `Agent Harbor personal player needs repair: ${id}; inspect /team ${id}, then re-run /join with the full definition and "replace":true if owned`;
    }
  } catch { /* Preserve the missing/retired remediation below. */ }
  return `Agent Harbor personal player is missing or retired: ${id}; re-run /join with the full definition or inspect /team ${id}`;
}

let session;
const runtime = new CopilotTeamRuntime();
const correlationRuns = new Map();
const abortableRoots = new Map();
let activeDirect;
let unsettledSelection;
let selectionRestoreHazard;
let coordinatorReady = false;
let selectionQueue = Promise.resolve();
let notificationLogPending = false;
let lastKnownProject;
let projectScopeVerified = false;

function rememberProjectScope(project) {
  if (typeof project !== "string" || !project.trim()) return undefined;
  lastKnownProject = project;
  projectScopeVerified = true;
  return project;
}

function safeLog(message, options = {}) {
  if (notificationLogPending) return Promise.resolve();
  notificationLogPending = true;
  return emitLog(message, options)
    .catch(() => undefined)
    .finally(() => { notificationLogPending = false; });
}

function displayLog(message, options = {}) {
  return emitLog(message, options);
}

function emitLog(message, options = {}) {
  return boundedHostCall(
    "Copilot session.log",
    () => session.log(wrapPlainText(message), { ephemeral: true, ...options }),
    logRpcTimeoutMs,
  );
}

function withSelectionLock(action) {
  const result = selectionQueue.then(action, action);
  selectionQueue = result.then(() => undefined, () => undefined);
  return result;
}

function deferred() {
  let resolve;
  const promise = new Promise((settle) => { resolve = settle; });
  return { promise, resolve };
}

function delay(ms, value) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(value), ms);
    timer.unref?.();
  });
}

async function currentProject() {
  const metadata = await boundedHostCall("Copilot metadata snapshot", () => session.rpc.metadata.snapshot());
  const observed = rememberProjectScope(metadata.workingDirectory);
  if (observed) return observed;
  if (projectScopeVerified && lastKnownProject) return lastKnownProject;
  throw new Error("Copilot project scope is unavailable; project-scoped controls fail closed");
}

async function currentModelSettings() {
  try {
    const current = await boundedHostCall("Copilot current model", () => session.rpc.model.getCurrent());
    return {
      model: current.modelId,
      reasoningEffort: current.reasoningEffort === null ? "none" : current.reasoningEffort,
    };
  } catch {
    return {};
  }
}

async function restoreSelection(previous) {
  const failures = [];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      if (previous.agent) {
        await boundedHostCall("Copilot selection restore", () => session.rpc.agent.select({ name: previous.agent.id }));
      } else {
        await boundedHostCall("Copilot selection restore", () => session.rpc.agent.deselect());
      }
      await boundedHostCall("Copilot coordinator refresh", () => coordinator.refreshAuthoritative());
      coordinatorReady = true;
      return;
    } catch (error) {
      failures.push(error);
      if (attempt < 2) await delay(50 * (attempt + 1));
    }
  }
  throw new AggregateError(failures, "Copilot selection restore failed after three bounded attempts");
}

function finishDirectRuntime(runId, terminal) {
  runtime.finishIfOpen(runId, terminal.outcome);
  releaseDirectControl(runId);
}

function releaseDirectControl(runId) {
  abortableRoots.delete(runId);
  if (activeDirect?.runId === runId) activeDirect = undefined;
}

async function runPlayer(id, rawTask, command = id) {
  const task = rawTask?.trim() ?? "";
  if (!task) throw new PlayerPreflightError(`usage: /${command} ${command === "player" ? "<id> <task>" : "<task>"}`);
  if (!isHarborId(id)) throw new PlayerPreflightError("invalid Agent Harbor player ID; expected 1-48 lowercase letters, digits, or hyphens");
  if (Buffer.byteLength(task, "utf8") > 30_000) throw new PlayerPreflightError("Agent Harbor task exceeds 30000 bytes");

  let modelAttempted = false;
  try {
    return await withSelectionLock(async () => {
    if (selectionRestoreHazard) {
      throw new Error(`Agent Harbor could not prove selection restoration after ${selectionRestoreHazard}; reload the Copilot session before running another player`);
    }
    if (coordinator.lifecycleIdentityUnverified()) {
      throw new Error("Agent Harbor lifecycle identity is unverified; reload the Copilot session before running another player");
    }
    if (unsettledSelection) {
      throw new Error(`Agent Harbor is still waiting for ${unsettledSelection.runId} to settle; run /team and wait before selecting another player`);
    }
    const project = await currentProject();
    const [activity, processing] = await Promise.all([
      boundedHostCall("Copilot session activity", () => session.rpc.metadata.activity()),
      boundedHostCall("Copilot processing state", () => session.rpc.metadata.isProcessing()),
    ]);
    const tracked = runtime.activeProjectRuns(project).find((run) => !run.parentRunId);
    if (activity.hasActiveWork || processing.processing || tracked) {
      const detail = tracked ? ` (tracked as ${tracked.rootRunId})` : "";
      throw new Error(`Copilot already has active work${detail}; wait or use /team stop <run-id|all> before selecting another player`);
    }
    if (id !== scoutPlayer.name && !copilotFixedAgentIds.has(id) && !activeProfileIds(project).includes(id)) {
      throw new Error(await inactivePlayerError(id, project));
    }

    const previous = await boundedHostCall("Copilot current agent", () => session.rpc.agent.getCurrent());
    await boundedHostCall("Copilot agent reload", () => session.rpc.agent.reload());
    const listed = await boundedHostCall("Copilot agent list", () => session.rpc.agent.list());
    if (!coordinatorReady) {
      await boundedHostCall("Copilot coordinator refresh", () => coordinator.refreshAuthoritative());
      coordinatorReady = true;
    }
    const agent = resolveCopilotPlayer(id, listed.agents, project);
    if (agent.userInvocable === false) throw new Error(`Agent Harbor player is not directly invocable: ${id}`);
    const model = await currentModelSettings();
    const runId = runtime.begin({
      project,
      agent: id,
      kind: memberKind(id),
      task,
      ...model,
      model: agent.model ?? model.model,
      modelSource: agent.model ? "configured" : "inherited",
    });
    const terminal = deferred();
    let terminalValue;
    let selectionAttempted = false;
    let sendAccepted = false;
    let lateSettlement = false;
    let restored = false;
    let primaryFailure;
    let ambiguousSelection = false;
    let finalTerminal;
    let showCompletion = false;
    let stopRequested = false;
    let promptAttempted = false;
    let promptPhase = "before";
    const acceptanceTerminals = [];
    const directStartedAt = runtime.get(runId)?.startedAt ?? Date.now();
    const directEventIds = new Set();
    let idleValidationGeneration = 0;
    const settle = (value) => {
      if (terminalValue) return;
      terminalValue = value;
      terminal.resolve(value);
    };
    const settleStrong = (value) => {
      if (promptPhase === "accepting" && !stopRequested) acceptanceTerminals.push({ kind: "error", value });
      else settle(value);
    };
    const directTimestamp = (event) => event.timestamp === undefined ? Number.NaN : Date.parse(event.timestamp);
    const directTimestampIsCurrent = (event) => {
      const timestamp = directTimestamp(event);
      return !Number.isFinite(timestamp) || timestamp >= directStartedAt;
    };
    const directOpaqueId = (value) => typeof value === "string" && value ? value : undefined;
    const directEventBelongs = (event) => {
      if (!directTimestampIsCurrent(event)) return false;
      const parentId = directOpaqueId(event.parentId);
      if (parentId !== undefined) return directEventIds.has(parentId) || directEventIds.size === 0;
      const timestamp = directTimestamp(event);
      if (Number.isFinite(timestamp)) return true;
      // Untimed, unparented events can seed a run only with a new native ID.
      // Anonymous events are indistinguishable from a previous run and remain
      // unclaimed rather than inventing terminal or usage ownership.
      if (!directOpaqueId(event.id)) return false;
      if (directEventIds.size === 0) return true;
      return false;
    };
    const rememberDirectEvent = (event) => {
      const eventId = directOpaqueId(event.id);
      if (!eventId || directEventIds.has(eventId)) return;
      if (directEventIds.size >= 256) {
        const oldest = directEventIds.values().next().value;
        if (oldest) directEventIds.delete(oldest);
      }
      directEventIds.add(eventId);
    };
    const validateAcceptedIdle = (event, value) => {
      const generation = ++idleValidationGeneration;
      const timestamp = directTimestamp(event);
      const parentId = directOpaqueId(event.parentId);
      if (Number.isFinite(timestamp) && parentId && directEventIds.has(parentId)) {
        settle(value);
        return;
      }
      if (stopRequested && event.data?.aborted) {
        settle(value);
        return;
      }
      void Promise.all([
        boundedHostCall("Copilot terminal activity", () => session.rpc.metadata.activity()),
        boundedHostCall("Copilot terminal processing state", () => session.rpc.metadata.isProcessing()),
      ]).then(([activity, processing]) => {
        if (generation !== idleValidationGeneration || terminalValue) return;
        if (!activity.hasActiveWork && !processing.processing) settle(value);
      }).catch(() => undefined);
    };
    const reconcileAcceptanceTerminals = async () => {
      if (!acceptanceTerminals.length || terminalValue) return;
      const errorCandidate = acceptanceTerminals.find(({ kind }) => kind === "error");
      if (errorCandidate) {
        acceptanceTerminals.length = 0;
        settle(errorCandidate.value);
        return;
      }
      // A pre-acceptance idle may belong to the previous turn. Give host
      // activity one tick to stabilize; an observed error is never discarded.
      await delay(20);
      try {
        const [activity, processing] = await Promise.all([
          boundedHostCall("Copilot post-acceptance activity", () => session.rpc.metadata.activity()),
          boundedHostCall("Copilot post-acceptance processing state", () => session.rpc.metadata.isProcessing()),
        ]);
        if (!activity.hasActiveWork && !processing.processing) {
          const candidate = acceptanceTerminals.at(-1);
          if (candidate) settle(candidate.value);
        }
      } catch { /* Uncertain host state must not restore selection early. */ }
      acceptanceTerminals.length = 0;
    };
    const unsubscribe = session.on((event) => {
      if (!promptAttempted && !stopRequested) return;
      const hostDisposition = coordinator.hostEventDisposition(event);
      if (hostDisposition === "replay") return;
      if (hostDisposition === "unverified") return;
      if (coordinator.hostEventWasClaimed(event) === false) return;
      // Copilot may omit agentId on a child usage event while retaining the
      // deprecated-but-authoritative parent task correlation.
      const childScoped = Boolean(event.agentId || event.data?.parentToolCallId || event.data?.initiator === "sub-agent");
      if (childScoped) {
        if (directEventBelongs(event)) rememberDirectEvent(event);
        return;
      }
      if (event.type === "assistant.usage") {
        if (!directEventBelongs(event)) return;
        runtime.observeUsageEvent(event, runId);
        rememberDirectEvent(event);
        return;
      }
      if (event.type === "session.error") {
        if (!directEventBelongs(event)) return;
        const value = { outcome: "failed", error: new Error(`Copilot reported session.error while running ${id}`) };
        settleStrong(value);
      } else if (event.type === "session.shutdown") {
        if (!directEventBelongs(event)) return;
        const shutdownType = copilotPublicIdentifier(event.data?.shutdownType, 40) ?? "unknown";
        const value = shutdownType === "error"
          ? { outcome: "failed", error: new Error(`Copilot reported session.shutdown (${shutdownType}) while running ${id}`) }
          : { outcome: "cancelled", error: new Error(`Copilot reported session.shutdown (${shutdownType}) while running ${id}`) };
        settleStrong(value);
      } else if (event.type === "session.idle") {
        if (!directEventBelongs(event)) return;
        const value = event.data?.aborted
          ? { outcome: "cancelled", error: new Error(`Agent Harbor player was cancelled: ${id}`) }
          : { outcome: "completed" };
        if (promptPhase === "accepting" && !stopRequested) acceptanceTerminals.push({ kind: "idle", value });
        else validateAcceptedIdle(event, value);
      } else if (directEventBelongs(event)) {
        rememberDirectEvent(event);
      }
    });
    const abort = async () => {
      stopRequested = true;
      if (!promptAttempted) {
        settle({ outcome: "cancelled", error: new Error(`Agent Harbor player was cancelled before prompt acceptance: ${id}`) });
      }
      runtime.setState(runId, "cleaning");
      try { await boundedHostCall("Copilot abort", () => session.abort()); }
      finally {
        void safeLog(`[Agent Harbor player · ${id} · run ${runId}]\nStop requested; waiting for Copilot to settle…`, { level: "warning" });
      }
    };
    abortableRoots.set(runId, abort);
    activeDirect = { sessionId: session.sessionId, runId, id, project };

    const waitAfterAbort = async (reason) => {
      let abortFailure;
      try { await abort(); } catch (error) { abortFailure = error; }
      await reconcileAcceptanceTerminals();
      if (terminalValue) return { result: terminalValue, abortFailure };
      const result = await Promise.race([terminal.promise, delay(abortSettlementMs, { unsettled: true })]);
      if (!result?.unsettled) return { result, abortFailure };

      lateSettlement = true;
      const late = terminal.promise.then(async (settled) => {
        runtime.setState(runId, "cleaning");
        unsubscribe();
        try {
          await restoreSelection(previous);
          restored = true;
          finishDirectRuntime(runId, settled);
        }
        catch (error) {
          selectionRestoreHazard = runId;
          runtime.setState(runId, "cleanup-error");
          releaseDirectControl(runId);
          await safeLog(`[Agent Harbor player · ${id} · run ${runId}]\nWork settled, but selection restore failed; reload Copilot before another player.`, { level: "error" });
        } finally {
          if (unsettledSelection?.runId === runId) unsettledSelection = undefined;
        }
      });
      unsettledSelection = { runId, settlement: late };
      const timeout = new Error(`${reason}; selection is retained until Copilot reports a terminal event`);
      if (abortFailure) throw new AggregateError([timeout, abortFailure], `${reason}; abort also failed and selection is retained`);
      throw timeout;
    };

    try {
      selectionAttempted = true;
      try {
        await boundedHostCall("Copilot player selection", () => session.rpc.agent.select({ name: agent.id }));
      } catch (error) {
        ambiguousSelection = error instanceof HostRpcTimeoutError;
        throw error;
      }
      await boundedHostCall("Copilot coordinator selection sync", () => coordinator.refresh(agent.id));
      coordinatorReady = true;
      const safeTask = runtime.get(runId)?.task ?? "(task not disclosed)";
      await safeLog(`[Agent Harbor player · ${id} · run ${runId}]\nStarting: selected ${id}; sending “${safeTask}”\nInspect progress with /team.`, { level: "info" });
      if (stopRequested) {
        const cancelled = { outcome: "cancelled", error: new Error(`Agent Harbor player was cancelled before prompt acceptance: ${id}`) };
        settle(cancelled);
        throw cancelled.error;
      }
      let result;
      let timeoutFailure;
      let abortFailure;
      try {
        await boundedHostCall("Copilot prompt acceptance", () => {
          // The check and call are one synchronous event-loop step. A queued
          // /team stop can therefore win before this callback, but never in
          // between the check and session.send itself.
          if (stopRequested) {
            throw new PlayerPreflightError(`Agent Harbor player was cancelled before prompt acceptance: ${id}`);
          }
          promptAttempted = true;
          promptPhase = "accepting";
          modelAttempted = true;
          return session.send({ prompt: task });
        });
        sendAccepted = true;
        promptPhase = "accepted";
        await reconcileAcceptanceTerminals();
        if (!terminalValue) runtime.setState(runId, "working");
      } catch (error) {
        if (!(error instanceof HostRpcTimeoutError)) throw error;
        sendAccepted = true;
        promptPhase = "accepted";
        timeoutFailure = error;
        await reconcileAcceptanceTerminals();
        if (terminalValue) {
          result = terminalValue;
          timeoutFailure = undefined;
        } else {
          ({ result, abortFailure } = await waitAfterAbort(`Run ${runId} timed out waiting for Copilot to accept the prompt`));
        }
      }

      if (!result) result = await Promise.race([terminal.promise, delay(directTimeoutMs, { timeout: true })]);
      if (result?.timeout) {
        timeoutFailure = new Error(`Run ${runId} exceeded ${directTimeoutMs}ms`);
        ({ result, abortFailure } = await waitAfterAbort(timeoutFailure.message));
      }

      finalTerminal = result;
      runtime.setState(runId, "cleaning");
      const failures = [timeoutFailure, abortFailure, result.error].filter(Boolean);
      if (failures.length > 1) throw new AggregateError(failures, `Agent Harbor player ${id} settled with multiple failures`);
      if (failures.length === 1) throw failures[0];
      showCompletion = true;
      return runId;
    } catch (error) {
      primaryFailure = error;
      if (!lateSettlement) {
        if (!sendAccepted && !terminalValue) settle({ outcome: "failed", error });
        finalTerminal ??= terminalValue ?? { outcome: "failed", error };
        runtime.setState(runId, "cleaning");
      }
      throw error;
    } finally {
      if (!lateSettlement) {
        unsubscribe();
        if (selectionAttempted && !restored) {
          try { await restoreSelection(previous); restored = true; }
          catch (restoreError) {
            selectionRestoreHazard = runId;
            runtime.setState(runId, "cleanup-error");
            releaseDirectControl(runId);
            if (primaryFailure) {
              throw new AggregateError(
                [primaryFailure, restoreError],
                `Agent Harbor player ${id} failed and its previous selection could not be restored`,
              );
            }
            throw new AggregateError([restoreError], `Agent Harbor selection restore failed after ${id}`);
          }
          if (ambiguousSelection) {
            selectionRestoreHazard = runId;
            runtime.setState(runId, "cleanup-error");
            releaseDirectControl(runId);
          }
        }
        if (!ambiguousSelection && finalTerminal) {
          finishDirectRuntime(runId, finalTerminal);
          if (showCompletion) {
            try {
              await displayLog(`[Agent Harbor player · ${id} · run ${runId}]\n${formatCopilotMissionReport(runtime, runId)}`, {
                level: finalTerminal.outcome === "completed" ? "info" : "warning",
              });
            } catch (error) {
              throw new Error(`Run ${runId} completed and selection was restored, but Copilot could not display its TEAM RUN report; inspect /team before retrying`, { cause: error });
            }
          }
        }
      }
    }
    });
  } catch (error) {
    if (modelAttempted || error instanceof PlayerPreflightError) throw error;
    throw new PlayerPreflightError(errorMessage(error), error);
  }
}

function mapLifecycleState(state) {
  if (state === "starting") return "starting";
  if (state === "working") return "working";
  if (state === "waiting" || state === "idle") return "waiting";
  if (state === "cancelling") return "cleaning";
  return undefined;
}

function registerAbortableRoot(runId) {
  abortableRoots.set(runId, async () => {
    runtime.setState(runId, "cleaning");
    await boundedHostCall("Copilot abort", () => session.abort());
  });
}

function currentTeamSelectionGate() {
  if (coordinator.lifecycleIdentityUnverified()) {
    return "lifecycle identity is unverified; reload Copilot before delegation";
  }
  if (selectionRestoreHazard) {
    return `selection restoration is unverified after run ${selectionRestoreHazard}; reload Copilot`;
  }
  if (unsettledSelection) {
    return `run ${unsettledSelection.runId} is still settling; wait for its terminal event`;
  }
  if (activeDirect) {
    const state = runtime.get(activeDirect.runId)?.state;
    const managerCanDelegate = activeDirect.id === "team-lead" &&
      (state === "starting" || state === "working" || state === "waiting");
    if (!managerCanDelegate) return `direct run ${activeDirect.runId} owns the Copilot session`;
  }
  return undefined;
}

function lifecycleHook(event) {
  try {
    rememberProjectScope(event.project);
    if (event.type === "root.started") {
      let runId = correlationRuns.get(event.runId);
      const directRoot = activeDirect && activeDirect.sessionId === event.sessionId && activeDirect.id === event.agent;
      if (directRoot) {
        runId = activeDirect.runId;
      } else if (!runId) {
        runId = runtime.begin({
          project: event.project,
          agent: event.agent,
          kind: event.memberKind ?? memberKind(event.agent),
          task: event.taskLabel,
          model: event.model,
          modelSource: event.modelSource,
          reasoningEffort: event.reasoningEffort === null ? "none" : event.reasoningEffort,
        });
      }
      if (!directRoot) {
        registerAbortableRoot(runId);
      }
      correlationRuns.set(event.runId, runId);
      return;
    }
    if (event.type === "child.started") {
      const parentRunId = correlationRuns.get(event.parentRunId);
      if (!parentRunId) return;
      const projectRun = runtime.get(parentRunId);
      let runId = correlationRuns.get(event.runId);
      if (!runId) {
        runId = runtime.begin({
          project: event.project,
          agent: event.agent,
          kind: event.memberKind ?? memberKind(event.agent),
          task: event.taskLabel,
          parentRunId,
          model: event.model,
        });
        correlationRuns.set(event.runId, runId);
      }
      runtime.attachChild(runId, { agentId: event.childId, model: event.model });
      const lifecycleLabel = event.basis === "observed"
        ? "started"
        : "admitted (inferred; native start not observed)";
      void safeLog(`[Agent Harbor team · run ${projectRun?.rootRunId ?? parentRunId}]\n${event.agent} ${lifecycleLabel} · child ${runId}.`, { level: "info" });
      return;
    }
    const runId = correlationRuns.get(event.runId);
    if (!runId) return;
    if (event.type === "run.identity") {
      runtime.relabelActiveRoot(runId, {
        agent: event.agent,
        kind: event.memberKind,
        task: event.taskLabel,
      });
    } else if (event.type === "run.state") {
      const state = mapLifecycleState(event.state);
      if (state) runtime.setState(runId, state);
    } else if (event.type === "run.model") {
      const run = runtime.get(runId);
      if (run?.model !== event.model || event.eventId) runtime.observeRootModel(runId, event.model);
    } else if (event.type === "run.reasoning") {
      const run = runtime.get(runId);
      const effort = event.reasoningEffort === null ? "none" : event.reasoningEffort;
      if (run?.reasoningEffort !== effort || event.eventId) {
        runtime.observeRootModel(runId, undefined, event.reasoningEffort === null ? "none" : event.reasoningEffort);
      }
    } else if (event.type === "run.usage") {
      // Direct player roots already observe the original assistant.usage event
      // in runPlayer. Keep one explicit owner instead of trying to correlate a
      // raw provider identifier with its content-minimized lifecycle copy.
      // Lifecycle remains authoritative for delegated children and for roots
      // started outside the direct /player runner.
      const run = runtime.get(runId);
      if (event.attributionUnverified) {
        runtime.markUsageAttributionUnverified(runId);
        return;
      }
      if (!run?.parentRunId && activeDirect?.runId === runId) return;
      runtime.observeUsageEvent({
        type: "assistant.usage",
        id: event.eventId,
        timestamp: event.timestamp,
        data: {
          apiCallId: event.apiCallId,
          serviceRequestId: event.serviceRequestId,
          providerCallId: event.providerCallId,
          model: event.model ?? run?.model,
          reasoningEffort: event.reasoningEffort === null
            ? "none"
            : event.reasoningEffort ?? run?.reasoningEffort,
          ...event.usage,
        },
      }, runId);
    } else if (event.type === "run.finished") {
      const run = runtime.get(runId);
      if (!run?.parentRunId && activeDirect?.runId === runId) {
        correlationRuns.delete(event.runId);
        return;
      }
      if (run?.parentRunId) {
        const childOutcome = event.outcome === "completed" ? "completed" : "failed";
        runtime.childTerminal(runId, childOutcome, {
          durationMs: event.durationMs,
          totalTokens: event.totalTokens,
          totalToolCalls: event.totalToolCalls,
        });
        if (event.outcome === "cancelled") runtime.finishIfOpen(runId, "cancelled");
        else runtime.finishChild(runId, childOutcome);
      } else {
        runtime.finishIfOpen(runId, event.outcome);
        abortableRoots.delete(runId);
      }
      correlationRuns.delete(event.runId);
      void safeLog(`[Agent Harbor team · run ${run?.rootRunId ?? runId}]\n${event.agent} ${event.outcome} · ${runId}.`, {
        level: event.outcome === "completed" ? "info" : "warning",
      });
    }
  } catch (error) {
    void safeLog(`[Agent Harbor observability]\nLifecycle event could not be recorded: ${errorMessage(error)}`, { level: "warning" });
  }
}

const guardEvidenceQueue = [];
let guardEvidenceLogging = Promise.resolve();
const coordinator = createCopilotCoordinatorGuard(() => session, (event) => {
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
}, lifecycleHook, (input) => {
  rememberProjectScope(input.project);
  if (input.type === "root") {
    const runId = runtime.begin({
      project: input.project,
      agent: input.agent,
      kind: input.memberKind ?? memberKind(input.agent),
      task: input.taskLabel,
    });
    correlationRuns.set(input.runId, runId);
    registerAbortableRoot(runId);
    return;
  }
  const parentRunId = input.parentRunId && correlationRuns.get(input.parentRunId);
  if (!parentRunId) throw new Error("Agent Harbor team activity is unavailable for this coordinator run; submit the task again");
  const runId = runtime.begin({
    project: input.project,
    agent: input.agent,
    kind: input.memberKind ?? memberKind(input.agent),
    task: input.taskLabel,
    parentRunId,
  });
  correlationRuns.set(input.runId, runId);
});

async function refreshTeamDiscovery(deadline) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await boundedTeamCall(
        "Copilot authoritative team refresh",
        () => coordinator.refreshAuthoritative(),
        deadline,
        700,
      );
      coordinatorReady = true;
      return true;
    } catch {
      coordinatorReady = false;
      if (attempt === 0 && deadline - Date.now() > 50) await delay(25);
    }
  }
  return false;
}

async function listNativeTeamAgents(deadline, degraded) {
  const read = async () => {
    try {
      const listed = await boundedTeamCall("Copilot agent list", () => session.rpc.agent.list(), deadline, 350);
      if (!Array.isArray(listed?.agents)) throw new Error("Copilot agent list returned no registry array");
      return { agents: listed.agents, discoveryAvailable: true };
    } catch {
      return { agents: [], discoveryAvailable: false };
    }
  };
  let discovery = await read();
  const fixedReady = [...copilotFixedAgentIds.values()].every((id) =>
    discovery.agents.some((agent) => agent?.id === id));
  if (!coordinatorReady || !discovery.discoveryAvailable || !fixedReady) {
    if (await refreshTeamDiscovery(deadline)) discovery = await read();
    else degraded.push("coordinator refresh unavailable");
  }
  if (!discovery.discoveryAvailable) degraded.push("native roster unavailable");
  return discovery;
}

async function boundedTeamProject(deadline, degraded) {
  try {
    const metadata = await boundedTeamCall(
      "Copilot team metadata snapshot",
      () => session.rpc.metadata.snapshot(),
      deadline,
      350,
    );
    const observed = rememberProjectScope(metadata.workingDirectory);
    if (!observed && !projectScopeVerified) throw new Error("Copilot metadata did not identify a project");
  } catch {
    degraded.push(projectScopeVerified ? "using cached project scope" : "project scope unavailable");
  }
  return projectScopeVerified ? lastKnownProject : undefined;
}

async function boundedTeamModel(deadline, degraded) {
  try {
    const current = await boundedTeamCall("Copilot team current model", () => session.rpc.model.getCurrent(), deadline, 400);
    return {
      model: current.modelId,
      reasoningEffort: current.reasoningEffort === null ? "none" : current.reasoningEffort,
    };
  } catch {
    degraded.push("host model settings unavailable");
    return {};
  }
}

async function showTeam(args, title = "team", allowStop = true) {
  const value = args?.trim() ?? "";
  const deadline = Date.now() + teamBudgetMs;
  if (title === "team" && (value === "help" || value === "--help")) {
    const output = [
      "Agent Harbor Copilot team help · 0 model tokens",
      "/team                         Show roster, live work, telemetry, and last mission.",
      "/team <filter>                Match member, description, role/kind, status/state, task, or run ID.",
      "                               Also matches capability/tool/skill and model/reasoning.",
      "/team stop <run-id|all>       Request cancellation for one mission or all active missions.",
      "Limits: 32 concurrent roots per project; 6 sequential team-lead delegations per prompt.",
      "Bounded views disclose omitted rows; tasks are lossy/redacted and activity is process-local.",
    ].join("\n");
    await boundedTeamCall(
      "Copilot team help display",
      () => displayLog(output, { level: "info" }),
      deadline,
      logRpcTimeoutMs,
    );
    return;
  }
  const observationDeadline = deadline - Math.min(250, Math.floor(teamBudgetMs / 4));
  const degraded = [];
  const project = await boundedTeamProject(observationDeadline, degraded);
  if (!project) {
    if (allowStop && /^stop(?:\s|$)/u.test(value)) {
      throw new Error("Copilot project scope is unavailable; /team stop fails closed without inspecting another project");
    }
    const output = [
      `Agent Harbor Copilot ${title} · project scope unavailable · 0 model tokens · degraded`,
      `Degraded bounded snapshot (${teamBudgetMs}ms budget): project scope unavailable.`,
      ...(coordinator.lifecycleIdentityUnverified()
        ? ["Native lifecycle identity/attribution is unverified; reload Copilot before delegation."]
        : []),
      ...(selectionRestoreHazard
        ? ["Player selection restoration is unverified; reload Copilot before delegation."]
        : []),
      "",
      "ACTIVITY (process-local)",
      "No project-scoped roster or activity is displayed until Copilot confirms the working directory.",
      "Retry /team after host metadata recovers; project-scoped stop remains disabled meanwhile.",
    ].join("\n");
    await boundedTeamCall("Copilot team display", () => displayLog(output, { level: "warning" }), deadline, logRpcTimeoutMs);
    return;
  }
  if (allowStop && /^stop(?:\s|$)/u.test(value)) {
    const target = value.slice(4).trim();
    if (!target) throw new Error("usage: /team stop <run-id|all>");
    const active = runtime.activeProjectRuns(project);
    const matching = target === "all" ? active : active.filter((run) => run.id === target || run.rootRunId === target);
    const roots = [...new Set(matching.map(({ rootRunId }) => rootRunId))]
      .flatMap((rootRunId) => active.find((run) => run.id === rootRunId) ?? []);
    if (!roots.length) {
      if (target === "all") {
        await boundedTeamCall(
          "Copilot team stop display",
          () => displayLog("Agent Harbor Copilot stop · 0 model tokens\nNo Agent Harbor work is active in this project.", { level: "info" }),
          deadline,
          logRpcTimeoutMs,
        );
        return;
      }
      throw new Error(`unknown active Agent Harbor run: ${target}; run /team to inspect current IDs`);
    }
    await Promise.all(roots.map(async (run) => {
      const abort = abortableRoots.get(run.id);
      if (!abort) throw new Error(`Agent Harbor run is no longer controlled: ${run.id}`);
      await boundedTeamCall(`Copilot stop ${run.id}`, abort, deadline, teamBudgetMs);
    }));
    await boundedTeamCall(
      "Copilot team stop display",
      () => displayLog(`Agent Harbor Copilot stop · 0 model tokens\nStopping ${roots.length} root run(s): ${roots.map(({ id }) => id).join(", ")}.`, { level: "warning" }),
      deadline,
      logRpcTimeoutMs,
    );
    return;
  }
  const [model, nativeDiscovery] = await Promise.all([
    boundedTeamModel(observationDeadline, degraded),
    listNativeTeamAgents(observationDeadline, degraded),
  ]);
  const selectionGate = currentTeamSelectionGate();
  if (selectionRestoreHazard) degraded.push("player selection restoration unverified");
  let output;
  let usedFallback = false;
  try {
    output = await boundedTeamCall(
      "Agent Harbor team view formatting",
      () => formatCopilotTeamView(project, runtime, {
        filter: value,
        title,
        nextModel: model.model,
        nextReasoning: model.reasoningEffort,
        selectionGate,
        native: {
          ...nativeDiscovery,
          coordinatorReady: coordinatorReady && !selectionRestoreHazard,
          selectionRestoreUnverified: Boolean(selectionRestoreHazard),
        },
      }),
      deadline - 100,
      teamFormatTimeoutMs,
    );
  } catch {
    degraded.push("authoritative roster rendering unavailable");
    usedFallback = true;
    output = formatCopilotDegradedTeamView(project, runtime, {
      title,
      filter: value,
      reasons: degraded,
      budgetMs: teamBudgetMs,
      selectionGate,
    });
  }
  const reasons = [...new Set(degraded)];
  if (reasons.length && !usedFallback) {
    output += `\n\nDegraded bounded snapshot (${teamBudgetMs}ms budget): ${reasons.join("; ")}.`;
  }
  await boundedTeamCall("Copilot team display", () => displayLog(output, { level: "info" }), deadline, logRpcTimeoutMs);
}

const knownPlayers = new Map([...rolePlayers, ...bundledPlayers]);
const startupActiveIds = activeProfileIds(process.cwd());
const callableIds = [...new Set([...knownPlayers.keys(), ...startupActiveIds])];

session = await joinSession({
  hooks: coordinator.hooks,
  commands: [
    {
      name: "team",
      description: "0 model tokens · /team [help|filter|stop <run-id|all>] · Show roster, live work, model/reasoning, native usage, and last mission.",
      handler: async ({ args }) => {
        try { await showTeam(args); }
        catch (error) {
          void safeLog(`[Agent Harbor team · 0 model tokens]\n${errorMessage(error)}`, { level: "error" });
          throw error;
        }
      },
    },
    {
      name: "player",
      description: "1 model root · /player <id> <task> · Run any currently active Agent Harbor teammate, including one just joined.",
      handler: async ({ args }) => {
        const input = args?.trim() ?? "";
        const separator = input.search(/\s/u);
        const id = separator < 0 ? input : input.slice(0, separator);
        const task = separator < 0 ? "" : input.slice(separator).trim();
        if (!isHarborId(id) || !task) {
          const error = new Error("usage: /player <id> <task>");
          await safeLog(`[Agent Harbor player · preflight · 0 model tokens]\n${error.message}`, { level: "error" });
          throw error;
        }
        try { await runPlayer(id, task, "player"); }
        catch (error) {
          const budget = error instanceof PlayerPreflightError ? " · Preflight stopped · 0 model tokens" : "";
          await safeLog(`[Agent Harbor player · ${id}${budget}]\n${errorMessage(error)}`, { level: "error" });
          throw error;
        }
      },
    },
    ...controls.map(([name, description]) => ({
      name,
      description,
      handler: async ({ args }) => {
        try {
          const value = (args ?? "").trim();
          const listFilter = name === "bench" ? benchListFilter(value) : undefined;
          if (name === "bench" && listFilter !== undefined) {
            await showTeam(listFilter, "bench", false);
            return;
          }
          const project = await currentProject();
          const result = await runDeterministicCommand("copilot", name, args ?? "", project, undefined, name === "list-skills" ? "copilot" : "plain");
          const committed = name === "join" || name === "retire" || (name === "bench" && /^(on|off)\b/u.test(value));
          let refreshWarning = "";
          if (committed) {
            try {
              await boundedHostCall("Copilot coordinator refresh", () => coordinator.refreshAuthoritative());
              coordinatorReady = true;
            }
            catch {
              coordinatorReady = false;
              refreshWarning = "\nRoster updated, but Copilot refresh failed; reload the session before invoking the changed player.";
            }
          }
          const heading = name === "list-skills" ? "Agent Harbor · skill catalog · 0 model tokens" : `Agent Harbor /${name} · 0 model tokens`;
          const publicResult = name === "join" ? conciseCopilotJoinResult(args ?? "") : result;
          try {
            await displayLog(`[${heading}]\n${publicResult || "Done."}${refreshWarning}`, { level: refreshWarning ? "warning" : "info" });
          } catch (error) {
            if (committed) {
              throw new Error("Agent Harbor roster updated successfully, but Copilot could not display the result; reload and inspect /team before retrying", { cause: error });
            }
            throw error;
          }
        } catch (error) {
          await safeLog(`[Agent Harbor /${name} · 0 model tokens]\n${errorMessage(error)}`, { level: "error" });
          throw error;
        }
      },
    })),
    {
      name: "scout",
      description: "1 recruiter model root · /scout <capability needed> · Recruit one persistent teammate.",
      handler: async ({ args }) => {
        try { await runPlayer(scoutPlayer.name, args, "scout"); }
        catch (error) {
          const budget = error instanceof PlayerPreflightError ? " · Preflight stopped · 0 model tokens" : "";
          await safeLog(`[Agent Harbor scout${budget}]\n${errorMessage(error)}`, { level: "error" });
          throw error;
        }
      },
    },
    ...callableIds.map((id) => ({
      name: id,
      description: `1 model root · /${id} <task> · ${knownPlayers.get(id)?.description ?? `Run active Agent Harbor player ${id}.`}`,
      handler: async ({ args }) => {
        try { await runPlayer(id, args); }
        catch (error) {
          const budget = error instanceof PlayerPreflightError ? " · Preflight stopped · 0 model tokens" : "";
          await safeLog(`[Agent Harbor player · ${id}${budget}]\n${errorMessage(error)}`, { level: "error" });
          throw error;
        }
      },
    })),
  ],
});

session.on((event) => {
  coordinator.observeEvent(event);
  if (event.type !== "hook.end" || event.data.hookType !== "preToolUse") return;
  if (coordinator.hostEventDisposition(event) !== "claimed") return;
  const evidence = guardEvidenceQueue.shift();
  if (!evidence) return;
  const message = JSON.stringify(evidence);
  const logEvidence = async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await boundedHostCall(
          "Copilot guard evidence log",
          () => session.log(message, { level: "info", type: "agent-harbor-guard", ephemeral: true }),
          logRpcTimeoutMs,
        );
        return;
      } catch (error) {
        if (error instanceof HostRpcTimeoutError) return;
        if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
      }
    }
  };
  guardEvidenceLogging = guardEvidenceLogging.then(logEvidence, logEvidence);
});
try {
  await boundedHostCall(
    "Copilot coordinator startup refresh",
    () => coordinator.refreshAuthoritative(),
    startupRefreshTimeoutMs,
  );
  coordinatorReady = true;
} catch {
  coordinatorReady = false;
  void safeLog("[Agent Harbor startup · 0 model tokens]\nRoster controls remain available, but native player/delegation discovery is unavailable; reload the Copilot session.", { level: "warning" });
}
