/** Minimal host-neutral contract used to observe one disposable Pi child. */
export type PiObservedThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type PiTeamRunState = "starting" | "working" | "cleaning" | "completed" | "failed" | "cancelled" | "cleanup-error";
export interface PiRunObserver {
    sessionStarted(info?: {
        readonly sessionId?: string;
        readonly model?: {
            readonly provider: string;
            readonly id: string;
        };
        readonly thinking?: PiObservedThinkingLevel;
    }): void;
    messageEnd(message: unknown): void;
    state(state: PiTeamRunState): void;
}
