import type { HarnessName, PlayerDefinition } from "./types.js";
export interface InvocablePlayerIdentity {
    id: string;
    source: "fixed" | "active";
    /** Available for fixed roles and every validated Pi active player. */
    definition?: PlayerDefinition;
}
/** Lists project profiles that are owned by Agent Harbor and safe to invoke. */
export declare function listManagedActiveIds(harness: HarnessName, project: string): string[];
/** Fixed roles first, followed by ownership-verified project profiles. */
export declare function listInvocablePlayerIds(harness: HarnessName, project: string): string[];
export declare function loadPiActivePlayer(project: string, id: unknown): PlayerDefinition;
export declare function requireInvocablePlayer(harness: HarnessName, project: string, id: unknown): InvocablePlayerIdentity;
export declare function assertInvocablePlayer(harness: HarnessName, project: string, id: unknown): asserts id is string;
export declare function isInvocablePlayer(harness: HarnessName, project: string, id: unknown): boolean;
