/** Deterministic Copilot team inventory and process-local activity views. */
import { join, resolve } from "node:path";
import { loadManagedActivePlayer } from "../core/active.js";
import { bundledPlayers, rolePlayers, scoutPlayer } from "../core/defaults.js";
import { isOwnedProfile, validatePlayer } from "../core/lifecycle.js";
import { decodePlayer, harnessSpec, isCanonicalPlayerProfile } from "../core/profiles.js";
import { publicMetadataText } from "../core/public-metadata.js";
import { readSafeBoundedProfile } from "../core/safe-profile.js";
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
  readonly tools?: readonly string[];
  readonly skills?: readonly string[];
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
export const maximumVisibleCopilotOverviewRosterMembers = 12;
export const maximumVisibleCopilotOverviewRuns = 4;
export const maximumCopilotTeamOverviewLines = 30;
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

function memberTools(definition: PlayerDefinition): string[] {
  return [...definition.tools];
}

function memberSkills(definition: PlayerDefinition): string[] {
  return (definition.skills ?? []).map(({ name }) => name);
}

async function registeredPersonalDefinition(project: string, id: string): Promise<PlayerDefinition | undefined> {
  try {
    const root = resolve(project);
    const spec = harnessSpec("copilot", defaultHome("copilot"), root);
    const path = join(spec.home, spec.registrationDir, `${id}${spec.extension}`);
    const content = await readSafeBoundedProfile(spec.home, path);
    if (!content) return undefined;
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
      tools: memberTools(definition),
      skills: memberSkills(definition),
      ...(definition.model ? { configuredModel: definition.model } : {}),
    });
  }
  members.push({
    id: scoutPlayer.name,
    kind: "utility",
    availability: "ready",
    description: scoutPlayer.description,
    capacity: "skill discovery, recruitment",
    tools: memberTools(scoutPlayer),
    skills: memberSkills(scoutPlayer),
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
      tools: memberTools(definition),
      skills: memberSkills(definition),
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
        tools: definition ? memberTools(definition) : [],
        skills: definition ? memberSkills(definition) : [],
        ...(definition?.model ? { configuredModel: definition.model } : {}),
        ...(row.state === "stale" ? {
          repairKind: definition ? "personal-active" as const : "personal-registration" as const,
        } : {}),
      } satisfies CopilotTeamMember;
    }));
    members.push(...batch);
  }
  const activeProfileIds = native ? listCopilotActiveProfileIds(project) : [];
  return members.map((member) => verifyNativeAvailability(member, project, native, activeProfileIds))
    .map((member) => ({
      ...member,
      description: publicMetadataText(member.description, 500) ?? "Description unavailable",
      capacity: publicMetadataText(member.capacity, 500) ?? "unavailable",
      ...(member.configuredModel === undefined
        ? {}
        : { configuredModel: publicMetadataText(member.configuredModel, 200) ?? "redacted" }),
    }));
}

type CopilotTeamFilterField =
  | "tool"
  | "capability"
  | "skill"
  | "status"
  | "model"
  | "reasoning"
  | "task"
  | "run"
  | "member"
  | "kind"
  | "description";

interface CopilotTeamFilter {
  readonly field?: CopilotTeamFilterField;
  readonly value: string;
}

const copilotTeamFilterFields = new Map<string, CopilotTeamFilterField>([
  ["tool", "tool"],
  ["capability", "capability"],
  ["skill", "skill"],
  ["status", "status"],
  ["state", "status"],
  ["model", "model"],
  ["reasoning", "reasoning"],
  ["task", "task"],
  ["run", "run"],
  ["id", "member"],
  ["member", "member"],
  ["kind", "kind"],
  ["role", "kind"],
  ["description", "description"],
]);

function parseCopilotTeamFilter(filter: string): CopilotTeamFilter {
  const separator = filter.indexOf(":");
  if (separator < 0) return { value: filter };
  const field = copilotTeamFilterFields.get(filter.slice(0, separator).trim());
  return field
    ? { field, value: filter.slice(separator + 1).trim() }
    : { value: filter };
}

function includesFilter(values: readonly (string | undefined)[], filter: string): boolean {
  return Boolean(filter) && values.some((value) => value?.toLowerCase().includes(filter));
}

function equalsFilter(values: readonly (string | undefined)[], filter: string): boolean {
  return Boolean(filter) && values.some((value) => value?.toLowerCase() === filter);
}

function memberMatches(
  member: CopilotTeamMember,
  filter: string,
  effectiveState: CopilotTeamRunSnapshot["state"] | CopilotTeamMember["availability"],
): boolean {
  if (!filter) return true;
  const query = parseCopilotTeamFilter(filter);
  if (query.field === "tool") return includesFilter(member.tools ?? [], query.value);
  if (query.field === "capability") return includesFilter([member.capacity], query.value);
  if (query.field === "skill") return includesFilter(member.skills ?? [], query.value);
  if (query.field === "status") return equalsFilter([effectiveState], query.value);
  if (query.field === "model") return includesFilter([member.configuredModel], query.value);
  if (query.field === "member") return includesFilter([member.id], query.value);
  if (query.field === "kind") return equalsFilter([member.kind], query.value);
  if (query.field === "description") return includesFilter([member.description], query.value);
  if (query.field) return false;
  return includesFilter([
    member.id,
    member.description,
    member.capacity,
    member.configuredModel,
  ], query.value) || equalsFilter([member.kind, member.availability], query.value);
}

function activityMatches(run: CopilotTeamRunSnapshot, filter: string): boolean {
  if (!filter) return true;
  const query = parseCopilotTeamFilter(filter);
  const models = [run.model, ...run.observedModels];
  const reasoning = [run.reasoningEffort, ...run.observedReasoningEfforts];
  if (query.field === "status") return equalsFilter([run.state], query.value);
  if (query.field === "model") return includesFilter(models, query.value);
  if (query.field === "reasoning") return equalsFilter(reasoning, query.value);
  if (query.field === "task") return includesFilter([run.task], query.value);
  if (query.field === "run") return includesFilter([run.id], query.value);
  if (query.field === "member") return includesFilter([run.agent], query.value);
  if (query.field === "kind") return equalsFilter([run.kind], query.value);
  if (query.field) return false;
  return includesFilter([run.agent, run.task, run.id, ...models], query.value)
    || equalsFilter([run.kind, run.state, ...reasoning], query.value);
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

function compactRunTelemetry(run: CopilotTeamRunSnapshot): string {
  const uncertainIdentity = run.usageIdentityTruncated || run.usageIdentityAmbiguous;
  const total = formatCopilotTokenCount(
    run.usage.total,
    run.usageLowerBounds.includes("total") || run.usageAttributionUnverified || uncertainIdentity,
  );
  if (run.usageAttributionUnverified) return `tok ${total} (unverified)`;
  if (run.usageAggregateConflict) return `tok ${total} (conflict)`;
  const calls = run.nativeCalls === undefined
    ? "calls —"
    : `calls ${formatCopilotTokenCount(run.nativeCalls, uncertainIdentity)}`;
  const identityNote = run.usageIdentityTruncated ? " (capped)" : run.usageIdentityAmbiguous ? " (ambiguous)" : "";
  return `${calls} · tok ${total}${identityNote}`;
}

function compactRunLine(run: CopilotTeamRunSnapshot): string {
  const agent = copilotPublicIdentifier(run.agent, 24) ?? "unknown";
  const id = copilotPublicIdentifier(run.id, 16) ?? "unknown";
  const mixedModels = run.observedModels.length > 1 || run.observedModelsTruncated;
  const rawModel = mixedModels ? "mixed models" : run.model ?? "model unknown";
  const model = copilotPublicIdentifier(rawModel, 16) ?? "model unknown";
  const source = mixedModels ? "observed" : run.modelSource ?? "unobserved";
  return `${run.parentRunId ? "↳" : "●"} ${agent} · ${id} · ${run.state} · ${formatCopilotElapsed(run.elapsedMs)} · ${model} (${source}) · ${compactRunTelemetry(run)}`;
}

function renderCompactRuns(runs: readonly CopilotTeamRunSnapshot[], omittedLabel: string): string[] {
  const shown = runs.slice(0, maximumVisibleCopilotOverviewRuns).map(compactRunLine);
  return [
    ...shown,
    ...(runs.length > maximumVisibleCopilotOverviewRuns
      ? [`+${runs.length - maximumVisibleCopilotOverviewRuns} ${omittedLabel} omitted; narrow with /team run:<id> or member:<id>.`]
      : []),
  ];
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
    const description = publicMetadataText(member.description, 500) ?? "Description unavailable";
    const capacity = publicMetadataText(member.capacity, 500) ?? "unavailable";
    const model = publicMetadataText(member.configuredModel ?? "", 200);
    return [
      `${availabilitySymbol(member.availability)} ${member.id}${member.id === scoutPlayer.name ? " (/scout)" : ""} · ${member.kind} · ${activity}`,
      `  ${description}`,
      `  Capacity: ${capacity} · model: ${model ? `configured ${model}` : "inherits the Copilot host when run"}`,
      ...repair,
    ];
  });
}

function renderCompactRoster(
  members: readonly CopilotTeamMember[],
  activeMemberStates: ReadonlyMap<string, CopilotTeamRunSnapshot["state"]>,
): string[] {
  const shown = members.slice(0, maximumVisibleCopilotOverviewRosterMembers).map((member) => {
    const activity = activeMemberStates.get(member.id) ?? member.availability;
    return `${availabilitySymbol(member.availability)} ${member.id}${member.id === scoutPlayer.name ? " (/scout)" : ""} · ${member.kind} · ${activity}`;
  });
  return [
    ...shown,
    ...(members.length > maximumVisibleCopilotOverviewRosterMembers
      ? [`+${members.length - maximumVisibleCopilotOverviewRosterMembers} more roster members; narrow with /team member:<id>.`]
      : []),
  ];
}

function renderCompactMission(
  runtime: CopilotTeamRuntime,
  rootRunId: string,
  runs: readonly CopilotTeamRunSnapshot[],
): string[] {
  const root = runs.find((run) => run.parentRunId === undefined) ?? runs[0];
  if (!root) return ["No completed mission snapshot is available."];
  const attributionUnverified = runtime.missionUsageAttributionUnverified(rootRunId);
  const aggregateConflict = runtime.missionUsageAggregateConflict(rootRunId);
  const total = runtime.missionUsage(rootRunId).total;
  const lowerBound = runtime.missionUsageLowerBounds(rootRunId).includes("total") || attributionUnverified;
  return [
    compactRunLine(root),
    `Mission: ${runs.length} tracked run${runs.length === 1 ? "" : "s"} · total ${formatCopilotTokenCount(total, lowerBound)} native tokens${attributionUnverified ? " · attribution unverified" : ""}${aggregateConflict ? " · token conflict" : ""} · details: /team run:${root.id}.`,
  ];
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

function renderCompactLeadAccess(
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
    `Enabled specialists: ${specialists.length} · 6 sequential delegations · Can delegate now: ${compactMemberIds(eligibleNow)}`,
    ...(busy.length ? [`Busy (double-booking blocked): ${compactMemberIds(busy)}`] : []),
    `SDLC coverage: ${bundled.filter((member) => member.availability === "ready").length}/${bundled.length} enabled · ${benched.length} benched${benched.length ? " · enable: /bench on <id...>" : ""}`,
    ...(unhealthy.length ? [`Repair before delegation: ${compactMemberIds(unhealthy)}`] : []),
  ];
}

export interface CopilotTeamViewOptions {
  readonly filter?: string;
  readonly title?: "team" | "bench";
  readonly nextModel?: string;
  /** The host returned no usable current-model identity or its offline sentinel. */
  readonly nextModelUnreported?: boolean;
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
  const activeMemberStates = new Map(allActive
    .filter((run) => run.kind !== "contractor")
    .map((run) => [run.agent, run.state] as const));
  const members = allMembers.filter((member) =>
    memberMatches(member, filter, activeMemberStates.get(member.id) ?? member.availability));
  const activity = allActive.filter((run) => activityMatches(run, filter));
  const latest = runtime.latestRoot(project);
  const latestMission = !allActive.length && latest ? runtime.mission(latest.rootRunId) : [];
  const historicalMatches = latestMission.filter((run) => activityMatches(run, filter));
  const richDetails = options.title === "bench"
    || (Boolean(filter) && members.length + activity.length + historicalMatches.length <= 2);
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
    const shown = publicMetadataText(options.filter?.trim() ?? "", 80) || "the requested filter";
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
  const unobservedModel = options.nextModelUnreported ? "no model reported (unobserved)" : "unknown/default (unobserved)";
  const hostDefault = `Host/session default: ${nextModel ? `${nextModel} (inherited)` : unobservedModel} · reasoning ${nextReasoning ?? "unknown"}`;
  const compactHostDefault = `Host default: ${nextModel ? `${nextModel} (inherited)` : unobservedModel} · reasoning ${nextReasoning ?? "unknown"}`;
  const lines = [
    `Agent Harbor Copilot ${(options.title ?? "team")} · ${copilotPublicIdentifier(runtime.projectName(project), 80) ?? "project"} · 0 model tokens`,
    `${filter ? "Overall Team" : "Team"}: ${ready} ready · ${allActive.length} active${activeBreakdown ? ` (${activeBreakdown})` : ""} · ${benched} benched · ${unhealthy} unhealthy`,
    `${richDetails ? hostDefault : compactHostDefault}${options.nextMaxOutputTokens === undefined
      ? ""
      : richDetails
        ? ` · model max output per response ${formatCopilotTokenCount(options.nextMaxOutputTokens)} tokens`
        : ` · max output ${formatCopilotTokenCount(options.nextMaxOutputTokens)} tokens`}`,
    ...globalWarnings,
    ...(selectionGate ? [`Selection gate: ${selectionGate}.`] : []),
    "",
    filter ? "LEAD ACCESS · OVERALL" : "LEAD ACCESS",
    ...(richDetails
      ? renderLeadAccess(allMembers, working, selectionGate)
      : renderCompactLeadAccess(allMembers, working, selectionGate)),
    "",
    "ACTIVITY",
    ...(richDetails
      ? renderActivity(activity, allActive.length > 0)
      : activity.length
        ? renderCompactRuns(activity, filter ? "matching active runs" : "active runs")
        : [allActive.length ? "No active work matches this filter." : "No one is working right now."]),
    "",
    "ROSTER",
    ...(members.length
      ? richDetails
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
        : renderCompactRoster(members, activeMemberStates)
      : ["No roster member matches this filter."]),
  ];
  if (!allActive.length && latest && historicalMatches.length) {
    lines.push(
      "",
      filter ? "LAST MISSION · MATCHING MEMBERS" : "LAST MISSION",
      ...(richDetails
        ? [...formatCopilotRunDetails(historicalMatches), "Filtered history · run /team without a filter for mission summary."]
        : filter
          ? renderCompactRuns(historicalMatches, "matching historical runs")
          : renderCompactMission(runtime, latest.rootRunId, latestMission)),
    );
  }
  if (!richDetails) lines.push("", "Details: /team member:<id> · activity/history: /team run:<id>.");
  lines.push(
    "",
    ...(richDetails
      ? ["Commands: /team [filter] · /team help|--help · /team stop <run-id|all> · /player <id> <task> · /contract <json> · /list-skills [--descriptions|-d] [filter] · /bench list [filter] · /bench on|off <id...> · /join <json> · /retire <id> · /scout <need>"]
      : ["Commands: /<id> <task> · /team help|<filter>|stop <run|all> · /bench · /join · /retire · /scout · /contract · /list-skills"]),
  );
  const wrapped = wrapPlainLines(lines);
  if (filter || options.title === "bench" || wrapped.length <= maximumCopilotTeamOverviewLines) {
    return wrapped.join("\n");
  }

  // Preserve every factory identity in the first viewport and spend only the
  // remaining wrapped-line budget on personal rows and activity. Filtered
  // member/run views remain rich and are never clipped by this overview path.
  const factoryMembers = allMembers.filter(({ kind }) => kind !== "personal");
  const personalMembers = allMembers.filter(({ kind }) => kind === "personal");
  const specialists = allMembers.filter((member) => member.id !== "team-lead"
    && member.kind !== "manager" && member.kind !== "utility" && member.availability === "ready");
  const busySpecialists = specialists.filter(({ id }) => working.has(id));
  const bundled = allMembers.filter(({ kind }) => kind === "bundled");
  const enabledBundled = bundled.filter(({ availability }) => availability === "ready").length;
  const overviewModel = nextModel
    ? `${copilotPublicIdentifier(nextModel, 40) ?? "unknown"} (inherited)`
    : options.nextModelUnreported
      ? "no model reported (unobserved)"
      : "unknown/default (unobserved)";
  const overviewReasoning = copilotPublicIdentifier(nextReasoning, 24) ?? "unknown";
  const overviewOutput = options.nextMaxOutputTokens === undefined
    ? "unknown"
    : `${formatCopilotTokenCount(options.nextMaxOutputTokens)} tokens`;
  const safetyLines = [
    ...globalWarnings,
    ...(selectionGate ? [`Selection gate: ${selectionGate}.`] : []),
  ].flatMap((value) => copilotPublicIdentifier(value, 72) ?? []);
  const activityLimit = Math.min(maximumVisibleCopilotOverviewRuns, Math.max(1, allActive.length));
  const overviewLeadLines = specialists.length <= 12
    ? renderCompactLeadAccess(allMembers, working, selectionGate)
    : [
      `Enabled specialists: ${specialists.length} · 6 sequential delegations · Can delegate now: ${selectionGate ? "none" : specialists.length - busySpecialists.length}`,
      ...(busySpecialists.length ? [`Busy (double-booking blocked): ${busySpecialists.length} specialists`] : []),
      `SDLC coverage: ${enabledBundled}/${bundled.length} enabled · ${bundled.length - enabledBundled} benched · enable with /bench on <id...>`,
      ...(unhealthy ? [`Repair before delegation: ${unhealthy} unhealthy member${unhealthy === 1 ? "" : "s"}; filter status:stale or status:unavailable.`] : []),
    ];

  const compactOverview = (personalLimit: number, runLimit: number): string[] => {
    const selectedMembers = [...factoryMembers, ...personalMembers.slice(0, personalLimit)];
    const omittedPersonal = personalMembers.length - Math.min(personalLimit, personalMembers.length);
    const shownRuns = allActive.slice(0, runLimit);
    const overviewLines = [
      `Agent Harbor Copilot ${(options.title ?? "team")} · ${copilotPublicIdentifier(runtime.projectName(project), 40) ?? "project"} · 0 model tokens`,
      `Team: ${ready} ready · ${allActive.length} active${activeBreakdown ? ` (${activeBreakdown})` : ""} · ${benched} benched · ${unhealthy} unhealthy`,
      `Host default: ${overviewModel} · reasoning ${overviewReasoning} · max output ${overviewOutput}`,
      ...safetyLines,
      "",
      "LEAD ACCESS",
      ...overviewLeadLines,
      "",
      ...(allActive.length
        ? [
          "ACTIVITY",
          ...shownRuns.map(compactRunLine),
          ...(allActive.length > shownRuns.length
            ? [`+${allActive.length - shownRuns.length} active runs omitted; use /team run:<id> or member:<id>.`]
            : []),
        ]
        : latest && latestMission.length
          ? ["LAST MISSION", ...renderCompactMission(runtime, latest.rootRunId, latestMission)]
          : ["ACTIVITY", "No one is working right now."]),
      "",
      "ROSTER",
      ...renderCompactRoster(selectedMembers, activeMemberStates),
      ...(omittedPersonal
        ? [`+${omittedPersonal} personal member${omittedPersonal === 1 ? "" : "s"} omitted; use /team kind:personal or /team member:<id>.`]
        : []),
      "",
      "Details: /team member:<id> · /team run:<id> · /team help",
      "Actions: /<id> <task> · /team stop <run|all> · /bench · /join · /retire · /scout",
    ];
    return wrapPlainLines(overviewLines);
  };

  for (let runLimit = activityLimit; runLimit >= Math.min(1, allActive.length); runLimit -= 1) {
    for (let personalLimit = Math.min(3, personalMembers.length); personalLimit >= 0; personalLimit -= 1) {
      const candidate = compactOverview(personalLimit, runLimit);
      if (candidate.length <= maximumCopilotTeamOverviewLines) return candidate.join("\n");
    }
  }
  return compactOverview(0, Math.min(1, allActive.length)).join("\n");
}
