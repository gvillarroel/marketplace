/** Replaces the bounded conflict snapshot for one loaded OpenCode project. */
export declare function recordOpenCodeAgentConflicts(project: string, ids: readonly string[]): void;
/** Returns a defensive copy so TUI callers cannot mutate config-hook state. */
export declare function readOpenCodeAgentConflicts(project: string): ReadonlySet<string>;
