import { PiTeamRuntime, type PiTeamMemberKind } from "./pi-team-runtime.js";
export interface PiTeamMember {
    readonly id: string;
    readonly kind: Exclude<PiTeamMemberKind, "contractor">;
    readonly availability: "ready" | "bench" | "stale" | "conflict";
    readonly description: string;
    readonly capacity: string;
    readonly configuredModel?: string;
    readonly repairKind?: "bundled-profile" | "personal-active" | "personal-registration";
}
/** Resolves every Pi-visible roster class without creating an SDK session or model turn. */
export declare function collectPiTeamMembers(project: string): Promise<PiTeamMember[]>;
export interface PiTeamViewOptions {
    readonly filter?: string;
    readonly title?: "team" | "bench";
    readonly nextModel?: {
        readonly provider: string;
        readonly id: string;
        readonly maxTokens?: number;
    };
    readonly nextThinking?: string;
}
/** Formats roster plus live runtime data. This function performs no inference. */
export declare function formatPiTeamView(project: string, runtime: PiTeamRuntime, options?: PiTeamViewOptions): Promise<string>;
