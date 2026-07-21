/**
 * Copilot hook guard that constrains native `task` delegation and correlates
 * host lifecycle events into privacy-preserving Agent Harbor evidence.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
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
/** True only for events emitted by the main/root loop, including deprecated correlation fields. */
function rootScopedHostEvent(event) {
    return !event.agentId && !event.data?.parentToolCallId && event.data?.initiator !== "sub-agent";
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
const lifecycleStateOrder = {
    starting: 0,
    working: 1,
    waiting: 2,
    idle: 3,
    cancelling: 4,
    completed: 5,
    failed: 5,
    cancelled: 5,
};
function lifecycleStateRank(state) {
    return lifecycleStateOrder[state];
}
const contractReferencePattern = /(?:^|\s)\/(?:agent-foundry\/)?contract(?:\s|$)/u;
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
    const samePrivateCorrelation = (left, right) => {
        const leftBytes = Buffer.from(left, "utf8");
        const rightBytes = Buffer.from(right, "utf8");
        return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
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
    const processedEventIds = new Set();
    const claimHostEvent = (event) => {
        const key = opaqueEventKey(event.id);
        if (!key)
            return true;
        if (processedEventIds.has(key))
            return false;
        if (processedEventIds.size >= 4_096) {
            const oldest = processedEventIds.values().next().value;
            if (oldest)
                processedEventIds.delete(oldest);
        }
        processedEventIds.add(key);
        return true;
    };
    const claimedNativeSessionTerminalKeys = new Map();
    const claimedFallbackSessionTerminalKeys = new Map();
    const childScopedSessionTerminalTypes = new Set();
    const hostEventClaims = new WeakMap();
    const hostEventDispositions = new WeakMap();
    const terminalEventDispositions = new WeakMap();
    let lifecycleIdentityUnverified = false;
    // These ledgers are deliberately saturating and non-evicting. Once a native
    // identity has owned lifecycle state, forgetting it could attribute a replay
    // to a later root after the bounded general event cache rotates.
    const criticalAliasOwners = new Map();
    const criticalFallbackOwners = new Map();
    const subagentPhaseToolChildren = new Map();
    // Large enough that normal SDK traffic does not hit a 4,096-event cliff;
    // saturation still fails closed instead of forgetting older mission owners.
    const maximumCriticalAliases = 65_536;
    const maximumCriticalFallbacks = 512;
    const claimSessionTerminal = (event, currentRootRunId) => {
        if (event.type !== "session.idle" && event.type !== "session.error" &&
            event.type !== "session.shutdown")
            return "claimed";
        const childScoped = Boolean(event.agentId || event.data?.parentToolCallId ||
            event.data?.initiator === "sub-agent");
        if (childScoped)
            childScopedSessionTerminalTypes.add(event.type);
        const nativeKey = opaqueEventKey(event.id);
        if (nativeKey) {
            if (claimedNativeSessionTerminalKeys.has(nativeKey))
                return "replay";
            if (claimedNativeSessionTerminalKeys.size >= maximumCriticalAliases)
                return "unverified";
            claimedNativeSessionTerminalKeys.set(nativeKey, currentRootRunId);
            return "claimed";
        }
        if (lifecycleIdentityUnverified || childScoped || childScopedSessionTerminalTypes.has(event.type)) {
            return "unverified";
        }
        const key = privateCorrelationKey("session-terminal-fallback", {
            type: event.type,
            parentId: event.parentId ?? null,
            agentId: event.agentId ?? null,
            parentToolCallId: event.data?.parentToolCallId ?? null,
            toolCallId: event.data?.toolCallId ?? null,
        });
        // An anonymous terminal with no active root has no safe owner. Treat it as
        // an inert replay and do not reserve a fallback key that could poison the
        // next legitimate mission.
        if (currentRootRunId === undefined)
            return "replay";
        if (claimedFallbackSessionTerminalKeys.has(key)) {
            if (claimedFallbackSessionTerminalKeys.get(key) === currentRootRunId)
                return "replay";
            return "unverified";
        }
        if (claimedFallbackSessionTerminalKeys.size >= 512)
            return "unverified";
        claimedFallbackSessionTerminalKeys.set(key, currentRootRunId);
        return "claimed";
    };
    const counts = new Map();
    const inFlight = new Set();
    const unclaimedTaskCalls = [];
    const pending = new Map();
    const contractInvocations = new Map();
    const blockedContractSessions = new Set();
    const maximumBlockedContractSessions = 256;
    let blockNextPromptForUnscopedContractEvent = false;
    const rememberBlockedContractSession = (sessionId) => {
        if (blockedContractSessions.has(sessionId))
            return;
        if (blockedContractSessions.size < maximumBlockedContractSessions) {
            blockedContractSessions.add(sessionId);
            return;
        }
        // Never evict an older blocked session and accidentally fail it open. At
        // capacity, retain a process-local fail-closed signal until reload.
        blockNextPromptForUnscopedContractEvent = true;
    };
    const invalidateContract = (state, reason) => {
        state.invalidReason ??= reason;
        return state.invalidReason;
    };
    const promptContexts = new Map();
    let latestPromptSessionId;
    let promptEpochSequence = 0;
    let snapshot = { ready: false, agents: [] };
    let selectionEpoch = 0;
    let selectionObservedAt;
    let selectionObservedDeselected = false;
    const selectionEventIdsAtObservedTime = new Set();
    let refreshEpoch = 0;
    let lifecycleSequence = 0;
    let selectedModel;
    let selectedReasoningEffort;
    let selectedModelObservedAt;
    let selectedReasoningObservedAt;
    const selectedModelEventIdsAtObservedTime = new Set();
    const selectedReasoningEventIdsAtObservedTime = new Set();
    const selectedUntimedModelEventIds = new Set();
    const selectedUntimedReasoningEventIds = new Set();
    const selectionUntimedEventIds = new Set();
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
    const safeTerminalObservation = (event) => ({
        type: event.type,
        ...(event.id === undefined ? {} : { id: event.id }),
        ...(event.parentId === undefined ? {} : { parentId: event.parentId }),
        ...(event.timestamp === undefined ? {} : { timestamp: event.timestamp }),
        ...(event.agentId === undefined ? {} : { agentId: event.agentId }),
        data: {
            ...(publicCopilotMetadata(event.data?.model) === undefined
                ? {}
                : { model: publicCopilotMetadata(event.data?.model) }),
            ...(nativeCounter(event.data?.durationMs) === undefined
                ? {}
                : { durationMs: nativeCounter(event.data?.durationMs) }),
            ...(nativeCounter(event.data?.totalTokens) === undefined
                ? {}
                : { totalTokens: nativeCounter(event.data?.totalTokens) }),
            ...(nativeCounter(event.data?.totalToolCalls) === undefined
                ? {}
                : { totalToolCalls: nativeCounter(event.data?.totalToolCalls) }),
        },
    });
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
            ...(run.memberKind === undefined ? {} : { memberKind: run.memberKind }),
        };
    };
    const untimedObservationKey = (domain, event, value) => opaqueEventKey(event?.id) ?? privateCorrelationKey(`untimed:${domain}`, {
        type: event?.type ?? null,
        parentId: event?.parentId ?? null,
        agentId: event?.agentId ?? null,
        turnId: event?.data?.turnId ?? null,
        toolCallId: event?.data?.toolCallId ?? null,
        parentToolCallId: event?.data?.parentToolCallId ?? null,
        value,
    });
    const setLifecycleState = (run, state, basis, event) => {
        if (run.finished)
            return;
        if (basis === "observed" && eventObservedAt(event) === undefined) {
            const stateKey = untimedObservationKey("state", event, state);
            if (run.untimedStateEventKeys.has(stateKey))
                return;
            if (run.untimedStateEventKeys.size >= 512) {
                if (lifecycleStateRank(state) < lifecycleStateRank("cancelling"))
                    return;
            }
            else {
                run.untimedStateEventKeys.add(stateKey);
            }
        }
        const observedAt = basis === "observed" && event?.timestamp !== undefined
            ? Date.parse(event.timestamp)
            : Number.NaN;
        if (Number.isFinite(observedAt)) {
            if (run.stateObservedAt !== undefined && (observedAt < run.stateObservedAt ||
                (observedAt === run.stateObservedAt && run.state !== undefined &&
                    lifecycleStateRank(state) < lifecycleStateRank(run.state))))
                return;
            run.stateObservedAt = observedAt;
        }
        if (run.state === state)
            return;
        run.state = state;
        emitLifecycle({ ...correlation(run, basis, event), type: "run.state", state });
    };
    const eventObservedAt = (event) => {
        if (event?.timestamp === undefined)
            return undefined;
        const value = Date.parse(event.timestamp);
        return Number.isFinite(value) ? value : undefined;
    };
    const acceptLatestTimestampedEvent = (event, currentObservedAt, eventIdsAtObservedTime, untimedEventIds, domain, fallbackValue) => {
        const observedAt = eventObservedAt(event);
        if (observedAt === undefined) {
            const eventKey = untimedObservationKey(domain, event, fallbackValue);
            if (untimedEventIds.has(eventKey) || untimedEventIds.size >= 256) {
                return { accepted: false, observedAt: currentObservedAt };
            }
            untimedEventIds.add(eventKey);
            return { accepted: true, observedAt: currentObservedAt };
        }
        if (currentObservedAt !== undefined && observedAt < currentObservedAt) {
            return { accepted: false, observedAt: currentObservedAt };
        }
        const eventKey = opaqueEventKey(event?.id);
        if (currentObservedAt === undefined || observedAt > currentObservedAt) {
            eventIdsAtObservedTime.clear();
        }
        else if (!eventKey || eventIdsAtObservedTime.has(eventKey) || eventIdsAtObservedTime.size >= 64) {
            return { accepted: false, observedAt: currentObservedAt };
        }
        if (eventKey)
            eventIdsAtObservedTime.add(eventKey);
        return { accepted: true, observedAt };
    };
    const acceptSelectionObservation = (event, deselected) => {
        const observedAt = eventObservedAt(event);
        if (observedAt === undefined) {
            const eventKey = untimedObservationKey("selection", event, {
                deselected,
                agentName: event.data?.agentName ?? null,
            });
            if (selectionUntimedEventIds.has(eventKey))
                return false;
            if (selectionUntimedEventIds.size >= 256)
                return deselected;
            selectionUntimedEventIds.add(eventKey);
            selectionObservedDeselected = deselected;
            return true;
        }
        if (selectionObservedAt !== undefined && observedAt < selectionObservedAt)
            return false;
        const eventKey = opaqueEventKey(event.id);
        if (selectionObservedAt === undefined || observedAt > selectionObservedAt) {
            selectionObservedAt = observedAt;
            selectionEventIdsAtObservedTime.clear();
        }
        else if (eventKey && selectionEventIdsAtObservedTime.has(eventKey)) {
            return false;
        }
        else if (!eventKey && selectionObservedDeselected && !deselected) {
            // Without a native identity, same-time deselection wins fail-closed.
            return false;
        }
        if (eventKey) {
            if (selectionEventIdsAtObservedTime.size >= 64) {
                // Do not forget same-timestamp replay identities. At pathological
                // capacity, only a deselection may advance the fail-closed state.
                if (!deselected)
                    return false;
            }
            else {
                selectionEventIdsAtObservedTime.add(eventKey);
            }
        }
        selectionObservedDeselected = deselected;
        return true;
    };
    const observeLifecycleModel = (run, value, basis, event) => {
        const model = publicCopilotMetadata(value);
        if (!model || run.finished)
            return;
        if (basis === "observed") {
            const timing = acceptLatestTimestampedEvent(event, run.modelObservedAt, run.modelEventIdsAtObservedTime, run.untimedModelEventIds, "model", model);
            if (!timing.accepted)
                return;
            run.modelObservedAt = timing.observedAt;
        }
        if (run.model === model) {
            if (basis !== "observed" || event?.id === undefined || run.observedModelConfirmed)
                return;
            run.observedModelConfirmed = true;
            emitLifecycle({ ...correlation(run, basis, event), type: "run.model", model });
            return;
        }
        run.model = model;
        run.observedModelConfirmed = basis === "observed" && event?.id !== undefined;
        emitLifecycle({ ...correlation(run, basis, event), type: "run.model", model });
    };
    const observeLifecycleReasoning = (run, value, basis, event) => {
        const reasoningEffort = value === null ? null : publicCopilotMetadata(value, 40);
        if (reasoningEffort === undefined || run.finished)
            return;
        if (basis === "observed") {
            const timing = acceptLatestTimestampedEvent(event, run.reasoningObservedAt, run.reasoningEventIdsAtObservedTime, run.untimedReasoningEventIds, "reasoning", reasoningEffort);
            if (!timing.accepted)
                return;
            run.reasoningObservedAt = timing.observedAt;
        }
        if (run.reasoningEffort === reasoningEffort) {
            if (basis !== "observed" || event?.id === undefined || run.observedReasoningConfirmed)
                return;
            run.observedReasoningConfirmed = true;
            emitLifecycle({ ...correlation(run, basis, event), type: "run.reasoning", reasoningEffort });
            return;
        }
        run.reasoningEffort = reasoningEffort;
        run.observedReasoningConfirmed = basis === "observed" && event?.id !== undefined;
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
            const candidates = snapshot.agents.filter(({ id }) => id === runtimeAgent);
            if (identity.path && !candidates.some((candidate) => candidate.path !== undefined && samePath(candidate.path, identity.path)))
                return undefined;
            const resolved = resolveCopilotPlayer(runtimeAgent, candidates, project);
            if (identity.path && (!resolved.path || !samePath(resolved.path, identity.path)))
                return undefined;
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
            untimedStateEventKeys: new Set(),
            modelEventIdsAtObservedTime: new Set(),
            untimedModelEventIds: new Set(),
            reasoningEventIdsAtObservedTime: new Set(),
            untimedReasoningEventIds: new Set(),
            seenUsageIds: new Set(),
            observedModelConfirmed: false,
            observedReasoningConfirmed: false,
        };
        activeRoots.set(sessionId, root);
        startLifecycle(root, basis, { timestamp: new Date(root.startedAt).toISOString() }, player.model ?? selectedModel);
        setLifecycleState(root, "working", basis);
        return root;
    };
    const exactContractControl = (value) => {
        const args = structuredToolArgs(value);
        if (!args || Object.keys(args).sort().join("\0") !== "args\0command")
            return undefined;
        if (args.command !== "contract" || typeof args.args !== "string")
            return undefined;
        return { args: args.args, hash: privateCorrelationKey("contract:control-args", args.args) };
    };
    const contractTaskMetadata = (raw) => {
        try {
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
                throw new Error("invalid contract");
            const record = parsed;
            return {
                contractorAgent: typeof record.name === "string" && isHarborId(record.name.trim())
                    ? record.name.trim()
                    : "contractor",
                taskLabel: typeof record.task === "string" ? copilotTaskLabel(record.task) : "(task not disclosed)",
            };
        }
        catch {
            return { contractorAgent: "contractor", taskLabel: "(invalid contract preflight)" };
        }
    };
    const exactContractDescriptor = (result) => {
        if (!result || typeof result !== "object" || Array.isArray(result))
            return undefined;
        const output = result;
        let parsedContent;
        if (typeof output.content === "string") {
            try {
                parsedContent = JSON.parse(output.content);
            }
            catch { /* A structured result remains authoritative when model-facing text was truncated. */ }
        }
        const hasStructured = Object.prototype.hasOwnProperty.call(output, "structuredContent");
        const structured = output.structuredContent;
        if (hasStructured && (!structured || typeof structured !== "object" || Array.isArray(structured))) {
            return undefined;
        }
        const descriptor = hasStructured
            ? structured
            : parsedContent && typeof parsedContent === "object" && !Array.isArray(parsedContent)
                ? parsedContent
                : undefined;
        if (!descriptor)
            return undefined;
        if (Object.keys(descriptor).sort().join("\0") !== "agent_type\0description\0prompt")
            return undefined;
        const agentType = descriptor.agent_type;
        const description = descriptor.description;
        const prompt = descriptor.prompt;
        if (typeof agentType !== "string" || !agentType || typeof description !== "string" ||
            typeof prompt !== "string" || !prompt)
            return undefined;
        if (hasStructured && parsedContent !== undefined) {
            if (!parsedContent || typeof parsedContent !== "object" || Array.isArray(parsedContent))
                return undefined;
            const record = parsedContent;
            if (Object.keys(record).sort().join("\0") !== "agent_type\0description\0prompt" ||
                record.agent_type !== agentType || record.description !== description || record.prompt !== prompt)
                return undefined;
        }
        return {
            agentType: privateCorrelationKey("contract:agent-type", agentType),
            description: privateCorrelationKey("contract:description", description),
            prompt: privateCorrelationKey("contract:prompt", prompt),
            runtimeAgent: publicCopilotMetadata(agentType, 120) ?? "contractor",
        };
    };
    const startContractWrapper = (event) => {
        if (!rootScopedHostEvent(event) || event.data?.agentName !== undefined)
            return;
        const sessionId = typeof event.data?.sessionId === "string" && promptContexts.has(event.data.sessionId)
            ? event.data.sessionId
            : latestPromptSessionId;
        if (!sessionId)
            return;
        const context = promptContexts.get(sessionId);
        if (!context)
            return;
        const eventAt = event.timestamp === undefined ? Number.NaN : Date.parse(event.timestamp);
        if (Number.isFinite(eventAt) && eventAt < context.submittedAt)
            return;
        const existing = contractInvocations.get(sessionId);
        if (existing) {
            const replayHash = event.id === undefined ? undefined : privateCorrelationKey("contract:skill-event", event.id);
            if (replayHash && existing.reservationEventHash &&
                samePrivateCorrelation(replayHash, existing.reservationEventHash))
                return;
            invalidateContract(existing, "Agent Harbor /contract may be invoked only once per user turn");
            return;
        }
        const state = {
            sessionId,
            project: context.project,
            contractorAgent: "contractor",
            taskLabel: "(awaiting validated contract)",
            controlCompleted: false,
            taskAttempted: false,
            taskAdmitted: false,
            taskFinalized: false,
            ...(event.id === undefined ? {} : {
                reservationEventHash: privateCorrelationKey("contract:skill-event", event.id),
            }),
        };
        contractInvocations.set(sessionId, state);
        const previousRoot = activeRoots.get(sessionId);
        if (previousRoot && !previousRoot.finished) {
            if (context.rootRunId === previousRoot.runId && !pending.has(sessionId) && !inFlight.has(sessionId)) {
                previousRoot.agent = "contract";
                previousRoot.runtimeAgent = "agent-foundry:contract";
                previousRoot.taskLabel = "validate and run one disposable contractor";
                previousRoot.memberKind = "utility";
                state.root = previousRoot;
                emitLifecycle({
                    ...correlation(previousRoot, "observed", event),
                    type: "run.identity",
                    agent: previousRoot.agent,
                    runtimeAgent: previousRoot.runtimeAgent,
                    taskLabel: previousRoot.taskLabel,
                    memberKind: "utility",
                });
                markLifecycleActivity(previousRoot, event);
            }
            else {
                state.admissionError = "Agent Harbor /contract cannot attach to work from another turn or an in-flight child";
            }
            return;
        }
        const runId = `copilot-root-${++lifecycleSequence}`;
        const root = {
            sessionId,
            project: context.project,
            runId,
            rootRunId: runId,
            kind: "root",
            agent: "contract",
            runtimeAgent: "agent-foundry:contract",
            taskLabel: "validate and run one disposable contractor",
            memberKind: "utility",
            started: false,
            finished: false,
            startedAt: Date.now(),
            observedActivity: false,
            observedEventIds: new Set(),
            untimedStateEventKeys: new Set(),
            modelEventIdsAtObservedTime: new Set(),
            untimedModelEventIds: new Set(),
            reasoningEventIdsAtObservedTime: new Set(),
            untimedReasoningEventIds: new Set(),
            seenUsageIds: new Set(),
            observedModelConfirmed: false,
            observedReasoningConfirmed: false,
        };
        try {
            admissionHook?.({
                type: "root",
                project: context.project,
                rootRunId: runId,
                runId,
                agent: root.agent,
                runtimeAgent: root.runtimeAgent,
                taskLabel: root.taskLabel,
                memberKind: "utility",
            });
        }
        catch (error) {
            state.admissionError = publicCopilotMetadata(error instanceof Error ? error.message : String(error), 300)
                ?? "Agent Harbor /contract root admission failed";
            return;
        }
        state.root = root;
        context.rootRunId = runId;
        activeRoots.set(sessionId, root);
        startLifecycle(root, "observed", event, event.data?.model ?? selectedModel);
        setLifecycleState(root, "working", "observed", event);
        markLifecycleActivity(root, event);
    };
    const latestRootLifecycle = () => {
        const roots = [...activeRoots.values()].filter((run) => !run.finished);
        return roots.at(-1);
    };
    const contractStateForRoot = () => {
        const root = latestRootLifecycle();
        return root ? contractInvocations.get(root.sessionId) : undefined;
    };
    const lifecycleItemForEvent = (event) => {
        const childId = event.agentId;
        const invocationId = event.data?.toolCallId ?? event.data?.parentToolCallId;
        return [...pending.values()].find((item) => {
            const knownChildId = item.childId ?? item.provisionalChildId;
            const childMatches = childId !== undefined && knownChildId === childId;
            // Once native child identity is sealed, a shared parent tool call cannot
            // reattribute activity from another child to this lifecycle.
            if (childId !== undefined && knownChildId !== undefined)
                return childMatches;
            return childMatches || (invocationId !== undefined && item.invocationId === invocationId);
        });
    };
    const lifecycleRunForEvent = (event) => {
        if (event.agentId || event.data?.parentToolCallId || event.data?.initiator === "sub-agent") {
            const correlated = lifecycleItemForEvent(event)?.lifecycle;
            if (correlated)
                return correlated;
            if (event.agentId)
                return undefined;
            if (event.data?.initiator === "sub-agent" && pending.size === 1)
                return [...pending.values()][0].lifecycle;
            return undefined;
        }
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
        if (typeof event.data?.sessionId === "string" && event.data.sessionId !== run.sessionId)
            return false;
        const timestamp = event.timestamp === undefined ? Number.NaN : Date.parse(event.timestamp);
        if (Number.isFinite(timestamp) && timestamp < run.startedAt)
            return false;
        const eventId = opaqueEventKey(event.id);
        // extendLifecycleEventChain runs before the type-specific observer. Once
        // that single admission decision remembered this exact event, every later
        // handler in the same observeEvent call must see the same result.
        if (eventId !== undefined && run.observedEventIds.has(eventId))
            return true;
        const parentEventId = opaqueEventKey(event.parentId);
        if (parentEventId === undefined || run.observedEventIds.has(parentEventId))
            return true;
        if (run.kind === "child" && activeRoots.get(run.sessionId)?.observedEventIds.has(parentEventId))
            return true;
        // The first current event seeds the native chain. Once any event exists,
        // an unknown parent is evidence that a delayed event belongs elsewhere.
        return run.observedEventIds.size === 0;
    };
    const criticalLifecycleEventTypes = new Set([
        "session.start",
        "assistant.turn_start",
        "session.model_change",
        "assistant.usage",
        "assistant.message",
        "assistant.idle",
        "tool.execution_start",
        "tool.execution_complete",
        "hook.end",
        "skill.invoked",
        "subagent.selected",
        "subagent.deselected",
        "subagent.started",
        "subagent.completed",
        "subagent.failed",
        "abort",
    ]);
    const criticalOwnerForEvent = (event) => {
        const run = lifecycleRunForEvent(event);
        const turnId = event.data?.turnId ?? run?.turnId;
        if (run)
            return privateCorrelationKey("critical-owner", {
                rootRunId: run.rootRunId,
                turnId: turnId ?? null,
            });
        const context = latestPromptSessionId ? promptContexts.get(latestPromptSessionId) : undefined;
        return context
            ? privateCorrelationKey("critical-owner", { promptEpoch: context.epoch })
            : privateCorrelationKey("critical-owner", "unscoped");
    };
    const criticalStableAliases = (event) => {
        const aliases = [];
        if (event.id)
            aliases.push(privateCorrelationKey("critical:event", event.id));
        if (event.type === "assistant.usage") {
            if (event.data?.apiCallId)
                aliases.push(privateCorrelationKey("critical:usage:api", event.data.apiCallId));
            if (event.data?.serviceRequestId) {
                aliases.push(privateCorrelationKey("critical:usage:service", event.data.serviceRequestId));
            }
            if (event.data?.providerCallId) {
                aliases.push(privateCorrelationKey("critical:usage:provider", event.data.providerCallId));
            }
        }
        if (event.type === "assistant.turn_start" && event.data?.interactionId) {
            aliases.push(privateCorrelationKey("critical:interaction", {
                agentId: event.agentId ?? "root",
                interactionId: event.data.interactionId,
            }));
        }
        if (event.type === "hook.end" && typeof event.data?.hookInvocationId === "string" &&
            event.data.hookInvocationId) {
            aliases.push(privateCorrelationKey("critical:hook-end", event.data.hookInvocationId));
        }
        if (event.type === "assistant.message" && event.data?.messageId) {
            aliases.push(privateCorrelationKey("critical:assistant-message", event.data.messageId));
        }
        if ((event.type === "tool.execution_start" || event.type === "tool.execution_complete") &&
            event.data?.toolCallId) {
            aliases.push(privateCorrelationKey(`critical:${event.type}:tool`, event.data.toolCallId));
        }
        if ((event.type === "subagent.started" || event.type === "subagent.completed" ||
            event.type === "subagent.failed") && event.agentId) {
            aliases.push(privateCorrelationKey(`critical:${event.type}:child`, event.agentId));
            if (event.data?.toolCallId)
                aliases.push(privateCorrelationKey(`critical:${event.type}:child-tool`, {
                    agentId: event.agentId,
                    toolCallId: event.data.toolCallId,
                }));
        }
        if ((event.type === "subagent.started" || event.type === "subagent.completed" ||
            event.type === "subagent.failed") && !event.agentId && event.data?.toolCallId) {
            aliases.push(privateCorrelationKey(`critical:${event.type}:tool-without-child`, event.data.toolCallId));
        }
        if ((event.type === "tool.execution_start" || event.type === "tool.execution_complete") &&
            event.agentId && event.data?.parentToolCallId) {
            aliases.push(privateCorrelationKey(`critical:${event.type}:child-tool`, {
                agentId: event.agentId,
                parentToolCallId: event.data.parentToolCallId,
                toolCallId: event.data.toolCallId ?? null,
            }));
        }
        return [...new Set(aliases)];
    };
    const criticalFallbackKey = (event) => privateCorrelationKey(event.type === "assistant.usage" ? "critical:usage:fallback" : "critical:event:fallback", {
        type: event.type ?? null,
        parentId: event.parentId ?? null,
        timestamp: event.timestamp ?? null,
        agentId: event.agentId ?? null,
        // Strict allowlist: never fingerprint message content, prompts, tool
        // arguments/results, error bodies, filesystem paths, or skill content.
        sessionId: event.data?.sessionId ?? null,
        turnId: event.data?.turnId ?? null,
        toolCallId: event.data?.toolCallId ?? null,
        parentToolCallId: event.data?.parentToolCallId ?? null,
        toolName: event.data?.toolName ?? null,
        mcpServerName: event.data?.mcpServerName ?? null,
        mcpToolName: event.data?.mcpToolName ?? null,
        toolDescriptionName: event.data?.toolDescription?.name ?? null,
        initiator: event.data?.initiator ?? null,
        interactionId: event.data?.interactionId ?? null,
        hookType: event.data?.hookType ?? null,
        hookInvocationId: event.data?.hookInvocationId ?? null,
        messageId: event.data?.messageId ?? null,
        agentName: event.data?.agentName ?? null,
        name: event.data?.name ?? null,
        pluginName: event.data?.pluginName ?? null,
        source: event.data?.source ?? null,
        trigger: event.data?.trigger ?? null,
        model: event.data?.model ?? null,
        newModel: event.data?.newModel ?? null,
        selectedModel: event.data?.selectedModel ?? null,
        reasoningEffort: event.data?.reasoningEffort ?? null,
        apiCallId: event.data?.apiCallId ?? null,
        serviceRequestId: event.data?.serviceRequestId ?? null,
        providerCallId: event.data?.providerCallId ?? null,
        inputTokens: event.data?.inputTokens ?? null,
        outputTokens: event.data?.outputTokens ?? null,
        reasoningTokens: event.data?.reasoningTokens ?? null,
        cacheReadTokens: event.data?.cacheReadTokens ?? null,
        cacheWriteTokens: event.data?.cacheWriteTokens ?? null,
        success: event.data?.success ?? null,
        aborted: event.data?.aborted ?? null,
        shutdownType: event.data?.shutdownType ?? null,
    });
    const claimCriticalLifecycleEvent = (event) => {
        if (!event.type || !criticalLifecycleEventTypes.has(event.type))
            return "claimed";
        if ((event.type === "subagent.started" || event.type === "subagent.completed" ||
            event.type === "subagent.failed") && event.data?.toolCallId) {
            const phaseToolKey = privateCorrelationKey("critical:subagent-phase-tool", {
                type: event.type,
                toolCallId: event.data.toolCallId,
            });
            const childIdentity = event.agentId
                ? privateCorrelationKey("critical:subagent-child", event.agentId)
                : "identity-unavailable";
            const existingChild = subagentPhaseToolChildren.get(phaseToolKey);
            if (existingChild !== undefined && existingChild !== childIdentity)
                return "unverified";
            if (existingChild === undefined) {
                if (subagentPhaseToolChildren.size >= maximumCriticalAliases)
                    return "unverified";
                subagentPhaseToolChildren.set(phaseToolKey, childIdentity);
            }
        }
        const owner = criticalOwnerForEvent(event);
        const aliases = criticalStableAliases(event);
        if (aliases.length > 0) {
            const existingOwners = [...new Set(aliases.flatMap((alias) => {
                    const existing = criticalAliasOwners.get(alias);
                    return existing === undefined ? [] : [existing];
                }))];
            if (existingOwners.length > 1)
                return "unverified";
            const canonicalOwner = existingOwners[0] ?? owner;
            const unseen = aliases.filter((alias) => !criticalAliasOwners.has(alias));
            if (criticalAliasOwners.size + unseen.length > maximumCriticalAliases)
                return "unverified";
            // An enriched replay may add a fresh event/service alias. Bind every new
            // alias to the original owner before returning so it cannot evade a later
            // check by presenting only that newly learned identity.
            for (const alias of unseen)
                criticalAliasOwners.set(alias, canonicalOwner);
            return existingOwners.length === 0 ? "claimed" : "replay";
        }
        const fallback = criticalFallbackKey(event);
        const existingOwner = criticalFallbackOwners.get(fallback);
        if (existingOwner !== undefined) {
            if (event.type === "assistant.usage" && existingOwner === owner)
                return "replay";
            // For state/model/lifecycle observations, an identity-free A→B→A can be
            // either a legitimate transition or a replay. Never guess and rewind.
            return "unverified";
        }
        if (criticalFallbackOwners.size >= maximumCriticalFallbacks)
            return "unverified";
        criticalFallbackOwners.set(fallback, owner);
        return "claimed";
    };
    const extendLifecycleEventChain = (event) => {
        const childScoped = Boolean(event.agentId || event.data?.parentToolCallId || event.data?.initiator === "sub-agent");
        if (event.type === "session.idle" && !childScoped)
            return;
        const run = lifecycleRunForEvent(event);
        if (!run || run.finished || !lifecycleEventBelongsToRun(run, event))
            return;
        rememberLifecycleEventId(run, event);
        const root = run.kind === "root" ? run : activeRoots.get(run.sessionId);
        if (root && root !== run && !root.finished && lifecycleEventBelongsToRun(root, event)) {
            rememberLifecycleEventId(root, event);
        }
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
    const emitUnverifiedUsageAttribution = (event) => {
        const run = lifecycleRunForEvent(event);
        if (!run || run.finished || !lifecycleEventBelongsToRun(run, event))
            return;
        emitLifecycle({
            ...correlation(run, "observed", event),
            type: "run.usage",
            attributionUnverified: true,
            usage: {},
        });
    };
    const finishTaskNow = (input, sessionId, outcome) => {
        if (input.toolName !== "task")
            return;
        const item = pending.get(sessionId);
        if (item) {
            if (item.purpose === "contract" && item.terminal === undefined) {
                item.deferredContractOutcome = item.deferredContractOutcome === "failed" || outcome === "failed"
                    ? "failed"
                    : "completed";
                if (outcome === "completed" && item.deferredContractOutcome === "completed") {
                    item.deferredContractCompletionEvidence = fingerprintHarborEvidence(serialized(input.toolResult));
                }
                else if (outcome === "failed") {
                    item.deferredContractErrorFingerprint = fingerprintHarborEvidence(serialized(input.error ?? "Copilot task failed"));
                }
                return;
            }
            const effectiveOutcome = outcome === "failed" || item.terminal === "failed" ? "failed" : "completed";
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
            if (effectiveOutcome === "completed") {
                const result = serialized(input.toolResult);
                emitHarborEvidence(evidenceHook, {
                    ...base,
                    phase: "evidence.returned",
                    outcome: "ok",
                    evidence: item.deferredContractCompletionEvidence ?? fingerprintHarborEvidence(result),
                });
                emitHarborEvidence(evidenceHook, { ...base, phase: "child.completed", outcome: "ok" });
            }
            else {
                const error = input.error;
                emitHarborEvidence(evidenceHook, {
                    ...base,
                    phase: "child.failed",
                    outcome: "error",
                    error: error === undefined
                        ? item.deferredContractErrorFingerprint ?? item.errorFingerprint ?? fingerprintHarborEvidence("Copilot task failed")
                        : fingerprintHarborEvidence(error),
                });
            }
            emitHarborEvidence(evidenceHook, { ...base, phase: "child.cleaned", outcome: "ok", basis: "inferred" });
            finishLifecycle(item.lifecycle, effectiveOutcome, item.terminal ? "observed" : "inferred", item.terminalObservation, item.terminalObservation?.data);
            if (item.purpose === "contract") {
                const contract = contractInvocations.get(sessionId);
                if (contract) {
                    contract.childOutcome = effectiveOutcome;
                    contract.taskFinalized = true;
                }
            }
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
    const finishDeferredContractTask = (sessionId, item) => {
        const outcome = item.deferredContractOutcome;
        if (!outcome)
            return;
        item.deferredContractOutcome = undefined;
        if (outcome === "completed") {
            finishTaskNow({
                sessionId,
                workingDirectory: item.lifecycle.project,
                toolName: "task",
                toolArgs: {},
                toolResult: "",
            }, sessionId, outcome);
        }
        else {
            finishTaskNow({
                sessionId,
                workingDirectory: item.lifecycle.project,
                toolName: "task",
                toolArgs: {},
                error: undefined,
            }, sessionId, outcome);
        }
    };
    const finishSessionLifecycle = (rootOutcome, event) => {
        const root = latestRootLifecycle();
        const sessionId = root?.sessionId ?? [...pending.keys()].at(-1) ?? latestPromptSessionId;
        const contract = sessionId ? contractInvocations.get(sessionId) : undefined;
        const effectiveRootOutcome = rootOutcome === "completed" && contract &&
            (!contract.taskAdmitted || !contract.taskFinalized || contract.childOutcome !== "completed" ||
                Boolean(contract.invalidReason))
            ? "failed"
            : rootOutcome;
        if (sessionId) {
            const item = pending.get(sessionId);
            if (item && !item.lifecycle.finished) {
                finishLifecycle(item.lifecycle, effectiveRootOutcome === "cancelled" ? "cancelled" : "failed", "inferred", event);
            }
            pending.delete(sessionId);
            inFlight.delete(sessionId);
            counts.delete(sessionId);
        }
        unclaimedTaskCalls.length = 0;
        if (root) {
            finishLifecycle(root, effectiveRootOutcome, "observed", event);
            activeRoots.delete(root.sessionId);
        }
        if (sessionId) {
            contractInvocations.delete(sessionId);
            promptContexts.delete(sessionId);
            if (event.type === "session.error" || event.type === "session.shutdown") {
                blockedContractSessions.delete(sessionId);
            }
            if (latestPromptSessionId === sessionId)
                latestPromptSessionId = undefined;
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
            const submittedPrompt = input.prompt ?? "";
            const referencesContract = contractReferencePattern.test(submittedPrompt);
            if (blockNextPromptForUnscopedContractEvent &&
                blockedContractSessions.size < maximumBlockedContractSessions) {
                rememberBlockedContractSession(invocation.sessionId);
                blockNextPromptForUnscopedContractEvent = false;
            }
            const contractBlocked = blockedContractSessions.has(invocation.sessionId) ||
                blockNextPromptForUnscopedContractEvent;
            promptContexts.set(invocation.sessionId, {
                project: input.workingDirectory,
                submittedAt: Date.now(),
                epoch: ++promptEpochSequence,
                referencesContract,
                ...(contractBlocked ? { contractBlocked: true } : {}),
            });
            latestPromptSessionId = invocation.sessionId;
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
                if (player) {
                    const taskLabel = referencesContract
                        ? "request references /contract; details hidden"
                        : copilotTaskLabel(submittedPrompt);
                    const root = startRootLifecycle(invocation.sessionId, input.workingDirectory, taskLabel, player, "observed");
                    const context = promptContexts.get(invocation.sessionId);
                    if (context)
                        context.rootRunId = root.runId;
                }
            });
        },
        onPreMcpToolCall: async (input, invocation) => {
            const contract = contractInvocations.get(invocation.sessionId);
            if (!contract || input.sessionId !== invocation.sessionId)
                return;
            await locked(() => {
                if (contract.invalidReason)
                    return;
                if (!samePath(input.workingDirectory, contract.project)) {
                    invalidateContract(contract, "Agent Harbor /contract working directory changed after reservation");
                    return;
                }
                if (input.serverName !== "agent-harbor" || input.toolName !== "control") {
                    invalidateContract(contract, "Agent Harbor /contract observed an MCP call outside agent-harbor(control)");
                    return;
                }
                const control = exactContractControl(input.arguments);
                if (!control) {
                    invalidateContract(contract, "Agent Harbor /contract MCP call did not contain its exact control arguments");
                    return;
                }
                const callHash = typeof input.toolCallId === "string" && input.toolCallId
                    ? privateCorrelationKey("contract:control-call", input.toolCallId)
                    : undefined;
                if (contract.controlMcpHash) {
                    if (!samePrivateCorrelation(control.hash, contract.controlMcpHash) ||
                        (callHash && contract.controlMcpCallHash &&
                            !samePrivateCorrelation(callHash, contract.controlMcpCallHash))) {
                        invalidateContract(contract, "Agent Harbor /contract may authenticate exactly one MCP control call");
                        return;
                    }
                    // The SDK declares toolCallId optional. A replay may enrich the same
                    // authenticated call with its ID before execution_start seals it.
                    if (callHash && !contract.controlMcpCallHash)
                        contract.controlMcpCallHash = callHash;
                    return;
                }
                if (contract.controlPreflightHash &&
                    !samePrivateCorrelation(control.hash, contract.controlPreflightHash)) {
                    invalidateContract(contract, "Agent Harbor /contract MCP call differs from its provisional tool preflight");
                    return;
                }
                contract.controlMcpHash = control.hash;
                contract.controlMcpCallHash = callHash;
                const metadata = contractTaskMetadata(control.args);
                contract.contractorAgent = metadata.contractorAgent;
                contract.taskLabel = metadata.taskLabel;
            });
        },
        onPreToolUse: async (input, invocation) => {
            if (lifecycleIdentityUnverified && input.toolName === "task") {
                return deny("Agent Harbor lifecycle identity is unverified; reload the Copilot session before delegation");
            }
            const contract = contractInvocations.get(invocation.sessionId);
            const parentContractTool = contract && input.sessionId === invocation.sessionId;
            if (!contract && input.sessionId === invocation.sessionId && input.toolName === "task" &&
                (promptContexts.get(invocation.sessionId)?.referencesContract ||
                    promptContexts.get(invocation.sessionId)?.contractBlocked)) {
                return deny("Agent Harbor /contract task is blocked until exact user-invoked skill provenance is observed");
            }
            if (contract && input.sessionId !== invocation.sessionId && input.toolName === "task") {
                return deny("Agent Harbor /contract blocks nested task delegation from its disposable child");
            }
            if (parentContractTool && !samePath(input.workingDirectory, contract.project)) {
                return locked(() => deny(invalidateContract(contract, "Agent Harbor /contract working directory changed after reservation")));
            }
            if (parentContractTool && input.toolName !== "task") {
                return locked(() => {
                    if (contract.admissionError)
                        return deny(`Agent Harbor /contract admission failed: ${contract.admissionError}`);
                    if (contract.invalidReason)
                        return deny(contract.invalidReason);
                    const control = exactContractControl(input.toolArgs);
                    if (!control)
                        return deny("Agent Harbor /contract wrapper permits only its exact control preflight and one task child");
                    if (contract.controlPreflightHash) {
                        return deny(invalidateContract(contract, "Agent Harbor /contract control preflight may run exactly once"));
                    }
                    if (contract.controlMcpHash && !samePrivateCorrelation(control.hash, contract.controlMcpHash)) {
                        return deny(invalidateContract(contract, "Agent Harbor /contract tool preflight differs from its authenticated MCP call"));
                    }
                    // PreToolUse does not carry the MCP server identity. Record the
                    // provisional shape but return no permission override: the skill's
                    // allowed-tools entry auto-approves the real control, while an
                    // identically shaped third-party tool keeps the host's normal prompt.
                    // Only the exact preMcpToolCall handshake can enable a later task.
                    contract.controlPreflightHash = control.hash;
                    return;
                });
            }
            if (parentContractTool && input.toolName === "task") {
                return locked(() => {
                    if (contract.admissionError)
                        return deny(`Agent Harbor /contract admission failed: ${contract.admissionError}`);
                    if (contract.invalidReason)
                        return deny(contract.invalidReason);
                    if (contract.taskAttempted) {
                        return deny(invalidateContract(contract, "Agent Harbor /contract permits exactly one task child"));
                    }
                    contract.taskAttempted = true;
                    if (!contract.controlCompleted || !contract.descriptor) {
                        return deny(invalidateContract(contract, "Agent Harbor /contract task is blocked until its exact MCP preflight succeeds"));
                    }
                    const args = structuredToolArgs(input.toolArgs);
                    if (!args || Object.keys(args).sort().join("\0") !== "agent_type\0description\0prompt" ||
                        typeof args.agent_type !== "string" || typeof args.description !== "string" || typeof args.prompt !== "string") {
                        return deny(invalidateContract(contract, "Agent Harbor /contract task arguments must be exactly agent_type, description, and prompt"));
                    }
                    const exact = samePrivateCorrelation(privateCorrelationKey("contract:agent-type", args.agent_type), contract.descriptor.agentType) && samePrivateCorrelation(privateCorrelationKey("contract:description", args.description), contract.descriptor.description) && samePrivateCorrelation(privateCorrelationKey("contract:prompt", args.prompt), contract.descriptor.prompt);
                    if (!exact) {
                        return deny(invalidateContract(contract, "Agent Harbor /contract task must use the validated descriptor unchanged"));
                    }
                    const root = contract.root;
                    if (!root || root.finished || activeRoots.get(invocation.sessionId)?.runId !== root.runId) {
                        return deny(invalidateContract(contract, "Agent Harbor /contract wrapper is no longer active"));
                    }
                    const childRunId = `copilot-child-${++lifecycleSequence}`;
                    const publicInvocationId = publicOpaqueCorrelation("tool", contract.taskCallId);
                    const lifecycle = {
                        sessionId: invocation.sessionId,
                        project: contract.project,
                        runId: childRunId,
                        rootRunId: root.rootRunId,
                        parentRunId: root.runId,
                        kind: "child",
                        agent: contract.contractorAgent,
                        runtimeAgent: contract.descriptor.runtimeAgent,
                        taskLabel: contract.taskLabel,
                        memberKind: "contractor",
                        ...(publicInvocationId === undefined ? {} : { invocationId: publicInvocationId }),
                        started: false,
                        finished: false,
                        startedAt: Date.now(),
                        observedActivity: false,
                        observedEventIds: new Set(),
                        untimedStateEventKeys: new Set(),
                        modelEventIdsAtObservedTime: new Set(),
                        untimedModelEventIds: new Set(),
                        reasoningEventIdsAtObservedTime: new Set(),
                        untimedReasoningEventIds: new Set(),
                        seenUsageIds: new Set(),
                        observedModelConfirmed: false,
                        observedReasoningConfirmed: false,
                    };
                    try {
                        admissionHook?.({
                            type: "child",
                            project: contract.project,
                            rootRunId: root.rootRunId,
                            parentRunId: root.runId,
                            runId: lifecycle.runId,
                            agent: lifecycle.agent,
                            runtimeAgent: lifecycle.runtimeAgent,
                            taskLabel: lifecycle.taskLabel,
                            memberKind: "contractor",
                        });
                    }
                    catch (error) {
                        return deny(invalidateContract(contract, `Agent Harbor /contract child admission failed: ${publicCopilotMetadata(error instanceof Error ? error.message : String(error), 300) ?? "unavailable"}`));
                    }
                    contract.taskAdmitted = true;
                    inFlight.add(invocation.sessionId);
                    pending.set(invocation.sessionId, {
                        agent: lifecycle.agent,
                        runtimeAgent: lifecycle.runtimeAgent,
                        lifecycle,
                        purpose: "contract",
                        ...(contract.taskCallId === undefined ? {} : { invocationId: contract.taskCallId }),
                    });
                    setLifecycleState(root, "waiting", "observed");
                    return { permissionDecision: "allow" };
                });
            }
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
                    try {
                        resolveCopilotPlayer("team-lead", snapshot.agents, input.workingDirectory);
                    }
                    catch (error) {
                        return deny(error instanceof Error ? error.message : String(error));
                    }
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
                        untimedStateEventKeys: new Set(),
                        modelEventIdsAtObservedTime: new Set(),
                        untimedModelEventIds: new Set(),
                        reasoningEventIdsAtObservedTime: new Set(),
                        untimedReasoningEventIds: new Set(),
                        seenUsageIds: new Set(),
                        observedModelConfirmed: false,
                        observedReasoningConfirmed: false,
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
        lifecycleIdentityUnverified: () => lifecycleIdentityUnverified,
        terminalIdentityUnverified: () => lifecycleIdentityUnverified,
        hostEventWasClaimed: (event) => hostEventClaims.get(event),
        hostEventDisposition: (event) => hostEventDispositions.get(event),
        terminalEventDisposition: (event) => terminalEventDispositions.get(event),
        observeEvent: (event) => {
            // Critical alias enrichment must run before the bounded generic replay
            // cache. A replay with the same event ID may reveal a provider/service ID
            // that must be learned before a later replay presents only that alias.
            const criticalClaim = claimCriticalLifecycleEvent(event);
            const terminalClaim = claimSessionTerminal(event, latestRootLifecycle()?.runId);
            const hostEventClaimed = claimHostEvent(event);
            if (event.type === "session.idle" || event.type === "session.error" ||
                event.type === "session.shutdown") {
                terminalEventDispositions.set(event, terminalClaim);
            }
            const disposition = criticalClaim === "unverified" || terminalClaim === "unverified"
                ? "unverified"
                : criticalClaim === "replay" || terminalClaim === "replay" || !hostEventClaimed
                    ? "replay"
                    : "claimed";
            hostEventClaims.set(event, disposition === "claimed");
            hostEventDispositions.set(event, disposition);
            if (disposition === "replay")
                return;
            if (disposition === "unverified") {
                lifecycleIdentityUnverified = true;
                if (event.type === "assistant.usage")
                    emitUnverifiedUsageAttribution(event);
                const ambiguousContract = contractStateForRoot();
                if (ambiguousContract) {
                    invalidateContract(ambiguousContract, "Agent Harbor /contract native lifecycle identity is unverified; reload Copilot");
                    ambiguousContract.childOutcome = "failed";
                    const contractPending = pending.get(ambiguousContract.sessionId);
                    if (contractPending?.purpose === "contract")
                        contractPending.terminal = "failed";
                }
                return;
            }
            if (event.agentId) {
                const activeContractEntry = [...pending.entries()].find(([, candidate]) => candidate.purpose === "contract");
                if (activeContractEntry) {
                    const bridgeRoot = activeRoots.get(activeContractEntry[0]);
                    if (bridgeRoot && !bridgeRoot.finished && lifecycleEventBelongsToRun(bridgeRoot, event)) {
                        // Preserve the host's contiguous session chain even when this
                        // child-scoped event is deliberately not attributed to the exact
                        // contractor identity.
                        rememberLifecycleEventId(bridgeRoot, event);
                    }
                }
            }
            const earlyInvocationId = event.data?.toolCallId ?? event.data?.parentToolCallId;
            if (event.agentId && earlyInvocationId) {
                const contractEntry = [...pending.entries()].find(([, candidate]) => candidate.purpose === "contract" && candidate.invocationId === earlyInvocationId);
                if (contractEntry) {
                    const [contractSessionId, contractPending] = contractEntry;
                    const knownChildId = contractPending.childId ?? contractPending.provisionalChildId;
                    if (knownChildId && knownChildId !== event.agentId) {
                        const contractState = contractInvocations.get(contractSessionId);
                        if (contractState) {
                            invalidateContract(contractState, "Agent Harbor /contract observed activity from a second native child identity");
                            contractState.childOutcome = "failed";
                        }
                        contractPending.terminal = "failed";
                        return;
                    }
                    contractPending.provisionalChildId ??= event.agentId;
                }
            }
            extendLifecycleEventChain(event);
            if (event.type === "skill.invoked" && rootScopedHostEvent(event) &&
                event.data?.name === "contract" && event.data?.pluginName === "agent-foundry" &&
                event.data?.source === "plugin") {
                if (event.data?.trigger === "user-invoked") {
                    // Deliberately ignore skill content/path. The host-authenticated plugin
                    // metadata is the only signal that reserves a Harbor contract wrapper.
                    const exactSessionId = typeof event.data?.sessionId === "string" && promptContexts.has(event.data.sessionId)
                        ? event.data.sessionId
                        : latestPromptSessionId;
                    if (exactSessionId) {
                        blockedContractSessions.delete(exactSessionId);
                        const exactContext = promptContexts.get(exactSessionId);
                        if (exactContext)
                            delete exactContext.contractBlocked;
                    }
                    startContractWrapper(event);
                }
                else {
                    const sessionId = typeof event.data?.sessionId === "string" && promptContexts.has(event.data.sessionId)
                        ? event.data.sessionId
                        : latestPromptSessionId;
                    const context = sessionId ? promptContexts.get(sessionId) : undefined;
                    if (context)
                        context.contractBlocked = true;
                    if (sessionId)
                        rememberBlockedContractSession(sessionId);
                    else
                        blockNextPromptForUnscopedContractEvent = true;
                    const invocation = sessionId ? contractInvocations.get(sessionId) : undefined;
                    if (invocation)
                        invalidateContract(invocation, "Agent Harbor /contract requires exact user-invoked skill provenance");
                }
            }
            const contract = contractStateForRoot();
            const contractEventCurrent = Boolean(contract?.root && lifecycleEventBelongsToRun(contract.root, event));
            if (contract && contractEventCurrent && !contract.invalidReason &&
                event.type === "tool.execution_start" && rootScopedHostEvent(event) &&
                event.data?.mcpServerName === "agent-harbor" && event.data?.mcpToolName === "control") {
                const control = exactContractControl(event.data.arguments);
                const eventCallHash = typeof event.data.toolCallId === "string" && event.data.toolCallId
                    ? privateCorrelationKey("contract:control-call", event.data.toolCallId)
                    : undefined;
                if (!control || !contract.controlPreflightHash || !contract.controlMcpHash || !eventCallHash ||
                    !samePrivateCorrelation(control.hash, contract.controlPreflightHash) ||
                    !samePrivateCorrelation(control.hash, contract.controlMcpHash) ||
                    (contract.controlMcpCallHash &&
                        !samePrivateCorrelation(eventCallHash, contract.controlMcpCallHash))) {
                    invalidateContract(contract, "Agent Harbor /contract MCP execution did not match its exact authenticated handshake");
                }
                else if (typeof event.data.toolCallId !== "string" || !event.data.toolCallId) {
                    invalidateContract(contract, "Agent Harbor /contract MCP execution has no native call identity");
                }
                else {
                    const callHash = eventCallHash;
                    if (!contract.controlMcpCallHash)
                        contract.controlMcpCallHash = callHash;
                    if (contract.controlCallHash) {
                        if (!samePrivateCorrelation(callHash, contract.controlCallHash)) {
                            invalidateContract(contract, "Agent Harbor /contract control may execute exactly once");
                        }
                    }
                    else {
                        contract.controlCallHash = callHash;
                        const metadata = contractTaskMetadata(control.args);
                        contract.contractorAgent = metadata.contractorAgent;
                        contract.taskLabel = metadata.taskLabel;
                    }
                }
            }
            else if (contract && contractEventCurrent && !contract.invalidReason &&
                event.type === "tool.execution_start" && rootScopedHostEvent(event) &&
                (contract.controlPreflightHash || contract.controlMcpHash) &&
                !contract.controlCallHash && event.data?.toolName !== "task") {
                invalidateContract(contract, "Agent Harbor /contract preflight did not execute through agent-harbor(control)");
            }
            if (contract && contractEventCurrent && !contract.invalidReason &&
                event.type === "tool.execution_complete" && rootScopedHostEvent(event) &&
                contract.controlCallHash && typeof event.data?.toolCallId === "string" &&
                samePrivateCorrelation(privateCorrelationKey("contract:control-call", event.data.toolCallId), contract.controlCallHash)) {
                if (!contract.controlCompleted) {
                    contract.controlCompleted = true;
                    if (event.data.success === false) {
                        invalidateContract(contract, "Agent Harbor /contract deterministic preflight failed; no child was created");
                    }
                    else {
                        const descriptor = exactContractDescriptor(event.data.result);
                        if (descriptor)
                            contract.descriptor = descriptor;
                        else
                            invalidateContract(contract, "Agent Harbor /contract MCP result did not contain one exact structured descriptor");
                    }
                }
            }
            if (contract && contractEventCurrent && event.type === "tool.execution_start" && rootScopedHostEvent(event) &&
                event.data?.toolName === "task" && typeof event.data.toolCallId === "string") {
                if (contract.taskCallId && contract.taskCallId !== event.data.toolCallId) {
                    invalidateContract(contract, "Agent Harbor /contract observed more than one parent task invocation");
                }
                else {
                    contract.taskCallId = event.data.toolCallId;
                }
            }
            if (event.type === "assistant.turn_start" ||
                event.type === "session.model_change" ||
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
            if (event.type === "session.start" && rootScopedHostEvent(event)) {
                const modelTiming = acceptLatestTimestampedEvent(event, selectedModelObservedAt, selectedModelEventIdsAtObservedTime, selectedUntimedModelEventIds, "selected-model", event.data?.selectedModel);
                if (modelTiming.accepted) {
                    selectedModel = publicCopilotMetadata(event.data?.selectedModel);
                    selectedModelObservedAt = modelTiming.observedAt;
                }
                const reasoningTiming = acceptLatestTimestampedEvent(event, selectedReasoningObservedAt, selectedReasoningEventIdsAtObservedTime, selectedUntimedReasoningEventIds, "selected-reasoning", event.data?.reasoningEffort);
                if (reasoningTiming.accepted) {
                    selectedReasoningEffort = event.data?.reasoningEffort === null
                        ? null
                        : publicCopilotMetadata(event.data?.reasoningEffort, 40);
                    selectedReasoningObservedAt = reasoningTiming.observedAt;
                }
            }
            if (event.type === "subagent.selected" && rootScopedHostEvent(event) && event.data?.agentName &&
                acceptSelectionObservation(event, false)) {
                selectionEpoch += 1;
                snapshot.current = {
                    id: copilotFixedAgentIds.get(event.data.agentName) ?? event.data.agentName,
                    userInvocable: true,
                };
            }
            else if (event.type === "subagent.deselected" && rootScopedHostEvent(event) &&
                acceptSelectionObservation(event, true)) {
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
                if (rootScopedHostEvent(event)) {
                    if (model) {
                        const modelTiming = acceptLatestTimestampedEvent(event, selectedModelObservedAt, selectedModelEventIdsAtObservedTime, selectedUntimedModelEventIds, "selected-model-change", model);
                        if (modelTiming.accepted) {
                            selectedModel = model;
                            selectedModelObservedAt = modelTiming.observedAt;
                        }
                    }
                    if (effort !== undefined) {
                        const reasoningTiming = acceptLatestTimestampedEvent(event, selectedReasoningObservedAt, selectedReasoningEventIdsAtObservedTime, selectedUntimedReasoningEventIds, "selected-reasoning-change", effort);
                        if (reasoningTiming.accepted) {
                            selectedReasoningEffort = effort;
                            selectedReasoningObservedAt = reasoningTiming.observedAt;
                        }
                    }
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
                if (rootScopedHostEvent(event) && root && sessionIdleBelongsToRoot(root, event)) {
                    finishSessionLifecycle(event.data?.aborted === true ? "cancelled" : "completed", event);
                }
                else if (rootScopedHostEvent(event) && !root && latestPromptSessionId) {
                    const sessionId = latestPromptSessionId;
                    contractInvocations.delete(sessionId);
                    promptContexts.delete(sessionId);
                    latestPromptSessionId = undefined;
                }
            }
            else if (event.type === "session.error") {
                const root = latestRootLifecycle();
                if (rootScopedHostEvent(event) && (!root || lifecycleEventBelongsToRun(root, event))) {
                    finishSessionLifecycle("failed", event);
                }
            }
            else if (event.type === "session.shutdown") {
                const root = latestRootLifecycle();
                if (rootScopedHostEvent(event) && (!root || lifecycleEventBelongsToRun(root, event))) {
                    finishSessionLifecycle(event.data?.shutdownType === "error" ? "failed" : "cancelled", event);
                }
            }
            const entries = [...pending.entries()];
            const toolCallId = event.data?.toolCallId;
            const childInvocationId = toolCallId ?? event.data?.parentToolCallId;
            if (event.agentId && childInvocationId) {
                const conflictingContract = entries.find(([, candidate]) => candidate.purpose === "contract" && candidate.invocationId === childInvocationId &&
                    (candidate.childId ?? candidate.provisionalChildId) !== undefined &&
                    (candidate.childId ?? candidate.provisionalChildId) !== event.agentId);
                if (conflictingContract) {
                    const [contractSessionId, contractPending] = conflictingContract;
                    const contractState = contractInvocations.get(contractSessionId);
                    if (contractState) {
                        invalidateContract(contractState, "Agent Harbor /contract observed activity from a second native child identity");
                        contractState.childOutcome = "failed";
                    }
                    contractPending.terminal = "failed";
                    return;
                }
            }
            if (event.type === "tool.execution_start" && rootScopedHostEvent(event) && event.data?.toolName === "task" && toolCallId) {
                const uncorrelated = entries.filter(([, state]) => !state.invocationId);
                if (uncorrelated.length === 1) {
                    uncorrelated[0][1].invocationId = toolCallId;
                    uncorrelated[0][1].lifecycle.invocationId = publicOpaqueCorrelation("tool", toolCallId);
                }
                else if (snapshot.current?.id === copilotFixedAgentIds.get("team-lead"))
                    unclaimedTaskCalls.push(toolCallId);
                return;
            }
            if (event.type === "subagent.started" || event.type === "subagent.completed" ||
                event.type === "subagent.failed") {
                const contractEntries = entries.filter(([, candidate]) => candidate.purpose === "contract");
                if (contractEntries.length === 1) {
                    const [contractSessionId, contractPending] = contractEntries[0];
                    const correlated = toolCallId === contractPending.invocationId ||
                        Boolean(event.agentId && event.agentId === (contractPending.childId ?? contractPending.provisionalChildId));
                    if (!correlated)
                        return;
                    const sameTool = Boolean(contractPending.invocationId && toolCallId === contractPending.invocationId);
                    const sameAgent = event.data?.agentName === contractPending.runtimeAgent;
                    const knownChildId = contractPending.childId ?? contractPending.provisionalChildId;
                    const sameChild = Boolean(event.agentId && (!knownChildId || knownChildId === event.agentId));
                    const startedReplay = event.type === "subagent.started" && sameTool && sameAgent && sameChild &&
                        Boolean(contractPending.childId && contractPending.lifecycle.started);
                    if (startedReplay)
                        return;
                    if (!sameTool || !sameAgent || !sameChild) {
                        const contractState = contractInvocations.get(contractSessionId);
                        if (contractState) {
                            invalidateContract(contractState, "Agent Harbor /contract observed a native child that did not match its exact admitted task");
                            contractState.childOutcome = "failed";
                        }
                        contractPending.terminal = "failed";
                        return;
                    }
                    if (contractInvocations.get(contractSessionId)?.invalidReason)
                        return;
                }
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
                if (!state.childId && event.agentId) {
                    state.childId = event.agentId;
                    state.lifecycle.childId = publicOpaqueCorrelation("child", event.agentId);
                }
                const priorTerminal = state.terminal;
                const deferredFailure = state.deferredContractOutcome === "failed";
                if (priorTerminal === "failed" && state.purpose === "contract") {
                    const contractState = contractInvocations.get(sessionId);
                    if (contractState)
                        invalidateContract(contractState, "Agent Harbor /contract observed conflicting native child terminal outcomes");
                }
                state.terminal = priorTerminal === "failed" || deferredFailure ? "failed" : "completed";
                if (state.purpose === "contract") {
                    const contractState = contractInvocations.get(sessionId);
                    if (contractState) {
                        if (deferredFailure)
                            invalidateContract(contractState, "Agent Harbor /contract task hook failed before native child completion");
                        contractState.childOutcome = state.terminal;
                    }
                    if (priorTerminal !== "failed")
                        state.terminalObservation = safeTerminalObservation(event);
                }
                observeLifecycleModel(state.lifecycle, event.data?.model, "observed", event);
                if (state.purpose !== "contract") {
                    finishLifecycle(state.lifecycle, state.terminal, "observed", event, event.data);
                }
                const root = activeRoots.get(sessionId);
                if (root)
                    setLifecycleState(root, "working", "observed", event);
                finishDeferredContractTask(sessionId, state);
            }
            else if (event.type === "subagent.failed" && event.data?.agentName === state.runtimeAgent && toolCallId === state.invocationId) {
                if (!state.childId && event.agentId) {
                    state.childId = event.agentId;
                    state.lifecycle.childId = publicOpaqueCorrelation("child", event.agentId);
                }
                const priorTerminal = state.terminal;
                state.terminal = "failed";
                if (state.purpose === "contract") {
                    const contractState = contractInvocations.get(sessionId);
                    if (contractState) {
                        if (priorTerminal === "completed")
                            invalidateContract(contractState, "Agent Harbor /contract observed conflicting native child terminal outcomes");
                        contractState.childOutcome = "failed";
                    }
                    state.terminalObservation = safeTerminalObservation(event);
                }
                state.errorFingerprint = fingerprintHarborEvidence(serialized(event.data.error));
                observeLifecycleModel(state.lifecycle, event.data?.model, "observed", event);
                if (state.purpose !== "contract") {
                    finishLifecycle(state.lifecycle, "failed", "observed", event, event.data);
                }
                const root = activeRoots.get(sessionId);
                if (root)
                    setLifecycleState(root, "working", "observed", event);
                finishDeferredContractTask(sessionId, state);
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
