import { createHash } from "node:crypto";
export const HARBOR_EVIDENCE_SCHEMA = "agent-harbor/evidence@1";
export function fingerprintHarborEvidence(value) {
    return {
        sha256: createHash("sha256").update(value, "utf8").digest("hex"),
        utf8Bytes: Buffer.byteLength(value, "utf8"),
    };
}
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
