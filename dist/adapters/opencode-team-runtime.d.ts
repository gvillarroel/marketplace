import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import type { PlayerDefinition } from "../core/types.js";
import { type OpenCodeAgentActivityPhase } from "./opencode-agent-activity.js";
export declare const maximumOpenCodeSessions = 64;
export declare const maximumOpenCodeActiveSessions = 32;
export declare const maximumOpenCodeMessageSessions = 24;
export declare const maximumOpenCodeMessagesPerSession = 16;
export declare const maximumVisibleOpenCodeRosterMembers = 40;
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
    readonly cost?: number;
}
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
    readonly task: string;
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
    readonly usageScope?: "current-turn" | "session-total";
    readonly observedAssistantTurns?: number;
    readonly observedAssistantTurnsLowerBound: boolean;
    readonly telemetryLowerBound: boolean;
    readonly telemetryBounded?: boolean;
}
export interface OpenCodeTeamReservationSnapshot {
    readonly agent: string;
    readonly invocation: "direct" | "delegated";
    readonly phase: OpenCodeAgentActivityPhase;
    readonly startedAt: number;
    readonly elapsedMs: number;
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
    /** Process-local lifecycle claims not yet represented by an authoritative native active session. */
    readonly reservations: readonly OpenCodeTeamReservationSnapshot[];
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
/** Stops only sessions classified as Harbor and re-proven active by the v2 API. */
export declare function stopOpenCodeTeamRuns(api: TuiPluginApi, selector: string, options?: OpenCodeTeamRuntimeOptions): Promise<OpenCodeTeamStopResult>;
