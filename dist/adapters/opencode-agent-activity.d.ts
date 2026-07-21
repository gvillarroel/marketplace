export type OpenCodeAgentActivityKind = "direct" | "delegated";
export type OpenCodeAgentActivityPhase = "starting" | "working" | "cleaning";
export interface OpenCodeAgentActivitySnapshot {
    readonly agent: string;
    readonly kind: OpenCodeAgentActivityKind;
    readonly phase: OpenCodeAgentActivityPhase;
    readonly startedAt: number;
}
export interface OpenCodeAgentActivityClaim {
    readonly snapshot: OpenCodeAgentActivitySnapshot;
    setPhase(phase: OpenCodeAgentActivityPhase): void;
    release(): void;
}
/** Atomically claims one player so plugin instances cannot overlap during host-session startup or cleanup. */
export declare function claimOpenCodeAgentActivity(project: string, agent: string, kind: OpenCodeAgentActivityKind, now?: number): OpenCodeAgentActivityClaim;
/** Returns defensive, bounded public activity facts without session IDs, tasks, or provider metadata. */
export declare function readOpenCodeAgentActivities(project: string): readonly OpenCodeAgentActivitySnapshot[];
