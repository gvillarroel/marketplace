import { type HarborEvidenceHook } from "../core/evidence.js";
/** Minimal host identity needed to resolve a logical Harbor player. */
export interface CopilotAgentIdentity {
    id: string;
    path?: string;
    model?: string;
    userInvocable?: boolean;
}
/** Narrow RPC surface used to refresh Copilot's selected and available agents. */
export interface CopilotCoordinatorSession {
    rpc: {
        agent: {
            getCurrent(): Promise<{
                agent?: CopilotAgentIdentity | null;
            }>;
            reload(): Promise<{
                agents: CopilotAgentIdentity[];
            }>;
        };
    };
}
interface HookInvocation {
    sessionId: string;
}
interface HookBaseInput {
    sessionId: string;
    workingDirectory: string;
}
interface ToolHookInput extends HookBaseInput {
    toolName: string;
    toolArgs: unknown;
}
interface PostToolHookInput extends ToolHookInput {
    toolResult?: unknown;
}
interface PostToolFailureHookInput extends ToolHookInput {
    error?: string;
}
interface UserPromptHookInput extends HookBaseInput {
    prompt?: string;
}
interface PreToolDecision {
    permissionDecision: "allow" | "deny";
    permissionDecisionReason?: string;
}
/** Stable run metadata shared by every privacy-preserving lifecycle callback. */
export interface CopilotCoordinatorRunCorrelation {
    /** Copilot's native session identifier. */
    sessionId: string;
    /** Project-local scope used only by the in-process runtime; never persisted by the guard. */
    project: string;
    /** Agent Harbor's process-local ID for the current root user turn. */
    rootRunId: string;
    /** Agent Harbor's process-local ID for this root or child run. */
    runId: string;
    /** Present only for a child, and always equal to its root's run ID. */
    parentRunId?: string;
    kind: "root" | "child";
    /** Logical Harbor player ID. */
    agent: string;
    /** Copilot's plugin-qualified or project-profile agent ID. */
    runtimeAgent: string;
    /** Native sub-agent instance ID, once Copilot reports it. */
    childId?: string;
    /** Native `task` tool-call ID. */
    invocationId?: string;
    /** Native assistant turn ID, when the host event carries one. */
    turnId?: string;
    /** Native session event-chain IDs. */
    eventId?: string;
    parentEventId?: string | null;
    /** Native ISO timestamp, or callback time for hook-only observations. */
    timestamp?: string;
    /** Whether Copilot reported the lifecycle fact or the guard inferred it. */
    basis: "observed" | "inferred";
}
export interface CopilotCoordinatorRootStartedEvent extends CopilotCoordinatorRunCorrelation {
    type: "root.started";
    kind: "root";
    /** Bounded lossy label; the submitted prompt is never exposed or retained. */
    taskLabel: string;
    model?: string;
    modelSource?: "configured" | "inherited";
    reasoningEffort?: string | null;
}
export interface CopilotCoordinatorChildStartedEvent extends CopilotCoordinatorRunCorrelation {
    type: "child.started";
    kind: "child";
    parentRunId: string;
    /** Bounded lossy label; the delegated prompt is never exposed or retained. */
    taskLabel: string;
    model?: string;
}
export type CopilotCoordinatorRunState = "starting" | "working" | "waiting" | "idle" | "cancelling" | "completed" | "failed" | "cancelled";
export interface CopilotCoordinatorRunStateEvent extends CopilotCoordinatorRunCorrelation {
    type: "run.state";
    state: CopilotCoordinatorRunState;
}
export interface CopilotCoordinatorRunModelEvent extends CopilotCoordinatorRunCorrelation {
    type: "run.model";
    model: string;
}
export interface CopilotCoordinatorRunReasoningEvent extends CopilotCoordinatorRunCorrelation {
    type: "run.reasoning";
    /** A setting such as `low` or `high`; never model reasoning content. */
    reasoningEffort: string | null;
}
export interface CopilotCoordinatorNativeUsage {
    inputTokens?: number;
    outputTokens?: number;
    reasoningTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    /** Computed only when both native input and output counters are present. */
    totalTokens?: number;
}
export interface CopilotCoordinatorRunUsageEvent extends CopilotCoordinatorRunCorrelation {
    type: "run.usage";
    apiCallId?: string;
    serviceRequestId?: string;
    providerCallId?: string;
    model?: string;
    reasoningEffort?: string | null;
    usage: CopilotCoordinatorNativeUsage;
}
export interface CopilotCoordinatorRunFinishedEvent extends CopilotCoordinatorRunCorrelation {
    type: "run.finished";
    outcome: "completed" | "failed" | "cancelled";
    durationMs?: number;
    /** Native aggregate supplied by Copilot for a sub-agent terminal event. */
    totalTokens?: number;
    totalToolCalls?: number;
}
/** Content-free lifecycle stream consumed by the in-memory Copilot team runtime. */
export type CopilotCoordinatorLifecycleEvent = CopilotCoordinatorRootStartedEvent | CopilotCoordinatorChildStartedEvent | CopilotCoordinatorRunStateEvent | CopilotCoordinatorRunModelEvent | CopilotCoordinatorRunReasoningEvent | CopilotCoordinatorRunUsageEvent | CopilotCoordinatorRunFinishedEvent;
/** Best-effort observer; callback failures never change delegation behavior. */
export type CopilotCoordinatorLifecycleHook = (event: CopilotCoordinatorLifecycleEvent) => void | Promise<void>;
/** Synchronous child admission check; throwing denies the native `task` before model work starts. */
export type CopilotCoordinatorAdmissionHook = (input: {
    type: "child";
    project: string;
    rootRunId: string;
    parentRunId: string;
    runId: string;
    agent: string;
    runtimeAgent: string;
    taskLabel: string;
}) => void;
/** Hook callbacks installed into the Copilot extension session. */
export interface CopilotCoordinatorHooks {
    onUserPromptSubmitted(input: UserPromptHookInput, invocation: HookInvocation): Promise<void>;
    onPreToolUse(input: ToolHookInput, invocation: HookInvocation): Promise<PreToolDecision | void>;
    onPostToolUse(input: PostToolHookInput, invocation: HookInvocation): Promise<void>;
    onPostToolUseFailure(input: PostToolFailureHookInput, invocation: HookInvocation): Promise<void>;
}
/** Stateful guard plus host-event observer used by the Copilot extension. */
export interface CopilotCoordinatorGuard {
    hooks: CopilotCoordinatorHooks;
    refresh(expectedCurrentId?: string): Promise<void>;
    refreshAuthoritative(): Promise<void>;
    observeEvent(event: CopilotCoordinatorHostEvent): void;
}
/** Structural subset of Copilot SDK 1.0.6 session events used by the guard. */
export interface CopilotCoordinatorHostEvent {
    type?: string;
    id?: string;
    parentId?: string | null;
    timestamp?: string;
    agentId?: string;
    data?: {
        aborted?: boolean;
        agentName?: string;
        apiCallId?: string;
        cacheReadTokens?: number;
        cacheWriteTokens?: number;
        currentModel?: string;
        durationMs?: number;
        error?: unknown;
        inputTokens?: number;
        model?: string;
        newModel?: string;
        outputTokens?: number;
        parentToolCallId?: string;
        providerCallId?: string;
        reasoningEffort?: string | null;
        reasoningTokens?: number;
        result?: unknown;
        selectedModel?: string;
        serviceRequestId?: string;
        sessionId?: string;
        shutdownType?: string;
        success?: boolean;
        toolCallId?: string;
        toolName?: string;
        toolDescription?: {
            name?: string;
        };
        tools?: string[] | null;
        totalTokens?: number;
        totalToolCalls?: number;
        turnId?: string;
        /** Other SDK fields, including content-bearing fields, are deliberately ignored. */
        [key: string]: unknown;
    };
}
export declare const copilotFixedAgentIds: ReadonlyMap<string, string>;
/** Plugin-qualified identity used only by the explicit `/scout` command. */
export declare const copilotScoutAgentId = "agent-foundry:talent-scout";
/** Lists canonical active project profile IDs without trusting arbitrary files. */
export declare function listCopilotActiveProfileIds(project: string): string[];
/** Resolves one logical ID to exactly one currently invocable Copilot identity. */
export declare function resolveCopilotPlayer(id: string, agents: readonly CopilotAgentIdentity[], project: string, activeProfileIds?: readonly string[]): CopilotAgentIdentity;
/**
 * Enforce the team-lead contract around Copilot's native synchronous `task`
 * tool. The host remains responsible for the child lifecycle and result.
 */
export declare function createCopilotCoordinatorGuard(getSession: () => CopilotCoordinatorSession, evidenceHook?: HarborEvidenceHook, lifecycleHook?: CopilotCoordinatorLifecycleHook, admissionHook?: CopilotCoordinatorAdmissionHook): CopilotCoordinatorGuard;
export {};
