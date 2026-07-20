import type { HarnessName } from "./types.js";
export declare const HARBOR_EVIDENCE_SCHEMA: "agent-harbor/evidence@1";
export type HarborEvidencePhase = "target.resolved" | "child.started" | "prompt.attempted" | "evidence.returned" | "child.completed" | "child.failed" | "child.cleaned";
export interface HarborEvidenceFingerprint {
    sha256: string;
    utf8Bytes: number;
}
export interface HarborEvidenceEvent {
    schema: typeof HARBOR_EVIDENCE_SCHEMA;
    source: "adapter-hook";
    basis: "observed" | "inferred";
    phase: HarborEvidencePhase;
    harness: HarnessName;
    agent: string;
    runtimeAgent?: string;
    parentSessionId?: string;
    childId?: string;
    invocationId?: string;
    outcome?: "ok" | "error";
    task?: HarborEvidenceFingerprint;
    evidence?: HarborEvidenceFingerprint;
    error?: HarborEvidenceFingerprint;
}
export type HarborEvidenceHook = (event: HarborEvidenceEvent) => void;
export declare function fingerprintHarborEvidence(value: string): HarborEvidenceFingerprint;
export declare function emitHarborEvidence(hook: HarborEvidenceHook | undefined, event: Omit<HarborEvidenceEvent, "schema" | "source" | "basis"> & {
    basis?: HarborEvidenceEvent["basis"];
}): void;
