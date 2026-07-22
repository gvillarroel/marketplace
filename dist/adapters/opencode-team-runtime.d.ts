import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import type { PlayerDefinition } from "../core/types.js";
import { type OpenCodeAgentActivityPhase } from "./opencode-agent-activity.js";
export declare const maximumOpenCodeSessions = 64;
export declare const maximumOpenCodeActiveSessions = 32;
export declare const maximumOpenCodeMessageSessions = 24;
export declare const maximumOpenCodeMessagesPerSession = 16;
export declare const maximumVisibleOpenCodeRosterMembers = 40;
export declare const maximumOpenCodeRosterRecords = 256;
export declare const maximumOpenCodeRosterSnapshotBytes = 16384;
export interface OpenCodeDirectAliasCollision {
    readonly alias: string;
    readonly agent: string;
}
/** Replaces the bounded direct-alias collision snapshot for one loaded project. */
export declare function recordOpenCodeDirectAliasCollisions(project: string, collisions: readonly OpenCodeDirectAliasCollision[]): void;
/** Returns defensive records so view callers cannot mutate config-hook state. */
export declare function readOpenCodeDirectAliasCollisions(project: string): readonly OpenCodeDirectAliasCollision[];
export type OpenCodeTeamMemberKind = "manager" | "fixed" | "bundled" | "personal" | "utility";
export type OpenCodeTeamAvailability = "ready" | "reload-required" | "bench" | "stale" | "conflict" | "unavailable";
export interface OpenCodeTeamMember {
    readonly id: string;
    readonly kind: OpenCodeTeamMemberKind;
    readonly availability: OpenCodeTeamAvailability;
    readonly description: string;
    readonly capacity: string;
    readonly tools: readonly string[];
    readonly skills: readonly string[];
    readonly configuredModel?: string;
}
export interface OpenCodeObservedUsage {
    readonly input?: number;
    readonly output?: number;
    readonly reasoning?: number;
    readonly cacheRead?: number;
    readonly cacheWrite?: number;
    /** OpenCode's native assistant total, or an explicitly labelled observed-component sum. */
    readonly total?: number;
    readonly cost?: number;
}
export type OpenCodeUsageTotalSource = "native" | "observed-components" | "mixed";
export type OpenCodeObservedUsageField = keyof OpenCodeObservedUsage;
export interface OpenCodeTeamRunSnapshot {
    /** Bounded identifier shown to the user and accepted as a unique stop prefix. */
    readonly id: string;
    readonly parentRunId?: string;
    readonly parentSource?: "observed" | "inferred";
    readonly agent: string;
    readonly kind: OpenCodeTeamMemberKind | "contractor";
    readonly rosterState?: OpenCodeTeamAvailability | "retired-or-unlisted";
    readonly invocation: "direct" | "delegated" | "contract";
    readonly state: "working" | "retrying";
    /** Opaque, process-stable locator for grouping work without disclosing a PID. */
    readonly ownerLocator?: string;
    readonly task: string;
    /** True only when host telemetry exposed a user task for this active run. */
    readonly taskObserved: boolean;
    readonly startedAt: number;
    readonly elapsedMs: number;
    /** Digest of the latest direct user/agent-switch ID used to detect turn drift. */
    readonly turnBoundaryID?: string;
    readonly turnBoundaryAt?: number;
    readonly model?: {
        readonly provider: string;
        readonly id: string;
        readonly variant?: string;
    };
    readonly usage: OpenCodeObservedUsage;
    /** Per-field incompleteness; explicit native zero is observed and does not enter this set. */
    readonly usageLowerBounds?: readonly OpenCodeObservedUsageField[];
    /** Distinguishes a host-reported total from a sum Agent Harbor computed for display. */
    readonly usageTotalSource?: OpenCodeUsageTotalSource;
    /** True when the displayed total omits an unobserved component/message or overflowed safely. */
    readonly usageTotalLowerBound?: boolean;
    /** Native total and observed components cannot both be true under either reasoning convention. */
    readonly usageTotalConflict?: boolean;
    readonly usageScope?: "current-turn" | "session-total";
    readonly observedAssistantTurns?: number;
    readonly observedAssistantTurnsLowerBound: boolean;
    readonly telemetryLowerBound: boolean;
    readonly telemetryBounded?: boolean;
}
export interface OpenCodeTeamReservationSnapshot {
    /** Absent only while a delegated child identity is still being published. */
    readonly id?: string;
    readonly agent: string;
    readonly invocation: "direct" | "delegated" | "contract";
    readonly phase: OpenCodeAgentActivityPhase;
    /** Opaque, process-stable locator for grouping work without disclosing a PID. */
    readonly ownerLocator?: string;
    readonly startedAt: number;
    readonly elapsedMs: number;
    /** True only for a fresh owner claim created by this OpenCode OS process. */
    readonly stopAvailable: boolean;
    readonly stopBlockReason?: "pending-child" | "lifecycle-transition" | "native-run-pending" | "stop-confirmation-pending" | "dual-engine" | "other-process" | "ambiguous-identity" | "claim-changed" | "ownership-changed" | "stale-heartbeat";
}
export interface OpenCodeTeamSnapshot {
    readonly projectName: string;
    readonly hostDefaultModel?: {
        readonly provider: string;
        readonly id: string;
        readonly contextLimit?: number;
        readonly outputLimit?: number;
    };
    readonly members: readonly OpenCodeTeamMember[];
    readonly runs: readonly OpenCodeTeamRunSnapshot[];
    /** Cross-isolate filesystem claims not yet represented by an authoritative native active session. */
    readonly reservations: readonly OpenCodeTeamReservationSnapshot[];
    /** Foreign slash commands preserved by the config hook; native agents remain independent. */
    readonly directAliasCollisions: readonly OpenCodeDirectAliasCollision[];
    readonly activeAuthoritative: boolean;
    /** Exact shown-run stop can still be rechecked when global discovery overflowed. */
    readonly exactStopAvailable: boolean;
    readonly degradedReasons: readonly string[];
    readonly sessionListTruncated: boolean;
    readonly activeListTruncated: boolean;
    readonly messageFanoutTruncated: boolean;
}
export interface OpenCodeTeamRuntimeOptions {
    readonly rpcDeadlineMs?: number;
    readonly collectionDeadlineMs?: number;
    readonly maximumSessions?: number;
    readonly maximumActiveSessions?: number;
    readonly maximumMessageSessions?: number;
    readonly maximumMessagesPerSession?: number;
    readonly maximumConcurrency?: number;
    readonly now?: () => number;
    readonly signal?: AbortSignal;
}
export interface OpenCodeTeamStopResult {
    readonly requested: string;
    readonly stopped: readonly string[];
    readonly alreadyIdle: readonly string[];
    readonly failed: readonly string[];
    /** Validated teammate IDs whose disposable child identity is not published yet. */
    readonly pendingChildIdentity?: readonly string[];
    /** Public run IDs whose fresh claim belongs to another OpenCode process. */
    readonly ownedByAnotherProcess?: readonly string[];
    /** Public run IDs suppressed because more than one claim referenced one native session. */
    readonly claimIdentityUnavailable?: readonly string[];
    /** Public run IDs whose native agent/title ownership changed during inspection. */
    readonly ownershipUnavailable?: readonly string[];
    /** Public run IDs whose owner process exists but whose claim heartbeat is overdue. */
    readonly staleOwnerHeartbeat?: readonly string[];
    /** Public run IDs still starting or already cleaning; no stop mutation was issued. */
    readonly lifecycleTransition?: readonly string[];
    /** Working claims whose legacy runner is not yet authoritatively visible. */
    readonly nativeRunPending?: readonly string[];
    /** Harbor work concurrently present in both independent OpenCode engines. */
    readonly engineAuthorityUnavailable?: readonly string[];
    /** Stop mutations still unresolved in the host worker; callers must not retry yet. */
    readonly pendingConfirmation?: readonly string[];
}
/** Strips terminal controls and bounds identifiers supplied by OpenCode. */
export declare function openCodePublicIdentifier(value: unknown, limit?: number): string | undefined;
/** Sanitizes descriptive/model text while preserving ordinary provider/model routes. */
export declare function openCodePublicLabel(value: unknown, limit?: number): string | undefined;
/** Produces a useful but lossy task label without retaining paths, URLs, or likely secrets. */
export declare function openCodeTaskLabel(task: string): string;
/** True when this TUI session still exposes an agent ID, even if its definition is stale. */
export declare function isOpenCodeAgentConfigured(api: TuiPluginApi, id: string): boolean;
/** Proves that OpenCode loaded the same managed definition that is active now. */
export declare function isOpenCodeAgentLoaded(api: TuiPluginApi, id: string, definition?: PlayerDefinition): boolean;
/** Collects an active-only, bounded OpenCode roster snapshot without inference. */
export declare function collectOpenCodeTeamSnapshot(api: TuiPluginApi, options?: OpenCodeTeamRuntimeOptions): Promise<OpenCodeTeamSnapshot>;
/** Stops only Harbor sessions re-proven active and owner-bound, then confirmed terminal after abort. */
export declare function stopOpenCodeTeamRuns(api: TuiPluginApi, selector: string, options?: OpenCodeTeamRuntimeOptions): Promise<OpenCodeTeamStopResult>;
