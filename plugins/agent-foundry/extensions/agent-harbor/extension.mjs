/**
 * Copilot extension bootstrap. Deterministic controls never send a prompt;
 * explicit player commands select one validated native agent for one bounded
 * host turn and expose project-shared persistent-player activity through `/team`.
 */
import { createHash, randomBytes } from "node:crypto";
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
  formatCopilotElapsed,
  formatCopilotModel,
  formatCopilotMissionReport,
  formatCopilotReasoning,
  formatCopilotTokenCount,
} from "../../runtime/dist/adapters/copilot-team-runtime.js";
import {
  collectCopilotTeamMembers,
  formatCopilotDegradedTeamView,
  formatCopilotTeamView,
} from "../../runtime/dist/adapters/copilot-team-view.js";
import { runCopilotControl } from "../../runtime/dist/adapters/copilot.js";
import { runDeterministicCommandResult } from "../../runtime/dist/adapters/direct.js";
import {
  claimValidatedSharedAgentActivity,
  readSharedAgentActivities,
  withSharedRosterMutationGate,
} from "../../runtime/dist/adapters/opencode-agent-activity.js";
import {
  discoverStartupActiveProfiles,
  listInvocablePlayers,
  requireInvocablePlayer,
} from "../../runtime/dist/core/active.js";
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
import { playerDefinitionDigest } from "../../runtime/dist/core/profiles.js";
import {
  canonicalProjectIdentity,
  sameCanonicalProject,
} from "../../runtime/dist/core/project-identity.js";
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

class CopilotTeamStopOutcomeError extends Error {
  constructor(message) {
    super(message);
    // The command already emitted the bounded, actionable stop outcome. Keep
    // the host-facing error conventional while letting the handler suppress a
    // second copy of the same visible result.
    this.name = "Error";
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

function isLifecycleMutationStatus(value) {
  return value === "changed" || value === "already-current";
}

function requireCopilotJoinLifecycleOutcome(args, lifecycle) {
  const input = JSON.parse(args);
  if (lifecycle?.command !== "join" || typeof input?.name !== "string" ||
      lifecycle.player !== input.name || !isLifecycleMutationStatus(lifecycle.status)) {
    throw new Error("Agent Harbor join returned an incomplete or mismatched lifecycle outcome; roster state is unverified");
  }
  return lifecycle;
}

function requireCopilotRetireLifecycleOutcome(args, lifecycle) {
  const player = args.trim();
  if (lifecycle?.command !== "retire" || lifecycle.player !== player ||
      !isLifecycleMutationStatus(lifecycle.status)) {
    throw new Error("Agent Harbor retire returned an incomplete or mismatched lifecycle outcome; roster state is unverified");
  }
  return lifecycle;
}

function expectedCopilotBenchMutation(args) {
  const match = /^(on|off)\s+(.+)$/u.exec(args.trim());
  if (!match) throw new Error("Agent Harbor bench mutation could not be verified");
  const requested = match[2].split(/[\s,]+/u).filter(Boolean);
  const ids = requested.length === 1 && requested[0] === "all"
    ? [...bundledPlayers.keys()]
    : [...new Set(requested)];
  if (!ids.length) throw new Error("Agent Harbor bench mutation could not be verified");
  return { action: match[1], ids };
}

function requireCopilotBenchLifecycleOutcome(args, lifecycle) {
  const expected = expectedCopilotBenchMutation(args);
  if (lifecycle?.command !== "bench" || !isLifecycleMutationStatus(lifecycle.status) ||
      !Array.isArray(lifecycle.rows) || lifecycle.rows.length !== expected.ids.length ||
      lifecycle.rows.some((row, index) => row?.id !== expected.ids[index] ||
        row.action !== expected.action || !isLifecycleMutationStatus(row.status)) ||
      lifecycle.status !== (lifecycle.rows.some(({ status }) => status === "changed") ? "changed" : "already-current")) {
    throw new Error("Agent Harbor bench returned an incomplete or mismatched lifecycle outcome; roster state is unverified");
  }
  return lifecycle;
}

function conciseCopilotJoinResult(args, refreshReady, lifecycle) {
  const input = JSON.parse(args);
  const verifiedLifecycle = requireCopilotJoinLifecycleOutcome(args, lifecycle);
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
  if (verifiedLifecycle.status === "already-current") {
    const summary = [
      `○ ${id} is already joined and current · no roster files changed.`,
      `Role: ${role}`,
      `Capacity: ${capacity}`,
      `Model: ${configuredModel ? `configured ${configuredModel}` : "inherits the current Copilot host when run"}`,
    ];
    return refreshReady && skillLoaderReady
      ? [
          ...summary,
          `Discovery reconciled: verify with /team member:${id}; run only when it reports ready.`,
          `When ready: /player ${id} <task>`,
          `After restarting Copilot: /${id} <task>`,
        ].join("\n")
      : [
          ...summary,
          "Discovery is not current in this Copilot session; reload, then inspect /team before invocation.",
          `After reload: /player ${id} <task> or /${id} <task>`,
        ].join("\n");
  }
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

function conciseCopilotBenchResult(lifecycle) {
  const rows = lifecycle.rows.map(({ id, action, status }) => status === "changed"
    ? action === "on"
      ? `✓ ${id} enabled in this project.`
      : `✓ ${id} moved to the bench in this project.`
    : `○ ${id} is already ${action === "on" ? "enabled" : "benched"} · this member was unchanged.`);
  if (lifecycle.status === "already-current") rows.push("No roster files changed.");
  if (lifecycle.rows.length <= 8) return rows.join("\n");
  const changed = lifecycle.rows.filter(({ status }) => status === "changed").map(({ id }) => id);
  const unchanged = lifecycle.rows.filter(({ status }) => status !== "changed").map(({ id }) => id);
  const action = lifecycle.rows[0]?.action ?? "update";
  const sample = (ids) => `${ids.slice(0, 4).join(", ") || "none"}${ids.length > 4 ? ` (+${ids.length - 4})` : ""}`;
  return wrapPlainText([
    `Bench ${action} · ${lifecycle.rows.length} requested · ${changed.length} changed · ${unchanged.length} unchanged.`,
    `Changed IDs: ${sample(changed)}`,
    `Unchanged IDs: ${sample(unchanged)}`,
    "Verify every roster ID and state: /bench list page:1",
  ].join("\n"));
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
  let mutation;
  try { mutation = expectedCopilotBenchMutation(value); }
  catch { return; }
  if (mutation.action === "on" && refreshReady && startupActiveDiscovery.complete) {
    for (const id of mutation.ids) {
      if (!rolePlayers.has(id) && !bundledPlayers.has(id) && id !== scoutPlayer.name) {
        sessionInvocablePersonalIds.add(id);
      }
    }
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
const sharedActivityClaims = new Map();
const sharedActivityClaimProjects = new Map();
const sharedActivityOwnershipUnsubscribers = new Map();
const sharedActivityAuthorityFailures = new Map();
// An exact shared claim is also the only object allowed to prove its eventual
// release. Keep failed generations in memory by physical project until that
// same object reports a successful release; ordinary run cleanup must never
// erase authority that it could not verify.
const sharedActivityProjectHazards = new Map();
const rootRosterReservations = new Map();
let rosterLifecycleTail = Promise.resolve();
async function withRosterLifecycleGate(action) {
  const previous = rosterLifecycleTail;
  let release;
  rosterLifecycleTail = new Promise((resolveGate) => { release = resolveGate; });
  await previous;
  try { return await action(); }
  finally { release(); }
}
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
const progressIntervalMs = boundedEnvironmentNumber("AGENT_HARBOR_COPILOT_PROGRESS_MS", 15_000, 50, 60_000);
const maximumProgressLogsPerRoot = 12;
const progressTrackers = new Map();
let lastKnownProject;
let projectScopeVerified = false;

runtime.subscribe((runId) => {
  const claim = sharedActivityClaims.get(runId);
  const run = runtime.get(runId);
  if (!claim || !run) return;
  const phase = run.state === "working" || run.state === "waiting" ? "working"
    : run.state === "cleaning" ? "cleaning" : undefined;
  if (!phase) return;
  publishSharedActivityPhase(runId, phase);
});

function publishSharedActivityPhase(runId, phase) {
  const claim = sharedActivityClaims.get(runId);
  const run = runtime.get(runId);
  if (!claim || !run || claim.setPhase(phase)) return;
  throw failSharedActivityOwnership(runId, `before ${phase}`);
}

function failSharedActivityOwnership(runId, detail) {
  const run = runtime.get(runId);
  const claim = sharedActivityClaims.get(runId);
  const project = sharedActivityClaimProjects.get(runId);
  const prior = sharedActivityAuthorityFailures.get(runId);
  const owner = run ? `${run.agent}'s` : "the player's";
  const failure = prior ?? new Error(
    `Agent Harbor lost ${owner} exact project-shared activity ownership ${detail}; model work was aborted`,
  );
  sharedActivityAuthorityFailures.set(runId, failure);
  if (run && claim && project) recordSharedActivityProjectHazard(project, runId, run.agent, claim, failure);
  if (run && run.state !== "cleanup-error") runtime.setState(runId, "cleanup-error");
  const abort = run && abortableRoots.get(run.rootRunId);
  if (abort) void Promise.resolve(abort()).catch(() => undefined);
  return failure;
}

function sharedRunIdentity(agent) {
  return `copilot:${process.pid}:${agent}:${randomBytes(12).toString("base64url")}`;
}

function sharedActivityProjectKey(project) {
  return canonicalProjectIdentity(project);
}

function recordSharedActivityProjectHazard(project, runId, agent, claim, failure, retryable = false) {
  const key = sharedActivityProjectKey(project);
  let hazards = sharedActivityProjectHazards.get(key);
  if (!hazards) {
    hazards = new Map();
    sharedActivityProjectHazards.set(key, hazards);
  }
  const prior = hazards.get(claim);
  if (prior) {
    if (retryable) prior.retryable = true;
  } else {
    hazards.set(claim, { project: key, runId, agent, claim, failure, retryable });
  }
  return hazards.get(claim);
}

function clearReleasedSharedActivityClaim(runId, claim) {
  if (runId !== undefined && sharedActivityClaims.get(runId) === claim) {
    sharedActivityOwnershipUnsubscribers.get(runId)?.();
    sharedActivityOwnershipUnsubscribers.delete(runId);
    sharedActivityClaims.delete(runId);
    sharedActivityClaimProjects.delete(runId);
    sharedActivityAuthorityFailures.delete(runId);
  }
  for (const [project, hazards] of sharedActivityProjectHazards) {
    hazards.delete(claim);
    if (!hazards.size) sharedActivityProjectHazards.delete(project);
  }
}

function releaseExactSharedActivityClaim(runId, claim) {
  let released = false;
  try { released = claim.release(); }
  catch { /* A release exception is the same authority hazard as a false result. */ }
  if (released) clearReleasedSharedActivityClaim(runId, claim);
  return released;
}

function recoverSharedActivityProjectHazards(project) {
  const key = sharedActivityProjectKey(project);
  const hazards = sharedActivityProjectHazards.get(key);
  if (!hazards) return undefined;
  for (const [claim, hazard] of [...hazards]) {
    // Ownership loss aborts the live model run first. Only terminal cleanup (or
    // a failed admission cleanup) makes a later exact-release retry safe.
    if (hazard.retryable) releaseExactSharedActivityClaim(hazard.runId, claim);
  }
  return sharedActivityProjectHazards.get(key);
}

function projectSharedActivityHazardMessage() {
  return "Agent Harbor project-shared activity ownership/release is unverified; reload Copilot or repair the managed activity claim before another persistent-player run";
}

function assertNoSharedActivityProjectHazard(project) {
  if (recoverSharedActivityProjectHazards(project)?.size) {
    throw new Error(projectSharedActivityHazardMessage());
  }
}

function releaseSharedActivity(runId) {
  const claim = sharedActivityClaims.get(runId);
  if (!claim) return !sharedActivityAuthorityFailures.has(runId);
  sharedActivityOwnershipUnsubscribers.get(runId)?.();
  sharedActivityOwnershipUnsubscribers.delete(runId);
  const released = releaseExactSharedActivityClaim(runId, claim);
  if (!released) {
    const run = runtime.get(runId);
    const project = sharedActivityClaimProjects.get(runId);
    const failure = sharedActivityAuthorityFailures.get(runId) ?? new Error(
      `Agent Harbor could not verify release of ${run?.agent ?? "the player"}'s exact project-shared activity claim`,
    );
    sharedActivityAuthorityFailures.set(runId, failure);
    if (run && project) {
      recordSharedActivityProjectHazard(project, runId, run.agent, claim, failure, true);
      runtime.setState(runId, "cleanup-error");
    }
  }
  return released;
}

function currentPersistentDefinition(project, id) {
  if (id === scoutPlayer.name) return scoutPlayer;
  return rolePlayers.get(id) ?? requireInvocablePlayer("copilot", project, id).definition;
}

function beginSharedPersistentRun(input, claimKind, validateAdmission) {
  assertNoSharedActivityProjectHazard(input.project);
  const claim = claimValidatedSharedAgentActivity(
    input.project,
    input.agent,
    claimKind,
    sharedRunIdentity(input.agent),
    "copilot",
    validateAdmission,
  );
  try {
    const runId = runtime.begin(input);
    sharedActivityClaims.set(runId, claim);
    sharedActivityClaimProjects.set(runId, sharedActivityProjectKey(input.project));
    sharedActivityOwnershipUnsubscribers.set(runId, claim.onOwnershipLost(() => {
      failSharedActivityOwnership(runId, "while its heartbeat was active");
    }));
    return runId;
  } catch (error) {
    if (!releaseExactSharedActivityClaim(undefined, claim)) {
      const releaseFailure = new Error(
        `Agent Harbor could not verify release of ${input.agent}'s exact project-shared activity claim`,
      );
      recordSharedActivityProjectHazard(input.project, undefined, input.agent, claim, releaseFailure, true);
      throw new AggregateError(
        [error, releaseFailure],
        `Copilot admission failed and ${input.agent}'s shared activity claim could not be released`,
      );
    }
    throw error;
  }
}

function rememberProjectScope(project) {
  if (typeof project !== "string" || !project.trim()) return undefined;
  let canonical;
  try { canonical = canonicalProjectIdentity(project); }
  catch { return undefined; }
  lastKnownProject = canonical;
  projectScopeVerified = true;
  return canonical;
}

function sharedPersistentClaimCount(project) {
  return readSharedAgentActivities(project).length;
}

function assertSharedCapacityCount(count, requiredSlots, label) {
  if (count + requiredSlots > 32) {
    throw new Error(
      `Agent Harbor ${label} needs ${requiredSlots} project-shared slot${requiredSlots === 1 ? "" : "s"}, ` +
      `but ${count}/32 persistent claims are active. No session.send/model request was attempted · 0 model tokens; inspect /team page:1 ` +
      "and stop settled work in its owning runtime.",
    );
  }
}

function assertSharedCapacityHeadroom(project, requiredSlots, label) {
  assertSharedCapacityCount(sharedPersistentClaimCount(project), requiredSlots, label);
}

function invocationRosterSnapshot(project, owner) {
  const entries = listInvocablePlayers("copilot", project)
    .filter(({ id }) => id !== "team-lead" && id !== scoutPlayer.name);
  const modelFacing = entries.map(({ id, definition }) => ({
    id,
    role: definition.description,
    tools: definition.tools,
    skills: (definition.skills ?? []).map(({ name }) => name),
    ...(definition.model ? { configuredModel: definition.model } : {}),
    // Completeness/count/byte validation must be pure because it is repeated
    // under the shared capacity lock. Live busy state remains authoritative in
    // the one model-facing harbor_team_roster tool call.
    availability: "ready",
  }));
  const formatted = formatHarborTeamRosterSnapshot(modelFacing, "", "/bench off <id...>");
  return {
    ids: new Set(entries.map(({ id }) => id)),
    formatted,
    digest: entries
      .map(({ id, definition }) => `${id}:${playerDefinitionDigest(definition)}`)
      .sort()
      .join("\n"),
  };
}

function protectedRosterTargets(command, args) {
  const value = args.trim();
  if (command === "retire") return value ? [value] : [];
  if (command === "join") {
    try {
      const input = JSON.parse(value);
      return input?.replace === true && isHarborId(input.name) ? [input.name] : [];
    } catch { return []; }
  }
  if (command !== "bench") return [];
  const match = /^off\s+(.+)$/u.exec(value);
  if (!match) return [];
  const requested = [...new Set(match[1].split(/[\s,]+/u).filter(Boolean))];
  return requested.length === 1 && requested[0] === "all"
    ? [...bundledPlayers.keys()]
    : requested;
}

function rosterMutationAction(command, target) {
  if (command === "retire") return `retire ${target}`;
  if (command === "join") return `replace ${target}`;
  return `bench off ${target}`;
}

function assertRosterMutationAllowed(project, command, args, ignoredRunId) {
  for (const target of protectedRosterTargets(command, args)) {
    const busy = runtime.activeProjectRuns(project).find((run) =>
      run.kind !== "contractor" && run.agent === target && run.id !== ignoredRunId);
    if (busy) {
      throw new Error(
        `cannot ${rosterMutationAction(command, target)} while it is ${busy.state} in ${busy.rootRunId}; ` +
        `use /team stop ${busy.rootRunId}, then wait for cleanup to settle`,
      );
    }
    const owner = runtime.activeProjectRuns(project).find((run) => {
      const reserved = rootRosterReservations.get(run.rootRunId);
      return !run.parentRunId && run.id !== ignoredRunId && (reserved?.has(target) || reserved?.has("*"));
    });
    if (owner) {
      throw new Error(
        `cannot ${rosterMutationAction(command, target)} while ${owner.agent} owns its active roster snapshot in ${owner.rootRunId}; ` +
        `use /team stop ${owner.rootRunId}, then wait for cleanup to settle`,
      );
    }
  }
}

function withProjectRosterMutationGate(project, command, args, action, ignoredRunId) {
  const targets = protectedRosterTargets(command, args);
  // Preserve exact local root guidance before the final cross-process gate.
  // The shared gate acquires synchronously before `action` can yield, so this
  // ordering does not open an admission/mutation race.
  assertRosterMutationAllowed(project, command, args, ignoredRunId);
  if (!targets.length) return action();
  const label = command === "retire"
    ? `retire ${targets.join(", ")}`
    : command === "join"
      ? `replace ${targets.join(", ")}`
      : `turn off ${targets.join(", ")}`;
  return withSharedRosterMutationGate(
    project,
    targets,
    label,
    action,
    ignoredRunId === undefined ? undefined : sharedActivityClaims.get(ignoredRunId)?.snapshot.claimToken,
  );
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

function clearProgressTracker(rootRunId) {
  const tracker = progressTrackers.get(rootRunId);
  if (tracker?.timer) clearTimeout(tracker.timer);
  progressTrackers.delete(rootRunId);
}

function clearProgressTrackers() {
  for (const rootRunId of progressTrackers.keys()) clearProgressTracker(rootRunId);
}

function progressFocus(rootRunId, preferredRunId) {
  const mission = runtime.mission(rootRunId);
  const active = mission.filter(({ state }) => state === "starting" || state === "working" || state === "waiting" || state === "cleaning");
  return active.find(({ id }) => id === preferredRunId) ?? active.at(-1);
}

function progressMessage(rootRunId, focus, note, firstRecord) {
  const modelObserved = focus.modelSource === "observed" || focus.observedModels.length > 0;
  const reasoningObserved = focus.reasoningSource === "observed" || focus.observedReasoningEfforts.length > 0;
  const model = modelObserved
    ? copilotPublicIdentifier(formatCopilotModel(focus), 160)
    : undefined;
  const reasoning = reasoningObserved
    ? copilotPublicIdentifier(formatCopilotReasoning(focus), 160)
    : undefined;
  const total = focus.usage.total;
  const totalLowerBound = focus.usageLowerBounds.includes("total") || focus.usageAttributionUnverified ||
    focus.usageIdentityTruncated || focus.usageIdentityAmbiguous;
  const nanoAiu = focus.billing.totalNanoAiu;
  const aiuLowerBound = focus.billingLowerBounds.includes("totalNanoAiu");
  const identity = focus.parentRunId ? `child ${focus.id}` : `root ${focus.id}`;
  return [
    `[Agent Harbor live · run ${rootRunId}]`,
    `${focus.parentRunId ? "↳ " : ""}${focus.agent} · ${identity} · ${focus.state} · ${formatCopilotElapsed(focus.elapsedMs)}${note ? ` · ${note}` : ""}`,
    ...(model || reasoning ? [`${model ? `Model: ${model}` : ""}${model && reasoning ? " · " : ""}${reasoning ?? ""}`] : []),
    ...(total === undefined && nanoAiu === undefined
      ? []
      : [`Usage: ${total === undefined ? "tokens —" : `${formatCopilotTokenCount(total, totalLowerBound)} native tokens`}${nanoAiu === undefined ? "" : ` · nano AIU ${formatCopilotTokenCount(nanoAiu, aiuLowerBound)}`}`]),
    firstRecord
      ? "Progress is automatic while Copilot is active. Esc interrupts/stops agents; /team returns after settlement."
      : "Live · Esc interrupt/stop · /team after settlement.",
  ].join("\n");
}

function emitProgress(rootRunId) {
  const tracker = progressTrackers.get(rootRunId);
  if (!tracker) return;
  tracker.timer = undefined;
  const focus = progressFocus(rootRunId, tracker.focusRunId);
  if (!focus) {
    clearProgressTracker(rootRunId);
    return;
  }
  if (tracker.emitted >= maximumProgressLogsPerRoot) return;
  const firstRecord = tracker.emitted === 0;
  tracker.emitted += 1;
  tracker.lastAt = Date.now();
  const note = tracker.note;
  tracker.note = undefined;
  void safeLog(progressMessage(rootRunId, focus, note, firstRecord), { level: focus.state === "cleaning" ? "warning" : "info" });
  if (tracker.emitted < maximumProgressLogsPerRoot) {
    tracker.timer = setTimeout(() => emitProgress(rootRunId), progressIntervalMs);
    tracker.timer.unref?.();
  }
}

function scheduleProgress(runId, note, immediate = false) {
  const run = runtime.get(runId);
  if (!run) return;
  const rootRunId = run.rootRunId;
  let tracker = progressTrackers.get(rootRunId);
  if (!tracker) {
    tracker = { emitted: 0, lastAt: 0, focusRunId: runId, note: undefined, timer: undefined };
    progressTrackers.set(rootRunId, tracker);
  }
  tracker.focusRunId = runId;
  if (note) tracker.note = copilotPublicIdentifier(note, 80);
  if (tracker.emitted >= maximumProgressLogsPerRoot) return;
  if (tracker.lastAt === 0 || immediate) {
    if (tracker.timer) clearTimeout(tracker.timer);
    tracker.timer = undefined;
    emitProgress(rootRunId);
    return;
  }
  if (tracker.timer) return;
  const delayMs = Math.max(0, progressIntervalMs - (Date.now() - tracker.lastAt));
  tracker.timer = setTimeout(() => emitProgress(rootRunId), delayMs);
  tracker.timer.unref?.();
}

function scheduleRootStartupProgress(runId, note) {
  const run = runtime.get(runId);
  if (!run || run.parentRunId) return;
  const existing = progressTrackers.get(run.rootRunId);
  if (existing?.rootStartupAnnounced) {
    scheduleProgress(runId);
    return;
  }
  scheduleProgress(runId, note, true);
  const tracker = progressTrackers.get(run.rootRunId);
  if (tracker) tracker.rootStartupAnnounced = true;
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
  clearProgressTracker(runId);
  rootRosterReservations.delete(runId);
  abortableRoots.delete(runId);
  nativeToolCallsByRun.delete(runId);
  nativeScoutGuardsByRun.get(runId)?.terminate("Copilot root run ended");
  nativeScoutGuardsByRun.delete(runId);
  if (activeDirect?.runId === runId) activeDirect = undefined;
  if (!releaseSharedActivity(runId)) {
    void safeLog(`[Agent Harbor activity]\nShared persistent-player claim cleanup is unverified for ${runId}; admission remains fail-closed.`, { level: "error" });
  }
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
    // Project metadata is the only host read needed before this durable gate.
    // In particular, a hazardous generation must not reach agent discovery,
    // model selection, a fresh claim, or session.send.
    assertNoSharedActivityProjectHazard(project);
    const requiredSharedSlots = id === "team-lead" ? 2 : 1;
    const expectedRosterSnapshot = id === "team-lead" || id === scoutPlayer.name
      ? invocationRosterSnapshot(project, id)
      : undefined;
    if (expectedRosterSnapshot && !expectedRosterSnapshot.formatted.complete) {
      throw new Error(`${expectedRosterSnapshot.formatted.text} No session.send/model request was attempted · 0 model tokens.`);
    }
    assertSharedCapacityHeadroom(project, requiredSharedSlots, `/${command} preflight`);
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
    let expectedDefinitionDigest;
    if (id !== scoutPlayer.name) {
      const player = requireInvocablePlayer("copilot", project, id).definition;
      expectedDefinitionDigest = playerDefinitionDigest(player);
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
    const runId = await withRosterLifecycleGate(() => {
      const validateAdmission = ({ activeClaimCount }) => {
        if (expectedDefinitionDigest !== undefined) {
          let current;
          try { current = requireInvocablePlayer("copilot", project, id).definition; }
          catch {
            throw new Error(`active managed player changed during preflight: ${id}; inspect /team and retry`);
          }
          if (playerDefinitionDigest(current) !== expectedDefinitionDigest) {
            throw new Error(`active managed player changed during preflight: ${id}; inspect /team and retry`);
          }
        } else {
          currentPersistentDefinition(project, id);
        }
        if (expectedRosterSnapshot !== undefined) {
          const currentRosterSnapshot = invocationRosterSnapshot(project, id);
          if (!currentRosterSnapshot.formatted.complete) {
            throw new Error(currentRosterSnapshot.formatted.text);
          }
          if (currentRosterSnapshot.digest !== expectedRosterSnapshot.digest) {
            throw new Error(`active roster changed during ${id} preflight; inspect /team and retry`);
          }
        }
        assertSharedCapacityCount(activeClaimCount, requiredSharedSlots, `/${command} preflight`);
      };
      const admittedRunId = beginSharedPersistentRun({
        project,
        agent: id,
        kind: memberKind(id),
        task,
        ...model,
        model: agent.model ?? model.model,
        modelSource: agent.model ? "configured" : "inherited",
      }, "direct", validateAdmission);
      if (expectedRosterSnapshot?.ids.size) {
        rootRosterReservations.set(admittedRunId, expectedRosterSnapshot.ids);
      }
      return admittedRunId;
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
    let abortPromise;
    const abort = () => {
      if (abortPromise) return abortPromise;
      abortPromise = (async () => {
        stopRequested = true;
        if (!promptAttempted) {
          settle({ outcome: "cancelled", error: new Error(`Agent Harbor player was cancelled before prompt acceptance: ${id}`) });
        }
        if (runtime.get(runId)?.state !== "cleanup-error") runtime.setState(runId, "cleaning");
        abortNativeTools(`Agent Harbor stop requested for run ${runId}`, {
          project,
          runIds: new Set([runId]),
          includeUnbound: true,
        });
        try { await boundedHostCall("Copilot abort", () => session.abort()); }
        finally {
          void safeLog(`[Agent Harbor player · ${id} · run ${runId}]\nStop requested; waiting for Copilot to settle…`, { level: "warning" });
        }
      })();
      return abortPromise;
    };
    abortableRoots.set(runId, abort);
    if (sharedActivityAuthorityFailures.has(runId)) void abort().catch(() => undefined);
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
      if (stopRequested) {
        const cancelled = { outcome: "cancelled", error: new Error(`Agent Harbor player was cancelled before prompt acceptance: ${id}`) };
        settle(cancelled);
        throw cancelled.error;
      }
      await safeLog(`[Agent Harbor player · ${id} · run ${runId}]\nPrepared: selected ${id}; no model call yet.\nProgress will be posted automatically. Esc interrupts/stops agents; /team returns after settlement.`, { level: "info" });
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
          // Publish and verify the exact durable owner generation in the same
          // synchronous step immediately before the first model call.
          publishSharedActivityPhase(runId, "working");
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
        else {
          runtime.setState(runId, "working");
          scheduleRootStartupProgress(runId, "prompt accepted");
        }
      }

      if (!result) result = await Promise.race([terminal.promise, delay(directTimeoutMs, { timeout: true })]);
      if (result?.timeout) {
        timeoutFailure = new Error(`Run ${runId} exceeded ${directTimeoutMs}ms`);
        ({ result, abortFailure } = await waitAfterAbort(timeoutFailure.message));
      }

      finalTerminal = result;
      runtime.setState(runId, "cleaning");
      const authorityFailure = sharedActivityAuthorityFailures.get(runId);
      const failures = [...new Set([timeoutFailure, abortFailure, result.error, authorityFailure].filter(Boolean))];
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
    if (runtime.get(runId)?.state !== "cleanup-error") runtime.setState(runId, "cleaning");
    abortNativeTools(`Agent Harbor stop requested for run ${runId}`, {
      project: sharedActivityClaimProjects.get(runId),
      runIds: new Set([runId]),
      includeUnbound: true,
    });
    await boundedHostCall("Copilot abort", () => session.abort());
  });
  if (sharedActivityAuthorityFailures.has(runId)) {
    void Promise.resolve(abortableRoots.get(runId)?.()).catch(() => undefined);
  }
}

function currentTeamSelectionGate(project) {
  if (recoverSharedActivityProjectHazards(project)?.size) {
    return `${projectSharedActivityHazardMessage()}; delegation is disabled`;
  }
  if (coordinator.lifecycleIdentityUnverified()) {
    return "lifecycle identity is unverified; reload Copilot before delegation";
  }
  if (selectionRestoreHazard) {
    return `selection restoration is unverified after run ${selectionRestoreHazard}; reload Copilot`;
  }
  if (unsettledSelection) {
    return `run ${unsettledSelection.runId} is still settling; wait for its terminal event`;
  }
  try {
    const claimCount = sharedPersistentClaimCount(project);
    if (claimCount >= 32) {
      return `project-shared persistent registry is full (${claimCount}/32); new roots and delegations are closed`;
    }
    const roster = invocationRosterSnapshot(project, "team-lead").formatted;
    if (!roster.complete) {
      return `model-facing roster is incomplete (${roster.total} enabled specialists or over 16 KiB); /team-lead and /scout are closed; use /bench off <id...>`;
    }
  } catch (error) {
    return `project-shared capacity/roster authority is unavailable: ${publicErrorText(errorMessage(error), 120) ?? "repair the managed activity store"}`;
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
      try { assertNoSharedActivityProjectHazard(event.project); }
      catch (error) {
        void boundedHostCall("Copilot abort hazardous native root", () => session.abort()).catch(() => undefined);
        throw error;
      }
      let runId = correlationRuns.get(event.runId);
      const directRoot = activeDirect && activeDirect.sessionId === event.sessionId && activeDirect.id === event.agent;
      if (directRoot) {
        runId = activeDirect.runId;
      } else if (!runId) {
        const beginInput = {
          project: event.project,
          agent: event.agent,
          kind: event.memberKind ?? memberKind(event.agent),
          task: event.taskLabel,
          model: event.model,
          modelSource: event.modelSource,
          reasoningEffort: event.reasoningEffort === null ? "none" : event.reasoningEffort,
        };
        try {
          runId = event.memberKind === "contractor" || event.agent === "contract"
            ? runtime.begin(beginInput)
            : beginSharedPersistentRun(beginInput, "direct", ({ activeClaimCount }) => {
              assertSharedCapacityCount(
                activeClaimCount,
                event.agent === "team-lead" ? 2 : 1,
                `${event.agent} root admission`,
              );
              currentPersistentDefinition(event.project, event.agent);
            });
        } catch (error) {
          void boundedHostCall("Copilot abort unclaimed native root", () => session.abort()).catch(() => undefined);
          throw error;
        }
      }
      if ((event.agent === "team-lead" || event.agent === scoutPlayer.name) &&
          !rootRosterReservations.has(runId)) {
        try {
          rootRosterReservations.set(runId, invocationRosterSnapshot(event.project, event.agent).ids);
        } catch {
          // Native roots already started model work. If the current roster
          // cannot be proven, destructive lifecycle controls fail closed.
          rootRosterReservations.set(runId, new Set(["*"]));
        }
      }
      if (!directRoot) {
        registerAbortableRoot(runId);
      }
      correlationRuns.set(event.runId, runId);
      scheduleRootStartupProgress(runId, "started");
      return;
    }
    if (event.type === "child.started") {
      try { assertNoSharedActivityProjectHazard(event.project); }
      catch (error) {
        void boundedHostCall("Copilot abort hazardous native child", () => session.abort()).catch(() => undefined);
        throw error;
      }
      const parentRunId = correlationRuns.get(event.parentRunId);
      if (!parentRunId) return;
      let runId = correlationRuns.get(event.runId);
      if (!runId) {
        const kind = event.memberKind ?? memberKind(event.agent);
        const beginInput = {
          project: event.project,
          agent: event.agent,
          kind,
          task: event.taskLabel,
          parentRunId,
          model: event.model,
        };
        try {
          runId = kind === "contractor"
            ? runtime.begin(beginInput)
            : beginSharedPersistentRun(beginInput, "delegated", ({ activeClaimCount }) => {
              assertSharedCapacityCount(activeClaimCount, 1, `${event.agent} delegation`);
              currentPersistentDefinition(event.project, event.agent);
            });
        } catch (error) {
          void boundedHostCall("Copilot abort unclaimed native child", () => session.abort()).catch(() => undefined);
          throw error;
        }
        correlationRuns.set(event.runId, runId);
      }
      runtime.attachChild(runId, { agentId: event.childId, model: event.model });
      const lifecycleLabel = event.basis === "observed"
        ? "started"
        : "admitted (inferred; native start not observed)";
      scheduleProgress(runId, lifecycleLabel, true);
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
      if (state) {
        runtime.setState(runId, state);
        scheduleProgress(runId);
      }
    } else if (event.type === "run.model") {
      const run = runtime.get(runId);
      if (run?.model !== event.model || event.eventId) runtime.observeRootModel(runId, event.model);
      scheduleProgress(runId);
    } else if (event.type === "run.reasoning") {
      const run = runtime.get(runId);
      const effort = event.reasoningEffort === null ? "none" : event.reasoningEffort;
      if (run?.reasoningEffort !== effort || event.eventId) {
        runtime.observeRootModel(runId, undefined, event.reasoningEffort === null ? "none" : event.reasoningEffort);
      }
      scheduleProgress(runId);
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
      scheduleProgress(runId);
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
        rootRosterReservations.delete(runId);
        abortableRoots.delete(runId);
      }
      if (!releaseSharedActivity(runId)) {
        void safeLog(`[Agent Harbor activity]\nShared persistent-player claim cleanup is unverified for ${runId}; admission remains fail-closed.`, { level: "error" });
      }
      correlationRuns.delete(event.runId);
      if (!run?.parentRunId) clearProgressTracker(run?.rootRunId ?? runId);
      else scheduleProgress(run.parentRunId, `${event.agent} ${event.outcome}`);
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
  const project = rememberProjectScope(input.project);
  if (!project) throw new Error("Agent Harbor coordinator admission could not establish a physical project identity");
  // Close every coordinator path, including native-selected roots, direct-root
  // binding, and process-local contractor branches. Until shared authority is
  // repaired this project is observable but not delegable.
  assertNoSharedActivityProjectHazard(project);
  if (input.type === "root") {
    // A slash-command/direct runner already owns the exact shared generation
    // before session.send. The coordinator's prompt hook must bind to that
    // root instead of trying to double-claim the same selected player.
    if (activeDirect && activeDirect.id === input.agent && sameProject(activeDirect.project, project)) {
      correlationRuns.set(input.runId, activeDirect.runId);
      return;
    }
    if (input.agent === "team-lead" || input.agent === scoutPlayer.name) {
      const roster = invocationRosterSnapshot(project, input.agent);
      if (!roster.formatted.complete) throw new Error(roster.formatted.text);
    }
    assertSharedCapacityHeadroom(
      project,
      input.agent === "team-lead" ? 2 : 1,
      `${input.agent} root admission`,
    );
    const beginInput = {
      project,
      agent: input.agent,
      kind: input.memberKind ?? memberKind(input.agent),
      task: input.taskLabel,
    };
    // /contract's utility wrapper and anonymous child remain process-local;
    // only named persistent players enter the durable project registry.
    const runId = input.memberKind === "contractor" || input.agent === "contract"
      ? runtime.begin(beginInput)
      : beginSharedPersistentRun(beginInput, "direct", ({ activeClaimCount }) => {
        assertSharedCapacityCount(
          activeClaimCount,
          input.agent === "team-lead" ? 2 : 1,
          `${input.agent} root admission`,
        );
        currentPersistentDefinition(project, input.agent);
      });
    correlationRuns.set(input.runId, runId);
    registerAbortableRoot(runId);
    scheduleRootStartupProgress(runId, "started");
    return;
  }
  const parentRunId = input.parentRunId && correlationRuns.get(input.parentRunId);
  if (!parentRunId) throw new Error("Agent Harbor team activity is unavailable for this coordinator run; submit the task again");
  const beginInput = {
    project,
    agent: input.agent,
    kind: input.memberKind ?? memberKind(input.agent),
    task: input.taskLabel,
    parentRunId,
  };
  const runId = input.memberKind === "contractor"
    ? runtime.begin(beginInput)
    : beginSharedPersistentRun(beginInput, "delegated", ({ activeClaimCount }) => {
      assertSharedCapacityCount(activeClaimCount, 1, `${input.agent} delegation`);
      currentPersistentDefinition(project, input.agent);
    });
  correlationRuns.set(input.runId, runId);
});

const projectAuthorityCoordinatorHooks = {
  ...coordinator.hooks,
  onUserPromptSubmitted(input, invocation) {
    const project = rememberProjectScope(input.workingDirectory);
    // The coordinator intentionally treats a steered/queued prompt as the same
    // active root and returns before admission. Gate outside it so authority
    // loss still rejects that additional prompt synchronously.
    if (project) assertNoSharedActivityProjectHazard(project);
    return coordinator.hooks.onUserPromptSubmitted(input, invocation);
  },
};

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
  if (process.platform !== "win32" && (looksLikeWindowsPath(left) || looksLikeWindowsPath(right))) {
    return equivalentAuthorizationPath(left, right);
  }
  try { return sameCanonicalProject(left, right); }
  catch { return false; }
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
    cancelledAfterCommit: false,
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
    // Once a roster transaction commits, cancellation must not turn success
    // into a reported failure. Preserve the cancellation fact for the result
    // while allowing bounded discovery reconciliation and cleanup to finish.
    if (control.committed) {
      control.cancelledAfterCommit = true;
      continue;
    }
    if (!control.controller.signal.aborted) control.controller.abort(abortReason);
  }
  if (scope.sessionId !== undefined && scope.sessionId !== session.sessionId) return;
  for (const [runId, guard] of nativeScoutGuardsByRun) {
    if (scope.runIds instanceof Set && !scope.runIds.has(runId)) continue;
    const runProject = sharedActivityClaimProjects.get(runId);
    if (scope.project !== undefined && (!runProject || !sameProject(scope.project, runProject))) continue;
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
  const busyAgents = new Set([
    ...runtime.activeProjectRuns(project)
      .filter((run) => run.kind !== "contractor")
      .map((run) => run.agent),
    ...readSharedAgentActivities(project).map(({ agent }) => agent),
  ]);
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
    let committedJoin;
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
      if (JSON.parse(call.definition).replace === true) {
        throw new Error(
          "harbor_join_player recruits a new teammate and cannot replace an existing roster member; " +
          "use the deterministic /join command manually for an intentional replacement",
        );
      }
      const { refreshReady, cancelledAfterCommit, lifecycle } = await withRosterLifecycleGate(() =>
        withProjectRosterMutationGate(context.project, "join", call.definition, async () => {
        const committed = await runDeterministicCommandResult("copilot", "join", call.definition, context.project, signal);
        const lifecycle = requireCopilotJoinLifecycleOutcome(call.definition, committed.lifecycle);
        const changed = lifecycle.status === "changed";
        // Returning from the deterministic command is the transaction boundary.
        // An abort racing after it must not turn a committed roster mutation into
        // a reported failure or skip reconciliation.
        guard.succeed(ticket);
        ticketSettled = true;
        if (changed) control.markCommitted();
        if (changed) committedJoin = { definition: call.definition, lifecycle };
        let refreshed = true;
        try {
          // A verified filesystem no-op may have been committed by another
          // process after this Copilot session loaded. Reconcile discovery on
          // every successful lifecycle outcome.
          await boundedHostCall("Copilot coordinator refresh", () => coordinator.refreshAuthoritative());
          coordinatorReady = true;
        } catch {
          coordinatorReady = false;
          refreshed = false;
        }
        updateSessionPersonalAdmission("join", call.definition, refreshed);
        return {
          refreshReady: refreshed,
          cancelledAfterCommit: changed && control.cancelledAfterCommit,
          lifecycle,
        };
        }, runId));
      const concise = conciseCopilotJoinResult(call.definition, refreshReady, lifecycle);
      const commitNotice = cancelledAfterCommit
        ? "\nRoster commit preserved: cancellation arrived after the player was joined."
        : "";
      return refreshReady
        ? `${concise}${commitNotice}`
        : lifecycle.status === "changed"
          ? `${concise}\nRoster updated, but Copilot discovery refresh failed; reload the session before invoking this player.${commitNotice}`
          : `${concise}${commitNotice}`;
    } catch (error) {
      if (control.committed && committedJoin) {
        // A host abort or reconciliation failure after the deterministic
        // transaction boundary cannot make the written roster look rolled
        // back. Preserve success and make the required recovery explicit.
        coordinatorReady = false;
        updateSessionPersonalAdmission("join", committedJoin.definition, false);
        const concise = conciseCopilotJoinResult(
          committedJoin.definition,
          false,
          committedJoin.lifecycle,
        );
        return `${concise}\nRoster updated, but Copilot discovery refresh failed; reload the session before invoking this player.\nRoster commit preserved: cancellation or reconciliation failed after the player was joined.`;
      }
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

const maximumCopilotTeamDisplayLines = 30;

function wrappedTeamBlock(value) {
  return value ? wrapPlainText(value) : "";
}

function teamBlockLineCount(value) {
  return value ? value.split(/\r?\n/u).length : 0;
}

function clipCopilotTeamDisplay(output) {
  const lines = output.split(/\r?\n/u);
  if (lines.length <= maximumCopilotTeamDisplayLines) return output;
  const prefix = lines.slice(0, maximumCopilotTeamDisplayLines - 1);
  while (prefix.length && (!prefix[prefix.length - 1].trim()
      || /^(?:LEAD ACCESS|ACTIVITY|HOST ACTIVITY|ROSTER|LAST MISSION)(?:\s*\(.*\))?$/u.test(prefix[prefix.length - 1]))) {
    prefix.pop();
  }
  const omitted = lines.length - prefix.length;
  return [
    ...prefix,
    `+${omitted} wrapped display lines omitted by the ${maximumCopilotTeamDisplayLines}-line host budget; narrow with /team <filter>.`,
  ].join("\n");
}

function sharedActivityStopOwner(snapshot) {
  const processID = Number.isSafeInteger(snapshot.processID) && snapshot.processID > 0
    ? snapshot.processID
    : "unverified";
  if (["pi", "copilot"].includes(snapshot.ownerRuntime)) {
    return `owner ${snapshot.ownerRuntime} PID ${processID}; stop there`;
  }
  return `owner runtime unverified (legacy claim) · PID ${processID}; stop in that owning Pi/Copilot process`;
}

function groupExternalStopRoutes(external) {
  const groups = new Map();
  for (const item of external) {
    const runtime = ["pi", "copilot"].includes(item.ownerRuntime) ? item.ownerRuntime : "unverified";
    const pid = Number.isSafeInteger(item.processID) && item.processID > 0 ? item.processID : "unverified";
    const heartbeat = item.heartbeatOverdue ? "overdue" : "healthy";
    const key = `${runtime}\0${pid}\0${item.phase}\0${heartbeat}`;
    const existing = groups.get(key);
    if (existing) existing.ids.push(item.id);
    else groups.set(key, { runtime, pid, phase: item.phase, heartbeat, ids: [item.id] });
  }
  return [...groups.values()].map((group) => ({
    ...group,
    ids: group.ids.sort((left, right) => left.localeCompare(right)),
  })).sort((left, right) => `${left.runtime}:${left.pid}:${left.phase}:${left.heartbeat}`
    .localeCompare(`${right.runtime}:${right.pid}:${right.phase}:${right.heartbeat}`));
}

function formatCopilotStopOutput({
  localRequestCount,
  stopping,
  failed,
  external,
  activityAuthorityUnavailable,
}) {
  // A failed command is also surfaced once by the host as an Error. An
  // accepted abort request can concurrently publish one two-line terminal
  // lifecycle notice. Reserve both from the global 30-line interaction budget.
  const maximumLines = maximumCopilotTeamDisplayLines -
    (failed.length ? 1 : 0) - (stopping.length ? 2 : 0);
  const externalGroups = groupExternalStopRoutes(external);
  const build = (shownFailures, shownGroups) => {
    const omittedFailures = failed.length - shownFailures.length;
    const omittedGroups = externalGroups.length - shownGroups.length;
    const shownStopping = stopping.slice(0, 4);
    const stoppingDetail = shownStopping.length
      ? `${shownStopping.join(", ")}${stopping.length > shownStopping.length
        ? ` (+${stopping.length - shownStopping.length} local IDs omitted)`
        : ""}`
      : "none";
    const stoppingLabel = stopping.length === 1 ? "awaiting terminal ID" : "awaiting terminal IDs";
    const lines = [
      "Agent Harbor Copilot stop · 0 model tokens",
      `LOCAL STOP REQUEST · ${stopping.length}/${localRequestCount} abort request accepted · ${failed.length} failed · ${stoppingLabel} ${stoppingDetail}`,
      ...(failed.length
        ? [
            `LOCAL STOP FAILURES · ${shownFailures.length} shown · ${omittedFailures} omitted`,
            ...shownFailures.map(({ id, state }) =>
              `• ${id} · state ${state} · Copilot did not accept this local abort request`),
            "Inspect local failures: /team status:cleaning or /team run:<id>; wait for a terminal event.",
          ]
        : []),
      ...(activityAuthorityUnavailable
        ? [
            "REMOTE OWNER ROUTES · unverified; shared activity authority is unavailable",
            "• shared-* · state unverified · external persistent-player activity authority is unavailable",
            "Repair the managed activity store, then use /team status:working to verify external work.",
          ]
        : external.length
          ? [
              `REMOTE OWNER GROUPS · ${external.length} active runs · ${externalGroups.length} groups · ${shownGroups.length} shown · ${omittedGroups} omitted · no remote abort attempted`,
              ...shownGroups.flatMap((group) => {
                const route = group.pid === "unverified"
                  ? `/team owner:${group.runtime} page:1`
                  : `/team pid:${group.pid} page:1`;
                const sample = group.ids.slice(0, 2).join(", ");
                return [
                  `• owner ${group.runtime} PID ${group.pid} · phase ${group.phase} · heartbeat ${group.heartbeat} · ${group.ids.length} run${group.ids.length === 1 ? "" : "s"}`,
                  `  IDs ${sample}${group.ids.length > 2 ? ` (+${group.ids.length - 2})` : ""} · full index ${route}`,
                ];
              }),
              ...(omittedGroups
                ? ["Omitted owner groups remain indexed without IDs at /team page:1."]
                : []),
              "In each listed runtime/PID, inspect its index and use /team stop <local-run-id|all>.",
            ]
          : []),
    ];
    return wrapPlainText(lines.join("\n")).split(/\r?\n/u);
  };

  let shownFailures = [];
  for (const failure of failed.slice(0, 4)) {
    const candidate = [...shownFailures, failure];
    if (build(candidate, []).length > maximumLines) break;
    shownFailures = candidate;
  }

  let shownGroups = [];
  for (const owner of externalGroups) {
    const candidate = [...shownGroups, owner];
    if (build(shownFailures, candidate).length > maximumLines) break;
    shownGroups = candidate;
  }

  const output = build(shownFailures, shownGroups);
  if (output.length > maximumLines) {
    throw new Error("Agent Harbor stop summary exceeded its bounded host output contract");
  }
  return output.join("\n");
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
      "/team — Show roster/current work after the active turn, or the last mission when idle.",
      "/team [<filter>] [page:N] — Deterministic pages enumerate active, retained history, and roster IDs.",
      "/bench list [<filter>] [page:N] — Roster-first pages; /bench on|off <id...> changes availability.",
      "/team <filter> — Match free text, or use a field prefix:",
      "  member:/id: · kind:/role: · description:",
      "  tool: · capability: · skill: · status:/state: · model: · reasoning: · task: · run:",
      "  owner: and pid: are exact owner routes; run: is an exact retained run ID.",
      "  heartbeat:overdue|healthy; telemetry:unobserved matches local telemetry only.",
      "/team stop <run-id|all> — Idle/RPC control for one mission or all controlled missions.",
      "A resolved local abort only means request accepted; wait for terminal settlement in /team.",
      "During a live TUI turn, Copilot 1.0.73 pauses SDK commands: progress posts automatically; press Esc to interrupt/stop agents, then use /team after settlement.",
      "Choose one teammate: /<id> <task> or /player <id> <task>.",
      "Team controls: /scout <need> · /contract <json> · /join <json> · /retire <id>.",
      "Catalog: /list-skills [--descriptions|-d] [filter] [--page N].",
      "Personal model: /join JSON with model:\"provider/model\"; add replace:true to change it.",
      "Limits: this Copilot process admits 32 local roots; the project-shared registry admits 32 active persistent players (roots plus children).",
      "An inactive team-lead needs 2 shared slots (root + first child); active lead/other roots need 1 next slot; team-lead allows 6 sequential delegations.",
      "Persistent-player activity/admission is project-wide across Pi and Copilot processes; tasks and cross-process telemetry are not disclosed.",
      "Anonymous /contract work is process-local; shared-* runs must be stopped in their owning process.",
      "Tokens, AI credits, and max-output are observed only when Copilot SDK reports them.",
      "Agent Harbor does not simulate a hard per-run token cap; its own gates are concurrency and six delegations.",
    ];
    const boundedHelp = clipCopilotTeamDisplay(wrapPlainText(output.join("\n")));
    await boundedTeamCall(
      "Copilot team help display",
      () => displayLog(boundedHelp, { level: "info" }),
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
      "ACTIVITY · persistent players project-wide · disposable contractors process-local",
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
    let external = [];
    let activityAuthorityUnavailable = false;
    try {
      const localPersistent = new Set(active.filter(({ kind }) => kind !== "contractor").map(({ agent }) => agent));
      external = readSharedAgentActivities(project)
        .filter(({ agent }) => !localPersistent.has(agent))
        .map((snapshot) => ({
          id: `shared-${snapshot.agent}`,
          owner: sharedActivityStopOwner(snapshot),
          ownerRuntime: snapshot.ownerRuntime,
          processID: snapshot.processID,
          phase: snapshot.phase,
          heartbeatOverdue: snapshot.heartbeatOverdue === true,
        }))
        .filter(({ id }) => target === "all" || target === id)
        .sort((left, right) => left.id.localeCompare(right.id));
    } catch {
      activityAuthorityUnavailable = true;
    }
    const matching = target === "all" ? active : active.filter((run) => run.id === target || run.rootRunId === target);
    const roots = [...new Set(matching.map(({ rootRunId }) => rootRunId))]
      .flatMap((rootRunId) => active.find((run) => run.id === rootRunId) ?? []);
    if (!roots.length) {
      if (activityAuthorityUnavailable && target.startsWith("shared-")) {
        throw new Error("Persistent-player activity authority is unavailable; /team stop fails closed for work owned by another process");
      }
      if (external.length && target !== "all") {
        throw new Error(`stop authority is external: ${external.map(({ id, owner, phase, heartbeatOverdue }) =>
          `${id} — phase ${phase} · heartbeat ${heartbeatOverdue ? "overdue" : "healthy"} · ${owner}`).join("; ")}`);
      }
      if (target === "all" && !external.length && !activityAuthorityUnavailable) {
        await boundedTeamCall(
          "Copilot team stop display",
          () => displayLog("Agent Harbor Copilot stop · 0 model tokens\nNo shared persistent-player work is active; contractors are process-local.", { level: "info" }),
          deadline,
          logRpcTimeoutMs,
        );
        return;
      }
      if (target !== "all") {
        throw new Error(`unknown active Agent Harbor run: ${target}; run /team to inspect current IDs`);
      }
    }
    if (roots.length) {
      abortNativeTools(`Agent Harbor /team stop requested for ${target}`, {
        project,
        runIds: new Set(roots.map(({ id }) => id)),
        includeUnbound: target === "all" || roots.length === 1,
      });
    }
    const stopResults = roots.length
      ? await Promise.allSettled(roots.map(async (run) => {
          const abort = abortableRoots.get(run.id);
          if (!abort) throw new Error(`Agent Harbor run is no longer controlled: ${run.id}`);
          await boundedTeamCall(`Copilot stop ${run.id}`, abort, deadline, teamBudgetMs);
        }))
      : [];
    const stopping = [];
    const failed = [];
    for (let index = 0; index < stopResults.length; index += 1) {
      const run = roots[index];
      const outcome = stopResults[index];
      if (outcome.status === "fulfilled") stopping.push(run.id);
      else failed.push({
        id: run.id,
        state: runtime.get(run.id)?.state ?? run.state,
      });
    }
    const output = formatCopilotStopOutput({
      localRequestCount: roots.length,
      stopping,
      failed,
      external,
      activityAuthorityUnavailable,
    });
    await boundedTeamCall(
      "Copilot team stop display",
      () => displayLog(output, {
        level: failed.length || external.length || activityAuthorityUnavailable ? "warning" : "info",
      }),
      deadline,
      logRpcTimeoutMs,
    );
    if (failed.length) {
      const failure = failed.length === 1
        ? failed[0].id
        : `${failed.length} of ${roots.length} local stop requests`;
      throw new CopilotTeamStopOutcomeError(
        `Abort request not accepted for ${failure}; inspect /team status:cleaning.`,
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
    currentTeamSelectionGate(project),
    ...(untrackedHostActivity
      ? ["Copilot host work is active outside Agent Harbor tracking; wait or use Copilot's native stop control"]
      : []),
  ].filter(Boolean);
  const selectionGate = selectionGates.join("; ") || undefined;
  if (selectionRestoreHazard) degraded.push("player selection restoration unverified");
  const sdkContextBlock = wrappedTeamBlock(teamSdkContextLines(context, snapshot).join("\n"));
  const hostBlock = untrackedHostActivity ? wrappedTeamBlock([
    "HOST ACTIVITY (Copilot SDK; outside Agent Harbor tracking)",
    `● Copilot host · active · ${[
      ...(hostActivity.hasActiveWork ? ["metadata.activity.hasActiveWork"] : []),
      ...(hostActivity.processing ? ["metadata.isProcessing"] : []),
    ].join(" + ")}`,
    `  Cancellation: ${hostActivity.abortable ? "available through Copilot's native stop control" : "not reported as abortable by Copilot"}.`,
    "  No Agent Harbor run ID exists for this work; delegation remains closed.",
  ].join("\n")) : "";
  const initialReasons = [...new Set(degraded)];
  const possibleDegradedBlock = initialReasons.length
    ? wrappedTeamBlock(`Degraded bounded snapshot (${teamBudgetMs}ms budget): ${initialReasons.join("; ")}.`)
    : "";
  const adjunctLineBudget = [possibleDegradedBlock, sdkContextBlock, hostBlock]
    .filter(Boolean)
    .reduce((total, block) => total + 1 + teamBlockLineCount(block), 0);
  const viewLineBudget = Math.max(1, maximumCopilotTeamDisplayLines - adjunctLineBudget);
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
        totalLineBudget: viewLineBudget,
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
      totalLineBudget: viewLineBudget,
    });
  }
  const reasons = [...new Set(degraded)];
  if (reasons.length && !usedFallback) {
    output += `\n\n${wrappedTeamBlock(`Degraded bounded snapshot (${teamBudgetMs}ms budget): ${reasons.join("; ")}.`)}`;
  }
  if (sdkContextBlock) output += `\n\n${sdkContextBlock}`;
  if (untrackedHostActivity) {
    output = output.replace(
      /No shared persistent-player work is active; contractors are\s+process-local\./u,
      "No Agent Harbor mission is tracked; Copilot reports other active host work below.",
    );
    output = output.includes("\n\nROSTER")
      ? output.replace("\n\nROSTER", `\n\n${hostBlock}\n\nROSTER`)
      : `${output}\n\n${hostBlock}`;
  }
  output = clipCopilotTeamDisplay(output);
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
  hooks: projectAuthorityCoordinatorHooks,
  commands: [
    {
      name: "team",
      description: "0 model tokens · /team [help|filter|stop <run-id|all>] · Inspect roster/history after active turns; live progress posts automatically.",
      handler: async ({ args }) => {
        try { await showTeam(args); }
        catch (error) {
          if (!(error instanceof CopilotTeamStopOutcomeError)) {
            void safeLog(`[Agent Harbor team · 0 model tokens]\n${errorMessage(error)}`, { level: "error" });
          }
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
          const execute = async () => {
            const result = await runDeterministicCommandResult("copilot", name, raw, project, undefined, name === "list-skills" ? "copilot" : "plain");
            const lifecycle = name === "join"
              ? requireCopilotJoinLifecycleOutcome(raw, result.lifecycle)
              : name === "bench"
                ? requireCopilotBenchLifecycleOutcome(raw, result.lifecycle)
                : name === "retire"
                  ? requireCopilotRetireLifecycleOutcome(raw, result.lifecycle)
                : undefined;
            const committed = lifecycle?.status === "changed";
            let refreshWarning = "";
            if (lifecycle) {
              try {
                // Reconcile host discovery even after a verified filesystem
                // no-op committed by another process after startup.
                await boundedHostCall("Copilot coordinator refresh", () => coordinator.refreshAuthoritative());
                coordinatorReady = true;
              }
              catch {
                coordinatorReady = false;
                refreshWarning = committed
                  ? "\nRoster updated, but Copilot discovery refresh failed; reload the session before invoking the changed player."
                  : "\nRoster files were already current, but Copilot discovery refresh failed; reload the session before invocation.";
              }
            }
            if (lifecycle) updateSessionPersonalAdmission(name, raw, !refreshWarning);
            return { result, lifecycle, committed, refreshWarning };
          };
          const { result, lifecycle, committed, refreshWarning } = name === "list-skills"
            ? await execute()
            : await withRosterLifecycleGate(() => withProjectRosterMutationGate(project, name, raw, execute));
          const heading = name === "list-skills" ? "Agent Harbor · skill catalog · 0 model tokens" : `Agent Harbor /${name} · 0 model tokens`;
          const pendingSkillReload = lifecycle?.command === "bench" && /^on\b/u.test(value)
            ? playersPendingNativeSkillReload(project)
            : [];
          const lifecycleNotice = name === "retire" && lifecycle?.status === "changed"
            ? "\nThe retired player is blocked immediately through /player; a startup alias may remain visible in slash-command completion/autocomplete until /reload."
            : pendingSkillReload.length
              ? `\nNative skill loader pending for ${pendingSkillReload.join(", ")}; /player stops before model use until /reload registers it.`
              : lifecycle?.command === "bench" && /^off\b/u.test(value)
                ? "\nBenched players are blocked immediately through /player; /reload removes any stale startup aliases from slash-command completion/autocomplete."
                : "";
          const commandResult = name === "retire" && lifecycle?.status === "already-current"
            ? `○ ${copilotPublicIdentifier(value, 80) ?? "player"} was already retired here · no roster files changed.\nOther project copies, if any, remain intentionally untouched.\nA stale startup alias remains blocked; /reload removes it from slash-command completion/autocomplete.`
            : name === "join" ? conciseCopilotJoinResult(raw, !refreshWarning, lifecycle)
              : name === "bench" ? conciseCopilotBenchResult(lifecycle)
                : result.text;
          const publicResult = `${commandResult}${lifecycleNotice}`;
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
          const visible = publicFacingError(error, id);
          await safeLog(`[Agent Harbor player · ${id}${budget}]\n${visible.message}`, { level: "error" });
          throw visible;
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
    clearProgressTrackers();
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
