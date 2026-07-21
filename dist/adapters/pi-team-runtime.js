/** In-memory, zero-model observability for Agent Harbor runs hosted by Pi. */
import { createHmac, randomBytes } from "node:crypto";
import { basename, resolve } from "node:path";
import { publicMetadataText, publicTaskLabel } from "../core/public-metadata.js";
import { wrapPlainLine, wrapPlainLines } from "../core/text-layout.js";
const usageKeys = ["input", "output", "reasoning", "cacheRead", "cacheWrite", "total"];
const activeStates = new Set(["starting", "working", "cleaning"]);
const terminalStates = new Set(["completed", "failed", "cancelled", "cleanup-error"]);
export const maximumPiObservedMessages = 4_096;
const maximumFingerprintDepth = 32;
const maximumFingerprintNodes = 256;
const maximumFingerprintEntries = 32;
const maximumFingerprintStringCodeUnits = 4_096;
export function piPublicIdentifier(value, limit = 80) {
    return typeof value === "string" ? publicMetadataText(value, limit) : undefined;
}
/** Produces a useful but deliberately lossy task label without retaining prompts, paths, or likely secrets. */
export function piTaskLabel(task) {
    return publicTaskLabel(task);
}
function nativeFiniteNumber(value) {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}
function nativeInteger(value) {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
function addSafeInteger(left, right) {
    if (left > Number.MAX_SAFE_INTEGER - right) {
        return { value: Number.MAX_SAFE_INTEGER, overflow: true };
    }
    return { value: left + right, overflow: false };
}
function sumSafeIntegers(values) {
    if (!values.length)
        return { value: undefined, overflow: false };
    let value = 0;
    let overflow = false;
    for (const amount of values) {
        const next = addSafeInteger(value, amount);
        value = next.value;
        overflow ||= next.overflow;
    }
    return { value, overflow };
}
function updatePrivateFingerprint(state, value, depth = 0) {
    const update = (tag, body = "") => {
        const bounded = body.length > maximumFingerprintStringCodeUnits
            ? body.slice(0, maximumFingerprintStringCodeUnits)
            : body;
        if (bounded.length !== body.length)
            state.truncated = true;
        state.fingerprint.update(`${tag}:${Buffer.byteLength(bounded, "utf8")}:`);
        state.fingerprint.update(bounded, "utf8");
        state.fingerprint.update(";");
    };
    if (value === null)
        return update("null");
    if (value === undefined)
        return update("undefined");
    if (typeof value === "string")
        return update("string", value);
    if (typeof value === "boolean")
        return update("boolean", value ? "1" : "0");
    if (typeof value === "number") {
        return update("number", Object.is(value, -0) ? "-0" : String(value));
    }
    if (typeof value === "bigint")
        return update("bigint", value.toString());
    if (typeof value === "symbol")
        return update("symbol");
    if (typeof value === "function")
        return update("function");
    if (depth > maximumFingerprintDepth || state.nodes >= maximumFingerprintNodes) {
        state.truncated = true;
        return update("bounded");
    }
    state.nodes += 1;
    const priorReference = state.seen.get(value);
    if (priorReference !== undefined)
        return update("reference", String(priorReference));
    state.seen.set(value, state.seen.size);
    if (Array.isArray(value)) {
        update("array-start", String(value.length));
        const length = Math.min(value.length, maximumFingerprintEntries);
        if (value.length > length)
            state.truncated = true;
        for (let index = 0; index < length; index += 1) {
            let present = false;
            try {
                present = Object.hasOwn(value, index);
            }
            catch {
                state.truncated = true;
                update("unreadable-item", String(index));
                continue;
            }
            update(present ? "item" : "hole", String(index));
            if (present) {
                try {
                    updatePrivateFingerprint(state, value[index], depth + 1);
                }
                catch {
                    state.truncated = true;
                    update("unreadable-value", String(index));
                }
            }
        }
        return update("array-end");
    }
    const keys = [];
    try {
        for (const key in value) {
            if (!Object.hasOwn(value, key))
                continue;
            if (keys.length === maximumFingerprintEntries) {
                state.truncated = true;
                break;
            }
            keys.push(key);
        }
    }
    catch {
        state.truncated = true;
        return update("unreadable-object");
    }
    keys.sort();
    update("object-start", String(keys.length));
    for (const key of keys) {
        update("key", key);
        try {
            updatePrivateFingerprint(state, value[key], depth + 1);
        }
        catch {
            state.truncated = true;
            update("unreadable-value", key);
        }
    }
    update("object-end");
}
/**
 * Produces an opaque, process-local identity without retaining message content.
 * A random HMAC key prevents short or predictable responses from being recovered
 * with an offline dictionary if runtime internals are inspected.
 */
function privateFingerprint(value, key) {
    const fingerprint = createHmac("sha256", key);
    const state = { fingerprint, seen: new Map(), nodes: 0, truncated: false };
    updatePrivateFingerprint(state, value);
    return { digest: fingerprint.digest("base64url"), truncated: state.truncated };
}
function messageKey(message, fingerprintKey) {
    const responseId = typeof message.responseId === "string"
        && /\S/u.test(message.responseId.slice(0, maximumFingerprintStringCodeUnits + 1))
        ? message.responseId
        : undefined;
    if (responseId) {
        const identity = privateFingerprint(responseId, fingerprintKey);
        return { key: `response:${identity.digest}`, truncated: identity.truncated };
    }
    const timestamp = nativeFiniteNumber(message.timestamp);
    const usage = message.usage && typeof message.usage === "object" ? message.usage : {};
    const hasContent = Object.hasOwn(message, "content");
    if (timestamp === undefined && !hasContent && !Object.keys(usage).length)
        return undefined;
    const identity = privateFingerprint({
        timestamp,
        provider: message.provider,
        model: message.responseModel ?? message.model,
        stopReason: message.stopReason,
        content: message.content,
        usage: {
            input: nativeInteger(usage.input),
            output: nativeInteger(usage.output),
            cacheRead: nativeInteger(usage.cacheRead),
            cacheWrite: nativeInteger(usage.cacheWrite),
            reasoning: nativeInteger(usage.reasoning),
            totalTokens: nativeInteger(usage.totalTokens),
        },
    }, fingerprintKey);
    return { key: `message:${identity.digest}`, truncated: identity.truncated };
}
function modelFrom(value) {
    if (!value || typeof value !== "object")
        return undefined;
    const provider = piPublicIdentifier(value.provider);
    // Routers such as OpenRouter retain the requested alias in `model` and
    // expose the concrete model that answered in `responseModel`.
    const id = piPublicIdentifier(value.responseModel ?? value.id ?? value.model);
    return provider && id ? { provider, id } : undefined;
}
function projectKey(project) {
    const absolute = resolve(project);
    return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}
function cloneUsage(run) {
    return Object.fromEntries(usageKeys.flatMap((key) => {
        const value = run.usage[key];
        return value === undefined ? [] : [[key, value]];
    }));
}
/** Process-local registry. It never persists task text or asks a model to summarize activity. */
export class PiTeamRuntime {
    now;
    maxRootRuns;
    runs = new Map();
    listeners = new Set();
    messageFingerprintKey = randomBytes(32);
    sequence = 0;
    constructor(now = Date.now, maxRootRuns = 32) {
        this.now = now;
        this.maxRootRuns = maxRootRuns;
    }
    begin(input) {
        const parent = input.parentRunId === undefined ? undefined : this.runs.get(input.parentRunId);
        if (input.parentRunId !== undefined && !parent)
            throw new Error("unknown parent team run");
        if (parent && parent.project !== projectKey(input.project))
            throw new Error("child team run must use its parent's project");
        const sequence = ++this.sequence;
        const id = `pi-run-${sequence}`;
        const initialModel = modelFrom(input.model);
        const run = {
            id,
            sequence,
            rootRunId: parent?.rootRunId ?? id,
            ...(parent ? { parentRunId: parent.id } : {}),
            project: projectKey(input.project),
            agent: piPublicIdentifier(input.agent) ?? "unknown-agent",
            kind: input.kind,
            task: piTaskLabel(input.task),
            state: "starting",
            startedAt: this.now(),
            ...(initialModel ? { model: initialModel } : {}),
            ...(initialModel ? { modelSource: input.modelSource ?? "inherited" } : {}),
            observedModels: new Map(),
            observedModelsTruncated: false,
            ...(input.thinking === undefined ? {} : { thinking: input.thinking }),
            usage: {},
            usageLowerBounds: new Set(),
            nativeMessages: 0,
            nativeMessagesLowerBound: false,
            seenMessageObjects: new WeakSet(),
            seenMessageKeys: new Set(),
        };
        this.runs.set(id, run);
        this.prune();
        this.emit(id);
        return id;
    }
    observer(runId) {
        return {
            sessionStarted: (info) => {
                const run = this.require(runId);
                const model = modelFrom(info?.model);
                if (model) {
                    run.model = model;
                    if (run.modelSource !== "configured")
                        run.modelSource = "inherited";
                }
                if (info?.thinking !== undefined)
                    run.thinking = info.thinking;
                this.setState(runId, "working");
            },
            messageEnd: (message) => { this.observeMessageEnd(runId, message); },
            state: (state) => { this.setState(runId, state); },
        };
    }
    setState(runId, state) {
        const run = this.require(runId);
        if (terminalStates.has(run.state) && state !== "cleanup-error")
            return;
        if (run.state === "cleanup-error")
            return;
        run.state = state;
        if (terminalStates.has(state))
            run.endedAt = this.now();
        if (terminalStates.has(state)) {
            run.seenMessageKeys.clear();
            run.seenMessageObjects = new WeakSet();
        }
        this.emit(runId);
        if (terminalStates.has(state))
            this.prune();
    }
    finishIfOpen(runId, outcome) {
        const run = this.require(runId);
        if (!terminalStates.has(run.state))
            this.setState(runId, outcome);
    }
    observeMessageEnd(runId, value) {
        const run = this.require(runId);
        if (terminalStates.has(run.state))
            return false;
        if (!value || typeof value !== "object")
            return false;
        const message = value;
        if (message.role !== "assistant")
            return false;
        if (run.seenMessageObjects.has(message))
            return false;
        if (run.nativeMessages >= maximumPiObservedMessages) {
            run.nativeMessagesLowerBound = true;
            for (const field of usageKeys)
                run.usageLowerBounds.add(field);
            this.emit(runId);
            return false;
        }
        const identity = messageKey(message, this.messageFingerprintKey);
        if (identity?.truncated) {
            run.nativeMessagesLowerBound = true;
            for (const field of usageKeys)
                run.usageLowerBounds.add(field);
        }
        if (identity && run.seenMessageKeys.has(identity.key))
            return false;
        run.seenMessageObjects.add(message);
        if (identity)
            run.seenMessageKeys.add(identity.key);
        const actualModel = modelFrom(message);
        if (actualModel) {
            run.model = actualModel;
            run.modelSource = "observed";
            const key = `${actualModel.provider}\0${actualModel.id}`;
            if (!run.observedModels.has(key)) {
                if (run.observedModels.size < 8)
                    run.observedModels.set(key, actualModel);
                else
                    run.observedModelsTruncated = true;
            }
        }
        const usage = message.usage && typeof message.usage === "object"
            ? message.usage
            : undefined;
        const incoming = {
            input: nativeInteger(usage?.input),
            output: nativeInteger(usage?.output),
            reasoning: nativeInteger(usage?.reasoning),
            cacheRead: nativeInteger(usage?.cacheRead),
            cacheWrite: nativeInteger(usage?.cacheWrite),
            total: nativeInteger(usage?.totalTokens),
        };
        const componentFields = ["input", "output", "cacheRead", "cacheWrite"];
        const componentValues = componentFields.map((field) => incoming[field]);
        const anyPositiveComponent = componentValues.some((value) => value !== undefined && value > 0);
        const everyComponentZero = componentValues.every((value) => value === 0);
        // Presence is authoritative: an explicit all-zero native usage object is
        // distinct from an omitted object. Contradictory totals remain unknown.
        if (incoming.total === 0 && anyPositiveComponent)
            incoming.total = undefined;
        if (incoming.total !== undefined && incoming.total > 0 && everyComponentZero) {
            for (const field of componentFields)
                incoming[field] = undefined;
        }
        for (const field of usageKeys) {
            const amount = incoming[field];
            if (amount === undefined) {
                run.usageLowerBounds.add(field);
            }
            else {
                const next = addSafeInteger(run.usage[field] ?? 0, amount);
                run.usage[field] = next.value;
                if (next.overflow)
                    run.usageLowerBounds.add(field);
            }
        }
        run.nativeMessages += 1;
        this.emit(runId);
        return true;
    }
    subscribe(listener) {
        this.listeners.add(listener);
        return () => { this.listeners.delete(listener); };
    }
    get(runId) {
        const run = this.runs.get(runId);
        return run ? this.snapshot(run) : undefined;
    }
    mission(rootRunId) {
        return [...this.runs.values()]
            .filter((run) => run.rootRunId === rootRunId)
            .sort((left, right) => left.sequence - right.sequence)
            .map((run) => this.snapshot(run));
    }
    projectRuns(project) {
        const key = projectKey(project);
        return [...this.runs.values()]
            .filter((run) => run.project === key)
            .sort((left, right) => right.sequence - left.sequence)
            .map((run) => this.snapshot(run));
    }
    activeProjectRuns(project) {
        return this.projectRuns(project).filter((run) => activeStates.has(run.state));
    }
    latestRoot(project) {
        return this.projectRuns(project).find((run) => run.parentRunId === undefined);
    }
    missionUsage(rootRunId) {
        const runs = this.mission(rootRunId);
        return Object.fromEntries(usageKeys.flatMap((field) => {
            const known = runs.flatMap((run) => run.usage[field] === undefined ? [] : [run.usage[field]]);
            const aggregate = sumSafeIntegers(known);
            return aggregate.value === undefined ? [] : [[field, aggregate.value]];
        }));
    }
    missionUsageLowerBounds(rootRunId) {
        const runs = this.mission(rootRunId);
        const usage = this.missionUsage(rootRunId);
        return usageKeys.filter((field) => {
            if (usage[field] === undefined)
                return false;
            const known = runs.flatMap((run) => run.usage[field] === undefined ? [] : [run.usage[field]]);
            return sumSafeIntegers(known).overflow || runs.some((run) => run.usage[field] === undefined || run.usageLowerBounds.includes(field));
        });
    }
    projectName(project) {
        return basename(resolve(project)) || "project";
    }
    snapshot(run) {
        const end = run.endedAt ?? this.now();
        return {
            id: run.id,
            sequence: run.sequence,
            rootRunId: run.rootRunId,
            ...(run.parentRunId === undefined ? {} : { parentRunId: run.parentRunId }),
            agent: run.agent,
            kind: run.kind,
            task: run.task,
            state: run.state,
            startedAt: run.startedAt,
            ...(run.endedAt === undefined ? {} : { endedAt: run.endedAt }),
            elapsedMs: Math.max(0, end - run.startedAt),
            ...(run.model === undefined ? {} : { model: { ...run.model } }),
            ...(run.modelSource === undefined ? {} : { modelSource: run.modelSource }),
            observedModels: [...run.observedModels.values()].map((model) => ({ ...model })),
            observedModelsTruncated: run.observedModelsTruncated,
            ...(run.thinking === undefined ? {} : { thinking: run.thinking }),
            usage: cloneUsage(run),
            usageLowerBounds: [...run.usageLowerBounds],
            nativeMessages: run.nativeMessages,
            nativeMessagesLowerBound: run.nativeMessagesLowerBound,
        };
    }
    require(runId) {
        const run = this.runs.get(runId);
        if (!run)
            throw new Error(`unknown Pi team run: ${runId}`);
        return run;
    }
    emit(runId) {
        for (const listener of this.listeners) {
            try {
                listener(runId);
            }
            catch { /* Observability must never break a child. */ }
        }
    }
    prune() {
        // Active roots are never evicted: callers must always be able to finish
        // telemetry even if RPC starts more work than the retained-history limit.
        const roots = [...this.runs.values()].filter((run) => run.parentRunId === undefined && terminalStates.has(run.state) &&
            [...this.runs.values()].every((candidate) => candidate.rootRunId !== run.id || terminalStates.has(candidate.state)))
            .sort((left, right) => right.sequence - left.sequence);
        // Retention stays globally bounded, but one noisy project cannot consume
        // every slot while another tracked project loses its only last mission.
        // When the number of projects itself exceeds the cap, the newest projects
        // win (an explicit project-level LRU), then remaining slots go to the
        // newest additional missions regardless of project.
        const keep = new Set();
        const newestByProject = new Map();
        for (const root of roots)
            if (!newestByProject.has(root.project))
                newestByProject.set(root.project, root);
        for (const root of [...newestByProject.values()]
            .sort((left, right) => right.sequence - left.sequence)
            .slice(0, this.maxRootRuns))
            keep.add(root.id);
        for (const root of roots) {
            if (keep.size >= this.maxRootRuns)
                break;
            keep.add(root.id);
        }
        for (const root of roots) {
            if (keep.has(root.id))
                continue;
            for (const run of this.runs.values())
                if (run.rootRunId === root.id)
                    this.runs.delete(run.id);
        }
    }
}
export function formatElapsed(milliseconds) {
    const seconds = Math.max(0, Math.floor(milliseconds / 1000));
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const remainder = seconds % 60;
    return hours > 0
        ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
        : `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}
export function formatTokenCount(value, lowerBound = false) {
    return value === undefined ? "—" : `${lowerBound ? "≥" : ""}${new Intl.NumberFormat("en-US").format(value)}`;
}
export function formatModel(run) {
    if (run.observedModels.length > 1 || run.observedModelsTruncated) {
        const models = run.observedModels.map(({ provider, id }) => `${provider}/${id}`).join(", ");
        return `mixed observed: ${models}${run.observedModelsTruncated ? ", +more" : ""}`;
    }
    return run.model
        ? `${run.model.provider}/${run.model.id} (${run.modelSource ?? "inherited"})`
        : "unknown/default (unobserved)";
}
export function formatUsage(usage, lowerBounds = []) {
    const lower = new Set(lowerBounds);
    return [
        `in ${formatTokenCount(usage.input, lower.has("input"))}`,
        `out ${formatTokenCount(usage.output, lower.has("output"))}`,
        `reason ${formatTokenCount(usage.reasoning, lower.has("reasoning"))}`,
        `cache r/w ${formatTokenCount(usage.cacheRead, lower.has("cacheRead"))}/${formatTokenCount(usage.cacheWrite, lower.has("cacheWrite"))}`,
        `total ${formatTokenCount(usage.total, lower.has("total"))}`,
    ].join(" · ");
}
/** Waits for best-effort shutdown cleanup without allowing a provider to hang Pi forever. */
export async function settlePiRootPromises(promises, timeoutMs = 5_000) {
    if (!promises.length)
        return true;
    let timer;
    const timeout = new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), Math.max(0, timeoutMs));
        timer.unref?.();
    });
    try {
        return await Promise.race([
            Promise.allSettled(promises).then(() => true),
            timeout,
        ]);
    }
    finally {
        if (timer)
            clearTimeout(timer);
    }
}
/** Formats selected run rows without inventing or leaking an aggregate. */
export function formatPiRunDetails(runs) {
    const lines = [];
    for (const run of runs) {
        const branch = run.parentRunId ? "  └─" : "●";
        const detail = run.parentRunId ? "     " : "  ";
        lines.push(`${branch} ${run.agent} · run ${run.id}${run.parentRunId ? ` · parent ${run.parentRunId}` : ""} · ${run.kind} · ${run.state} · ${formatElapsed(run.elapsedMs)}`);
        lines.push(`${detail}Task: “${run.task}”`);
        lines.push(`${detail}${formatModel(run)} · thinking setting ${run.thinking ?? "unknown"} · model turns ${run.nativeMessagesLowerBound ? "≥" : ""}${run.nativeMessages} · ${formatUsage(run.usage, run.usageLowerBounds)}`);
    }
    return wrapPlainLines(lines);
}
/** Shared mission details for the final notification and the zero-model history view. */
export function formatPiMissionDetails(runtime, rootRunId) {
    const runs = runtime.mission(rootRunId);
    if (!runs.length)
        return ["Team run unavailable."];
    const root = runs.find((run) => run.id === rootRunId) ?? runs[0];
    const lines = formatPiRunDetails(runs);
    lines.push(`Mission total · ${formatElapsed(root.elapsedMs)} · ${formatUsage(runtime.missionUsage(rootRunId), runtime.missionUsageLowerBounds(rootRunId))}`);
    return wrapPlainLines(lines);
}
/** Final accounting is composed outside child evidence, so a lead never sees or reasons over it. */
export function formatPiMissionReport(runtime, rootRunId) {
    return ["", "TEAM RUN (native Pi telemetry)", ...formatPiMissionDetails(runtime, rootRunId)].join("\n");
}
export function formatPiLiveStatus(runtime, rootRunId) {
    const runs = runtime.mission(rootRunId);
    const active = runs.filter((run) => activeStates.has(run.state));
    const focus = active.at(-1) ?? runs.at(-1);
    const usage = runtime.missionUsage(rootRunId);
    const totalLabel = formatTokenCount(usage.total, runtime.missionUsageLowerBounds(rootRunId).includes("total"));
    if (!focus)
        return "Agent Harbor · no active run";
    const counts = new Map();
    for (const run of active)
        counts.set(run.state, (counts.get(run.state) ?? 0) + 1);
    const breakdown = ["working", "starting", "cleaning"]
        .flatMap((state) => counts.has(state) ? [`${counts.get(state)} ${state}`] : [])
        .join(" · ");
    return wrapPlainLine(`Agent Harbor · ${active.length} active${breakdown ? ` (${breakdown})` : ""} · ${focus.agent} ${focus.state} · ${totalLabel} tok · ${formatElapsed(focus.elapsedMs)}`).join("\n");
}
export function formatPiLiveWidget(runtime, rootRunId) {
    const runs = runtime.mission(rootRunId);
    return wrapPlainLines([...runs.slice(-8).flatMap((run) => [
            `${run.parentRunId ? "  └─" : "●"} ${run.agent} · run ${run.id} · ${run.state} · ${formatModel(run)} · thinking setting ${run.thinking ?? "unknown"} · ${formatElapsed(run.elapsedMs)}`,
            `${run.parentRunId ? "     " : "  "}Task: “${run.task}” · model turns ${run.nativeMessagesLowerBound ? "≥" : ""}${run.nativeMessages} · ${formatTokenCount(run.usage.total, run.usageLowerBounds.includes("total"))} native tokens`,
        ]), "Alt+H: stop active Agent Harbor work"]);
}
