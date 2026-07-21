/**
 * Best-effort, content-minimizing evidence emitted around disposable child execution.
 * Hooks receive hashes and byte counts instead of task, result, or error bodies.
 */
import type { HarnessName } from "./types.js";
export declare const maximumHarborEvidenceBytes = 30000;
/** Bounded child evidence with an explicit, machine-visible truncation marker. */
export interface BoundedHarborEvidence {
    readonly text: string;
    /** Exact unless `utf8BytesLowerBound` is true. */
    readonly utf8Bytes: number;
    readonly utf8BytesLowerBound?: boolean;
    readonly truncated: boolean;
}
/** Bounds a settled child response without cutting a UTF-8 code point. */
export declare function boundHarborEvidence(value: string, maximumBytes?: number): BoundedHarborEvidence;
/** Streaming variant that never retains more than the configured evidence cap. */
export declare class HarborEvidenceAccumulator {
    private readonly maximumBytes;
    private retained;
    private totalBytes;
    private omittedSegments;
    constructor(maximumBytes?: number);
    append(value: string): void;
    /** Records input deliberately not inspected so the result cannot look complete. */
    markIncomplete(omittedSegments?: number): void;
    result(): BoundedHarborEvidence;
}
/** Versioned schema identifier attached to every adapter evidence event. */
export declare const HARBOR_EVIDENCE_SCHEMA: "agent-harbor/evidence@1";
/** Ordered lifecycle observations an adapter may report for a disposable child. */
export type HarborEvidencePhase = "target.resolved" | "child.started" | "prompt.attempted" | "evidence.returned" | "child.completed" | "child.failed" | "child.cleaned";
/** Non-reversible identity and exact UTF-8 size of evidence kept out of event payloads. */
export interface HarborEvidenceFingerprint {
    sha256: string;
    utf8Bytes: number;
}
/** Structured lifecycle evidence emitted by a harness adapter. */
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
/** Observer invoked synchronously by adapters; its failures never affect child execution. */
export type HarborEvidenceHook = (event: HarborEvidenceEvent) => void;
/** Creates the privacy-preserving hash and UTF-8 byte count used in evidence events. */
export declare function fingerprintHarborEvidence(value: string): HarborEvidenceFingerprint;
/**
 * Delivers an evidence event on a best-effort basis.
 * Synchronous throws and asynchronous rejections are deliberately swallowed so observability
 * cannot alter child execution, its outcome, or mandatory cleanup.
 */
export declare function emitHarborEvidence(hook: HarborEvidenceHook | undefined, event: Omit<HarborEvidenceEvent, "schema" | "source" | "basis"> & {
    basis?: HarborEvidenceEvent["basis"];
}): void;
