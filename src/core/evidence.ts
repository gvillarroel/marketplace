/**
 * Best-effort, content-minimizing evidence emitted around disposable child execution.
 * Hooks receive hashes and byte counts instead of task, result, or error bodies.
 */

import { createHash } from "node:crypto";
import type { HarnessName } from "./types.js";

/** Versioned schema identifier attached to every adapter evidence event. */
export const HARBOR_EVIDENCE_SCHEMA = "agent-harbor/evidence@1" as const;

/** Ordered lifecycle observations an adapter may report for a disposable child. */
export type HarborEvidencePhase =
  | "target.resolved"
  | "child.started"
  | "prompt.attempted"
  | "evidence.returned"
  | "child.completed"
  | "child.failed"
  | "child.cleaned";

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
export function fingerprintHarborEvidence(value: string): HarborEvidenceFingerprint {
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
export function emitHarborEvidence(
  hook: HarborEvidenceHook | undefined,
  event: Omit<HarborEvidenceEvent, "schema" | "source" | "basis"> & { basis?: HarborEvidenceEvent["basis"] },
): void {
  if (!hook) return;
  try {
    const result: unknown = hook({
      schema: HARBOR_EVIDENCE_SCHEMA,
      source: "adapter-hook",
      ...event,
      basis: event.basis ?? "observed",
    });
    if (result && typeof (result as PromiseLike<unknown>).then === "function") {
      void Promise.resolve(result).catch(() => undefined);
    }
  }
  catch { /* Observability must never change child execution or cleanup. */ }
}
