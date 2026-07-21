/** In-memory, zero-model observability for Agent Harbor runs hosted by Pi. */
import { createHmac, randomBytes } from "node:crypto";
import { basename, resolve } from "node:path";
import { wrapPlainLine, wrapPlainLines } from "../core/text-layout.js";
const usageKeys = ["input", "output", "reasoning", "cacheRead", "cacheWrite", "total"];
const activeStates = new Set(["starting", "working", "cleaning"]);
const terminalStates = new Set(["completed", "failed", "cancelled", "cleanup-error"]);
export function piPublicIdentifier(value, limit = 80) {
    if (typeof value !== "string")
        return undefined;
    const normalized = value
        .replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, " ")
        .replace(/[\p{Cc}\p{Cf}\s]+/gu, " ")
        .trim();
    return normalized ? [...normalized].slice(0, limit).join("") : undefined;
}
/** Produces a useful but deliberately lossy task label without retaining prompts, paths, or likely secrets. */
export function piTaskLabel(task) {
    const normalized = task
        .replace(/https?:\/\/\S+/giu, "[url]")
        .replace(/\\\\[^\\\s"'`]+(?:\\[^\\\s"'`]+)+/gu, "[path]")
        .replace(/\b[A-Za-z]:\\(?:[^\s"']+\\)*[^\s"']*/gu, "[path]")
        .replace(/(^|[\s"'`(])\/(?:[A-Za-z0-9._~-]+\/)*[A-Za-z0-9._~-]+(?=$|[\s"'`,.;:!?)}\]])/gu, "$1[path]")
        .replace(/(^|[\s"'`(])\.{1,2}[\\/](?:[^\s"'`\\/()]+[\\/])*[^\s"'`()]+/gu, "$1[path]")
        .replace(/(^|[\s"'`(])(?:[A-Za-z0-9_.-]+[\\/])+(?:[A-Za-z0-9_.-]*\.[A-Za-z0-9_.-]+)(?=$|[\s"'`,.;:!?)}\]])/gu, "$1[path]")
        .replace(/\b(?:authorization\s*:\s*)?bearer\s+[A-Za-z0-9._~+/=-]{12,}/giu, "[redacted]")
        .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, "[redacted]")
        .replace(/\b(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu, "$1=[redacted]")
        .replace(/\b(?:sk|pk|api|token|secret|key)[-_][A-Za-z0-9_-]{12,}\b/giu, "[redacted]")
        .replace(/[\p{Cc}\p{Cf}\s]+/gu, " ")
        .trim();
    if (!normalized)
        return "(task not disclosed)";
    const points = [...normalized];
    return points.length <= 72 ? normalized : `${points.slice(0, 69).join("")}…`;
}
function nativeNumber(value) {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}
function updatePrivateFingerprint(fingerprint, value, seen) {
    const update = (tag, body = "") => {
        fingerprint.update(`${tag}:${Buffer.byteLength(body, "utf8")}:`);
        fingerprint.update(body, "utf8");
        fingerprint.update(";");
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
    const priorReference = seen.get(value);
    if (priorReference !== undefined)
        return update("reference", String(priorReference));
    seen.set(value, seen.size);
    if (Array.isArray(value)) {
        update("array-start", String(value.length));
        for (let index = 0; index < value.length; index += 1) {
            update(Object.hasOwn(value, index) ? "item" : "hole", String(index));
            if (Object.hasOwn(value, index))
                updatePrivateFingerprint(fingerprint, value[index], seen);
        }
        return update("array-end");
    }
    const keys = Object.keys(value).sort();
    update("object-start", String(keys.length));
    for (const key of keys) {
        update("key", key);
        updatePrivateFingerprint(fingerprint, value[key], seen);
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
    updatePrivateFingerprint(fingerprint, value, new Map());
    return fingerprint.digest("base64url");
}
function messageKey(message, fingerprintKey) {
    const responseId = typeof message.responseId === "string" && message.responseId.trim()
        ? message.responseId
        : undefined;
    if (responseId)
        return `response:${privateFingerprint(responseId, fingerprintKey)}`;
    const timestamp = nativeNumber(message.timestamp);
    const usage = message.usage && typeof message.usage === "object" ? message.usage : {};
    const hasContent = Object.hasOwn(message, "content");
    if (timestamp === undefined && !hasContent && !Object.keys(usage).length)
        return undefined;
    return `message:${privateFingerprint({
        timestamp,
        provider: message.provider,
        model: message.responseModel ?? message.model,
        stopReason: message.stopReason,
        content: message.content,
        usage: {
            input: nativeNumber(usage.input),
            output: nativeNumber(usage.output),
            cacheRead: nativeNumber(usage.cacheRead),
            cacheWrite: nativeNumber(usage.cacheWrite),
            reasoning: nativeNumber(usage.reasoning),
            totalTokens: nativeNumber(usage.totalTokens),
        },
    }, fingerprintKey)}`;
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
            ...(initialModel ? { modelSource: "inherited" } : {}),
            observedModels: new Map(),
            observedModelsTruncated: false,
            ...(input.thinking === undefined ? {} : { thinking: input.thinking }),
            usage: {},
            usageLowerBounds: new Set(),
            nativeMessages: 0,
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
        if (!value || typeof value !== "object")
            return false;
        const message = value;
        if (message.role !== "assistant")
            return false;
        if (run.seenMessageObjects.has(message))
            return false;
        const key = messageKey(message, this.messageFingerprintKey);
        if (key && run.seenMessageKeys.has(key))
            return false;
        run.seenMessageObjects.add(message);
        if (key)
            run.seenMessageKeys.add(key);
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
        const usage = message.usage && typeof message.usage === "object" ? message.usage : {};
        const incoming = {
            input: nativeNumber(usage.input),
            output: nativeNumber(usage.output),
            reasoning: nativeNumber(usage.reasoning),
            cacheRead: nativeNumber(usage.cacheRead),
            cacheWrite: nativeNumber(usage.cacheWrite),
            total: nativeNumber(usage.totalTokens),
        };
        const componentFields = ["input", "output", "cacheRead", "cacheWrite"];
        const componentValues = componentFields.map((field) => incoming[field]);
        const anyPositiveComponent = componentValues.some((value) => value !== undefined && value > 0);
        const everyComponentZero = componentValues.every((value) => value === 0);
        // Pi initializes absent provider usage to an all-zero object. A real model
        // turn cannot consume zero input/cache and zero output simultaneously.
        if (incoming.total === 0 && everyComponentZero) {
            for (const field of [...componentFields, "reasoning", "total"])
                incoming[field] = undefined;
        }
        else {
            if (incoming.total === 0 && anyPositiveComponent)
                incoming.total = undefined;
            if (incoming.total !== undefined && incoming.total > 0 && everyComponentZero) {
                for (const field of componentFields)
                    incoming[field] = undefined;
            }
        }
        for (const field of usageKeys) {
            const amount = incoming[field];
            if (amount === undefined) {
                run.usageLowerBounds.add(field);
            }
            else {
                run.usage[field] = (run.usage[field] ?? 0) + amount;
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
            return known.length ? [[field, known.reduce((sum, value) => sum + value, 0)]] : [];
        }));
    }
    missionUsageLowerBounds(rootRunId) {
        const runs = this.mission(rootRunId);
        const usage = this.missionUsage(rootRunId);
        return usageKeys.filter((field) => usage[field] !== undefined && runs.some((run) => run.usage[field] === undefined || run.usageLowerBounds.includes(field)));
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
        for (const root of roots.slice(this.maxRootRuns)) {
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
        lines.push(`${detail}${formatModel(run)} · thinking setting ${run.thinking ?? "unknown"} · model turns ${run.nativeMessages} · ${formatUsage(run.usage, run.usageLowerBounds)}`);
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
    return wrapPlainLine(`Agent Harbor · ${active.length} working · ${focus.agent} ${focus.state} · ${totalLabel} tok · ${formatElapsed(focus.elapsedMs)}`).join("\n");
}
export function formatPiLiveWidget(runtime, rootRunId) {
    const runs = runtime.mission(rootRunId);
    return wrapPlainLines([...runs.slice(-8).flatMap((run) => [
            `${run.parentRunId ? "  └─" : "●"} ${run.agent} · run ${run.id} · ${run.state} · ${formatModel(run)} · thinking setting ${run.thinking ?? "unknown"} · ${formatElapsed(run.elapsedMs)}`,
            `${run.parentRunId ? "     " : "  "}Task: “${run.task}” · model turns ${run.nativeMessages} · ${formatTokenCount(run.usage.total, run.usageLowerBounds.includes("total"))} native tokens`,
        ]), "Alt+H: stop active Agent Harbor work"]);
}
