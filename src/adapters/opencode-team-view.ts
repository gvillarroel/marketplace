/** Human-readable, bounded rendering for OpenCode's deterministic team snapshot. */
import { takeTerminalColumns, terminalLineWidth, wrapPlainLines } from "../core/text-layout.js";
import { scoutPlayer } from "../core/defaults.js";
import { maximumHarborTeamRosterMembers } from "../core/custom-tools.js";
import {
  maximumOpenCodeActiveSessions,
  maximumOpenCodeMessagesPerSession,
  maximumOpenCodeMessageSessions,
  maximumOpenCodeRosterRecords,
  maximumOpenCodeRosterSnapshotBytes,
  maximumOpenCodeSessions,
  openCodePublicIdentifier,
  openCodePublicLabel,
  openCodeTaskLabel,
  type OpenCodeDirectAliasCollision,
  type OpenCodeObservedUsage,
  type OpenCodeTeamMember,
  type OpenCodeTeamReservationSnapshot,
  type OpenCodeTeamRunSnapshot,
  type OpenCodeTeamSnapshot,
  type OpenCodeTeamStopResult,
} from "./opencode-team-runtime.js";

const maximumOpenCodeTeamViewCharacters = 24_000;
export const maximumOpenCodeTeamDialogLines = 30;
const maximumCompactRosterRows = 10;
const maximumCompactActivityRows = 2;
const maximumDiagnosticReasons = 64;
const maximumDiagnosticReasonCharacters = 320;
const diagnosticBodyLineBudget = 16;

type FilterField = "member" | "kind" | "status" | "capability" | "tool" | "skill" | "model" | "task" | "run" | "mode" | "owner";

type TeamViewSection = "combined" | "roster" | "activity";

interface TeamViewRequest {
  readonly section: TeamViewSection;
  readonly page: number;
  readonly filter: string;
}

interface TeamFilter {
  readonly field?: FilterField;
  readonly value: string;
}

const filterFields = new Map<string, FilterField>([
  ["id", "member"], ["member", "member"], ["role", "kind"], ["kind", "kind"],
  ["state", "status"], ["status", "status"], ["capability", "capability"],
  ["tool", "tool"], ["skill", "skill"], ["model", "model"], ["task", "task"],
  ["run", "run"], ["mode", "mode"], ["invocation", "mode"], ["owner", "owner"],
]);

function parseFilter(filter: string): TeamFilter {
  const separator = filter.indexOf(":");
  if (separator < 0) return { value: filter };
  const rawField = filter.slice(0, separator).trim().toLowerCase();
  const value = filter.slice(separator + 1).trim();
  if (rawField === "pid") {
    throw new Error("PID filters are intentionally unavailable; use owner:<public-locator> from /team activity instead");
  }
  if (rawField === "reasoning") {
    throw new Error("reasoning is not a searchable public field; use model:<value> or run:<id>");
  }
  const field = filterFields.get(rawField);
  if (!field) {
    throw new Error(`unknown /team filter field “${openCodePublicIdentifier(rawField, 32) ?? "invalid"}”; run /team help for supported fields`);
  }
  if (!value) throw new Error(`/team ${rawField}: requires a non-empty value`);
  return { field, value };
}

function parseTeamViewRequest(input: string): TeamViewRequest {
  const trimmed = input.trim();
  const section = /^(roster|activity)(?:\s+(\d{1,6}))?$/iu.exec(trimmed);
  if (section) {
    const page = section[2] ? Number(section[2]) : 1;
    if (!Number.isSafeInteger(page) || page < 1) throw new Error(`/team ${section[1].toLowerCase()} page must be at least 1`);
    return { section: section[1].toLowerCase() as Exclude<TeamViewSection, "combined">, page, filter: "" };
  }
  const pageTokens = [...trimmed.matchAll(/(?:^|\s)page:(\d{1,6})(?=\s|$)/giu)];
  if (pageTokens.length > 1) throw new Error("/team accepts at most one page:<number> selector");
  const page = pageTokens.length ? Number(pageTokens[0][1]) : 1;
  if (!Number.isSafeInteger(page) || page < 1) throw new Error("/team page must be at least 1");
  const token = pageTokens[0];
  const filter = token
    ? `${trimmed.slice(0, token.index).trim()} ${trimmed.slice((token.index ?? 0) + token[0].length).trim()}`.trim()
    : trimmed;
  parseFilter(filter);
  return { section: "combined", page, filter };
}

function includes(values: readonly (string | undefined)[], value: string): boolean {
  return Boolean(value) && values.some((candidate) => candidate?.toLowerCase().includes(value));
}

function equals(values: readonly (string | undefined)[], value: string): boolean {
  return Boolean(value) && values.some((candidate) => candidate?.toLowerCase() === value);
}

function availabilityTerms(availability: OpenCodeTeamMember["availability"]): readonly string[] {
  if (availability === "ready") return ["ready", "invocable"];
  if (availability === "reload-required") return ["reload-required", "reload required", "enabled"];
  return [availability];
}

function memberStatusTerms(
  member: OpenCodeTeamMember,
  effectiveStatus: OpenCodeTeamMember["availability"] | OpenCodeTeamRunSnapshot["state"] |
    OpenCodeTeamReservationSnapshot["phase"],
  idleAuthoritative: boolean,
): readonly string[] {
  const terms = effectiveStatus === member.availability ? [...availabilityTerms(member.availability)] : [effectiveStatus];
  if (idleAuthoritative && effectiveStatus === "ready") terms.push("idle");
  return terms;
}

function memberMatches(
  member: OpenCodeTeamMember,
  filter: string,
  effectiveStatus: OpenCodeTeamMember["availability"] | OpenCodeTeamRunSnapshot["state"] |
    OpenCodeTeamReservationSnapshot["phase"] = member.availability,
  idleAuthoritative = false,
): boolean {
  if (!filter) return true;
  const query = parseFilter(filter);
  const statuses = memberStatusTerms(member, effectiveStatus, idleAuthoritative);
  if (query.field === "member") return includes([member.id], query.value);
  if (query.field === "kind") return equals([member.kind], query.value);
  if (query.field === "status") return equals(statuses, query.value);
  if (query.field === "capability") return includes([member.capacity], query.value);
  if (query.field === "tool") return includes(member.tools, query.value);
  if (query.field === "skill") return includes(member.skills, query.value);
  if (query.field === "model") return includes([member.configuredModel], query.value);
  if (query.field) return false;
  return includes([
    member.id, member.description, member.capacity, member.configuredModel, ...member.tools, ...member.skills,
  ], query.value) || equals([member.kind, ...statuses], query.value);
}

function reservationMatches(reservation: OpenCodeTeamReservationSnapshot, filter: string): boolean {
  if (!filter) return true;
  const query = parseFilter(filter);
  if (query.field === "member") return includes([reservation.agent], query.value);
  if (query.field === "status") return equals([reservation.phase], query.value);
  if (query.field === "mode") return equals([reservation.invocation], query.value);
  if (query.field === "run") return includes([reservation.id], query.value);
  if (query.field === "owner") return equals([reservation.ownerLocator], query.value);
  if (query.field) return false;
  return includes([reservation.agent, reservation.id, reservation.ownerLocator], query.value)
    || equals([reservation.phase, reservation.invocation], query.value);
}

function runMatches(run: OpenCodeTeamRunSnapshot, filter: string): boolean {
  if (!filter) return true;
  const query = parseFilter(filter);
  const model = run.model ? `${run.model.provider}/${run.model.id}${run.model.variant ? `@${run.model.variant}` : ""}` : undefined;
  if (query.field === "member") return includes([run.agent], query.value);
  if (query.field === "kind") return equals([run.kind], query.value);
  if (query.field === "status") return equals([run.state], query.value);
  if (query.field === "model") return includes([model], query.value);
  if (query.field === "task") return run.taskObserved && includes([run.task], query.value);
  if (query.field === "run") return includes([run.id], query.value);
  if (query.field === "mode") return equals([run.invocation], query.value);
  if (query.field === "owner") return equals([run.ownerLocator], query.value);
  if (query.field) return false;
  return includes([run.agent, run.taskObserved ? run.task : undefined, run.id, model, run.ownerLocator], query.value)
    || equals([run.kind, run.state, run.invocation], query.value);
}

interface ActiveTelemetryFilterCompleteness {
  readonly field: "model" | "task" | "task/model";
  readonly unknownCount: number;
}

function activeTelemetryFilterCompleteness(
  snapshot: OpenCodeTeamSnapshot,
  filter: string,
): ActiveTelemetryFilterCompleteness | undefined {
  if (!filter) return undefined;
  const parsed = parseFilter(filter);
  const field = parsed.field === "model" || parsed.field === "task"
    ? parsed.field
    : parsed.field === undefined ? "task/model" : undefined;
  if (!field) return undefined;
  const unknownRuns = field === "model"
    ? snapshot.runs.filter(({ model }) => model === undefined).length
    : field === "task"
      ? snapshot.runs.filter(({ taskObserved }) => !taskObserved).length
      : snapshot.runs.filter(({ taskObserved, model }) => !taskObserved || model === undefined).length;
  // Lifecycle reservations intentionally expose neither task nor model.
  return { field, unknownCount: unknownRuns + snapshot.reservations.length };
}

function formatElapsed(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function formatCount(value: number): string {
  return Math.floor(value).toLocaleString("en-US");
}

function quotedPublic(value: string): string {
  return `"${value.replaceAll("\"", "″")}"`;
}

function formattedObservedModel(run: OpenCodeTeamRunSnapshot): string | undefined {
  if (!run.model) return undefined;
  const provider = openCodePublicIdentifier(run.model.provider, 100) ?? "unknown";
  const model = openCodePublicIdentifier(run.model.id, 160) ?? "unknown";
  const variant = run.model.variant ? openCodePublicIdentifier(run.model.variant, 100) ?? "unobserved" : undefined;
  return `provider=${quotedPublic(provider)} · model=${quotedPublic(model)}${variant ? ` · variant=${quotedPublic(variant)}` : ""}`;
}

function formatCostAmount(value: number): string {
  return Object.is(value, -0) ? "0" : value.toString();
}

function fallbackObservedTotal(usage: OpenCodeObservedUsage): {
  readonly total?: number;
  readonly complete: boolean;
  readonly bounded: boolean;
} {
  const components = [usage.input, usage.output, usage.reasoning, usage.cacheRead, usage.cacheWrite];
  const observed = components.filter((value): value is number => value !== undefined);
  let total = 0;
  let bounded = false;
  for (const value of observed) {
    if (total > Number.MAX_SAFE_INTEGER - value) {
      total = Number.MAX_SAFE_INTEGER;
      bounded = true;
    } else total += value;
  }
  return {
    ...(observed.length ? { total } : {}),
    complete: observed.length === components.length,
    bounded,
  };
}

function formatObservedTotal(run: OpenCodeTeamRunSnapshot): string | undefined {
  const fallback = run.usage.total === undefined ? fallbackObservedTotal(run.usage) : undefined;
  const total = run.usage.total ?? fallback?.total;
  if (total === undefined) return undefined;
  const source = run.usageTotalSource ?? "observed-components";
  const lowerBound = run.usageTotalLowerBound === true || run.telemetryLowerBound || run.usageLowerBounds?.includes("total") ||
    fallback?.complete === false || fallback?.bounded === true;
  const marker = lowerBound ? "≥" : "";
  const label = source === "native"
    ? "native total"
    : source === "mixed" ? "combined native/component total" : "observed component sum";
  return `${label} ${marker}${formatCount(total)}${run.usageTotalConflict ? " (component conflict)" : lowerBound && source !== "native" ? " (partial)" : ""}`;
}

function formatUsage(run: OpenCodeTeamRunSnapshot): string {
  const { usage, observedAssistantTurns: turns, usageScope: scope } = run;
  const lowerBounds = new Set(run.usageLowerBounds ?? []);
  const marker = (field: keyof OpenCodeObservedUsage): string =>
    run.telemetryLowerBound || lowerBounds.has(field) ? "≥" : "";
  const values = [
    usage.input === undefined ? undefined : `input ${marker("input")}${formatCount(usage.input)}`,
    usage.output === undefined ? undefined : `output ${marker("output")}${formatCount(usage.output)}`,
    usage.reasoning === undefined ? undefined : `reasoning ${marker("reasoning")}${formatCount(usage.reasoning)}`,
    usage.cacheRead === undefined ? undefined : `cache read ${marker("cacheRead")}${formatCount(usage.cacheRead)}`,
    usage.cacheWrite === undefined ? undefined : `cache write ${marker("cacheWrite")}${formatCount(usage.cacheWrite)}`,
    formatObservedTotal(run),
    usage.cost === undefined ? undefined : `cost ${marker("cost")}$${formatCostAmount(usage.cost)}`,
  ].filter((value): value is string => value !== undefined);
  const scopeLabel = scope === "session-total" ? "child session total" : "current turn";
  const prefix = turns === undefined
    ? []
    : [`assistant turns ${run.observedAssistantTurnsLowerBound ? "≥" : ""}${formatCount(turns)}${run.observedAssistantTurnsLowerBound ? " (page lower bound)" : ""}`];
  if (!values.length) return `${prefix.length ? `${prefix.join(" · ")} · ` : ""}usage and cost unobserved`;
  return `${scopeLabel} ${run.telemetryLowerBound ? "lower bound" : "observed"} · ${[...prefix, ...values].join(" · ")}`;
}

function availabilitySymbol(
  member: OpenCodeTeamMember,
  activeState: OpenCodeTeamRunSnapshot["state"] | OpenCodeTeamReservationSnapshot["phase"] | undefined,
  activeAuthoritative: boolean,
): string {
  if (activeState) return activeState === "working" ? "●" : "◐";
  if (!activeAuthoritative && member.availability !== "stale" && member.availability !== "conflict" &&
      member.availability !== "unavailable") return "◐";
  if (member.availability === "ready") return "●";
  if (member.availability === "reload-required") return "◐";
  if (member.availability === "bench") return "○";
  return "!";
}

function availabilityLabel(availability: OpenCodeTeamMember["availability"]): string {
  if (availability === "ready") return "ready · invocable";
  if (availability === "reload-required") return "enabled · reload required";
  return availability;
}

function visibleMemberState(
  member: OpenCodeTeamMember,
  activeState: OpenCodeTeamRunSnapshot["state"] | OpenCodeTeamReservationSnapshot["phase"] | undefined,
  activeAuthoritative: boolean,
): string {
  if (activeState) return activeState;
  if (activeAuthoritative) return availabilityLabel(member.availability);
  if (member.availability === "ready") return "enabled · activity/availability unverified";
  if (member.availability === "reload-required") return "enabled · reload required · activity unverified";
  if (member.availability === "bench") return "rostered as bench · activity unverified";
  return `${member.availability} · activity unverified`;
}

function renderRoster(
  members: readonly OpenCodeTeamMember[],
  activity: ReadonlyMap<string, OpenCodeTeamRunSnapshot["state"] | OpenCodeTeamReservationSnapshot["phase"]>,
  activeAuthoritative: boolean,
  aliasCollisions: ReadonlyMap<string, string>,
): string[] {
  return members.flatMap((member) => {
    const description = openCodePublicIdentifier(member.description, 500) ?? "Description unavailable";
    const capacity = openCodePublicIdentifier(member.capacity, 500) ?? "unavailable";
    const configuredModel = openCodePublicIdentifier(member.configuredModel, 200);
    const [descriptionPrefix, descriptionRemainder] = takeTerminalColumns(description, 78);
    const [capacityPrefix, capacityRemainder] = takeTerminalColumns(capacity, 66);
    const activeState = activity.get(member.id);
    const state = visibleMemberState(member, activeState, activeAuthoritative);
    const unavailableAlias = aliasCollisions.get(member.id);
    const repair = member.availability === "stale"
      ? [`  Repair: /bench-on ${member.id}; then reload OpenCode.`]
      : member.availability === "conflict"
        ? ["  Repair: inspect the unmanaged collision; Agent Harbor will not overwrite it."]
        : member.availability === "reload-required"
          ? [`  Reload OpenCode; then /team member:${member.id} must report ready · invocable.`]
          : member.availability === "unavailable"
            ? ["  Inventory unavailable; retry /team after host recovery. Invocation is not advertised."]
            : [];
    return [
      `${availabilitySymbol(member, activeState, activeAuthoritative)} ${member.id}${member.id === scoutPlayer.name && !unavailableAlias ? " (/scout)" : ""} · ${member.kind} · ${state}`,
      `  ${descriptionPrefix}${descriptionRemainder ? "… (description abbreviated)" : ""}`,
      `  Capacity: ${capacityPrefix}${capacityRemainder ? "… (abbreviated)" : ""}`,
      `  Model: ${configuredModel ? `configured=${quotedPublic(configuredModel)}` : "inherits the OpenCode session when run"}`,
      ...(unavailableAlias ? [
        `  Alias /${unavailableAlias}: unavailable; a foreign command was preserved.`,
        "  Do not invoke it as Agent Harbor.",
        member.availability === "ready"
          ? member.kind === "manager" || member.kind === "utility"
            ? `  Native ${member.id} selection remains available.`
            : "  Native agent selection remains available; team-lead can delegate this specialist when it is not busy."
          : "  No Harbor invocation is advertised for this member until its separate agent/inventory issue is repaired.",
        `  Repair: rename or remove the foreign /${unavailableAlias} command, then reload OpenCode.`,
      ] : []),
      ...repair,
    ];
  });
}

function renderCompactRoster(
  members: readonly OpenCodeTeamMember[],
  activity: ReadonlyMap<string, OpenCodeTeamRunSnapshot["state"] | OpenCodeTeamReservationSnapshot["phase"]>,
  activeAuthoritative: boolean,
  aliasCollisions: ReadonlyMap<string, string>,
): string[] {
  return members.map((member) => {
    const activeState = activity.get(member.id);
    const state = visibleMemberState(member, activeState, activeAuthoritative);
    const unavailableAlias = aliasCollisions.get(member.id);
    return `${availabilitySymbol(member, activeState, activeAuthoritative)} ${member.id}${member.id === scoutPlayer.name && !unavailableAlias ? " (/scout)" : ""} · ${member.kind} · ${state}${unavailableAlias ? ` · /${unavailableAlias} alias unavailable (foreign command)` : ""}`;
  });
}

function renderActivity(runs: readonly OpenCodeTeamRunSnapshot[], hasOtherActiveWork: boolean): string[] {
  if (!runs.length) return [hasOtherActiveWork ? "No active work matches this filter." : "No Agent Harbor teammate is working right now."];
  return runs.flatMap((run) => {
    const model = formattedObservedModel(run);
    const parent = run.parentRunId
      ? ` · parent ${run.parentRunId}${run.parentSource === "inferred" ? " (inferred from the only active lead)" : ""}`
      : "";
    return [
      `${run.parentRunId ? "↳" : "●"} ${run.agent} · run ${run.id}${parent} · ${run.kind === "contractor" ? "disposable contractor · " : ""}${run.invocation} · ${run.state} · roster ${run.rosterState ?? "unknown"} · owner ${run.ownerLocator ?? "unobserved"} · ${formatElapsed(run.elapsedMs)}`,
      `  Task: “${run.task}”`,
      `  ${model ? `${model} (observed)` : "model unobserved"} · ${formatUsage(run)}`,
    ];
  });
}

function renderReservationActivity(reservations: readonly OpenCodeTeamReservationSnapshot[]): string[] {
  return reservations.flatMap((reservation) => [
    `◐ ${reservation.agent} · ${reservation.id ? `run ${reservation.id}` : "run ID pending"} · ${reservation.invocation} lifecycle · ${reservation.phase} · owner ${reservation.ownerLocator ?? "unobserved"} · ${formatElapsed(reservation.elapsedMs)}`,
    reservation.stopAvailable
      ? "  Cross-isolate owner claim verified in this OpenCode process; open /team, then enter stop <run-id|all> and wait for terminal cleanup."
      : reservation.stopBlockReason === "pending-child"
        ? "  Disposable child identity is not published yet · not yet stoppable; the lead session will never be used as its stop target."
        : reservation.stopBlockReason === "stale-heartbeat"
          ? "  Owner heartbeat is overdue; the teammate remains busy and stop is disabled until the owning OpenCode process recovers or restarts."
        : reservation.stopBlockReason === "ambiguous-identity"
          ? "  Multiple owner claims reference one native session; stop is disabled until filesystem recovery resolves that identity."
        : reservation.stopBlockReason === "claim-changed"
          ? "  The owner-claim generation changed during inspection; task content was discarded and stop is disabled until /team observes one stable owner."
        : reservation.stopBlockReason === "ownership-changed"
          ? "  Native agent/title ownership changed or became unavailable during inspection; task content was discarded and stop is disabled until /team observes a stable identity."
        : reservation.stopBlockReason === "stop-confirmation-pending"
          ? "  A stop request was already dispatched and remains unconfirmed; do not retry it. Refresh /team after the host settles."
        : reservation.stopBlockReason === "dual-engine"
          ? "  The same Harbor identity is active in both OpenCode engines; task content is withheld and stop is disabled until one authority remains."
        : reservation.stopBlockReason === "native-run-pending"
          ? "  The owner claim is working but its native runner is not currently visible; lifecycle state is still reconciling."
        : reservation.stopBlockReason === "lifecycle-transition"
          ? "  The owner claim is starting or cleaning; stop is disabled until the lifecycle settles."
      : "  Another OpenCode process owns this claim; inspect or stop it from that process.",
  ]);
}

function compactActivityLines(run: OpenCodeTeamRunSnapshot): string[] {
  const exactTask = openCodePublicIdentifier(openCodeTaskLabel(run.task), 72) ?? "task unavailable";
  const [taskPrefix, taskRemainder] = takeTerminalColumns(exactTask, 40);
  const task = `${taskPrefix}${taskRemainder ? "…" : ""}`;
  let model = "model unobserved";
  let exactModelRoute: string | undefined;
  if (run.model) {
    const exact = formattedObservedModel(run)!;
    const [prefix, remainder] = takeTerminalColumns(exact, 44);
    if (remainder) {
      model = `model ${prefix}… (abbreviated)`;
      exactModelRoute = `  Exact model: /team run:${run.id}`;
    } else model = `model ${exact} observed`;
  }
  const total = formatObservedTotal(run) ?? "tokens unobserved";
  const cost = run.usage.cost === undefined
    ? "cost unobserved"
    : `cost ${run.telemetryLowerBound || run.usageLowerBounds?.includes("cost") ? "≥" : ""}$${formatCostAmount(run.usage.cost)}`;
  return [
    `${run.parentRunId ? "↳" : "●"} ${run.agent} · run ${run.id} · ${run.kind === "contractor" ? "disposable contractor · " : ""}${run.invocation} · ${run.state} · owner ${run.ownerLocator ?? "unobserved"} · ${formatElapsed(run.elapsedMs)} · task “${task}”`,
    `  ${model}${exactModelRoute ? "" : ` · ${total} · ${cost}`}`,
    ...(taskRemainder ? [`  Exact task label: /team run:${run.id}`] : []),
    ...(exactModelRoute ? [exactModelRoute, `  ${total} · ${cost}`] : []),
  ];
}

function compactReservationLine(reservation: OpenCodeTeamReservationSnapshot): string {
  const stopState = reservation.stopAvailable ? "stoppable"
    : reservation.stopBlockReason === "dual-engine" ? "stop blocked: dual engine"
      : reservation.stopBlockReason === "stale-heartbeat" ? "stop blocked: owner heartbeat"
        : reservation.stopBlockReason === "other-process" ? "stop blocked: other process"
          : reservation.stopBlockReason === "claim-changed" ? "stop blocked: claim changed"
            : reservation.stopBlockReason === "ownership-changed" ? "stop blocked: ownership changed"
              : reservation.stopBlockReason === "stop-confirmation-pending" ? "stop pending: do not retry"
            : reservation.stopBlockReason === "ambiguous-identity" ? "stop blocked: competing claims"
              : reservation.stopBlockReason === "native-run-pending" ? "stop blocked: runner reconciling"
                : "stop blocked: lifecycle";
  return `◐ ${reservation.agent} · ${reservation.id ? `run ${reservation.id}` : "run ID pending"} · ${reservation.invocation} lifecycle · ${reservation.phase} · owner ${reservation.ownerLocator ?? "unobserved"} · ${stopState} · ${formatElapsed(reservation.elapsedMs)}`;
}

function compactLeadAccess(
  members: readonly OpenCodeTeamMember[],
  runs: readonly OpenCodeTeamRunSnapshot[],
  reservations: readonly OpenCodeTeamReservationSnapshot[],
  activeAuthoritative: boolean,
  directAliasCollisions: readonly OpenCodeDirectAliasCollision[],
): string {
  if (!activeAuthoritative) {
    return "Lead: blocked · teammate availability/delegability unverified until activity authority recovers";
  }
  const busyIDs = new Set([
    ...runs.filter(({ kind }) => kind !== "contractor").map(({ agent }) => agent),
    ...reservations.map(({ agent }) => agent),
  ]);
  const enabledSpecialists = members.filter((member) =>
    member.kind !== "manager" && member.kind !== "utility" &&
    (member.availability === "ready" || member.availability === "reload-required"));
  if (enabledSpecialists.length > maximumHarborTeamRosterMembers) {
    return `Lead: blocked · ${enabledSpecialists.length}/${maximumHarborTeamRosterMembers} enabled specialist limit · disable surplus bundled/personal members with /bench-off <id...>`;
  }
  const loadedSpecialists = enabledSpecialists.filter(({ availability }) => availability === "ready");
  const available = loadedSpecialists.filter(({ id }) => !busyIDs.has(id)).length;
  const busy = loadedSpecialists.length - available;
  const reloadRequired = members.filter((member) =>
    member.kind !== "manager" && member.kind !== "utility" && member.availability === "reload-required").length;
  const bundled = members.filter(({ kind }) => kind === "bundled");
  const collisionAgents = new Set(directAliasCollisions.map(({ agent }) => agent));
  const invocable = bundled.filter(({ availability, id }) => availability === "ready" && !collisionAgents.has(id)).length;
  const aliasBlocked = bundled.filter(({ id }) => collisionAgents.has(id)).length;
  const bundledReloadRequired = bundled.filter(({ availability }) => availability === "reload-required").length;
  return `Lead: ${available} available · ${busy} busy${reloadRequired ? ` · ${reloadRequired} blocked until reload` : ""} · max 6 sequential · SDLC direct ${invocable}/${bundled.length}${aliasBlocked ? ` · alias collisions ${aliasBlocked}` : ""}${bundledReloadRequired ? ` · pending reload ${bundledReloadRequired}` : ""}`;
}

function directAliasCollisionNotice(collisions: readonly OpenCodeDirectAliasCollision[]): string[] {
  if (!collisions.length) return [];
  const shown = collisions.slice(0, 3).map(({ alias }) => `/${alias}`).join(", ");
  const excess = collisions.length > 3 ? ` +${collisions.length - 3} more` : "";
  return [
    oneTerminalLine(`! Harbor direct alias${collisions.length === 1 ? "" : "es"} unavailable: ${shown}${excess}. Foreign commands are preserved.`),
    "  Do not invoke those aliases as Agent Harbor; use native selection or team-lead instead.",
  ];
}

function openCodeWorkHelp(collisions: readonly OpenCodeDirectAliasCollision[]): string {
  if (!collisions.length) {
    return "Work: /<id> <task> · /team-lead <task> · /scout <need> · /contract <json> · stop in /team";
  }
  const unavailable = new Set(collisions.map(({ alias }) => alias));
  const controls = [
    "native agent selector",
    "uncollided /<id> aliases",
    ...(!unavailable.has("team-lead") ? ["team-lead"] : []),
    ...(!unavailable.has("scout") ? ["scout"] : []),
    "/contract <json>",
    "stop in /team",
  ];
  return `Work: ${controls.join(" · ")}`;
}

function stopSafety(snapshot: OpenCodeTeamSnapshot): string {
  return snapshot.activeAuthoritative
    ? "legacy + v2 inventories and project/ownership/turn recheck available"
    : snapshot.exactStopAvailable
      ? "global discovery bounded; exact shown-run recheck available, stop all disabled"
      : "unavailable; stop in the /team prompt is disabled";
}

function currentWarnings(snapshot: OpenCodeTeamSnapshot): string[] {
  const raw = [
    ...snapshot.degradedReasons.slice(0, maximumDiagnosticReasons),
    ...(snapshot.degradedReasons.length > maximumDiagnosticReasons
      ? [`Diagnostic input exceeded the ${maximumDiagnosticReasons}-reason safety bound; excess host diagnostics were omitted.`]
      : []),
    ...(snapshot.sessionListTruncated ? [`Session history was bounded to ${maximumOpenCodeSessions}; older inactive sessions were omitted.`] : []),
    ...(snapshot.activeListTruncated ? [`Global active-session discovery exceeded ${maximumOpenCodeActiveSessions}; stop all is disabled${snapshot.exactStopAvailable ? ", while exact shown-run stop remains available after a final target recheck" : ""}.`] : []),
    ...(snapshot.messageFanoutTruncated ? [`Message inspection was bounded to ${maximumOpenCodeMessageSessions} sessions × ${maximumOpenCodeMessagesPerSession} messages.`] : []),
  ];
  const sanitized = raw.flatMap((reason) => {
    const value = openCodePublicLabel(reason, maximumDiagnosticReasonCharacters + 1);
    if (!value) return [];
    const points = [...value];
    return [points.length > maximumDiagnosticReasonCharacters
      ? `${points.slice(0, maximumDiagnosticReasonCharacters - 12).join("")}… [bounded]`
      : value];
  });
  if (!snapshot.activeAuthoritative && !sanitized.length) {
    sanitized.push("Active-work authority is unavailable; total activity and teammate availability cannot be confirmed.");
  }
  return [...new Set(sanitized)];
}

function diagnosticRepair(reason: string): string {
  if (/Session history was bounded/iu.test(reason)) {
    return "Repair: none for active authority; older inactive history is intentionally omitted from this live view.";
  }
  if (/cleanup|orphan|delete/iu.test(reason)) {
    return "Repair: complete the named cleanup inspection, then reload OpenCode and rerun /team diagnostics.";
  }
  if (/roster|definition|collision/iu.test(reason)) {
    return "Repair: restore roster storage or resolve the reported definition conflict, reload OpenCode, then rerun diagnostics.";
  }
  if (/tampered|unsigned|provenance/iu.test(reason)) {
    return "Repair: restart the affected Harbor work with the current extension, then rerun /team diagnostics.";
  }
  if (/message|usage|telemetry|numeric/iu.test(reason)) {
    return "Repair: retry after host telemetry recovers; keep task, token, model, and cost fields unobserved until then.";
  }
  if (/bounded|exceeded|truncated|omitted/iu.test(reason)) {
    return "Repair: narrow /team by member or run; recover the host inventory before relying on global absence or stop all.";
  }
  return "Repair: recover the reported OpenCode inventory/owner authority, then rerun /team diagnostics before delegating.";
}

function oneTerminalLine(value: string): string {
  const [prefix, remainder] = takeTerminalColumns(value, terminalLineWidth - 1);
  return remainder ? `${prefix}…` : value;
}

function boundView(
  lines: readonly string[],
  clippingNotice = "… view clipped to the 30-line dialog budget; narrow with /team member:<id> or run:<id>.",
): string {
  let wrapped = wrapPlainLines(lines);
  if (wrapped.length > maximumOpenCodeTeamDialogLines) {
    const noticeLines = wrapPlainLines([
      `Rendered lines 1–${Math.max(0, maximumOpenCodeTeamDialogLines - 2)} of ${wrapped.length}. ${clippingNotice}`,
    ]).slice(0, 2);
    wrapped = [
      ...wrapped.slice(0, Math.max(0, maximumOpenCodeTeamDialogLines - noticeLines.length)),
      ...noticeLines,
    ];
  }
  const rendered = wrapped.join("\n");
  const points = [...rendered];
  if (points.length <= maximumOpenCodeTeamViewCharacters) return rendered;
  const prefix = points.slice(0, maximumOpenCodeTeamViewCharacters - 120).join("");
  const boundary = prefix.lastIndexOf("\n");
  return `${boundary > 0 ? prefix.slice(0, boundary) : prefix}\n… view truncated; use /team with a narrower filter.`;
}

/** Defensive final boundary for every OpenCode alert/error surface. */
export function boundOpenCodeDialogText(
  value: string,
  clippingNotice = "Use the command's page/filter route to inspect omitted content.",
): string {
  return boundView(value.split(/\r?\n/gu), clippingNotice);
}

function boundViewWithFooter(
  lines: readonly string[],
  footer: string | readonly string[],
  clippingNotice = "… stop details clipped to the 30-line dialog budget; run /team before retrying unresolved work.",
): string {
  const footerLines = wrapPlainLines(["", ...(typeof footer === "string" ? [footer] : footer)])
    .slice(0, maximumOpenCodeTeamDialogLines);
  const bodyBudget = Math.max(0, maximumOpenCodeTeamDialogLines - footerLines.length);
  let bodyLines = wrapPlainLines(lines);
  if (bodyLines.length > bodyBudget) {
    const originalBodyLines = bodyLines.length;
    const noticeLines = wrapPlainLines([
      `Rendered body lines 1–${Math.max(0, bodyBudget - 2)} of ${originalBodyLines}. ${clippingNotice}`,
    ]).slice(0, Math.min(2, bodyBudget));
    const semanticOmissions = wrapPlainLines(lines.filter((line) =>
      /^\+\d+ (?:roster matches|active entries) hidden;/u.test(line)));
    const reservedTail = [...semanticOmissions, ...noticeLines].slice(0, bodyBudget);
    const nonSemanticBody = wrapPlainLines(lines.filter((line) =>
      !/^\+\d+ (?:roster matches|active entries) hidden;/u.test(line)));
    bodyLines = [
      ...nonSemanticBody.slice(0, Math.max(0, bodyBudget - reservedTail.length)),
      ...reservedTail,
    ];
  }
  return [...bodyLines, ...footerLines].slice(0, maximumOpenCodeTeamDialogLines).join("\n");
}

/** Renders roster, active hierarchy, observed telemetry, and operational limits. */
export function formatOpenCodeTeamView(snapshot: OpenCodeTeamSnapshot, filterInput = ""): string {
  const request = parseTeamViewRequest(filterInput);
  const filter = request.filter.toLowerCase();
  const telemetryFilter = activeTelemetryFilterCompleteness(snapshot, filter);
  const aliasCollisionsByAgent = new Map(snapshot.directAliasCollisions.map(({ agent, alias }) => [agent, alias]));
  const hostModel = snapshot.hostDefaultModel
    ? `provider=${quotedPublic(snapshot.hostDefaultModel.provider)} · model=${quotedPublic(snapshot.hostDefaultModel.id)}${snapshot.hostDefaultModel.contextLimit === undefined ? "" : ` · context ${formatCount(snapshot.hostDefaultModel.contextLimit)}`}${snapshot.hostDefaultModel.outputLimit === undefined ? "" : ` · max output ${formatCount(snapshot.hostDefaultModel.outputLimit)}`}`
    : "unobserved";
  const project = quotedPublic(openCodePublicIdentifier(snapshot.projectName, 80) ?? "project");
  const activity = new Map<string, OpenCodeTeamRunSnapshot["state"] | OpenCodeTeamReservationSnapshot["phase"]>([
    ...snapshot.reservations.map(({ agent, phase }) => [agent, phase] as const),
    ...snapshot.runs.filter(({ kind }) => kind !== "contractor").map(({ agent, state }) => [agent, state] as const),
  ]);
  const members = snapshot.members.filter((entry) =>
    memberMatches(entry, filter, activity.get(entry.id) ?? entry.availability, snapshot.activeAuthoritative));
  const runs = snapshot.runs.filter((entry) => runMatches(entry, filter));
  const reservations = snapshot.reservations.filter((entry) => reservationMatches(entry, filter));
  const warnings = currentWarnings(snapshot);
  if (!members.length && !runs.length && !reservations.length) {
    const shown = openCodePublicLabel(request.filter, 80) ?? "the requested filter";
    const safetyWarning = warnings.find((warning) => /cleanup|stop|authorized|provenance/iu.test(warning)) ?? warnings[0];
    if (telemetryFilter?.unknownCount) {
      const field = telemetryFilter.field;
      const count = telemetryFilter.unknownCount;
      return boundView([
        `Agent Harbor OpenCode team · project=${project} · 0 model tokens${snapshot.activeAuthoritative ? "" : " · degraded"}`,
        snapshot.activeAuthoritative
          ? `Team: ${snapshot.runs.length + snapshot.reservations.length} active · telemetry-filter result incomplete`
          : "Overall Team: visible activity is a lower bound · teammate availability unverified",
        `Host default model: ${hostModel}`,
        `Stop safety: ${stopSafety(snapshot)}`,
        ...(safetyWarning ? [oneTerminalLine(`! ${safetyWarning}`)] : []),
        "",
        field === "task"
          ? `No observed public task label matches “${shown}”.`
          : field === "model"
            ? `No configured roster model or observed active model matches “${shown}”.`
            : `No disclosed roster field, public task label, or observed model matches “${shown}”.`,
        `This is not a proven no-match: ${count} active entr${count === 1 ? "y has" : "ies have"} ${field} telemetry unobserved, so the filter is incomplete.`,
        ...(field !== "model"
          ? ["Privacy: task filters search only redacted public labels; private task content is never searched."]
          : []),
        "Action: run /team with no filter to identify unobserved rows; retry after host telemetry recovers.",
        "Filter help: /team help",
      ]);
    }
    if (!snapshot.activeAuthoritative) {
      return boundView([
        `Agent Harbor OpenCode team · project=${project} · 0 model tokens · degraded`,
        "Overall Team: visible activity is a lower bound · teammate availability unverified",
        `Host default model: ${hostModel}`,
        `Stop safety: ${stopSafety(snapshot)}`,
        ...(safetyWarning ? [oneTerminalLine(`! ${safetyWarning}`)] : []),
        ...(warnings.length > 1 ? [`! +${warnings.length - 1} more current warning${warnings.length === 2 ? "" : "s"}; use /team diagnostics for every reason and repair step.`] : []),
        "",
        `No visible team member or activity record matches “${shown}”.`,
        "Discovery is degraded, so this result does not prove absence, idleness, readiness, or delegability.",
        "Repair: run /team diagnostics, follow its recovery steps, then retry this filter.",
        "Filter help: /team help",
      ]);
    }
    return boundView([
      `Agent Harbor OpenCode team · project=${project} · 0 model tokens`,
      `Host default model: ${hostModel}`,
      `No team member or active work matches “${shown}”.`,
      "Try /team with no filter, or search by member, role/kind, status/state, capability, tool, skill, model, task, run, or mode.",
      "Examples: status:bench · tool:edit · member:crafter · mode:delegated · task:release",
    ]);
  }

  const working = new Set([
    ...snapshot.runs.filter(({ kind }) => kind !== "contractor").map(({ agent }) => agent),
    ...snapshot.reservations.map(({ agent }) => agent),
  ]);
  const ready = snapshot.members.filter(({ availability, id }) => availability === "ready" && !working.has(id)).length;
  const reloadRequired = snapshot.members.filter(({ availability, id }) =>
    availability === "reload-required" && !working.has(id)).length;
  const benched = snapshot.members.filter(({ availability }) => availability === "bench").length;
  const unhealthy = snapshot.members.filter(({ availability }) =>
    availability === "stale" || availability === "conflict" || availability === "unavailable").length;
  const detailed = Boolean(filter) && members.length + runs.length + reservations.length <= 2;
  const activityEntries = [
    ...runs.map((run) => ({ type: "run" as const, run })),
    ...reservations.map((reservation) => ({ type: "reservation" as const, reservation })),
  ];
  const historyNotice = warnings.find((warning) => /Session history was bounded/iu.test(warning));
  const degradedWarnings = warnings.filter((warning) => warning !== historyNotice);
  const viewDegraded = !snapshot.activeAuthoritative || degradedWarnings.length > 0;
  const safetyWarning = degradedWarnings.find((warning) => /cleanup|stop|authorized|provenance/iu.test(warning))
    ?? degradedWarnings[0] ?? historyNotice;
  const teamSummary = snapshot.activeAuthoritative
    ? `${filter ? "Overall Team" : "Team"}: ${ready} ready/invocable${reloadRequired ? ` · ${reloadRequired} enabled/reload required` : ""} · ${snapshot.runs.length + snapshot.reservations.length} active · ${benched} benched · ${unhealthy} unhealthy`
    : `${filter ? "Overall Team" : "Team"}: ≥${snapshot.runs.length + snapshot.reservations.length} visible activity record${snapshot.runs.length + snapshot.reservations.length === 1 ? "" : "s"} (lower bound) · availability unverified · roster ${snapshot.members.length} visible / ${benched} marked bench / ${unhealthy} issues`;
  const factoryMemberCount = members.filter(({ kind }) => kind !== "personal").length;
  const memberPageSize = request.section === "activity" ? 0
    : request.section === "roster" ? 12
      : detailed ? 1
        : filter ? 4 : Math.min(12, Math.max(4, factoryMemberCount));
  const activityPageSize = request.section === "roster" ? 0
    : request.section === "activity" ? 4 : 1;
  const memberPages = memberPageSize ? Math.ceil(members.length / memberPageSize) : 0;
  const activityPages = activityPageSize ? Math.ceil(activityEntries.length / activityPageSize) : 0;
  const totalPages = Math.max(1, memberPages, activityPages);
  if (request.page > totalPages) {
    const route = request.section === "combined" ? "/team [filter] page:<n>" : `/team ${request.section} <page>`;
    return boundView([
      `Agent Harbor OpenCode team · project=${project} · 0 model tokens`,
      `Page ${request.page} is unavailable; choose page 1–${totalPages}.`,
      `Route: ${route}`,
    ]);
  }
  const memberStart = memberPageSize * (request.page - 1);
  const activityStart = activityPageSize * (request.page - 1);
  const shownMembers = memberPageSize ? members.slice(memberStart, memberStart + memberPageSize) : [];
  const shownActivity = activityPageSize
    ? activityEntries.slice(activityStart, activityStart + activityPageSize)
    : [];
  const shownRuns = shownActivity.filter((entry) => entry.type === "run").map((entry) => entry.run);
  const shownReservations = shownActivity
    .filter((entry) => entry.type === "reservation")
    .map((entry) => entry.reservation);
  const baseRoute = request.section === "combined"
    ? `/team${request.filter ? ` ${request.filter}` : ""}`
    : `/team ${request.section}`;
  const footer = [
    `Page ${request.page}/${totalPages}${request.page < totalPages ? ` · next: ${baseRoute}${request.section === "combined" ? ` page:${request.page + 1}` : ` ${request.page + 1}`}` : " · complete enumeration"}`,
    "Pages: /team roster|activity|history|diagnostics [page]",
    "Inspect: /team member:<id> · /team run:<run-id> · filters: status:idle · owner:<locator>",
    openCodeWorkHelp(snapshot.directAliasCollisions),
    "Roster: /bench-list|on|off · /harbor-join|retire · catalog: /harbor-list-skills",
    "Privacy: active-only, bounded, redacted metadata; PID and assistant text are never displayed.",
  ];
  const lines = [
      `Agent Harbor OpenCode team · project=${project} · 0 model tokens${viewDegraded ? " · degraded" : historyNotice ? " · bounded history" : ""}`,
      teamSummary,
      `Host default model: ${hostModel}`,
      `Stop safety: ${stopSafety(snapshot)}`,
      compactLeadAccess(snapshot.members, snapshot.runs, snapshot.reservations, snapshot.activeAuthoritative, snapshot.directAliasCollisions),
      ...(detailed && shownMembers.some(({ id }) => aliasCollisionsByAgent.has(id))
        ? []
        : directAliasCollisionNotice(snapshot.directAliasCollisions)),
      ...(telemetryFilter?.unknownCount ? [oneTerminalLine(
        `i ${telemetryFilter.field === "task" ? "Task" : telemetryFilter.field === "model" ? "Model" : "Text"} filter incomplete: ${telemetryFilter.unknownCount} active entr${telemetryFilter.unknownCount === 1 ? "y has" : "ies have"} unobserved ${telemetryFilter.field}; inspect unfiltered /team.`,
      )] : []),
      ...(safetyWarning ? [oneTerminalLine(`${viewDegraded ? "!" : "i"} ${safetyWarning}`)] : []),
      ...(warnings.length > 1 ? [`! +${warnings.length - 1} more current warning${warnings.length === 2 ? "" : "s"}; use /team diagnostics for every reason and repair step.`] : []),
      ...(request.section === "activity" ? [] : [
      "",
      `ROSTER · ${detailed ? "DETAILS" : "COMPACT"} · rows ${shownMembers.length ? `${memberStart + 1}–${memberStart + shownMembers.length}` : "0"} of ${members.length}${filter ? ` · filtered` : ""}`,
      ...(shownMembers.length
        ? detailed
          ? renderRoster(shownMembers, activity, snapshot.activeAuthoritative, aliasCollisionsByAgent)
          : renderCompactRoster(shownMembers, activity, snapshot.activeAuthoritative, aliasCollisionsByAgent)
        : members.length
          ? []
          : [telemetryFilter?.field === "task"
            ? "Task filters apply to sanitized active task labels; roster members have no task field."
            : snapshot.activeAuthoritative
              ? "No roster member matches this filter."
              : "No visible roster member matches this filter; roster completeness and availability are unverified."]),
      ]),
      ...(request.section === "roster" ? [] : [
      "",
      `ACTIVITY · ${detailed ? "DETAILS" : "COMPACT"} · rows ${shownActivity.length ? `${activityStart + 1}–${activityStart + shownActivity.length}` : "0"} of ${activityEntries.length}`,
      ...(!shownActivity.length
        ? activityEntries.length
          ? [`No activity row falls on page ${request.page}; use /team activity 1–${Math.max(1, activityPages)}.`]
          : [snapshot.activeAuthoritative
            ? telemetryFilter?.unknownCount
              ? `No observed active ${telemetryFilter.field} match; ${telemetryFilter.unknownCount} active entr${telemetryFilter.unknownCount === 1 ? "y is" : "ies are"} unobserved, so this filter is incomplete.`
              : snapshot.runs.length || snapshot.reservations.length
                ? "No active work matches this filter."
                : "No Agent Harbor teammate is working right now."
            : snapshot.runs.length || snapshot.reservations.length
              ? "No visible activity matches this filter; degraded discovery cannot confirm absence or idleness."
              : "No verified active work is visible; degraded discovery cannot confirm absence, idleness, or availability."]
        : detailed
          ? [
              ...(shownRuns.length ? renderActivity(shownRuns, snapshot.runs.length > 0) : []),
              ...renderReservationActivity(shownReservations),
            ]
          : shownActivity.flatMap((entry) => entry.type === "run"
            ? compactActivityLines(entry.run)
            : [compactReservationLine(entry.reservation)])),
      ]),
    ];
  return boundViewWithFooter(lines, footer,
  `Use ${baseRoute}${request.section === "combined" ? ` page:${Math.min(totalPages, request.page + 1)}` : ` ${Math.min(totalPages, request.page + 1)}`} for the next deterministic page.`);
}

/** Renders every current sanitized warning and a recovery action through bounded pages. */
export function formatOpenCodeTeamDiagnostics(snapshot: OpenCodeTeamSnapshot, requestedPage = 1): string {
  const warnings = currentWarnings(snapshot);
  const entryLines = warnings.map((reason, index) => wrapPlainLines([
    `${index + 1}. Reason: ${reason}`,
    `   ${diagnosticRepair(reason)}`,
  ]));
  const pages: string[][] = [];
  let page: string[] = [];
  for (const entry of entryLines) {
    if (page.length && page.length + entry.length > diagnosticBodyLineBudget) {
      pages.push(page);
      page = [];
    }
    page.push(...entry.slice(0, diagnosticBodyLineBudget));
  }
  if (page.length || !pages.length) pages.push(page);
  const pageNumber = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
  const selected = pages[pageNumber - 1];
  const project = openCodePublicIdentifier(snapshot.projectName, 80) ?? "project";
  if (!selected) {
    return boundView([
      `Agent Harbor OpenCode diagnostics · ${project} · 0 model tokens`,
      `Diagnostic page ${pageNumber} is unavailable; choose page 1–${pages.length}.`,
      `Run /team diagnostics${pages.length > 1 ? " <page>" : ""}.`,
    ], "… diagnostics clipped; request a specific /team diagnostics <page>.");
  }
  const firstReason = pages.slice(0, pageNumber - 1).reduce((total, entries) =>
    total + entries.filter((line) => /^\d+\. Reason:/u.test(line)).length, 0) + 1;
  const shownReasons = selected.filter((line) => /^\d+\. Reason:/u.test(line)).length;
  const lastReason = Math.min(warnings.length, firstReason + Math.max(0, shownReasons - 1));
  const authority = snapshot.activeAuthoritative
    ? "authoritative active-work discovery"
    : "DEGRADED · activity totals and teammate availability/delegability are unverified";
  return boundView([
    `Agent Harbor OpenCode diagnostics · ${project} · 0 model tokens`,
    `Authority: ${authority}`,
    warnings.length
      ? `Page ${pageNumber}/${pages.length} · reasons ${firstReason}–${lastReason} of ${warnings.length}`
      : "No current diagnostic warnings; active-work authority is healthy.",
    "",
    ...selected,
    ...(warnings.length ? [
      "",
      pages.length > 1
        ? `Pages: /team diagnostics <1-${pages.length}>${pageNumber < pages.length ? ` · next /team diagnostics ${pageNumber + 1}` : ""}`
        : "All current sanitized reasons and repair steps are shown.",
      "After repair, rerun /team; rely on ready/idle/delegation claims only when authority is healthy.",
    ] : []),
  ], "… diagnostics clipped; request a specific /team diagnostics <page>.");
}

/** Static help is available even when every OpenCode RPC is unavailable. */
export function formatOpenCodeTeamHelp(
  directAliasCollisions: readonly OpenCodeDirectAliasCollision[] = [],
  requestedPage = 1,
): string {
  const unavailableAliases = new Set(directAliasCollisions.map(({ alias }) => alias));
  const directHelp = directAliasCollisions.length ? [
    "Do not invoke foreign Harbor aliases; use native selection or only aliases marked available by /team.",
    unavailableAliases.has("team-lead")
      ? "Lead: select team-lead natively; its foreign /team-lead alias is unavailable · max 6 sequential."
      : "/team-lead <task>: one lead plus at most six teammates sequentially.",
    unavailableAliases.has("scout")
      ? "Scout: select talent-scout natively; foreign /scout is unavailable · /contract creates one child."
      : "/scout <need>: one recruiter root · /contract <json>: exactly one disposable child.",
  ] : [
    "A ready · invocable teammate can run with /<id> <task> in the current session.",
    "/team-lead <task>: one lead plus at most six teammates sequentially.",
    "/scout <need>: one recruiter root · /contract <json>: exactly one disposable child.",
  ];
  // Keep schemas and their explanation on the same deterministic help page;
  // slicing one flattened line stream previously separated a heading from the
  // JSON users needed to copy.
  const pageTopics = [
    [
      "View: empty /team shows the current team and work. Deterministic pages expose exact row ranges.",
      "Pages: /team roster [page] · /team activity [page] · /team history [page] · /team diagnostics [page]",
      "Filters: member, kind/role, status/state, capability, tool, skill, model, task, run, mode, owner.",
      "Exact examples: /team status:idle · /team owner:owner-abc · /team status:bench page:2",
      "Unknown or empty structured fields are rejected. PID and reasoning filters are unavailable by design.",
      ...directHelp,
      "Stop: enter stop <run-id> (a unique visible prefix works) or stop all in the /team prompt.",
      "Stop fails closed after engine, project, generation, owner, and turn rechecks.",
      "Discovery overflow disables stop all; an exact shown run may survive its own recheck.",
      "OpenCode has no atomic compare-and-stop API; a small residual host race remains.",
    ],
    [
      "Roster controls (0-token): /bench-list · /bench-on · /bench-off · /harbor-join · /harbor-retire",
      "Bench `all` changes only the six bundled SDLC members; personal members remain unchanged.",
      "Join JSON (copy this complete line):",
      "{\"name\":\"reviewer\",\"description\":\"Review\",\"prompt\":\"Review\",\"tools\":[\"read\"]}",
      "Optional join fields: skills, model, and replace. Use replace:true only for the same owned personal ID.",
      "Contract JSON (copy this complete line; exactly one disposable model child):",
      "{\"name\":\"reviewer\",\"description\":\"Review\",\"prompt\":\"Review\",\"tools\":[\"read\"],\"task\":\"Audit\"}",
      "Catalog: /harbor-list-skills · /harbor-filter-skills accepts -d|--descriptions, filter, --page N.",
      "Enabled · reload required is visible to 0-token controls but cannot run natively or via team-lead.",
      "Reload OpenCode after join/replace/enable before invocation; stale definitions always fail closed.",
    ],
    [
      "History is active-only. OpenCode exposes no reliable terminal mission history; no completion is invented.",
      "Telemetry is observed only. Counts and nonzero costs use the exact JavaScript numeric value received.",
      "A ≥ marker means partial/page-bounded data; explicit zero remains observed, never absent.",
      "Capacity: at most 32 enabled model-facing specialists and 6 sequential teammate calls per lead.",
      "Those are roster/concurrency gates, not a hard per-run token cap.",
      "Disposable-root/create reconciliation capacity is 32; it is separate from roster and cleanup counts.",
      `Runtime scan: ${maximumOpenCodeSessions} sessions · ${maximumOpenCodeActiveSessions} active · ${maximumOpenCodeMessageSessions} message pages × ${maximumOpenCodeMessagesPerSession} messages.`,
      `Roster preflight: at most ${maximumOpenCodeRosterRecords} records and ${maximumOpenCodeRosterSnapshotBytes} UTF-8 bytes (16 KiB).`,
    ],
  ];
  const pages = pageTopics.map((topics) => wrapPlainLines(topics));
  const page = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 0;
  if (!page || !pages[page - 1]) {
    return boundView([
      "Agent Harbor OpenCode /team help · 0 model tokens",
      `Help page ${requestedPage} is unavailable; choose page 1–${pages.length}.`,
      "Route: /team help [page]",
    ]);
  }
  return boundViewWithFooter([
    "Agent Harbor OpenCode /team help · 0 model tokens",
    `Page ${page}/${pages.length} · topics ${page === pages.length ? "complete on this page" : "continue on the next page"}`,
    "",
    ...pages[page - 1],
  ], [
    `Help pages: /team help <1-${pages.length}>${page < pages.length ? ` · next /team help ${page + 1}` : " · complete"}`,
    "Privacy: task labels redact paths, URLs, credentials, and controls; assistant text and PID are never retained for display.",
  ], "Use /team help <page> to enumerate every help topic.");
}

/** Formats a bounded stop outcome without echoing native errors or hidden session content. */
export function formatOpenCodeStopResult(result: OpenCodeTeamStopResult, footer?: string): string {
  const pending = result.pendingChildIdentity ?? [];
  const otherProcess = result.ownedByAnotherProcess ?? [];
  const unavailable = result.claimIdentityUnavailable ?? [];
  const ownershipUnavailable = result.ownershipUnavailable ?? [];
  const stale = result.staleOwnerHeartbeat ?? [];
  const transition = result.lifecycleTransition ?? [];
  const nativePending = result.nativeRunPending ?? [];
  const engineAuthority = result.engineAuthorityUnavailable ?? [];
  const confirmation = result.pendingConfirmation ?? [];
  const lines = [
    "Agent Harbor OpenCode stop · 0 model tokens",
    result.stopped.length ? `Stop confirmed: ${result.stopped.join(", ")}` : "Stop confirmed: none",
    ...(result.alreadyIdle.length ? [`Already idle before the final recheck: ${result.alreadyIdle.join(", ")}`] : []),
    ...(result.failed.length ? [`Stop not confirmed: ${result.failed.join(", ")}. Run /team before retrying.`] : []),
    ...(confirmation.length ? [`Stop request still pending: ${confirmation.join(", ")}. Do not retry it; run /team after the host request settles.`] : []),
    ...(pending.length ? [`Pending child identity: ${pending.join(", ")}; no stop was attempted for this lifecycle. Retry shortly.`] : []),
    ...(otherProcess.length ? [`Owned by another OpenCode process: ${otherProcess.join(", ")}. Stop it from that process.`] : []),
    ...(unavailable.length ? [`Ambiguous claim identity: ${unavailable.join(", ")}. No stop was attempted; inspect filesystem recovery state.`] : []),
    ...(ownershipUnavailable.length ? [`Native ownership changed during inspection: ${ownershipUnavailable.join(", ")}. No stop was attempted; refresh /team after agent/title state stabilizes.`] : []),
    ...(stale.length ? [`Owner heartbeat overdue: ${stale.join(", ")}. No stop was attempted; recover or restart the owning OpenCode process.`] : []),
    ...(transition.length ? [`Lifecycle is not stoppable yet: ${transition.join(", ")}. No stop was attempted while it is starting or cleaning.`] : []),
    ...(nativePending.length ? [`Native runner not currently visible: ${nativePending.join(", ")}. Lifecycle state is still reconciling; no stop was attempted. Run /team again after it settles.`] : []),
    ...(engineAuthority.length ? [`OpenCode engine authority changed or is ambiguous: ${engineAuthority.join(", ")}. The target appeared in the non-owning engine; no stop was attempted. Refresh /team after engine state stabilizes.`] : []),
    ...(!result.stopped.length && !result.alreadyIdle.length && !result.failed.length && !confirmation.length && !pending.length && !otherProcess.length && !unavailable.length && !ownershipUnavailable.length && !stale.length && !transition.length && !nativePending.length && !engineAuthority.length
      ? ["No verified active Agent Harbor run matched the request; no stop was requested."] : []),
  ];
  return footer ? boundViewWithFooter(lines, footer) : boundView(lines);
}
