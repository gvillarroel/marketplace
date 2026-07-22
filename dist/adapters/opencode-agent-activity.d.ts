import type { CommandName } from "../core/types.js";
export type OpenCodeAgentActivityKind = "direct" | "delegated";
export type OpenCodeAgentActivityPhase = "starting" | "working" | "cleaning";
export type AgentHarborActivityOwnerRuntime = "opencode" | "pi" | "copilot";
export interface OpenCodeAgentActivitySnapshot {
    readonly agent: string;
    readonly kind: OpenCodeAgentActivityKind;
    readonly phase: OpenCodeAgentActivityPhase;
    readonly startedAt: number;
    /** Private native identity. Views must project this field away. */
    readonly sessionID: string;
    /** Claims from another OpenCode OS process are visible but never stoppable here. */
    readonly processID: number;
    /** Opaque ownership generation used only for compare-before-stop/release. */
    readonly claimToken: string;
    /** Public routing hint; absent only on legacy version-1 claims. */
    readonly ownerRuntime?: AgentHarborActivityOwnerRuntime;
    /** Present only on filesystem observations whose heartbeat exceeded the TTL. */
    readonly heartbeatOverdue?: true;
}
export interface OpenCodeAgentActivityClaim {
    readonly snapshot: OpenCodeAgentActivitySnapshot;
    /** Publishes the disposable child identity before delegated work becomes visible as working. */
    setSessionID(sessionID: string): boolean;
    setPhase(phase: OpenCodeAgentActivityPhase): boolean;
    /** One-shot notification that this process no longer owns the exact published generation. */
    onOwnershipLost(listener: () => void): () => void;
    /** True only after this exact owner generation is absent from the canonical path. */
    release(): boolean;
}
/** Final synchronous ownership check executed while roster mutations are excluded. */
export interface AgentHarborActivityAdmissionInventory {
    /** Exact fresh-claim count observed while the transactional capacity lock is held. */
    readonly activeClaimCount: number;
    readonly maximumClaimCount: number;
}
export type OpenCodeAgentActivityAdmissionValidation = (inventory: AgentHarborActivityAdmissionInventory) => void;
/** Atomically claims one player across OpenCode server/plugin isolates and OS processes. */
export declare function claimOpenCodeAgentActivity(project: string, agent: string, kind: OpenCodeAgentActivityKind, sessionID: string, now?: number): OpenCodeAgentActivityClaim;
/** Claims only if the final live roster/configuration check still passes under the capacity gate. */
export declare function claimValidatedOpenCodeAgentActivity(project: string, agent: string, kind: OpenCodeAgentActivityKind, sessionID: string, validateAdmission: OpenCodeAgentActivityAdmissionValidation, now?: number): OpenCodeAgentActivityClaim;
/** Cross-process claim shared by Pi and Copilot without entering OpenCode's native-session inventory. */
export declare function claimSharedAgentActivity(project: string, agent: string, kind: OpenCodeAgentActivityKind, runID: string, ownerRuntime: Exclude<AgentHarborActivityOwnerRuntime, "opencode">, now?: number): OpenCodeAgentActivityClaim;
/** Shared claim whose final roster/configuration validation runs under the cross-process gate. */
export declare function claimValidatedSharedAgentActivity(project: string, agent: string, kind: OpenCodeAgentActivityKind, runID: string, ownerRuntime: Exclude<AgentHarborActivityOwnerRuntime, "opencode">, validateAdmission: OpenCodeAgentActivityAdmissionValidation, now?: number): OpenCodeAgentActivityClaim;
/** Applies the activity gate only when an OpenCode command can remove/replace owned roster state. */
export declare function runOpenCodeRosterMutationGate<T>(command: CommandName, args: string, project: string, action: () => Promise<T>, ignoredClaimToken?: string): Promise<T>;
/**
 * Runs one destructive roster mutation while new activity admissions are
 * excluded. A specialist claim protects that member; manager/scout claims
 * conservatively protect the complete roster snapshot they may be using.
 */
export declare function withOpenCodeRosterMutationGate<T>(project: string, targets: readonly string[], actionLabel: string, action: () => Promise<T>, ignoredClaimToken?: string): Promise<T>;
/** Shared Pi/Copilot destructive-mutation gate; an exact owner may mutate for its own scout run. */
export declare function withSharedRosterMutationGate<T>(project: string, targets: readonly string[], actionLabel: string, action: () => Promise<T>, ignoredClaimToken?: string): Promise<T>;
/** Returns bounded claims that are fresh or whose owner PID is not definitely absent. */
export declare function readOpenCodeAgentActivities(project: string): readonly OpenCodeAgentActivitySnapshot[];
/** Private stop/recovery inventory; overdue claims remain observable unless exact dead-owner recovery succeeds. */
export declare function readOpenCodeAgentActivitiesIncludingStale(project: string): readonly OpenCodeAgentActivitySnapshot[];
/** Bounded live claims shared across Pi and Copilot OS processes. */
export declare function readSharedAgentActivities(project: string): readonly OpenCodeAgentActivitySnapshot[];
