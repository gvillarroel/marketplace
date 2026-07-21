/**
 * Copilot hook guard that constrains native `task` delegation and correlates
 * host lifecycle events into privacy-preserving Agent Harbor evidence.
 */
import { createHmac, randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { listManagedActiveIds } from "../core/active.js";
import { rolePlayers } from "../core/defaults.js";
import { emitHarborEvidence, fingerprintHarborEvidence } from "../core/evidence.js";
import { harnessProfileLayout } from "../core/harnesses.js";
import { isHarborId } from "../core/identity.js";
import { copilotTaskLabel } from "./copilot-team-runtime.js";
/** Maps stable Harbor role IDs to Copilot's plugin-qualified runtime IDs. */
const specializedCopilotRoles = new Map([
    ["team-lead", "agent-foundry:team-lead"],
]);
export const copilotFixedAgentIds = new Map([...rolePlayers.keys()].map((id) => [id, specializedCopilotRoles.get(id) ?? `agent-foundry:${id}`]));
/** Plugin-qualified identity used only by the explicit `/scout` command. */
export const copilotScoutAgentId = "agent-foundry:talent-scout";
function samePath(left, right) {
    const normalize = (value) => process.platform === "win32" ? resolve(value).toLowerCase() : resolve(value);
    return normalize(left) === normalize(right);
}
function activePath(project, id) {
    const { activeDir, extension } = harnessProfileLayout("copilot");
    return resolve(project, activeDir, `${id}${extension}`);
}
/** Lists canonical active project profile IDs without trusting arbitrary files. */
export function listCopilotActiveProfileIds(project) {
    return listManagedActiveIds("copilot", project);
}
/** Resolves one logical ID to exactly one currently invocable Copilot identity. */
export function resolveCopilotPlayer(id, agents, project, activeProfileIds = listCopilotActiveProfileIds(project)) {
    const fixedId = id === "talent-scout" ? copilotScoutAgentId : copilotFixedAgentIds.get(id);
    if (fixedId) {
        const matches = agents.filter((agent) => agent.id === fixedId);
        if (matches.length === 1)
            return matches[0];
        if (matches.length > 1)
            throw new Error(`active Agent Harbor player is ambiguous: ${id}`);
        throw new Error(`Agent Harbor player is not active in Copilot: ${id}`);
    }
    if (!activeProfileIds.includes(id)) {
        throw new Error(`Agent Harbor player is not active: ${id}; run /bench on ${id}`);
    }
    const expectedPath = activePath(project, id);
    const matches = agents.filter((agent) => agent.id === id && agent.path && samePath(agent.path, expectedPath));
    if (matches.length === 1)
        return matches[0];
    if (matches.length > 1)
        throw new Error(`active Agent Harbor player is ambiguous: ${id}`);
    throw new Error(`Agent Harbor player is not active in Copilot: ${id}`);
}
function deny(reason) {
    return { permissionDecision: "deny", permissionDecisionReason: reason };
}
function structuredToolArgs(value) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
        try {
            const serialized = JSON.stringify(value);
            return Buffer.byteLength(serialized, "utf8") <= 100_000 ? value : undefined;
        }
        catch {
            return undefined;
        }
    }
    if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value, "utf8") > 100_000)
        return undefined;
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined;
    }
    catch {
        return undefined;
    }
}
function publicCopilotMetadata(value, limit = 200) {
    if (typeof value !== "string")
        return undefined;
    const normalized = value
        .replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, " ")
        .replace(/[\p{Cc}\p{Cf}\s]+/gu, " ")
        .trim();
    return normalized ? [...normalized].slice(0, limit).join("") : undefined;
}
function nativeCounter(value) {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}
function coordinatorRpcTimeoutMs() {
    const configured = Number(process.env.AGENT_HARBOR_COPILOT_RPC_TIMEOUT_MS);
    return Number.isFinite(configured) ? Math.min(60_000, Math.max(250, Math.floor(configured))) : 15_000;
}
async function boundedCoordinatorRpc(label, action, timeoutMs = coordinatorRpcTimeoutMs()) {
    let timer;
    try {
        return await Promise.race([
            Promise.resolve().then(action),
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
                timer.unref?.();
            }),
        ]);
    }
    finally {
        clearTimeout(timer);
    }
}
/**
 * Enforce the team-lead contract around Copilot's native synchronous `task`
 * tool. The host remains responsible for the child lifecycle and result.
 */
export function createCopilotCoordinatorGuard(getSession, evidenceHook, lifecycleHook, admissionHook) {
    const correlationKey = randomBytes(32);
    const privateCorrelationKey = (namespace, value) => {
        const digest = createHmac("sha256", correlationKey);
        digest.update(namespace, "utf8");
        digest.update("\0", "utf8");
        digest.update(typeof value === "string" ? value : JSON.stringify(value) ?? String(value), "utf8");
        return digest.digest("base64url");
    };
    const publicOpaqueCorrelation = (namespace, value, limit = 200) => {
        const publicValue = publicCopilotMetadata(value, limit);
        if (!publicValue || typeof value !== "string" || [...value].length <= limit)
            return publicValue;
        const suffix = privateCorrelationKey(namespace, value).slice(0, 16);
        const prefix = publicCopilotMetadata(value, Math.max(1, limit - suffix.length - 1));
        return prefix ? `${prefix}~${suffix}` : suffix;
    };
    const opaqueEventKey = (value) => typeof value === "string" && value
        ? privateCorrelationKey("event", value)
        : undefined;
    const counts = new Map();
    const inFlight = new Set();
    const unclaimedTaskCalls = [];
    const pending = new Map();
    let snapshot = { ready: false, agents: [] };
    let selectionEpoch = 0;
    let refreshEpoch = 0;
    let lifecycleSequence = 0;
    let selectedModel;
    let selectedReasoningEffort;
    const activeRoots = new Map();
    let guard = Promise.resolve();
    // Hook callbacks and asynchronous refreshes share state. A tiny promise lock
    // makes their ordering deterministic without blocking the host event loop.
    const locked = (action) => {
        const result = guard.then(action, action);
        guard = result.then(() => undefined, () => undefined);
        return result;
    };
    const serialized = (value) => {
        if (typeof value === "string")
            return value;
        if (value === undefined)
            return "";
        try {
            return JSON.stringify(value);
        }
        catch {
            return String(value);
        }
    };
    const emitLifecycle = (event) => {
        if (!lifecycleHook)
            return;
        try {
            const result = lifecycleHook(event);
            if (result && typeof result.then === "function") {
                void Promise.resolve(result).catch(() => undefined);
            }
        }
        catch { /* Observability must never change delegation or cleanup. */ }
    };
    const correlation = (run, basis, event) => {
        const eventId = publicOpaqueCorrelation("event", event?.id);
        const parentEventId = event?.parentId === null ? null : publicOpaqueCorrelation("event", event?.parentId);
        const timestamp = publicCopilotMetadata(event?.timestamp, 80);
        return {
            sessionId: run.sessionId,
            project: run.project,
            rootRunId: run.rootRunId,
            runId: run.runId,
            ...(run.parentRunId === undefined ? {} : { parentRunId: run.parentRunId }),
            kind: run.kind,
            agent: run.agent,
            runtimeAgent: run.runtimeAgent,
            ...(run.childId === undefined ? {} : { childId: run.childId }),
            ...(run.invocationId === undefined ? {} : { invocationId: run.invocationId }),
            ...(run.turnId === undefined ? {} : { turnId: run.turnId }),
            ...(eventId === undefined ? {} : { eventId }),
            ...(parentEventId === undefined ? {} : { parentEventId }),
            ...(timestamp === undefined ? {} : { timestamp }),
            basis,
        };
    };
    const setLifecycleState = (run, state, basis, event) => {
        if (run.state === state || run.finished)
            return;
        run.state = state;
        emitLifecycle({ ...correlation(run, basis, event), type: "run.state", state });
    };
    const observeLifecycleModel = (run, value, basis, event) => {
        const model = publicCopilotMetadata(value);
        if (!model || run.model === model || run.finished)
            return;
        run.model = model;
        emitLifecycle({ ...correlation(run, basis, event), type: "run.model", model });
    };
    const observeLifecycleReasoning = (run, value, basis, event) => {
        const reasoningEffort = value === null ? null : publicCopilotMetadata(value, 40);
        if (reasoningEffort === undefined || run.reasoningEffort === reasoningEffort || run.finished)
            return;
        run.reasoningEffort = reasoningEffort;
        emitLifecycle({ ...correlation(run, basis, event), type: "run.reasoning", reasoningEffort });
    };
    const startLifecycle = (run, basis, event, model) => {
        if (run.started || run.finished)
            return;
        run.started = true;
        const publicModel = publicCopilotMetadata(model);
        if (run.kind === "root") {
            emitLifecycle({
                ...correlation(run, basis, event),
                type: "root.started",
                kind: "root",
                taskLabel: run.taskLabel,
                ...(publicModel === undefined ? {} : { model: publicModel }),
                ...(publicModel === undefined ? {} : { modelSource: run.modelSource ?? "inherited" }),
                ...(selectedReasoningEffort === undefined ? {} : { reasoningEffort: selectedReasoningEffort }),
            });
        }
        else {
            emitLifecycle({
                ...correlation(run, basis, event),
                type: "child.started",
                kind: "child",
                parentRunId: run.parentRunId,
                taskLabel: run.taskLabel,
                ...(publicModel === undefined ? {} : { model: publicModel }),
            });
        }
        setLifecycleState(run, "starting", basis, event);
        if (publicModel)
            observeLifecycleModel(run, publicModel, basis, event);
        if (run.kind === "root" && selectedReasoningEffort !== undefined) {
            observeLifecycleReasoning(run, selectedReasoningEffort, basis, event);
        }
    };
    const finishLifecycle = (run, outcome, basis, event, aggregates) => {
        if (run.finished)
            return;
        if (!run.started)
            startLifecycle(run, "inferred", event, event?.data?.model);
        const state = outcome === "completed" ? "completed" : outcome === "failed" ? "failed" : "cancelled";
        setLifecycleState(run, state, basis, event);
        run.finished = true;
        const nativeDuration = nativeCounter(aggregates?.durationMs);
        const durationMs = nativeDuration ?? Math.max(0, Date.now() - run.startedAt);
        const totalTokens = nativeCounter(aggregates?.totalTokens);
        const totalToolCalls = nativeCounter(aggregates?.totalToolCalls);
        emitLifecycle({
            ...correlation(run, basis, event),
            type: "run.finished",
            outcome,
            durationMs,
            ...(totalTokens === undefined ? {} : { totalTokens }),
            ...(totalToolCalls === undefined ? {} : { totalToolCalls }),
        });
    };
    const harborPlayerForIdentity = (project, identity) => {
        const runtimeAgent = identity?.id;
        if (!runtimeAgent)
            return undefined;
        const fixed = [...copilotFixedAgentIds].find(([, exact]) => exact === runtimeAgent);
        const logicalId = runtimeAgent === copilotScoutAgentId ? "talent-scout" : fixed?.[0];
        try {
            if (logicalId) {
                const resolved = resolveCopilotPlayer(logicalId, snapshot.agents, project);
                return resolved.id === runtimeAgent
                    ? { agent: logicalId, runtimeAgent, ...(resolved.model === undefined ? {} : { model: resolved.model }) }
                    : undefined;
            }
            if (!listCopilotActiveProfileIds(project).includes(runtimeAgent))
                return undefined;
            // An id-only current selection is common in the SDK. Validate it against
            // every same-id registry entry so order cannot select a foreign path and
            // duplicate exact definitions remain fail-closed as ambiguous.
            const candidates = identity.path
                ? [identity]
                : snapshot.agents.filter(({ id }) => id === runtimeAgent);
            const resolved = resolveCopilotPlayer(runtimeAgent, candidates, project);
            return resolved.id === runtimeAgent
                ? { agent: runtimeAgent, runtimeAgent, ...(resolved.model === undefined ? {} : { model: resolved.model }) }
                : undefined;
        }
        catch {
            return undefined;
        }
    };
    const selectedHarborPlayer = (project) => {
        const selected = snapshot.current;
        if (!selected)
            return undefined;
        return harborPlayerForIdentity(project, selected);
    };
    const startRootLifecycle = (sessionId, project, taskLabel, player, basis) => {
        const runId = `copilot-root-${++lifecycleSequence}`;
        const root = {
            sessionId,
            project,
            runId,
            rootRunId: runId,
            kind: "root",
            agent: player.agent,
            runtimeAgent: player.runtimeAgent,
            taskLabel,
            ...(player.model === undefined ? {} : { modelSource: "configured" }),
            started: false,
            finished: false,
            startedAt: Date.now(),
            observedActivity: false,
            observedEventIds: new Set(),
            seenUsageIds: new Set(),
        };
        activeRoots.set(sessionId, root);
        startLifecycle(root, basis, { timestamp: new Date(root.startedAt).toISOString() }, player.model ?? selectedModel);
        setLifecycleState(root, "working", basis);
        return root;
    };
    const latestRootLifecycle = () => {
        const roots = [...activeRoots.values()].filter((run) => !run.finished);
        return roots.at(-1);
    };
    const lifecycleItemForEvent = (event) => {
        const childId = event.agentId;
        const invocationId = event.data?.toolCallId ?? event.data?.parentToolCallId;
        return [...pending.values()].find((item) => (childId !== undefined && item.childId === childId) ||
            (invocationId !== undefined && item.invocationId === invocationId));
    };
    const lifecycleRunForEvent = (event) => {
        if (event.agentId || event.data?.parentToolCallId)
            return lifecycleItemForEvent(event)?.lifecycle;
        return latestRootLifecycle();
    };
    const rememberLifecycleEventId = (run, event) => {
        const eventId = opaqueEventKey(event?.id);
        if (!eventId || run.observedEventIds.has(eventId))
            return;
        if (run.observedEventIds.size >= 256) {
            const oldest = run.observedEventIds.values().next().value;
            if (oldest)
                run.observedEventIds.delete(oldest);
        }
        run.observedEventIds.add(eventId);
    };
    const markLifecycleActivity = (run, event) => {
        run.observedActivity = true;
        rememberLifecycleEventId(run, event);
        const root = run.kind === "root" ? run : activeRoots.get(run.sessionId);
        if (root && root !== run) {
            root.observedActivity = true;
            rememberLifecycleEventId(root, event);
        }
    };
    const lifecycleEventBelongsToRun = (run, event) => {
        const timestamp = event.timestamp === undefined ? Number.NaN : Date.parse(event.timestamp);
        if (Number.isFinite(timestamp) && timestamp < run.startedAt)
            return false;
        const parentEventId = opaqueEventKey(event.parentId);
        if (parentEventId === undefined || run.observedEventIds.has(parentEventId))
            return true;
        // The first current event seeds the native chain. Once activity exists,
        // an unknown parent is evidence that a delayed event belongs elsewhere.
        return !run.observedActivity;
    };
    const extendRootEventChain = (event) => {
        const root = latestRootLifecycle();
        if (!root || root.finished || event.type === "session.idle" || !lifecycleEventBelongsToRun(root, event))
            return;
        rememberLifecycleEventId(root, event);
    };
    const sessionIdleBelongsToRoot = (root, event) => {
        return root.observedActivity && lifecycleEventBelongsToRun(root, event);
    };
    const observeLifecycleUsage = (event) => {
        const run = lifecycleRunForEvent(event);
        if (!run || run.finished || !lifecycleEventBelongsToRun(run, event))
            return;
        const apiCallId = publicOpaqueCorrelation("usage:api", event.data?.apiCallId);
        const serviceRequestId = publicOpaqueCorrelation("usage:service", event.data?.serviceRequestId);
        const providerCallId = publicOpaqueCorrelation("usage:provider", event.data?.providerCallId);
        const usageAliases = [
            event.data?.apiCallId === undefined ? undefined : privateCorrelationKey("usage:api", event.data.apiCallId),
            event.data?.serviceRequestId === undefined ? undefined : privateCorrelationKey("usage:service", event.data.serviceRequestId),
            event.data?.providerCallId === undefined ? undefined : privateCorrelationKey("usage:provider", event.data.providerCallId),
            event.id === undefined ? undefined : privateCorrelationKey("usage:event", event.id),
        ].filter((value) => value !== undefined);
        const replay = usageAliases.some((alias) => run.seenUsageIds.has(alias));
        for (const alias of usageAliases) {
            if (!run.seenUsageIds.has(alias) && run.seenUsageIds.size >= 512) {
                const oldest = run.seenUsageIds.values().next().value;
                if (oldest)
                    run.seenUsageIds.delete(oldest);
            }
            run.seenUsageIds.add(alias);
        }
        if (replay)
            return;
        const inputTokens = nativeCounter(event.data?.inputTokens);
        const outputTokens = nativeCounter(event.data?.outputTokens);
        const reasoningTokens = nativeCounter(event.data?.reasoningTokens);
        const cacheReadTokens = nativeCounter(event.data?.cacheReadTokens);
        const cacheWriteTokens = nativeCounter(event.data?.cacheWriteTokens);
        const usage = {
            ...(inputTokens === undefined ? {} : { inputTokens }),
            ...(outputTokens === undefined ? {} : { outputTokens }),
            ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
            ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
            ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
            ...(inputTokens === undefined || outputTokens === undefined ? {} : { totalTokens: inputTokens + outputTokens }),
        };
        observeLifecycleModel(run, event.data?.model, "observed", event);
        observeLifecycleReasoning(run, event.data?.reasoningEffort, "observed", event);
        emitLifecycle({
            ...correlation(run, "observed", event),
            type: "run.usage",
            ...(apiCallId === undefined ? {} : { apiCallId }),
            ...(serviceRequestId === undefined ? {} : { serviceRequestId }),
            ...(providerCallId === undefined ? {} : { providerCallId }),
            ...(run.model === undefined ? {} : { model: run.model }),
            ...(run.reasoningEffort === undefined ? {} : { reasoningEffort: run.reasoningEffort }),
            usage,
        });
    };
    const finishTaskNow = (input, sessionId, outcome) => {
        if (input.toolName !== "task")
            return;
        const item = pending.get(sessionId);
        if (item) {
            const base = {
                harness: "copilot",
                agent: item.agent,
                runtimeAgent: item.runtimeAgent,
                parentSessionId: sessionId,
                childId: item.childId,
                invocationId: item.lifecycle.invocationId,
            };
            if (!item.childId) {
                emitHarborEvidence(evidenceHook, { ...base, phase: "child.started", outcome: "ok", basis: "inferred" });
                emitHarborEvidence(evidenceHook, { ...base, phase: "prompt.attempted", outcome: "ok", basis: "inferred" });
            }
            if (outcome === "completed") {
                const result = serialized(input.toolResult);
                emitHarborEvidence(evidenceHook, { ...base, phase: "evidence.returned", outcome: "ok", evidence: fingerprintHarborEvidence(result) });
                emitHarborEvidence(evidenceHook, { ...base, phase: "child.completed", outcome: "ok" });
            }
            else {
                const error = input.error;
                emitHarborEvidence(evidenceHook, {
                    ...base,
                    phase: "child.failed",
                    outcome: "error",
                    error: error === undefined
                        ? item.errorFingerprint ?? fingerprintHarborEvidence("Copilot task failed")
                        : fingerprintHarborEvidence(error),
                });
            }
            emitHarborEvidence(evidenceHook, { ...base, phase: "child.cleaned", outcome: "ok", basis: "inferred" });
            finishLifecycle(item.lifecycle, outcome, item.terminal ? "observed" : "inferred");
            const root = activeRoots.get(sessionId);
            if (root && !root.finished)
                setLifecycleState(root, "working", "inferred");
            pending.delete(sessionId);
        }
        inFlight.delete(sessionId);
    };
    const finishTask = async (input, sessionId, outcome) => {
        await locked(() => { finishTaskNow(input, sessionId, outcome); });
    };
    const finishSessionLifecycle = (rootOutcome, event) => {
        const root = latestRootLifecycle();
        const sessionId = root?.sessionId ?? [...pending.keys()].at(-1);
        if (sessionId) {
            const item = pending.get(sessionId);
            if (item && !item.lifecycle.finished) {
                finishLifecycle(item.lifecycle, rootOutcome === "cancelled" ? "cancelled" : "failed", "inferred", event);
            }
            pending.delete(sessionId);
            inFlight.delete(sessionId);
            counts.delete(sessionId);
        }
        unclaimedTaskCalls.length = 0;
        if (root) {
            finishLifecycle(root, rootOutcome, "observed", event);
            activeRoots.delete(root.sessionId);
        }
    };
    const refreshSnapshot = async (expectedCurrentId, requirePublication = false) => {
        const strict = requirePublication || expectedCurrentId !== undefined;
        const generation = ++refreshEpoch;
        let refreshSelectionEpoch = 0;
        const currentGeneration = await locked(() => {
            if (generation !== refreshEpoch)
                return false;
            refreshSelectionEpoch = selectionEpoch;
            snapshot = { ready: false, current: snapshot.current, agents: [] };
            return true;
        });
        if (!currentGeneration) {
            if (strict)
                throw new Error(expectedCurrentId === undefined
                    ? "Copilot coordinator snapshot refresh was superseded"
                    : "Copilot coordinator selection synchronization was superseded");
            return;
        }
        try {
            const listed = await boundedCoordinatorRpc("Copilot agent registry reload", () => getSession().rpc.agent.reload());
            const current = await boundedCoordinatorRpc("Copilot current agent read", () => getSession().rpc.agent.getCurrent());
            if (expectedCurrentId !== undefined && current.agent?.id !== expectedCurrentId) {
                throw new Error(`Copilot selected agent did not stabilize as ${expectedCurrentId}`);
            }
            const publication = await locked(() => {
                if (generation !== refreshEpoch)
                    return "stale";
                const selected = selectionEpoch === refreshSelectionEpoch
                    ? current.agent ?? undefined
                    : snapshot.current;
                if (expectedCurrentId !== undefined && selected?.id !== expectedCurrentId) {
                    snapshot = { ready: false, current: selected, agents: [] };
                    return "selection-changed";
                }
                snapshot = {
                    ready: true,
                    current: selected,
                    agents: [...listed.agents],
                };
                return "published";
            });
            if (publication !== "published" && strict) {
                throw new Error(publication === "stale"
                    ? expectedCurrentId === undefined
                        ? "Copilot coordinator snapshot refresh was superseded"
                        : "Copilot coordinator selection synchronization was superseded"
                    : `Copilot selected agent changed before ${expectedCurrentId} was synchronized`);
            }
        }
        catch (error) {
            const publishedFailure = await locked(() => {
                if (generation !== refreshEpoch)
                    return false;
                snapshot = {
                    ready: false,
                    current: selectionEpoch === refreshSelectionEpoch ? undefined : snapshot.current,
                    agents: [],
                };
                return true;
            });
            // A newer refresh owns the snapshot and its result supersedes this one.
            if (publishedFailure || strict)
                throw error;
        }
    };
    const refresh = (expectedCurrentId) => refreshSnapshot(expectedCurrentId);
    const refreshAuthoritative = () => refreshSnapshot(undefined, true);
    const hooks = {
        onUserPromptSubmitted: async (input, invocation) => {
            if (input.sessionId !== invocation.sessionId)
                return;
            const currentRoot = activeRoots.get(invocation.sessionId);
            if (currentRoot && !currentRoot.finished)
                return;
            const selectionEpochBeforeRead = selectionEpoch;
            let authoritativeCurrent;
            let authoritativeRead = false;
            try {
                authoritativeCurrent = (await boundedCoordinatorRpc("Copilot prompt agent observation", () => getSession().rpc.agent.getCurrent(), Math.min(coordinatorRpcTimeoutMs(), 500))).agent ?? undefined;
                authoritativeRead = true;
            }
            catch { /* Best-effort observation falls back after its short independent deadline. */ }
            await locked(() => {
                const previousRoot = activeRoots.get(invocation.sessionId);
                if (previousRoot && !previousRoot.finished) {
                    // Copilot can steer or queue another user prompt while a turn/child is
                    // active. It remains the same root until a native session terminal.
                    return;
                }
                const previousChild = pending.get(invocation.sessionId);
                if (previousChild)
                    finishLifecycle(previousChild.lifecycle, "cancelled", "inferred");
                counts.delete(invocation.sessionId);
                inFlight.delete(invocation.sessionId);
                pending.delete(invocation.sessionId);
                unclaimedTaskCalls.length = 0;
                let player;
                if (authoritativeRead && selectionEpoch === selectionEpochBeforeRead) {
                    if (snapshot.current?.id !== authoritativeCurrent?.id)
                        selectionEpoch += 1;
                    snapshot.current = authoritativeCurrent;
                    player = harborPlayerForIdentity(input.workingDirectory, authoritativeCurrent);
                }
                else {
                    // A native selection event observed while the RPC was pending is
                    // newer than the read's starting generation and remains authoritative.
                    player = selectedHarborPlayer(input.workingDirectory);
                }
                if (player)
                    startRootLifecycle(invocation.sessionId, input.workingDirectory, copilotTaskLabel(input.prompt ?? ""), player, "observed");
            });
        },
        onPreToolUse: async (input, invocation) => {
            if (input.toolName !== "task")
                return;
            const teamLeadId = copilotFixedAgentIds.get("team-lead");
            let authoritativeCurrent;
            try {
                authoritativeCurrent = (await boundedCoordinatorRpc("Copilot current agent verification", () => getSession().rpc.agent.getCurrent())).agent ?? undefined;
            }
            catch (error) {
                return deny(`Agent Harbor cannot verify the current agent and fails closed for task delegation: ${error instanceof Error ? error.message : String(error)}`);
            }
            if (authoritativeCurrent?.id !== teamLeadId) {
                await locked(() => {
                    if (snapshot.current?.id !== authoritativeCurrent?.id)
                        selectionEpoch += 1;
                    snapshot.current = authoritativeCurrent;
                });
                return;
            }
            const activeRoot = activeRoots.get(invocation.sessionId);
            if (activeRoot && !activeRoot.finished)
                markLifecycleActivity(activeRoot);
            try {
                await refresh(teamLeadId);
            }
            catch (error) {
                return deny(`Agent Harbor coordinator snapshot is unavailable; reload the session: ${error instanceof Error ? error.message : String(error)}`);
            }
            return locked(async () => {
                try {
                    if (!snapshot.ready)
                        return deny("Agent Harbor coordinator snapshot is unavailable; reload the session");
                    if (snapshot.current?.id !== teamLeadId)
                        return deny("Agent Harbor team-lead selection changed during delegation preflight");
                    const invocationId = unclaimedTaskCalls.shift();
                    const publicInvocationId = publicOpaqueCorrelation("tool", invocationId);
                    if (input.sessionId !== invocation.sessionId) {
                        return deny("Agent Harbor blocks nested coordinator delegation");
                    }
                    const args = structuredToolArgs(input.toolArgs);
                    if (!args) {
                        return deny("Agent Harbor task arguments must be a bounded object");
                    }
                    const agentType = typeof args.agent_type === "string" ? args.agent_type.trim() : "";
                    const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
                    if (!agentType)
                        return deny("Agent Harbor delegation requires an exact agent_type");
                    if (!isHarborId(agentType) && ![...copilotFixedAgentIds.values()].includes(agentType)) {
                        return deny("Agent Harbor delegation requires a canonical agent_type");
                    }
                    if (!prompt)
                        return deny("Agent Harbor delegation requires a non-empty prompt");
                    if (Buffer.byteLength(prompt, "utf8") > 30_000)
                        return deny("Agent Harbor delegation prompt exceeds 30000 bytes");
                    if (agentType === "team-lead" || agentType === copilotFixedAgentIds.get("team-lead")) {
                        return deny("Agent Harbor cannot recursively invoke team-lead");
                    }
                    if (inFlight.has(invocation.sessionId)) {
                        return deny("Agent Harbor coordinator delegations must run sequentially");
                    }
                    const count = counts.get(invocation.sessionId) ?? 0;
                    if (count >= 6)
                        return deny("Agent Harbor allows at most six delegations per user prompt");
                    const fixed = [...copilotFixedAgentIds].find(([, exact]) => exact === agentType);
                    const logicalId = fixed?.[0] ?? agentType;
                    let target;
                    try {
                        target = resolveCopilotPlayer(logicalId, snapshot.agents, input.workingDirectory);
                    }
                    catch (error) {
                        return deny(error instanceof Error ? error.message : String(error));
                    }
                    if (target.id !== agentType)
                        return deny(`Agent Harbor requires exact agent_type ${target.id}`);
                    if (target.userInvocable === false)
                        return deny(`Agent Harbor player is not invocable: ${logicalId}`);
                    const root = activeRoots.get(invocation.sessionId) ?? startRootLifecycle(invocation.sessionId, input.workingDirectory, "(task not disclosed)", { agent: "team-lead", runtimeAgent: copilotFixedAgentIds.get("team-lead") }, "inferred");
                    const childRunId = `copilot-child-${++lifecycleSequence}`;
                    const lifecycle = {
                        sessionId: invocation.sessionId,
                        project: input.workingDirectory,
                        runId: childRunId,
                        rootRunId: root.rootRunId,
                        parentRunId: root.runId,
                        kind: "child",
                        agent: logicalId,
                        runtimeAgent: target.id,
                        taskLabel: copilotTaskLabel(prompt),
                        ...(publicInvocationId === undefined ? {} : { invocationId: publicInvocationId }),
                        started: false,
                        finished: false,
                        startedAt: Date.now(),
                        observedActivity: false,
                        observedEventIds: new Set(),
                        seenUsageIds: new Set(),
                    };
                    admissionHook?.({
                        type: "child",
                        project: input.workingDirectory,
                        rootRunId: root.rootRunId,
                        parentRunId: root.runId,
                        runId: lifecycle.runId,
                        agent: logicalId,
                        runtimeAgent: target.id,
                        taskLabel: lifecycle.taskLabel,
                    });
                    counts.set(invocation.sessionId, count + 1);
                    inFlight.add(invocation.sessionId);
                    pending.set(invocation.sessionId, { agent: logicalId, runtimeAgent: target.id, invocationId, lifecycle });
                    setLifecycleState(root, "waiting", "observed");
                    emitHarborEvidence(evidenceHook, {
                        harness: "copilot",
                        phase: "target.resolved",
                        agent: logicalId,
                        runtimeAgent: target.id,
                        parentSessionId: invocation.sessionId,
                        invocationId: publicInvocationId,
                        outcome: "ok",
                        task: fingerprintHarborEvidence(prompt),
                    });
                    return { permissionDecision: "allow" };
                }
                catch (error) {
                    return deny(`Agent Harbor delegation preflight failed: ${error instanceof Error ? error.message : String(error)}`);
                }
            });
        },
        onPostToolUse: async (input, invocation) => finishTask(input, invocation.sessionId, "completed"),
        onPostToolUseFailure: async (input, invocation) => finishTask(input, invocation.sessionId, "failed"),
    };
    return {
        hooks,
        refresh,
        refreshAuthoritative,
        observeEvent: (event) => {
            extendRootEventChain(event);
            if (event.type === "assistant.turn_start" ||
                event.type === "assistant.usage" ||
                event.type === "assistant.message" ||
                event.type === "assistant.idle" ||
                event.type === "tool.execution_start" ||
                event.type === "tool.execution_complete" ||
                event.type === "subagent.started" ||
                event.type === "subagent.completed" ||
                event.type === "subagent.failed" ||
                event.type === "abort") {
                const activityRun = lifecycleRunForEvent(event);
                if (activityRun && lifecycleEventBelongsToRun(activityRun, event))
                    markLifecycleActivity(activityRun, event);
            }
            if (event.type === "session.start") {
                selectedModel = publicCopilotMetadata(event.data?.selectedModel);
                selectedReasoningEffort = event.data?.reasoningEffort === null
                    ? null
                    : publicCopilotMetadata(event.data?.reasoningEffort, 40);
            }
            if (event.type === "subagent.selected" && !event.agentId && event.data?.agentName) {
                selectionEpoch += 1;
                snapshot.current = {
                    id: copilotFixedAgentIds.get(event.data.agentName) ?? event.data.agentName,
                    userInvocable: true,
                };
            }
            else if (event.type === "subagent.deselected" && !event.agentId) {
                selectionEpoch += 1;
                snapshot.current = undefined;
            }
            if (event.type === "assistant.turn_start") {
                const run = lifecycleRunForEvent(event);
                if (run && lifecycleEventBelongsToRun(run, event)) {
                    run.turnId = publicCopilotMetadata(event.data?.turnId) ?? run.turnId;
                    if (event.agentId)
                        run.childId = publicOpaqueCorrelation("child", event.agentId) ?? run.childId;
                    if (!run.started)
                        startLifecycle(run, "observed", event, event.data?.model);
                    setLifecycleState(run, "working", "observed", event);
                    observeLifecycleModel(run, event.data?.model, "observed", event);
                }
            }
            else if (event.type === "session.model_change") {
                const run = lifecycleRunForEvent(event);
                const model = publicCopilotMetadata(event.data?.newModel);
                const effort = event.data?.reasoningEffort === null
                    ? null
                    : publicCopilotMetadata(event.data?.reasoningEffort, 40);
                if (!event.agentId) {
                    if (model)
                        selectedModel = model;
                    if (effort !== undefined)
                        selectedReasoningEffort = effort;
                }
                if (run && lifecycleEventBelongsToRun(run, event)) {
                    if (!run.started)
                        startLifecycle(run, "inferred", event, model);
                    observeLifecycleModel(run, model, "observed", event);
                    observeLifecycleReasoning(run, effort, "observed", event);
                }
            }
            else if (event.type === "assistant.usage") {
                const run = lifecycleRunForEvent(event);
                if (run && lifecycleEventBelongsToRun(run, event)) {
                    if (event.agentId)
                        run.childId = publicOpaqueCorrelation("child", event.agentId) ?? run.childId;
                    if (!run.started)
                        startLifecycle(run, "inferred", event, event.data?.model);
                }
                observeLifecycleUsage(event);
            }
            else if (event.type === "assistant.idle") {
                const run = lifecycleRunForEvent(event);
                if (run && lifecycleEventBelongsToRun(run, event)) {
                    if (!run.started)
                        startLifecycle(run, "inferred", event, event.data?.model);
                    setLifecycleState(run, "idle", "observed", event);
                }
            }
            else if (event.type === "abort") {
                const run = lifecycleRunForEvent(event);
                if (run && lifecycleEventBelongsToRun(run, event)) {
                    if (!run.started)
                        startLifecycle(run, "inferred", event, event.data?.model);
                    setLifecycleState(run, "cancelling", "observed", event);
                }
            }
            else if (event.type === "session.idle") {
                const root = latestRootLifecycle();
                if (!event.agentId && !event.data?.parentToolCallId && root && sessionIdleBelongsToRoot(root, event)) {
                    finishSessionLifecycle(event.data?.aborted === true ? "cancelled" : "completed", event);
                }
            }
            else if (event.type === "session.error") {
                if (!event.agentId && !event.data?.parentToolCallId)
                    finishSessionLifecycle("failed", event);
            }
            else if (event.type === "session.shutdown") {
                if (!event.agentId && !event.data?.parentToolCallId) {
                    finishSessionLifecycle(event.data?.shutdownType === "error" ? "failed" : "cancelled", event);
                }
            }
            const entries = [...pending.entries()];
            const toolCallId = event.data?.toolCallId;
            if (event.type === "tool.execution_start" && !event.agentId && event.data?.toolName === "task" && toolCallId) {
                const uncorrelated = entries.filter(([, state]) => !state.invocationId);
                if (uncorrelated.length === 1) {
                    uncorrelated[0][1].invocationId = toolCallId;
                    uncorrelated[0][1].lifecycle.invocationId = publicOpaqueCorrelation("tool", toolCallId);
                }
                else if (snapshot.current?.id === copilotFixedAgentIds.get("team-lead"))
                    unclaimedTaskCalls.push(toolCallId);
                return;
            }
            const item = toolCallId
                ? entries.find(([, state]) => state.invocationId === toolCallId)
                : event.type === "tool.execution_complete" && event.data?.toolDescription?.name === "task" && entries.length === 1
                    ? entries[0]
                    : undefined;
            if (!item)
                return;
            const [sessionId, state] = item;
            if (event.type === "subagent.started" && event.data?.agentName === state.runtimeAgent && toolCallId === state.invocationId) {
                state.childId = event.agentId;
                state.lifecycle.childId = publicOpaqueCorrelation("child", event.agentId);
                state.lifecycle.invocationId = publicOpaqueCorrelation("tool", toolCallId) ?? state.lifecycle.invocationId;
                startLifecycle(state.lifecycle, "observed", event, event.data?.model);
                setLifecycleState(state.lifecycle, "working", "observed", event);
                observeLifecycleModel(state.lifecycle, event.data?.model, "observed", event);
                const base = {
                    harness: "copilot",
                    agent: state.agent,
                    runtimeAgent: state.runtimeAgent,
                    parentSessionId: sessionId,
                    childId: state.lifecycle.childId,
                    invocationId: state.lifecycle.invocationId,
                };
                emitHarborEvidence(evidenceHook, { ...base, phase: "child.started", outcome: "ok" });
                emitHarborEvidence(evidenceHook, { ...base, phase: "prompt.attempted", outcome: "ok" });
            }
            else if (event.type === "subagent.completed" && event.data?.agentName === state.runtimeAgent && toolCallId === state.invocationId) {
                state.terminal = "completed";
                observeLifecycleModel(state.lifecycle, event.data?.model, "observed", event);
                finishLifecycle(state.lifecycle, "completed", "observed", event, event.data);
                const root = activeRoots.get(sessionId);
                if (root)
                    setLifecycleState(root, "working", "observed", event);
            }
            else if (event.type === "subagent.failed" && event.data?.agentName === state.runtimeAgent && toolCallId === state.invocationId) {
                state.terminal = "failed";
                state.errorFingerprint = fingerprintHarborEvidence(serialized(event.data.error));
                observeLifecycleModel(state.lifecycle, event.data?.model, "observed", event);
                finishLifecycle(state.lifecycle, "failed", "observed", event, event.data);
                const root = activeRoots.get(sessionId);
                if (root)
                    setLifecycleState(root, "working", "observed", event);
            }
            else if (event.type === "tool.execution_complete" && !event.agentId && (event.data?.toolDescription?.name === "task" ||
                Boolean(state.invocationId && event.data?.toolCallId === state.invocationId))) {
                const data = event.data;
                const result = serialized(data.result);
                const input = {
                    sessionId,
                    workingDirectory: "",
                    toolName: "task",
                    toolArgs: {},
                    toolResult: result,
                };
                // Host events are observed synchronously. Finalize the child before a
                // contiguous session.idle can infer a contradictory failure.
                finishTaskNow(input, sessionId, data.success === false || state.terminal === "failed" ? "failed" : "completed");
            }
        },
    };
}
