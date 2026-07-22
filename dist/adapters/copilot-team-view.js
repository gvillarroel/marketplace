/** Deterministic Copilot team inventory and project-shared persistent-player activity views. */
import { join, resolve } from "node:path";
import { loadManagedActivePlayer } from "../core/active.js";
import { formatHarborTeamRosterSnapshot } from "../core/custom-tools.js";
import { bundledPlayers, rolePlayers, scoutPlayer } from "../core/defaults.js";
import { isOwnedProfile, validatePlayer } from "../core/lifecycle.js";
import { decodePlayer, harnessSpec, isCanonicalPlayerProfile } from "../core/profiles.js";
import { publicErrorText, publicMetadataText } from "../core/public-metadata.js";
import { canonicalProjectIdentity } from "../core/project-identity.js";
import { readSafeBoundedProfile } from "../core/safe-profile.js";
import { takeTerminalColumns, terminalLineWidth, visibleTextWidth, wrapPlainLines } from "../core/text-layout.js";
import { runDeterministicCommand } from "./direct.js";
import { readSharedAgentActivities } from "./opencode-agent-activity.js";
import { defaultHome } from "./shared.js";
import { listCopilotActiveProfileIds, resolveCopilotPlayer, } from "./copilot-coordinator.js";
import { copilotPublicIdentifier, formatCopilotBilling, formatCopilotElapsed, formatCopilotMissionDetails, formatCopilotModel, formatCopilotNativeTelemetry, formatCopilotReasoning, formatCopilotRunDetails, formatCopilotTokenCount, formatCopilotUsage, copilotTaskLabel, } from "./copilot-team-runtime.js";
export const maximumVisibleCopilotRosterMembers = 32;
export const maximumVisibleCopilotOverviewRosterMembers = 12;
export const maximumVisibleCopilotOverviewRuns = 4;
export const maximumCopilotTeamOverviewLines = 30;
const personalProfileReadConcurrency = 8;
const maximumRequestedCopilotTeamLines = 1_000;
function copilotTeamLineBudget(value) {
    const budget = value ?? maximumCopilotTeamOverviewLines;
    if (!Number.isSafeInteger(budget) || budget < 1 || budget > maximumRequestedCopilotTeamLines) {
        throw new Error(`Copilot team totalLineBudget must be an integer between 1 and ${maximumRequestedCopilotTeamLines}`);
    }
    return budget;
}
function clipCopilotTeamLines(lines, budget) {
    if (lines.length <= budget)
        return [...lines];
    if (budget === 1)
        return ["View clipped by the 1-line total budget; narrow with /team <filter>."];
    const prefix = lines.slice(0, budget - 1);
    while (prefix.length && (!prefix[prefix.length - 1].trim()
        || /^(?:LEAD ACCESS|ACTIVITY|ROSTER|LAST MISSION)(?:\s*·.*)?$/u.test(prefix[prefix.length - 1]))) {
        prefix.pop();
    }
    const omitted = lines.length - prefix.length;
    return [
        ...prefix,
        `+${omitted} wrapped view lines omitted by the ${budget}-line total budget; narrow with /team <filter>.`,
    ];
}
function clipCopilotTeamLinesWithFooter(body, footer, budget) {
    const wrappedBody = wrapPlainLines(body);
    const wrappedFooter = wrapPlainLines(["", ...footer]);
    if (wrappedBody.length + wrappedFooter.length <= budget)
        return [...wrappedBody, ...wrappedFooter];
    if (budget <= wrappedFooter.length + 1) {
        return clipCopilotTeamLines([...wrappedBody, ...wrappedFooter], budget);
    }
    const semanticPattern = /^\+\d+ (?:more roster members|matching active runs omitted|matching historical runs omitted|active runs omitted|personal members omitted)/u;
    const semanticOmissions = wrapPlainLines(body.filter((line) => semanticPattern.test(line)));
    const ordinaryBody = wrapPlainLines(body.filter((line) => !semanticPattern.test(line)));
    const bodyBudget = budget - wrappedFooter.length;
    let headCount = Math.max(0, bodyBudget - semanticOmissions.length - 1);
    let omitted = ordinaryBody.length - headCount;
    let notice = wrapPlainLines([
        `+${omitted} wrapped view lines omitted by the ${budget}-line total budget; narrow with /team <filter>.`,
    ]);
    headCount = Math.max(0, bodyBudget - semanticOmissions.length - notice.length);
    omitted = ordinaryBody.length - headCount;
    notice = wrapPlainLines([
        `+${omitted} wrapped view lines omitted by the ${budget}-line total budget; narrow with /team <filter>.`,
    ]).slice(0, Math.max(0, bodyBudget - semanticOmissions.length));
    headCount = Math.max(0, bodyBudget - semanticOmissions.length - notice.length);
    return [
        ...ordinaryBody.slice(0, headCount),
        ...semanticOmissions,
        ...notice,
        ...wrappedFooter,
    ].slice(0, budget);
}
function parseBenchRows(output) {
    const lines = output.split(/\r?\n/gu).map((line) => line.trim()).filter(Boolean);
    const rows = lines.flatMap((line) => {
        const match = /^([a-z0-9-]+) \| (bundled|personal) \| (on|bench|stale|conflict)$/u.exec(line);
        return match ? [{ id: match[1], roster: match[2], state: match[3] }] : [];
    });
    if (rows.length !== lines.length) {
        throw new Error("Agent Harbor bench inventory returned an unrecognized row; update or reload the extension");
    }
    const bundled = new Set(rows.filter(({ roster }) => roster === "bundled").map(({ id }) => id));
    const missing = [...bundledPlayers.keys()].filter((id) => !bundled.has(id));
    if (missing.length)
        throw new Error(`Agent Harbor bench inventory is incomplete; missing bundled members: ${missing.join(", ")}`);
    return rows;
}
function memberCapacity(definition, id = definition.name) {
    const capabilities = definition.tools.length
        ? [...definition.tools]
        : [id === "team-lead" ? "coordination" : "advisory"];
    for (const skill of definition.skills ?? [])
        capabilities.push(`skill:${skill.name}`);
    return capabilities.join(", ");
}
function memberTools(definition) {
    return [...definition.tools];
}
function memberSkills(definition) {
    return (definition.skills ?? []).map(({ name }) => name);
}
async function registeredPersonalDefinition(project, id) {
    try {
        const root = resolve(project);
        const spec = harnessSpec("copilot", defaultHome("copilot"), root);
        const path = join(spec.home, spec.registrationDir, `${id}${spec.extension}`);
        const content = await readSafeBoundedProfile(spec.home, path);
        if (!content)
            return undefined;
        if (!isOwnedProfile(content, id, "personal"))
            return undefined;
        const definition = validatePlayer(decodePlayer(content, id));
        return isCanonicalPlayerProfile(content, "copilot", definition, "personal", root) ? definition : undefined;
    }
    catch {
        return undefined;
    }
}
async function personalDefinition(project, row) {
    if (row.state === "on") {
        try {
            return loadManagedActivePlayer("copilot", project, row.id);
        }
        catch { /* Fall through to registration metadata. */ }
    }
    return registeredPersonalDefinition(project, row.id);
}
function verifyNativeAvailability(member, project, native, activeProfileIds) {
    if (!native || member.availability !== "ready")
        return member;
    if (!native.discoveryAvailable || !native.coordinatorReady) {
        return { ...member, availability: "unavailable", repairKind: "native-discovery" };
    }
    try {
        const identity = resolveCopilotPlayer(member.id, native.agents, project, activeProfileIds);
        if (identity.userInvocable === false)
            throw new Error("not user invocable");
        return { ...member, configuredModel: identity.model ?? member.configuredModel };
    }
    catch {
        return { ...member, availability: "unavailable", repairKind: "native-discovery" };
    }
}
/** Resolves the complete Copilot-visible roster without creating a model request. */
export async function collectCopilotTeamMembers(project, native) {
    project = canonicalProjectIdentity(project);
    const rows = parseBenchRows(await runDeterministicCommand("copilot", "bench", "list", project));
    const members = [];
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
        if (!definition)
            continue;
        members.push({
            id: row.id,
            kind: "bundled",
            availability: row.state === "on" ? "ready" : row.state,
            description: definition.description,
            capacity: memberCapacity(definition),
            tools: memberTools(definition),
            skills: memberSkills(definition),
            ...(definition.model ? { configuredModel: definition.model } : {}),
            ...(row.state === "stale" ? { repairKind: "bundled-profile" } : {}),
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
                kind: "personal",
                availability: row.state === "on" ? "ready" : row.state,
                description: definition?.description
                    ?? (row.state === "conflict" ? "Unmanaged collision; metadata unavailable" : "Managed profile needs repair"),
                capacity: definition ? memberCapacity(definition) : "unavailable until repaired",
                tools: definition ? memberTools(definition) : [],
                skills: definition ? memberSkills(definition) : [],
                ...(definition?.model ? { configuredModel: definition.model } : {}),
                ...(row.state === "stale" ? {
                    repairKind: definition ? "personal-active" : "personal-registration",
                } : {}),
            };
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
const copilotTeamFilterFields = new Map([
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
    ["owner", "owner"],
    ["pid", "pid"],
    ["heartbeat", "heartbeat"],
    ["telemetry", "telemetry"],
]);
function parseCopilotPagedFilter(value) {
    const matches = [...value.matchAll(/(?:^|\s)page:([^\s]+)(?=\s|$)/gu)];
    if (matches.length > 1)
        throw new Error("Copilot team accepts at most one page:<number> selector");
    if (!matches.length)
        return { filter: value.trim(), page: 1, explicitPage: false };
    const rawPage = matches[0][1];
    if (!/^[1-9]\d{0,5}$/u.test(rawPage)) {
        throw new Error("Copilot team page must be an integer between 1 and 999999");
    }
    const start = matches[0].index ?? 0;
    const end = start + matches[0][0].length;
    const filter = `${value.slice(0, start)} ${value.slice(end)}`.trim().replace(/\s+/gu, " ");
    return { filter, page: Number(rawPage), explicitPage: true };
}
function parseCopilotTeamFilter(filter) {
    const separator = filter.indexOf(":");
    if (separator < 0)
        return { value: filter };
    const field = copilotTeamFilterFields.get(filter.slice(0, separator).trim());
    return field
        ? { field, value: filter.slice(separator + 1).trim() }
        : { value: filter };
}
function includesFilter(values, filter) {
    return Boolean(filter) && values.some((value) => value?.toLowerCase().includes(filter));
}
function equalsFilter(values, filter) {
    return Boolean(filter) && values.some((value) => value?.toLowerCase() === filter);
}
function memberMatches(member, filter, effectiveState) {
    if (!filter)
        return true;
    const query = parseCopilotTeamFilter(filter);
    if (query.field === "tool")
        return includesFilter(member.tools ?? [], query.value);
    if (query.field === "capability")
        return includesFilter([member.capacity], query.value);
    if (query.field === "skill")
        return includesFilter(member.skills ?? [], query.value);
    if (query.field === "status")
        return equalsFilter([effectiveState], query.value);
    if (query.field === "model")
        return includesFilter([member.configuredModel], query.value);
    if (query.field === "member")
        return includesFilter([member.id], query.value);
    if (query.field === "kind")
        return equalsFilter([member.kind], query.value);
    if (query.field === "description")
        return includesFilter([member.description], query.value);
    if (query.field)
        return false;
    return includesFilter([
        member.id,
        member.description,
        member.capacity,
        member.configuredModel,
    ], query.value) || equalsFilter([member.kind, member.availability], query.value);
}
function activityMatches(run, filter) {
    if (!filter)
        return true;
    const query = parseCopilotTeamFilter(filter);
    const models = [run.model, ...run.observedModels];
    const reasoning = [run.reasoningEffort, ...run.observedReasoningEfforts];
    if (query.field === "status")
        return equalsFilter([run.state], query.value);
    if (query.field === "run")
        return equalsFilter([run.id], query.value);
    if (query.field === "member")
        return includesFilter([run.agent], query.value);
    if (query.field === "kind")
        return equalsFilter([run.kind], query.value);
    if (run.projectSharedExternal) {
        if (query.field === "owner") {
            return equalsFilter([run.sharedOwnerRuntime ?? "unverified"], query.value);
        }
        if (query.field === "pid") {
            return equalsFilter([
                run.sharedOwnerProcessID === undefined ? undefined : String(run.sharedOwnerProcessID),
            ], query.value);
        }
        if (query.field === "heartbeat") {
            return equalsFilter([run.sharedHeartbeatOverdue ? "overdue" : "healthy"], query.value);
        }
        if (query.field)
            return false;
        return includesFilter([
            run.agent,
            run.id,
            run.sharedOwnerRuntime,
            run.sharedOwnerProcessID === undefined ? undefined : String(run.sharedOwnerProcessID),
            run.sharedOwnerRuntime ? `owner ${run.sharedOwnerRuntime}` : "owner runtime unverified",
            run.sharedOwnerProcessID === undefined ? undefined : `pid ${run.sharedOwnerProcessID}`,
        ], query.value)
            || equalsFilter([run.kind, run.state, run.sharedActivityKind], query.value);
    }
    if (query.field === "model") {
        return includesFilter(models, query.value)
            || (!models.some(Boolean) && equalsFilter(["unknown", "unobserved"], query.value));
    }
    if (query.field === "reasoning") {
        return equalsFilter(reasoning, query.value)
            || (!reasoning.some(Boolean) && equalsFilter(["unknown", "unobserved"], query.value));
    }
    if (query.field === "telemetry") {
        const unobserved = !models.some(Boolean) || !reasoning.some(Boolean) || run.nativeCalls === undefined;
        return unobserved && equalsFilter(["unobserved", "unknown"], query.value);
    }
    if (query.field === "task")
        return includesFilter([run.task], query.value);
    if (query.field)
        return false;
    return includesFilter([run.agent, run.task, run.id, ...models], query.value)
        || equalsFilter([run.kind, run.state, ...reasoning], query.value);
}
function undisclosedTelemetryWarning(query, runs) {
    if (query.field && !["model", "reasoning", "task", "telemetry"].includes(query.field))
        return undefined;
    const count = runs.filter(({ projectSharedExternal }) => projectSharedExternal).length;
    if (!count)
        return undefined;
    const fields = query.field ?? "task/model/reasoning";
    return `${count} active project-shared run${count === 1 ? " was" : "s were"} not evaluated for ${fields}: the owning process does not disclose that telemetry.`;
}
function availabilitySymbol(state) {
    if (state === "ready")
        return "●";
    if (state === "bench")
        return "○";
    return "!";
}
function sharedOwnerInstruction(run) {
    const processID = run.sharedOwnerProcessID;
    if (run.sharedOwnerRuntime && typeof processID === "number" && Number.isSafeInteger(processID) && processID > 0) {
        return `owner ${run.sharedOwnerRuntime} PID ${processID}; stop there`;
    }
    if (typeof processID === "number" && Number.isSafeInteger(processID) && processID > 0) {
        return `owner runtime unverified (legacy claim) · PID ${processID}; stop in that owning Pi/Copilot process`;
    }
    return "owner runtime/PID unverified; stop in the owning process";
}
function renderActivityRun(run, detailedTelemetry = false) {
    return [
        `${run.parentRunId ? "↳" : "●"} ${run.agent} · run ${run.id}${run.parentRunId ? ` · parent ${run.parentRunId}` : ""} · ${run.kind} · ${run.state} · ${formatCopilotElapsed(run.elapsedMs)}`,
        `  Task: “${run.task}”`,
        `  ${run.projectSharedExternal
            ? `Project-shared persistent player (${run.sharedActivityKind ?? "direct"}); ${sharedOwnerInstruction(run)}. Model, task detail, and usage remain in that process.${run.sharedHeartbeatOverdue ? " Owner heartbeat is overdue; admission remains blocked—recover or restart that process." : ""}`
            : `${formatCopilotModel(run)} · ${formatCopilotReasoning(run)} · ${formatCopilotNativeTelemetry(run, detailedTelemetry)}`}`,
    ];
}
function renderActivity(runs, hasOtherActiveWork) {
    if (!runs.length)
        return [hasOtherActiveWork ? "No active work matches this filter." : "No shared persistent-player work is active; contractors are process-local."];
    return runs.flatMap((run) => renderActivityRun(run));
}
function compactRunTelemetry(run) {
    const uncertainIdentity = run.usageIdentityTruncated || run.usageIdentityAmbiguous;
    const total = formatCopilotTokenCount(run.usage.total, run.usageLowerBounds.includes("total") || run.usageAttributionUnverified || uncertainIdentity);
    if (run.usageAttributionUnverified)
        return `${total} tok (unverified)`;
    if (run.usageAggregateConflict)
        return `${total} tok (conflict)`;
    const identityNote = run.usageIdentityTruncated ? " (capped)" : run.usageIdentityAmbiguous ? " (ambiguous)" : "";
    return `${total} tok${identityNote}`;
}
function boundedCopilotTeamLine(value) {
    if (visibleTextWidth(value) <= terminalLineWidth)
        return value;
    const [prefix] = takeTerminalColumns(value, terminalLineWidth - 1);
    return `${prefix.trimEnd()}…`;
}
function compactCopilotField(value, limit, fallback) {
    const display = copilotPublicIdentifier(value, limit) ?? fallback;
    const probe = copilotPublicIdentifier(value, Math.min(1_000, limit + 1));
    return `${display}${probe !== undefined && probe !== display ? " [abbr]" : ""}`;
}
function detailedCopilotField(value, limit, fallback) {
    const display = copilotPublicIdentifier(value, limit) ?? fallback;
    const probe = copilotPublicIdentifier(value, Math.min(1_000, limit + 1));
    return `${display}${probe !== undefined && probe !== display
        ? ` [alias abbreviated to ${limit} characters]`
        : ""}`;
}
function compactRunLines(run) {
    const agent = compactCopilotField(run.agent, 18, "unknown");
    // Runtime IDs are bounded at their source. Keep them complete on a dedicated
    // route line so copying `/team run:<id>` never inherits a wrap boundary.
    const id = copilotPublicIdentifier(run.id, 64) ?? "unknown";
    const task = compactCopilotField(copilotTaskLabel(run.task), 28, "task unavailable");
    if (run.projectSharedExternal) {
        return [
            boundedCopilotTeamLine(`● ${agent}/${id} · ${run.state} · ${formatCopilotElapsed(run.elapsedMs)} · project-shared persistent`),
            boundedCopilotTeamLine(`  /team run:${id}`),
            boundedCopilotTeamLine(`  Task/telemetry undisclosed · ${sharedOwnerInstruction(run)}${run.sharedHeartbeatOverdue ? " · heartbeat overdue" : ""}`),
            ...(run.sharedHeartbeatOverdue
                ? ["  Heartbeat overdue · recover/restart owner; admission stays blocked until recovery."]
                : []),
        ];
    }
    const model = compactCopilotField(formatCopilotModel(run), 70, "model unknown");
    const reasoning = compactCopilotField(formatCopilotReasoning(run), 50, "reasoning unknown");
    const billing = run.billing.modelMultiplier !== undefined || run.billing.totalNanoAiu !== undefined
        ? [boundedCopilotTeamLine(`  ${formatCopilotBilling(run.billing, run.billingLowerBounds)}`)]
        : [];
    return [
        boundedCopilotTeamLine(`${run.parentRunId ? "↳" : "●"} ${agent}/${id} · ${run.state} · ${formatCopilotElapsed(run.elapsedMs)} · task “${task}”`),
        boundedCopilotTeamLine(`  Model: ${model}`),
        boundedCopilotTeamLine(`  ${reasoning} · ${compactRunTelemetry(run)}`),
        ...billing,
        boundedCopilotTeamLine(`  /team run:${id}`),
    ];
}
function renderExactRun(run) {
    const heading = `${run.parentRunId ? "↳" : "●"} ${run.agent} · run ${run.id}${run.parentRunId ? ` · parent ${run.parentRunId}` : ""} · ${run.kind} · ${run.state} · ${formatCopilotElapsed(run.elapsedMs)}`;
    if (run.projectSharedExternal) {
        return [
            heading,
            `  /team run:${run.id}`,
            `  Project-shared persistent player (${run.sharedActivityKind ?? "direct"}) · ${sharedOwnerInstruction(run)}.`,
            `  Task/model/reasoning/usage/billing: undisclosed by the owning process.${run.sharedHeartbeatOverdue ? " Heartbeat overdue; recover or restart that process." : ""}`,
        ];
    }
    const hasBilling = run.billing.modelMultiplier !== undefined || run.billing.totalNanoAiu !== undefined;
    return [
        heading,
        `  /team run:${run.id}`,
        `  Usage: ${formatCopilotUsage(run.usage, run.usageLowerBounds)}`,
        `  Billing: ${hasBilling
            ? formatCopilotBilling(run.billing, run.billingLowerBounds)
            : "billing units (not USD): model multiplier — · nano AIU —"}`,
        ...(run.parentRunId && (run.durationMs !== undefined || run.totalToolCalls !== undefined)
            ? [`  Native child: duration ${run.durationMs === undefined
                    ? "—"
                    : `${formatCopilotElapsed(run.durationMs)}.${String(Math.floor(run.durationMs % 1_000)).padStart(3, "0")}`} · tool calls ${run.totalToolCalls ?? "—"}`]
            : []),
        `  Model: ${detailedCopilotField(formatCopilotModel(run), 160, "unknown/default (unobserved)")}`,
        `  Reasoning: ${detailedCopilotField(formatCopilotReasoning(run), 120, "reasoning effort unknown")}`,
        `  Task: “${run.task}”`,
        `  Native: ${formatCopilotNativeTelemetry(run, false)}`,
    ];
}
function fallbackSharedKind(agent) {
    if (agent === "team-lead")
        return "manager";
    if (agent === scoutPlayer.name)
        return "utility";
    if (bundledPlayers.has(agent))
        return "bundled";
    if (rolePlayers.has(agent))
        return "fixed";
    return "personal";
}
function sharedCopilotActivity(project, local, members = []) {
    try {
        const localPersistent = new Set(local.filter(({ kind }) => kind !== "contractor").map(({ agent }) => agent));
        const kinds = new Map(members.map(({ id, kind }) => [id, kind]));
        const now = Date.now();
        const claims = readSharedAgentActivities(project);
        const runs = claims
            .filter(({ agent }) => !localPersistent.has(agent))
            .map((claim, index) => ({
            id: `shared-${claim.agent}`,
            sequence: Number.MAX_SAFE_INTEGER - index,
            rootRunId: `shared-${claim.agent}`,
            agent: claim.agent,
            kind: kinds.get(claim.agent) ?? fallbackSharedKind(claim.agent),
            task: "Task not disclosed by the owning process",
            state: claim.phase,
            startedAt: claim.startedAt,
            elapsedMs: Math.max(0, now - claim.startedAt),
            observedModels: [],
            observedModelsTruncated: false,
            observedReasoningEfforts: [],
            observedReasoningEffortsTruncated: false,
            usage: {},
            usageLowerBounds: [],
            billing: {},
            billingLowerBounds: [],
            usageAggregateConflict: false,
            usageIdentityTruncated: false,
            usageIdentityAmbiguous: false,
            usageAttributionUnverified: false,
            nativeCalls: 0,
            projectSharedExternal: true,
            sharedActivityKind: claim.kind,
            ...(claim.ownerRuntime === "pi" || claim.ownerRuntime === "copilot"
                ? { sharedOwnerRuntime: claim.ownerRuntime }
                : {}),
            sharedOwnerProcessID: claim.processID,
            ...(claim.heartbeatOverdue ? { sharedHeartbeatOverdue: true } : {}),
        }));
        return { runs, authoritative: true, persistentClaimCount: claims.length };
    }
    catch (error) {
        const rawReason = error instanceof Error
            ? error.message
            : typeof error === "string"
                ? error
                : "Agent Harbor activity store read failed without an error message";
        return {
            runs: [],
            authoritative: false,
            diagnosticReason: publicErrorText(rawReason, 240)
                ?? "Agent Harbor activity store read failed without a public diagnostic",
        };
    }
}
function sharedActivityWarnings(shared) {
    if (shared.authoritative)
        return [];
    return [
        "Persistent-player activity authority is unavailable; availability and delegation cannot be verified. Repair: use the zero-model steps below.",
        ...(shared.diagnosticReason ? [`Activity store diagnostic: ${shared.diagnosticReason}`] : []),
        "Repair (0 model tokens): inspect AGENT_HARBOR_ACTIVITY_HOME—or the default Agent Harbor activity store—for permissions/content; restart owning processes; retry /team.",
    ];
}
function emptyCopilotActivity(authoritative) {
    return authoritative
        ? "No shared persistent-player work is active; contractors are process-local."
        : "Persistent-player activity authority is unavailable; another process may be working. Disposable contractor work is process-local.";
}
function compactRunIndexLine(run, prefix = "A") {
    const agent = compactCopilotField(run.agent, 18, "unknown");
    const id = copilotPublicIdentifier(run.id, 64) ?? "unknown";
    const heartbeat = run.projectSharedExternal
        ? ` · shared persistent · ${run.sharedOwnerRuntime ?? "owner?"}/${run.sharedOwnerProcessID ?? "pid?"}${run.sharedHeartbeatOverdue ? " · overdue" : ""}`
        : "";
    const marker = prefix === "A" ? (run.parentRunId ? "↳" : "●") : prefix;
    return boundedCopilotTeamLine(`${marker} ${agent}/${id} · ${run.state} · /team run:${id}${heartbeat}`);
}
function compactRunOverviewLines(run) {
    return compactRunLines(run);
}
function compactRosterIndexLine(member, activeMemberStates, activityAuthoritative) {
    const activity = activeMemberStates.get(member.id) ?? (activityAuthoritative
        ? member.availability
        : `${member.availability}/activity-unverified`);
    return boundedCopilotTeamLine(`R ${availabilitySymbol(member.availability)} ${member.id}${member.id === scoutPlayer.name ? " (/scout)" : ""} · ${member.kind} · ${activity}`);
}
function historicalRoots(runtime, project) {
    return runtime.projectRuns(project).filter((run) => run.parentRunId === undefined);
}
function modelFacingRosterGate(members, working) {
    return formatHarborTeamRosterSnapshot(members.flatMap((member) => {
        if (member.availability !== "ready" || !["fixed", "bundled", "personal"].includes(member.kind))
            return [];
        if (member.id === "team-lead" || member.id === scoutPlayer.name)
            return [];
        return [{
                id: member.id,
                role: member.description,
                tools: member.tools ?? [],
                skills: member.skills ?? [],
                ...(member.configuredModel ? { configuredModel: member.configuredModel } : {}),
                availability: working.has(member.id) ? "busy" : "ready",
            }];
    }), "", "/bench off <id...>");
}
function pagedTeamRoute(title, filter, page) {
    const command = title === "bench" ? "/bench list" : "/team";
    return `${command}${filter ? ` ${filter}` : ""} page:${page}`;
}
function renderCopilotPagedIndex(input) {
    const activityItems = input.title === "bench"
        ? []
        : input.activity.map((run) => ({ kind: "active", line: compactRunIndexLine(run) }));
    const activeIds = new Set(input.activity.map(({ id }) => id));
    const historyItems = input.title === "bench"
        ? []
        : input.history.filter(({ id }) => !activeIds.has(id)).map((run) => ({
            kind: "history",
            line: compactRunIndexLine(run, "H"),
        }));
    // Bench is deliberately roster-only; /team keeps activity/history first so
    // work in progress is never hidden behind a large personal inventory.
    const rosterItems = input.members.map((member) => ({
        kind: "roster",
        line: compactRosterIndexLine(member, input.activeMemberStates, input.activityAuthoritative),
    }));
    const items = input.title === "bench"
        ? rosterItems
        : [...activityItems, ...historyItems, ...rosterItems];
    const boundedNotices = input.notices.map(boundedCopilotTeamLine).slice(0, 3);
    const reservedLines = 7 + boundedNotices.length;
    const pageSize = Math.max(1, Math.min(12, input.lineBudget - reservedLines));
    const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
    if (input.page > totalPages) {
        return [
            boundedCopilotTeamLine(`Agent Harbor Copilot ${input.title} · ${input.projectName} · 0 model tokens`),
            `Page ${input.page} is outside the available range 1-${totalPages}.`,
            `Open: ${pagedTeamRoute(input.title, input.filter, totalPages)}`,
        ].slice(0, input.lineBudget).join("\n");
    }
    const start = (input.page - 1) * pageSize;
    const shown = items.slice(start, start + pageSize);
    const counts = {
        active: shown.filter(({ kind }) => kind === "active").length,
        history: shown.filter(({ kind }) => kind === "history").length,
        roster: shown.filter(({ kind }) => kind === "roster").length,
    };
    const hidden = items.length - shown.length;
    const nextPage = input.page < totalPages ? input.page + 1 : undefined;
    const previousPage = input.page > 1 ? input.page - 1 : undefined;
    const lines = [
        boundedCopilotTeamLine(`Agent Harbor Copilot ${input.title} · ${input.projectName} · 0 model tokens`),
        ...boundedNotices,
        boundedCopilotTeamLine(`INDEX · page ${input.page}/${totalPages} · showing ${shown.length}/${items.length} · active ${counts.active} · history ${counts.history} · roster ${counts.roster}`),
        ...shown.map(({ line }) => line),
        boundedCopilotTeamLine(`INDEX · +${Math.max(0, hidden)} items not on this page${hidden ? "; use the adjacent route below" : ""}.`),
        boundedCopilotTeamLine(`Pages: ${previousPage ? `prev ${pagedTeamRoute(input.title, input.filter, previousPage)} · ` : ""}${nextPage ? `next ${pagedTeamRoute(input.title, input.filter, nextPage)}` : "end"}`),
        input.title === "bench"
            ? "Actions: /bench on|off <id...> · /join <json> · /retire <id>"
            : "Actions: /team run:<id> · /team stop <run|all> · /<id> <task> · /team help",
    ];
    return lines.slice(0, input.lineBudget).join("\n");
}
function renderCompactRuns(runs, omittedLabel, nextRoute = "/team page:2") {
    const shown = runs.slice(0, maximumVisibleCopilotOverviewRuns).flatMap(compactRunLines);
    return [
        ...shown,
        ...(runs.length > maximumVisibleCopilotOverviewRuns
            ? [`+${runs.length - maximumVisibleCopilotOverviewRuns} ${omittedLabel} omitted; next ${nextRoute}.`]
            : []),
    ];
}
function renderRoster(members, activeMemberStates, suppressNativeDiscoveryRepair = false, activityAuthoritative = true) {
    return members.flatMap((member) => {
        const localActivity = activeMemberStates.get(member.id);
        const activity = localActivity ?? (activityAuthoritative
            ? member.availability
            : `${member.availability} · project activity unverified`);
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
function renderCompactRoster(members, activeMemberStates, activityAuthoritative = true, nextRoute = "/team page:2") {
    const shown = members.slice(0, maximumVisibleCopilotOverviewRosterMembers).map((member) => {
        const localActivity = activeMemberStates.get(member.id);
        const activity = localActivity ?? (activityAuthoritative
            ? member.availability
            : `${member.availability} · project activity unverified`);
        return `${availabilitySymbol(member.availability)} ${member.id}${member.id === scoutPlayer.name ? " (/scout)" : ""} · ${member.kind} · ${activity}`;
    });
    return [
        ...shown,
        ...(members.length > maximumVisibleCopilotOverviewRosterMembers
            ? [`+${members.length - maximumVisibleCopilotOverviewRosterMembers} more roster members; next ${nextRoute}.`]
            : []),
    ];
}
function renderCompactMission(runtime, rootRunId, runs) {
    const root = runs.find((run) => run.parentRunId === undefined) ?? runs[0];
    if (!root)
        return ["No completed mission snapshot is available."];
    const attributionUnverified = runtime.missionUsageAttributionUnverified(rootRunId);
    const aggregateConflict = runtime.missionUsageAggregateConflict(rootRunId);
    const total = runtime.missionUsage(rootRunId).total;
    const lowerBound = runtime.missionUsageLowerBounds(rootRunId).includes("total") || attributionUnverified;
    const billing = runtime.missionBilling(rootRunId);
    const billingText = billing.modelMultiplier !== undefined || billing.totalNanoAiu !== undefined
        ? formatCopilotBilling(billing, runtime.missionBillingLowerBounds(rootRunId))
        : undefined;
    return [
        ...compactRunLines(root),
        boundedCopilotTeamLine(`Mission: ${runs.length} tracked run${runs.length === 1 ? "" : "s"} · total ${formatCopilotTokenCount(total, lowerBound)} native tokens${attributionUnverified ? " · attribution unverified" : ""}${aggregateConflict ? " · token conflict" : ""}`),
        ...(billingText ? [boundedCopilotTeamLine(`Mission billing: ${billingText}`)] : []),
    ];
}
function compactMemberIds(members, limit = 6) {
    if (!members.length)
        return "none";
    const shown = members.slice(0, limit).map(({ id }) => id).join(", ");
    return members.length > limit ? `${shown} (+${members.length - limit} more)` : shown;
}
function renderCompactLeadAccess(members, working, selectionGate) {
    const specialists = members.filter((member) => member.id !== "team-lead" && member.kind !== "manager" && member.kind !== "utility" && member.availability === "ready");
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
/** Minimal fallback used when authoritative roster rendering misses its deadline. */
export function formatCopilotDegradedTeamView(project, runtime, options = {}) {
    const paging = parseCopilotPagedFilter(options.filter?.trim().toLowerCase() ?? "");
    const needle = paging.filter;
    const lineBudget = copilotTeamLineBudget(options.totalLineBudget);
    const localActive = runtime.activeProjectRuns(project);
    const shared = sharedCopilotActivity(project, localActive);
    const unorderedActive = [...localActive, ...shared.runs];
    const rootOrder = new Map();
    for (const run of unorderedActive) {
        const current = rootOrder.get(run.rootRunId);
        if (current === undefined || run.sequence < current)
            rootOrder.set(run.rootRunId, run.sequence);
    }
    const active = unorderedActive.sort((left, right) => rootOrder.get(left.rootRunId) - rootOrder.get(right.rootRunId) || left.sequence - right.sequence);
    const filterQuery = parseCopilotTeamFilter(needle);
    const filterTelemetryWarning = needle
        ? undisclosedTelemetryWarning(filterQuery, active)
        : undefined;
    const matchingActive = active.filter((run) => !needle || activityMatches(run, needle));
    const retainedHistory = historicalRoots(runtime, project)
        .filter((run) => !active.some(({ id }) => id === run.id))
        .filter((run) => !needle || activityMatches(run, needle));
    const projectName = copilotPublicIdentifier(runtime.projectName(project), 80) ?? "project";
    const snapshotLabel = options.budgetMs === undefined
        ? "Bounded snapshot"
        : `Degraded bounded snapshot (${options.budgetMs}ms budget)`;
    const common = [
        `Agent Harbor Copilot ${options.title ?? "team"} · ${projectName} · 0 model tokens · degraded`,
        `${snapshotLabel}: ${[...new Set(options.reasons ?? [])].join("; ") || "authoritative roster rendering unavailable"}.`,
        ...(options.selectionGate
            ? [`Selection gate: ${copilotPublicIdentifier(options.selectionGate, 240) ?? "selection is temporarily locked"}.`]
            : []),
        ...sharedActivityWarnings(shared),
        ...(filterTelemetryWarning ? [filterTelemetryWarning] : []),
    ];
    const exact = filterQuery.field === "run"
        ? [...matchingActive, ...runtime.projectRuns(project)].find((run) => run.id.toLowerCase() === filterQuery.value)
        : undefined;
    if (exact) {
        const exactIsActive = active.some(({ id }) => id === exact.id);
        const lines = [
            ...common,
            "",
            exactIsActive ? "ACTIVITY · EXACT RUN" : "HISTORY · EXACT RUN",
            ...renderExactRun(exact),
            "",
            "Retry /team for the authoritative roster after Copilot host RPC recovers.",
        ];
        return clipCopilotTeamLinesWithFooter(lines, ["Route preserved: /team run:<id>."], lineBudget).join("\n");
    }
    if (!paging.explicitPage && matchingActive.length > 0 && matchingActive.length <= 2) {
        const lines = [
            ...common,
            "",
            "ACTIVITY",
            "Scope: persistent players project-wide · disposable contractors process-local",
            ...matchingActive.flatMap((run) => renderActivityRun(run, true)),
            ...matchingActive.flatMap((run) => !run.projectSharedExternal && run.parentRunId
                && (run.durationMs !== undefined || run.totalToolCalls !== undefined)
                ? [`  Native child: duration ${run.durationMs === undefined
                        ? "—"
                        : `${formatCopilotElapsed(run.durationMs)}.${String(Math.floor(run.durationMs % 1_000)).padStart(3, "0")}`} · tool calls ${run.totalToolCalls ?? "—"}`]
                : []),
            "",
            "Retry /team for the authoritative roster after Copilot host RPC recovers.",
        ];
        return clipCopilotTeamLines(lines.flatMap((line) => wrapPlainLines([line])), lineBudget).join("\n");
    }
    const latestCandidate = active.length ? undefined : runtime.latestRoot(project);
    const historicalMissionRoot = needle ? retainedHistory[0] : latestCandidate;
    if (!paging.explicitPage && historicalMissionRoot && retainedHistory.length
        && (!needle || retainedHistory.length === 1)) {
        const lines = [
            ...common,
            "",
            "LAST MISSION",
            ...formatCopilotMissionDetails(runtime, historicalMissionRoot.rootRunId),
            "",
            "Retry /team for the authoritative roster after Copilot host RPC recovers.",
        ];
        return clipCopilotTeamLines(lines.flatMap((line) => wrapPlainLines([line])), lineBudget).join("\n");
    }
    const reserved = wrapPlainLines([
        ...common,
        "ACTIVITY · persistent players project-wide · contractors process-local",
        "Retry /team for the authoritative roster after Copilot host RPC recovers.",
    ]).length + 6;
    const pageSize = Math.max(1, Math.min(maximumVisibleCopilotRosterMembers, lineBudget - reserved));
    const indexed = [
        ...matchingActive.map((run) => ({ run, label: "A" })),
        ...retainedHistory.map((run) => ({ run, label: "H" })),
    ];
    const totalPages = Math.max(1, Math.ceil(indexed.length / pageSize));
    if (paging.page > totalPages) {
        return clipCopilotTeamLines([
            ...wrapPlainLines(common),
            `Page ${paging.page} is outside the available range 1-${totalPages}.`,
            `Open: /team${needle ? ` ${needle}` : ""} page:${totalPages}`,
        ], lineBudget).join("\n");
    }
    const start = (paging.page - 1) * pageSize;
    const shown = indexed.slice(start, start + pageSize);
    const hidden = indexed.length - shown.length;
    const shownActiveCount = shown.filter(({ label }) => label === "A").length;
    const shownHistoryCount = shown.filter(({ label }) => label === "H").length;
    const hiddenActiveCount = matchingActive.length - shownActiveCount;
    const hiddenHistoryCount = retainedHistory.length - shownHistoryCount;
    const lines = [
        ...common,
        "",
        `ACTIVITY · page ${paging.page}/${totalPages} · showing ${shown.length}/${indexed.length} · +${Math.max(0, hidden)} runs not on this page`,
        "Scope: persistent players project-wide · disposable contractors process-local",
        ...(hiddenActiveCount > 0
            ? [`+${hiddenActiveCount} matching active runs omitted by this bounded snapshot; filter or retry /team${paging.page < totalPages ? ` page:${paging.page + 1}` : ""}.`]
            : []),
        ...(hiddenHistoryCount > 0
            ? [`+${hiddenHistoryCount} matching historical runs omitted; continue /team${paging.page < totalPages ? ` page:${paging.page + 1}` : ""}.`]
            : []),
        ...(shown.length
            ? shown.map(({ run, label }) => compactRunIndexLine(run, label))
            : [needle
                    ? `No tracked Agent Harbor work matches this bounded snapshot${filterTelemetryWarning ? " in disclosed fields" : ""}.`
                    : emptyCopilotActivity(shared.authoritative)]),
        ...(paging.page < totalPages
            ? [`Next: /team${needle ? ` ${needle}` : ""} page:${paging.page + 1}`]
            : []),
        "",
        "Retry /team for the authoritative roster after Copilot host RPC recovers.",
    ];
    return clipCopilotTeamLines(wrapPlainLines(lines), lineBudget).join("\n");
}
/** Formats roster, active hierarchy, and last mission without inference or durable activity storage. */
export async function formatCopilotTeamView(project, runtime, options = {}) {
    project = canonicalProjectIdentity(project);
    const paging = parseCopilotPagedFilter(options.filter?.trim().toLowerCase() ?? "");
    const filter = paging.filter;
    const lineBudget = copilotTeamLineBudget(options.totalLineBudget);
    const applyLineBudget = true;
    const filterQuery = parseCopilotTeamFilter(filter);
    const allMembers = await collectCopilotTeamMembers(project, options.native);
    const localActive = runtime.activeProjectRuns(project);
    const shared = sharedCopilotActivity(project, localActive, allMembers);
    const unorderedActive = [...localActive, ...shared.runs];
    const rootOrder = new Map();
    for (const run of unorderedActive) {
        const current = rootOrder.get(run.rootRunId);
        if (current === undefined || run.sequence < current)
            rootOrder.set(run.rootRunId, run.sequence);
    }
    const allActive = unorderedActive.sort((left, right) => rootOrder.get(left.rootRunId) - rootOrder.get(right.rootRunId) || left.sequence - right.sequence);
    const filterTelemetryWarning = filter
        ? undisclosedTelemetryWarning(filterQuery, allActive)
        : undefined;
    const activeMemberStates = new Map(allActive
        .filter((run) => run.kind !== "contractor")
        .map((run) => [run.agent, run.state]));
    const members = allMembers.filter((member) => memberMatches(member, filter, activeMemberStates.get(member.id) ?? member.availability));
    const activity = allActive.filter((run) => activityMatches(run, filter));
    const latest = runtime.latestRoot(project);
    const latestMission = !allActive.length && latest ? runtime.mission(latest.rootRunId) : [];
    const activeRunIds = new Set(allActive.map(({ id }) => id));
    const retainedHistoryRuns = runtime.projectRuns(project).filter((run) => !activeRunIds.has(run.id));
    const historicalMatches = retainedHistoryRuns.filter((run) => activityMatches(run, filter));
    const richDetails = Boolean(filter) && members.length + activity.length + historicalMatches.length <= 2;
    const working = new Set(activeMemberStates.keys());
    const rosterSnapshot = modelFacingRosterGate(allMembers, working);
    // Project-shared work blocks only its claimed persistent player. Copilot's
    // single-session selection owner is necessarily one of this process's runs.
    const activeChild = localActive.find((run) => run.parentRunId !== undefined);
    const activeNonManagerRoot = localActive.find((run) => run.parentRunId === undefined && run.kind !== "manager");
    const cleaningManagerRoot = localActive.find((run) => run.parentRunId === undefined && run.kind === "manager" && run.state === "cleaning");
    const persistentClaimCount = shared.persistentClaimCount ?? allActive.filter(({ kind }) => kind !== "contractor").length;
    const rosterGate = rosterSnapshot.complete
        ? undefined
        : `model-facing roster is incomplete (${rosterSnapshot.total} enabled specialists or over 16 KiB); /team-lead and /scout are closed; use /bench off <id...>`;
    const capacityGate = persistentClaimCount >= 32
        ? `project-shared persistent registry is full (${persistentClaimCount}/32); new roots and delegations are closed; settle or stop active work`
        : undefined;
    const selectionGate = [
        !shared.authoritative
            ? "project-shared activity authority is unavailable; repair the managed activity store before selecting or delegating"
            : undefined,
        copilotPublicIdentifier(options.selectionGate, 240),
        activeChild ? `child run ${activeChild.id} is active; wait for its terminal event` : undefined,
        activeNonManagerRoot ? `${activeNonManagerRoot.kind} root ${activeNonManagerRoot.id} owns the session` : undefined,
        cleaningManagerRoot ? `manager run ${cleaningManagerRoot.id} is cleaning; wait for its terminal event` : undefined,
        capacityGate,
        rosterGate,
    ].filter(Boolean).join("; ") || undefined;
    const activeManager = localActive.some((run) => !run.parentRunId && run.kind === "manager"
        && ["starting", "working", "waiting"].includes(run.state));
    const capacityNotice = persistentClaimCount === 31
        ? activeManager
            ? "Capacity: 31/32 persistent claims; this active team-lead may use the final child slot; new /team-lead roots need 2 slots."
            : "Capacity: 31/32 persistent claims; an inactive /team-lead root needs 2 slots and is preflight-blocked; one-slot roots remain available."
        : undefined;
    const globalNativeDiscoveryFailure = Boolean(options.native &&
        (!options.native.discoveryAvailable || !options.native.coordinatorReady));
    const globalWarnings = [
        ...sharedActivityWarnings(shared),
        ...(filterTelemetryWarning ? [filterTelemetryWarning] : []),
        ...(capacityNotice ? [capacityNotice] : []),
        ...(options.native?.selectionRestoreUnverified
            ? ["Player selection restoration is unverified; no teammate can be selected. Reload the Copilot session."]
            : globalNativeDiscoveryFailure
                ? ["Native agent discovery/coordinator is not ready; no teammate can be selected. Reload the Copilot session."]
                : []),
    ];
    const exactRun = filterQuery.field === "run"
        ? [...allActive, ...retainedHistoryRuns].find((run) => run.id.toLowerCase() === filterQuery.value)
        : undefined;
    if (exactRun) {
        const projectName = copilotPublicIdentifier(runtime.projectName(project), 80) ?? "project";
        const historical = !activeRunIds.has(exactRun.id);
        const body = [
            `Agent Harbor Copilot ${(options.title ?? "team")} · ${projectName} · 0 model tokens`,
            ...globalWarnings,
            ...(selectionGate ? [`Selection gate: ${selectionGate}.`] : []),
            "",
            historical ? "HISTORY · EXACT RUN" : "ACTIVITY · EXACT RUN",
            ...renderExactRun(exactRun),
            ...(historical && exactRun.rootRunId
                ? [`Mission root: /team run:${exactRun.rootRunId}.`]
                : []),
        ];
        return clipCopilotTeamLinesWithFooter(body, [
            "Control: /team stop <run-id|all> · index: /team page:1",
            "Roster: /bench list page:1 · help: /team help",
        ], lineBudget).join("\n");
    }
    if (!members.length && !activity.length && !historicalMatches.length) {
        const shown = publicMetadataText(options.filter?.trim() ?? "", 80) || "the requested filter";
        const projectName = copilotPublicIdentifier(runtime.projectName(project), 80) ?? "project";
        const noMatchLines = wrapPlainLines([
            `Agent Harbor Copilot ${(options.title ?? "team")} · ${projectName} · 0 model tokens`,
            filterTelemetryWarning
                ? `No team member or tracked activity matches “${shown}” in disclosed fields.`
                : `No team member or tracked activity matches “${shown}”.`,
            ...globalWarnings,
            ...(selectionGate ? [`Selection gate: ${selectionGate}.`] : []),
            "Try /team, /bench list, or search by member ID, description, role/kind, capability, tool, skill,",
            "model/reasoning, status/state, task label, or run ID.",
        ]);
        return (applyLineBudget ? clipCopilotTeamLines(noMatchLines, lineBudget) : noMatchLines).join("\n");
    }
    // A small filtered history result should be a focused telemetry view. Mixing
    // it with the full roster used to consume the 30-line budget before every
    // matched run was shown, which made an exact two-run mission look partial.
    if (filter && !members.length && !activity.length && historicalMatches.length <= 2) {
        const projectName = copilotPublicIdentifier(runtime.projectName(project), 80) ?? "project";
        const body = [
            `Agent Harbor Copilot ${(options.title ?? "team")} · ${projectName} · 0 model tokens`,
            ...globalWarnings,
            ...(selectionGate ? [`Selection gate: ${selectionGate}.`] : []),
            "",
            "HISTORY · FILTERED RUNS",
            ...historicalMatches.flatMap((run) => [
                ...renderActivityRun(run, true),
                ...(run.parentRunId && (run.durationMs !== undefined || run.totalToolCalls !== undefined)
                    ? [`  Native child: duration ${run.durationMs === undefined
                            ? "—"
                            : `${formatCopilotElapsed(run.durationMs)}.${String(Math.floor(run.durationMs % 1_000)).padStart(3, "0")}`} · tool calls ${run.totalToolCalls ?? "—"}`]
                    : []),
            ]),
        ];
        return clipCopilotTeamLinesWithFooter(body, [
            "Control: /team stop <run-id|all> · full index: /team page:1",
            "Roster: /bench list page:1 · help: /team help",
        ], lineBudget).join("\n");
    }
    if (paging.explicitPage || options.title === "bench") {
        return renderCopilotPagedIndex({
            title: options.title ?? "team",
            projectName: copilotPublicIdentifier(runtime.projectName(project), 80) ?? "project",
            filter,
            page: paging.page,
            lineBudget,
            members,
            activity,
            history: historicalMatches,
            activeMemberStates,
            activityAuthoritative: shared.authoritative,
            notices: [
                ...globalWarnings,
                ...(selectionGate ? [`Selection gate: ${selectionGate}.`] : []),
                ...(options.title === "bench"
                    ? [`Capacity: ${persistentClaimCount}/32 active persistent claims · ${Math.max(0, 32 - persistentClaimCount)} slots free.`]
                    : []),
            ],
        });
    }
    if (filter && !members.length && activity.length + historicalMatches.length > 2) {
        return renderCopilotPagedIndex({
            title: "team",
            projectName: copilotPublicIdentifier(runtime.projectName(project), 80) ?? "project",
            filter,
            page: 1,
            lineBudget,
            members: [],
            activity,
            history: historicalMatches,
            activeMemberStates,
            activityAuthoritative: shared.authoritative,
            notices: [
                ...globalWarnings,
                ...(selectionGate ? [`Selection gate: ${selectionGate}.`] : []),
            ],
        });
    }
    const ready = allMembers.filter((member) => member.availability === "ready" && !working.has(member.id)).length;
    const benched = allMembers.filter((member) => member.availability === "bench").length;
    const unhealthy = allMembers.filter((member) => member.availability !== "ready" && member.availability !== "bench").length;
    const activeCounts = new Map();
    for (const run of allActive)
        activeCounts.set(run.state, (activeCounts.get(run.state) ?? 0) + 1);
    const activeBreakdown = ["working", "starting", "waiting", "cleaning"]
        .flatMap((state) => activeCounts.has(state) ? [`${activeCounts.get(state)} ${state}`] : [])
        .join(" · ");
    const nextModel = copilotPublicIdentifier(options.nextModel, 200);
    const nextReasoning = copilotPublicIdentifier(options.nextReasoning, 80);
    const unobservedModel = options.nextModelUnreported ? "no model reported (unobserved)" : "unknown/default (unobserved)";
    const hostDefault = `Host/session default: ${nextModel ? `${nextModel} (inherited)` : unobservedModel} · reasoning ${nextReasoning ?? "unknown"}`;
    const compactHostDefault = `Host default: ${nextModel ? `${nextModel} (inherited)` : unobservedModel} · reasoning ${nextReasoning ?? "unknown"}`;
    const lines = [
        `Agent Harbor Copilot ${(options.title ?? "team")} · ${copilotPublicIdentifier(runtime.projectName(project), 80) ?? "project"} · 0 model tokens`,
        shared.authoritative
            ? `${filter ? "Overall Team" : "Team"}: ${ready} ready · ${allActive.length} active${activeBreakdown ? ` (${activeBreakdown})` : ""} · ${benched} benched · ${unhealthy} unhealthy`
            : `${filter ? "Overall Team" : "Team"}: persistent availability/activity unverified · ≥${allActive.length} process-visible active · ${benched} configured benched · ${unhealthy} unhealthy`,
        `${richDetails ? hostDefault : compactHostDefault}${options.nextMaxOutputTokens === undefined
            ? ""
            : richDetails
                ? ` · model max output per response ${formatCopilotTokenCount(options.nextMaxOutputTokens)} tokens`
                : ` · max output ${formatCopilotTokenCount(options.nextMaxOutputTokens)} tokens`}`,
        ...globalWarnings,
        ...(selectionGate ? [`Selection gate: ${selectionGate}.`] : []),
        "",
        filter ? "LEAD ACCESS · OVERALL" : "LEAD ACCESS",
        ...renderCompactLeadAccess(allMembers, working, selectionGate),
        "",
        "ACTIVITY",
        "Scope: persistent players project-wide · disposable contractors process-local",
        ...(richDetails
            ? renderActivity(activity, allActive.length > 0)
            : activity.length
                ? renderCompactRuns(activity, filter ? "matching active runs" : "active runs", `/team${filter ? ` ${filter}` : ""} page:2`)
                : [allActive.length ? "No active work matches this filter." : emptyCopilotActivity(shared.authoritative)]),
        "",
        "ROSTER",
        ...(members.length
            ? richDetails
                ? [
                    ...renderRoster(members.slice(0, maximumVisibleCopilotRosterMembers), activeMemberStates, globalNativeDiscoveryFailure, shared.authoritative),
                    ...(members.length > maximumVisibleCopilotRosterMembers
                        ? [`+${members.length - maximumVisibleCopilotRosterMembers} more roster members; use /team <filter> to narrow the view.`]
                        : []),
                ]
                : renderCompactRoster(members, activeMemberStates, shared.authoritative, `/team${filter ? ` ${filter}` : ""} page:2`)
            : ["No roster member matches this filter."]),
    ];
    if (!allActive.length && latest && historicalMatches.length) {
        const historyHeading = !filter
            ? "LAST MISSION"
            : filterQuery.field === "run"
                ? "LAST MISSION · MATCHING RUNS"
                : "LAST MISSION · MATCHES";
        lines.push("", historyHeading, ...(richDetails
            ? [...formatCopilotRunDetails(historicalMatches), "Filtered history · run /team without a filter for mission summary."]
            : filter
                ? renderCompactRuns(historicalMatches, "matching historical runs", `/team ${filter} page:2`)
                : renderCompactMission(runtime, latest.rootRunId, latestMission)));
    }
    if (!richDetails)
        lines.push("", "Details: /team member:<id> · activity/history: /team run:<id>.");
    const footer = richDetails
        ? [
            "Live TUI: progress posts automatically · Esc interrupts/stops agents · /team returns after settlement.",
            "Inspect/control: /team [filter] · /team help|--help · /team stop <run-id|all> (idle/RPC)",
            "Run: /player <id> <task> · /contract <json> · /scout <need>",
            "Roster: /bench list [filter] · /bench on|off <id...> · /join <json> · /retire <id>",
            "Catalog: /list-skills [--descriptions|-d] [filter] [--page N]",
        ]
        : [
            "Live: automatic progress · Esc interrupt/stop · /team after settlement",
            "Inspect/run: /<id> <task> · /team help|<filter> · /team stop <run|all> (idle/RPC)",
            "Roster/catalog: /bench · /join · /retire · /scout · /contract · /list-skills",
        ];
    const wrapped = wrapPlainLines([...lines, "", ...footer]);
    if (filter) {
        return (applyLineBudget
            ? clipCopilotTeamLinesWithFooter(lines, footer, lineBudget)
            : wrapped).join("\n");
    }
    if (wrapped.length <= lineBudget) {
        return wrapped.join("\n");
    }
    // Preserve every factory identity in the first viewport and spend only the
    // remaining wrapped-line budget on personal rows and activity. Filtered
    // detail views use the same total 30-line default budget above.
    const factoryMembers = allMembers.filter(({ kind }) => kind !== "personal");
    const personalMembers = allMembers.filter(({ kind }) => kind === "personal");
    const specialists = allMembers.filter((member) => member.id !== "team-lead"
        && member.kind !== "manager" && member.kind !== "utility" && member.availability === "ready");
    const busySpecialists = specialists.filter(({ id }) => working.has(id));
    const eligibleSpecialists = specialists.filter(({ id }) => !working.has(id));
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
    const safetyLines = wrapPlainLines([
        ...globalWarnings,
        ...(selectionGate ? [`Selection gate: ${selectionGate}.`] : []),
    ]);
    const activityLimit = Math.min(maximumVisibleCopilotOverviewRuns, Math.max(1, allActive.length));
    const tightOverviewLeadLines = [
        `Specialists ${specialists.length} · lead cap 6 · Can delegate now: ${selectionGate ? "none" : compactMemberIds(eligibleSpecialists, 3)}`,
        ...(busySpecialists.length
            ? [`Busy (double-booking blocked): ${compactMemberIds(busySpecialists, 3)}`]
            : ["Busy: none"]),
        `SDLC coverage: ${enabledBundled}/${bundled.length} enabled · ${bundled.length - enabledBundled} benched${unhealthy ? ` · ${unhealthy} unhealthy` : ""}${enabledBundled === bundled.length ? "" : " · /bench on <id...>"}`,
    ].map(boundedCopilotTeamLine);
    const compactOverview = (personalLimit, runLimit) => {
        const selectedMembers = [...factoryMembers, ...personalMembers.slice(0, personalLimit)];
        const omittedPersonal = personalMembers.length - Math.min(personalLimit, personalMembers.length);
        const shownRuns = allActive.slice(0, runLimit);
        const overviewLines = [
            `Agent Harbor Copilot ${(options.title ?? "team")} · ${copilotPublicIdentifier(runtime.projectName(project), 40) ?? "project"} · 0 model tokens`,
            shared.authoritative
                ? `Team: ${ready} ready · ${allActive.length} active${activeBreakdown ? ` (${activeBreakdown})` : ""} · ${benched} benched · ${unhealthy} unhealthy`
                : `Team: persistent availability/activity unverified · ≥${allActive.length} process-visible active · ${benched} configured benched`,
            `Host default: ${overviewModel} · reasoning ${overviewReasoning} · max output ${overviewOutput}`,
            ...safetyLines,
            "LEAD ACCESS",
            ...tightOverviewLeadLines,
            ...(allActive.length
                ? [
                    "ACTIVITY · persistent players project-wide · contractors process-local",
                    ...shownRuns.flatMap(compactRunOverviewLines),
                    ...(allActive.length > shownRuns.length
                        ? [`+${allActive.length - shownRuns.length} active runs omitted; next /team page:2.`]
                        : []),
                ]
                : latest && latestMission.length
                    ? ["LAST MISSION", ...renderCompactMission(runtime, latest.rootRunId, latestMission)]
                    : ["ACTIVITY · persistent players project-wide · contractors process-local", emptyCopilotActivity(shared.authoritative)]),
            "ROSTER",
            ...renderCompactRoster(selectedMembers, activeMemberStates, shared.authoritative),
            ...(omittedPersonal
                ? [`+${omittedPersonal} personal member${omittedPersonal === 1 ? "" : "s"} omitted; use /team kind:personal page:1 or /team member:<id>.`]
                : []),
            "Actions: /team member:<id>|run:<id>|page:N · /<id> <task> · /team stop <run|all> · help",
        ];
        return overviewLines.map(boundedCopilotTeamLine);
    };
    for (let runLimit = activityLimit; runLimit >= Math.min(1, allActive.length); runLimit -= 1) {
        for (let personalLimit = 0; personalLimit >= 0; personalLimit -= 1) {
            const candidate = compactOverview(personalLimit, runLimit);
            if (candidate.length <= lineBudget)
                return candidate.join("\n");
        }
    }
    return clipCopilotTeamLines(compactOverview(0, Math.min(1, allActive.length)), lineBudget).join("\n");
}
