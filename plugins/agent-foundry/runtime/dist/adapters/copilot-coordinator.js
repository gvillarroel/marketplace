import { resolve } from "node:path";
import { listManagedActiveIds } from "../core/active.js";
import { emitHarborEvidence, fingerprintHarborEvidence } from "../core/evidence.js";
export const copilotFixedAgentIds = new Map([
    ["team-lead", "agent-foundry:team-lead"],
    ["repo-cartographer", "repo-cartographer:repo-cartographer"],
    ["crafter", "repo-cartographer:crafter"],
]);
function samePath(left, right) {
    const normalize = (value) => process.platform === "win32" ? resolve(value).toLowerCase() : resolve(value);
    return normalize(left) === normalize(right);
}
function activePath(project, id) {
    return resolve(project, ".github", "agents", `${id}.agent.md`);
}
export function listCopilotActiveProfileIds(project) {
    return listManagedActiveIds("copilot", project);
}
/** Resolve one logical Harbor ID to the exact Copilot agent exposed by the host. */
export function resolveCopilotPlayer(id, agents, project) {
    const fixedId = copilotFixedAgentIds.get(id);
    if (fixedId) {
        const exact = agents.find((agent) => agent.id === fixedId);
        if (exact)
            return exact;
        throw new Error(`Agent Harbor player is not active in Copilot: ${id}`);
    }
    if (!listCopilotActiveProfileIds(project).includes(id)) {
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
/**
 * Enforce the team-lead contract around Copilot's native synchronous `task`
 * tool. The host remains responsible for the child lifecycle and result.
 */
export function createCopilotCoordinatorGuard(getSession, evidenceHook) {
    const counts = new Map();
    const inFlight = new Set();
    const unclaimedTaskCalls = [];
    const pending = new Map();
    let snapshot = { ready: false, agents: [] };
    let selectionEpoch = 0;
    let guard = Promise.resolve();
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
    const finishTask = async (input, sessionId, outcome) => {
        if (input.toolName !== "task")
            return;
        await locked(() => {
            const item = pending.get(sessionId);
            if (item) {
                const base = {
                    harness: "copilot",
                    agent: item.agent,
                    runtimeAgent: item.runtimeAgent,
                    parentSessionId: sessionId,
                    childId: item.childId,
                    invocationId: item.invocationId,
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
                    const error = input.error ?? item.error ?? "Copilot task failed";
                    emitHarborEvidence(evidenceHook, { ...base, phase: "child.failed", outcome: "error", error: fingerprintHarborEvidence(error) });
                }
                emitHarborEvidence(evidenceHook, { ...base, phase: "child.cleaned", outcome: "ok", basis: "inferred" });
                pending.delete(sessionId);
            }
            inFlight.delete(sessionId);
        });
    };
    const refresh = async () => {
        let refreshSelectionEpoch = 0;
        await locked(() => {
            refreshSelectionEpoch = selectionEpoch;
            snapshot = { ready: false, current: snapshot.current, agents: [] };
        });
        try {
            const current = await getSession().rpc.agent.getCurrent();
            const listed = await getSession().rpc.agent.reload();
            await locked(() => {
                snapshot = {
                    ready: true,
                    current: selectionEpoch === refreshSelectionEpoch
                        ? current.agent ?? undefined
                        : snapshot.current,
                    agents: [...listed.agents],
                };
            });
        }
        catch (error) {
            await locked(() => {
                snapshot = {
                    ready: false,
                    current: selectionEpoch === refreshSelectionEpoch ? undefined : snapshot.current,
                    agents: [],
                };
            });
            throw error;
        }
    };
    const hooks = {
        onUserPromptSubmitted: async (input, invocation) => {
            if (input.sessionId !== invocation.sessionId)
                return;
            await locked(() => {
                counts.delete(invocation.sessionId);
                inFlight.delete(invocation.sessionId);
                pending.delete(invocation.sessionId);
                unclaimedTaskCalls.length = 0;
            });
        },
        onPreToolUse: async (input, invocation) => {
            if (input.toolName !== "task")
                return;
            return locked(async () => {
                try {
                    if (!snapshot.ready)
                        return deny("Agent Harbor coordinator snapshot is unavailable; reload the session");
                    if (snapshot.current?.id !== copilotFixedAgentIds.get("team-lead"))
                        return;
                    const invocationId = unclaimedTaskCalls.shift();
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
                    counts.set(invocation.sessionId, count + 1);
                    inFlight.add(invocation.sessionId);
                    pending.set(invocation.sessionId, { agent: logicalId, runtimeAgent: target.id, invocationId });
                    emitHarborEvidence(evidenceHook, {
                        harness: "copilot",
                        phase: "target.resolved",
                        agent: logicalId,
                        runtimeAgent: target.id,
                        parentSessionId: invocation.sessionId,
                        invocationId,
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
        observeEvent: (event) => {
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
            const entries = [...pending.entries()];
            const toolCallId = event.data?.toolCallId;
            if (event.type === "tool.execution_start" && !event.agentId && event.data?.toolName === "task" && toolCallId) {
                const uncorrelated = entries.filter(([, state]) => !state.invocationId);
                if (uncorrelated.length === 1)
                    uncorrelated[0][1].invocationId = toolCallId;
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
                const base = {
                    harness: "copilot",
                    agent: state.agent,
                    runtimeAgent: state.runtimeAgent,
                    parentSessionId: sessionId,
                    childId: state.childId,
                    invocationId: state.invocationId,
                };
                emitHarborEvidence(evidenceHook, { ...base, phase: "child.started", outcome: "ok" });
                emitHarborEvidence(evidenceHook, { ...base, phase: "prompt.attempted", outcome: "ok" });
            }
            else if (event.type === "subagent.completed" && event.data?.agentName === state.runtimeAgent && toolCallId === state.invocationId) {
                state.terminal = "completed";
            }
            else if (event.type === "subagent.failed" && event.data?.agentName === state.runtimeAgent && toolCallId === state.invocationId) {
                state.terminal = "failed";
                state.error = serialized(event.data.error);
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
                void finishTask(input, sessionId, data.success === false || state.terminal === "failed" ? "failed" : "completed");
            }
        },
    };
}
