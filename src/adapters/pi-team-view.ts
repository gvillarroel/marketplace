/** Deterministic Pi team inventory and human-readable activity views. */
import { join, resolve } from "node:path";
import { bundledPlayers, rolePlayers, scoutPlayer } from "../core/defaults.js";
import { isOwnedProfile, validatePlayer } from "../core/lifecycle.js";
import { decodePlayer, harnessSpec, isCanonicalPlayerProfile } from "../core/profiles.js";
import { publicMetadataText } from "../core/public-metadata.js";
import { readSafeBoundedProfile } from "../core/safe-profile.js";
import type { PlayerDefinition } from "../core/types.js";
import { wrapPlainLines } from "../core/text-layout.js";
import { runDeterministicCommand } from "./direct.js";
import { defaultHome } from "./shared.js";
import {
  formatElapsed,
  formatPiMissionDetails,
  formatPiRunDetails,
  formatModel,
  formatTokenCount,
  piPublicIdentifier,
  PiTeamRuntime,
  type PiTeamMemberKind,
  type PiTeamRunSnapshot,
} from "./pi-team-runtime.js";

export interface PiTeamMember {
  readonly id: string;
  readonly kind: Exclude<PiTeamMemberKind, "contractor">;
  readonly availability: "ready" | "bench" | "stale" | "conflict";
  readonly description: string;
  readonly capacity: string;
  readonly configuredModel?: string;
  readonly repairKind?: "bundled-profile" | "personal-active" | "personal-registration";
}

interface BenchRow {
  readonly id: string;
  readonly roster: "bundled" | "personal";
  readonly state: "on" | "bench" | "stale" | "conflict";
}

export const maximumVisiblePiRosterMembers = 32;
export const maximumVisiblePiOverviewRosterMembers = 12;
export const maximumVisiblePiOverviewRuns = 4;
export const maximumPiTeamOverviewLines = 30;
const maximumConcurrentPiProfileReads = 8;

function parseBenchRows(output: string): BenchRow[] {
  const lines = output.split(/\r?\n/gu).map((line) => line.trim()).filter(Boolean);
  const rows = lines.flatMap((line) => {
    const match = /^([a-z0-9-]+) \| (bundled|personal) \| (on|bench|stale|conflict)$/u.exec(line.trim());
    return match ? [{ id: match[1], roster: match[2], state: match[3] } as BenchRow] : [];
  });
  if (rows.length !== lines.length) throw new Error("Agent Harbor bench inventory returned an unrecognized row; update or reload the extension");
  const bundled = new Set(rows.filter(({ roster }) => roster === "bundled").map(({ id }) => id));
  const missing = [...bundledPlayers.keys()].filter((id) => !bundled.has(id));
  if (missing.length) throw new Error(`Agent Harbor bench inventory is incomplete; missing bundled members: ${missing.join(", ")}`);
  return rows;
}

function capacity(definition: PlayerDefinition, id = definition.name): string {
  const capabilities = definition.tools.length ? [...definition.tools] : [id === "team-lead" ? "coordination" : "advisory"];
  for (const skill of definition.skills ?? []) capabilities.push(`skill:${skill.name}`);
  return capabilities.join(", ");
}

async function canonicalPersonalDefinition(
  project: string,
  root: string,
  path: string,
  id: string,
): Promise<PlayerDefinition | undefined> {
  const content = await readSafeBoundedProfile(root, path);
  if (!content || !isOwnedProfile(content, id, "personal")) return undefined;
  const definition = validatePlayer(decodePlayer(content, id));
  return isCanonicalPlayerProfile(content, "pi", definition, "personal", resolve(project)) ? definition : undefined;
}

async function registeredPersonalDefinition(project: string, id: string): Promise<PlayerDefinition | undefined> {
  try {
    const root = resolve(project);
    const spec = harnessSpec("pi", defaultHome("pi"), root);
    const path = join(spec.home, spec.registrationDir, `${id}${spec.extension}`);
    return await canonicalPersonalDefinition(root, spec.home, path, id);
  } catch { return undefined; }
}

async function personalDefinition(project: string, row: BenchRow): Promise<PlayerDefinition | undefined> {
  if (row.state === "on") {
    try {
      const root = resolve(project);
      const spec = harnessSpec("pi", defaultHome("pi"), root);
      const path = join(root, spec.activeDir, `${row.id}${spec.extension}`);
      const active = await canonicalPersonalDefinition(root, root, path, row.id);
      if (active) return active;
    } catch { /* Fall back to registration metadata. */ }
  }
  return registeredPersonalDefinition(project, row.id);
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  maximumConcurrency: number,
  transform: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await transform(values[index]);
    }
  };
  await Promise.all(Array.from(
    { length: Math.min(maximumConcurrency, values.length) },
    () => worker(),
  ));
  return results;
}

/** Resolves every Pi-visible roster class without creating an SDK session or model turn. */
export async function collectPiTeamMembers(project: string): Promise<PiTeamMember[]> {
  const raw = await runDeterministicCommand("pi", "bench", "list", project);
  const benchRows = parseBenchRows(raw);
  const members: PiTeamMember[] = [];
  for (const [id, definition] of rolePlayers) {
    members.push({
      id,
      kind: id === "team-lead" ? "manager" : "fixed",
      availability: "ready",
      description: definition.description,
      capacity: capacity(definition, id),
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
  for (const row of benchRows.filter(({ roster }) => roster === "bundled")) {
    const definition = bundledPlayers.get(row.id);
    if (!definition) continue;
    members.push({
      id: row.id,
      kind: "bundled",
      availability: row.state === "on" ? "ready" : row.state,
      description: definition.description,
      capacity: capacity(definition),
      ...(definition.model ? { configuredModel: definition.model } : {}),
      ...(row.state === "stale" ? { repairKind: "bundled-profile" as const } : {}),
    });
  }
  const personalRows = benchRows.filter(({ roster }) => roster === "personal").sort((a, b) => a.id.localeCompare(b.id));
  const personalDefinitions = await mapWithConcurrency(
    personalRows,
    maximumConcurrentPiProfileReads,
    (row) => personalDefinition(project, row),
  );
  for (let index = 0; index < personalRows.length; index += 1) {
    const row = personalRows[index];
    const definition = personalDefinitions[index];
    members.push({
      id: row.id,
      kind: "personal",
      availability: row.state === "on" ? "ready" : row.state,
      description: definition?.description ?? (row.state === "conflict" ? "Unmanaged collision; metadata unavailable" : "Managed profile needs repair"),
      capacity: definition ? capacity(definition) : "unavailable until repaired",
      ...(definition?.model ? { configuredModel: definition.model } : {}),
      ...(row.state === "stale" ? {
        repairKind: definition ? "personal-active" as const : "personal-registration" as const,
      } : {}),
    });
  }
  return members.map((member) => ({
    ...member,
    description: publicMetadataText(member.description, 500) ?? "Description unavailable",
    capacity: publicMetadataText(member.capacity, 500) ?? "unavailable",
    ...(member.configuredModel === undefined
      ? {}
      : { configuredModel: publicMetadataText(member.configuredModel, 200) ?? "redacted" }),
  }));
}

type PiTeamFilterField =
  | "tool"
  | "capability"
  | "skill"
  | "status"
  | "model"
  | "thinking"
  | "task"
  | "run"
  | "member"
  | "kind"
  | "description";

interface PiTeamFilter {
  readonly field?: PiTeamFilterField;
  readonly value: string;
}

const piTeamFilterFields = new Map<string, PiTeamFilterField>([
  ["tool", "tool"],
  ["capability", "capability"],
  ["skill", "skill"],
  ["status", "status"],
  ["state", "status"],
  ["model", "model"],
  ["thinking", "thinking"],
  ["task", "task"],
  ["run", "run"],
  ["id", "member"],
  ["member", "member"],
  ["kind", "kind"],
  ["role", "kind"],
  ["description", "description"],
]);

function parsePiTeamFilter(filter: string): PiTeamFilter {
  const separator = filter.indexOf(":");
  if (separator < 0) return { value: filter };
  const field = piTeamFilterFields.get(filter.slice(0, separator).trim());
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
  member: PiTeamMember,
  filter: string,
  effectiveState: PiTeamRunSnapshot["state"] | PiTeamMember["availability"],
): boolean {
  if (!filter) return true;
  const query = parsePiTeamFilter(filter);
  if (query.field === "tool" || query.field === "capability" || query.field === "skill") {
    return includesFilter([member.capacity], query.value);
  }
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

function activityMatches(run: PiTeamRunSnapshot, filter: string): boolean {
  if (!filter) return true;
  const query = parsePiTeamFilter(filter);
  if (query.field === "status") return equalsFilter([run.state], query.value);
  if (query.field === "model") return includesFilter([formatModel(run)], query.value);
  if (query.field === "thinking") return equalsFilter([run.thinking ?? "unknown"], query.value);
  if (query.field === "task") return includesFilter([run.task], query.value);
  if (query.field === "run") return includesFilter([run.id], query.value);
  if (query.field === "member") return includesFilter([run.agent], query.value);
  if (query.field === "kind") return equalsFilter([run.kind], query.value);
  if (query.field) return false;
  return includesFilter([run.id, run.agent, run.task, formatModel(run)], query.value)
    || equalsFilter([run.kind, run.state, run.thinking ?? "unknown"], query.value);
}

function availabilitySymbol(state: PiTeamMember["availability"]): string {
  if (state === "ready") return "●";
  if (state === "bench") return "○";
  return "!";
}

function renderActivity(runs: readonly PiTeamRunSnapshot[], hasOtherActiveWork: boolean): string[] {
  if (!runs.length) return [hasOtherActiveWork ? "No active work matches this filter." : "No one is working right now."];
  return runs.flatMap((run) => [
    `${run.parentRunId ? "↳" : "●"} ${run.agent} · run ${run.id}${run.parentRunId ? ` · parent ${run.parentRunId}` : ""} · ${run.kind} · ${run.state} · ${formatElapsed(run.elapsedMs)}`,
    "  " + `Task: “${run.task}”`,
    "  " + `${formatModel(run)} · thinking setting ${run.thinking ?? "unknown"} · model turns ${run.nativeMessagesLowerBound ? "≥" : ""}${run.nativeMessages} · ${formatTokenCount(run.usage.total, run.usageLowerBounds.includes("total"))} native tokens`,
  ]);
}

function compactRunLine(run: PiTeamRunSnapshot): string {
  const agent = piPublicIdentifier(run.agent, 24) ?? "unknown";
  const id = piPublicIdentifier(run.id, 16) ?? "unknown";
  const rawModel = run.observedModels.length > 1 || run.observedModelsTruncated
    ? "mixed models"
    : run.model ? `${run.model.provider}/${run.model.id}` : "model unknown";
  const model = piPublicIdentifier(rawModel, 16) ?? "model unknown";
  const source = run.observedModels.length > 1 || run.observedModelsTruncated
    ? "observed"
    : run.modelSource ?? "unobserved";
  return `${run.parentRunId ? "↳" : "●"} ${agent} · ${id} · ${run.state} · ${formatElapsed(run.elapsedMs)} · ${model} (${source}) · turns ${run.nativeMessagesLowerBound ? "≥" : ""}${run.nativeMessages}`;
}

function renderCompactRuns(runs: readonly PiTeamRunSnapshot[], omittedLabel: string): string[] {
  const shown = runs.slice(0, maximumVisiblePiOverviewRuns).map(compactRunLine);
  return [
    ...shown,
    ...(runs.length > maximumVisiblePiOverviewRuns
      ? [`+${runs.length - maximumVisiblePiOverviewRuns} ${omittedLabel} omitted; narrow with /team run:<id> or member:<id>.`]
      : []),
  ];
}

function renderRoster(
  members: readonly PiTeamMember[],
  activeMemberStates: ReadonlyMap<string, PiTeamRunSnapshot["state"]>,
): string[] {
  return members.flatMap((member) => {
    const activity = activeMemberStates.get(member.id) ?? member.availability;
    const repair = member.repairKind === "bundled-profile"
      ? [`  Repair: /bench on ${member.id}; then /reload.`]
      : member.repairKind === "personal-active"
        ? [`  Repair: /bench on ${member.id}; then /reload.`]
        : member.repairKind === "personal-registration"
          ? [`  Repair: re-run /join with the full definition and "replace":true; then /reload.`]
      : member.availability === "conflict"
        ? ["  Repair: inspect the unmanaged collision; Agent Harbor will not overwrite it."]
        : [];
    const description = publicMetadataText(member.description, 500) ?? "Description unavailable";
    const memberCapacity = publicMetadataText(member.capacity, 500) ?? "unavailable";
    const configuredModel = publicMetadataText(member.configuredModel ?? "", 200);
    return [
      `${availabilitySymbol(member.availability)} ${member.id}${member.id === scoutPlayer.name ? " (/scout)" : ""} · ${member.kind} · ${activity}`,
      `  ${description}`,
      `  Capacity: ${memberCapacity} · model: ${configuredModel ? `configured ${configuredModel}` : "inherits the Pi host when run"}`,
      ...repair,
    ];
  });
}

function renderCompactRoster(
  members: readonly PiTeamMember[],
  activeMemberStates: ReadonlyMap<string, PiTeamRunSnapshot["state"]>,
): string[] {
  const shown = members.slice(0, maximumVisiblePiOverviewRosterMembers).map((member) => {
    const activity = activeMemberStates.get(member.id) ?? member.availability;
    return `${availabilitySymbol(member.availability)} ${member.id}${member.id === scoutPlayer.name ? " (/scout)" : ""} · ${member.kind} · ${activity}`;
  });
  return [
    ...shown,
    ...(members.length > maximumVisiblePiOverviewRosterMembers
      ? [`+${members.length - maximumVisiblePiOverviewRosterMembers} more roster members; narrow with /team member:<id>.`]
      : []),
  ];
}

function renderCompactMission(runtime: PiTeamRuntime, rootRunId: string, runs: readonly PiTeamRunSnapshot[]): string[] {
  const root = runs.find((run) => run.parentRunId === undefined) ?? runs[0];
  if (!root) return ["No completed mission snapshot is available."];
  const total = runtime.missionUsage(rootRunId).total;
  const lowerBound = runtime.missionUsageLowerBounds(rootRunId).includes("total");
  return [
    compactRunLine(root),
    `Mission: ${runs.length} tracked run${runs.length === 1 ? "" : "s"} · total ${formatTokenCount(total, lowerBound)} native tokens · details: /team run:${root.id}.`,
  ];
}

function compactMemberIds(members: readonly PiTeamMember[], limit = 12): string {
  if (!members.length) return "none";
  const shown = members.slice(0, limit).map(({ id }) => id).join(", ");
  return members.length > limit ? `${shown} (+${members.length - limit} more)` : shown;
}

function renderLeadAccess(
  members: readonly PiTeamMember[],
  working: ReadonlySet<string>,
  delegationBlockedBy?: string,
): string[] {
  const enabledSpecialists = members.filter((member) => member.id !== "team-lead"
    && member.kind !== "manager" && member.kind !== "utility" && member.availability === "ready");
  const busy = enabledSpecialists.filter((member) => working.has(member.id));
  const delegable = enabledSpecialists.filter((member) => !working.has(member.id));
  const overCapacity = enabledSpecialists.slice(32);
  const bundled = members.filter((member) => member.kind === "bundled");
  const benched = bundled.filter((member) => member.availability === "bench");
  const unhealthy = members.filter((member) => member.availability === "stale" || member.availability === "conflict");
  return [
    ...(overCapacity.length
      ? [
        `Lead capacity exceeded: ${enabledSpecialists.length}/32 enabled specialists · /team-lead preflight stops at 0 model tokens.`,
        ...(delegationBlockedBy ? [`Delegable now: none (${delegationBlockedBy})`] : []),
        `Reduce enabled roster: /bench off ${overCapacity.slice(0, 12).map(({ id }) => id).join(" ")}${overCapacity.length > 12 ? ` · +${overCapacity.length - 12} more; repeat with /team <filter>` : ""}`,
      ]
      : [
        `Lead capacity: ${enabledSpecialists.length}/32`,
        `Delegable now: ${delegationBlockedBy ? `none (${delegationBlockedBy})` : compactMemberIds(delegable)}`,
        ...(busy.length ? [`Busy (double-booking blocked): ${compactMemberIds(busy)}`] : []),
      ]),
    `SDLC coverage: ${bundled.length - benched.length - bundled.filter((member) => member.availability === "stale" || member.availability === "conflict").length}/${bundled.length} enabled · ${benched.length} benched`,
    ...(benched.length ? [`Enable SDLC: /bench on ${benched.map(({ id }) => id).join(" ")}`] : []),
    ...(unhealthy.length ? [`Repair before delegation: ${compactMemberIds(unhealthy)}`] : []),
  ];
}

export interface PiTeamViewOptions {
  readonly filter?: string;
  readonly title?: "team" | "bench";
  readonly nextModel?: { readonly provider: string; readonly id: string; readonly maxTokens?: number };
  /** Pi's current model plus registry authoritatively report that no model is available. */
  readonly nextModelUnavailable?: boolean;
  /** Pi reports usable models, but none is selected for the next inherited child. */
  readonly nextModelAvailableCount?: number;
  /** Pi has no active model and its availability could not be observed safely. */
  readonly nextModelAvailabilityUnobserved?: boolean;
  readonly nextThinking?: string;
}

/** Formats roster plus live runtime data. This function performs no inference. */
export async function formatPiTeamView(
  project: string,
  runtime: PiTeamRuntime,
  options: PiTeamViewOptions = {},
): Promise<string> {
  const filter = options.filter?.trim().toLowerCase() ?? "";
  const allMembers = await collectPiTeamMembers(project);
  const unorderedActive = runtime.activeProjectRuns(project);
  const rootOrder = new Map<string, number>();
  for (const run of unorderedActive) {
    const current = rootOrder.get(run.rootRunId);
    if (current === undefined || run.sequence < current) rootOrder.set(run.rootRunId, run.sequence);
  }
  const allActive = unorderedActive.sort((a, b) =>
    rootOrder.get(a.rootRunId)! - rootOrder.get(b.rootRunId)! || a.sequence - b.sequence);
  const activeMemberStates = new Map(allActive
    .filter((run) => run.kind !== "contractor")
    .map((run) => [run.agent, run.state] as const));
  const members = allMembers.filter((member) =>
    memberMatches(member, filter, activeMemberStates.get(member.id) ?? member.availability));
  const activity = allActive.filter((run) => activityMatches(run, filter));
  const latest = runtime.latestRoot(project);
  const latestMission = !allActive.length && latest ? runtime.mission(latest.rootRunId) : [];
  const historicalMatches = latestMission.filter((run) => activityMatches(run, filter));
  const richDetails = Boolean(filter) && members.length + activity.length + historicalMatches.length <= 2;
  if (!members.length && !activity.length && !historicalMatches.length) {
    const shown = publicMetadataText(options.filter?.trim() ?? "", 80) || "the requested filter";
    return wrapPlainLines([
      `Agent Harbor ${(options.title ?? "team")} · 0 model tokens`,
      `No team member or tracked activity matches “${shown}”.`,
      "Try /team, /bench list, or search by member ID, role, tool, skill, model, thinking, state, task label, or run ID.",
    ]).join("\n");
  }

  const working = new Set(activeMemberStates.keys());
  const ready = allMembers.filter((member) => member.availability === "ready" && !working.has(member.id)).length;
  const benched = allMembers.filter((member) => member.availability === "bench").length;
  const unhealthy = allMembers.filter((member) => member.availability === "stale" || member.availability === "conflict").length;
  const activeCounts = new Map<PiTeamRunSnapshot["state"], number>();
  for (const run of allActive) activeCounts.set(run.state, (activeCounts.get(run.state) ?? 0) + 1);
  const activeBreakdown = (["working", "starting", "cleaning"] as const)
    .flatMap((state) => activeCounts.has(state) ? [`${activeCounts.get(state)} ${state}`] : [])
    .join(" · ");
  const nextModelDisplay = options.nextModel
    ? `${piPublicIdentifier(options.nextModel.provider) ?? "unknown"}/${piPublicIdentifier(options.nextModel.id) ?? "unknown"} (inherited)`
    : options.nextModelUnavailable
      ? "unavailable (Pi reports no usable models; use /login)"
      : options.nextModelAvailableCount !== undefined
        ? `not selected (${options.nextModelAvailableCount} available; use /model)`
        : options.nextModelAvailabilityUnobserved
          ? "no active model; availability unobserved (use /model or /login)"
          : "unknown/default (unobserved)";
  const delegationBlockedBy = options.nextModelUnavailable
    ? "model unavailable"
    : options.nextModelAvailableCount !== undefined
      ? "select a model with /model"
      : options.nextModelAvailabilityUnobserved
        ? "model availability unobserved; use /model or /login"
        : undefined;
  const lines = [
    `Agent Harbor ${(options.title ?? "team")} · ${piPublicIdentifier(runtime.projectName(project), 80) ?? "project"} · 0 model tokens`,
    `${filter ? "Overall Team" : "Team"}: ${ready} ready · ${allActive.length} active${activeBreakdown ? ` (${activeBreakdown})` : ""} · ${benched} benched · ${unhealthy} unhealthy`,
    `Next default child: ${nextModelDisplay} · thinking setting ${piPublicIdentifier(options.nextThinking) ?? "unknown"} · model max output per response ${options.nextModel?.maxTokens === undefined ? "unknown" : `${formatTokenCount(options.nextModel.maxTokens)} tokens`}`,
    "",
    filter ? "LEAD ACCESS · OVERALL" : "LEAD ACCESS",
    ...renderLeadAccess(allMembers, working, delegationBlockedBy),
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
          ...renderRoster(members.slice(0, maximumVisiblePiRosterMembers), activeMemberStates),
          ...(members.length > maximumVisiblePiRosterMembers
            ? [`+${members.length - maximumVisiblePiRosterMembers} more roster members; use /team <filter> to narrow the view.`]
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
        ? [...formatPiRunDetails(historicalMatches), "Filtered history · run /team without a filter for mission summary."]
        : filter
          ? renderCompactRuns(historicalMatches, "matching historical runs")
          : renderCompactMission(runtime, latest.rootRunId, latestMission)),
    );
  }
  if (!richDetails) lines.push("", "Details: /team member:<id> · activity/history: /team run:<id>.");
  lines.push("", "Commands: /team [filter] · /team stop <run-id|all> · Alt+H stop (TUI) · /<id> <task> · /contract <json> · /bench list [filter] · /bench on <id...> · /bench off <id...> · /join <json> · /retire <id> · /scout <need> · /reload");
  const wrapped = wrapPlainLines(lines);
  if (filter || options.title === "bench" || wrapped.length <= maximumPiTeamOverviewLines) {
    return wrapped.join("\n");
  }

  // A large personal roster can make otherwise compact lead and footer rows
  // wrap past one terminal viewport. Rebuild only the unfiltered /team
  // overview from mandatory factory rows plus as many personal rows as fit.
  // Rich member/run filters remain unchanged and expose every omitted member.
  const factoryMembers = allMembers.filter(({ kind }) => kind !== "personal");
  const personalMembers = allMembers.filter(({ kind }) => kind === "personal");
  const enabledSpecialists = allMembers.filter((member) => member.id !== "team-lead"
    && member.kind !== "manager" && member.kind !== "utility" && member.availability === "ready");
  const busySpecialists = enabledSpecialists.filter(({ id }) => working.has(id));
  const bundled = allMembers.filter(({ kind }) => kind === "bundled");
  const enabledBundled = bundled.filter(({ availability }) => availability === "ready").length;
  const overviewModel = nextModelDisplay;
  const overviewThinking = piPublicIdentifier(options.nextThinking, 24) ?? "unknown";
  const overviewOutput = options.nextModel?.maxTokens === undefined
    ? "unknown"
    : `${formatTokenCount(options.nextModel.maxTokens)} tokens`;
  const activityLimit = Math.min(maximumVisiblePiOverviewRuns, Math.max(1, allActive.length));
  const overviewLeadLines = delegationBlockedBy
    ? renderLeadAccess(allMembers, working, delegationBlockedBy)
    : ((enabledSpecialists.length <= 12
        && !(allActive.length > maximumVisiblePiOverviewRuns && busySpecialists.length === 0))
      || enabledSpecialists.length > 32
      ? renderLeadAccess(allMembers, working)
      : [
        `Lead capacity: ${enabledSpecialists.length}/32 · ${enabledSpecialists.length - busySpecialists.length} delegable · ${busySpecialists.length} busy`,
        `SDLC coverage: ${enabledBundled}/${bundled.length} enabled · ${bundled.length - enabledBundled} benched · enable with /bench on <id...>`,
        ...(unhealthy ? [`Repair before delegation: ${unhealthy} unhealthy member${unhealthy === 1 ? "" : "s"}; filter status:stale or status:conflict.`] : []),
      ]);

  const compactOverview = (personalLimit: number, runLimit: number): string[] => {
    const selectedMembers = [...factoryMembers, ...personalMembers.slice(0, personalLimit)];
    const omittedPersonal = personalMembers.length - Math.min(personalLimit, personalMembers.length);
    const shownRuns = allActive.slice(0, runLimit);
    const overviewLines = [
      `Agent Harbor ${(options.title ?? "team")} · ${piPublicIdentifier(runtime.projectName(project), 40) ?? "project"} · 0 model tokens`,
      `Team: ${ready} ready · ${allActive.length} active${activeBreakdown ? ` (${activeBreakdown})` : ""} · ${benched} benched · ${unhealthy} unhealthy`,
      `Next child: ${overviewModel} · thinking ${overviewThinking} · max output ${overviewOutput}`,
      "",
      "LEAD ACCESS",
      ...overviewLeadLines,
      "",
      ...(allActive.length
        ? [
          "ACTIVITY",
          ...shownRuns.map(compactRunLine),
          ...(allActive.length > shownRuns.length
            ? [`+${allActive.length - shownRuns.length} active runs omitted; narrow with /team run:<id> or member:<id>.`]
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
      "Commands: /team [filter] · /<id> <task> · /contract <json> · /bench · /join · /retire · /scout",
    ];
    return wrapPlainLines(overviewLines);
  };

  for (let runLimit = activityLimit; runLimit >= Math.min(1, allActive.length); runLimit -= 1) {
    for (let personalLimit = Math.min(3, personalMembers.length); personalLimit >= 0; personalLimit -= 1) {
      const candidate = compactOverview(personalLimit, runLimit);
      if (candidate.length <= maximumPiTeamOverviewLines) return candidate.join("\n");
    }
  }
  // Factory IDs, safety state, one activity row, and actionable filters are
  // the non-negotiable minimum. Their fields are independently bounded above.
  return compactOverview(0, Math.min(1, allActive.length)).join("\n");
}
