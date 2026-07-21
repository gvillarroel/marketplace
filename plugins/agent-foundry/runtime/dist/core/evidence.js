/**
 * Best-effort, content-minimizing evidence emitted around disposable child execution.
 * Hooks receive hashes and byte counts instead of task, result, or error bodies.
 */
import { createHash } from "node:crypto";
export const maximumHarborEvidenceBytes = 30_000;
const maximumConfigurableHarborEvidenceBytes = 1_000_000;
function validateEvidenceLimit(maximumBytes) {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 256 ||
        maximumBytes > maximumConfigurableHarborEvidenceBytes) {
        throw new Error(`Agent Harbor evidence byte limit must be an integer between 256 and ${maximumConfigurableHarborEvidenceBytes}`);
    }
}
function utf8Prefix(value, maximumBytes) {
    if (maximumBytes <= 0)
        return "";
    // At most `maximumBytes` UTF-16 code units can contribute to a UTF-8 prefix
    // of that many bytes. One extra unit completes a surrogate pair at the cut.
    // This avoids copying an attacker-sized settled response merely to retain a
    // small evidence prefix.
    const boundedCandidate = value.length > maximumBytes + 1
        ? value.slice(0, maximumBytes + 1)
        : value;
    const bytes = Buffer.from(boundedCandidate, "utf8");
    if (bytes.length <= maximumBytes)
        return value;
    let end = maximumBytes;
    const decoder = new TextDecoder("utf-8", { fatal: true });
    while (end > 0) {
        try {
            return decoder.decode(bytes.subarray(0, end));
        }
        catch {
            end -= 1;
        }
    }
    return "";
}
/** Bounds a settled child response without cutting a UTF-8 code point. */
export function boundHarborEvidence(value, maximumBytes = maximumHarborEvidenceBytes) {
    validateEvidenceLimit(maximumBytes);
    const utf8Bytes = Buffer.byteLength(value, "utf8");
    if (utf8Bytes <= maximumBytes)
        return { text: value, utf8Bytes, truncated: false };
    const marker = `\n[HARBOR-EVIDENCE-TRUNCATED original_utf8_bytes=${utf8Bytes} limit=${maximumBytes}]`;
    const retained = utf8Prefix(value, maximumBytes - Buffer.byteLength(marker, "utf8"));
    return { text: retained + marker, utf8Bytes, truncated: true };
}
/** Streaming variant that never retains more than the configured evidence cap. */
export class HarborEvidenceAccumulator {
    maximumBytes;
    retained = "";
    totalBytes = 0;
    omittedSegments = 0;
    constructor(maximumBytes = maximumHarborEvidenceBytes) {
        this.maximumBytes = maximumBytes;
        validateEvidenceLimit(maximumBytes);
    }
    append(value) {
        if (typeof value !== "string" || !value)
            return;
        this.totalBytes += Buffer.byteLength(value, "utf8");
        const retainedBytes = Buffer.byteLength(this.retained, "utf8");
        if (retainedBytes < this.maximumBytes) {
            this.retained += utf8Prefix(value, this.maximumBytes - retainedBytes);
        }
    }
    /** Records input deliberately not inspected so the result cannot look complete. */
    markIncomplete(omittedSegments = 1) {
        if (!Number.isSafeInteger(omittedSegments) || omittedSegments < 1) {
            throw new Error("omitted evidence segment count must be a positive safe integer");
        }
        this.omittedSegments = Math.min(Number.MAX_SAFE_INTEGER, this.omittedSegments + omittedSegments);
    }
    result() {
        if (this.totalBytes <= this.maximumBytes && this.omittedSegments === 0) {
            return { text: this.retained, utf8Bytes: this.totalBytes, truncated: false };
        }
        // Re-bound the retained prefix with either the exact observed size or a
        // truthful lower bound when a caller deliberately capped its iteration.
        const marker = this.omittedSegments === 0
            ? `\n[HARBOR-EVIDENCE-TRUNCATED original_utf8_bytes=${this.totalBytes} limit=${this.maximumBytes}]`
            : `\n[HARBOR-EVIDENCE-TRUNCATED observed_utf8_bytes_at_least=${this.totalBytes} omitted_segments_at_least=${this.omittedSegments} limit=${this.maximumBytes}]`;
        const text = utf8Prefix(this.retained, this.maximumBytes - Buffer.byteLength(marker, "utf8")) + marker;
        return {
            text,
            utf8Bytes: this.totalBytes,
            ...(this.omittedSegments === 0 ? {} : { utf8BytesLowerBound: true }),
            truncated: true,
        };
    }
}
/** Versioned schema identifier attached to every adapter evidence event. */
export const HARBOR_EVIDENCE_SCHEMA = "agent-harbor/evidence@1";
/** Creates the privacy-preserving hash and UTF-8 byte count used in evidence events. */
export function fingerprintHarborEvidence(value) {
    return {
        sha256: createHash("sha256").update(value, "utf8").digest("hex"),
        utf8Bytes: Buffer.byteLength(value, "utf8"),
    };
}
/**
 * Delivers an evidence event on a best-effort basis.
 * Synchronous throws and asynchronous rejections are deliberately swallowed so observability
 * cannot alter child execution, its outcome, or mandatory cleanup.
 */
export function emitHarborEvidence(hook, event) {
    if (!hook)
        return;
    try {
        const result = hook({
            schema: HARBOR_EVIDENCE_SCHEMA,
            source: "adapter-hook",
            ...event,
            basis: event.basis ?? "observed",
        });
        if (result && typeof result.then === "function") {
            void Promise.resolve(result).catch(() => undefined);
        }
    }
    catch { /* Observability must never change child execution or cleanup. */ }
}
