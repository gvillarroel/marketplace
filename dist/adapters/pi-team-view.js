/** Deterministic Pi team inventory and human-readable activity views. */
import { join, resolve } from "node:path";
import { bundledPlayers, rolePlayers, scoutPlayer } from "../core/defaults.js";
import { formatHarborTeamRosterSnapshot, maximumHarborTeamRosterMembers, } from "../core/custom-tools.js";
import { isOwnedProfile, validatePlayer } from "../core/lifecycle.js";
import { decodePlayer, harnessSpec, isCanonicalPlayerProfile } from "../core/profiles.js";
import { publicErrorText, publicMetadataText } from "../core/public-metadata.js";
import { canonicalProjectIdentity } from "../core/project-identity.js";
import { readSafeBoundedProfile } from "../core/safe-profile.js";
import { takeTerminalColumns, terminalLineWidth, wrapPlainLines } from "../core/text-layout.js";
import { runDeterministicCommand } from "./direct.js";
import { readSharedAgentActivities, } from "./opencode-agent-activity.js";
import { defaultHome } from "./shared.js";
import { formatElapsed, formatCost, formatCostAmount, formatPiRunDetails, formatModel, formatTokenCount, formatUsage, piPublicIdentifier, piTaskLabel, } from "./pi-team-runtime.js";
export const maximumVisiblePiRosterMembers = 32;
export const maximumVisiblePiOverviewRosterMembers = 12;
export const maximumVisiblePiOverviewRuns = 4;
export const maximumPiTeamOverviewLines = 30;
const maximumConcurrentPiProfileReads = 8;
const maximumProjectSharedPersistentClaims = 32;
function clipPiTeamLines(lines) {
    if (lines.length <= maximumPiTeamOverviewLines)
        return [...lines];
    const semanticOmissions = lines
        .filter((line) => /^\+\d+ .*?(?:roster member|active run|historical run).*omitted|^\+\d+ more roster members/u.test(line))
        .slice(0, 2);
    const prefix = lines.slice(0, maximumPiTeamOverviewLines - 1 - semanticOmissions.length);
    while (prefix.length && (!prefix[prefix.length - 1].trim()
        || /^(?:LEAD ACCESS|ACTIVITY|ROSTER|LAST MISSION)(?:\s*·.*)?$/u.test(prefix[prefix.length - 1]))) {
        prefix.pop();
    }
    const preserved = semanticOmissions.filter((line) => !prefix.includes(line));
    while (prefix.length + preserved.length >= maximumPiTeamOverviewLines)
        prefix.pop();
    const omitted = lines.length - prefix.length - preserved.length;
    return [
        ...prefix,
        ...preserved,
        `+${omitted} wrapped view lines omitted by the ${maximumPiTeamOverviewLines}-line budget; refine with /team <filter> or /team help.`,
    ];
}
function parseBenchRows(output) {
    const lines = output.split(/\r?\n/gu).map((line) => line.trim()).filter(Boolean);
    const rows = lines.flatMap((line) => {
        const match = /^([a-z0-9-]+) \| (bundled|personal) \| (on|bench|stale|conflict)$/u.exec(line.trim());
        return match ? [{ id: match[1], roster: match[2], state: match[3] }] : [];
    });
    if (rows.length !== lines.length)
        throw new Error("Agent Harbor bench inventory returned an unrecognized row; update or reload the extension");
    const bundled = new Set(rows.filter(({ roster }) => roster === "bundled").map(({ id }) => id));
    const missing = [...bundledPlayers.keys()].filter((id) => !bundled.has(id));
    if (missing.length)
        throw new Error(`Agent Harbor bench inventory is incomplete; missing bundled members: ${missing.join(", ")}`);
    return rows;
}
function capacity(definition, id = definition.name) {
    const capabilities = definition.tools.length ? [...definition.tools] : [id === "team-lead" ? "coordination" : "advisory"];
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
async function canonicalPersonalDefinition(project, root, path, id) {
    const content = await readSafeBoundedProfile(root, path);
    if (!content || !isOwnedProfile(content, id, "personal"))
        return undefined;
    const definition = validatePlayer(decodePlayer(content, id));
    return isCanonicalPlayerProfile(content, "pi", definition, "personal", resolve(project)) ? definition : undefined;
}
async function registeredPersonalDefinition(project, id) {
    try {
        const root = resolve(project);
        const spec = harnessSpec("pi", defaultHome("pi"), root);
        const path = join(spec.home, spec.registrationDir, `${id}${spec.extension}`);
        return await canonicalPersonalDefinition(root, spec.home, path, id);
    }
    catch {
        return undefined;
    }
}
async function personalDefinition(project, row) {
    if (row.state === "on") {
        try {
            const root = resolve(project);
            const spec = harnessSpec("pi", defaultHome("pi"), root);
            const path = join(root, spec.activeDir, `${row.id}${spec.extension}`);
            const active = await canonicalPersonalDefinition(root, root, path, row.id);
            if (active)
                return active;
        }
        catch { /* Fall back to registration metadata. */ }
    }
    return registeredPersonalDefinition(project, row.id);
}
async function mapWithConcurrency(values, maximumConcurrency, transform) {
    const results = new Array(values.length);
    let nextIndex = 0;
    const worker = async () => {
        while (nextIndex < values.length) {
            const index = nextIndex;
            nextIndex += 1;
            results[index] = await transform(values[index]);
        }
    };
    await Promise.all(Array.from({ length: Math.min(maximumConcurrency, values.length) }, () => worker()));
    return results;
}
/** Resolves every Pi-visible roster class without creating an SDK session or model turn. */
export async function collectPiTeamMembers(project) {
    project = canonicalProjectIdentity(project);
    const raw = await runDeterministicCommand("pi", "bench", "list", project);
    const benchRows = parseBenchRows(raw);
    const members = [];
    for (const [id, definition] of rolePlayers) {
        members.push({
            id,
            kind: id === "team-lead" ? "manager" : "fixed",
            availability: "ready",
            description: definition.description,
            capacity: capacity(definition, id),
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
    for (const row of benchRows.filter(({ roster }) => roster === "bundled")) {
        const definition = bundledPlayers.get(row.id);
        if (!definition)
            continue;
        members.push({
            id: row.id,
            kind: "bundled",
            availability: row.state === "on" ? "ready" : row.state,
            description: definition.description,
            capacity: capacity(definition),
            tools: memberTools(definition),
            skills: memberSkills(definition),
            ...(definition.model ? { configuredModel: definition.model } : {}),
            ...(row.state === "stale" ? { repairKind: "bundled-profile" } : {}),
        });
    }
    const personalRows = benchRows.filter(({ roster }) => roster === "personal").sort((a, b) => a.id.localeCompare(b.id));
    const personalDefinitions = await mapWithConcurrency(personalRows, maximumConcurrentPiProfileReads, (row) => personalDefinition(project, row));
    for (let index = 0; index < personalRows.length; index += 1) {
        const row = personalRows[index];
        const definition = personalDefinitions[index];
        members.push({
            id: row.id,
            kind: "personal",
            availability: row.state === "on" ? "ready" : row.state,
            description: definition?.description ?? (row.state === "conflict" ? "Unmanaged collision; metadata unavailable" : "Managed profile needs repair"),
            capacity: definition ? capacity(definition) : "unavailable until repaired",
            tools: definition ? memberTools(definition) : [],
            skills: definition ? memberSkills(definition) : [],
            ...(definition?.model ? { configuredModel: definition.model } : {}),
            ...(row.state === "stale" ? {
                repairKind: definition ? "personal-active" : "personal-registration",
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
const piTeamFilterFields = new Map([
    ["tool", "tool"],
    ["capability", "capability"],
    ["skill", "skill"],
    ["status", "status"],
    ["state", "status"],
    ["model", "model"],
    ["thinking", "thinking"],
    ["task", "task"],
    ["run", "run"],
    ["owner", "owner"],
    ["pid", "pid"],
    ["heartbeat", "heartbeat"],
    ["id", "member"],
    ["member", "member"],
    ["kind", "kind"],
    ["role", "kind"],
    ["description", "description"],
]);
const piPagePrefixes = new Map([
    ["roster-page", "roster"],
    ["activity-page", "activity"],
    ["history-page", "history"],
]);
function parsePiTeamPageRequest(filter, title) {
    const separator = filter.indexOf(":");
    if (separator < 0)
        return undefined;
    const prefix = filter.slice(0, separator).trim();
    const kind = piPagePrefixes.get(prefix) ?? (title === "bench" && prefix === "page" ? "roster" : undefined);
    if (!kind)
        return undefined;
    const rawPage = filter.slice(separator + 1).trim();
    if (!/^[1-9]\d{0,5}$/u.test(rawPage)) {
        throw new Error(`${prefix}: requires a positive page number, for example ${title === "bench" ? "/bench list page:1" : `/team ${prefix}:1`}`);
    }
    return { kind, page: Number(rawPage) };
}
function validatePiTeamFilter(filter, title) {
    if (!filter)
        return;
    const separator = filter.indexOf(":");
    if (separator < 0)
        return;
    const prefix = filter.slice(0, separator).trim();
    if (piPagePrefixes.has(prefix) || title === "bench" && prefix === "page") {
        parsePiTeamPageRequest(filter, title);
        return;
    }
    if (!piTeamFilterFields.has(prefix)) {
        throw new Error(`unsupported /team field “${publicMetadataText(prefix, 40) ?? "empty"}”. ` +
            "Use member, kind, description, capability, tool, skill, status, model, thinking, task, run, owner, pid, heartbeat, roster-page, activity-page, or history-page");
    }
    if (!filter.slice(separator + 1).trim()) {
        throw new Error(`${prefix}: requires a value; example /team ${prefix}:<value>`);
    }
}
function parsePiTeamFilter(filter) {
    const separator = filter.indexOf(":");
    if (separator < 0)
        return { value: filter };
    const field = piTeamFilterFields.get(filter.slice(0, separator).trim());
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
    const query = parsePiTeamFilter(filter);
    if (query.field === "tool")
        return includesFilter(member.tools ?? [], query.value);
    if (query.field === "capability")
        return includesFilter([member.capacity], query.value);
    if (query.field === "skill")
        return includesFilter(member.skills ?? [], query.value);
    if (query.field === "status") {
        return query.value === "idle"
            ? effectiveState === "ready"
            : equalsFilter([effectiveState], query.value);
    }
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
    const query = parsePiTeamFilter(filter);
    if (query.field === "status") {
        return query.value === "overdue"
            ? run.sharedHeartbeatOverdue === true
            : equalsFilter([run.state], query.value);
    }
    if (query.field === "heartbeat")
        return query.value === "overdue" && run.sharedHeartbeatOverdue === true;
    if (query.field === "run")
        return equalsFilter([run.id], query.value);
    if (query.field === "member")
        return includesFilter([run.agent], query.value);
    if (query.field === "kind")
        return equalsFilter([run.kind], query.value);
    if (run.projectSharedExternal) {
        if (query.field === "owner") {
            return equalsFilter([
                run.sharedOwnerRuntime,
                run.sharedOwnerRuntime ? `owner ${run.sharedOwnerRuntime}` : "runtime unverified",
            ], query.value);
        }
        if (query.field === "pid") {
            return equalsFilter([
                run.sharedOwnerProcessID === undefined ? undefined : String(run.sharedOwnerProcessID),
            ], query.value);
        }
        if (query.field)
            return false;
        return includesFilter([
            run.id,
            run.agent,
            run.sharedOwnerRuntime,
            run.sharedOwnerProcessID === undefined ? undefined : String(run.sharedOwnerProcessID),
            run.sharedOwnerRuntime ? `owner ${run.sharedOwnerRuntime}` : "owner runtime unverified",
            run.sharedOwnerProcessID === undefined ? undefined : `pid ${run.sharedOwnerProcessID}`,
        ], query.value)
            || equalsFilter([run.kind, run.state, run.sharedActivityKind], query.value);
    }
    if (query.field === "model")
        return includesFilter([formatModel(run)], query.value);
    if (query.field === "thinking")
        return equalsFilter([run.thinking ?? "unknown"], query.value);
    if (query.field === "task")
        return includesFilter([run.task], query.value);
    if (query.field)
        return false;
    return includesFilter([run.id, run.agent, run.task, formatModel(run)], query.value)
        || equalsFilter([run.kind, run.state, run.thinking ?? "unknown"], query.value);
}
function undisclosedTelemetryWarning(query, runs) {
    if (query.field && !["model", "thinking", "task"].includes(query.field))
        return undefined;
    const count = runs.filter(({ projectSharedExternal }) => projectSharedExternal).length;
    if (!count)
        return undefined;
    const fields = query.field ?? "task/model/thinking";
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
function renderActivity(runs, hasOtherActiveWork) {
    if (!runs.length)
        return [hasOtherActiveWork ? "No active work matches this filter." : "No project-shared persistent-player work is visible; disposable contractor work is process-local."];
    return runs.flatMap((run) => {
        const heading = run.projectSharedExternal
            ? `● ${piPublicIdentifier(run.agent, 18) ?? "unknown"} · run ${run.id} · ${run.kind} · ${run.state} · ${formatElapsed(run.elapsedMs)}`
            : `${run.parentRunId ? "↳" : "●"} ${run.agent} · run ${run.id}${run.parentRunId ? ` · parent ${run.parentRunId}` : ""} · ${run.kind} · ${run.state} · ${formatElapsed(run.elapsedMs)}`;
        if (run.projectSharedExternal) {
            return [
                heading,
                `  Task/model/thinking/usage: undisclosed · project-shared persistent player (${run.sharedActivityKind ?? "direct"}) · ${sharedOwnerInstruction(run)}.${run.sharedHeartbeatOverdue ? " Heartbeat overdue; admission remains blocked—recover or restart that process." : ""}`,
            ];
        }
        return [
            heading,
            `  Usage: ${formatUsage(run.usage, run.usageLowerBounds)}`,
            `  Provider ${formatCost(run.cost, run.costLowerBounds)}`,
            `  Task: “${run.task}”`,
            `  ${formatModel(run)} · thinking setting ${run.thinking ?? "unknown"} · model turns ${run.nativeMessagesLowerBound ? "≥" : ""}${run.nativeMessages}`,
        ];
    });
}
function compactPublicField(value, limit, fallback) {
    const display = piPublicIdentifier(value, limit) ?? fallback;
    const probe = piPublicIdentifier(value, Math.min(1_000, limit + 1));
    return `${display}${probe !== undefined && probe !== display ? " [abbr]" : ""}`;
}
function compactRunLines(run) {
    const agent = compactPublicField(run.agent, 18, "unknown");
    // Runtime and shared aliases are bounded at their sources. Keep the complete
    // value so copied filters and stop IDs remain valid.
    const id = run.id;
    const rawModel = run.observedModelsTruncated
        ? "mixed models +more"
        : run.observedModels.length > 1
            ? "mixed models"
            : run.model ? `${run.model.provider}/${run.model.id}` : "model unknown";
    const model = compactPublicField(rawModel, 8, "model unknown");
    const source = run.observedModels.length > 1 || run.observedModelsTruncated
        ? "observed"
        : run.modelSource ?? "source unknown";
    const thinking = compactPublicField(run.thinking ?? "unknown", 10, "unknown");
    const task = compactPublicField(piTaskLabel(run.task), 32, "task unavailable");
    if (run.projectSharedExternal) {
        return [
            `● ${agent} · ${run.state} ${formatElapsed(run.elapsedMs)} · project-shared persistent`,
            `  /team run:${id} · task/telemetry not disclosed · ${sharedOwnerInstruction(run)}`,
            ...(run.sharedHeartbeatOverdue ? ["  Heartbeat overdue; recover or restart the owning process."] : []),
        ];
    }
    return [
        `${run.parentRunId ? "↳" : "●"} ${agent} · ${run.state} ${formatElapsed(run.elapsedMs)} · task “${task}”`,
        `  /team run:${id} · model ${model} (${source}) · thinking ${thinking} · t${run.nativeMessagesLowerBound ? "≥" : ""}${run.nativeMessages}/${formatTokenCount(run.usage.total, run.usageLowerBounds.includes("total"))}tok/${formatCostAmount(run.cost.total, run.costLowerBounds.includes("total"))}`,
    ];
}
function sharedPiActivity(project, local, members) {
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
            kind: kinds.get(claim.agent) ?? "personal",
            task: "Undisclosed",
            state: claim.phase,
            startedAt: claim.startedAt,
            elapsedMs: Math.max(0, now - claim.startedAt),
            observedModels: [],
            observedModelsTruncated: false,
            usage: {},
            usageLowerBounds: [],
            cost: {},
            costLowerBounds: [],
            nativeMessages: 0,
            nativeMessagesLowerBound: false,
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
        "Repair (0 model tokens): inspect AGENT_HARBOR_ACTIVITY_HOME—or default Agent Harbor activity store—for permissions/content; restart owning processes; retry /team.",
    ];
}
function emptyPiActivity(authoritative) {
    return authoritative
        ? "No project-shared persistent-player work is visible; disposable contractor work is process-local."
        : "Persistent-player activity authority is unavailable; another process may be working. Disposable contractor work is process-local.";
}
function renderCompactRuns(runs, omittedLabel) {
    const shown = runs.slice(0, maximumVisiblePiOverviewRuns).flatMap(compactRunLines);
    return [
        ...shown,
        ...(runs.length > maximumVisiblePiOverviewRuns
            ? [`+${runs.length - maximumVisiblePiOverviewRuns} ${omittedLabel} omitted; enumerate with /team ${omittedLabel.includes("historical") ? "history" : "activity"}-page:1.`]
            : []),
    ];
}
function renderRoster(members, activeMemberStates, activityAuthoritative = true) {
    return members.flatMap((member) => {
        const localActivity = activeMemberStates.get(member.id);
        const activity = localActivity ?? (activityAuthoritative
            ? member.availability
            : `${member.availability} · project activity unverified`);
        const repairInstruction = memberRepair(member);
        const repair = repairInstruction ? [`  Repair: ${repairInstruction}`] : [];
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
function renderCompactRoster(members, activeMemberStates, activityAuthoritative = true) {
    const shown = members.slice(0, maximumVisiblePiOverviewRosterMembers).map((member) => {
        const localActivity = activeMemberStates.get(member.id);
        const activity = localActivity ?? (activityAuthoritative
            ? member.availability
            : `${member.availability} · project activity unverified`);
        return `${availabilitySymbol(member.availability)} ${member.id}${member.id === scoutPlayer.name ? " (/scout)" : ""} · ${member.kind} · ${activity}`;
    });
    return [
        ...shown,
        ...(members.length > maximumVisiblePiOverviewRosterMembers
            ? [`+${members.length - maximumVisiblePiOverviewRosterMembers} more roster members; enumerate with /team roster-page:1.`]
            : []),
    ];
}
function renderCompactMission(runtime, rootRunId, runs) {
    const root = runs.find((run) => run.parentRunId === undefined) ?? runs[0];
    if (!root)
        return ["No completed mission snapshot is available."];
    const total = runtime.missionUsage(rootRunId).total;
    const lowerBound = runtime.missionUsageLowerBounds(rootRunId).includes("total");
    const totalCost = runtime.missionCost(rootRunId).total;
    const costLowerBound = runtime.missionCostLowerBounds(rootRunId).includes("total");
    return [
        ...compactRunLines(root),
        `Mission: ${runs.length} tracked run${runs.length === 1 ? "" : "s"} · total ${formatTokenCount(total, lowerBound)} native tokens · ${formatCostAmount(totalCost, costLowerBound)} observed cost.`,
    ];
}
function compactMemberIds(members, limit = 12) {
    if (!members.length)
        return "none";
    const shown = members.slice(0, limit).map(({ id }) => id).join(", ");
    return members.length > limit ? `${shown} (+${members.length - limit} more)` : shown;
}
function renderCapacitySummary(summary) {
    const contractors = `${summary.localContractorRootCount} contractor${summary.localContractorRootCount === 1 ? "" : "s"}`;
    return [
        `Local root capacity: ${summary.localRootCount}/32 active · ${summary.localPersistentRootCount} persistent · ${contractors}`,
        summary.projectSharedPersistentClaimCount === undefined
            ? "Project-shared capacity: ?/32 claims (unverified) · roots + children; contractors excluded"
            : `Project-shared capacity: ${summary.projectSharedPersistentClaimCount}/32 claims · roots + delegated children; contractors excluded`,
    ];
}
function renderLeadAccess(members, working, capacitySummary, delegationBlockedBy) {
    const enabledSpecialists = members.filter((member) => member.id !== "team-lead"
        && member.kind !== "manager" && member.kind !== "utility" && member.availability === "ready");
    const busy = enabledSpecialists.filter((member) => working.has(member.id));
    const delegable = enabledSpecialists.filter((member) => !working.has(member.id));
    const overCapacity = enabledSpecialists.slice(maximumHarborTeamRosterMembers);
    const bundled = members.filter((member) => member.kind === "bundled");
    const benched = bundled.filter((member) => member.availability === "bench");
    const unhealthy = members.filter((member) => member.availability === "stale" || member.availability === "conflict");
    return [
        ...(overCapacity.length
            ? [
                `Enabled specialist roster limit exceeded: ${enabledSpecialists.length}/${maximumHarborTeamRosterMembers} · /team-lead preflight stops at 0 model tokens.`,
                ...renderCapacitySummary(capacitySummary),
                "Delegable now: none (enabled specialist count exceeds the complete model-facing roster limit)",
                `Reduce enabled roster: /bench off ${overCapacity.slice(0, 12).map(({ id }) => id).join(" ")}${overCapacity.length > 12 ? ` · +${overCapacity.length - 12} more; repeat with /team <filter>` : ""}`,
            ]
            : [
                `Enabled specialists: ${enabledSpecialists.length}/${maximumHarborTeamRosterMembers} roster limit`,
                ...renderCapacitySummary(capacitySummary),
                `Delegable now: ${delegationBlockedBy ? `none (${delegationBlockedBy})` : compactMemberIds(delegable)}`,
                ...(busy.length ? [`Busy (double-booking blocked): ${compactMemberIds(busy)}`] : []),
            ]),
        `SDLC coverage: ${bundled.length - benched.length - bundled.filter((member) => member.availability === "stale" || member.availability === "conflict").length}/${bundled.length} enabled · ${benched.length} benched`,
        ...(benched.length ? [`Enable SDLC: /bench on ${benched.map(({ id }) => id).join(" ")}`] : []),
        ...(unhealthy.length ? [`Repair before delegation: ${compactMemberIds(unhealthy)}`] : []),
    ];
}
function memberRepair(member) {
    if (member.repairKind === "bundled-profile" || member.repairKind === "personal-active") {
        return `/bench on ${member.id}; then /reload.`;
    }
    if (member.repairKind === "personal-registration") {
        return 're-run /join with the full definition and "replace":true; then /reload.';
    }
    if (member.availability === "conflict") {
        return "inspect the unmanaged collision; Agent Harbor will not overwrite it.";
    }
    return undefined;
}
function boundedPiTeamLine(value) {
    const [bounded, remainder] = takeTerminalColumns(value, terminalLineWidth);
    if (!remainder)
        return bounded.trimEnd();
    const [prefix] = takeTerminalColumns(value, terminalLineWidth - 1);
    return `${prefix.trimEnd()}…`;
}
function renderBenchMember(member, activeMemberStates, activityAuthoritative) {
    const localActivity = activeMemberStates.get(member.id);
    const activity = localActivity ?? (activityAuthoritative
        ? member.availability
        : `${member.availability} · activity unverified`);
    const model = publicMetadataText(member.configuredModel ?? "", 200);
    const tools = member.tools?.length ? member.tools.join(", ") : "none";
    const skills = member.skills?.length ? member.skills.join(", ") : "none";
    const repair = memberRepair(member);
    return [
        boundedPiTeamLine(`${availabilitySymbol(member.availability)} ${member.id}${member.id === scoutPlayer.name ? " (/scout)" : ""} · ${member.kind} · ${activity} · model: ${model ? `configured ${model}` : "inherits Pi host"}`),
        boundedPiTeamLine(`  Tools: ${tools} · Skills: ${skills}${repair ? ` · Repair: ${repair}` : ""} · Role: ${member.description}`),
    ];
}
function renderBenchView(header, teamSummary, members, allMembers, activeMemberStates, capacitySummary, activeCount, activeBreakdown, activityAuthoritative, warnings) {
    const enabledSpecialists = allMembers.filter((member) => member.id !== "team-lead"
        && member.kind !== "manager" && member.kind !== "utility" && member.availability === "ready").length;
    const prefix = [
        header,
        teamSummary,
        ...wrapPlainLines(warnings),
        `Enabled specialists: ${enabledSpecialists}/32 roster limit`,
        ...renderCapacitySummary(capacitySummary),
        activityAuthoritative
            ? `Activity: ${activeCount} active${activeBreakdown ? ` (${activeBreakdown})` : ""} · effective state is shown per member`
            : `Activity: ≥${activeCount} process-visible active · project-shared state is unverified`,
        "",
        "ROSTER",
    ];
    const suffix = [
        "",
        "Actions: /<id> · /bench on|off <id...> · /join <json> · /retire <id> · /team",
    ];
    const maximumWithoutOmission = Math.max(0, Math.floor((maximumPiTeamOverviewLines - prefix.length - suffix.length) / 2));
    const needsOmission = members.length > maximumWithoutOmission;
    const maximumMembers = needsOmission
        ? Math.max(0, Math.floor((maximumPiTeamOverviewLines - prefix.length - suffix.length - 1) / 2))
        : maximumWithoutOmission;
    const shown = members.slice(0, maximumMembers);
    const omitted = members.length - shown.length;
    return [
        ...prefix,
        ...shown.flatMap((member) => renderBenchMember(member, activeMemberStates, activityAuthoritative)),
        ...(omitted ? [`+${omitted} roster member${omitted === 1 ? "" : "s"} omitted; narrow with /bench list <filter>.`] : []),
        ...suffix,
    ].map(boundedPiTeamLine).join("\n");
}
function pageBounds(total, requested, size) {
    const pages = Math.max(1, Math.ceil(total / size));
    if (requested > pages)
        throw new Error(`page ${requested} is out of range; available pages: 1-${pages}`);
    const start = (requested - 1) * size;
    return { page: requested, pages, start, end: Math.min(total, start + size) };
}
function pageNavigation(kind, page, pages, bench) {
    const route = (value) => bench
        ? `/bench list page:${value}`
        : `/team ${kind}-page:${value}`;
    const links = [
        ...(page > 1 ? [`previous ${route(page - 1)}`] : []),
        ...(page < pages ? [`next ${route(page + 1)}`] : []),
    ];
    return links.length ? `Pages: ${links.join(" · ")}` : "Pages: complete on this page";
}
function renderPiRosterPage(header, members, activeMemberStates, activityAuthoritative, requestedPage, bench, warnings = []) {
    const bounds = pageBounds(members.length, requestedPage, 8);
    const rows = members.slice(bounds.start, bounds.end).flatMap((member) => {
        const activity = activeMemberStates.get(member.id) ?? (activityAuthoritative
            ? member.availability
            : `${member.availability} · activity unverified`);
        return [
            `${availabilitySymbol(member.availability)} ${member.id} · ${member.kind} · ${activity}`,
            `  Detail: /team member:${member.id}`,
        ];
    });
    return clipPiTeamLines(wrapPlainLines([
        header,
        ...warnings,
        `ROSTER INDEX · page ${bounds.page}/${bounds.pages} · showing ${members.length ? `${bounds.start + 1}-${bounds.end}` : "0"} of ${members.length}`,
        ...(rows.length ? rows : ["No roster members are configured."]),
        pageNavigation("roster", bounds.page, bounds.pages, bench),
        "Actions: /team member:<id> · /<id> <task> · /bench list · /team",
    ])).join("\n");
}
function renderPiActivityPage(header, runs, requestedPage, warnings = []) {
    const bounds = pageBounds(runs.length, requestedPage, 6);
    const rows = runs.slice(bounds.start, bounds.end).flatMap((run) => [
        `${run.state === "working" ? "●" : "↳"} ${run.agent} · ${run.state} · ${run.kind}`,
        `  Detail: /team run:${run.id}${run.projectSharedExternal ? ` · ${sharedOwnerInstruction(run)}` : ""}`,
    ]);
    return clipPiTeamLines(wrapPlainLines([
        header,
        ...warnings,
        `ACTIVE RUN INDEX · page ${bounds.page}/${bounds.pages} · showing ${runs.length ? `${bounds.start + 1}-${bounds.end}` : "0"} of ${runs.length}`,
        ...(rows.length ? rows : ["No active Agent Harbor runs are visible."]),
        pageNavigation("activity", bounds.page, bounds.pages, false),
        "Actions: /team run:<id> · /team stop <run-id|all> · /team",
    ])).join("\n");
}
function renderPiHistoryPage(header, runtime, roots, requestedPage, warnings = []) {
    const bounds = pageBounds(roots.length, requestedPage, 6);
    const rows = roots.slice(bounds.start, bounds.end).flatMap((root) => {
        const mission = runtime.mission(root.rootRunId);
        return [
            `${root.state === "completed" ? "●" : "!"} ${root.agent} · ${root.state} · ${mission.length} tracked run${mission.length === 1 ? "" : "s"}`,
            `  Detail: /team run:${root.id}`,
        ];
    });
    return clipPiTeamLines(wrapPlainLines([
        header,
        ...warnings,
        `MISSION HISTORY INDEX · page ${bounds.page}/${bounds.pages} · showing ${roots.length ? `${bounds.start + 1}-${bounds.end}` : "0"} of ${roots.length}`,
        ...(rows.length ? rows : ["No retained terminal missions are available."]),
        pageNavigation("history", bounds.page, bounds.pages, false),
        "Actions: /team run:<id> · /team history-page:1 · /team",
    ])).join("\n");
}
/** Formats roster plus live runtime data. This function performs no inference. */
export async function formatPiTeamView(project, runtime, options = {}) {
    project = canonicalProjectIdentity(project);
    const filter = options.filter?.trim().toLowerCase() ?? "";
    validatePiTeamFilter(filter, options.title);
    const pageRequest = parsePiTeamPageRequest(filter, options.title);
    const discoveryWarning = options.discoveryWarning === undefined
        ? undefined
        : publicErrorText(options.discoveryWarning, 240, ["/team", "/reload"])
            ?? "Pi command discovery is degraded; inspect /team and run /reload after repair.";
    const allMembers = await collectPiTeamMembers(project);
    const filterQuery = parsePiTeamFilter(filter);
    const activityOnlyFilter = filterQuery.field === "run";
    const localActive = runtime.activeProjectRuns(project);
    const shared = sharedPiActivity(project, localActive, allMembers);
    const unorderedActive = [...localActive, ...shared.runs];
    const rootOrder = new Map();
    for (const run of unorderedActive) {
        const current = rootOrder.get(run.rootRunId);
        if (current === undefined || run.sequence < current)
            rootOrder.set(run.rootRunId, run.sequence);
    }
    const allActive = unorderedActive.sort((a, b) => rootOrder.get(a.rootRunId) - rootOrder.get(b.rootRunId) || a.sequence - b.sequence);
    const filterTelemetryWarning = filter
        ? undisclosedTelemetryWarning(filterQuery, allActive)
        : undefined;
    const activeMemberStates = new Map(allActive
        .filter((run) => run.kind !== "contractor")
        .map((run) => [run.agent, run.state]));
    const retainedRoots = runtime.projectRuns(project)
        .filter((run) => run.parentRunId === undefined
        && !["starting", "working", "cleaning"].includes(run.state));
    if (pageRequest) {
        const pageHeader = `Agent Harbor ${(options.title ?? "team")} · ${piPublicIdentifier(runtime.projectName(project), 80) ?? "project"} · 0 model tokens`;
        const warnings = [
            ...(discoveryWarning ? [`Warning: ${discoveryWarning}`] : []),
            ...(pageRequest.kind === "activity" ? sharedActivityWarnings(shared) : []),
        ];
        if (pageRequest.kind === "roster") {
            return renderPiRosterPage(pageHeader, allMembers, activeMemberStates, shared.authoritative, pageRequest.page, options.title === "bench", warnings);
        }
        if (pageRequest.kind === "activity") {
            return renderPiActivityPage(pageHeader, allActive, pageRequest.page, warnings);
        }
        return renderPiHistoryPage(pageHeader, runtime, retainedRoots, pageRequest.page, warnings);
    }
    const members = allMembers.filter((member) => memberMatches(member, filter, activeMemberStates.get(member.id) ?? member.availability));
    const activity = allActive.filter((run) => activityMatches(run, filter));
    const latest = runtime.latestRoot(project);
    const latestMission = !allActive.length && latest ? runtime.mission(latest.rootRunId) : [];
    const retainedTerminalRuns = runtime.projectRuns(project)
        .filter((run) => !["starting", "working", "cleaning"].includes(run.state));
    const historicalUniverse = filter ? retainedTerminalRuns : latestMission;
    const historicalMatches = historicalUniverse.filter((run) => activityMatches(run, filter));
    const richDetails = Boolean(filter) && members.length + activity.length + historicalMatches.length <= 2;
    if (!members.length && !activity.length && !historicalMatches.length) {
        const shown = publicMetadataText(options.filter?.trim() ?? "", 80) || "the requested filter";
        return clipPiTeamLines(wrapPlainLines([
            `Agent Harbor ${(options.title ?? "team")} · 0 model tokens`,
            ...(discoveryWarning ? [`Warning: ${discoveryWarning}`] : []),
            filterTelemetryWarning
                ? `No team member or tracked activity matches “${shown}” in disclosed fields.`
                : `No team member or tracked activity matches “${shown}”.`,
            ...(filterTelemetryWarning ? [filterTelemetryWarning] : []),
            ...sharedActivityWarnings(shared),
            "Search by member ID, role, tool, skill, model, thinking, state, task label, run ID, owner runtime, or owner PID.",
            "Complete indexes: /team roster-page:1 · /team activity-page:1 · /team history-page:1.",
        ])).join("\n");
    }
    const working = new Set(activeMemberStates.keys());
    const ready = allMembers.filter((member) => member.availability === "ready" && !working.has(member.id)).length;
    const benched = allMembers.filter((member) => member.availability === "bench").length;
    const unhealthy = allMembers.filter((member) => member.availability === "stale" || member.availability === "conflict").length;
    const activeCounts = new Map();
    for (const run of allActive)
        activeCounts.set(run.state, (activeCounts.get(run.state) ?? 0) + 1);
    const activeBreakdown = ["working", "starting", "cleaning"]
        .flatMap((state) => activeCounts.has(state) ? [`${activeCounts.get(state)} ${state}`] : [])
        .join(" · ");
    const localRoots = localActive.filter(({ parentRunId }) => parentRunId === undefined);
    const capacitySummary = {
        localRootCount: localRoots.length,
        localPersistentRootCount: localRoots.filter(({ kind }) => kind !== "contractor").length,
        localContractorRootCount: localRoots.filter(({ kind }) => kind === "contractor").length,
        ...(shared.persistentClaimCount === undefined
            ? {}
            : { projectSharedPersistentClaimCount: shared.persistentClaimCount }),
    };
    const enabledRoster = allMembers.filter((member) => member.id !== "team-lead"
        && member.kind !== "manager" && member.kind !== "utility" && member.availability === "ready");
    const completeRoster = formatHarborTeamRosterSnapshot(enabledRoster.map((member) => ({
        id: member.id,
        role: member.description,
        tools: member.tools ?? [],
        skills: member.skills,
        ...(member.configuredModel ? { configuredModel: member.configuredModel } : {}),
        availability: working.has(member.id) ? "busy" : "ready",
    })));
    const activeLead = allActive.some(({ agent }) => agent === "team-lead");
    const sharedCapacityBlock = capacitySummary.projectSharedPersistentClaimCount === undefined
        ? undefined
        : activeLead
            ? capacitySummary.projectSharedPersistentClaimCount >= maximumProjectSharedPersistentClaims
                ? `project-shared capacity is ${capacitySummary.projectSharedPersistentClaimCount}/32; the active lead has no specialist slot`
                : undefined
            : capacitySummary.projectSharedPersistentClaimCount >= maximumProjectSharedPersistentClaims - 1
                ? `team-lead start needs two project-shared slots; capacity is ${capacitySummary.projectSharedPersistentClaimCount}/32`
                : undefined;
    const nextModelDisplay = options.nextModel
        ? `${piPublicIdentifier(options.nextModel.provider) ?? "unknown"}/${piPublicIdentifier(options.nextModel.id) ?? "unknown"} (inherited)`
        : options.nextModelUnavailable
            ? "unavailable (Pi reports no usable models; use /login)"
            : options.nextModelAvailableCount !== undefined
                ? `not selected (${options.nextModelAvailableCount} available; use /model)`
                : options.nextModelAvailabilityUnobserved
                    ? "no active model; availability unobserved (use /model or /login)"
                    : "unknown/default (unobserved)";
    const delegationBlockedBy = !shared.authoritative
        ? "project-shared activity authority unavailable; repair the managed activity store and retry /team"
        : !completeRoster.complete
            ? "the complete model-facing roster exceeds its safe count/16 KiB limit; shorten metadata or bench surplus members"
            : sharedCapacityBlock
                ? sharedCapacityBlock
                : options.nextModelUnavailable
                    ? "model unavailable"
                    : options.nextModelAvailableCount !== undefined
                        ? "select a model with /model"
                        : options.nextModelAvailabilityUnobserved
                            ? "model availability unobserved; use /model or /login"
                            : undefined;
    const header = `Agent Harbor ${(options.title ?? "team")} · ${piPublicIdentifier(runtime.projectName(project), 80) ?? "project"} · 0 model tokens`;
    const teamSummary = shared.authoritative
        ? `${filter ? "Overall Team" : "Team"}: ${ready} ready · ${allActive.length} active${activeBreakdown ? ` (${activeBreakdown})` : ""} · ${benched} benched · ${unhealthy} unhealthy`
        : `${filter ? "Overall Team" : "Team"}: persistent availability/activity unverified · ≥${allActive.length} process-visible active · ${benched} configured benched · ${unhealthy} unhealthy`;
    const exactRun = filterQuery.field === "run"
        ? activity.length === 1
            ? { run: activity[0], heading: "ACTIVE RUN · EXACT" }
            : historicalMatches.length === 1
                ? { run: historicalMatches[0], heading: "RETAINED HISTORY · EXACT RUN" }
                : undefined
        : undefined;
    if (exactRun) {
        return clipPiTeamLines(wrapPlainLines([
            header,
            ...(discoveryWarning ? [`Warning: ${discoveryWarning}`] : []),
            teamSummary,
            ...sharedActivityWarnings(shared),
            "",
            exactRun.heading,
            `Query: /team run:${exactRun.run.id}`,
            ...renderActivity([exactRun.run], false),
            "",
            "Back: /team · Stop local owner: /team stop <run-id|all> · Alt+H stop",
        ])).join("\n");
    }
    if (options.title === "bench" && !activityOnlyFilter) {
        return renderBenchView(header, teamSummary, members, allMembers, activeMemberStates, capacitySummary, allActive.length, activeBreakdown, shared.authoritative, sharedActivityWarnings(shared));
    }
    const lines = [
        header,
        ...(discoveryWarning ? [`Warning: ${discoveryWarning}`] : []),
        teamSummary,
        ...sharedActivityWarnings(shared),
        ...(filterTelemetryWarning ? [filterTelemetryWarning] : []),
        `Next default child: ${nextModelDisplay} · thinking setting ${piPublicIdentifier(options.nextThinking) ?? "unknown"} · model max output per response ${options.nextModel?.maxTokens === undefined ? "unknown" : `${formatTokenCount(options.nextModel.maxTokens)} tokens`}`,
        "",
        filter ? "LEAD ACCESS · OVERALL" : "LEAD ACCESS",
        ...renderLeadAccess(allMembers, working, capacitySummary, delegationBlockedBy),
        "",
        "ACTIVITY",
        "Scope: persistent players project-wide · disposable contractors process-local",
        ...(richDetails
            ? renderActivity(activity, allActive.length > 0)
            : activity.length
                ? renderCompactRuns(activity, filter ? "matching active runs" : "active runs")
                : [allActive.length ? "No active work matches this filter." : emptyPiActivity(shared.authoritative)]),
        ...(activityOnlyFilter
            ? []
            : [
                "",
                "ROSTER",
                ...(members.length
                    ? richDetails
                        ? [
                            ...renderRoster(members.slice(0, maximumVisiblePiRosterMembers), activeMemberStates, shared.authoritative),
                            ...(members.length > maximumVisiblePiRosterMembers
                                ? [`+${members.length - maximumVisiblePiRosterMembers} more roster members; use /team <filter> to narrow the view.`]
                                : []),
                        ]
                        : renderCompactRoster(members, activeMemberStates, shared.authoritative)
                    : ["No roster member matches this filter."]),
            ]),
    ];
    if (historicalMatches.length && (Boolean(filter) || !allActive.length && latest)) {
        const historyHeading = !filter
            ? "LAST MISSION"
            : filterQuery.field === "run"
                ? "RETAINED HISTORY · MATCHING RUNS"
                : "RETAINED HISTORY · MATCHING MEMBERS";
        lines.push("", historyHeading, ...(richDetails
            ? [...formatPiRunDetails(historicalMatches), "Filtered history · run /team without a filter for mission summary."]
            : filter
                ? renderCompactRuns(historicalMatches, "matching historical runs")
                : latest ? renderCompactMission(runtime, latest.rootRunId, latestMission) : []));
    }
    if (!richDetails)
        lines.push("", "Details: /team member:<id> · /team run:<id> · /team help");
    lines.push("", "Actions: /<id> · /contract · /scout · /bench · /join · /retire · /reload · Alt+H stop");
    const wrapped = wrapPlainLines(lines);
    if (wrapped.length <= maximumPiTeamOverviewLines) {
        return wrapped.join("\n");
    }
    if (filter || options.title === "bench")
        return clipPiTeamLines(wrapped).join("\n");
    // Filtered and bench views above retain semantic activity/roster omission
    // rows when clipping. Rebuild only an oversized unfiltered /team overview
    // from mandatory factory rows plus as many personal rows as fit.
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
    const overviewLeadLines = !shared.authoritative
        ? [
            `Enabled ${enabledSpecialists.length}/32 · Delegable now: none (project-shared activity authority unavailable)`,
            ...renderCapacitySummary(capacitySummary),
            `SDLC ${enabledBundled}/${bundled.length} on · ${enabledBundled === bundled.length
                ? "all enabled"
                : `enable: /bench on ${bundled.filter(({ availability }) => availability === "bench").map(({ id }) => id).join(" ")}`}`,
        ]
        : delegationBlockedBy
            ? renderLeadAccess(allMembers, working, capacitySummary, delegationBlockedBy)
            : ((enabledSpecialists.length <= 12
                && !(allActive.length > maximumVisiblePiOverviewRuns && busySpecialists.length === 0))
                || enabledSpecialists.length > 32
                ? renderLeadAccess(allMembers, working, capacitySummary)
                : [
                    `Enabled ${enabledSpecialists.length}/32 roster · ${enabledSpecialists.length - busySpecialists.length} delegable · ${busySpecialists.length} busy`,
                    ...renderCapacitySummary(capacitySummary),
                    `SDLC coverage: ${enabledBundled}/${bundled.length} enabled · ${bundled.length - enabledBundled} benched · enable with /bench on <id...>`,
                    ...(unhealthy ? [`Repair before delegation: ${unhealthy} unhealthy member${unhealthy === 1 ? "" : "s"}; filter status:stale or status:conflict.`] : []),
                ]);
    const compactOverview = (personalLimit, runLimit, factoryLimit = factoryMembers.length) => {
        const selectedFactory = factoryMembers.slice(0, factoryLimit);
        const selectedMembers = [...selectedFactory, ...personalMembers.slice(0, personalLimit)];
        const omittedFactory = factoryMembers.length - selectedFactory.length;
        const omittedPersonal = personalMembers.length - Math.min(personalLimit, personalMembers.length);
        const shownRuns = allActive.slice(0, runLimit);
        // Under heavy concurrency, live work wins the first viewport. Keep a
        // representative roster slice plus an exact discoverability count rather
        // than sacrificing the fourth current activity row to static members.
        const busyRosterLimit = allActive.length > maximumVisiblePiOverviewRuns ? 4 : selectedMembers.length;
        const shownMembers = selectedMembers.slice(0, busyRosterLimit);
        const omittedSelectedMembers = selectedMembers.length - shownMembers.length;
        const overviewLines = [
            `Agent Harbor ${(options.title ?? "team")} · ${piPublicIdentifier(runtime.projectName(project), 40) ?? "project"} · 0 model tokens`,
            ...(discoveryWarning ? [`Warning: ${discoveryWarning}`] : []),
            shared.authoritative
                ? `Team: ${ready} ready · ${allActive.length} active${activeBreakdown ? ` (${activeBreakdown})` : ""} · ${benched} benched · ${unhealthy} unhealthy`
                : `Team: persistent availability/activity unverified · ≥${allActive.length} active · ${benched} benched · ${unhealthy} unhealthy`,
            ...(shared.authoritative ? [] : sharedActivityWarnings(shared).slice(1)),
            `Next child: ${overviewModel} · thinking ${overviewThinking} · max output ${overviewOutput}`,
            "",
            "LEAD ACCESS",
            ...overviewLeadLines,
            "",
            ...(allActive.length
                ? [
                    "ACTIVITY",
                    ...shownRuns.flatMap(compactRunLines),
                    ...(allActive.length > shownRuns.length
                        ? [`+${allActive.length - shownRuns.length} active runs omitted; enumerate with /team activity-page:1.`]
                        : []),
                ]
                : latest && latestMission.length
                    ? ["LAST MISSION", ...renderCompactMission(runtime, latest.rootRunId, latestMission)]
                    : [
                        "ACTIVITY",
                        shared.authoritative
                            ? "No active persistent work; disposable contractors are visible only in their owning Pi process."
                            : "Activity authority unavailable; shared work may be hidden; contractors are process-local.",
                    ]),
            "",
            "ROSTER",
            ...renderCompactRoster(shownMembers, activeMemberStates, shared.authoritative),
            ...(omittedSelectedMembers
                ? [`+${omittedSelectedMembers} roster members omitted from this busy overview; use /team roster-page:1.`]
                : []),
            ...(omittedFactory
                ? [`+${omittedFactory} factory roster member${omittedFactory === 1 ? "" : "s"} omitted; use /team roster-page:1.`]
                : []),
            ...(omittedPersonal
                ? [`+${omittedPersonal} personal member${omittedPersonal === 1 ? "" : "s"} omitted; use /team roster-page:1.`]
                : []),
            "Details: /team member:<id> · /team run:<id> · /team help",
            "Actions: /<id> · /contract · /scout · /bench · /join · /retire · /reload · Alt+H stop",
        ];
        return wrapPlainLines(overviewLines);
    };
    for (let runLimit = activityLimit; runLimit >= Math.min(1, allActive.length); runLimit -= 1) {
        for (let personalLimit = Math.min(3, personalMembers.length); personalLimit >= 0; personalLimit -= 1) {
            const candidate = compactOverview(personalLimit, runLimit);
            if (candidate.length <= maximumPiTeamOverviewLines)
                return candidate.join("\n");
        }
    }
    for (let factoryLimit = factoryMembers.length - 1; factoryLimit >= 0; factoryLimit -= 1) {
        const candidate = compactOverview(0, Math.min(1, allActive.length), factoryLimit);
        if (candidate.length <= maximumPiTeamOverviewLines)
            return candidate.join("\n");
    }
    // In a degraded authority view, diagnostics and repair remain mandatory.
    // If even the factory roster must yield, keep an exact omission count and
    // the filters that recover every hidden member.
    return compactOverview(0, Math.min(1, allActive.length), 0).join("\n");
}
