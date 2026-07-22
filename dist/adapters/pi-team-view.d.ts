import { PiTeamRuntime, type PiTeamMemberKind } from "./pi-team-runtime.js";
export interface PiTeamMember {
    readonly id: string;
    readonly kind: Exclude<PiTeamMemberKind, "contractor">;
    readonly availability: "ready" | "bench" | "stale" | "conflict";
    readonly description: string;
    readonly capacity: string;
    readonly tools?: readonly string[];
    readonly skills?: readonly string[];
    readonly configuredModel?: string;
    readonly repairKind?: "bundled-profile" | "personal-active" | "personal-registration";
}
export declare const maximumVisiblePiRosterMembers = 32;
export declare const maximumVisiblePiOverviewRosterMembers = 12;
export declare const maximumVisiblePiOverviewRuns = 4;
export declare const maximumPiTeamOverviewLines = 30;
/** Resolves every Pi-visible roster class without creating an SDK session or model turn. */
export declare function collectPiTeamMembers(project: string): Promise<PiTeamMember[]>;
export interface PiTeamViewOptions {
    readonly filter?: string;
    readonly title?: "team" | "bench";
    /** A zero-model host discovery warning that must remain inside this bounded view. */
    readonly discoveryWarning?: string;
    readonly nextModel?: {
        readonly provider: string;
        readonly id: string;
        readonly maxTokens?: number;
    };
    /** Pi's current model plus registry authoritatively report that no model is available. */
    readonly nextModelUnavailable?: boolean;
    /** Pi reports usable models, but none is selected for the next inherited child. */
    readonly nextModelAvailableCount?: number;
    /** Pi has no active model and its availability could not be observed safely. */
    readonly nextModelAvailabilityUnobserved?: boolean;
    readonly nextThinking?: string;
}
/** Formats roster plus live runtime data. This function performs no inference. */
export declare function formatPiTeamView(project: string, runtime: PiTeamRuntime, options?: PiTeamViewOptions): Promise<string>;
