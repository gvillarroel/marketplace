export declare const maximumConcurrentCopilotRoots = 32;
export declare const maximumCopilotUsageIdentityKeys = 4096;
export type CopilotTeamRunState = "starting" | "working" | "waiting" | "cleaning" | "completed" | "failed" | "cancelled" | "cleanup-error";
export type CopilotTeamMemberKind = "manager" | "fixed" | "bundled" | "personal" | "contractor" | "utility";
export interface CopilotNativeTokenUsage {
    readonly input?: number;
    readonly output?: number;
    readonly reasoning?: number;
    readonly cacheRead?: number;
    readonly cacheWrite?: number;
    readonly total?: number;
}
export type CopilotNativeUsageField = keyof CopilotNativeTokenUsage;
export interface CopilotNativeBillingUsage {
    /** Sum of Copilot's per-request model-multiplier billing units; not USD. */
    readonly modelMultiplier?: number;
    /** Sum of Copilot's native nano-AI-unit values. */
    readonly totalNanoAiu?: number;
}
export type CopilotNativeBillingField = keyof CopilotNativeBillingUsage;
export interface CopilotTeamRunSnapshot {
    readonly id: string;
    readonly sequence: number;
    readonly rootRunId: string;
    readonly parentRunId?: string;
    readonly agent: string;
    readonly kind: CopilotTeamMemberKind;
    readonly task: string;
    readonly state: CopilotTeamRunState;
    readonly startedAt: number;
    readonly endedAt?: number;
    readonly elapsedMs: number;
    readonly model?: string;
    readonly modelSource?: "configured" | "inherited" | "observed";
    readonly observedModels: readonly string[];
    readonly observedModelsTruncated: boolean;
    readonly reasoningEffort?: string;
    readonly reasoningSource?: "inherited" | "observed";
    readonly observedReasoningEfforts: readonly string[];
    readonly observedReasoningEffortsTruncated: boolean;
    readonly usage: CopilotNativeTokenUsage;
    readonly usageLowerBounds: readonly CopilotNativeUsageField[];
    readonly billing: CopilotNativeBillingUsage;
    readonly billingLowerBounds: readonly CopilotNativeBillingField[];
    /** The authoritative terminal total contradicted the per-call token sum. */
    readonly usageAggregateConflict: boolean;
    readonly usageIdentityTruncated: boolean;
    readonly usageIdentityAmbiguous: boolean;
    readonly usageAttributionUnverified: boolean;
    readonly nativeCalls?: number;
    readonly durationMs?: number;
    readonly totalToolCalls?: number;
    /** Durable activity owned by another Pi/Copilot process; telemetry and stop remain with that owner. */
    readonly projectSharedExternal?: true;
    readonly sharedActivityKind?: "direct" | "delegated";
    /** Public routing hint for a project-shared owner; absent on legacy version-1 claims. */
    readonly sharedOwnerRuntime?: "pi" | "copilot";
    /** Public OS process identity for a project-shared owner. */
    readonly sharedOwnerProcessID?: number;
    readonly sharedHeartbeatOverdue?: true;
}
export interface CopilotRunStart {
    readonly project: string;
    readonly agent: string;
    readonly kind: CopilotTeamMemberKind;
    readonly task: string;
    readonly parentRunId?: string;
    readonly model?: string;
    readonly modelSource?: "configured" | "inherited";
    readonly reasoningEffort?: string;
}
export interface CopilotUsageEvent {
    readonly id?: string;
    readonly timestamp?: string;
    readonly type: "assistant.usage";
    readonly agentId?: string;
    readonly data: {
        readonly apiCallId?: string;
        readonly serviceRequestId?: string;
        readonly providerCallId?: string;
        readonly model?: string;
        readonly reasoningEffort?: string;
        readonly inputTokens?: number;
        readonly outputTokens?: number;
        readonly reasoningTokens?: number;
        readonly cacheReadTokens?: number;
        readonly cacheWriteTokens?: number;
        /** Copilot's model-multiplier billing units for this request; not USD. */
        readonly cost?: number;
        readonly copilotUsage?: {
            readonly totalNanoAiu?: number;
        };
    };
}
export interface CopilotRunObserver {
    event(event: CopilotUsageEvent): boolean;
    state(state: CopilotTeamRunState): void;
}
/** Strips terminal controls and bounds host-provided public identifiers. */
export declare function copilotPublicIdentifier(value: unknown, limit?: number): string | undefined;
/** Produces a deliberately lossy label without retaining paths, URLs, or likely secrets. */
export declare function copilotTaskLabel(task: string): string;
/** In-memory registry; it never persists model content or asks a model to summarize activity. */
export declare class CopilotTeamRuntime {
    private readonly now;
    private readonly maxRootRuns;
    private readonly runs;
    private readonly listeners;
    private readonly agentRuns;
    private readonly fingerprintKey;
    private sequence;
    constructor(now?: () => number, maxRootRuns?: number);
    assertRootStartAllowed(project: string, agent: string, kind: CopilotTeamMemberKind): void;
    assertChildStartAllowed(project: string, agent: string, parentRunId: string, kind?: CopilotTeamMemberKind): void;
    assertStartAllowed(input: CopilotRunStart): void;
    begin(input: CopilotRunStart): string;
    observer(runId: string): CopilotRunObserver;
    attachChild(runId: string, input: {
        agentId?: string;
        model?: string;
    }): void;
    /** Reclassifies one still-active root when an exact user-invoked wrapper is observed after prompt submission. */
    relabelActiveRoot(runId: string, input: {
        agent: string;
        kind: Exclude<CopilotTeamMemberKind, "contractor">;
        task: string;
    }): void;
    observeRootModel(runId: string, model?: string, reasoningEffort?: string): void;
    observeUsageEvent(event: CopilotUsageEvent, rootRunId?: string): boolean;
    markUsageAttributionUnverified(runId: string): void;
    childTerminal(runId: string, outcome: "completed" | "failed", summary?: {
        model?: string;
        durationMs?: number;
        totalTokens?: number;
        totalToolCalls?: number;
    }): void;
    finishChild(runId: string, fallback: "completed" | "failed"): void;
    setState(runId: string, state: CopilotTeamRunState): void;
    finishIfOpen(runId: string, outcome: "completed" | "failed" | "cancelled"): void;
    finish(runId: string, outcome: "completed" | "failed" | "cancelled"): void;
    subscribe(listener: (runId: string) => void): () => void;
    get(runId: string): CopilotTeamRunSnapshot | undefined;
    mission(rootRunId: string): CopilotTeamRunSnapshot[];
    projectRuns(project: string): CopilotTeamRunSnapshot[];
    list(project: string): CopilotTeamRunSnapshot[];
    activeProjectRuns(project: string): CopilotTeamRunSnapshot[];
    activeRoot(project: string, agent: string): CopilotTeamRunSnapshot | undefined;
    latestRoot(project: string): CopilotTeamRunSnapshot | undefined;
    missionUsage(rootRunId: string): CopilotNativeTokenUsage;
    missionUsageLowerBounds(rootRunId: string): CopilotNativeUsageField[];
    missionBilling(rootRunId: string): CopilotNativeBillingUsage;
    missionBillingLowerBounds(rootRunId: string): CopilotNativeBillingField[];
    missionUsageAggregateConflict(rootRunId: string): boolean;
    missionUsageAttributionUnverified(rootRunId: string): boolean;
    projectName(project: string): string;
    private observeModel;
    private rememberObservedModel;
    private observeEffort;
    private rememberObservedEffort;
    private snapshot;
    private require;
    private emit;
    private releaseAgentKeys;
    private prune;
}
export declare function formatCopilotElapsed(milliseconds: number): string;
export declare function formatCopilotTokenCount(value: number | undefined, lowerBound?: boolean): string;
export declare function formatCopilotBilling(billing: CopilotNativeBillingUsage, lowerBounds?: readonly CopilotNativeBillingField[]): string;
export declare function formatCopilotModel(run: CopilotTeamRunSnapshot): string;
export declare function formatCopilotReasoning(run: CopilotTeamRunSnapshot): string;
export declare function formatCopilotUsage(usage: CopilotNativeTokenUsage, lowerBounds?: readonly CopilotNativeUsageField[]): string;
export declare function formatCopilotNativeTelemetry(run: CopilotTeamRunSnapshot, detailed?: boolean): string;
export declare function formatCopilotRunDetails(runs: readonly CopilotTeamRunSnapshot[]): string[];
export declare function formatCopilotMissionDetails(runtime: CopilotTeamRuntime, rootRunId: string): string[];
export declare function formatCopilotMissionReport(runtime: CopilotTeamRuntime, rootRunId: string): string;
