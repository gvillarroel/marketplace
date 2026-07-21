/**
 * Best-effort, content-minimizing evidence emitted around disposable child execution.
 * Hooks receive hashes and byte counts instead of task, result, or error bodies.
 */
import { createHash } from "node:crypto";
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
