import type { PlayerDefinition } from "./types.js";
export declare const harborCustomToolNames: Readonly<{
    readonly contractPreflight: "harbor_contract";
    readonly filterSkills: "harbor_filter_skills";
    readonly joinPlayer: "harbor_join_player";
    readonly delegate: "harbor_delegate";
    readonly teamRoster: "harbor_team_roster";
}>;
export type HarborStaticCustomToolName = (typeof harborCustomToolNames)[keyof typeof harborCustomToolNames];
export declare const maximumHarborTeamRosterMembers = 32;
export type HarborScoutToolName = typeof harborCustomToolNames.teamRoster | typeof harborCustomToolNames.filterSkills | typeof harborCustomToolNames.joinPlayer;
export interface HarborTeamRosterEntry {
    readonly id: string;
    readonly role: string;
    readonly tools: readonly string[];
    readonly skills?: readonly string[];
    readonly configuredModel?: string;
    readonly availability: "ready" | "busy";
}
export interface HarborFormattedTeamRoster {
    readonly text: string;
    /** False means no member rows were disclosed and filter/join must fail closed. */
    readonly complete: boolean;
    readonly total: number;
}
/**
 * Produces the same complete, compact model-facing roster in every adapter.
 * A query ranks likely matches first but never hides other enabled members.
 */
export declare function formatHarborTeamRosterSnapshot(entries: readonly HarborTeamRosterEntry[], query?: string, benchOffCommand?: "/bench off <id...>" | "/bench-off <id...>"): HarborFormattedTeamRoster;
export interface HarborScoutCallTicket {
    readonly name: HarborScoutToolName;
    readonly nonce: number;
}
/**
 * Shared invocation-local roster -> filter -> optional join state machine.
 * It enforces completeness, ordering, call budgets, serialization, and terminal
 * state. Semantic capacity/sufficiency remains an explicit recruiter policy:
 * the guard intentionally receives no roster rows and cannot infer it.
 */
export declare class HarborScoutTurnGuard {
    private rosterCalls;
    private rosterSucceeded;
    private rosterComplete;
    private filterCalls;
    private filterSucceeded;
    private joinCalls;
    private nextNonce;
    private inFlight?;
    private terminalReason?;
    get terminal(): boolean;
    begin(name: HarborScoutToolName, signal?: AbortSignal): HarborScoutCallTicket;
    succeed(ticket: HarborScoutCallTicket, outcome?: {
        readonly rosterComplete?: boolean;
    }): void;
    fail(ticket: HarborScoutCallTicket, signal?: AbortSignal): void;
    terminate(reason?: string): void;
    private requireTicket;
}
interface HarborInvocationLedgerLifecycle<T> {
    readonly create: () => T;
    readonly terminal: (value: T) => boolean;
    readonly terminate: (value: T, reason: string) => void;
}
/**
 * Fixed-memory HMAC-keyed host identity ledger. Terminal entries may be
 * evicted only into a non-clearing replay filter, so eviction never reopens a
 * spent call budget. Raw host IDs are never retained.
 */
export declare class HarborInvocationLedger<T> {
    private readonly lifecycle;
    private readonly maximumEntries;
    private readonly key;
    private readonly entries;
    private readonly tombstones;
    constructor(lifecycle: HarborInvocationLedgerLifecycle<T>, maximumEntries?: number);
    acquire(scopeParts: readonly string[], invocationParts: readonly string[]): {
        readonly id: string;
        readonly value: T;
    };
    terminate(id: string, reason?: string): void;
    terminateScope(scopeParts: readonly string[], reason?: string): void;
    terminateAll(reason?: string): void;
    private evictOneTerminal;
    private digest;
}
/** Returns the single custom skill-loader name permanently bound to a player. */
export declare function harborPlayerSkillToolName(player: Pick<PlayerDefinition, "name"> | string): string;
/** Decodes only names produced by {@link harborPlayerSkillToolName}. */
export declare function harborPlayerFromSkillToolName(name: string): string | undefined;
export interface HarborCustomToolPolicy {
    readonly principal: "contract-skill" | "bound-player" | "talent-scout" | "team-lead" | "team-lead-or-talent-scout";
    readonly maximumCalls: number;
    readonly sequential: true;
    readonly effect: "read" | "roster-write" | "child-run";
}
/** Returns policy for a static tool or one player-bound skill loader. */
export declare function harborCustomToolPolicy(name: string): HarborCustomToolPolicy | undefined;
export interface HarborCustomToolSpec {
    readonly name: string;
    readonly description: string;
    readonly parameters: Readonly<Record<string, unknown>>;
    readonly policy: HarborCustomToolPolicy;
}
export declare const harborStaticCustomToolSpecs: Readonly<Record<HarborStaticCustomToolName, HarborCustomToolSpec>>;
/** Builds one no-argument spec whose handler is permanently bound to `player`. */
export declare function harborPlayerSkillToolSpec(player: Pick<PlayerDefinition, "name">): HarborCustomToolSpec;
/** Custom tools required by one player; adapters register only the union they need. */
export declare function harborCustomToolsForPlayer(player: Pick<PlayerDefinition, "name" | "skills">): string[];
export interface HarborCustomToolPrincipal {
    /** Host-authenticated logical agent. Never accept this value from tool arguments. */
    readonly agent?: string;
    /** Host-authenticated user-invoked skill name, when applicable. */
    readonly skill?: string;
}
/** Enforces the transport-neutral principal boundary after the adapter authenticates it. */
export declare function assertHarborCustomToolAccess(name: string, principal: HarborCustomToolPrincipal): void;
export type HarborValidatedCustomToolCall = {
    readonly kind: "contract-preflight";
    readonly definition: string;
} | {
    readonly kind: "player-skills";
    readonly player: string;
} | {
    readonly kind: "filter-skills";
    readonly query: string;
} | {
    readonly kind: "join-player";
    readonly definition: string;
} | {
    readonly kind: "delegate";
    readonly agent: string;
    readonly task: string;
} | {
    readonly kind: "team-roster";
    readonly query: string;
};
/** Validates runtime arguments independently of the host's JSON-schema implementation. */
export declare function validateHarborCustomToolArguments(name: string, value: unknown): HarborValidatedCustomToolCall;
export interface HarborCustomToolDispatchContext extends HarborCustomToolPrincipal {
    readonly project: string;
    readonly signal?: AbortSignal;
    readonly invocationId?: string;
}
export interface HarborCustomToolHandlers<TResult = unknown> {
    contractPreflight(call: Extract<HarborValidatedCustomToolCall, {
        kind: "contract-preflight";
    }>, context: HarborCustomToolDispatchContext): Promise<TResult> | TResult;
    playerSkills(call: Extract<HarborValidatedCustomToolCall, {
        kind: "player-skills";
    }>, context: HarborCustomToolDispatchContext): Promise<TResult> | TResult;
    filterSkills(call: Extract<HarborValidatedCustomToolCall, {
        kind: "filter-skills";
    }>, context: HarborCustomToolDispatchContext): Promise<TResult> | TResult;
    joinPlayer(call: Extract<HarborValidatedCustomToolCall, {
        kind: "join-player";
    }>, context: HarborCustomToolDispatchContext): Promise<TResult> | TResult;
    delegate(call: Extract<HarborValidatedCustomToolCall, {
        kind: "delegate";
    }>, context: HarborCustomToolDispatchContext): Promise<TResult> | TResult;
    teamRoster(call: Extract<HarborValidatedCustomToolCall, {
        kind: "team-roster";
    }>, context: HarborCustomToolDispatchContext): Promise<TResult> | TResult;
}
/** Shared closed-schema/access dispatcher; adapters inject only the side effects. */
export declare function dispatchHarborCustomTool<TResult>(name: string, args: unknown, context: HarborCustomToolDispatchContext, handlers: HarborCustomToolHandlers<TResult>): Promise<TResult> | TResult;
export {};
