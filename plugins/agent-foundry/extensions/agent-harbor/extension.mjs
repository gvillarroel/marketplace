/**
 * Copilot extension bootstrap. Deterministic controls never send a prompt;
 * explicit player commands select one validated native agent for one bounded
 * host turn and expose process-local activity through `/team`.
 */
import { createHash } from "node:crypto";
import { posix, resolve, win32 } from "node:path";
import { joinSession } from "@github/copilot-sdk/extension";
import {
  copilotFixedAgentIds,
  copilotScoutAgentId,
  copilotAgentIdentityMatches,
  createCopilotCoordinatorGuard,
  listCopilotActiveProfileIds,
  resolveCopilotPlayer,
} from "../../runtime/dist/adapters/copilot-coordinator.js";
import {
  copilotPublicIdentifier,
  copilotTaskLabel,
  CopilotTeamRuntime,
  formatCopilotMissionReport,
} from "../../runtime/dist/adapters/copilot-team-runtime.js";
import {
  collectCopilotTeamMembers,
  formatCopilotDegradedTeamView,
  formatCopilotTeamView,
} from "../../runtime/dist/adapters/copilot-team-view.js";
import { runCopilotControl } from "../../runtime/dist/adapters/copilot.js";
import { runDeterministicCommand } from "../../runtime/dist/adapters/direct.js";
import { discoverStartupActiveProfiles, requireInvocablePlayer } from "../../runtime/dist/core/active.js";
import {
  assertHarborCustomToolAccess,
  formatHarborTeamRosterSnapshot,
  harborCustomToolNames,
  harborCustomToolPolicy,
  harborPlayerSkillToolSpec,
  harborStaticCustomToolSpecs,
  HarborScoutTurnGuard,
  validateHarborCustomToolArguments,
} from "../../runtime/dist/core/custom-tools.js";
import { bundledPlayers, rolePlayers, scoutPlayer, trustedSkills } from "../../runtime/dist/core/defaults.js";
import { GhResolver } from "../../runtime/dist/core/github.js";
import { isHarborId } from "../../runtime/dist/core/identity.js";
import { filterTrustedSkills, formatScoutSkillMatches } from "../../runtime/dist/core/scout.js";
import { formatLoadedSkillGroup, loadConfiguredSkills } from "../../runtime/dist/core/skills.js";
import { publicErrorText, publicMetadataText } from "../../runtime/dist/core/public-metadata.js";
import { wrapPlainText } from "../../runtime/dist/core/text-layout.js";

const controls = [
  ["bench", "0 model tokens · Inspect, activate, or deactivate Agent Harbor teammates."],
  ["join", "0 model tokens · Validate, persist, and activate one personal teammate."],
  ["retire", "0 model tokens · Unregister one personal teammate and deactivate it here."],
  ["list-skills", "0 model tokens · Search trusted skill snapshots and optional public descriptions."],
];
const directChainSeedEventTypes = new Set([
  "session.start",
  "assistant.turn_start",
  "session.model_change",
  "assistant.usage",
  "assistant.message",
  "assistant.idle",
  "tool.execution_start",
  "tool.execution_complete",
  "hook.end",
  "skill.invoked",
  "subagent.selected",
  "subagent.deselected",
  "subagent.started",
  "subagent.completed",
  "subagent.failed",
  "abort",
  "session.error",
  "session.shutdown",
  "session.idle",
]);
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
const directEventLedgerCapacity = 256;
const maximumTeamArgumentBytes = 4_096;
const maximumLifecycleArgumentBytes = 4_096;
const maximumDefinitionArgumentBytes = 100_000;
const maximumOpaqueHostIdBytes = 4_096;

function boundedEnvironmentNumber(name, fallback, minimum, maximum) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, Math.floor(value))) : fallback;
}

function opaqueDigest(namespace, value) {
  if (typeof value !== "string" || !value || value.length > maximumOpaqueHostIdBytes ||
      Buffer.byteLength(value, "utf8") > maximumOpaqueHostIdBytes) return undefined;
  const digest = createHash("sha256");
  digest.update(namespace, "utf8");
  digest.update("\0", "utf8");
  digest.update(value, "utf8");
  return digest.digest("base64url");
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
function errorMessage(error) {
  try {
    const raw = typeof error === "string"
      ? error
      : error instanceof Error && typeof error.message === "string"
        ? error.message
        : undefined;
    return raw ? publicErrorText(raw, 600) ?? "Agent Harbor operation failed." : "Agent Harbor operation failed.";
  } catch {
    return "Agent Harbor operation failed.";
  }
}
function publicErrorName(error, fallback = "Error") {
  try {
    return error instanceof Error
      ? copilotPublicIdentifier(error.name, 80) ?? fallback
      : fallback;
  } catch {
    return fallback;
  }
}
function boundedAggregateErrors(error) {
  try {
    return error instanceof AggregateError && Array.isArray(error.errors)
      ? error.errors.slice(0, 8)
      : [];
  } catch {
    return [];
  }
}
function publicFacingError(error, safeUsageCommand, depth = 0) {
  const exactGeneratedUsage = error instanceof PlayerPreflightError &&
    typeof safeUsageCommand === "string" && isHarborId(safeUsageCommand) &&
    error.message === `usage: /${safeUsageCommand} <task>`;
  const message = exactGeneratedUsage ? error.message : errorMessage(error);
  const visible = error instanceof PlayerPreflightError
    ? new PlayerPreflightError(message)
    : error instanceof AggregateError && depth < 3
      ? new AggregateError(
          boundedAggregateErrors(error).map((child) => publicFacingError(child, undefined, depth + 1)),
          message,
        )
      : new Error(message);
  visible.name = publicErrorName(error, visible.name);
  return visible;
}
function publicNativeToolError(error, depth = 0) {
  const visible = error instanceof AggregateError && depth < 3
    ? new AggregateError(
        boundedAggregateErrors(error).map((child) => publicNativeToolError(child, depth + 1)),
        errorMessage(error),
      )
    : new Error(errorMessage(error));
  visible.name = publicErrorName(error, "Error") === "AbortError"
    ? "AbortError"
    : publicErrorName(error, visible.name);
  return visible;
}
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

function conciseCopilotJoinResult(args, refreshReady = true) {
  const input = JSON.parse(args);
  const id = copilotPublicIdentifier(input.name, 48) ?? "joined-player";
  const role = publicMetadataText(input.description, 240) ?? "Personal Agent Harbor teammate";
  const tools = Array.isArray(input.tools)
    ? input.tools.flatMap((tool) => copilotPublicIdentifier(tool, 80) ?? [])
    : [];
  const skills = Array.isArray(input.skills)
    ? input.skills.flatMap((skill) => copilotPublicIdentifier(skill?.name, 80) ? [`skill:${copilotPublicIdentifier(skill.name, 80)}`] : [])
    : [];
  const configuredModel = publicMetadataText(typeof input.model === "string" ? input.model : "", 200);
  const capacity = [...tools, ...skills].join(", ") || "advisory";
  const skillLoaderReady = skills.length === 0 || registeredNativeSkillTools.has(
    harborPlayerSkillToolSpec({ name: input.name }).name,
  );
  const readyNow = refreshReady && skillLoaderReady;
  return readyNow
    ? [
        `✓ ${id} joined · personal · registered in this project`,
        `Role: ${role}`,
        `Capacity: ${capacity}`,
        `Model: ${configuredModel ? `configured ${configuredModel}` : "inherits the current Copilot host when run"}`,
        `Availability: verify with /team member:${id}; run only when it reports ready.`,
        `When ready: /player ${id} <task>`,
        `After restarting Copilot: /${id} <task>`,
      ].join("\n")
    : [
        `✓ ${id} stored · personal · pending Copilot reload`,
        `Role: ${role}`,
        `Capacity: ${capacity}`,
        `Model: ${configuredModel ? `configured ${configuredModel}` : "inherits the current Copilot host when run"}`,
        ...(skills.length && !skillLoaderReady
          ? ["Configured skills require the extension tools registered at startup; reload Copilot before invoking this player."]
          : ["Next: reload the Copilot session, then inspect /team before invoking this player."]),
        `After reload: /player ${id} <task> or /${id} <task>`,
      ].join("\n");
}

function playersPendingNativeSkillReload(project) {
  return activeProfileIds(project).flatMap((id) => {
    try {
      const player = requireInvocablePlayer("copilot", project, id).definition;
      if (!player.skills?.length || registeredNativeSkillTools.has(harborPlayerSkillToolSpec(player).name)) return [];
      return [id];
    } catch {
      return [];
    }
  });
}

function updateSessionPersonalAdmission(command, args, refreshReady) {
  const value = args?.trim() ?? "";
  if (command === "join") {
    if (!refreshReady) return;
    try {
      const id = JSON.parse(value)?.name;
      if (isHarborId(id)) sessionInvocablePersonalIds.add(id);
    } catch { /* The deterministic command already validates successful joins. */ }
    return;
  }
  if (command === "retire") {
    // Keep the session admission tombstone so a retired player receives the
    // precise missing/retired repair instead of being confused with a profile
    // that startup discovery deliberately omitted.
    return;
  }
  if (command !== "bench") return;
  const match = /^(on|off)\s+([a-z0-9-]+)$/u.exec(value);
  if (!match) return;
  if (match[1] === "on" && refreshReady && startupActiveDiscovery.complete) {
    sessionInvocablePersonalIds.add(match[2]);
  }
}

async function inactivePlayerError(id, project) {
  try {
    const member = (await collectCopilotTeamMembers(project)).find((candidate) => candidate.id === id);
    if (!member) {
      return `Agent Harbor personal player is missing or retired: ${id}; re-run /join with the full definition or inspect /team ${id}`;
    }
    if (member.availability === "ready") return undefined;
    if (member.availability === "bench") {
      return `Agent Harbor ${member.kind === "personal" ? "personal " : ""}player is benched: ${id}; run /bench on ${id}`;
    }
    if (member.availability === "conflict") {
      return `Agent Harbor personal player has an unmanaged collision: ${id}; inspect /team ${id} and the colliding file. Agent Harbor will never overwrite it.`;
    }
    if (member.repairKind === "personal-active") {
      return `Agent Harbor personal active profile is stale: ${id}; run /bench on ${id}, then reload the Copilot session.`;
    }
    if (member.repairKind === "personal-registration") {
      return `Agent Harbor personal registration is stale: ${id}; re-run /join with the full definition and "replace":true, then reload the Copilot session.`;
    }
    if (member.repairKind === "bundled-profile") {
      return `Agent Harbor bundled profile is stale: ${id}; run /bench on ${id}, then reload the Copilot session.`;
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
let selectionClaimed = false;
const nativeToolCallsByRun = new Map();
const nativeScoutGuardsByRun = new Map();
const nativeToolControllers = new Map();
const registeredNativeSkillTools = new Set();
const sessionInvocablePersonalIds = new Set();
const maximumNotificationLogQueue = 8;
const notificationLogQueue = [];
let notificationLogDraining = false;
let logCircuitOpenUntil = 0;
const logCircuitCooldownMs = Math.min(1_000, Math.max(100, logRpcTimeoutMs));
let lastKnownProject;
let projectScopeVerified = false;

function rememberProjectScope(project) {
  if (typeof project !== "string" || !project.trim()) return undefined;
  lastKnownProject = project;
  projectScopeVerified = true;
  return project;
}

function safeLog(message, options = {}, priority = "normal") {
  return new Promise((resolve) => {
    if (notificationLogQueue.length >= maximumNotificationLogQueue) {
      if (priority !== "terminal") {
        resolve();
        return;
      }
      const normalIndex = notificationLogQueue.findIndex((entry) => entry.priority !== "terminal");
      const evictedIndex = normalIndex >= 0 ? normalIndex : 0;
      const [evicted] = notificationLogQueue.splice(evictedIndex, 1);
      evicted?.resolve();
    }
    notificationLogQueue.push({ message, options, priority, resolve });
    void drainNotificationLogs();
  });
}

async function drainNotificationLogs() {
  if (notificationLogDraining) return;
  notificationLogDraining = true;
  try {
    while (notificationLogQueue.length) {
      const terminalIndex = notificationLogQueue.findIndex((entry) => entry.priority === "terminal");
      const [entry] = notificationLogQueue.splice(terminalIndex >= 0 ? terminalIndex : 0, 1);
      try { await emitLog(entry.message, entry.options); }
      catch { /* Best-effort notifications never block the requested command. */ }
      entry.resolve();
    }
  } finally {
    notificationLogDraining = false;
    if (notificationLogQueue.length) void drainNotificationLogs();
  }
}

function displayLog(message, options = {}) {
  return emitLog(message, options);
}

async function emitLog(message, options = {}) {
  const remainingCircuitMs = logCircuitOpenUntil - Date.now();
  if (remainingCircuitMs > 0) {
    throw new HostRpcTimeoutError("Copilot session.log circuit open after a prior timeout", remainingCircuitMs);
  }
  try {
    const result = await boundedHostCall(
      "Copilot session.log",
      () => session.log(wrapPlainText(message), { ephemeral: true, ...options }),
      logRpcTimeoutMs,
    );
    logCircuitOpenUntil = 0;
    return result;
  } catch (error) {
    if (error instanceof HostRpcTimeoutError) {
      logCircuitOpenUntil = Date.now() + logCircuitCooldownMs;
    }
    throw error;
  }
}

function withSelectionLock(action) {
  if (selectionClaimed) {
    return Promise.reject(new PlayerPreflightError(
      "Another Agent Harbor player selection is already queued or in progress; inspect /team and retry after it settles",
    ));
  }
  selectionClaimed = true;
  const result = selectionQueue.then(action, action);
  selectionQueue = result.then(() => undefined, () => undefined);
  return result.finally(() => { selectionClaimed = false; });
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

function normalizedCurrentModelSettings(current) {
  const modelId = typeof current?.modelId === "string" && current.modelId.length <= 300
    ? current.modelId.trim()
    : "";
  const modelUnreported = !modelId || /^(?:unknown(?:\/default)?|default)$/iu.test(modelId);
  return {
    ...(modelUnreported ? { modelUnreported: true } : { model: modelId }),
    reasoningEffort: current?.reasoningEffort === null ? "none" : current?.reasoningEffort,
  };
}

async function currentModelSettings() {
  try {
    return normalizedCurrentModelSettings(
      await boundedHostCall("Copilot current model", () => session.rpc.model.getCurrent()),
    );
  } catch {
    return { modelUnreported: true };
  }
}

async function restoreSelection(previous) {
  const failures = [];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      if (previous.agent) {
        const restored = await boundedHostCall(
          "Copilot selection restore",
          () => session.rpc.agent.select({ name: previous.agent.id }),
        );
        if (!copilotAgentIdentityMatches(previous.agent, restored?.agent)) {
          throw new Error("Copilot selection restore returned a different native identity");
        }
        await boundedHostCall("Copilot coordinator refresh", () => coordinator.refresh(previous.agent));
      } else {
        await boundedHostCall("Copilot selection restore", () => session.rpc.agent.deselect());
        const restored = await boundedHostCall("Copilot deselection verification", () => session.rpc.agent.getCurrent());
        if (restored.agent !== undefined && restored.agent !== null) {
          throw new Error("Copilot deselection did not restore an empty native selection");
        }
        await boundedHostCall("Copilot coordinator refresh", () => coordinator.refreshAuthoritative());
      }
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
  nativeToolCallsByRun.delete(runId);
  nativeScoutGuardsByRun.get(runId)?.terminate("Copilot root run ended");
  nativeScoutGuardsByRun.delete(runId);
  if (activeDirect?.runId === runId) activeDirect = undefined;
}

async function runPlayer(id, rawTask, command = id) {
  const raw = typeof rawTask === "string" ? rawTask : "";
  if (raw.length > 30_000 || Buffer.byteLength(raw, "utf8") > 30_000) {
    throw new PlayerPreflightError("Agent Harbor task exceeds 30000 bytes");
  }
  const task = raw.trim();
  if (!task) throw new PlayerPreflightError(`usage: /${command} ${command === "player" ? "<id> <task>" : "<task>"}`);
  if (!isHarborId(id)) throw new PlayerPreflightError("invalid Agent Harbor player ID; expected 1-48 lowercase letters, digits, or hyphens");

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
    if (id !== scoutPlayer.name && !copilotFixedAgentIds.has(id)) {
      if (!bundledPlayers.has(id) && !sessionInvocablePersonalIds.has(id)) {
        throw new Error(
          `Agent Harbor personal player was not admitted by this session's bounded startup discovery: ${id}; ` +
          "repair any startup warning and reload Copilot, or join/activate the player explicitly in this session",
        );
      }
      const inactive = await inactivePlayerError(id, project);
      if (inactive) throw new Error(inactive);
    }
    if (id !== scoutPlayer.name) {
      const player = requireInvocablePlayer("copilot", project, id).definition;
      if (player.skills?.length) {
        const skillTool = harborPlayerSkillToolSpec(player).name;
        if (!registeredNativeSkillTools.has(skillTool)) {
          throw new Error(
            `Agent Harbor player ${id} has configured skills whose native loader was not registered at startup; reload Copilot before invoking it`,
          );
        }
      }
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
    // Prompt acceptance can lag behind the native event stream. Retain only
    // one strongest terminal plus one idle candidate: an adversarial terminal
    // flood must not become an unbounded queue, and a provider/session error
    // must always dominate a weaker cancellation or idle observation.
    let acceptanceStrongTerminal;
    let acceptanceIdleTerminal;
    let acceptanceSignalVersion = 0;
    let acceptanceSignalWaiter = deferred();
    const directStartedAt = runtime.get(runId)?.startedAt ?? Date.now();
    const directEventIds = new Set();
    let idleValidationGeneration = 0;
    const settle = (value) => {
      if (terminalValue) return;
      terminalValue = value;
      terminal.resolve(value);
    };
    const signalAcceptanceTerminal = () => {
      acceptanceSignalVersion += 1;
      acceptanceSignalWaiter.resolve(acceptanceSignalVersion);
      acceptanceSignalWaiter = deferred();
    };
    const waitForAcceptanceTerminal = (observedVersion) => acceptanceSignalVersion !== observedVersion
      ? Promise.resolve(acceptanceSignalVersion)
      : acceptanceSignalWaiter.promise;
    const acceptanceTerminalPriority = (value) => value.outcome === "failed" ? 2 : 1;
    const bufferAcceptanceTerminal = (kind, value) => {
      if (kind === "error") {
        if (!acceptanceStrongTerminal ||
            acceptanceTerminalPriority(value) > acceptanceTerminalPriority(acceptanceStrongTerminal)) {
          acceptanceStrongTerminal = value;
          acceptanceIdleTerminal = undefined;
          signalAcceptanceTerminal();
        }
        return;
      }
      if (!acceptanceStrongTerminal && !acceptanceIdleTerminal) {
        acceptanceIdleTerminal = value;
        signalAcceptanceTerminal();
      }
    };
    const settleStrong = (value) => {
      if (promptPhase === "accepting" && !stopRequested) {
        bufferAcceptanceTerminal("error", value);
      }
      else settle(value);
    };
    const directTimestamp = (event) => event.timestamp === undefined ? Number.NaN : Date.parse(event.timestamp);
    const directTimestampIsCurrent = (event) => {
      const timestamp = directTimestamp(event);
      return !Number.isFinite(timestamp) || timestamp >= directStartedAt;
    };
    // Event IDs are correlation-only. Keep fixed-size digests rather than raw
    // host-controlled IDs, which may be very large or contain private data.
    const directOpaqueId = (value) => opaqueDigest("direct-event", value);
    const directEventIdsAreBounded = (event) => [event.id, event.parentId].every((value) =>
      value === undefined || value === null ||
      (typeof value === "string" && value.length <= maximumOpaqueHostIdBytes &&
        Buffer.byteLength(value, "utf8") <= maximumOpaqueHostIdBytes));
    const directEventBelongs = (event) => {
      if (!directEventIdsAreBounded(event)) return false;
      if (!directTimestampIsCurrent(event)) return false;
      const parentId = directOpaqueId(event.parentId);
      const canSeedChain = directChainSeedEventTypes.has(event.type);
      if (parentId !== undefined) {
        if (directEventIds.has(parentId)) return true;
        return canSeedChain && directEventIds.size === 0;
      }
      // Stream fragments and other non-lifecycle notifications cannot prove
      // ownership on their own. They may extend a known native parent, but
      // must never poison an empty direct-run chain with a replayed ID.
      if (!canSeedChain) return false;
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
      if (directEventIds.size >= directEventLedgerCapacity) {
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
      if ((!acceptanceStrongTerminal && !acceptanceIdleTerminal) || terminalValue) return;
      const strongCandidate = acceptanceStrongTerminal;
      const idleCandidate = acceptanceIdleTerminal;
      acceptanceStrongTerminal = undefined;
      acceptanceIdleTerminal = undefined;
      if (strongCandidate) {
        settle(strongCandidate);
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
        // A strong terminal may have arrived while activity was stabilizing.
        // It remains dominant over the earlier idle candidate.
        if (acceptanceStrongTerminal) {
          const lateStrong = acceptanceStrongTerminal;
          acceptanceStrongTerminal = undefined;
          acceptanceIdleTerminal = undefined;
          settle(lateStrong);
        } else if (!activity.hasActiveWork && !processing.processing && idleCandidate) {
          settle(idleCandidate);
        }
      } catch { /* Uncertain host state must not restore selection early. */ }
    };
    const awaitPromptAcceptance = async (action) => {
      const call = boundedHostCall("Copilot prompt acceptance", action).then(
        () => ({ kind: "accepted" }),
        (error) => ({ kind: "error", error }),
      );
      let observedSignalVersion = acceptanceSignalVersion;
      while (true) {
        const outcome = await Promise.race([
          call,
          waitForAcceptanceTerminal(observedSignalVersion)
            .then((version) => ({ kind: "terminal-signal", version })),
        ]);
        if (outcome.kind !== "terminal-signal") return outcome;
        observedSignalVersion = outcome.version;
        await reconcileAcceptanceTerminals();
        if (terminalValue) return { kind: "terminal", result: terminalValue };
      }
    };
    const unsubscribe = session.on((event) => {
      if (!promptAttempted && !stopRequested) return;
      if (["abort", "session.error", "session.idle", "session.shutdown"].includes(event.type) &&
          !eventMatchesCurrentSession(event)) return;
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
        if (promptPhase === "accepting" && !stopRequested) {
          bufferAcceptanceTerminal("idle", value);
        }
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
      abortNativeTools(`Agent Harbor stop requested for run ${runId}`, {
        project,
        runIds: new Set([runId]),
        includeUnbound: true,
      });
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
        const selected = await boundedHostCall(
          "Copilot player selection",
          () => session.rpc.agent.select({ name: agent.id }),
        );
        if (!copilotAgentIdentityMatches(agent, selected?.agent)) {
          throw new Error("Copilot player selection returned a different native identity");
        }
      } catch (error) {
        ambiguousSelection = error instanceof HostRpcTimeoutError;
        throw error;
      }
      await boundedHostCall("Copilot coordinator selection sync", () => coordinator.refresh(agent));
      coordinatorReady = true;
      const safeTask = runtime.get(runId)?.task ?? "(task not disclosed)";
      if (stopRequested) {
        const cancelled = { outcome: "cancelled", error: new Error(`Agent Harbor player was cancelled before prompt acceptance: ${id}`) };
        settle(cancelled);
        throw cancelled.error;
      }
      await safeLog(`[Agent Harbor player · ${id} · run ${runId}]\nPrepared: selected ${id}; no model call yet.\nTask: “${safeTask}” · inspect progress with /team.`, { level: "info" });
      // Give a stop command queued while the preparation notice was being
      // displayed one event-loop turn to claim the run before session.send.
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (stopRequested) {
        const cancelled = { outcome: "cancelled", error: new Error(`Agent Harbor player was cancelled before prompt acceptance: ${id}`) };
        settle(cancelled);
        throw cancelled.error;
      }
      let result;
      let timeoutFailure;
      let abortFailure;
      const acceptance = await awaitPromptAcceptance(() => {
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
      if (acceptance.kind === "error" && !(acceptance.error instanceof HostRpcTimeoutError)) {
        throw acceptance.error;
      }
      if (acceptance.kind === "accepted" || acceptance.kind === "terminal" ||
          acceptance.error instanceof HostRpcTimeoutError) {
        sendAccepted = true;
        promptPhase = "accepted";
      }
      if (acceptance.kind === "terminal") {
        result = acceptance.result;
      } else if (acceptance.kind === "error") {
        timeoutFailure = acceptance.error;
        await reconcileAcceptanceTerminals();
        if (terminalValue) {
          result = terminalValue;
          timeoutFailure = undefined;
        } else {
          ({ result, abortFailure } = await waitAfterAbort(`Run ${runId} timed out waiting for Copilot to accept the prompt`));
        }
      } else {
        await reconcileAcceptanceTerminals();
        if (terminalValue) result = terminalValue;
        else runtime.setState(runId, "working");
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
    const run = runtime.get(runId);
    abortNativeTools(`Agent Harbor stop requested for run ${runId}`, {
      project: run?.project,
      runIds: new Set([runId]),
      includeUnbound: true,
    });
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
          cost: event.billing?.modelMultiplier,
          ...(event.billing?.totalNanoAiu === undefined
            ? {}
            : { copilotUsage: { totalNanoAiu: event.billing.totalNanoAiu } }),
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
      }, "terminal");
    }
  } catch (error) {
    void safeLog(`[Agent Harbor observability]\nLifecycle event could not be recorded: ${errorMessage(error)}`, { level: "warning" });
  }
}

const maximumGuardEvidenceQueue = 6;
const maximumGuardEvidenceLogQueue = 8;
const guardEvidenceQueue = [];
const guardEvidenceLogQueue = [];
let guardEvidenceLogDraining = false;
let guardEvidenceGeneration = 0;
async function drainGuardEvidenceLogs() {
  if (guardEvidenceLogDraining) return;
  guardEvidenceLogDraining = true;
  try {
    while (guardEvidenceLogQueue.length) {
      const entry = guardEvidenceLogQueue.shift();
      for (let attempt = 0; attempt < 3; attempt += 1) {
        if (entry.generation !== guardEvidenceGeneration) break;
        try {
          await boundedHostCall(
            "Copilot guard evidence log",
            () => session.log(entry.message, { level: "info", type: "agent-harbor-guard", ephemeral: true }),
            logRpcTimeoutMs,
          );
          break;
        } catch (error) {
          if (error instanceof HostRpcTimeoutError || entry.generation !== guardEvidenceGeneration) break;
          if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
        }
      }
    }
  } finally {
    guardEvidenceLogDraining = false;
    if (guardEvidenceLogQueue.length) void drainGuardEvidenceLogs();
  }
}
function queueGuardEvidenceLog(evidence) {
  if (guardEvidenceLogQueue.length >= maximumGuardEvidenceLogQueue) return;
  guardEvidenceLogQueue.push({ message: JSON.stringify(evidence), generation: guardEvidenceGeneration });
  void drainGuardEvidenceLogs();
}
function clearGuardEvidenceQueues() {
  guardEvidenceGeneration += 1;
  guardEvidenceQueue.length = 0;
  guardEvidenceLogQueue.length = 0;
}
const coordinator = createCopilotCoordinatorGuard(() => session, (event) => {
  if (event.phase !== "target.resolved") return;
  if (guardEvidenceQueue.length >= maximumGuardEvidenceQueue) {
    guardEvidenceQueue.length = 0;
    void safeLog("[Agent Harbor guard]\nGuard evidence queue saturated and was cleared; delegation remains fail-closed in the coordinator.", { level: "warning" });
    return;
  }
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

function looksLikeWindowsPath(value) {
  return typeof value === "string" && (win32.isAbsolute(value) || /^[A-Za-z]:[\\/]/u.test(value));
}

function normalizedAuthorizationPath(value, windowsStyle) {
  if (typeof value !== "string" || !value || value.includes("\0")) return undefined;
  if (windowsStyle) {
    return win32.normalize(value).replace(/\\/gu, "/").replace(/\/+$/u, "").toLowerCase();
  }
  const normalized = posix.isAbsolute(value) ? posix.normalize(value) : resolve(value);
  return normalized.length > 1 ? normalized.replace(/\/+$/u, "") : normalized;
}

function equivalentAuthorizationPath(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const windowsStyle = looksLikeWindowsPath(left) || looksLikeWindowsPath(right);
  const normalizedLeft = normalizedAuthorizationPath(left, windowsStyle);
  const normalizedRight = normalizedAuthorizationPath(right, windowsStyle);
  return normalizedLeft !== undefined && normalizedLeft === normalizedRight;
}

function sameProject(left, right) {
  return equivalentAuthorizationPath(left, right);
}

function exactNativeToolInvocation(expectedName, args, invocation) {
  const allowedKeys = new Set(["arguments", "sessionId", "toolCallId", "toolName", "traceparent", "tracestate"]);
  if (!invocation || typeof invocation !== "object" || Array.isArray(invocation) ||
      Object.keys(invocation).some((key) => !allowedKeys.has(key)) ||
      !Object.hasOwn(invocation, "arguments") ||
      invocation.sessionId !== session.sessionId ||
      typeof invocation.toolCallId !== "string" || !invocation.toolCallId ||
      invocation.toolCallId.length > maximumOpaqueHostIdBytes ||
      Buffer.byteLength(invocation.toolCallId, "utf8") > maximumOpaqueHostIdBytes ||
      invocation.toolName !== expectedName ||
      (invocation.traceparent !== undefined && typeof invocation.traceparent !== "string") ||
      (invocation.tracestate !== undefined && typeof invocation.tracestate !== "string")) {
    throw new Error(`Agent Harbor custom tool ${expectedName} received an invalid Copilot invocation identity`);
  }
  const handlerCall = validateHarborCustomToolArguments(expectedName, args);
  const nativeCall = validateHarborCustomToolArguments(expectedName, invocation.arguments);
  if (JSON.stringify(handlerCall) !== JSON.stringify(nativeCall)) {
    throw new Error(`Agent Harbor custom tool ${expectedName} handler arguments do not match its native invocation`);
  }
  // Preserve the host-provided identity and arguments. In particular, never
  // replace `invocation.arguments` with the separately supplied handler args:
  // the coordinator authenticates this exact native object.
  return invocation;
}

class DuplicateNativeToolCallError extends Error {
  constructor() {
    super("Agent Harbor rejected duplicate active native tool call ID");
    this.name = "DuplicateNativeToolCallError";
  }
}

async function withNativeToolAbort(expectedName, args, invocation, action) {
  const exactInvocation = exactNativeToolInvocation(expectedName, args, invocation);
  const callKey = opaqueDigest("native-tool-call", exactInvocation.toolCallId);
  if (!callKey) throw new Error(`Agent Harbor custom tool ${expectedName} received an invalid Copilot call ID`);
  if (nativeToolControllers.has(callKey)) {
    throw new DuplicateNativeToolCallError();
  }
  const controller = new AbortController();
  const control = {
    controller,
    sessionId: exactInvocation.sessionId,
    project: undefined,
    runId: undefined,
    committed: false,
    bind(project, runId) {
      this.project = project;
      this.runId = runId;
    },
    markCommitted() { this.committed = true; },
  };
  nativeToolControllers.set(callKey, control);
  try {
    return await action(controller.signal, exactInvocation, control);
  } finally {
    if (nativeToolControllers.get(callKey) === control) {
      nativeToolControllers.delete(callKey);
    }
  }
}

function abortNativeTools(reason, scope = {}) {
  const abortReason = new DOMException(reason, "AbortError");
  for (const control of nativeToolControllers.values()) {
    if (scope.sessionId !== undefined && control.sessionId !== scope.sessionId) continue;
    if (scope.project !== undefined && control.project !== undefined &&
        !sameProject(scope.project, control.project)) continue;
    if (scope.runIds instanceof Set) {
      if (control.runId === undefined && !scope.includeUnbound) continue;
      if (control.runId !== undefined && !scope.runIds.has(control.runId)) continue;
    }
    if (!control.controller.signal.aborted) control.controller.abort(abortReason);
  }
  if (scope.sessionId !== undefined && scope.sessionId !== session.sessionId) return;
  for (const [runId, guard] of nativeScoutGuardsByRun) {
    if (scope.runIds instanceof Set && !scope.runIds.has(runId)) continue;
    const run = runtime.get(runId);
    if (scope.project !== undefined && (!run || !sameProject(scope.project, run.project))) continue;
    guard.terminate(reason);
  }
}

function logicalCopilotAgentId(agent) {
  if (!agent) return undefined;
  if (agent.id === copilotScoutAgentId) return scoutPlayer.name;
  for (const [logical, native] of copilotFixedAgentIds) {
    if (agent.id === native) return logical;
  }
  return isHarborId(agent.id) ? agent.id : undefined;
}

async function authenticatedNativeToolContext(expectedName, args, invocation, expectedAgent) {
  const exactInvocation = exactNativeToolInvocation(expectedName, args, invocation);
  const project = await currentProject();
  const current = await boundedHostCall("Copilot custom-tool current agent", () => session.rpc.agent.getCurrent());
  const logicalCurrent = logicalCopilotAgentId(current.agent);
  if (expectedAgent !== undefined) {
    if (logicalCurrent !== expectedAgent) {
      throw new Error(`Agent Harbor custom tool ${expectedName} is not owned by the current Copilot player`);
    }
    const listed = await boundedHostCall("Copilot custom-tool agent list", () => session.rpc.agent.list());
    const resolved = resolveCopilotPlayer(expectedAgent, listed.agents, project);
    if (!copilotAgentIdentityMatches(resolved, current.agent)) {
      throw new Error(`Agent Harbor custom tool ${expectedName} could not verify current-player ownership`);
    }
  } else if (current.agent !== undefined) {
    if (logicalCurrent === undefined || logicalCurrent === scoutPlayer.name) {
      throw new Error(`Agent Harbor custom tool ${expectedName} could not verify current-player ownership`);
    }
    requireInvocablePlayer("copilot", project, logicalCurrent);
    const listed = await boundedHostCall("Copilot custom-tool agent list", () => session.rpc.agent.list());
    const resolved = resolveCopilotPlayer(logicalCurrent, listed.agents, project);
    if (!copilotAgentIdentityMatches(resolved, current.agent)) {
      throw new Error(`Agent Harbor custom tool ${expectedName} could not verify current-player ownership`);
    }
  }
  return { exactInvocation, project, currentAgent: logicalCurrent };
}

function activeNativeToolRoot(expectedAgent, project, name) {
  const direct = activeDirect;
  const run = direct && runtime.get(direct.runId);
  if (!direct || direct.sessionId !== session.sessionId || direct.id !== expectedAgent ||
      !sameProject(direct.project, project) || !run || run.state === "cleaning" ||
      run.state === "completed" || run.state === "failed" || run.state === "cancelled") {
    throw new Error(`Agent Harbor custom tool ${name} requires an active ${expectedAgent} root run`);
  }
  return direct.runId;
}

function consumeNativeToolCall(runId, name) {
  const policy = harborCustomToolPolicy(name);
  if (!policy) throw new Error(`unknown Agent Harbor custom tool: ${name}`);
  let counts = nativeToolCallsByRun.get(runId);
  if (!counts) {
    counts = new Map();
    nativeToolCallsByRun.set(runId, counts);
  }
  const prior = counts.get(name) ?? 0;
  if (prior >= policy.maximumCalls) {
    throw new Error(`Agent Harbor custom tool ${name} reached its per-run limit (${policy.maximumCalls})`);
  }
  counts.set(name, prior + 1);
}

function scoutTurnGuard(runId) {
  let guard = nativeScoutGuardsByRun.get(runId);
  if (!guard) {
    guard = new HarborScoutTurnGuard();
    nativeScoutGuardsByRun.set(runId, guard);
  }
  return guard;
}

async function boundedScoutRoster(query, project, signal) {
  signal.throwIfAborted();
  const listed = await boundedHostCall(
    "Copilot talent-scout native roster",
    () => session.rpc.agent.list(),
    Math.min(hostRpcTimeoutMs, 3_000),
  );
  if (!Array.isArray(listed?.agents)) throw new Error("Copilot native roster is unavailable");
  const members = await boundedHostCall(
    "Agent Harbor talent-scout roster inventory",
    () => collectCopilotTeamMembers(project, {
      agents: listed.agents,
      discoveryAvailable: true,
      coordinatorReady,
      selectionRestoreUnverified: Boolean(selectionRestoreHazard),
    }),
    Math.min(hostRpcTimeoutMs, 3_000),
  );
  signal.throwIfAborted();
  const busyAgents = new Set(runtime.activeProjectRuns(project)
    .filter((run) => run.kind !== "contractor")
    .map((run) => run.agent));
  const specialists = members.flatMap((member) => {
    if (member.availability !== "ready" || !["fixed", "bundled", "personal"].includes(member.kind)) return [];
    const id = copilotPublicIdentifier(member.id, 48);
    if (!id || id === "team-lead" || id === scoutPlayer.name) return [];
    const configuredModel = copilotPublicIdentifier(member.configuredModel, 200);
    return [{
      id,
      role: copilotTaskLabel(member.description),
      tools: Array.isArray(member.tools) ? member.tools : [],
      skills: Array.isArray(member.skills) ? member.skills : [],
      ...(configuredModel ? { configuredModel } : {}),
      availability: busyAgents.has(id) ? "busy" : "ready",
    }];
  });
  return formatHarborTeamRosterSnapshot(specialists, query);
}

async function contractNativeTool(args, invocation) {
  const name = harborCustomToolNames.contractPreflight;
  let exactInvocation;
  try {
    return await withNativeToolAbort(name, args, invocation, async (signal, invocationIdentity, control) => {
      exactInvocation = invocationIdentity;
      signal.throwIfAborted();
      const context = await authenticatedNativeToolContext(name, args, invocation);
      const activeRoots = runtime.activeProjectRuns(context.project)
        .filter((run) => !run.parentRunId);
      const rootRunId = activeDirect?.project && sameProject(activeDirect.project, context.project)
        ? activeDirect.runId
        : activeRoots.length === 1 ? activeRoots[0].id : undefined;
      control.bind(context.project, rootRunId);
      signal.throwIfAborted();
      assertHarborCustomToolAccess(name, { skill: "contract" });
      const call = validateHarborCustomToolArguments(name, args);
      if (call.kind !== "contract-preflight") throw new Error("invalid Agent Harbor contract dispatch");
      const descriptor = JSON.parse(await runCopilotControl("contract", call.definition, context.project, signal));
      signal.throwIfAborted();
      await coordinator.contractToolSucceeded(exactInvocation, descriptor);
      return descriptor;
    });
  } catch (error) {
    if (error instanceof DuplicateNativeToolCallError) throw error;
    const failedInvocation = exactInvocation ?? (() => {
      try { return exactNativeToolInvocation(name, args, invocation); }
      catch { return undefined; }
    })();
    if (failedInvocation) {
      try { await coordinator.contractToolFailed(failedInvocation); }
      catch (sealError) {
        throw new AggregateError([error, sealError], "Agent Harbor contract preflight failed and its guard seal was rejected");
      }
    }
    throw error;
  }
}

async function playerSkillsNativeTool(player, args, invocation) {
  const spec = harborPlayerSkillToolSpec(player);
  return withNativeToolAbort(spec.name, args, invocation, async (signal, _invocationIdentity, control) => {
    signal.throwIfAborted();
    const context = await authenticatedNativeToolContext(spec.name, args, invocation, player.name);
    signal.throwIfAborted();
    assertHarborCustomToolAccess(spec.name, { agent: context.currentAgent });
    const call = validateHarborCustomToolArguments(spec.name, args);
    if (call.kind !== "player-skills" || call.player !== player.name) {
      throw new Error("invalid Agent Harbor bound-skill dispatch");
    }
    const runId = activeNativeToolRoot(player.name, context.project, spec.name);
    control.bind(context.project, runId);
    consumeNativeToolCall(runId, spec.name);
    const current = requireInvocablePlayer("copilot", context.project, player.name).definition;
    const loaded = await loadConfiguredSkills(current, context.project, new GhResolver(), trustedSkills, signal);
    signal.throwIfAborted();
    return formatLoadedSkillGroup(loaded);
  });
}

async function scoutNativeTool(name, args, invocation) {
  return withNativeToolAbort(name, args, invocation, async (signal, _invocationIdentity, control) => {
    signal.throwIfAborted();
    const provisional = activeDirect;
    const provisionalRun = provisional && runtime.get(provisional.runId);
    if (!provisional || provisional.sessionId !== session.sessionId || provisional.id !== scoutPlayer.name ||
        !provisionalRun || ["cleaning", "completed", "failed", "cancelled"].includes(provisionalRun.state)) {
      throw new Error(`Agent Harbor custom tool ${name} requires an active ${scoutPlayer.name} root run`);
    }
    // Reserve the one ordered scout call before asynchronous host
    // authentication. A stop/error during that RPC must not let the model retry
    // an already-attempted roster inspection or create a late mutation.
    const runId = provisional.runId;
    const guard = scoutTurnGuard(runId);
    const ticket = guard.begin(name, signal);
    let ticketSettled = false;
    try {
      const context = await authenticatedNativeToolContext(name, args, invocation, scoutPlayer.name);
      signal.throwIfAborted();
      assertHarborCustomToolAccess(name, { agent: context.currentAgent });
      const call = validateHarborCustomToolArguments(name, args);
      const verifiedRunId = activeNativeToolRoot(scoutPlayer.name, context.project, name);
      if (verifiedRunId !== runId) throw new Error("Agent Harbor talent-scout run identity changed during custom-tool authentication");
      control.bind(context.project, runId);
      if (call.kind === "team-roster") {
        const snapshot = await boundedScoutRoster(call.query, context.project, signal);
        signal.throwIfAborted();
        guard.succeed(ticket, { rosterComplete: snapshot.complete });
        ticketSettled = true;
        return snapshot.text;
      }
      if (call.kind === "filter-skills") {
        const matches = await filterTrustedSkills(call.query, trustedSkills, new GhResolver(), signal);
        signal.throwIfAborted();
        guard.succeed(ticket);
        ticketSettled = true;
        return formatScoutSkillMatches(matches);
      }
      if (call.kind !== "join-player") throw new Error("invalid Agent Harbor talent-scout dispatch");
      await runDeterministicCommand("copilot", "join", call.definition, context.project, signal);
      // Returning from the deterministic command is the transaction boundary.
      // An abort racing after it must not turn a committed roster mutation into
      // a reported failure or skip reconciliation.
      guard.succeed(ticket);
      ticketSettled = true;
      control.markCommitted();
      let refreshReady = true;
      try {
        await boundedHostCall("Copilot coordinator refresh", () => coordinator.refreshAuthoritative());
        coordinatorReady = true;
      } catch {
        coordinatorReady = false;
        refreshReady = false;
      }
      const cancelledAfterCommit = signal.aborted;
      updateSessionPersonalAdmission("join", call.definition, refreshReady);
      const concise = conciseCopilotJoinResult(call.definition, refreshReady);
      const commitNotice = cancelledAfterCommit
        ? "\nRoster commit preserved: cancellation arrived after the player was joined."
        : "";
      return refreshReady
        ? `${concise}${commitNotice}`
        : `${concise}\nRoster updated, but Copilot refresh failed; reload the session before invoking the changed player.${commitNotice}`;
    } catch (error) {
      if (!ticketSettled) {
        try { guard.fail(ticket, signal); }
        catch (guardError) {
          throw new AggregateError([error, guardError], "Agent Harbor talent-scout call and shared guard settlement failed");
        }
      }
      throw error;
    }
  });
}

function copilotNativeTool(spec, handler, defer = "auto") {
  return {
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    handler: async (...args) => {
      try { return await handler(...args); }
      catch (error) { throw publicNativeToolError(error); }
    },
    skipPermission: true,
    defer,
  };
}

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
  let snapshot;
  try {
    snapshot = await boundedTeamCall(
      "Copilot team metadata snapshot",
      () => session.rpc.metadata.snapshot(),
      deadline,
      350,
    );
    const observed = rememberProjectScope(snapshot.workingDirectory);
    if (!observed && !projectScopeVerified) throw new Error("Copilot metadata did not identify a project");
  } catch {
    degraded.push(projectScopeVerified ? "using cached project scope" : "project scope unavailable");
  }
  return { project: projectScopeVerified ? lastKnownProject : undefined, snapshot };
}

async function boundedTeamModel(deadline, degraded) {
  try {
    const current = await boundedTeamCall("Copilot team current model", () => session.rpc.model.getCurrent(), deadline, 400);
    return normalizedCurrentModelSettings(current);
  } catch {
    degraded.push("host model settings unavailable");
    return { modelUnreported: true };
  }
}

function nonnegativeFinite(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function nonnegativeTokenCount(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function displayCount(value) {
  return Number.isInteger(value) ? value.toLocaleString("en-US") : String(value);
}

async function boundedTeamHostActivity(deadline, degraded) {
  const [activity, processing] = await Promise.allSettled([
    boundedTeamCall("Copilot team activity", () => session.rpc.metadata.activity(), deadline, 300),
    boundedTeamCall("Copilot team processing state", () => session.rpc.metadata.isProcessing(), deadline, 300),
  ]);
  if (activity.status === "rejected" || processing.status === "rejected") {
    degraded.push("host activity state partially unavailable");
  }
  return {
    hasActiveWork: activity.status === "fulfilled" && activity.value?.hasActiveWork === true,
    processing: processing.status === "fulfilled" && processing.value?.processing === true,
    abortable: activity.status === "fulfilled" && activity.value?.abortable === true,
  };
}

async function boundedTeamContext(deadline, degraded) {
  if (typeof session.rpc.metadata.contextInfo !== "function") return undefined;
  try {
    const result = await boundedTeamCall(
      "Copilot team context usage",
      () => session.rpc.metadata.contextInfo({ promptTokenLimit: 0, outputTokenLimit: 0 }),
      deadline,
      350,
    );
    const info = result?.contextInfo;
    if (!info) return undefined;
    // Current SDK names are totalTokens/promptTokenLimit; accept the equivalent
    // usage-info names if a host exposes that shape directly.
    const currentTokens = nonnegativeTokenCount(info.currentTokens ?? info.totalTokens);
    const tokenLimit = nonnegativeTokenCount(info.tokenLimit ?? info.promptTokenLimit);
    const totalLimit = nonnegativeTokenCount(info.limit);
    const outputTokenLimit = tokenLimit !== undefined && totalLimit !== undefined && totalLimit > tokenLimit
      ? totalLimit - tokenLimit
      : undefined;
    const toolDefinitionsTokens = nonnegativeTokenCount(info.toolDefinitionsTokens);
    if (currentTokens === undefined && tokenLimit === undefined && outputTokenLimit === undefined &&
        toolDefinitionsTokens === undefined) return undefined;
    return { currentTokens, tokenLimit, outputTokenLimit, toolDefinitionsTokens };
  } catch {
    degraded.push("host context usage unavailable");
    return undefined;
  }
}

function teamSdkContextLines(context, snapshot) {
  const parts = [];
  if (context?.currentTokens !== undefined) parts.push(`currentTokens ${displayCount(context.currentTokens)}`);
  if (context?.tokenLimit !== undefined) parts.push(`tokenLimit ${displayCount(context.tokenLimit)}`);
  if (context?.outputTokenLimit !== undefined) {
    parts.push(`outputTokenLimit ${displayCount(context.outputTokenLimit)}`);
  }
  if (context?.toolDefinitionsTokens !== undefined) {
    parts.push(`toolDefinitionsTokens ${displayCount(context.toolDefinitionsTokens)}`);
  }
  const maxAiCredits = nonnegativeFinite(snapshot?.sessionLimits?.maxAiCredits);
  const lines = parts.length ? [`Context (Copilot SDK): ${parts.join(" · ")}`] : [];
  if (maxAiCredits !== undefined) {
    lines.push(`AI-credit limit (Copilot SDK): maxAiCredits ${displayCount(maxAiCredits)}`);
  }
  return lines;
}

async function showTeam(args, title = "team", allowStop = true) {
  const raw = typeof args === "string" ? args : "";
  if (raw.length > maximumTeamArgumentBytes || Buffer.byteLength(raw, "utf8") > maximumTeamArgumentBytes) {
    throw new Error(`Agent Harbor /${title} arguments exceed ${maximumTeamArgumentBytes} bytes`);
  }
  const value = raw.trim();
  const deadline = Date.now() + teamBudgetMs;
  if (title === "team" && (value === "help" || value === "--help")) {
    const output = [
      "Agent Harbor Copilot team help · 0 model tokens",
      "/team                         Show roster, live work or, when idle, the last mission.",
      "/team <filter>                Match free text, or use a field prefix:",
      "  member:/id: · kind:/role: · description:",
      "  tool: · capability: · skill: · status:/state: · model: · reasoning: · task: · run:",
      "/team stop <run-id|all>       Request cancellation for one mission or all active missions.",
      "Choose one teammate: /<id> <task> or /player <id> <task>.",
      "Personal model: /join JSON with model:\"provider/model\"; add replace:true to change it.",
      "Limits: 32 concurrent roots per project; 6 sequential team-lead delegations per prompt.",
      "Bounded views disclose omitted rows; tasks are lossy/redacted and activity is process-local.",
      "Tokens, AI credits, and max-output are observed only when Copilot SDK reports them.",
      "Agent Harbor does not simulate a hard per-run token cap; its own gates are concurrency and six delegations.",
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
  const { project, snapshot } = await boundedTeamProject(observationDeadline, degraded);
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
    abortNativeTools(`Agent Harbor /team stop requested for ${target}`, {
      project,
      runIds: new Set(roots.map(({ id }) => id)),
      includeUnbound: target === "all" || roots.length === 1,
    });
    const stopResults = await Promise.allSettled(roots.map(async (run) => {
      const abort = abortableRoots.get(run.id);
      if (!abort) throw new Error(`Agent Harbor run is no longer controlled: ${run.id}`);
      await boundedTeamCall(`Copilot stop ${run.id}`, abort, deadline, teamBudgetMs);
    }));
    const stopping = [];
    const failed = [];
    for (let index = 0; index < stopResults.length; index += 1) {
      const run = roots[index];
      const outcome = stopResults[index];
      if (outcome.status === "fulfilled") stopping.push(run.id);
      else failed.push({
        id: run.id,
        state: runtime.get(run.id)?.state ?? run.state,
        reason: errorMessage(outcome.reason),
      });
    }
    const output = [
      "Agent Harbor Copilot stop · 0 model tokens",
      ...(stopping.length
        ? [`Stopping ${stopping.length} root run(s): ${stopping.join(", ")}.`]
        : ["No root stop request was confirmed by Copilot."]),
      ...(failed.length
        ? [
            `Failed or unconfirmed ${failed.length} root stop request(s):`,
            ...failed.map(({ id, state, reason }) => `• ${id} · state ${state} · ${reason}`),
            "Inspect /team: a cleaning run remains blocked from reuse until its terminal event.",
          ]
        : []),
    ].join("\n");
    await boundedTeamCall(
      "Copilot team stop display",
      () => displayLog(output, { level: "warning" }),
      deadline,
      logRpcTimeoutMs,
    );
    if (failed.length) {
      throw new Error(
        `Agent Harbor could not confirm stop for ${failed.map(({ id }) => id).join(", ")}; ` +
        "inspect /team and wait for every cleaning run to settle",
      );
    }
    return;
  }
  const [model, nativeDiscovery, hostActivity, context] = await Promise.all([
    boundedTeamModel(observationDeadline, degraded),
    listNativeTeamAgents(observationDeadline, degraded),
    boundedTeamHostActivity(observationDeadline, degraded),
    boundedTeamContext(observationDeadline, degraded),
  ]);
  const trackedActivity = runtime.activeProjectRuns(project).length > 0;
  const untrackedHostActivity = !trackedActivity && (hostActivity.hasActiveWork || hostActivity.processing);
  const selectionGates = [
    currentTeamSelectionGate(),
    ...(untrackedHostActivity
      ? ["Copilot host work is active outside Agent Harbor tracking; wait or use Copilot's native stop control"]
      : []),
  ].filter(Boolean);
  const selectionGate = selectionGates.join("; ") || undefined;
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
        nextModelUnreported: model.modelUnreported,
        nextReasoning: model.reasoningEffort,
        nextMaxOutputTokens: context?.outputTokenLimit,
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
  const sdkContextLines = teamSdkContextLines(context, snapshot);
  if (sdkContextLines.length) output += `\n\n${sdkContextLines.join("\n")}`;
  if (untrackedHostActivity) {
    const sources = [
      ...(hostActivity.hasActiveWork ? ["metadata.activity.hasActiveWork"] : []),
      ...(hostActivity.processing ? ["metadata.isProcessing"] : []),
    ];
    const hostBlock = [
      "HOST ACTIVITY (Copilot SDK; outside Agent Harbor tracking)",
      `● Copilot host · active · ${sources.join(" + ")}`,
      `  Cancellation: ${hostActivity.abortable ? "available through Copilot's native stop control" : "not reported as abortable by Copilot"}.`,
      "  No Agent Harbor run ID exists for this work; delegation remains closed.",
    ].join("\n");
    output = output.replace(
      "No one is working right now.",
      "No Agent Harbor mission is tracked; Copilot reports other active host work below.",
    );
    output = output.includes("\n\nROSTER")
      ? output.replace("\n\nROSTER", `\n\n${hostBlock}\n\nROSTER`)
      : `${output}\n\n${hostBlock}`;
  }
  await boundedTeamCall("Copilot team display", () => displayLog(output, { level: "info" }), deadline, logRpcTimeoutMs);
}

const knownPlayers = new Map([...rolePlayers, ...bundledPlayers]);
const startupActiveDiscovery = discoverStartupActiveProfiles("copilot", process.cwd());
const startupActiveIds = startupActiveDiscovery.ids;
for (const id of startupActiveIds) sessionInvocablePersonalIds.add(id);
const callableIds = [...new Set([...knownPlayers.keys(), ...startupActiveIds])];
const startupSkillPlayers = new Map(rolePlayers);
for (const id of startupActiveIds) {
  try {
    const player = requireInvocablePlayer("copilot", process.cwd(), id).definition;
    startupSkillPlayers.set(player.name, player);
  } catch { /* Stale or conflicting startup profiles do not receive native tools. */ }
}
const copilotNativeTools = [
  copilotNativeTool(
    harborStaticCustomToolSpecs[harborCustomToolNames.contractPreflight],
    contractNativeTool,
    "never",
  ),
  ...[harborCustomToolNames.teamRoster, harborCustomToolNames.filterSkills, harborCustomToolNames.joinPlayer].map((name) =>
    copilotNativeTool(harborStaticCustomToolSpecs[name], (args, invocation) =>
      scoutNativeTool(name, args, invocation))),
  ...[...startupSkillPlayers.values()]
    .filter((player) => player.skills?.length)
    .map((player) => {
      const spec = harborPlayerSkillToolSpec(player);
      registeredNativeSkillTools.add(spec.name);
      return copilotNativeTool(spec, (args, invocation) => playerSkillsNativeTool(player, args, invocation));
    }),
];

session = await joinSession({
  tools: copilotNativeTools,
  hooks: coordinator.hooks,
  commands: [
    {
      name: "team",
      description: "0 model tokens · /team [help|filter|stop <run-id|all>] · Show roster, live work or, when idle, the last mission.",
      handler: async ({ args }) => {
        try { await showTeam(args); }
        catch (error) {
          void safeLog(`[Agent Harbor team · 0 model tokens]\n${errorMessage(error)}`, { level: "error" });
          throw publicFacingError(error);
        }
      },
    },
    {
      name: "player",
      description: "1 model root · /player <id> <task> · Run any currently active Agent Harbor teammate, including one just joined.",
      handler: async ({ args }) => {
        const raw = typeof args === "string" ? args : "";
        if (raw.length > 30_000 || Buffer.byteLength(raw, "utf8") > 30_000) {
          const error = new PlayerPreflightError("Agent Harbor task exceeds 30000 bytes");
          await safeLog(`[Agent Harbor player · preflight · 0 model tokens]\n${error.message}`, { level: "error" });
          throw error;
        }
        const input = raw.trim();
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
          throw publicFacingError(error);
        }
      },
    },
    ...controls.map(([name, description]) => ({
      name,
      description,
      handler: async ({ args }) => {
        try {
          const raw = typeof args === "string" ? args : "";
          const maximumBytes = name === "join" ? maximumDefinitionArgumentBytes : maximumLifecycleArgumentBytes;
          if (raw.length > maximumBytes || Buffer.byteLength(raw, "utf8") > maximumBytes) {
            throw new Error(`Agent Harbor /${name} arguments exceed ${maximumBytes} bytes`);
          }
          const value = raw.trim();
          const listFilter = name === "bench" ? benchListFilter(value) : undefined;
          if (name === "bench" && listFilter !== undefined) {
            await showTeam(listFilter, "bench", false);
            return;
          }
          const project = await currentProject();
          if (name === "retire") {
            const busy = runtime.activeProjectRuns(project).find((run) =>
              run.kind !== "contractor" && run.agent === value);
            if (busy) {
              throw new Error(
                `cannot retire ${value} while it is ${busy.state} in ${busy.rootRunId}; ` +
                `use /team stop ${busy.rootRunId}, then wait for cleanup to settle`,
              );
            }
          }
          const result = await runDeterministicCommand("copilot", name, raw, project, undefined, name === "list-skills" ? "copilot" : "plain");
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
          updateSessionPersonalAdmission(name, raw, !refreshWarning);
          const heading = name === "list-skills" ? "Agent Harbor · skill catalog · 0 model tokens" : `Agent Harbor /${name} · 0 model tokens`;
          const pendingSkillReload = name === "bench" && /^on\b/u.test(value)
            ? playersPendingNativeSkillReload(project)
            : [];
          const lifecycleNotice = name === "retire"
            ? "\nThe retired player is blocked immediately through /player; a startup alias may remain visible until /reload."
            : pendingSkillReload.length
              ? `\nNative skill loader pending for ${pendingSkillReload.join(", ")}; /player stops before model use until /reload registers it.`
              : "";
          const publicResult = `${name === "join" ? conciseCopilotJoinResult(raw, !refreshWarning) : result}${lifecycleNotice}`;
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
          throw publicFacingError(error);
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
          throw publicFacingError(error);
        }
      },
    },
    ...callableIds.map((id) => ({
      name: id,
      description: `1 model root · /${id} <task> · ${publicMetadataText(
        knownPlayers.get(id)?.description ?? `Run active Agent Harbor player ${id}.`,
        240,
      ) ?? `Run active Agent Harbor player ${id}.`}`,
      handler: async ({ args }) => {
        try { await runPlayer(id, args); }
        catch (error) {
          const budget = error instanceof PlayerPreflightError ? " · Preflight stopped · 0 model tokens" : "";
          await safeLog(`[Agent Harbor player · ${id}${budget}]\n${errorMessage(error)}`, { level: "error" });
          throw publicFacingError(error, id);
        }
      },
    })),
  ],
});

if (startupActiveDiscovery.diagnostics.length) {
  const details = startupActiveDiscovery.diagnostics.flatMap((diagnostic) => [
    `• ${copilotPublicIdentifier(diagnostic.message, 320) ?? "A project profile was omitted from startup discovery."}`,
    `  Repair: ${copilotPublicIdentifier(diagnostic.repair, 320) ?? "Repair the active-profile directory and reload Copilot."}`,
  ]);
  void safeLog([
    "[Agent Harbor startup · bounded profile discovery · 0 model tokens]",
    "Some project profiles were omitted and cannot be invoked in this session.",
    ...details,
  ].join("\n"), { level: "warning" });
}

function eventMatchesCurrentSession(event) {
  const explicitScopes = [event.sessionId, event.data?.sessionId]
    .filter((value) => value !== undefined);
  return explicitScopes.every((value) => value === session.sessionId);
}

session.on((event) => {
  const terminalType = ["abort", "session.error", "session.idle", "session.shutdown"].includes(event.type);
  if (terminalType && !eventMatchesCurrentSession(event)) return;
  const sessionTerminal = terminalType;
  if (sessionTerminal) {
    const reason = {
      abort: "Copilot aborted an active Agent Harbor native tool",
      "session.error": "Copilot reported a session error while an Agent Harbor native tool was active",
      "session.idle": "Copilot became idle while an Agent Harbor native tool was active",
      "session.shutdown": "Copilot shut down while an Agent Harbor native tool was active",
    }[event.type];
    abortNativeTools(reason, { sessionId: session.sessionId });
  }
  coordinator.observeEvent(event);
  if (sessionTerminal) {
    clearGuardEvidenceQueues();
  }
  // Copilot exposes a hook ID only on hook.end, not to the preToolUse callback.
  // Coordinator admission is sequential, so a bounded FIFO is the strongest
  // correlation available; claimed replay filtering prevents a duplicate shift.
  if (event.type !== "hook.end" || event.data?.hookType !== "preToolUse") return;
  if (coordinator.hostEventDisposition(event) !== "claimed") return;
  const evidence = guardEvidenceQueue.shift();
  if (!evidence) return;
  queueGuardEvidenceLog(evidence);
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
  void safeLog("[Agent Harbor startup · 0 model tokens]\nInitial native discovery is still pending. /team will retry it; reload Copilot only if /team remains degraded.", { level: "info" });
}
