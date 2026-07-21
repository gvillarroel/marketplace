/** Bounded, zero-model OpenCode team discovery and active-session control. */
import { createHash } from "node:crypto";
import { basename, resolve } from "node:path";
import { listInvocablePlayers, loadManagedActivePlayer } from "../core/active.js";
import { bundledPlayers, rolePlayers, scoutPlayer } from "../core/defaults.js";
import { looksLikeOpenCodeHarborTitle, loadOpenCodeHarborTitleVerifier, verifySignedOpenCodeHarborTitles, } from "../core/opencode-session-claims.js";
import { publicTaskLabel, redactPublicMetadata } from "../core/public-metadata.js";
import { playerDefinitionDigest } from "../core/profiles.js";
import { hasOpenCodeCleanupHazard, openCodeCleanupHazardRecovery } from "../core/opencode-cleanup-hazards.js";
import { runDeterministicCommand } from "./direct.js";
import { readOpenCodeAgentConflicts } from "./opencode-agent-conflicts.js";
import { readOpenCodeAgentActivities } from "./opencode-agent-activity.js";
import { defaultHome } from "./shared.js";
export const maximumOpenCodeSessions = 64;
export const maximumOpenCodeActiveSessions = 32;
export const maximumOpenCodeMessageSessions = 24;
export const maximumOpenCodeMessagesPerSession = 16;
export const maximumVisibleOpenCodeRosterMembers = 40;
const privateRunSessionIDs = new WeakMap();
const privateSnapshotProjects = new WeakMap();
const harborIdPattern = /^[a-z0-9][a-z0-9-]{0,47}$/u;
function limits(options) {
    const positive = (value, fallback) => typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
    return {
        rpcDeadlineMs: positive(options.rpcDeadlineMs, 750),
        collectionDeadlineMs: positive(options.collectionDeadlineMs, 1_800),
        maximumSessions: positive(options.maximumSessions, maximumOpenCodeSessions),
        maximumActiveSessions: positive(options.maximumActiveSessions, maximumOpenCodeActiveSessions),
        maximumMessageSessions: positive(options.maximumMessageSessions, maximumOpenCodeMessageSessions),
        maximumMessagesPerSession: positive(options.maximumMessagesPerSession, maximumOpenCodeMessagesPerSession),
        maximumConcurrency: positive(options.maximumConcurrency, 4),
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
    };
}
function hasObservedTelemetry(values) {
    return Object.values(values).some((value) => value !== undefined);
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
        const rows = parseBenchRows(read.value);
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
    const cursor = object(page.cursor);
    return { sessions, truncated: page.data.length > maximum || Boolean(cursor?.next || cursor?.previous), malformed };
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
function parseMessages(value, maximum) {
    const page = object(responseData(value));
    if (!page || !Array.isArray(page.data))
        throw new Error("invalid OpenCode message page");
    // Deliberately project at the trust boundary. In particular, never retain
    // assistant prose, reasoning, tool input/output, snapshots, or errors in the
    // team-observability pipeline merely because the SDK returned them.
    const messages = [];
    for (const item of page.data.slice(0, maximum)) {
        const message = object(item);
        if (!message || typeof message.type !== "string")
            continue;
        const id = typeof message.id === "string" && message.id.length <= 512 ? message.id : undefined;
        const time = object(message.time);
        const created = nativeNumber(time?.created);
        const common = {
            ...(id === undefined ? {} : { id }),
            ...(created === undefined ? {} : { time: { created } }),
        };
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
            messages.push({ ...common, type: "agent-switched", ...(agent ? { agent } : {}) });
            continue;
        }
        if (message.type === "model-switched") {
            const observedModel = model(message.model);
            messages.push({ ...common, type: "model-switched", ...(observedModel ? { model: {
                        providerID: observedModel.provider, id: observedModel.id,
                        ...(observedModel.variant ? { variant: observedModel.variant } : {}),
                    } } : {}) });
        }
    }
    const cursor = object(page.cursor);
    return { messages, truncated: page.data.length > maximum || Boolean(cursor?.next || cursor?.previous) };
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
        return "(task not disclosed)";
    let task = latest.text;
    if (contract) {
        const marker = "\nTask:\n";
        const index = task.lastIndexOf(marker);
        if (index >= 0)
            task = task.slice(index + marker.length);
    }
    return openCodeTaskLabel(task);
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
        return {
            usage: {
                ...(session.tokens.input === undefined ? {} : { input: session.tokens.input }),
                ...(session.tokens.output === undefined ? {} : { output: session.tokens.output }),
                ...(session.tokens.reasoning === undefined ? {} : { reasoning: session.tokens.reasoning }),
                ...(session.tokens.cacheRead === undefined ? {} : { cacheRead: session.tokens.cacheRead }),
                ...(session.tokens.cacheWrite === undefined ? {} : { cacheWrite: session.tokens.cacheWrite }),
                ...(session.cost === undefined ? {} : { cost: session.cost }),
            },
            turns: messages.filter(({ type }) => type === "assistant").length || undefined,
            scope: "session-total",
        };
    }
    const assistants = messages.filter(({ type }) => type === "assistant");
    const totals = {
        input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0,
    };
    const observed = new Set();
    let bounded = false;
    for (const assistant of assistants) {
        const nativeTokens = tokens(assistant.tokens);
        for (const key of ["input", "output", "reasoning", "cacheRead", "cacheWrite"]) {
            const value = nativeTokens[key];
            if (value !== undefined) {
                totals[key] = totals[key] > Number.MAX_SAFE_INTEGER - value
                    ? (bounded = true, Number.MAX_SAFE_INTEGER)
                    : totals[key] + value;
                observed.add(key);
            }
        }
        const cost = nativeNumber(assistant.cost);
        if (cost !== undefined) {
            totals.cost = totals.cost > Number.MAX_SAFE_INTEGER - cost
                ? (bounded = true, Number.MAX_SAFE_INTEGER)
                : totals.cost + cost;
            observed.add("cost");
        }
    }
    return {
        usage: Object.fromEntries([...observed].map((key) => [key, totals[key]])),
        turns: assistants.length || undefined,
        scope: allowSessionAggregate ? "session-total" : "current-turn",
        ...(bounded ? { bounded: true } : {}),
    };
}
function classifyRuns(sessions, messages, members, titleClaims, stateByID, now) {
    const memberByID = new Map(members.map((entry) => [entry.id, entry]));
    const directlyOwnedByID = new Map(members
        .filter(({ availability }) => availability !== "conflict" && availability !== "unavailable")
        .map((entry) => [entry.id, entry]));
    const partial = sessions.flatMap((session) => {
        const page = messages.get(session.nativeID) ?? { messages: [], truncated: true };
        const claim = titleClaims.get(session.nativeID);
        // SessionV2Info.agent is authoritative for direct sessions. Historical
        // assistant messages are telemetry only and can never establish ownership.
        const directAgent = !claim && directlyOwnedByID.has(session.agent ?? "") ? session.agent : undefined;
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
        const directTurn = invocation === "direct" ? currentTurnMessages(page.messages) : undefined;
        const telemetryMessages = directTurn?.messages ?? page.messages;
        const telemetry = observedUsage(session, telemetryMessages, invocation !== "direct");
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
                task: taskFrom(page.messages, invocation === "contract"),
                startedAt,
                elapsedMs: Math.max(0, now - startedAt),
                ...(directTurn?.boundaryID === undefined ? {} : { turnBoundaryID: directTurn.boundaryID }),
                ...(directTurn?.startedAt === undefined ? {} : { turnBoundaryAt: directTurn.startedAt }),
                ...(latestObservedModel(telemetryMessages) ?? session.model
                    ? { model: latestObservedModel(telemetryMessages) ?? session.model }
                    : {}),
                usage: telemetry.usage,
                ...(telemetry.scope === undefined ? {} : { usageScope: telemetry.scope }),
                ...(telemetry.turns === undefined ? {} : { observedAssistantTurns: telemetry.turns }),
                observedAssistantTurnsLowerBound: page.truncated && !(invocation === "direct" && directTurn?.boundaryObserved),
                telemetryLowerBound: telemetry.bounded === true || (invocation === "direct"
                    ? page.truncated && !directTurn?.boundaryObserved
                    : page.truncated && !hasObservedTelemetry(session.tokens) && session.cost === undefined),
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
    const sessionListPromise = withDeadline((signal) => api.client.v2.session.list({ directory: project, limit: runtime.maximumSessions, order: "desc" }, { signal }), runtime.rpcDeadlineMs, runtime.signal);
    const activePromise = withDeadline((signal) => api.client.v2.session.active({ signal }), runtime.rpcDeadlineMs, runtime.signal);
    const [roster, listed, activeResponse] = await Promise.all([
        collectRoster(api, project, runtime), sessionListPromise, activePromise,
    ]);
    if (roster.degraded)
        degraded.push(roster.degraded);
    let sessions = [];
    let sessionListTruncated = false;
    if (listed.ok) {
        try {
            const page = parseSessionList(listed.value, project, runtime.maximumSessions);
            sessions = page.sessions;
            sessionListTruncated = page.truncated || page.sessions.length >= runtime.maximumSessions;
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
            active = parseActive(activeResponse.value, runtime.maximumActiveSessions, [current ?? "", ...sessions.map(({ nativeID }) => nativeID)]);
            if (active.unknownEntries)
                degraded.push(`${active.unknownEntries} active-session status entr${active.unknownEntries === 1 ? "y was" : "ies were"} ignored as unknown telemetry`);
        }
        catch {
            degraded.push("OpenCode active-session inventory returned an incompatible response; stop is disabled");
        }
    }
    else
        degraded.push(`OpenCode active-session inventory ${activeResponse.timedOut ? "timed out" : "is unavailable"}; stop is disabled`);
    const byID = new Map(sessions.map((session) => [session.nativeID, session]));
    let activeListTruncated = active?.truncated ?? false;
    if (active) {
        const missing = active.ids.filter((id) => !byID.has(id));
        const fetched = await mapWithConcurrency(missing, runtime.maximumConcurrency, deadlineAt, async (id) => {
            const remaining = Math.min(runtime.rpcDeadlineMs, Math.max(1, deadlineAt - Date.now()));
            const result = await withDeadline((signal) => api.client.v2.session.get({ sessionID: id }, { signal }), remaining, runtime.signal);
            if (!result.ok)
                return { id, scope: "invalid" };
            try {
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
        if (unresolved)
            degraded.push(`${unresolved} active session(s) could not be inspected within the bounded deadline`);
        sessions = active.ids.flatMap((id) => byID.has(id) ? [byID.get(id)] : []);
    }
    else {
        const fallback = current ? stateSession(api, project, current) : undefined;
        const fallbackState = current ? stateIsActive(api, current) : undefined;
        sessions = fallback && fallbackState ? [fallback] : [];
        if (sessions.length)
            degraded.push("current activity comes from the TUI cache and is not authorized for stop");
    }
    const stateByID = new Map();
    if (current && (!active || active.ids.includes(current))) {
        const status = stateIsActive(api, current);
        if (status)
            stateByID.set(current, status);
    }
    const titleClaims = new Map();
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
        else
            degraded.push("signed Harbor child provenance could not be verified; disposable sessions were omitted");
    }
    const directlyOwnedIDs = new Set(roster.members
        .filter(({ availability }) => availability !== "conflict" && availability !== "unavailable")
        .map(({ id }) => id));
    // Never read task/message content until session-level ownership is proven.
    const candidateSessions = sessions.filter((session) => titleClaims.has(session.nativeID)
        || (!looksLikeOpenCodeHarborTitle(session.title) && directlyOwnedIDs.has(session.agent ?? "")));
    const selectedForMessages = candidateSessions.slice(0, runtime.maximumMessageSessions);
    let messageFanoutTruncated = candidateSessions.length > selectedForMessages.length;
    const messageReads = await mapWithConcurrency(selectedForMessages, runtime.maximumConcurrency, deadlineAt, async (session) => {
        const remaining = Math.min(runtime.rpcDeadlineMs, Math.max(1, deadlineAt - Date.now()));
        const result = active ? await withDeadline((signal) => api.client.v2.session.messages({ sessionID: session.nativeID, limit: runtime.maximumMessagesPerSession, order: "desc" }, { signal }), remaining, runtime.signal) : undefined;
        if (result?.ok) {
            try {
                return [session.nativeID, parseMessages(result.value, runtime.maximumMessagesPerSession)];
            }
            catch { /* Use current TUI cache when possible. */ }
        }
        return [session.nativeID, current === session.nativeID
                ? stateMessages(api, session.nativeID, runtime.maximumMessagesPerSession, deadlineAt)
                : undefined];
    });
    if (messageReads.omitted)
        messageFanoutTruncated = true;
    const messages = new Map(messageReads.results.filter((entry) => entry[1] !== undefined));
    const missingMessages = selectedForMessages.filter(({ nativeID }) => !messages.has(nativeID)).length;
    if (missingMessages)
        degraded.push(`${missingMessages} Harbor candidate(s) have unavailable task or response telemetry`);
    const runs = classifyRuns(candidateSessions, messages, roster.members, titleClaims, stateByID, runtime.now());
    if (runs.some(({ telemetryBounded }) => telemetryBounded)) {
        degraded.push("usage telemetry exceeded numeric safety bounds and is shown as a lower bound");
    }
    const runningAgents = new Set(runs.filter(({ kind }) => kind !== "contractor").map(({ agent }) => agent));
    const reservations = readOpenCodeAgentActivities(project)
        .filter(({ agent }) => !runningAgents.has(agent))
        .map(({ agent, kind, phase, startedAt }) => ({
        agent,
        invocation: kind,
        phase,
        startedAt,
        elapsedMs: Math.max(0, runtime.now() - startedAt),
    }));
    const snapshot = {
        projectName: openCodePublicLabel(basename(project), 80) ?? "project",
        ...(hostDefaultModel(api) ? { hostDefaultModel: hostDefaultModel(api) } : {}),
        members: roster.members,
        runs,
        reservations,
        activeAuthoritative: active !== undefined && active.unknownEntries === 0 && !active.truncated,
        exactStopAvailable: active !== undefined && active.preferredUnknownEntries === 0,
        degradedReasons: [...new Set(degraded)],
        sessionListTruncated,
        activeListTruncated,
        messageFanoutTruncated,
    };
    privateSnapshotProjects.set(snapshot, project);
    return snapshot;
}
function selectStopTargets(runs, selector) {
    if (selector === "all")
        return [...runs];
    const exact = runs.filter((run) => run.id === selector);
    if (exact.length === 1)
        return exact;
    const prefixes = runs.filter((run) => run.id.startsWith(selector));
    if (prefixes.length === 1)
        return prefixes;
    if (prefixes.length > 1)
        throw new Error(`run prefix is ambiguous; use one of: ${prefixes.map(({ id }) => id).join(", ")}`);
    throw new Error(`no active Agent Harbor run matches “${openCodePublicLabel(selector, 80) ?? "invalid selector"}”`);
}
function nativeRunSessionID(run) {
    const id = privateRunSessionIDs.get(run);
    if (!id)
        throw new Error("OpenCode run identity is unavailable; no session was interrupted");
    return id;
}
function snapshotProject(snapshot) {
    const project = privateSnapshotProjects.get(snapshot);
    if (!project)
        throw new Error("OpenCode project identity is unavailable; no session was interrupted");
    return project;
}
/** Stops only sessions classified as Harbor and re-proven active by the v2 API. */
export async function stopOpenCodeTeamRuns(api, selector, options = {}) {
    if (selector.length > 256 || Buffer.byteLength(selector, "utf8") > 256) {
        throw new Error("OpenCode stop selector exceeds the 256-byte safety limit");
    }
    const requested = selector.trim();
    if (!requested)
        throw new Error("usage: /team stop <run-id|all>");
    const runtime = limits(options);
    const snapshot = await collectOpenCodeTeamSnapshot(api, options);
    const targets = selectStopTargets(snapshot.runs, requested);
    if (!snapshot.activeAuthoritative && (requested === "all" || !snapshot.exactStopAvailable)) {
        throw new Error("OpenCode active-session verification is unavailable; no session was interrupted. Retry /team after host RPC recovers");
    }
    if (!targets.length)
        return { requested, stopped: [], alreadyIdle: [], failed: [] };
    const recheck = await withDeadline((signal) => api.client.v2.session.active({ signal }), runtime.rpcDeadlineMs, runtime.signal);
    if (!recheck.ok)
        throw new Error("OpenCode active-session recheck failed; no session was interrupted");
    let active;
    try {
        active = parseActive(recheck.value, runtime.maximumActiveSessions, targets.map(nativeRunSessionID));
    }
    catch {
        throw new Error("OpenCode active-session recheck was incompatible; no session was interrupted");
    }
    if (active.truncated && requested === "all")
        throw new Error("OpenCode active-session recheck exceeded the safety bound; no session was interrupted");
    if (requested === "all" ? active.unknownEntries : active.preferredUnknownEntries) {
        throw new Error("OpenCode active-session recheck contained unknown status telemetry; no session was interrupted");
    }
    const activeIDs = new Set(active.ids);
    const ready = targets.filter((run) => activeIDs.has(nativeRunSessionID(run)));
    const alreadyIdle = targets.filter((run) => !activeIDs.has(nativeRunSessionID(run))).map(({ id }) => id);
    const deadlineAt = Date.now() + runtime.collectionDeadlineMs;
    const failed = new Set();
    let titleVerifier;
    if (ready.some(({ invocation }) => invocation !== "direct")) {
        const remaining = Math.min(runtime.rpcDeadlineMs, Math.max(1, deadlineAt - Date.now()));
        const loaded = await withDeadline(() => loadOpenCodeHarborTitleVerifier(defaultHome("opencode"), snapshotProject(snapshot)), remaining, runtime.signal);
        if (loaded.ok)
            titleVerifier = loaded.value;
    }
    const stopped = new Set();
    const processed = new Set();
    await mapWithConcurrency(ready, runtime.maximumConcurrency, deadlineAt, async (run) => {
        const nativeSessionID = nativeRunSessionID(run);
        processed.add(nativeSessionID);
        let remaining = Math.min(runtime.rpcDeadlineMs, Math.max(1, deadlineAt - Date.now()));
        const fresh = await withDeadline((signal) => api.client.v2.session.get({ sessionID: nativeSessionID }, { signal }), remaining, runtime.signal);
        let session;
        if (fresh.ok) {
            try {
                const envelope = object(responseData(fresh.value));
                session = parseSession(envelope?.data, snapshotProject(snapshot));
            }
            catch {
                session = undefined;
            }
        }
        if (!session) {
            failed.add(nativeSessionID);
            return;
        }
        if (run.invocation === "direct") {
            if (session.agent !== run.agent) {
                failed.add(nativeSessionID);
                return;
            }
            remaining = Math.min(runtime.rpcDeadlineMs, Math.max(1, deadlineAt - Date.now()));
            const messageResult = await withDeadline((signal) => api.client.v2.session.messages({
                sessionID: nativeSessionID,
                limit: runtime.maximumMessagesPerSession,
                order: "desc",
            }, { signal }), remaining, runtime.signal);
            let freshTurn;
            if (messageResult.ok) {
                try {
                    freshTurn = currentTurnMessages(parseMessages(messageResult.value, runtime.maximumMessagesPerSession).messages);
                }
                catch {
                    freshTurn = undefined;
                }
            }
            const sameBoundary = run.turnBoundaryID !== undefined && freshTurn?.boundaryID === run.turnBoundaryID;
            if (!sameBoundary) {
                failed.add(nativeSessionID);
                return;
            }
        }
        else {
            const claim = titleVerifier?.(session.title, session.nativeID);
            const expected = run.invocation === "delegated" ? "agent" : "contract";
            if (claim?.invocation !== expected || claim.agent !== run.agent) {
                failed.add(nativeSessionID);
                return;
            }
        }
        // OpenCode offers no conditional compare-and-interrupt primitive. Keep the
        // observable TOCTOU window minimal by interrupting immediately after this
        // target's own generation + ownership check instead of batching all GETs.
        remaining = Math.min(runtime.rpcDeadlineMs, Math.max(1, deadlineAt - Date.now()));
        const interrupted = await withDeadline((signal) => api.client.v2.session.interrupt({ sessionID: nativeSessionID }, { signal }), remaining, runtime.signal);
        if (!interrupted.ok) {
            failed.add(nativeSessionID);
            return;
        }
        try {
            responseData(interrupted.value);
            stopped.add(nativeSessionID);
        }
        catch {
            failed.add(nativeSessionID);
        }
    });
    for (const run of ready) {
        const nativeSessionID = nativeRunSessionID(run);
        if (!processed.has(nativeSessionID))
            failed.add(nativeSessionID);
    }
    return {
        requested,
        stopped: targets.filter((run) => stopped.has(nativeRunSessionID(run))).map(({ id }) => id),
        alreadyIdle,
        failed: targets.filter((run) => failed.has(nativeRunSessionID(run))).map(({ id }) => id),
    };
}
