import type { PiObservedThinkingLevel, PiRunObserver, PiTeamRunState } from "../core/pi-observability.js";
export type { PiRunObserver, PiTeamRunState } from "../core/pi-observability.js";
export type PiTeamMemberKind = "manager" | "fixed" | "bundled" | "personal" | "contractor" | "utility";
export interface PiNativeTokenUsage {
    readonly input?: number;
    readonly output?: number;
    readonly reasoning?: number;
    readonly cacheRead?: number;
    readonly cacheWrite?: number;
    readonly total?: number;
}
export type PiNativeUsageField = keyof PiNativeTokenUsage;
export interface PiTeamRunSnapshot {
    readonly id: string;
    readonly sequence: number;
    readonly rootRunId: string;
    readonly parentRunId?: string;
    readonly agent: string;
    readonly kind: PiTeamMemberKind;
    readonly task: string;
    readonly state: PiTeamRunState;
    readonly startedAt: number;
    readonly endedAt?: number;
    readonly elapsedMs: number;
    readonly model?: {
        readonly provider: string;
        readonly id: string;
    };
    readonly modelSource?: "configured" | "inherited" | "observed";
    readonly observedModels: readonly {
        readonly provider: string;
        readonly id: string;
    }[];
    readonly observedModelsTruncated: boolean;
    readonly thinking?: PiObservedThinkingLevel;
    readonly usage: PiNativeTokenUsage;
    /** Fields whose visible value is a known lower bound because at least one turn lacked native usage. */
    readonly usageLowerBounds: readonly PiNativeUsageField[];
    readonly nativeMessages: number;
    /** True when message identity/retention bounds mean additional native turns may have been omitted. */
    readonly nativeMessagesLowerBound: boolean;
}
export interface PiRunStart {
    readonly project: string;
    readonly agent: string;
    readonly kind: PiTeamMemberKind;
    readonly task: string;
    readonly parentRunId?: string;
    readonly model?: {
        readonly provider: string;
        readonly id: string;
    };
    readonly modelSource?: "configured" | "inherited";
    readonly thinking?: PiObservedThinkingLevel;
}
export declare const maximumPiObservedMessages = 4096;
export declare function piPublicIdentifier(value: unknown, limit?: number): string | undefined;
/** Produces a useful but deliberately lossy task label without retaining prompts, paths, or likely secrets. */
export declare function piTaskLabel(task: string): string;
/** Process-local registry. It never persists task text or asks a model to summarize activity. */
export declare class PiTeamRuntime {
    private readonly now;
    private readonly maxRootRuns;
    private readonly runs;
    private readonly listeners;
    private readonly messageFingerprintKey;
    private sequence;
    constructor(now?: () => number, maxRootRuns?: number);
    begin(input: PiRunStart): string;
    observer(runId: string): PiRunObserver;
    setState(runId: string, state: PiTeamRunState): void;
    finishIfOpen(runId: string, outcome: "completed" | "failed" | "cancelled"): void;
    observeMessageEnd(runId: string, value: unknown): boolean;
    subscribe(listener: (runId: string) => void): () => void;
    get(runId: string): PiTeamRunSnapshot | undefined;
    mission(rootRunId: string): PiTeamRunSnapshot[];
    projectRuns(project: string): PiTeamRunSnapshot[];
    activeProjectRuns(project: string): PiTeamRunSnapshot[];
    latestRoot(project: string): PiTeamRunSnapshot | undefined;
    missionUsage(rootRunId: string): PiNativeTokenUsage;
    missionUsageLowerBounds(rootRunId: string): PiNativeUsageField[];
    projectName(project: string): string;
    private snapshot;
    private require;
    private emit;
    private prune;
}
export declare function formatElapsed(milliseconds: number): string;
export declare function formatTokenCount(value: number | undefined, lowerBound?: boolean): string;
export declare function formatModel(run: PiTeamRunSnapshot): string;
export declare function formatUsage(usage: PiNativeTokenUsage, lowerBounds?: readonly PiNativeUsageField[]): string;
/** Waits for best-effort shutdown cleanup without allowing a provider to hang Pi forever. */
export declare function settlePiRootPromises(promises: readonly Promise<unknown>[], timeoutMs?: number): Promise<boolean>;
/** Formats selected run rows without inventing or leaking an aggregate. */
export declare function formatPiRunDetails(runs: readonly PiTeamRunSnapshot[]): string[];
/** Shared mission details for the final notification and the zero-model history view. */
export declare function formatPiMissionDetails(runtime: PiTeamRuntime, rootRunId: string): string[];
/** Final accounting is composed outside child evidence, so a lead never sees or reasons over it. */
export declare function formatPiMissionReport(runtime: PiTeamRuntime, rootRunId: string): string;
export declare function formatPiLiveStatus(runtime: PiTeamRuntime, rootRunId: string): string;
export declare function formatPiLiveWidget(runtime: PiTeamRuntime, rootRunId: string): string[];
