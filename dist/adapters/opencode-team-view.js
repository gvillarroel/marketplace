/** Human-readable, bounded rendering for OpenCode's deterministic team snapshot. */
import { takeTerminalColumns, terminalLineWidth, wrapPlainLines } from "../core/text-layout.js";
import { scoutPlayer } from "../core/defaults.js";
import { maximumOpenCodeActiveSessions, maximumOpenCodeMessagesPerSession, maximumOpenCodeMessageSessions, maximumOpenCodeSessions, maximumVisibleOpenCodeRosterMembers, openCodePublicIdentifier, } from "./opencode-team-runtime.js";
const maximumOpenCodeTeamViewCharacters = 24_000;
export const maximumOpenCodeTeamDialogLines = 30;
const maximumCompactRosterRows = 10;
const maximumCompactActivityRows = 3;
const filterFields = new Map([
    ["id", "member"], ["member", "member"], ["role", "kind"], ["kind", "kind"],
    ["state", "status"], ["status", "status"], ["capability", "capability"],
    ["tool", "tool"], ["skill", "skill"], ["model", "model"], ["task", "task"],
    ["run", "run"], ["mode", "mode"], ["invocation", "mode"],
]);
function parseFilter(filter) {
    const separator = filter.indexOf(":");
    if (separator < 0)
        return { value: filter };
    const field = filterFields.get(filter.slice(0, separator).trim());
    return field ? { field, value: filter.slice(separator + 1).trim() } : { value: filter };
}
function includes(values, value) {
    return Boolean(value) && values.some((candidate) => candidate?.toLowerCase().includes(value));
}
function equals(values, value) {
    return Boolean(value) && values.some((candidate) => candidate?.toLowerCase() === value);
}
function availabilityTerms(availability) {
    if (availability === "ready")
        return ["ready", "invocable"];
    if (availability === "reload-required")
        return ["reload-required", "reload required", "enabled"];
    return [availability];
}
function memberStatusTerms(member, effectiveStatus) {
    return effectiveStatus === member.availability ? availabilityTerms(member.availability) : [effectiveStatus];
}
function memberMatches(member, filter, effectiveStatus = member.availability) {
    if (!filter)
        return true;
    const query = parseFilter(filter);
    const statuses = memberStatusTerms(member, effectiveStatus);
    if (query.field === "member")
        return includes([member.id], query.value);
    if (query.field === "kind")
        return equals([member.kind], query.value);
    if (query.field === "status")
        return equals(statuses, query.value);
    if (query.field === "capability")
        return includes([member.capacity], query.value);
    if (query.field === "tool")
        return includes(member.tools, query.value);
    if (query.field === "skill")
        return includes(member.skills, query.value);
    if (query.field === "model")
        return includes([member.configuredModel], query.value);
    if (query.field)
        return false;
    return includes([
        member.id, member.description, member.capacity, member.configuredModel, ...member.tools, ...member.skills,
    ], query.value) || equals([member.kind, ...statuses], query.value);
}
function reservationMatches(reservation, filter) {
    if (!filter)
        return true;
    const query = parseFilter(filter);
    if (query.field === "member")
        return includes([reservation.agent], query.value);
    if (query.field === "status")
        return equals([reservation.phase], query.value);
    if (query.field === "mode")
        return equals([reservation.invocation], query.value);
    if (query.field)
        return false;
    return includes([reservation.agent], query.value)
        || equals([reservation.phase, reservation.invocation], query.value);
}
function runMatches(run, filter) {
    if (!filter)
        return true;
    const query = parseFilter(filter);
    const model = run.model ? `${run.model.provider}/${run.model.id}${run.model.variant ? `@${run.model.variant}` : ""}` : undefined;
    if (query.field === "member")
        return includes([run.agent], query.value);
    if (query.field === "kind")
        return equals([run.kind], query.value);
    if (query.field === "status")
        return equals([run.state], query.value);
    if (query.field === "model")
        return includes([model], query.value);
    if (query.field === "task")
        return includes([run.task], query.value);
    if (query.field === "run")
        return includes([run.id], query.value);
    if (query.field === "mode")
        return equals([run.invocation], query.value);
    if (query.field)
        return false;
    return includes([run.agent, run.task, run.id, model], query.value)
        || equals([run.kind, run.state, run.invocation], query.value);
}
function formatElapsed(milliseconds) {
    const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
    if (seconds < 60)
        return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60)
        return `${minutes}m ${seconds % 60}s`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${minutes % 60}m`;
}
function formatCount(value) {
    return Math.floor(value).toLocaleString("en-US");
}
function formatUsage(usage, turns, scope, lowerBound, turnsLowerBound) {
    const marker = lowerBound ? "≥" : "";
    const values = [
        usage.input === undefined ? undefined : `input ${marker}${formatCount(usage.input)}`,
        usage.output === undefined ? undefined : `output ${marker}${formatCount(usage.output)}`,
        usage.reasoning === undefined ? undefined : `reasoning ${marker}${formatCount(usage.reasoning)}`,
        usage.cacheRead === undefined ? undefined : `cache read ${marker}${formatCount(usage.cacheRead)}`,
        usage.cacheWrite === undefined ? undefined : `cache write ${marker}${formatCount(usage.cacheWrite)}`,
        usage.cost === undefined ? undefined : `cost ${marker}$${usage.cost.toFixed(Math.min(6, usage.cost < 0.01 ? 6 : 4))}`,
    ].filter((value) => value !== undefined);
    const scopeLabel = scope === "session-total" ? "child session total" : "current turn";
    const prefix = turns === undefined
        ? []
        : [`assistant turns ${turnsLowerBound ? "≥" : ""}${formatCount(turns)}${turnsLowerBound ? " (page lower bound)" : ""}`];
    if (!values.length)
        return `${prefix.length ? `${prefix.join(" · ")} · ` : ""}usage and cost unobserved`;
    return `${scopeLabel} ${lowerBound ? "lower bound" : "observed"} · ${[...prefix, ...values].join(" · ")}`;
}
function availabilitySymbol(member) {
    if (member.availability === "ready")
        return "●";
    if (member.availability === "reload-required")
        return "◐";
    if (member.availability === "bench")
        return "○";
    return "!";
}
function availabilityLabel(availability) {
    if (availability === "ready")
        return "ready · invocable";
    if (availability === "reload-required")
        return "enabled · reload required";
    return availability;
}
function renderRoster(members, activity) {
    return members.flatMap((member) => {
        const description = openCodePublicIdentifier(member.description, 500) ?? "Description unavailable";
        const capacity = openCodePublicIdentifier(member.capacity, 500) ?? "unavailable";
        const configuredModel = openCodePublicIdentifier(member.configuredModel, 200);
        const activeState = activity.get(member.id);
        const state = activeState ?? availabilityLabel(member.availability);
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
            `${availabilitySymbol(member)} ${member.id}${member.id === scoutPlayer.name ? " (/scout)" : ""} · ${member.kind} · ${state}`,
            `  ${description}`,
            `  Capacity: ${capacity} · model: ${configuredModel ? `configured ${configuredModel}` : "inherits the OpenCode session when run"}`,
            ...repair,
        ];
    });
}
function renderCompactRoster(members, activity) {
    return members.map((member) => {
        const state = activity.get(member.id) ?? availabilityLabel(member.availability);
        return `${availabilitySymbol(member)} ${member.id}${member.id === scoutPlayer.name ? " (/scout)" : ""} · ${member.kind} · ${state}`;
    });
}
function renderActivity(runs, hasOtherActiveWork) {
    if (!runs.length)
        return [hasOtherActiveWork ? "No active work matches this filter." : "No Agent Harbor teammate is working right now."];
    return runs.flatMap((run) => {
        const model = run.model
            ? `${openCodePublicIdentifier(run.model.provider, 100) ?? "unknown"}/${openCodePublicIdentifier(run.model.id, 160) ?? "unknown"}${run.model.variant ? ` · variant ${openCodePublicIdentifier(run.model.variant, 100) ?? "unobserved"}` : ""} (observed)`
            : "model unobserved";
        const parent = run.parentRunId
            ? ` · parent ${run.parentRunId}${run.parentSource === "inferred" ? " (inferred from the only active lead)" : ""}`
            : "";
        return [
            `${run.parentRunId ? "↳" : "●"} ${run.agent} · run ${run.id}${parent} · ${run.invocation} · ${run.state} · roster ${run.rosterState ?? "unknown"} · ${formatElapsed(run.elapsedMs)}`,
            `  Task: “${run.task}”`,
            `  ${model} · ${formatUsage(run.usage, run.observedAssistantTurns, run.usageScope, run.telemetryLowerBound, run.observedAssistantTurnsLowerBound)}`,
        ];
    });
}
function renderReservationActivity(reservations) {
    return reservations.flatMap((reservation) => [
        `◐ ${reservation.agent} · ${reservation.invocation} lifecycle · ${reservation.phase} · ${formatElapsed(reservation.elapsedMs)}`,
        "  Native run telemetry is not yet verified; wait for a run ID before using stop.",
    ]);
}
function compactActivityLine(run) {
    return `${run.parentRunId ? "↳" : "●"} ${run.agent} · run ${run.id} · ${run.invocation} · ${run.state} · ${formatElapsed(run.elapsedMs)}`;
}
function compactReservationLine(reservation) {
    return `◐ ${reservation.agent} · ${reservation.invocation} lifecycle · ${reservation.phase} · ${formatElapsed(reservation.elapsedMs)}`;
}
function compactLeadAccess(members, runs, reservations) {
    const busyIDs = new Set([
        ...runs.filter(({ kind }) => kind !== "contractor").map(({ agent }) => agent),
        ...reservations.map(({ agent }) => agent),
    ]);
    const specialists = members.filter((member) => member.kind !== "manager" && member.kind !== "utility" &&
        (member.availability === "ready" || member.availability === "reload-required"));
    const available = specialists.filter(({ id }) => !busyIDs.has(id)).length;
    const reloadRequired = members.filter((member) => member.kind !== "manager" && member.kind !== "utility" && member.availability === "reload-required").length;
    const bundled = members.filter(({ kind }) => kind === "bundled");
    const invocable = bundled.filter(({ availability }) => availability === "ready").length;
    const bundledReloadRequired = bundled.filter(({ availability }) => availability === "reload-required").length;
    return `Lead: ${available} available · ${specialists.length - available} busy${reloadRequired ? ` · ${reloadRequired} via live preflight until reload` : ""} · max 6 sequential · SDLC direct ${invocable}/${bundled.length}${bundledReloadRequired ? ` · pending reload ${bundledReloadRequired}` : ""}`;
}
function oneTerminalLine(value) {
    const [prefix, remainder] = takeTerminalColumns(value, terminalLineWidth - 1);
    return remainder ? `${prefix}…` : value;
}
function boundView(lines) {
    let wrapped = wrapPlainLines(lines);
    if (wrapped.length > maximumOpenCodeTeamDialogLines) {
        const notice = "… view clipped to fit a 45-row terminal; narrow with /team member:<id> or run:<id>.";
        const noticeLines = wrapPlainLines([notice]);
        wrapped = [
            ...wrapped.slice(0, Math.max(0, maximumOpenCodeTeamDialogLines - noticeLines.length)),
            ...noticeLines,
        ];
    }
    const rendered = wrapped.join("\n");
    const points = [...rendered];
    if (points.length <= maximumOpenCodeTeamViewCharacters)
        return rendered;
    const prefix = points.slice(0, maximumOpenCodeTeamViewCharacters - 120).join("");
    const boundary = prefix.lastIndexOf("\n");
    return `${boundary > 0 ? prefix.slice(0, boundary) : prefix}\n… view truncated; use /team with a narrower filter.`;
}
/** Renders roster, active hierarchy, observed telemetry, and operational limits. */
export function formatOpenCodeTeamView(snapshot, filterInput = "") {
    const filter = filterInput.trim().toLowerCase();
    const hostModel = snapshot.hostDefaultModel
        ? `${snapshot.hostDefaultModel.provider}/${snapshot.hostDefaultModel.id}${snapshot.hostDefaultModel.contextLimit === undefined ? "" : ` · context ${formatCount(snapshot.hostDefaultModel.contextLimit)}`}${snapshot.hostDefaultModel.outputLimit === undefined ? "" : ` · max output ${formatCount(snapshot.hostDefaultModel.outputLimit)}`}`
        : "unobserved";
    const activity = new Map([
        ...snapshot.reservations.map(({ agent, phase }) => [agent, phase]),
        ...snapshot.runs.filter(({ kind }) => kind !== "contractor").map(({ agent, state }) => [agent, state]),
    ]);
    const members = snapshot.members.filter((entry) => memberMatches(entry, filter, activity.get(entry.id) ?? entry.availability));
    const runs = snapshot.runs.filter((entry) => runMatches(entry, filter));
    const reservations = snapshot.reservations.filter((entry) => reservationMatches(entry, filter));
    if (!members.length && !runs.length && !reservations.length) {
        const shown = openCodePublicIdentifier(filterInput.trim(), 80) ?? "the requested filter";
        return boundView([
            `Agent Harbor OpenCode team · ${snapshot.projectName} · 0 model tokens`,
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
    const reloadRequired = snapshot.members.filter(({ availability, id }) => availability === "reload-required" && !working.has(id)).length;
    const benched = snapshot.members.filter(({ availability }) => availability === "bench").length;
    const unhealthy = snapshot.members.filter(({ availability }) => availability === "stale" || availability === "conflict" || availability === "unavailable").length;
    const warnings = [
        ...snapshot.degradedReasons,
        ...(snapshot.sessionListTruncated ? [`Session history was bounded to ${maximumOpenCodeSessions}; older inactive sessions were omitted.`] : []),
        ...(snapshot.activeListTruncated ? [`Global active-session discovery exceeded ${maximumOpenCodeActiveSessions}; stop all is disabled${snapshot.exactStopAvailable ? ", while exact shown-run stop remains available after a final target recheck" : ""}.`] : []),
        ...(snapshot.messageFanoutTruncated ? [`Message inspection was bounded to ${maximumOpenCodeMessageSessions} sessions × ${maximumOpenCodeMessagesPerSession} messages.`] : []),
    ];
    const detailed = Boolean(filter) && members.length + runs.length + reservations.length <= 2;
    const rosterLimit = detailed ? maximumVisibleOpenCodeRosterMembers : maximumCompactRosterRows;
    const shownMembers = members.slice(0, rosterLimit);
    const activityEntries = [
        ...runs.map((run) => ({ type: "run", run })),
        ...reservations.map((reservation) => ({ type: "reservation", reservation })),
    ];
    const shownActivity = detailed ? activityEntries : activityEntries.slice(0, maximumCompactActivityRows);
    const safetyWarning = warnings.find((warning) => /cleanup|stop|authorized|provenance/iu.test(warning)) ?? warnings[0];
    const lines = [
        `Agent Harbor OpenCode team · ${snapshot.projectName} · 0 model tokens${warnings.length ? " · degraded" : ""}`,
        `${filter ? "Overall Team" : "Team"}: ${ready} ready/invocable${reloadRequired ? ` · ${reloadRequired} enabled/reload required` : ""} · ${snapshot.runs.length + snapshot.reservations.length} active · ${benched} benched · ${unhealthy} unhealthy`,
        `Host default model: ${hostModel}`,
        `Stop safety: ${snapshot.activeAuthoritative
            ? "v2 active + project/ownership/direct-turn recheck available"
            : snapshot.exactStopAvailable ? "global discovery bounded; exact shown-run recheck available, stop all disabled"
                : "unavailable; stop in the /team prompt is disabled"}`,
        compactLeadAccess(snapshot.members, snapshot.runs, snapshot.reservations),
        ...(safetyWarning ? [oneTerminalLine(`! ${safetyWarning}`)] : []),
        ...(warnings.length > 1 ? [`! +${warnings.length - 1} more bounded warning${warnings.length === 2 ? "" : "s"}; use /team help and retry after host recovery.`] : []),
        "",
        `ROSTER · ${detailed ? "DETAILS" : "COMPACT"}${filter ? ` · ${members.length} match${members.length === 1 ? "" : "es"}` : " · use /team member:<id> for details"}`,
        ...(shownMembers.length
            ? detailed ? renderRoster(shownMembers, activity) : renderCompactRoster(shownMembers, activity)
            : ["No roster member matches this filter."]),
        ...(members.length > shownMembers.length
            ? [`+${members.length - shownMembers.length} roster matches hidden; narrow with /team member:<id>, kind:<kind>, or status:<state>.`]
            : []),
        "",
        `ACTIVITY · ${detailed ? "DETAILS" : "COMPACT"}`,
        ...(!shownActivity.length
            ? [snapshot.runs.length || snapshot.reservations.length
                    ? "No active work matches this filter."
                    : "No Agent Harbor teammate is working right now."]
            : detailed
                ? [
                    ...(runs.length ? renderActivity(runs, snapshot.runs.length > 0) : []),
                    ...renderReservationActivity(reservations),
                ]
                : shownActivity.map((entry) => entry.type === "run"
                    ? compactActivityLine(entry.run)
                    : compactReservationLine(entry.reservation))),
        ...(activityEntries.length > shownActivity.length
            ? [`+${activityEntries.length - shownActivity.length} active entries hidden; narrow with /team run:<id>, member:<id>, mode:<mode>, or status:<state>.`]
            : []),
        "",
        "Details: /team member:<id> · /team run:<run-id> · /team status:working · /team help",
        "Work actions: /<id> <task> · /team stop <run-id|all>",
        "Roster actions: /bench-on · /bench-off · /harbor-join · /harbor-retire",
        "Privacy: active-only, bounded, redacted metadata; assistant text is never displayed or retained.",
    ];
    return boundView(lines);
}
/** Static help is available even when every OpenCode RPC is unavailable. */
export function formatOpenCodeTeamHelp() {
    return boundView([
        "Agent Harbor OpenCode /team · 0 model tokens",
        "",
        "Enter an empty value for the compact whole-team view; it always includes the nine factory member IDs, kinds, and effective states, including unavailable during degraded inventory reads.",
        "Filter with plain text or field:value: member, kind/role, status/state, capability, tool, skill, model, task, run, or mode.",
        "Examples: status:bench · tool:edit · skill:zx-example-author · mode:delegated · run:run-AbCd1234",
        "Broad matches stay compact and announce hidden rows; member:<id> and run:<id> show rich detail.",
        "A ready · invocable teammate can run with /<id> <task> in the current session, with no routing prompt or extra parent-summary turn.",
        "Enabled · reload required means native selection and /<id> are stale. The lead can still use live preflight; reload for direct invocation.",
        "Set or update a personal model with /harbor-join JSON using model: \"provider/model\" and replace: true for an existing ID; reload applies the definition and exposes a new alias.",
        "",
        "Stop: enter stop <run-id> (a unique visible prefix works) or stop all in the /team prompt.",
        "Stop fails closed unless v2 active state, project, direct-turn agent/boundary, or signed child provenance is reverified immediately before each interrupt.",
        "If global discovery overflows, stop all is disabled; an exact shown run may remain available after its own recheck.",
        "OpenCode has no atomic compare-and-interrupt API; Agent Harbor minimizes the residual host window with get → verify → interrupt per target.",
        "",
        "Model, token, cost, context, and max-output are observations only: explicit zero is observed, absence is unobserved, and this is not a hard token cap.",
        "Agent Harbor limits: at most six teammates sequentially per lead turn and 32 disposable child lifecycles live or awaiting cleanup.",
        `Runtime bounds: ${maximumOpenCodeSessions} sessions · ${maximumOpenCodeActiveSessions} active · ${maximumOpenCodeMessageSessions} message pages × ${maximumOpenCodeMessagesPerSession} messages · ${maximumVisibleOpenCodeRosterMembers} roster records.`,
        "Privacy: task labels are 72-character path/URL/credential/control-redacted summaries; assistant content is never rendered.",
    ]);
}
/** Formats a bounded stop outcome without echoing native errors or hidden session content. */
export function formatOpenCodeStopResult(result) {
    const lines = [
        "Agent Harbor OpenCode stop · 0 model tokens",
        result.stopped.length ? `Interrupted: ${result.stopped.join(", ")}` : "Interrupted: none",
        ...(result.alreadyIdle.length ? [`Already idle before the final recheck: ${result.alreadyIdle.join(", ")}`] : []),
        ...(result.failed.length ? [`Interrupt failed or timed out: ${result.failed.join(", ")}. Run /team before retrying.`] : []),
        ...(!result.stopped.length && !result.alreadyIdle.length && !result.failed.length
            ? ["No verified active Agent Harbor run matched the request; no interrupt was requested."] : []),
    ];
    return boundView(lines);
}
