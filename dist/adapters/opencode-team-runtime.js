/** Bounded, zero-model OpenCode team discovery and active-session control. */
import { createHash, randomBytes } from "node:crypto";
import { basename, resolve } from "node:path";
import { listInvocablePlayers, loadManagedActivePlayer } from "../core/active.js";
import { bundledPlayers, rolePlayers, scoutPlayer } from "../core/defaults.js";
import { looksLikeOpenCodeHarborTitle, loadOpenCodeHarborTitleVerifier, verifySignedOpenCodeHarborTitles, } from "../core/opencode-session-claims.js";
import { publicTaskLabel, redactPublicMetadata } from "../core/public-metadata.js";
import { isHarborId } from "../core/identity.js";
import { playerDefinitionDigest } from "../core/profiles.js";
import { hasOpenCodeCleanupHazard, openCodeCleanupHazardRecovery } from "../core/opencode-cleanup-hazards.js";
import { runDeterministicCommand } from "./direct.js";
import { readOpenCodeAgentConflicts } from "./opencode-agent-conflicts.js";
import { readOpenCodeAgentActivities, readOpenCodeAgentActivitiesIncludingStale, } from "./opencode-agent-activity.js";
import { defaultHome } from "./shared.js";
export const maximumOpenCodeSessions = 64;
export const maximumOpenCodeActiveSessions = 32;
export const maximumOpenCodeMessageSessions = 24;
export const maximumOpenCodeMessagesPerSession = 16;
export const maximumVisibleOpenCodeRosterMembers = 40;
export const maximumOpenCodeRosterRecords = 256;
export const maximumOpenCodeRosterSnapshotBytes = 16_384;
const maximumOpenCodeConfigProjects = 64;
const maximumOpenCodeDirectAliasCollisions = 256;
/**
 * Process-local bridge from the server config hook to the TUI snapshot. Alias
 * ownership is intentionally separate from agent ownership: a foreign slash
 * command can block /<id> while the Harbor native agent remains invocable.
 */
const directAliasCollisionsByProject = new Map();
/** Replaces the bounded direct-alias collision snapshot for one loaded project. */
export function recordOpenCodeDirectAliasCollisions(project, collisions) {
    const key = projectKey(project);
    directAliasCollisionsByProject.delete(key);
    const byAlias = new Map();
    for (const collision of collisions) {
        if (byAlias.size >= maximumOpenCodeDirectAliasCollisions)
            break;
        if (!isHarborId(collision.alias) || !isHarborId(collision.agent))
            continue;
        if (!byAlias.has(collision.alias)) {
            byAlias.set(collision.alias, { alias: collision.alias, agent: collision.agent });
        }
    }
    const bounded = [...byAlias.values()].sort((left, right) => left.alias.localeCompare(right.alias) || left.agent.localeCompare(right.agent));
    if (bounded.length)
        directAliasCollisionsByProject.set(key, bounded);
    while (directAliasCollisionsByProject.size > maximumOpenCodeConfigProjects) {
        const oldest = directAliasCollisionsByProject.keys().next().value;
        if (oldest === undefined)
            break;
        directAliasCollisionsByProject.delete(oldest);
    }
}
/** Returns defensive records so view callers cannot mutate config-hook state. */
export function readOpenCodeDirectAliasCollisions(project) {
    return (directAliasCollisionsByProject.get(projectKey(project)) ?? [])
        .map(({ alias, agent }) => ({ alias, agent }));
}
const privateRunSessionIDs = new WeakMap();
const privateRunAuthorities = new WeakMap();
const privateRunClaims = new WeakMap();
const privateReservationClaims = new WeakMap();
const privateSnapshotProjects = new WeakMap();
const privateSnapshotClaimsAuthoritative = new WeakMap();
const inFlightStopMutations = new Map();
const activeStopAttempts = new Map();
const activeStopCalls = new Map();
const pendingStopConfirmations = new Map();
const maximumPendingOpenCodeStopMutations = 64;
const harborIdPattern = /^[a-z0-9][a-z0-9-]{0,47}$/u;
function limits(options) {
    const positive = (value, fallback) => typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
    const bounded = (value, fallback, maximum) => Math.min(positive(value, fallback), maximum);
    return {
        rpcDeadlineMs: positive(options.rpcDeadlineMs, 750),
        collectionDeadlineMs: positive(options.collectionDeadlineMs, 1_800),
        maximumSessions: bounded(options.maximumSessions, maximumOpenCodeSessions, maximumOpenCodeSessions),
        maximumActiveSessions: bounded(options.maximumActiveSessions, maximumOpenCodeActiveSessions, maximumOpenCodeActiveSessions),
        maximumMessageSessions: bounded(options.maximumMessageSessions, maximumOpenCodeMessageSessions, maximumOpenCodeMessageSessions),
        maximumMessagesPerSession: bounded(options.maximumMessagesPerSession, maximumOpenCodeMessagesPerSession, maximumOpenCodeMessagesPerSession),
        maximumConcurrency: bounded(options.maximumConcurrency, 4, 4),
        now: options.now ?? Date.now,
        signal: options.signal,
    };
}
function object(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? value
        : undefined;
}
function nativeNumber(value) {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER
        ? value
        : undefined;
}
/** Strips terminal controls and bounds identifiers supplied by OpenCode. */
export function openCodePublicIdentifier(value, limit = 120) {
    if (typeof value !== "string")
        return undefined;
    const source = value.slice(0, Math.max(512, Math.min(4_096, limit * 8)));
    const normalized = source
        .replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, " ")
        .replace(/[\p{Cc}\p{Cf}\s]+/gu, " ")
        .trim();
    return normalized ? [...normalized].slice(0, limit).join("") : undefined;
}
function publicSessionID(value) {
    const normalized = openCodePublicIdentifier(value, 512);
    if (!normalized)
        return undefined;
    // Native IDs are host-controlled opaque data. Even a short, syntactically
    // plausible value can itself be a credential, so no native prefix is ever
    // copied into the public selector.
    const digest = createHash("sha256").update(value, "utf8").digest("base64url").slice(0, 20);
    return `run-${digest}`;
}
// A per-process secret prevents a public locator from becoming a reversible
// hash of the small PID space while keeping every refresh in this TUI stable.
const publicOwnerLocatorSalt = randomBytes(32);
function publicOwnerLocator(processID) {
    const digest = createHash("sha256")
        .update(publicOwnerLocatorSalt)
        .update(String(processID), "utf8")
        .digest("base64url")
        .slice(0, 12);
    return `owner-${digest}`;
}
/** Sanitizes descriptive/model text while preserving ordinary provider/model routes. */
export function openCodePublicLabel(value, limit = 500) {
    if (typeof value !== "string")
        return undefined;
    return openCodePublicIdentifier(redactPublicMetadata(value.slice(0, 4_096)), limit);
}
/** Produces a useful but lossy task label without retaining paths, URLs, or likely secrets. */
export function openCodeTaskLabel(task) {
    return publicTaskLabel(task.slice(0, 4_096), 72);
}
function projectKey(project) {
    const absolute = resolve(project);
    return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}
function stopMutationKey(project, authority, nativeSessionID) {
    return `${projectKey(project)}\u0000${authority}\u0000${nativeSessionID}`;
}
function stopAttemptKey(project, publicTargetID) {
    return `${projectKey(project)}\u0000${publicTargetID}`;
}
function model(value) {
    const record = object(value);
    if (!record)
        return undefined;
    const provider = openCodePublicLabel(record.providerID, 100);
    const id = openCodePublicLabel(record.id ?? record.modelID, 160);
    const variant = openCodePublicLabel(record.variant, 100);
    return provider && id ? { provider, id, ...(variant ? { variant } : {}) } : undefined;
}
function hostDefaultModel(api) {
    try {
        const configured = typeof api.state.config.model === "string" ? api.state.config.model : undefined;
        if (!configured || configured.length > 300 || Buffer.byteLength(configured, "utf8") > 600
            || /[\p{Cc}\p{Cf}]/u.test(configured))
            return undefined;
        const separator = configured.indexOf("/");
        if (separator <= 0 || separator === configured.length - 1)
            return undefined;
        const rawProvider = configured.slice(0, separator);
        const rawID = configured.slice(separator + 1);
        if (rawProvider.length > 100 || rawID.length > 160
            || rawProvider !== rawProvider.trim() || rawID !== rawID.trim())
            return undefined;
        const provider = openCodePublicLabel(rawProvider, 100);
        const id = openCodePublicLabel(rawID, 160);
        if (!provider || !id)
            return undefined;
        const providers = Array.isArray(api.state.provider) ? api.state.provider.slice(0, 256) : [];
        const nativeProvider = providers.find((candidate) => candidate.id === rawProvider);
        const nativeModel = nativeProvider?.models?.[rawID];
        const contextLimit = nativeNumber(nativeModel?.limit?.context);
        const outputLimit = nativeNumber(nativeModel?.limit?.output);
        return {
            provider, id,
            ...(contextLimit === undefined ? {} : { contextLimit }),
            ...(outputLimit === undefined ? {} : { outputLimit }),
        };
    }
    catch {
        return undefined;
    }
}
function tokens(value) {
    const record = object(value);
    const cache = object(record?.cache);
    return {
        ...(nativeNumber(record?.input) === undefined ? {} : { input: nativeNumber(record?.input) }),
        ...(nativeNumber(record?.output) === undefined ? {} : { output: nativeNumber(record?.output) }),
        ...(nativeNumber(record?.reasoning) === undefined ? {} : { reasoning: nativeNumber(record?.reasoning) }),
        ...(nativeNumber(cache?.read ?? record?.cacheRead) === undefined ? {} : { cacheRead: nativeNumber(cache?.read ?? record?.cacheRead) }),
        ...(nativeNumber(cache?.write ?? record?.cacheWrite) === undefined ? {} : { cacheWrite: nativeNumber(cache?.write ?? record?.cacheWrite) }),
        ...(nativeNumber(record?.total) === undefined ? {} : { total: nativeNumber(record?.total) }),
    };
}
function hasObservedTelemetry(values) {
    return Object.values(values).some((value) => value !== undefined);
}
const openCodeTokenComponentKeys = ["input", "output", "reasoning", "cacheRead", "cacheWrite"];
const openCodeNonReasoningTokenKeys = ["input", "output", "cacheRead", "cacheWrite"];
function addObservedToken(left, right) {
    return left > Number.MAX_SAFE_INTEGER - right
        ? { value: Number.MAX_SAFE_INTEGER, bounded: true }
        : { value: left + right, bounded: false };
}
function observedComponentSum(value) {
    let total = 0;
    let observed = 0;
    let bounded = false;
    for (const key of openCodeTokenComponentKeys) {
        const component = value[key];
        if (component === undefined)
            continue;
        observed += 1;
        const next = addObservedToken(total, component);
        total = next.value;
        bounded ||= next.bounded;
    }
    return {
        ...(observed ? { value: total } : {}),
        complete: observed === openCodeTokenComponentKeys.length,
        bounded,
    };
}
/**
 * OpenCode may report reasoning either inside output or beside it. A native
 * total is contradictory only when it falls outside both interpretations.
 */
function nativeTotalConflicts(value) {
    if (value.total === undefined)
        return false;
    let minimum = 0;
    for (const key of openCodeNonReasoningTokenKeys) {
        const component = value[key];
        if (component === undefined)
            continue;
        const next = addObservedToken(minimum, component);
        minimum = next.value;
    }
    if (value.total < minimum)
        return true;
    if (openCodeNonReasoningTokenKeys.some((key) => value[key] === undefined))
        return false;
    if (value.reasoning === undefined)
        return false;
    const maximum = addObservedToken(minimum, value.reasoning).value;
    return value.total > maximum;
}
async function withDeadline(invoke, timeoutMs, externalSignal) {
    if (externalSignal?.aborted)
        return { ok: false, timedOut: false };
    const controller = new AbortController();
    let timer;
    let abortListener;
    const operation = Promise.resolve().then(() => {
        if (externalSignal?.aborted)
            throw new Error("OpenCode team action was disposed");
        return invoke(controller.signal);
    }).then((value) => ({ ok: true, value }), () => ({ ok: false, timedOut: false }));
    const timeout = new Promise((resolveTimeout) => {
        timer = setTimeout(() => {
            controller.abort();
            resolveTimeout({ ok: false, timedOut: true });
        }, Math.max(1, timeoutMs));
    });
    const disposed = new Promise((resolveDisposed) => {
        if (!externalSignal)
            return;
        abortListener = () => {
            controller.abort();
            resolveDisposed({ ok: false, timedOut: false });
        };
        externalSignal.addEventListener("abort", abortListener, { once: true });
    });
    try {
        return await Promise.race([operation, timeout, disposed]);
    }
    finally {
        if (timer)
            clearTimeout(timer);
        if (abortListener)
            externalSignal?.removeEventListener("abort", abortListener);
    }
}
async function withOneShotMutationDeadline(key, pendingRecord, invoke, acceptResponse, timeoutMs, externalSignal) {
    return withDeadline(async (signal) => {
        if (inFlightStopMutations.has(key) || pendingStopConfirmations.has(key)) {
            throw new Error("OpenCode stop mutation is already pending");
        }
        const distinctPending = new Set([...inFlightStopMutations.keys(), ...pendingStopConfirmations.keys()]);
        if (!distinctPending.has(key) && distinctPending.size >= maximumPendingOpenCodeStopMutations) {
            throw new Error("OpenCode pending-stop safety capacity is exhausted");
        }
        // Publish the selector-bearing one-shot ledger before dispatch. The host
        // can mutate and publish terminal status before its response body crosses
        // the TUI worker boundary; no concurrent caller may enter that gap.
        pendingStopConfirmations.set(key, pendingRecord);
        const hostOperation = Promise.resolve().then(() => invoke(signal));
        const operation = hostOperation.then((value) => {
            acceptResponse(value);
            return value;
        });
        inFlightStopMutations.set(key, operation);
        try {
            return await operation;
        }
        finally {
            if (inFlightStopMutations.get(key) === operation)
                inFlightStopMutations.delete(key);
            // Once dispatched, transport rejection and malformed/error envelopes do
            // not prove the host mutation was not committed. Only terminal
            // reconciliation across both engines and the claim boundary may remove
            // the one-shot ledger.
        }
    }, timeoutMs, externalSignal);
}
function responseData(value) {
    const result = object(value);
    if (!result || result.error !== undefined && result.error !== null)
        throw new Error("OpenCode RPC failed");
    if (!Object.hasOwn(result, "data"))
        throw new Error("OpenCode RPC returned no data field");
    return result.data;
}
function parseBenchRows(output) {
    const lines = output.split(/\r?\n/gu).map((line) => line.trim()).filter(Boolean);
    const rows = lines.flatMap((line) => {
        const match = /^([a-z0-9-]+) \| (bundled|personal) \| (on|bench|stale|conflict)$/u.exec(line);
        return match ? [{ id: match[1], roster: match[2], state: match[3] }] : [];
    });
    if (rows.length !== lines.length)
        throw new Error("unrecognized bench inventory row");
    const bundled = new Set(rows.filter(({ roster }) => roster === "bundled").map(({ id }) => id));
    if ([...bundledPlayers.keys()].some((id) => !bundled.has(id)))
        throw new Error("incomplete bundled bench inventory");
    return rows;
}
function capacity(definition, id = definition.name) {
    const values = definition.tools.length
        ? [...definition.tools]
        : [id === "team-lead" ? "coordination" : "advisory"];
    for (const skill of definition.skills ?? [])
        values.push(`skill:${skill.name}`);
    return values.join(", ");
}
function member(id, definition, kind, availability) {
    return {
        id,
        kind,
        availability,
        description: openCodePublicLabel(definition.description, 500) ?? "Description unavailable",
        capacity: capacity(definition, id),
        tools: [...definition.tools],
        skills: (definition.skills ?? []).map(({ name }) => name),
        ...(openCodePublicLabel(definition.model, 200) ? { configuredModel: openCodePublicLabel(definition.model, 200) } : {}),
    };
}
function fixedMembers() {
    const members = [...rolePlayers].map(([id, definition]) => member(id, definition, id === "team-lead" ? "manager" : "fixed", "ready"));
    members.push(member(scoutPlayer.name, scoutPlayer, "utility", "ready"));
    return members;
}
function degradedMembers() {
    const members = fixedMembers();
    for (const [id, definition] of bundledPlayers) {
        members.push(member(id, definition, "bundled", "unavailable"));
    }
    return members;
}
/** True when this TUI session still exposes an agent ID, even if its definition is stale. */
export function isOpenCodeAgentConfigured(api, id) {
    try {
        const agents = object(api.state.config.agent);
        return Boolean(agents && Object.hasOwn(agents, id));
    }
    catch {
        return false;
    }
}
/** Proves that OpenCode loaded the same managed definition that is active now. */
export function isOpenCodeAgentLoaded(api, id, definition) {
    try {
        const agents = object(api.state.config.agent);
        const configured = object(agents?.[id]);
        if (!configured)
            return false;
        if (rolePlayers.has(id) || id === scoutPlayer.name)
            return true;
        const current = definition ?? loadManagedActivePlayer("opencode", api.state.path.directory, id);
        const metadata = object(configured.metadata);
        return metadata?.owner === "agent-foundry" && metadata.player === id && metadata.revision === "5" &&
            metadata.definitionDigest === playerDefinitionDigest(current);
    }
    catch {
        return false;
    }
}
function enabledAvailability(api, id, definition) {
    return isOpenCodeAgentLoaded(api, id, definition) ? "ready" : "reload-required";
}
function applyRuntimeAgentConflicts(project, members) {
    const conflicts = readOpenCodeAgentConflicts(project);
    return conflicts.size
        ? members.map((entry) => conflicts.has(entry.id) ? { ...entry, availability: "conflict" } : entry)
        : [...members];
}
async function collectRoster(api, project, runtime) {
    const read = await withDeadline((signal) => runDeterministicCommand("opencode", "bench", "list", project, signal), runtime.rpcDeadlineMs, runtime.signal);
    if (!read.ok)
        return {
            members: applyRuntimeAgentConflicts(project, degradedMembers()),
            degraded: "roster inventory unavailable; the six known bundled teammates are shown as unavailable",
        };
    try {
        if (read.value.length > maximumOpenCodeRosterSnapshotBytes ||
            Buffer.byteLength(read.value, "utf8") > maximumOpenCodeRosterSnapshotBytes) {
            throw new Error("roster snapshot exceeds its 16 KiB safety bound");
        }
        const rows = parseBenchRows(read.value);
        if (rows.length > maximumOpenCodeRosterRecords) {
            throw new Error(`roster snapshot exceeds its ${maximumOpenCodeRosterRecords}-record safety bound`);
        }
        const definitions = new Map(listInvocablePlayers("opencode", project).map(({ id, definition }) => [id, definition]));
        const members = fixedMembers();
        for (const row of rows.filter(({ roster }) => roster === "bundled")) {
            const definition = bundledPlayers.get(row.id);
            if (definition)
                members.push(member(row.id, definition, "bundled", row.state === "on" ? enabledAvailability(api, row.id, definition) : row.state));
        }
        for (const row of rows.filter(({ roster }) => roster === "personal").sort((a, b) => a.id.localeCompare(b.id))) {
            const definition = definitions.get(row.id);
            members.push(definition
                ? member(row.id, definition, "personal", row.state === "on" ? enabledAvailability(api, row.id, definition) : row.state)
                : {
                    id: row.id,
                    kind: "personal",
                    availability: row.state === "on" ? "stale" : row.state,
                    description: row.state === "conflict" ? "Unmanaged collision; metadata unavailable" : "Managed definition unavailable until repaired",
                    capacity: "unavailable until repaired",
                    tools: [],
                    skills: [],
                });
        }
        return { members: applyRuntimeAgentConflicts(project, members) };
    }
    catch {
        return {
            members: applyRuntimeAgentConflicts(project, degradedMembers()),
            degraded: "roster inventory was incomplete or changed; the six known bundled teammates are shown as unavailable",
        };
    }
}
function parseSession(value, project) {
    const record = object(value);
    if (!record || typeof record.id !== "string" || !record.id || record.id.length > 512)
        return undefined;
    const location = object(record.location);
    const directory = typeof location?.directory === "string"
        ? location.directory
        : typeof record.directory === "string" ? record.directory : undefined;
    if (!directory || directory.length > 4_096 || projectKey(directory) !== projectKey(project))
        return undefined;
    // Every host-controlled native ID receives a stable public digest alias.
    const publicID = publicSessionID(record.id);
    // Authorization inputs stay byte-for-byte exact. Sanitization is for
    // display only; normalizing controls here could turn a spoof into a roster
    // or signed-title match.
    const title = typeof record.title === "string" && record.title.length <= 512 ? record.title : undefined;
    const time = object(record.time);
    const createdAt = nativeNumber(time?.created);
    const updatedAt = nativeNumber(time?.updated);
    if (!publicID || !title || createdAt === undefined || updatedAt === undefined)
        return undefined;
    const parentID = typeof record.parentID === "string" && record.parentID.length <= 512 ? record.parentID : undefined;
    const agent = typeof record.agent === "string" && record.agent.length <= 48 && harborIdPattern.test(record.agent)
        ? record.agent
        : undefined;
    return {
        nativeID: record.id,
        publicID,
        ...(parentID ? { parentID } : {}),
        title,
        ...(agent ? { agent } : {}),
        ...(model(record.model) ? { model: model(record.model) } : {}),
        ...(nativeNumber(record.cost) === undefined ? {} : { cost: nativeNumber(record.cost) }),
        tokens: tokens(record.tokens),
        createdAt,
        updatedAt,
    };
}
function parseFetchedSession(value, project) {
    const record = object(value);
    const location = object(record?.location);
    const directory = typeof location?.directory === "string"
        ? location.directory
        : typeof record?.directory === "string" ? record.directory : undefined;
    if (!directory)
        return { scope: "invalid" };
    if (projectKey(directory) !== projectKey(project)) {
        // `/api/session/active` is global. Validate foreign records before silently
        // omitting them so ordinary multi-project use is not reported as damage.
        return parseSession(record, directory) ? { scope: "foreign" } : { scope: "invalid" };
    }
    const session = parseSession(record, project);
    return session ? { scope: "project", session } : { scope: "invalid" };
}
function parseSessionList(value, project, maximum) {
    const page = object(responseData(value));
    if (!page || !Array.isArray(page.data))
        throw new Error("invalid OpenCode session page");
    const sessions = [];
    let malformed = 0;
    for (const value of page.data.slice(0, maximum)) {
        const session = parseSession(value, project);
        if (session)
            sessions.push(session);
        else
            malformed += 1;
    }
    // OpenCode 1.18.4 (unchanged from the pinned 1.18.3 SDK surface) emits both
    // cursor directions even when following either token produces an empty page.
    // The only truthful proof of truncation is an over-read item from this page;
    // callers therefore request maximum + 1.
    return { sessions, truncated: page.data.length > maximum, malformed };
}
function parseActive(value, maximum, preferred) {
    const envelope = object(responseData(value));
    const body = object(envelope?.data);
    if (!body)
        throw new Error("invalid OpenCode active-session response");
    const running = [];
    let unknownEntries = 0;
    let preferredUnknownEntries = 0;
    let inspected = 0;
    let responseTruncated = false;
    const seen = new Set();
    const inspect = (id, status, preferredEntry = false) => {
        if (seen.has(id))
            return;
        seen.add(id);
        const state = object(status);
        if (!id || id.length > 512 || state?.type !== "running") {
            unknownEntries += 1;
            if (preferredEntry)
                preferredUnknownEntries += 1;
        }
        else
            running.push(id);
    };
    // Global active telemetry may contain many unrelated projects. Always
    // inspect scoped/listed targets before applying the global response bound.
    for (const id of preferred) {
        if (id && Object.hasOwn(body, id))
            inspect(id, body[id], true);
    }
    for (const id in body) {
        if (!Object.hasOwn(body, id))
            continue;
        if (seen.has(id))
            continue;
        inspected += 1;
        if (inspected > maximum + 64) {
            responseTruncated = true;
            break;
        }
        inspect(id, body[id]);
    }
    const preferredOrder = new Map(preferred.map((id, index) => [id, index]));
    running.sort((left, right) => (preferredOrder.get(left) ?? Number.MAX_SAFE_INTEGER) - (preferredOrder.get(right) ?? Number.MAX_SAFE_INTEGER)
        || left.localeCompare(right));
    return {
        ids: running.slice(0, maximum), unknownEntries, preferredUnknownEntries,
        truncated: responseTruncated || running.length > maximum,
    };
}
function parseLegacyStatus(value, maximum, preferred) {
    const body = object(responseData(value));
    if (!body)
        throw new Error("invalid OpenCode legacy session-status response");
    const running = [];
    const retrying = new Set();
    let unknownEntries = 0;
    let preferredUnknownEntries = 0;
    let inspected = 0;
    let responseTruncated = false;
    const seen = new Set();
    const inspect = (id, status, preferredEntry = false) => {
        if (seen.has(id))
            return;
        seen.add(id);
        const state = object(status);
        const validID = Boolean(id) && id.length <= 512;
        const validRetry = state?.type === "retry" &&
            Number.isSafeInteger(state.attempt) && state.attempt >= 0 &&
            typeof state.message === "string" && state.message.length <= 1_024 &&
            nativeNumber(state.next) !== undefined;
        if (!validID || state?.type !== "idle" && state?.type !== "busy" && !validRetry) {
            unknownEntries += 1;
            if (preferredEntry)
                preferredUnknownEntries += 1;
            return;
        }
        if (state.type === "busy" || state.type === "retry") {
            running.push(id);
            if (state.type === "retry")
                retrying.add(id);
        }
    };
    // This legacy endpoint is project-scoped. Inspect every requested identity
    // before the global response bound so unrelated status volume cannot hide an
    // exact target, while `stop all` can still reject an incomplete inventory.
    for (const id of preferred) {
        if (id && Object.hasOwn(body, id))
            inspect(id, body[id], true);
    }
    for (const id in body) {
        if (!Object.hasOwn(body, id) || seen.has(id))
            continue;
        inspected += 1;
        if (inspected > maximum + 64) {
            responseTruncated = true;
            break;
        }
        inspect(id, body[id]);
    }
    const preferredOrder = new Map(preferred.map((id, index) => [id, index]));
    running.sort((left, right) => (preferredOrder.get(left) ?? Number.MAX_SAFE_INTEGER) - (preferredOrder.get(right) ?? Number.MAX_SAFE_INTEGER)
        || left.localeCompare(right));
    return {
        ids: running.slice(0, maximum),
        retryingIDs: running.slice(0, maximum).filter((id) => retrying.has(id)),
        unknownEntries, preferredUnknownEntries,
        truncated: responseTruncated || running.length > maximum,
    };
}
function parseMessages(value, maximum) {
    const page = object(responseData(value));
    if (!page || !Array.isArray(page.data) || page.data.length > maximum + 1) {
        throw new Error("invalid OpenCode message page");
    }
    // Deliberately project at the trust boundary. In particular, never retain
    // assistant prose, reasoning, tool input/output, snapshots, or errors in the
    // team-observability pipeline merely because the SDK returned them.
    const messages = [];
    const ids = new Set();
    let priorCreated = Number.POSITIVE_INFINITY;
    let priorID = "";
    for (let index = 0; index < page.data.length; index += 1) {
        const item = page.data[index];
        const message = object(item);
        if (!message || typeof message.type !== "string") {
            throw new Error("invalid OpenCode v2 message");
        }
        if (message.type !== "user" && message.type !== "assistant" &&
            message.type !== "agent-switched" && message.type !== "model-switched" &&
            message.type !== "system" && message.type !== "shell" &&
            message.type !== "compaction" && message.type !== "synthetic") {
            throw new Error("unknown OpenCode v2 message type");
        }
        const id = message.id;
        const time = object(message.time);
        const created = nativeNumber(time?.created);
        if (typeof id !== "string" || !id || id.length > 512 || created === undefined || ids.has(id)) {
            throw new Error("ambiguous OpenCode v2 message identity");
        }
        // The v2 endpoint is newest-first. Every consumer below treats the first
        // user/agent-switch as the current turn boundary, so accepting ascending or
        // unstable equal-time rows could authorize a stop against a replacement
        // turn. Validate the over-read row too and fail closed on any ambiguity.
        if (created > priorCreated || created === priorCreated && id >= priorID) {
            throw new Error("ambiguous OpenCode v2 message order");
        }
        priorCreated = created;
        priorID = id;
        ids.add(id);
        if (index >= maximum)
            continue;
        const common = { id, time: { created } };
        if (message.type === "system" || message.type === "shell" ||
            message.type === "compaction" || message.type === "synthetic")
            continue;
        if (message.type === "user") {
            messages.push({ ...common, type: "user", text: typeof message.text === "string" ? message.text.slice(0, 4_096) : "" });
            continue;
        }
        if (message.type === "assistant") {
            const observedModel = model(message.model);
            const observedTokens = tokens(message.tokens);
            messages.push({
                ...common,
                type: "assistant",
                ...(openCodePublicIdentifier(message.agent, 80) ? { agent: openCodePublicIdentifier(message.agent, 80) } : {}),
                ...(observedModel ? { model: {
                        providerID: observedModel.provider, id: observedModel.id,
                        ...(observedModel.variant ? { variant: observedModel.variant } : {}),
                    } } : {}),
                ...(Object.keys(observedTokens).length ? { tokens: observedTokens } : {}),
                ...(nativeNumber(message.cost) === undefined ? {} : { cost: nativeNumber(message.cost) }),
            });
            continue;
        }
        if (message.type === "agent-switched") {
            const agent = openCodePublicIdentifier(message.agent, 80);
            if (!agent)
                throw new Error("invalid OpenCode v2 agent-switch message");
            messages.push({ ...common, type: "agent-switched", agent });
            continue;
        }
        if (message.type === "model-switched") {
            const observedModel = model(message.model);
            if (!observedModel)
                throw new Error("invalid OpenCode v2 model-switch message");
            messages.push({ ...common, type: "model-switched", model: {
                    providerID: observedModel.provider, id: observedModel.id,
                    ...(observedModel.variant ? { variant: observedModel.variant } : {}),
                } });
        }
    }
    // OpenCode emits both cursor directions for any non-empty page, including a
    // complete one. Only the bounded over-read item proves truncation.
    return { messages, truncated: page.data.length > maximum };
}
function parseLegacyMessages(value, maximum, expectedSessionID, includePublicTelemetry = false) {
    const body = responseData(value);
    if (!Array.isArray(body) || body.length > maximum + 1) {
        throw new Error("invalid OpenCode legacy session-message response");
    }
    // The legacy endpoint returns chronological `{ info, parts }` entries. Keep
    // only bounded public fields from `info`. After session-level ownership is
    // proven, callers may opt into bounded user text for a redacted task label;
    // assistant prose, reasoning, tool data, snapshots, and errors never cross.
    const messages = [];
    const ids = new Set();
    let priorCreated = -1;
    let priorID = "";
    for (const item of body.slice(Math.max(0, body.length - maximum))) {
        const record = object(item);
        const info = object(record?.info);
        const parts = record?.parts;
        const role = info?.role;
        const id = info?.id;
        const sessionID = info?.sessionID;
        const created = nativeNumber(object(info?.time)?.created);
        if ((role !== "user" && role !== "assistant") ||
            typeof id !== "string" || !id || id.length > 512 ||
            sessionID !== expectedSessionID || created === undefined) {
            throw new Error("invalid OpenCode legacy message identity");
        }
        if (ids.has(id) || created < priorCreated || created === priorCreated && id <= priorID) {
            throw new Error("ambiguous OpenCode legacy message order");
        }
        ids.add(id);
        priorCreated = created;
        priorID = id;
        if (role === "user") {
            const agent = info.agent;
            if (typeof agent !== "string" || !harborIdPattern.test(agent)) {
                throw new Error("invalid OpenCode legacy user-agent identity");
            }
            let text = "";
            if (includePublicTelemetry) {
                if (!Array.isArray(parts) || parts.length > 64)
                    throw new Error("invalid OpenCode legacy user parts");
                for (const partValue of parts) {
                    const part = object(partValue);
                    if (part?.type === "text" && typeof part.text === "string" && text.length < 4_096) {
                        if (typeof part.id !== "string" || !part.id || part.id.length > 512 ||
                            part.sessionID !== expectedSessionID || part.messageID !== id) {
                            throw new Error("invalid OpenCode legacy text-part identity");
                        }
                        text += part.text.slice(0, 4_096 - text.length);
                    }
                }
            }
            messages.push({ id, type: "user", agent, ...(includePublicTelemetry ? { text } : {}), time: { created } });
        }
        else {
            const observedModel = model({ providerID: info.providerID, id: info.modelID, variant: info.variant });
            const observedTokens = tokens(info.tokens);
            messages.push({
                id,
                type: "assistant",
                time: { created },
                ...(includePublicTelemetry && openCodePublicIdentifier(info.agent, 80)
                    ? { agent: openCodePublicIdentifier(info.agent, 80) }
                    : {}),
                ...(includePublicTelemetry && observedModel ? { model: {
                        providerID: observedModel.provider,
                        id: observedModel.id,
                        ...(observedModel.variant ? { variant: observedModel.variant } : {}),
                    } } : {}),
                ...(includePublicTelemetry && Object.keys(observedTokens).length ? { tokens: observedTokens } : {}),
                ...(includePublicTelemetry && nativeNumber(info.cost) !== undefined ? { cost: nativeNumber(info.cost) } : {}),
            });
        }
    }
    return { messages: messages.reverse(), truncated: body.length > maximum };
}
function currentSessionID(api) {
    try {
        const route = api.route?.current;
        if (route?.name !== "session")
            return undefined;
        const id = object(route.params)?.sessionID;
        return typeof id === "string" && id.length <= 512 ? id : undefined;
    }
    catch {
        return undefined;
    }
}
function stateSession(api, project, id) {
    try {
        return parseSession(api.state.session.get(id), project);
    }
    catch {
        return undefined;
    }
}
function stateMessages(api, id, maximum, deadlineAt) {
    try {
        const infos = api.state.session.messages(id);
        const messages = [];
        let truncated = infos.length > maximum;
        // TUI state is chronological. Walk only its bounded newest suffix and emit
        // descending order to match the v2 messages endpoint.
        for (let index = infos.length - 1; index >= Math.max(0, infos.length - maximum); index -= 1) {
            if (Date.now() >= deadlineAt) {
                truncated = true;
                break;
            }
            const info = infos[index];
            if (info.role === "user") {
                const parts = api.state.part(info.id);
                if (parts.length > 16)
                    truncated = true;
                let text = "";
                for (const part of parts.slice(0, 16)) {
                    if (part.type !== "text" || typeof part.text !== "string")
                        continue;
                    const remaining = 4_096 - text.length;
                    if (remaining <= 0) {
                        truncated = true;
                        break;
                    }
                    const next = part.text;
                    text += `${text ? "\n" : ""}${next.slice(0, remaining)}`;
                    if (next.length > remaining)
                        truncated = true;
                }
                const id = typeof info.id === "string" && info.id.length <= 512 ? info.id : undefined;
                const created = nativeNumber(info.time?.created);
                messages.push({
                    ...(id ? { id } : {}), type: "user", text,
                    ...(created === undefined ? {} : { time: { created } }),
                });
                continue;
            }
            const observedModel = model({ providerID: info.providerID, id: info.modelID });
            const observedTokens = tokens(info.tokens);
            const cost = nativeNumber(info.cost);
            messages.push({
                ...(typeof info.id === "string" && info.id.length <= 512 ? { id: info.id } : {}),
                type: "assistant",
                ...(openCodePublicIdentifier(info.agent, 80) ? { agent: openCodePublicIdentifier(info.agent, 80) } : {}),
                ...(observedModel ? { model: {
                        providerID: observedModel.provider, id: observedModel.id,
                        ...(observedModel.variant ? { variant: observedModel.variant } : {}),
                    } } : {}),
                ...(Object.keys(observedTokens).length ? { tokens: observedTokens } : {}),
                ...(cost === undefined ? {} : { cost }),
                ...(nativeNumber(info.time?.created) === undefined ? {} : { time: { created: nativeNumber(info.time?.created) } }),
            });
        }
        return { messages, truncated };
    }
    catch {
        return undefined;
    }
}
function stateIsActive(api, id) {
    try {
        const status = api.state.session.status(id);
        return status?.type === "busy" ? "working" : status?.type === "retry" ? "retrying" : undefined;
    }
    catch {
        return undefined;
    }
}
async function mapWithConcurrency(values, concurrency, deadlineAt, transform) {
    const results = [];
    let next = 0;
    const worker = async () => {
        for (;;) {
            if (Date.now() >= deadlineAt || next >= values.length)
                return;
            const index = next;
            next += 1;
            results.push(await transform(values[index]));
        }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()));
    return { results, omitted: Math.max(0, values.length - next) };
}
function latestObservedModel(messages) {
    for (const message of messages) {
        if (message.type !== "assistant" && message.type !== "model-switched")
            continue;
        const observed = model(message.model);
        if (observed)
            return observed;
    }
    return undefined;
}
function taskFrom(messages, contract) {
    const latest = messages.find((message) => message.type === "user" && typeof message.text === "string");
    if (!latest || typeof latest.text !== "string")
        return { label: "(task not disclosed)", observed: false };
    let task = latest.text;
    if (contract) {
        const marker = "\nTask:\n";
        const index = task.lastIndexOf(marker);
        if (index >= 0)
            task = task.slice(index + marker.length);
    }
    return { label: openCodeTaskLabel(task), observed: true };
}
function currentTurnMessages(messages) {
    const boundary = messages.findIndex(({ type }) => type === "user" || type === "agent-switched");
    const startedAt = boundary < 0 ? undefined : nativeNumber(object(messages[boundary].time)?.created);
    const nativeBoundaryID = boundary < 0 ? undefined : messages[boundary].id;
    const boundaryID = typeof nativeBoundaryID === "string" && nativeBoundaryID.length <= 512
        ? `sha256:${createHash("sha256").update(nativeBoundaryID, "utf8").digest("base64url").slice(0, 22)}`
        : undefined;
    return boundary < 0
        ? { messages, boundaryObserved: false }
        : {
            messages: messages.slice(0, boundary), boundaryObserved: true,
            ...(boundaryID === undefined ? {} : { boundaryID }),
            ...(startedAt === undefined ? {} : { startedAt }),
        };
}
function observedUsage(session, messages, allowSessionAggregate) {
    if (allowSessionAggregate && (hasObservedTelemetry(session.tokens) || session.cost !== undefined)) {
        const componentTotal = observedComponentSum(session.tokens);
        const effectiveTotal = session.tokens.total ?? componentTotal.value;
        const totalSource = session.tokens.total !== undefined
            ? "native"
            : componentTotal.value !== undefined ? "observed-components" : undefined;
        const totalLowerBound = session.tokens.total === undefined && componentTotal.value !== undefined &&
            (!componentTotal.complete || componentTotal.bounded);
        return {
            usage: {
                ...(session.tokens.input === undefined ? {} : { input: session.tokens.input }),
                ...(session.tokens.output === undefined ? {} : { output: session.tokens.output }),
                ...(session.tokens.reasoning === undefined ? {} : { reasoning: session.tokens.reasoning }),
                ...(session.tokens.cacheRead === undefined ? {} : { cacheRead: session.tokens.cacheRead }),
                ...(session.tokens.cacheWrite === undefined ? {} : { cacheWrite: session.tokens.cacheWrite }),
                ...(effectiveTotal === undefined ? {} : { total: effectiveTotal }),
                ...(session.cost === undefined ? {} : { cost: session.cost }),
            },
            ...(totalSource === undefined ? {} : { totalSource }),
            ...(totalLowerBound ? { totalLowerBound: true } : {}),
            ...(nativeTotalConflicts(session.tokens) ? { totalConflict: true } : {}),
            turns: messages.filter(({ type }) => type === "assistant").length || undefined,
            scope: "session-total",
            ...(componentTotal.bounded ? { bounded: true } : {}),
        };
    }
    const assistants = messages.filter(({ type }) => type === "assistant");
    const totals = {
        input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0,
    };
    const observed = new Set();
    const observedCounts = new Map();
    let bounded = false;
    let nativeTotals = 0;
    let componentTotals = 0;
    let totalLowerBound = false;
    let totalConflict = false;
    for (const assistant of assistants) {
        const nativeTokens = tokens(assistant.tokens);
        for (const key of openCodeTokenComponentKeys) {
            const value = nativeTokens[key];
            if (value !== undefined) {
                const next = addObservedToken(totals[key], value);
                totals[key] = next.value;
                bounded ||= next.bounded;
                observed.add(key);
                observedCounts.set(key, (observedCounts.get(key) ?? 0) + 1);
            }
        }
        const componentTotal = observedComponentSum(nativeTokens);
        const effectiveTotal = nativeTokens.total ?? componentTotal.value;
        if (effectiveTotal !== undefined) {
            const next = addObservedToken(totals.total, effectiveTotal);
            totals.total = next.value;
            bounded ||= next.bounded || componentTotal.bounded;
            observed.add("total");
            observedCounts.set("total", (observedCounts.get("total") ?? 0) + 1);
            if (nativeTokens.total !== undefined) {
                nativeTotals += 1;
                totalConflict ||= nativeTotalConflicts(nativeTokens);
            }
            else {
                componentTotals += 1;
                totalLowerBound ||= !componentTotal.complete || componentTotal.bounded;
            }
        }
        const cost = nativeNumber(assistant.cost);
        if (cost !== undefined) {
            const next = addObservedToken(totals.cost, cost);
            totals.cost = next.value;
            bounded ||= next.bounded;
            observed.add("cost");
            observedCounts.set("cost", (observedCounts.get("cost") ?? 0) + 1);
        }
    }
    const totalSource = nativeTotals && componentTotals
        ? "mixed"
        : nativeTotals ? "native"
            : componentTotals ? "observed-components" : undefined;
    const lowerBounds = [...observed].filter((key) => (observedCounts.get(key) ?? 0) < assistants.length);
    if (totalLowerBound && observed.has("total") && !lowerBounds.includes("total"))
        lowerBounds.push("total");
    return {
        usage: Object.fromEntries([...observed].map((key) => [key, totals[key]])),
        ...(lowerBounds.length ? { lowerBounds } : {}),
        ...(totalSource ? { totalSource } : {}),
        ...(totalLowerBound ? { totalLowerBound: true } : {}),
        ...(totalConflict ? { totalConflict: true } : {}),
        turns: assistants.length || undefined,
        scope: allowSessionAggregate ? "session-total" : "current-turn",
        ...(bounded ? { bounded: true } : {}),
    };
}
function classifyRuns(sessions, messages, members, titleClaims, directActivityAgents, stateByID, now) {
    const memberByID = new Map(members.map((entry) => [entry.id, entry]));
    const directlyOwnedByID = new Map(members
        .filter(({ availability }) => availability !== "conflict" && availability !== "unavailable")
        .map((entry) => [entry.id, entry]));
    const partial = sessions.flatMap((session) => {
        const page = messages.get(session.nativeID) ?? { messages: [], truncated: true };
        const claim = titleClaims.get(session.nativeID);
        // SessionV2Info.agent is authoritative for direct sessions. Historical
        // assistant messages are telemetry only and can never establish ownership.
        const activityAgent = directActivityAgents.get(session.nativeID);
        const directAgent = !claim && activityAgent && directlyOwnedByID.has(activityAgent)
            ? activityAgent
            : !claim && directlyOwnedByID.has(session.agent ?? "") ? session.agent : undefined;
        if (!claim && !directAgent)
            return [];
        const invocation = claim
            ? claim.invocation === "agent" ? "delegated" : "contract"
            : "direct";
        const agent = claim?.agent ?? directAgent;
        const roster = memberByID.get(agent);
        // A direct command reuses the user's TUI session, whose aggregate tokens and
        // cost may include unrelated earlier agents. Attribute only assistant
        // messages after the latest visible user boundary. Disposable Harbor child
        // sessions may safely expose their whole-session aggregate.
        const observedTurn = currentTurnMessages(page.messages);
        const directTurn = invocation === "direct" ? observedTurn : undefined;
        const telemetryMessages = directTurn?.messages ?? page.messages;
        const telemetry = observedUsage(session, telemetryMessages, invocation !== "direct");
        const turnModel = latestObservedModel(telemetryMessages);
        // A reused direct session can retain an old session-level model after the
        // current user turn starts. Only a model observed inside that turn may be
        // attributed to the direct run; disposable sessions own their aggregate.
        const effectiveModel = invocation === "direct" ? turnModel : turnModel ?? session.model;
        const task = taskFrom(page.messages, invocation === "contract");
        const telemetryLowerBound = telemetry.bounded === true || (invocation === "direct"
            ? page.truncated && !directTurn?.boundaryObserved
            : page.truncated && !hasObservedTelemetry(session.tokens) && session.cost === undefined);
        const startedAt = invocation === "direct"
            ? directTurn?.startedAt ?? session.updatedAt
            : session.createdAt;
        return [{
                id: session.publicID,
                _nativeSessionID: session.nativeID,
                agent,
                kind: invocation === "contract" ? "contractor" : roster?.kind ?? "personal",
                rosterState: roster?.availability ?? "retired-or-unlisted",
                invocation,
                state: stateByID.get(session.nativeID) ?? "working",
                task: task.label,
                taskObserved: task.observed,
                startedAt,
                elapsedMs: Math.max(0, now - startedAt),
                ...(observedTurn.boundaryID === undefined ? {} : { turnBoundaryID: observedTurn.boundaryID }),
                ...(observedTurn.startedAt === undefined ? {} : { turnBoundaryAt: observedTurn.startedAt }),
                ...(effectiveModel ? { model: effectiveModel } : {}),
                usage: telemetry.usage,
                ...(telemetry.lowerBounds?.length ? { usageLowerBounds: telemetry.lowerBounds } : {}),
                ...(telemetry.totalSource === undefined ? {} : { usageTotalSource: telemetry.totalSource }),
                ...(telemetry.usage.total === undefined || !(telemetry.totalLowerBound || telemetryLowerBound || telemetry.lowerBounds?.includes("total"))
                    ? {} : { usageTotalLowerBound: true }),
                ...(telemetry.totalConflict ? { usageTotalConflict: true } : {}),
                ...(telemetry.scope === undefined ? {} : { usageScope: telemetry.scope }),
                ...(telemetry.turns === undefined ? {} : { observedAssistantTurns: telemetry.turns }),
                observedAssistantTurnsLowerBound: page.truncated && !(invocation === "direct" && directTurn?.boundaryObserved),
                telemetryLowerBound,
                ...(telemetry.bounded ? { telemetryBounded: true } : {}),
                _parentID: session.parentID,
            }];
    });
    const byNative = new Map(partial.map((run) => [run._nativeSessionID, run]));
    const directLeads = partial.filter((run) => run.invocation === "direct" && run.agent === "team-lead");
    const completed = partial.map((run) => {
        const observedParent = run._parentID ? byNative.get(run._parentID) : undefined;
        const inferredParent = !observedParent && run.invocation !== "direct" && directLeads.length === 1
            ? directLeads[0]
            : undefined;
        const { _nativeSessionID, _parentID: _discard, ...publicFields } = run;
        const publicRun = {
            ...publicFields,
            ...(observedParent ? { parentRunId: observedParent.id, parentSource: "observed" }
                : inferredParent ? { parentRunId: inferredParent.id, parentSource: "inferred" } : {}),
        };
        privateRunSessionIDs.set(publicRun, _nativeSessionID);
        return publicRun;
    });
    return completed.sort((left, right) => {
        if (left.parentRunId === right.id)
            return 1;
        if (right.parentRunId === left.id)
            return -1;
        return left.startedAt - right.startedAt || left.id.localeCompare(right.id);
    });
}
/** Collects an active-only, bounded OpenCode roster snapshot without inference. */
export async function collectOpenCodeTeamSnapshot(api, options = {}) {
    const runtime = limits(options);
    const project = resolve(api.state.path.directory);
    const deadlineAt = Date.now() + runtime.collectionDeadlineMs;
    const current = currentSessionID(api);
    const degraded = [];
    if (hasOpenCodeCleanupHazard(project)) {
        degraded.push(`${openCodeCleanupHazardRecovery}; new delegated or contract children remain blocked until that inspection and reload`);
    }
    let observedClaims = [];
    let claimsAuthoritative = true;
    try {
        observedClaims = readOpenCodeAgentActivities(project);
    }
    catch (error) {
        claimsAuthoritative = false;
        degraded.push(error instanceof Error && /publication recovery is required/u.test(error.message)
            ? "Agent Harbor cross-isolate activity publication requires filesystem recovery; lifecycle activity and claim-based stop remain disabled until the orphan claim link is inspected"
            : "Agent Harbor cross-isolate activity claims are unavailable; lifecycle activity and claim-based stop are disabled");
    }
    if (observedClaims.some(({ heartbeatOverdue }) => heartbeatOverdue)) {
        degraded.push("One or more owner claims have an overdue heartbeat; those teammates remain busy and claim-based stop is disabled until the owning OpenCode process recovers or restarts");
    }
    const claimByNativeSession = new Map();
    const ambiguousClaimSessions = new Set();
    for (const claim of observedClaims) {
        // A delegated starting claim still names only its lead/owner session. It
        // must not authorize, suppress, or retarget that lead's native activity.
        if (claim.kind === "delegated" && claim.phase === "starting")
            continue;
        if (claimByNativeSession.has(claim.sessionID))
            ambiguousClaimSessions.add(claim.sessionID);
        else
            claimByNativeSession.set(claim.sessionID, claim);
    }
    for (const sessionID of ambiguousClaimSessions)
        claimByNativeSession.delete(sessionID);
    if (ambiguousClaimSessions.size) {
        degraded.push("Ambiguous cross-isolate claim identities were kept separate from native run telemetry; claim-based stop is disabled for them");
    }
    const scopedPendingStops = [...pendingStopConfirmations.values()]
        .filter((pending) => pending.project === projectKey(project));
    const pendingNativeIDs = scopedPendingStops.map(({ nativeSessionID }) => nativeSessionID);
    const sessionListPromise = withDeadline((signal) => api.client.v2.session.list({ directory: project, limit: runtime.maximumSessions + 1, order: "desc" }, { signal }), runtime.rpcDeadlineMs, runtime.signal);
    const activePromise = withDeadline((signal) => api.client.v2.session.active({ signal }), runtime.rpcDeadlineMs, runtime.signal);
    const legacyStatusPromise = withDeadline((signal) => api.client.session.status({ directory: project }, { signal }), runtime.rpcDeadlineMs, runtime.signal);
    const [roster, listed, activeResponse, legacyStatusResponse] = await Promise.all([
        collectRoster(api, project, runtime), sessionListPromise, activePromise, legacyStatusPromise,
    ]);
    if (roster.degraded)
        degraded.push(roster.degraded);
    let sessions = [];
    let sessionListTruncated = false;
    if (listed.ok) {
        try {
            const page = parseSessionList(listed.value, project, runtime.maximumSessions);
            sessions = page.sessions;
            sessionListTruncated = page.truncated;
            if (page.malformed)
                degraded.push(`${page.malformed} session record(s) were ignored because ownership or project scope was invalid`);
        }
        catch {
            degraded.push("OpenCode session inventory returned an incompatible response");
        }
    }
    else
        degraded.push(`OpenCode session inventory ${listed.timedOut ? "timed out" : "is unavailable"}`);
    let active;
    if (activeResponse.ok) {
        try {
            active = parseActive(activeResponse.value, runtime.maximumActiveSessions, [current ?? "", ...pendingNativeIDs, ...sessions.map(({ nativeID }) => nativeID)]);
            if (active.unknownEntries)
                degraded.push(`${active.unknownEntries} active-session status entr${active.unknownEntries === 1 ? "y was" : "ies were"} ignored as unknown telemetry`);
        }
        catch {
            degraded.push("OpenCode active-session inventory returned an incompatible response; stop is disabled");
        }
    }
    else
        degraded.push(`OpenCode active-session inventory ${activeResponse.timedOut ? "timed out" : "is unavailable"}; stop is disabled`);
    let legacyActive;
    if (legacyStatusResponse.ok) {
        try {
            legacyActive = parseLegacyStatus(legacyStatusResponse.value, runtime.maximumActiveSessions, [current ?? "", ...pendingNativeIDs, ...claimByNativeSession.keys(), ...sessions.map(({ nativeID }) => nativeID)]);
            if (legacyActive.unknownEntries) {
                degraded.push(`${legacyActive.unknownEntries} legacy session-status entr${legacyActive.unknownEntries === 1 ? "y was" : "ies were"} ignored as unknown telemetry`);
            }
        }
        catch {
            degraded.push("OpenCode legacy session-status inventory returned an incompatible response; legacy stop is disabled");
        }
    }
    else {
        degraded.push(`OpenCode legacy session-status inventory ${legacyStatusResponse.timedOut ? "timed out" : "is unavailable"}; direct-command and child stop are disabled`);
    }
    const byID = new Map(sessions.map((session) => [session.nativeID, session]));
    const v2ActiveIDs = new Set(active?.ids ?? []);
    const legacyActiveIDs = new Set(legacyActive?.ids ?? []);
    if (claimsAuthoritative) {
        const scopedProject = projectKey(project);
        for (const [key, pending] of pendingStopConfirmations) {
            if (pending.project !== scopedProject)
                continue;
            let terminal = false;
            if (legacyStatusResponse.ok && activeResponse.ok) {
                try {
                    const exactLegacy = parseLegacyStatus(legacyStatusResponse.value, runtime.maximumActiveSessions, [pending.nativeSessionID]);
                    const exactV2 = parseActive(activeResponse.value, runtime.maximumActiveSessions, [pending.nativeSessionID]);
                    terminal = exactLegacy.preferredUnknownEntries === 0 && exactV2.preferredUnknownEntries === 0 &&
                        !exactLegacy.ids.includes(pending.nativeSessionID) && !exactV2.ids.includes(pending.nativeSessionID);
                }
                catch {
                    terminal = false;
                }
            }
            // A locally timed-out worker mutation can still execute after status
            // briefly looks terminal. Reconcile only after its host promise settles.
            if (terminal && !inFlightStopMutations.has(key) &&
                !activeStopCalls.has(projectKey(project)) &&
                !activeStopAttempts.has(stopAttemptKey(project, pending.publicTargetID)) &&
                activityClaimBoundaryUnchanged(project, pending.nativeSessionID)) {
                pendingStopConfirmations.delete(key);
            }
        }
    }
    const activeOrder = [
        ...claimByNativeSession.keys(),
        ...(current ? [current] : []),
        ...sessions.map(({ nativeID }) => nativeID),
        ...(legacyActive?.ids ?? []),
        ...(active?.ids ?? []),
    ].filter((id, index, values) => (legacyActiveIDs.has(id) || v2ActiveIDs.has(id)) && values.indexOf(id) === index);
    let activeListTruncated = Boolean(active?.truncated || legacyActive?.truncated || activeOrder.length > runtime.maximumActiveSessions);
    const activeIDs = activeOrder.slice(0, runtime.maximumActiveSessions);
    const cacheFallbackIDs = new Set();
    let unresolvedActiveSessions = 0;
    if (active || legacyActive) {
        const missing = activeIDs.filter((id) => !byID.has(id));
        const fetched = await mapWithConcurrency(missing, runtime.maximumConcurrency, deadlineAt, async (id) => {
            const remaining = Math.min(runtime.rpcDeadlineMs, Math.max(1, deadlineAt - Date.now()));
            const legacy = legacyActiveIDs.has(id);
            const result = await withDeadline((signal) => legacy
                ? api.client.session.get({ sessionID: id, directory: project }, { signal })
                : api.client.v2.session.get({ sessionID: id }, { signal }), remaining, runtime.signal);
            if (!result.ok)
                return { id, scope: "invalid" };
            try {
                if (legacy) {
                    const session = parseSession(responseData(result.value), project);
                    return session ? { id, scope: "project", session } : { id, scope: "invalid" };
                }
                const envelope = object(responseData(result.value));
                return { id, ...parseFetchedSession(envelope?.data, project) };
            }
            catch {
                return { id, scope: "invalid" };
            }
        });
        const foreign = new Set();
        for (const result of fetched.results) {
            if (result.scope === "project")
                byID.set(result.session.nativeID, result.session);
            else if (result.scope === "foreign")
                foreign.add(result.id);
        }
        if (fetched.omitted)
            activeListTruncated = true;
        const unresolved = missing.filter((id) => !byID.has(id) && !foreign.has(id)).length;
        unresolvedActiveSessions = unresolved + fetched.omitted;
        if (unresolved)
            degraded.push(`${unresolved} active session(s) could not be inspected within the bounded deadline`);
        sessions = activeIDs.flatMap((id) => byID.has(id) ? [byID.get(id)] : []);
    }
    else
        sessions = [];
    if ((!active || !legacyActive) && current && !sessions.some(({ nativeID }) => nativeID === current)) {
        const fallback = stateSession(api, project, current);
        const fallbackState = stateIsActive(api, current);
        if (fallback && fallbackState) {
            sessions.push(fallback);
            cacheFallbackIDs.add(current);
            degraded.push("current activity comes from the TUI cache and is not authorized for stop");
        }
    }
    const stateByID = new Map();
    for (const id of legacyActive?.retryingIDs ?? [])
        stateByID.set(id, "retrying");
    if (current && (!active && !legacyActive || activeIDs.includes(current))) {
        const status = stateIsActive(api, current);
        if (status)
            stateByID.set(current, status);
    }
    const titleClaims = new Map();
    let titleClaimsAuthoritative = true;
    const titleCandidates = sessions.filter(({ title }) => looksLikeOpenCodeHarborTitle(title));
    if (titleCandidates.length) {
        const remaining = Math.min(runtime.rpcDeadlineMs, Math.max(1, deadlineAt - Date.now()));
        const verified = await withDeadline(() => verifySignedOpenCodeHarborTitles(defaultHome("opencode"), project, titleCandidates.map(({ title, nativeID }) => ({ title, sessionID: nativeID }))), remaining, runtime.signal);
        if (verified.ok) {
            for (let index = 0; index < titleCandidates.length; index += 1) {
                const claim = verified.value[index];
                if (claim)
                    titleClaims.set(titleCandidates[index].nativeID, claim);
            }
            const rejected = titleCandidates.length - titleClaims.size;
            if (rejected)
                degraded.push(`${rejected} unsigned or tampered Harbor-titled session(s) were omitted; restart legacy work with the current extension`);
        }
        else {
            titleClaimsAuthoritative = false;
            degraded.push("signed Harbor child provenance could not be verified; disposable sessions were omitted");
        }
    }
    const directlyOwnedIDs = new Set(roster.members
        .filter(({ availability }) => availability !== "conflict" && availability !== "unavailable")
        .map(({ id }) => id));
    const workingClaims = new Map([...claimByNativeSession].filter(([, claim]) => claim.processID === process.pid && !claim.heartbeatOverdue && claim.phase === "working" &&
        legacyActiveIDs.has(claim.sessionID)));
    const directActivityAgents = new Map([...workingClaims]
        .filter(([, claim]) => claim.kind === "direct")
        .map(([sessionID, claim]) => [sessionID, claim.agent]));
    const authorityByID = new Map();
    const dualActiveSessionIDs = new Set([...legacyActiveIDs].filter((id) => v2ActiveIDs.has(id)));
    const unclaimedDualReservations = [];
    const candidateSessions = sessions.filter((session) => {
        if (!claimsAuthoritative)
            return false;
        // Multiple generations claiming one native ID revoke all content and stop
        // authority before message fanout, even when raw agent/title metadata
        // would otherwise resemble a Harbor-owned session.
        if (ambiguousClaimSessions.has(session.nativeID))
            return false;
        const titleClaim = titleClaims.get(session.nativeID);
        const activityClaim = workingClaims.get(session.nativeID);
        const anyClaim = claimByNativeSession.get(session.nativeID);
        // A claim that is stale, foreign-process, non-working, or no longer backed
        // by legacy status may remain visibly busy as a reservation, but it cannot
        // authorize a message read or inherit native stop authority.
        if (anyClaim && !activityClaim)
            return false;
        const activityOwned = activityClaim?.kind === "direct"
            ? directlyOwnedIDs.has(activityClaim.agent)
            : activityClaim?.kind === "delegated" && titleClaim?.invocation === "agent" &&
                titleClaim.agent === activityClaim.agent;
        const owned = Boolean(activityOwned || titleClaim ||
            !looksLikeOpenCodeHarborTitle(session.title) && directlyOwnedIDs.has(session.agent ?? ""));
        if (!owned)
            return false;
        if (cacheFallbackIDs.has(session.nativeID))
            return true;
        const inLegacy = legacyActiveIDs.has(session.nativeID);
        const inV2 = v2ActiveIDs.has(session.nativeID);
        if (inLegacy && inV2) {
            // A claim or signed title proves Harbor origin, but cannot prove which
            // of two independent engines owns the currently executing generation.
            // Calling either route could leave the other active and falsely report
            // success, so every dual-active identity fails closed.
            degraded.push("One Harbor candidate appeared active in both OpenCode run registries; it was omitted because one stop authority could not be proven");
            if (!anyClaim) {
                const dualAgent = titleClaim?.agent ?? session.agent;
                const dualInvocation = titleClaim?.invocation === "contract"
                    ? "contract"
                    : titleClaim?.invocation === "agent"
                        ? "delegated"
                        : "direct";
                if (dualAgent)
                    unclaimedDualReservations.push({
                        id: session.publicID,
                        agent: dualAgent,
                        invocation: dualInvocation,
                        phase: "working",
                        startedAt: session.createdAt,
                        elapsedMs: Math.max(0, runtime.now() - session.createdAt),
                        stopAvailable: false,
                        stopBlockReason: "dual-engine",
                    });
            }
            return false;
        }
        if (inLegacy)
            authorityByID.set(session.nativeID, "legacy");
        else if (inV2)
            authorityByID.set(session.nativeID, "v2");
        else
            return false;
        return true;
    });
    const selectedForMessages = candidateSessions.slice(0, runtime.maximumMessageSessions);
    let messageFanoutTruncated = candidateSessions.length > selectedForMessages.length;
    const claimIdentityDriftSessions = new Set();
    const messageClaimBoundaries = new Map(candidateSessions.map((session) => {
        const claim = workingClaims.get(session.nativeID);
        return [session.nativeID, claim ? {
                sessionID: claim.sessionID,
                processID: claim.processID,
                claimToken: claim.claimToken,
                agent: claim.agent,
                kind: claim.kind,
                phase: claim.phase,
            } : undefined];
    }));
    const messageReads = await mapWithConcurrency(selectedForMessages, runtime.maximumConcurrency, deadlineAt, async (session) => {
        const remaining = Math.min(runtime.rpcDeadlineMs, Math.max(1, deadlineAt - Date.now()));
        const authority = authorityByID.get(session.nativeID);
        const expectedActivityClaim = messageClaimBoundaries.get(session.nativeID);
        if (!activityClaimBoundaryUnchanged(project, session.nativeID, expectedActivityClaim)) {
            claimIdentityDriftSessions.add(session.nativeID);
            return [session.nativeID, undefined];
        }
        const result = authority ? await withDeadline((signal) => authority === "legacy"
            ? api.client.session.messages({
                sessionID: session.nativeID,
                directory: project,
                limit: runtime.maximumMessagesPerSession + 1,
            }, { signal })
            : api.client.v2.session.messages({ sessionID: session.nativeID, limit: runtime.maximumMessagesPerSession + 1, order: "desc" }, { signal }), remaining, runtime.signal) : undefined;
        if (!activityClaimBoundaryUnchanged(project, session.nativeID, expectedActivityClaim)) {
            claimIdentityDriftSessions.add(session.nativeID);
            return [session.nativeID, undefined];
        }
        if (result?.ok) {
            try {
                return [session.nativeID, authority === "legacy"
                        ? parseLegacyMessages(result.value, runtime.maximumMessagesPerSession, session.nativeID, true)
                        : parseMessages(result.value, runtime.maximumMessagesPerSession)];
            }
            catch { /* Use current TUI cache when possible. */ }
        }
        return [session.nativeID, current === session.nativeID
                ? stateMessages(api, session.nativeID, runtime.maximumMessagesPerSession, deadlineAt)
                : undefined];
    });
    if (messageReads.omitted)
        messageFanoutTruncated = true;
    const ownershipDriftSessions = new Set();
    const ownershipChecks = await mapWithConcurrency(candidateSessions.filter((session) => !cacheFallbackIDs.has(session.nativeID) &&
        workingClaims.get(session.nativeID)?.kind !== "direct"), runtime.maximumConcurrency, deadlineAt, async (session) => {
        const authority = authorityByID.get(session.nativeID);
        if (!authority)
            return [session.nativeID, false];
        const remaining = Math.min(runtime.rpcDeadlineMs, Math.max(1, deadlineAt - Date.now()));
        const result = await withDeadline((signal) => authority === "legacy"
            ? api.client.session.get({ sessionID: session.nativeID, directory: project }, { signal })
            : api.client.v2.session.get({ sessionID: session.nativeID }, { signal }), remaining, runtime.signal);
        let fresh;
        if (result.ok) {
            try {
                fresh = authority === "legacy"
                    ? parseSession(responseData(result.value), project)
                    : parseSession(object(responseData(result.value))?.data, project);
            }
            catch {
                fresh = undefined;
            }
        }
        if (!fresh)
            return [session.nativeID, false];
        const signed = titleClaims.get(session.nativeID);
        return [session.nativeID, signed
                ? fresh.title === session.title && fresh.agent === session.agent
                : fresh.agent === session.agent && !looksLikeOpenCodeHarborTitle(fresh.title)];
    });
    for (const [nativeSessionID, stable] of ownershipChecks.results) {
        if (!stable)
            ownershipDriftSessions.add(nativeSessionID);
    }
    for (const session of candidateSessions) {
        if (!cacheFallbackIDs.has(session.nativeID) && workingClaims.get(session.nativeID)?.kind !== "direct" &&
            !ownershipChecks.results.some(([nativeSessionID]) => nativeSessionID === session.nativeID)) {
            ownershipDriftSessions.add(session.nativeID);
        }
    }
    let finalRelevantClaims;
    try {
        finalRelevantClaims = readOpenCodeAgentActivitiesIncludingStale(project)
            .filter(({ kind, phase }) => !(kind === "delegated" && phase === "starting"));
    }
    catch {
        finalRelevantClaims = undefined;
    }
    const matchesFinalClaimBarrier = (nativeSessionID, expected) => {
        if (!finalRelevantClaims)
            return false;
        const sameSession = finalRelevantClaims.filter(({ sessionID }) => sessionID === nativeSessionID);
        if (!expected)
            return sameSession.length === 0;
        const claim = finalRelevantClaims.find(({ agent }) => agent === expected.agent);
        return sameSession.length === 1 && claim !== undefined && !claim.heartbeatOverdue &&
            claim.sessionID === expected.sessionID && claim.processID === expected.processID &&
            claim.claimToken === expected.claimToken && claim.kind === expected.kind && claim.phase === expected.phase;
    };
    for (const { nativeID } of candidateSessions) {
        if (!matchesFinalClaimBarrier(nativeID, messageClaimBoundaries.get(nativeID))) {
            claimIdentityDriftSessions.add(nativeID);
        }
    }
    const stableMessageResults = messageReads.results.filter(([nativeSessionID]) => {
        return !claimIdentityDriftSessions.has(nativeSessionID);
    });
    const messages = new Map(stableMessageResults.filter((entry) => entry[1] !== undefined));
    const missingMessages = selectedForMessages.filter(({ nativeID }) => !messages.has(nativeID)).length;
    if (missingMessages)
        degraded.push(`${missingMessages} Harbor candidate(s) have unavailable task or response telemetry`);
    if (claimIdentityDriftSessions.size) {
        degraded.push("One or more activity-claim generations changed during message inspection; their content and stop authority were discarded");
    }
    if (ownershipDriftSessions.size) {
        degraded.push("One or more native agent/title ownership records changed or became unavailable during message inspection; their content and stop authority were discarded");
    }
    let runs = classifyRuns(candidateSessions, messages, roster.members, titleClaims, directActivityAgents, stateByID, runtime.now());
    for (const run of runs) {
        const nativeSessionID = privateRunSessionIDs.get(run);
        const authority = nativeSessionID ? authorityByID.get(nativeSessionID) : undefined;
        if (authority)
            privateRunAuthorities.set(run, authority);
    }
    if (runs.some(({ telemetryBounded }) => telemetryBounded)) {
        degraded.push("usage telemetry exceeded numeric safety bounds and is shown as a lower bound");
    }
    const memberByID = new Map(roster.members.map((member) => [member.id, member]));
    const matchedClaimTokens = new Set();
    const reconciledRuns = [];
    for (const run of runs) {
        const nativeSessionID = privateRunSessionIDs.get(run);
        if (nativeSessionID && (ambiguousClaimSessions.has(nativeSessionID) ||
            claimIdentityDriftSessions.has(nativeSessionID) || ownershipDriftSessions.has(nativeSessionID)))
            continue;
        const claim = nativeSessionID ? claimByNativeSession.get(nativeSessionID) : undefined;
        if (!claim) {
            reconciledRuns.push(run);
            continue;
        }
        // A fresh claim from another OpenCode process still proves that the
        // lagging native/base-agent row is not independently stoppable here.
        // Suppress that duplicate row and retain the explicit reservation below.
        if (claim.processID !== process.pid || claim.heartbeatOverdue)
            continue;
        if (claim.phase !== "working") {
            // The filesystem lifecycle phase is more precise than a lagging native
            // `running` status during starting/cleaning; render the reservation only.
            continue;
        }
        const claimedMember = memberByID.get(claim.agent);
        const reconciled = {
            ...run,
            agent: claim.agent,
            kind: claimedMember?.kind ?? "personal",
            rosterState: claimedMember?.availability ?? "retired-or-unlisted",
            invocation: claim.kind,
            ownerLocator: publicOwnerLocator(claim.processID),
        };
        privateRunSessionIDs.set(reconciled, nativeSessionID);
        const authority = privateRunAuthorities.get(run);
        if (authority)
            privateRunAuthorities.set(reconciled, authority);
        privateRunClaims.set(reconciled, {
            sessionID: claim.sessionID,
            processID: claim.processID,
            claimToken: claim.claimToken,
            agent: claim.agent,
            kind: claim.kind,
            phase: claim.phase,
        });
        matchedClaimTokens.add(claim.claimToken);
        reconciledRuns.push(reconciled);
    }
    runs = reconciledRuns;
    const unclaimedDriftReservations = candidateSessions.flatMap((session) => {
        if (!claimIdentityDriftSessions.has(session.nativeID) || claimByNativeSession.has(session.nativeID))
            return [];
        const titleClaim = titleClaims.get(session.nativeID);
        const agent = titleClaim?.agent ?? session.agent;
        if (!agent)
            return [];
        return [{
                id: session.publicID,
                agent,
                invocation: titleClaim?.invocation === "contract" ? "contract"
                    : titleClaim?.invocation === "agent" ? "delegated" : "direct",
                phase: "working",
                startedAt: session.createdAt,
                elapsedMs: Math.max(0, runtime.now() - session.createdAt),
                stopAvailable: false,
                stopBlockReason: "claim-changed",
            }];
    });
    const ownershipDriftReservations = candidateSessions.flatMap((session) => {
        if (!ownershipDriftSessions.has(session.nativeID) || claimIdentityDriftSessions.has(session.nativeID) ||
            claimByNativeSession.has(session.nativeID))
            return [];
        const titleClaim = titleClaims.get(session.nativeID);
        const claim = workingClaims.get(session.nativeID);
        const agent = claim?.agent ?? titleClaim?.agent ?? session.agent;
        if (!agent)
            return [];
        return [{
                id: session.publicID,
                agent,
                invocation: claim?.kind ?? (titleClaim?.invocation === "contract" ? "contract"
                    : titleClaim?.invocation === "agent" ? "delegated" : "direct"),
                phase: "working",
                startedAt: session.createdAt,
                elapsedMs: Math.max(0, runtime.now() - session.createdAt),
                stopAvailable: false,
                stopBlockReason: "ownership-changed",
            }];
    });
    let reservations = [
        ...observedClaims.flatMap((claim) => {
            const privateClaim = {
                sessionID: claim.sessionID,
                processID: claim.processID,
                claimToken: claim.claimToken,
                agent: claim.agent,
                kind: claim.kind,
                phase: claim.phase,
            };
            if (matchedClaimTokens.has(claim.claimToken))
                return [];
            const reservation = {
                // Never derive a visible selector from the delegated owner/lead
                // session. It appears only after the child identity is published.
                ...(claim.kind === "delegated" && claim.phase === "starting" ? {} : {
                    id: publicSessionID(claim.sessionID),
                }),
                agent: claim.agent,
                invocation: claim.kind,
                phase: claim.phase,
                ownerLocator: publicOwnerLocator(claim.processID),
                startedAt: claim.startedAt,
                elapsedMs: Math.max(0, runtime.now() - claim.startedAt),
                stopAvailable: claim.processID === process.pid && !claim.heartbeatOverdue && claim.phase === "working" &&
                    !ambiguousClaimSessions.has(claim.sessionID) && legacyActiveIDs.has(claim.sessionID) &&
                    !dualActiveSessionIDs.has(claim.sessionID) && !claimIdentityDriftSessions.has(claim.sessionID) &&
                    !ownershipDriftSessions.has(claim.sessionID),
                ...(claim.kind === "delegated" && claim.phase === "starting"
                    ? { stopBlockReason: "pending-child" }
                    : claim.heartbeatOverdue
                        ? { stopBlockReason: "stale-heartbeat" }
                        : ambiguousClaimSessions.has(claim.sessionID)
                            ? { stopBlockReason: "ambiguous-identity" }
                            : claimIdentityDriftSessions.has(claim.sessionID)
                                ? { stopBlockReason: "claim-changed" }
                                : ownershipDriftSessions.has(claim.sessionID)
                                    ? { stopBlockReason: "ownership-changed" }
                                    : dualActiveSessionIDs.has(claim.sessionID)
                                        ? { stopBlockReason: "dual-engine" }
                                        : claim.processID !== process.pid
                                            ? { stopBlockReason: "other-process" }
                                            : claim.phase !== "working"
                                                ? { stopBlockReason: "lifecycle-transition" }
                                                : !legacyActiveIDs.has(claim.sessionID)
                                                    ? { stopBlockReason: "native-run-pending" }
                                                    : {}),
            };
            privateReservationClaims.set(reservation, privateClaim);
            return [reservation];
        }),
        ...unclaimedDualReservations,
        ...unclaimedDriftReservations,
        ...ownershipDriftReservations,
    ];
    const currentPendingByID = new Map();
    for (const pending of pendingStopConfirmations.values()) {
        if (pending.project === projectKey(project))
            currentPendingByID.set(pending.publicTargetID, pending);
    }
    if (currentPendingByID.size) {
        const pendingReservations = [];
        for (const [publicTargetID, pending] of currentPendingByID) {
            const run = runs.find(({ id }) => id === publicTargetID);
            const reservation = reservations.find(({ id }) => id === publicTargetID);
            const startedAt = run?.startedAt ?? reservation?.startedAt ?? pending.startedAt;
            pendingReservations.push({
                id: publicTargetID,
                agent: run?.agent ?? reservation?.agent ?? pending.agent,
                invocation: run?.invocation ?? reservation?.invocation ?? pending.invocation,
                phase: "working",
                ...(run?.ownerLocator ?? reservation?.ownerLocator
                    ? { ownerLocator: run?.ownerLocator ?? reservation?.ownerLocator }
                    : {}),
                startedAt,
                elapsedMs: Math.max(0, runtime.now() - startedAt),
                stopAvailable: false,
                stopBlockReason: "stop-confirmation-pending",
            });
        }
        runs = runs.filter(({ id }) => !currentPendingByID.has(id));
        reservations = [
            ...reservations.filter(({ id }) => id === undefined || !currentPendingByID.has(id)),
            ...pendingReservations,
        ];
    }
    const exactTargetAuthorities = new Set([
        ...runs.flatMap((run) => {
            const authority = privateRunAuthorities.get(run);
            return authority ? [authority] : [];
        }),
        ...reservations.filter(({ stopAvailable }) => stopAvailable).map(() => "legacy"),
    ]);
    // Even an exact target needs both independent registries readable: the
    // non-owning surface must authoritatively prove the same ID is absent.
    const exactTargetsAuthoritative = exactTargetAuthorities.size > 0 &&
        active !== undefined && legacyActive !== undefined &&
        active.preferredUnknownEntries === 0 && legacyActive.preferredUnknownEntries === 0;
    const snapshot = {
        projectName: openCodePublicLabel(basename(project), 80) ?? "project",
        ...(hostDefaultModel(api) ? { hostDefaultModel: hostDefaultModel(api) } : {}),
        members: roster.members,
        runs,
        reservations,
        directAliasCollisions: readOpenCodeDirectAliasCollisions(project),
        activeAuthoritative: active !== undefined && legacyActive !== undefined &&
            active.unknownEntries === 0 && legacyActive.unknownEntries === 0 && !activeListTruncated &&
            unresolvedActiveSessions === 0 && claimsAuthoritative && titleClaimsAuthoritative && !roster.degraded,
        exactStopAvailable: exactTargetsAuthoritative && claimsAuthoritative &&
            titleClaimsAuthoritative && !roster.degraded,
        degradedReasons: [...new Set(degraded)],
        sessionListTruncated,
        activeListTruncated,
        messageFanoutTruncated,
    };
    privateSnapshotProjects.set(snapshot, project);
    privateSnapshotClaimsAuthoritative.set(snapshot, claimsAuthoritative);
    return snapshot;
}
function selectStopTargets(snapshot, selector) {
    const targets = [
        ...snapshot.runs.map((value) => ({ type: "run", value })),
        ...snapshot.reservations.filter(({ id }) => id !== undefined)
            .map((value) => ({ type: "reservation", value })),
    ];
    if (selector === "all")
        return targets;
    const exact = targets.filter(({ value }) => value.id === selector);
    if (exact.length === 1)
        return exact;
    if (exact.length > 1 && exact.every((target) => target.type === "reservation" &&
        target.value.stopBlockReason === "ambiguous-identity"))
        return exact;
    if (exact.length > 1)
        throw new Error("run selector maps to competing activity rows; inspect /team and filesystem claim recovery before retrying");
    const prefixes = targets.filter(({ value }) => value.id?.startsWith(selector) === true);
    const prefixIDs = [...new Set(prefixes.map(({ value }) => value.id))];
    if (prefixIDs.length === 1)
        return prefixes;
    if (prefixIDs.length > 1)
        throw new Error(`run prefix is ambiguous; use one of: ${prefixIDs.join(", ")}`);
    throw new Error(`no active Agent Harbor run matches “${openCodePublicLabel(selector, 80) ?? "invalid selector"}”`);
}
function nativeRunSessionID(run) {
    const id = privateRunSessionIDs.get(run);
    if (!id)
        throw new Error("OpenCode run identity is unavailable; no session was stopped");
    return id;
}
function snapshotProject(snapshot) {
    const project = privateSnapshotProjects.get(snapshot);
    if (!project)
        throw new Error("OpenCode project identity is unavailable; no session was stopped");
    return project;
}
function targetID(target) {
    const id = target.value.id;
    if (!id)
        throw new Error("OpenCode reservation is not yet stoppable; no session was stopped");
    return id;
}
function targetInvocation(target) {
    return target.value.invocation;
}
function targetAgent(target) { return target.value.agent; }
function targetClaim(target) {
    return target.type === "run"
        ? privateRunClaims.get(target.value)
        : privateReservationClaims.get(target.value);
}
function targetNativeSessionID(target) {
    if (target.type === "run")
        return nativeRunSessionID(target.value);
    const claim = privateReservationClaims.get(target.value);
    if (!claim)
        throw new Error("OpenCode reservation identity is unavailable; no session was stopped");
    return claim.sessionID;
}
function targetAuthority(target) {
    if (targetClaim(target))
        return "legacy";
    if (target.type === "reservation")
        return "legacy";
    const authority = privateRunAuthorities.get(target.value);
    if (!authority)
        throw new Error("OpenCode run authority is unavailable; no session was stopped");
    return authority;
}
function exactActivityClaim(project, expected) {
    try {
        const claims = readOpenCodeAgentActivitiesIncludingStale(project)
            .filter(({ kind, phase }) => !(kind === "delegated" && phase === "starting"));
        const sameSession = claims.filter(({ sessionID }) => sessionID === expected.sessionID);
        const claim = claims.find(({ agent }) => agent === expected.agent);
        if (!claim)
            return sameSession.length ? "replaced" : "absent";
        if (claim.heartbeatOverdue || sameSession.length !== 1)
            return "unavailable";
        return claim.sessionID === expected.sessionID && claim.processID === expected.processID &&
            claim.claimToken === expected.claimToken && claim.kind === expected.kind && claim.phase === expected.phase
            ? "exact"
            : "replaced";
    }
    catch {
        return "unavailable";
    }
}
function activityClaimBoundaryUnchanged(project, nativeSessionID, expected) {
    if (expected)
        return exactActivityClaim(project, expected) === "exact";
    try {
        return !readOpenCodeAgentActivitiesIncludingStale(project)
            .some(({ sessionID, kind, phase }) => sessionID === nativeSessionID &&
            !(kind === "delegated" && phase === "starting"));
    }
    catch {
        return false;
    }
}
async function confirmStoppedTarget(api, nativeSessionID, project, claim, runtime, deadlineAt) {
    while (!runtime.signal?.aborted && Date.now() < deadlineAt) {
        const remaining = Math.min(runtime.rpcDeadlineMs, Math.max(1, deadlineAt - Date.now()));
        const [legacyStatus, v2Status] = await Promise.all([
            withDeadline((signal) => api.client.session.status({ directory: project }, { signal }), remaining, runtime.signal),
            withDeadline((signal) => api.client.v2.session.active({ signal }), remaining, runtime.signal),
        ]);
        if (legacyStatus.ok && v2Status.ok) {
            try {
                const legacyActive = parseLegacyStatus(legacyStatus.value, runtime.maximumActiveSessions, [nativeSessionID]);
                const v2Active = parseActive(v2Status.value, runtime.maximumActiveSessions, [nativeSessionID]);
                if (!legacyActive.ids.includes(nativeSessionID) && !v2Active.ids.includes(nativeSessionID) &&
                    legacyActive.preferredUnknownEntries === 0 && v2Active.preferredUnknownEntries === 0 &&
                    (claim ? exactActivityClaim(project, claim) === "absent"
                        : activityClaimBoundaryUnchanged(project, nativeSessionID)))
                    return true;
            }
            catch { /* Poll until both engines and this exact claim are terminal. */ }
        }
        const delayMs = Math.min(25, Math.max(0, deadlineAt - Date.now()));
        if (delayMs > 0)
            await new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs));
    }
    return false;
}
/** Stops only Harbor sessions re-proven active and owner-bound, then confirmed terminal after abort. */
export async function stopOpenCodeTeamRuns(api, selector, options = {}) {
    if (selector.length > 256 || Buffer.byteLength(selector, "utf8") > 256) {
        throw new Error("OpenCode stop selector exceeds the 256-byte safety limit");
    }
    const requested = selector.trim();
    if (!requested)
        throw new Error("usage inside the /team prompt: stop <run-id|all>");
    const runtime = limits(options);
    const stopCallProject = resolve(api.state.path.directory);
    const stopCallProjectKey = projectKey(stopCallProject);
    activeStopCalls.set(stopCallProjectKey, (activeStopCalls.get(stopCallProjectKey) ?? 0) + 1);
    try {
        const snapshot = await collectOpenCodeTeamSnapshot(api, options);
        const project = snapshotProject(snapshot);
        const scopedPendingIDs = [...new Set([...pendingStopConfirmations.values()]
                .filter((pending) => pending.project === projectKey(project))
                .map(({ publicTargetID }) => publicTargetID))];
        let requestedPendingIDs = requested === "all" ? scopedPendingIDs : [];
        if (requested !== "all" && scopedPendingIDs.length) {
            const visibleIDs = selectStopTargets(snapshot, "all").map(targetID);
            const selectableIDs = [...new Set([...visibleIDs, ...scopedPendingIDs])];
            const exact = selectableIDs.filter((id) => id === requested);
            const prefixes = exact.length ? exact : selectableIDs.filter((id) => id.startsWith(requested));
            if (prefixes.length > 1) {
                throw new Error(`run prefix is ambiguous; use one of: ${prefixes.join(", ")}`);
            }
            if (prefixes.length === 1 && scopedPendingIDs.includes(prefixes[0])) {
                requestedPendingIDs = [prefixes[0]];
                return {
                    requested,
                    stopped: [],
                    alreadyIdle: [],
                    failed: [],
                    pendingConfirmation: [prefixes[0]],
                };
            }
        }
        if (requested === "all" && !snapshot.activeAuthoritative) {
            throw new Error("OpenCode active-session verification is unavailable; no session was stopped. Retry /team after host RPC recovers");
        }
        if (privateSnapshotClaimsAuthoritative.get(snapshot) !== true) {
            throw new Error("OpenCode activity-claim verification is unavailable; no session was stopped. Inspect claim recovery state before retrying");
        }
        const pendingChildIdentity = requested === "all"
            ? snapshot.reservations.filter(({ invocation, phase, id }) => invocation === "delegated" && phase === "starting" && id === undefined).map(({ agent }) => agent)
            : [];
        const selectedTargets = selectStopTargets(snapshot, requested);
        // A retained one-shot tombstone outranks an apparently idle registry row or
        // a still-live claim. Never route a retry through generic failed/idle logic.
        const requestedPendingIDSet = new Set(requestedPendingIDs);
        const selectableTargets = selectedTargets.filter((target) => !requestedPendingIDSet.has(targetID(target)));
        const blockedTargetIDs = (predicate) => [...new Set(selectableTargets.filter(predicate).map(targetID))];
        const ownedByAnotherProcess = blockedTargetIDs((target) => target.type === "reservation" && target.value.stopBlockReason === "other-process");
        const claimIdentityUnavailable = blockedTargetIDs((target) => target.type === "reservation" &&
            (target.value.stopBlockReason === "ambiguous-identity" || target.value.stopBlockReason === "claim-changed"));
        const ownershipUnavailable = blockedTargetIDs((target) => target.type === "reservation" && target.value.stopBlockReason === "ownership-changed");
        const staleOwnerHeartbeat = blockedTargetIDs((target) => target.type === "reservation" && target.value.stopBlockReason === "stale-heartbeat");
        const lifecycleTransition = blockedTargetIDs((target) => target.type === "reservation" && target.value.stopBlockReason === "lifecycle-transition");
        const nativeRunPending = blockedTargetIDs((target) => target.type === "reservation" && target.value.stopBlockReason === "native-run-pending");
        const engineAuthorityUnavailable = blockedTargetIDs((target) => target.type === "reservation" && target.value.stopBlockReason === "dual-engine");
        const targets = selectableTargets.filter((target) => !(target.type === "reservation" && !target.value.stopAvailable));
        if (!targets.length)
            return {
                requested,
                stopped: [],
                alreadyIdle: [],
                failed: [],
                ...(pendingChildIdentity.length ? { pendingChildIdentity } : {}),
                ...(ownedByAnotherProcess.length ? { ownedByAnotherProcess } : {}),
                ...(claimIdentityUnavailable.length ? { claimIdentityUnavailable } : {}),
                ...(ownershipUnavailable.length ? { ownershipUnavailable } : {}),
                ...(staleOwnerHeartbeat.length ? { staleOwnerHeartbeat } : {}),
                ...(lifecycleTransition.length ? { lifecycleTransition } : {}),
                ...(nativeRunPending.length ? { nativeRunPending } : {}),
                ...(engineAuthorityUnavailable.length ? { engineAuthorityUnavailable } : {}),
                ...(requestedPendingIDs.length ? { pendingConfirmation: requestedPendingIDs } : {}),
            };
        const targetIdentities = targets.map((target) => ({
            target,
            nativeSessionID: targetNativeSessionID(target),
            claim: targetClaim(target),
            authority: targetAuthority(target),
        }));
        const attemptKeys = [...new Set(targetIdentities.map(({ target }) => stopAttemptKey(project, targetID(target))))];
        for (const key of attemptKeys)
            activeStopAttempts.set(key, (activeStopAttempts.get(key) ?? 0) + 1);
        try {
            const targetNativeIDs = targetIdentities.map(({ nativeSessionID }) => nativeSessionID);
            // Recheck both engines for every target. The owning registry proves the run
            // remains active; the other proves a concurrent duplicate did not appear.
            const needV2Recheck = targetIdentities.length > 0;
            const needLegacyRecheck = targetIdentities.length > 0;
            const [v2Recheck, legacyRecheck] = await Promise.all([
                needV2Recheck
                    ? withDeadline((signal) => api.client.v2.session.active({ signal }), runtime.rpcDeadlineMs, runtime.signal)
                    : Promise.resolve(undefined),
                needLegacyRecheck
                    ? withDeadline((signal) => api.client.session.status({ directory: project }, { signal }), runtime.rpcDeadlineMs, runtime.signal)
                    : Promise.resolve(undefined),
            ]);
            let v2Active;
            if (v2Recheck) {
                if (!v2Recheck.ok)
                    throw new Error("OpenCode v2 active-session recheck failed; no session was stopped");
                try {
                    v2Active = parseActive(v2Recheck.value, runtime.maximumActiveSessions, targetNativeIDs);
                }
                catch {
                    throw new Error("OpenCode v2 active-session recheck was incompatible; no session was stopped");
                }
                if (v2Active.truncated && requested === "all") {
                    throw new Error("OpenCode v2 active-session recheck exceeded the safety bound; no session was stopped");
                }
                if (requested === "all" ? v2Active.unknownEntries : v2Active.preferredUnknownEntries) {
                    throw new Error("OpenCode v2 active-session recheck contained unknown status telemetry; no session was stopped");
                }
            }
            let legacyActive;
            if (legacyRecheck) {
                if (!legacyRecheck.ok)
                    throw new Error("OpenCode legacy session-status recheck failed; no session was stopped");
                try {
                    legacyActive = parseLegacyStatus(legacyRecheck.value, runtime.maximumActiveSessions, targetNativeIDs);
                }
                catch {
                    throw new Error("OpenCode legacy session-status recheck was incompatible; no session was stopped");
                }
                if (legacyActive.truncated && requested === "all") {
                    throw new Error("OpenCode legacy session-status recheck exceeded the safety bound; no session was stopped");
                }
                if (requested === "all" ? legacyActive.unknownEntries : legacyActive.preferredUnknownEntries) {
                    throw new Error("OpenCode legacy session-status recheck contained unknown telemetry; no session was stopped");
                }
            }
            const v2ActiveIDs = new Set(v2Active?.ids ?? []);
            const legacyActiveIDs = new Set(legacyActive?.ids ?? []);
            const isActive = ({ nativeSessionID, authority }) => authority === "legacy" ? legacyActiveIDs.has(nativeSessionID) : v2ActiveIDs.has(nativeSessionID);
            const pendingConfirmation = new Set(requestedPendingIDs);
            const becamePending = targetIdentities.filter(({ target, nativeSessionID, authority }) => pendingStopConfirmations.has(stopMutationKey(project, authority, nativeSessionID)) ||
                [...pendingStopConfirmations.values()].some((pending) => pending.project === projectKey(project) && pending.publicTargetID === targetID(target)));
            for (const { target } of becamePending)
                pendingConfirmation.add(targetID(target));
            const becameDualEngine = targetIdentities.filter(({ nativeSessionID, authority }) => authority === "legacy" ? v2ActiveIDs.has(nativeSessionID) : legacyActiveIDs.has(nativeSessionID));
            for (const { target } of becameDualEngine) {
                if (!engineAuthorityUnavailable.includes(targetID(target)))
                    engineAuthorityUnavailable.push(targetID(target));
            }
            const mutationIdentities = targetIdentities.filter((identity) => !becamePending.includes(identity) && !becameDualEngine.includes(identity));
            const ready = mutationIdentities.filter(isActive);
            const alreadyIdle = mutationIdentities.filter((identity) => {
                if (isActive(identity))
                    return false;
                if (!identity.claim)
                    return identity.target.type === "run";
                return exactActivityClaim(project, identity.claim) === "absent";
            }).map(({ target }) => targetID(target));
            const deadlineAt = Date.now() + runtime.collectionDeadlineMs;
            const failed = new Set();
            for (const identity of mutationIdentities) {
                if (!isActive(identity) && !alreadyIdle.includes(targetID(identity.target))) {
                    failed.add(identity.target);
                }
            }
            let titleVerifier;
            if (ready.some(({ target }) => targetInvocation(target) !== "direct")) {
                const remaining = Math.min(runtime.rpcDeadlineMs, Math.max(1, deadlineAt - Date.now()));
                const loaded = await withDeadline(() => loadOpenCodeHarborTitleVerifier(defaultHome("opencode"), project), remaining, runtime.signal);
                if (loaded.ok)
                    titleVerifier = loaded.value;
            }
            const stopped = new Set();
            const processed = new Set();
            await mapWithConcurrency(ready, runtime.maximumConcurrency, deadlineAt, async ({ target, nativeSessionID, claim, authority }) => {
                processed.add(target);
                const mutationKey = stopMutationKey(project, authority, nativeSessionID);
                const markConcurrentPending = () => {
                    const pending = pendingStopConfirmations.get(mutationKey);
                    if (!pending && ![...pendingStopConfirmations.values()].some((candidate) => candidate.project === projectKey(project) && candidate.publicTargetID === targetID(target)))
                        return false;
                    pendingConfirmation.add(targetID(target));
                    return true;
                };
                if (markConcurrentPending())
                    return;
                if (claim) {
                    if (claim.processID !== process.pid || exactActivityClaim(project, claim) !== "exact" ||
                        target.type === "reservation" && !target.value.stopAvailable) {
                        failed.add(target);
                        return;
                    }
                }
                let remaining = Math.min(runtime.rpcDeadlineMs, Math.max(1, deadlineAt - Date.now()));
                const fresh = await withDeadline((signal) => authority === "legacy"
                    ? api.client.session.get({ sessionID: nativeSessionID, directory: project }, { signal })
                    : api.client.v2.session.get({ sessionID: nativeSessionID }, { signal }), remaining, runtime.signal);
                if (markConcurrentPending())
                    return;
                let session;
                if (fresh.ok) {
                    try {
                        if (authority === "legacy")
                            session = parseSession(responseData(fresh.value), project);
                        else {
                            const envelope = object(responseData(fresh.value));
                            session = parseSession(envelope?.data, project);
                        }
                    }
                    catch {
                        session = undefined;
                    }
                }
                if (!session) {
                    failed.add(target);
                    return;
                }
                const sessionMatchesTarget = (candidate) => {
                    if (targetInvocation(target) === "direct") {
                        // SessionV2Info.agent can remain the host's base agent (for example
                        // `build`) while a custom direct slash command is streaming. Its exact
                        // filesystem generation and legacy user boundary own authorization;
                        // only a v2-discovered direct run without that claim relies on the raw
                        // SessionV2Info.agent field.
                        return claim ? true : candidate.agent === targetAgent(target) &&
                            !looksLikeOpenCodeHarborTitle(candidate.title);
                    }
                    const titleClaim = titleVerifier?.(candidate.title, candidate.nativeID);
                    const expected = targetInvocation(target) === "delegated" ? "agent" : "contract";
                    return titleClaim?.invocation === expected && titleClaim.agent === targetAgent(target);
                };
                if (!sessionMatchesTarget(session)) {
                    failed.add(target);
                    return;
                }
                remaining = Math.min(runtime.rpcDeadlineMs, Math.max(1, deadlineAt - Date.now()));
                const pendingRecord = {
                    project: projectKey(project), nativeSessionID, authority, publicTargetID: targetID(target),
                    agent: targetAgent(target), invocation: targetInvocation(target), startedAt: target.value.startedAt,
                };
                if (authority === "legacy") {
                    const messageResult = await withDeadline((signal) => api.client.session.messages({
                        sessionID: nativeSessionID,
                        directory: project,
                        limit: runtime.maximumMessagesPerSession + 1,
                    }, { signal }), remaining, runtime.signal);
                    if (markConcurrentPending())
                        return;
                    let boundaryAgent;
                    let boundaryObserved = false;
                    let boundaryID;
                    if (messageResult.ok) {
                        try {
                            const page = parseLegacyMessages(messageResult.value, runtime.maximumMessagesPerSession, nativeSessionID);
                            const boundary = page.messages.find(({ type }) => type === "user");
                            boundaryObserved = typeof boundary?.id === "string";
                            boundaryAgent = typeof boundary?.agent === "string" ? boundary.agent : undefined;
                            boundaryID = currentTurnMessages(page.messages).boundaryID;
                        }
                        catch {
                            boundaryObserved = false;
                        }
                    }
                    const expectedBoundaryAgent = targetInvocation(target) === "contract" ? session.agent : targetAgent(target);
                    const sameObservedBoundary = claim
                        ? target.type === "reservation" || target.value.turnBoundaryID === undefined ||
                            boundaryID === target.value.turnBoundaryID
                        : target.type === "run" && target.value.turnBoundaryID !== undefined &&
                            boundaryID === target.value.turnBoundaryID;
                    if (!boundaryObserved || boundaryAgent !== expectedBoundaryAgent || !sameObservedBoundary) {
                        failed.add(target);
                        return;
                    }
                }
                else {
                    const messageResult = await withDeadline((signal) => api.client.v2.session.messages({
                        sessionID: nativeSessionID,
                        limit: runtime.maximumMessagesPerSession + 1,
                        order: "desc",
                    }, { signal }), remaining, runtime.signal);
                    if (markConcurrentPending())
                        return;
                    let freshTurn;
                    if (messageResult.ok) {
                        try {
                            freshTurn = currentTurnMessages(parseMessages(messageResult.value, runtime.maximumMessagesPerSession).messages);
                        }
                        catch {
                            freshTurn = undefined;
                        }
                    }
                    const sameBoundary = target.type === "run" && target.value.turnBoundaryID !== undefined &&
                        freshTurn?.boundaryID === target.value.turnBoundaryID;
                    if (!sameBoundary) {
                        failed.add(target);
                        return;
                    }
                }
                // Re-read the exact owner generation after every host-controlled GET and
                // message response. A replacement between snapshot and abort can
                // never inherit authorization from the prior claim.
                if (claim && exactActivityClaim(project, claim) !== "exact") {
                    failed.add(target);
                    return;
                }
                remaining = Math.min(runtime.rpcDeadlineMs, Math.max(1, deadlineAt - Date.now()));
                const postMessageSession = await withDeadline((signal) => authority === "legacy"
                    ? api.client.session.get({ sessionID: nativeSessionID, directory: project }, { signal })
                    : api.client.v2.session.get({ sessionID: nativeSessionID }, { signal }), remaining, runtime.signal);
                if (markConcurrentPending())
                    return;
                let postMessageRecord;
                if (postMessageSession.ok) {
                    try {
                        if (authority === "legacy")
                            postMessageRecord = parseSession(responseData(postMessageSession.value), project);
                        else
                            postMessageRecord = parseSession(object(responseData(postMessageSession.value))?.data, project);
                    }
                    catch {
                        postMessageRecord = undefined;
                    }
                }
                if (!postMessageRecord || !sessionMatchesTarget(postMessageRecord)) {
                    failed.add(target);
                    return;
                }
                if (claim && exactActivityClaim(project, claim) !== "exact") {
                    failed.add(target);
                    return;
                }
                // Close the registry-switch/dual-engine window introduced by GET and
                // message RPCs. The owning engine must still contain the target and the
                // other engine must still prove it absent immediately before dispatch.
                remaining = Math.min(runtime.rpcDeadlineMs, Math.max(1, deadlineAt - Date.now()));
                const [latestLegacyStatus, latestV2Status] = await Promise.all([
                    withDeadline((signal) => api.client.session.status({ directory: project }, { signal }), remaining, runtime.signal),
                    withDeadline((signal) => api.client.v2.session.active({ signal }), remaining, runtime.signal),
                ]);
                if (markConcurrentPending())
                    return;
                let latestLegacy;
                let latestV2;
                if (latestLegacyStatus.ok && latestV2Status.ok) {
                    try {
                        latestLegacy = parseLegacyStatus(latestLegacyStatus.value, runtime.maximumActiveSessions, [nativeSessionID]);
                        latestV2 = parseActive(latestV2Status.value, runtime.maximumActiveSessions, [nativeSessionID]);
                    }
                    catch { /* Fail closed below. */ }
                }
                if (!latestLegacy || !latestV2 || latestLegacy.preferredUnknownEntries || latestV2.preferredUnknownEntries ||
                    requested === "all" && (latestLegacy.unknownEntries || latestV2.unknownEntries ||
                        latestLegacy.truncated || latestV2.truncated)) {
                    failed.add(target);
                    return;
                }
                const latestLegacyOwns = latestLegacy.ids.includes(nativeSessionID);
                const latestV2Owns = latestV2.ids.includes(nativeSessionID);
                const expectedOwns = authority === "legacy" ? latestLegacyOwns : latestV2Owns;
                const otherOwns = authority === "legacy" ? latestV2Owns : latestLegacyOwns;
                if (otherOwns) {
                    if (!engineAuthorityUnavailable.includes(targetID(target)))
                        engineAuthorityUnavailable.push(targetID(target));
                    return;
                }
                if (!expectedOwns) {
                    failed.add(target);
                    return;
                }
                if (claim && exactActivityClaim(project, claim) !== "exact") {
                    failed.add(target);
                    return;
                }
                // OpenCode offers no conditional compare-and-abort primitive. Keep the
                // observable TOCTOU window minimal by aborting immediately after this
                // target's own generation + ownership check instead of batching all GETs.
                remaining = Math.min(runtime.rpcDeadlineMs, Math.max(1, deadlineAt - Date.now()));
                if (authority === "legacy") {
                    // Direct custom commands and disposable children created through the v1
                    // SDK are owned by legacy SessionRunState. V2 interrupt cannot reach
                    // that engine, so use its boolean abort and confirm against scoped legacy
                    // status plus disappearance of this exact filesystem generation.
                    const aborted = await withOneShotMutationDeadline(mutationKey, pendingRecord, (signal) => api.client.session.abort({ sessionID: nativeSessionID, directory: project }, { signal }), (value) => {
                        if (responseData(value) !== true)
                            throw new Error("OpenCode legacy abort was not accepted");
                    }, remaining, runtime.signal);
                    if (!aborted.ok) {
                        if (aborted.timedOut || inFlightStopMutations.has(mutationKey) || pendingStopConfirmations.has(mutationKey)) {
                            pendingConfirmation.add(targetID(target));
                        }
                        else
                            failed.add(target);
                        return;
                    }
                    if (await confirmStoppedTarget(api, nativeSessionID, project, claim, runtime, deadlineAt)) {
                        stopped.add(target);
                    }
                    else
                        pendingConfirmation.add(targetID(target));
                    return;
                }
                // Sessions discovered and owned through SessionV2 stay on the v2 engine.
                const interrupted = await withOneShotMutationDeadline(mutationKey, pendingRecord, (signal) => api.client.v2.session.interrupt({ sessionID: nativeSessionID }, { signal }), (value) => {
                    responseData(value);
                }, remaining, runtime.signal);
                if (!interrupted.ok) {
                    if (interrupted.timedOut || inFlightStopMutations.has(mutationKey) || pendingStopConfirmations.has(mutationKey)) {
                        pendingConfirmation.add(targetID(target));
                    }
                    else
                        failed.add(target);
                    return;
                }
                if (await confirmStoppedTarget(api, nativeSessionID, project, claim, runtime, deadlineAt)) {
                    stopped.add(target);
                }
                else
                    pendingConfirmation.add(targetID(target));
            });
            for (const { target } of ready) {
                if (!processed.has(target))
                    failed.add(target);
            }
            return {
                requested,
                stopped: targets.filter((target) => stopped.has(target)).map(targetID),
                alreadyIdle,
                failed: targets.filter((target) => failed.has(target)).map(targetID),
                ...(pendingConfirmation.size ? {
                    pendingConfirmation: [...pendingConfirmation],
                } : {}),
                ...(pendingChildIdentity.length ? { pendingChildIdentity } : {}),
                ...(ownedByAnotherProcess.length ? { ownedByAnotherProcess } : {}),
                ...(claimIdentityUnavailable.length ? { claimIdentityUnavailable } : {}),
                ...(ownershipUnavailable.length ? { ownershipUnavailable } : {}),
                ...(staleOwnerHeartbeat.length ? { staleOwnerHeartbeat } : {}),
                ...(lifecycleTransition.length ? { lifecycleTransition } : {}),
                ...(nativeRunPending.length ? { nativeRunPending } : {}),
                ...(engineAuthorityUnavailable.length ? { engineAuthorityUnavailable } : {}),
            };
        }
        finally {
            for (const key of attemptKeys) {
                const remaining = (activeStopAttempts.get(key) ?? 1) - 1;
                if (remaining > 0)
                    activeStopAttempts.set(key, remaining);
                else
                    activeStopAttempts.delete(key);
            }
        }
    }
    finally {
        const remaining = (activeStopCalls.get(stopCallProjectKey) ?? 1) - 1;
        if (remaining > 0)
            activeStopCalls.set(stopCallProjectKey, remaining);
        else
            activeStopCalls.delete(stopCallProjectKey);
    }
}
