import { type CopilotAgentIdentity } from "./copilot-coordinator.js";
import { CopilotTeamRuntime, type CopilotTeamMemberKind } from "./copilot-team-runtime.js";
export interface CopilotTeamMember {
    readonly id: string;
    readonly kind: Exclude<CopilotTeamMemberKind, "contractor">;
    readonly availability: "ready" | "bench" | "stale" | "conflict" | "unavailable";
    readonly description: string;
    readonly capacity: string;
    readonly configuredModel?: string;
    readonly repairKind?: "bundled-profile" | "personal-active" | "personal-registration" | "native-discovery";
}
export interface CopilotNativeRosterStatus {
    readonly agents: readonly CopilotAgentIdentity[];
    readonly discoveryAvailable: boolean;
    readonly coordinatorReady: boolean;
    readonly selectionRestoreUnverified?: boolean;
}
export declare const maximumVisibleCopilotRosterMembers = 32;
/** Resolves the complete Copilot-visible roster without creating a model request. */
export declare function collectCopilotTeamMembers(project: string, native?: CopilotNativeRosterStatus): Promise<CopilotTeamMember[]>;
export interface CopilotTeamViewOptions {
    readonly filter?: string;
    readonly title?: "team" | "bench";
    readonly nextModel?: string;
    readonly nextReasoning?: string;
    readonly nextMaxOutputTokens?: number;
    readonly native?: CopilotNativeRosterStatus;
    readonly selectionGate?: string;
}
/** Minimal process-local fallback used when authoritative roster rendering misses its shared deadline. */
export declare function formatCopilotDegradedTeamView(project: string, runtime: CopilotTeamRuntime, options?: {
    title?: "team" | "bench";
    filter?: string;
    reasons?: readonly string[];
    budgetMs?: number;
    selectionGate?: string;
}): string;
/** Formats roster, active hierarchy, and last mission without inference or durable activity storage. */
export declare function formatCopilotTeamView(project: string, runtime: CopilotTeamRuntime, options?: CopilotTeamViewOptions): Promise<string>;
