export declare const openCodeCleanupHazardRecovery: string;
/** Hazards intentionally persist until the OpenCode process reloads. */
export declare function recordOpenCodeCleanupHazard(project: string): void;
export declare function hasOpenCodeCleanupHazard(project: string): boolean;
