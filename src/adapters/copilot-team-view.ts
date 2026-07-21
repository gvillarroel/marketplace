/** Deterministic Copilot team inventory and process-local activity views. */
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { loadManagedActivePlayer } from "../core/active.js";
import { bundledPlayers, rolePlayers, scoutPlayer } from "../core/defaults.js";
import { isOwnedProfile, validatePlayer } from "../core/lifecycle.js";
import { decodePlayer, harnessSpec, isCanonicalPlayerProfile } from "../core/profiles.js";
import { wrapPlainLines } from "../core/text-layout.js";
import type { PlayerDefinition } from "../core/types.js";
import { runDeterministicCommand } from "./direct.js";
import { defaultHome } from "./shared.js";
import {
  listCopilotActiveProfileIds,
  resolveCopilotPlayer,
  type CopilotAgentIdentity,
} from "./copilot-coordinator.js";
import {
  copilotPublicIdentifier,
  CopilotTeamRuntime,
  formatCopilotElapsed,
  formatCopilotMissionDetails,
  formatCopilotModel,
  formatCopilotNativeTelemetry,
  formatCopilotReasoning,
  formatCopilotRunDetails,
  formatCopilotTokenCount,
  formatCopilotUsage,
  type CopilotTeamMemberKind,
  type CopilotTeamRunSnapshot,
} from "./copilot-team-runtime.js";

export interface CopilotTeamMember {
  readonly id: string;
  readonly kind: Exclude<CopilotTeamMemberKind, "contractor">;
  readonly availability: "ready" | "bench" | "stale" | "conflict" | "unavailable";
  readonly description: string;
  readonly capacity: string;
  readonly configuredModel?: string;
  readonly repairKind?: "bundled-profile" | "personal-active" | "personal-registration" | "native-discovery";
}

export interface CopilotNativeRosterStatus {
  readonly agents: readonly CopilotAgentIdentity[];
  readonly discoveryAvailable: boolean;
  readonly coordinatorReady: boolean;
  readonly selectionRestoreUnverified?: boolean;
}

export const maximumVisibleCopilotRosterMembers = 32;
const personalProfileReadConcurrency = 8;

interface BenchRow {
  readonly id: string;
  readonly roster: "bundled" | "personal";
  readonly state: "on" | "bench" | "stale" | "conflict";
}

function parseBenchRows(output: string): BenchRow[] {
  const lines = output.split(/\r?\n/gu).map((line) => line.trim()).filter(Boolean);
  const rows = lines.flatMap((line) => {
    const match = /^([a-z0-9-]+) \| (bundled|personal) \| (on|bench|stale|conflict)$/u.exec(line);
    return match ? [{ id: match[1], roster: match[2], state: match[3] } as BenchRow] : [];
  });
  if (rows.length !== lines.length) {
    throw new Error("Agent Harbor bench inventory returned an unrecognized row; update or reload the extension");
  }
  const bundled = new Set(rows.filter(({ roster }) => roster === "bundled").map(({ id }) => id));
  const missing = [...bundledPlayers.keys()].filter((id) => !bundled.has(id));
  if (missing.length) throw new Error(`Agent Harbor bench inventory is incomplete; missing bundled members: ${missing.join(", ")}`);
  return rows;
}

function memberCapacity(definition: PlayerDefinition, id = definition.name): string {
  const capabilities = definition.tools.length
    ? [...definition.tools]
    : [id === "team-lead" ? "coordination" : "advisory"];
  for (const skill of definition.skills ?? []) capabilities.push(`skill:${skill.name}`);
  return capabilities.join(", ");
}

async function registeredPersonalDefinition(project: string, id: string): Promise<PlayerDefinition | undefined> {
  try {
    const root = resolve(project);
    const spec = harnessSpec("copilot", defaultHome("copilot"), root);
    const path = join(spec.home, spec.registrationDir, `${id}${spec.extension}`);
    const content = await readFile(path, "utf8");
    if (!isOwnedProfile(content, id, "personal")) return undefined;
    const definition = validatePlayer(decodePlayer(content, id));
    return isCanonicalPlayerProfile(content, "copilot", definition, "personal", root) ? definition : undefined;
  } catch {
    return undefined;
  }
}

async function personalDefinition(project: string, row: BenchRow): Promise<PlayerDefinition | undefined> {
  if (row.state === "on") {
    try { return loadManagedActivePlayer("copilot", project, row.id); }
    catch { /* Fall through to registration metadata. */ }
  }
  return registeredPersonalDefinition(project, row.id);
}

function verifyNativeAvailability(
  member: CopilotTeamMember,
  project: string,
  native: CopilotNativeRosterStatus | undefined,
  activeProfileIds: readonly string[],
): CopilotTeamMember {
  if (!native || member.availability !== "ready") return member;
  if (!native.discoveryAvailable || !native.coordinatorReady) {
    return { ...member, availability: "unavailable", repairKind: "native-discovery" };
  }
  try {
    const identity = resolveCopilotPlayer(member.id, native.agents, project, activeProfileIds);
    if (identity.userInvocable === false) throw new Error("not user invocable");
    return { ...member, configuredModel: identity.model ?? member.configuredModel };
  } catch {
    return { ...member, availability: "unavailable", repairKind: "native-discovery" };
  }
}

/** Resolves the complete Copilot-visible roster without creating a model request. */
export async function collectCopilotTeamMembers(
  project: string,
  native?: CopilotNativeRosterStatus,
): Promise<CopilotTeamMember[]> {
  const rows = parseBenchRows(await runDeterministicCommand("copilot", "bench", "list", project));
  const members: CopilotTeamMember[] = [];
  for (const [id, definition] of rolePlayers) {
    members.push({
      id,
      kind: id === "team-lead" ? "manager" : "fixed",
      availability: "ready",
      description: definition.description,
      capacity: memberCapacity(definition, id),
      ...(definition.model ? { configuredModel: definition.model } : {}),
    });
  }
  members.push({
    id: scoutPlayer.name,
    kind: "utility",
    availability: "ready",
    description: scoutPlayer.description,
    capacity: "skill discovery, recruitment",
    ...(scoutPlayer.model ? { configuredModel: scoutPlayer.model } : {}),
  });
  for (const row of rows.filter(({ roster }) => roster === "bundled")) {
    const definition = bundledPlayers.get(row.id);
    if (!definition) continue;
    members.push({
      id: row.id,
      kind: "bundled",
      availability: row.state === "on" ? "ready" : row.state,
      description: definition.description,
      capacity: memberCapacity(definition),
      ...(definition.model ? { configuredModel: definition.model } : {}),
      ...(row.state === "stale" ? { repairKind: "bundled-profile" as const } : {}),
    });
  }
  const personalRows = rows
    .filter(({ roster }) => roster === "personal")
    .sort((left, right) => left.id.localeCompare(right.id));
  for (let index = 0; index < personalRows.length; index += personalProfileReadConcurrency) {
    const batch = await Promise.all(personalRows.slice(index, index + personalProfileReadConcurrency).map(async (row) => {
      const definition = await personalDefinition(project, row);
      return {
        id: row.id,
        kind: "personal" as const,
        availability: row.state === "on" ? "ready" as const : row.state,
        description: definition?.description
          ?? (row.state === "conflict" ? "Unmanaged collision; metadata unavailable" : "Managed profile needs repair"),
        capacity: definition ? memberCapacity(definition) : "unavailable until repaired",
        ...(definition?.model ? { configuredModel: definition.model } : {}),
        ...(row.state === "stale" ? {
          repairKind: definition ? "personal-active" as const : "personal-registration" as const,
        } : {}),
      } satisfies CopilotTeamMember;
    }));
    members.push(...batch);
  }
  const activeProfileIds = native ? listCopilotActiveProfileIds(project) : [];
  return members.map((member) => verifyNativeAvailability(member, project, native, activeProfileIds));
}

function memberMatches(member: CopilotTeamMember, filter: string): boolean {
  return !filter || [member.id, member.kind, member.availability, member.description, member.capacity, member.configuredModel ?? ""]
    .some((value) => value.toLowerCase().includes(filter));
}

function activityMatches(run: CopilotTeamRunSnapshot, filter: string): boolean {
  return !filter || [run.id, run.agent, run.kind, run.state, run.task, formatCopilotReasoning(run), formatCopilotModel(run)]
    .some((value) => value.toLowerCase().includes(filter));
}

function availabilitySymbol(state: CopilotTeamMember["availability"]): string {
  if (state === "ready") return "●";
  if (state === "bench") return "○";
  return "!";
}

function renderActivity(runs: readonly CopilotTeamRunSnapshot[], hasOtherActiveWork: boolean): string[] {
  if (!runs.length) return [hasOtherActiveWork ? "No active work matches this filter." : "No one is working right now."];
  return runs.flatMap((run) => [
    `${run.parentRunId ? "↳" : "●"} ${run.agent} · run ${run.id}${run.parentRunId ? ` · parent ${run.parentRunId}` : ""} · ${run.kind} · ${run.state} · ${formatCopilotElapsed(run.elapsedMs)}`,
    `  Task: “${run.task}”`,
    `  ${formatCopilotModel(run)} · ${formatCopilotReasoning(run)} · ${formatCopilotNativeTelemetry(run, false)}`,
  ]);
}

function renderRoster(
  members: readonly CopilotTeamMember[],
  activeMemberStates: ReadonlyMap<string, CopilotTeamRunSnapshot["state"]>,
  suppressNativeDiscoveryRepair = false,
): string[] {
  return members.flatMap((member) => {
    const activity = activeMemberStates.get(member.id) ?? member.availability;
    const repair = member.repairKind === "bundled-profile" || member.repairKind === "personal-active"
      ? [`  Repair: /bench on ${member.id}; then reload the Copilot session.`]
      : member.repairKind === "personal-registration"
        ? [`  Repair: re-run /join with the full definition and "replace":true; then reload.`]
        : member.availability === "conflict"
          ? ["  Repair: inspect the unmanaged collision; Agent Harbor will not overwrite it."]
          : member.repairKind === "native-discovery" && !suppressNativeDiscoveryRepair
            ? ["  Repair: reload the Copilot session and run /team again before delegation."]
          : [];
    const description = copilotPublicIdentifier(member.description, 500) ?? "Description unavailable";
    const capacity = copilotPublicIdentifier(member.capacity, 500) ?? "unavailable";
    const model = copilotPublicIdentifier(member.configuredModel, 200);
    return [
      `${availabilitySymbol(member.availability)} ${member.id}${member.id === scoutPlayer.name ? " (/scout)" : ""} · ${member.kind} · ${activity}`,
      `  ${description}`,
      `  Capacity: ${capacity} · model: ${model ? `configured ${model}` : "inherits the Copilot host when run"}`,
      ...repair,
    ];
  });
}

function compactMemberIds(members: readonly CopilotTeamMember[], limit = 12): string {
  if (!members.length) return "none";
  const shown = members.slice(0, limit).map(({ id }) => id).join(", ");
  return members.length > limit ? `${shown} (+${members.length - limit} more)` : shown;
}

function renderLeadAccess(
  members: readonly CopilotTeamMember[],
  working: ReadonlySet<string>,
  selectionGate?: string,
): string[] {
  const specialists = members.filter((member) =>
    member.id !== "team-lead" && member.kind !== "manager" && member.kind !== "utility" && member.availability === "ready");
  const busy = specialists.filter((member) => working.has(member.id));
  const eligibleNow = selectionGate ? [] : specialists.filter((member) => !working.has(member.id));
  const bundled = members.filter((member) => member.kind === "bundled");
  const benched = bundled.filter((member) => member.availability === "bench");
  const unhealthy = members.filter((member) => member.availability !== "ready" && member.availability !== "bench");
  return [
    `Enabled specialists: ${specialists.length} · mission budget: up to 6 sequential delegations`,
    `Eligible specialists: ${compactMemberIds(specialists)}`,
    `Can delegate now: ${compactMemberIds(eligibleNow)}${selectionGate ? ` · ${selectionGate}` : ""}`,
    ...(busy.length ? [`Busy (double-booking blocked): ${compactMemberIds(busy)}`] : []),
    `SDLC coverage: ${bundled.filter((member) => member.availability === "ready").length}/${bundled.length} enabled · ${benched.length} benched`,
    ...(benched.length ? [`Enable SDLC: /bench on ${benched.map(({ id }) => id).join(" ")}`] : []),
    ...(unhealthy.length ? [`Repair before delegation: ${compactMemberIds(unhealthy)}`] : []),
  ];
}

export interface CopilotTeamViewOptions {
  readonly filter?: string;
  readonly title?: "team" | "bench";
  readonly nextModel?: string;
  readonly nextReasoning?: string;
  readonly nextMaxOutputTokens?: number;
  readonly native?: CopilotNativeRosterStatus;
  readonly selectionGate?: string;
}

/** Minimal process-local fallback used when authoritative roster rendering misses its shared deadline. */
export function formatCopilotDegradedTeamView(
  project: string,
  runtime: CopilotTeamRuntime,
  options: {
    title?: "team" | "bench";
    filter?: string;
    reasons?: readonly string[];
    budgetMs?: number;
    selectionGate?: string;
  } = {},
): string {
  const needle = options.filter?.trim().toLowerCase() ?? "";
  const unorderedActive = runtime.activeProjectRuns(project);
  const rootOrder = new Map<string, number>();
  for (const run of unorderedActive) {
    const current = rootOrder.get(run.rootRunId);
    if (current === undefined || run.sequence < current) rootOrder.set(run.rootRunId, run.sequence);
  }
  const active = unorderedActive.sort((left, right) =>
    rootOrder.get(left.rootRunId)! - rootOrder.get(right.rootRunId)! || left.sequence - right.sequence);
  const matchingActive = active.filter((run) => !needle || activityMatches(run, needle));
  const runs = matchingActive.slice(0, maximumVisibleCopilotRosterMembers);
  const omittedActive = Math.max(0, matchingActive.length - runs.length);
  const latestCandidate = active.length ? undefined : runtime.latestRoot(project);
  const latest = latestCandidate && (!needle || runtime.mission(latestCandidate.rootRunId)
    .some((run) => activityMatches(run, needle))) ? latestCandidate : undefined;
  const projectName = copilotPublicIdentifier(runtime.projectName(project), 80) ?? "project";
  const snapshotLabel = options.budgetMs === undefined
    ? "Bounded snapshot"
    : `Degraded bounded snapshot (${options.budgetMs}ms budget)`;
  const lines = [
    `Agent Harbor Copilot ${options.title ?? "team"} · ${projectName} · 0 model tokens · degraded`,
    `${snapshotLabel}: ${[...new Set(options.reasons ?? [])].join("; ") || "authoritative roster rendering unavailable"}.`,
    ...(options.selectionGate
      ? [`Selection gate: ${copilotPublicIdentifier(options.selectionGate, 240) ?? "selection is temporarily locked"}.`]
      : []),
    "",
    "ACTIVITY (process-local)",
    ...(runs.length ? runs.flatMap((run) => [
      `${run.parentRunId ? "↳" : "●"} ${run.agent} · run ${run.id}${run.parentRunId ? ` · parent ${run.parentRunId}` : ""} · ${run.kind} · ${run.state} · ${formatCopilotElapsed(run.elapsedMs)}`,
      `  Task: “${run.task}”`,
      `  ${formatCopilotModel(run)} · ${formatCopilotReasoning(run)} · ${formatCopilotNativeTelemetry(run)}`,
      ...(run.parentRunId && (run.durationMs !== undefined || run.totalToolCalls !== undefined)
        ? [`  Native child: duration ${run.durationMs === undefined ? "—" : `${formatCopilotElapsed(run.durationMs)}.${String(Math.floor(run.durationMs % 1_000)).padStart(3, "0")}`} · tool calls ${run.totalToolCalls ?? "—"}`]
        : []),
    ]) : ["No tracked Agent Harbor work matches this bounded snapshot."]),
    ...(omittedActive
      ? [`+${omittedActive} matching active runs omitted by this bounded snapshot; filter or retry /team.`]
      : []),
    ...(latest ? ["", "LAST MISSION", ...formatCopilotMissionDetails(runtime, latest.rootRunId)] : []),
    "",
    "Retry /team for the authoritative roster after Copilot host RPC recovers.",
  ];
  return wrapPlainLines(lines).join("\n");
}

/** Formats roster, active hierarchy, and last mission without inference or durable activity storage. */
export async function formatCopilotTeamView(
  project: string,
  runtime: CopilotTeamRuntime,
  options: CopilotTeamViewOptions = {},
): Promise<string> {
  const filter = options.filter?.trim().toLowerCase() ?? "";
  const allMembers = await collectCopilotTeamMembers(project, options.native);
  const unorderedActive = runtime.activeProjectRuns(project);
  const rootOrder = new Map<string, number>();
  for (const run of unorderedActive) {
    const current = rootOrder.get(run.rootRunId);
    if (current === undefined || run.sequence < current) rootOrder.set(run.rootRunId, run.sequence);
  }
  const allActive = unorderedActive.sort((left, right) =>
    rootOrder.get(left.rootRunId)! - rootOrder.get(right.rootRunId)! || left.sequence - right.sequence);
  const members = allMembers.filter((member) => memberMatches(member, filter));
  const activity = allActive.filter((run) => activityMatches(run, filter));
  const latest = runtime.latestRoot(project);
  const latestMission = !allActive.length && latest ? runtime.mission(latest.rootRunId) : [];
  const historicalMatches = latestMission.filter((run) => activityMatches(run, filter));
  const activeMemberStates = new Map(allActive
    .filter((run) => run.kind !== "contractor")
    .map((run) => [run.agent, run.state] as const));
  const working = new Set(activeMemberStates.keys());
  const activeChild = allActive.find((run) => run.parentRunId !== undefined);
  const activeNonManagerRoot = allActive.find((run) => run.parentRunId === undefined && run.kind !== "manager");
  const cleaningManagerRoot = allActive.find((run) =>
    run.parentRunId === undefined && run.kind === "manager" && run.state === "cleaning");
  const selectionGate = copilotPublicIdentifier(options.selectionGate, 240)
    ?? (activeChild ? `child run ${activeChild.id} is active; wait for its terminal event`
      : activeNonManagerRoot ? `${activeNonManagerRoot.kind} root ${activeNonManagerRoot.id} owns the session`
        : cleaningManagerRoot ? `manager run ${cleaningManagerRoot.id} is cleaning; wait for its terminal event`
          : undefined);
  const globalNativeDiscoveryFailure = Boolean(options.native &&
    (!options.native.discoveryAvailable || !options.native.coordinatorReady));
  const globalWarnings = (options.native?.selectionRestoreUnverified)
    ? ["Player selection restoration is unverified; no teammate can be selected. Reload the Copilot session."]
    : globalNativeDiscoveryFailure
      ? ["Native agent discovery/coordinator is not ready; no teammate can be selected. Reload the Copilot session."]
      : [];
  if (!members.length && !activity.length && !historicalMatches.length) {
    const shown = copilotPublicIdentifier(options.filter?.trim(), 80) || "the requested filter";
    const projectName = copilotPublicIdentifier(runtime.projectName(project), 80) ?? "project";
    return wrapPlainLines([
      `Agent Harbor Copilot ${(options.title ?? "team")} · ${projectName} · 0 model tokens`,
      `No team member or tracked activity matches “${shown}”.`,
      ...globalWarnings,
      ...(selectionGate ? [`Selection gate: ${selectionGate}.`] : []),
      "Try /team, /bench list, or search by member ID, description, role/kind, capability, tool, skill,",
      "model/reasoning, status/state, task label, or run ID.",
    ]).join("\n");
  }

  const ready = allMembers.filter((member) => member.availability === "ready" && !working.has(member.id)).length;
  const benched = allMembers.filter((member) => member.availability === "bench").length;
  const unhealthy = allMembers.filter((member) => member.availability !== "ready" && member.availability !== "bench").length;
  const activeCounts = new Map<CopilotTeamRunSnapshot["state"], number>();
  for (const run of allActive) activeCounts.set(run.state, (activeCounts.get(run.state) ?? 0) + 1);
  const activeBreakdown = (["working", "starting", "waiting", "cleaning"] as const)
    .flatMap((state) => activeCounts.has(state) ? [`${activeCounts.get(state)} ${state}`] : [])
    .join(" · ");
  const nextModel = copilotPublicIdentifier(options.nextModel, 200);
  const nextReasoning = copilotPublicIdentifier(options.nextReasoning, 80);
  const hostDefault = `Host/session default: ${nextModel ? `${nextModel} (inherited)` : "unknown/default (unobserved)"} · reasoning ${nextReasoning ?? "unknown"}`;
  const lines = [
    `Agent Harbor Copilot ${(options.title ?? "team")} · ${copilotPublicIdentifier(runtime.projectName(project), 80) ?? "project"} · 0 model tokens`,
    `${filter ? "Overall Team" : "Team"}: ${ready} ready · ${allActive.length} active${activeBreakdown ? ` (${activeBreakdown})` : ""} · ${benched} benched · ${unhealthy} unhealthy`,
    `${hostDefault}${options.nextMaxOutputTokens === undefined ? "" : ` · model max output per response ${formatCopilotTokenCount(options.nextMaxOutputTokens)} tokens`}`,
    ...globalWarnings,
    ...(selectionGate ? [`Selection gate: ${selectionGate}.`] : []),
    "",
    filter ? "LEAD ACCESS · OVERALL" : "LEAD ACCESS",
    ...renderLeadAccess(allMembers, working, selectionGate),
    "",
    "ACTIVITY",
    ...renderActivity(activity, allActive.length > 0),
    "",
    "ROSTER",
    ...(members.length
      ? [
          ...renderRoster(
            members.slice(0, maximumVisibleCopilotRosterMembers),
            activeMemberStates,
            globalNativeDiscoveryFailure,
          ),
          ...(members.length > maximumVisibleCopilotRosterMembers
            ? [`+${members.length - maximumVisibleCopilotRosterMembers} more roster members; use /team <filter> to narrow the view.`]
            : []),
        ]
      : ["No roster member matches this filter."]),
  ];
  if (!allActive.length && latest && historicalMatches.length) {
    lines.push(
      "",
      filter ? "LAST MISSION · MATCHING MEMBERS" : "LAST MISSION",
      ...(filter
        ? [...formatCopilotRunDetails(historicalMatches), "Filtered history · run /team without a filter for full mission accounting."]
        : formatCopilotMissionDetails(runtime, latest.rootRunId)),
    );
  }
  lines.push(
    "",
    "Commands: /team [filter] · /team stop <run-id|all> · /player <id> <task> · /contract <json> · /bench list [filter] · /bench on <id...> · /bench off <id...> · /join <json> · /retire <id> · /scout <need>",
  );
  return wrapPlainLines(lines).join("\n");
}
