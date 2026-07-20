import { createHash } from "node:crypto";
import type { HarnessName } from "./types.js";

export const HARBOR_EVIDENCE_SCHEMA = "agent-harbor/evidence@1" as const;

export type HarborEvidencePhase =
  | "target.resolved"
  | "child.started"
  | "prompt.attempted"
  | "evidence.returned"
  | "child.completed"
  | "child.failed"
  | "child.cleaned";

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

export function fingerprintHarborEvidence(value: string): HarborEvidenceFingerprint {
  return {
    sha256: createHash("sha256").update(value, "utf8").digest("hex"),
    utf8Bytes: Buffer.byteLength(value, "utf8"),
  };
}

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
