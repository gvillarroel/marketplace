/**
 * Read-only discovery and validation of project-active player profiles.
 * Ownership markers identify Agent Harbor files; canonical validation separately decides whether
 * their complete executable representation is current and therefore invocable.
 */
import type { HarnessName, PlayerDefinition } from "./types.js";
/** Resolved player identity returned only after its definition is safe to invoke. */
export interface InvocablePlayerIdentity {
    /** Stable player identifier used by harness delegation tools. */
    id: string;
    /** Whether the definition is built in or recovered from an active managed profile. */
    source: "fixed" | "active";
    /** Validated definition recovered from a fixed role or revision-4 managed profile. */
    definition: PlayerDefinition;
}
/**
 * Lists active files carrying a structurally valid Agent Harbor ownership marker.
 * The result may include stale revision-3 or modified revision-4 profiles; use
 * {@link listManagedActiveIds} when selecting an invocation target.
 */
export declare function listOwnedActiveIds(harness: HarnessName, project: string): string[];
/** Lists owned revision-4 profiles whose complete executable representation is canonical. */
export declare function listManagedActiveIds(harness: HarnessName, project: string): string[];
/** Lists fixed roles first, followed by canonical project profiles that are safe to invoke. */
export declare function listInvocablePlayerIds(harness: HarnessName, project: string): string[];
/**
 * Returns an invocation-scoped snapshot of every fixed/current player. Active
 * definitions are parsed once during the scan so callers cannot create a run
 * and then lose its preparation to a second filesystem read.
 */
export declare function listInvocablePlayers(harness: HarnessName, project: string): InvocablePlayerIdentity[];
/** Loads one active player only if it is owned, revision-4, validated, and canonical. */
export declare function loadManagedActivePlayer(harness: HarnessName, project: string, id: unknown): PlayerDefinition;
/** Pi-specific convenience wrapper for loading a canonical active player. */
export declare function loadPiActivePlayer(project: string, id: unknown): PlayerDefinition;
/** Resolves a fixed role or canonical active profile and returns its validated definition. */
export declare function requireInvocablePlayer(harness: HarnessName, project: string, id: unknown): InvocablePlayerIdentity;
/** Narrows an unknown identifier to a string after proving the corresponding player is invocable. */
export declare function assertInvocablePlayer(harness: HarnessName, project: string, id: unknown): asserts id is string;
/** Returns whether an identifier resolves to a fixed role or canonical active profile. */
export declare function isInvocablePlayer(harness: HarnessName, project: string, id: unknown): boolean;
