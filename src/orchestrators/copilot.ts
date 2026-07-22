/** One-child Copilot SDK orchestration with isolated skills and full cleanup. */
import { CopilotClient, approveAll } from "@github/copilot-sdk";
import type { CopilotSession } from "@github/copilot-sdk";
import type { ContractDefinition, GithubResolver, Orchestrator } from "../core/types.js";
import { GhResolver } from "../core/github.js";
import { trustedSkills } from "../core/defaults.js";
import {
  boundHarborEvidence,
  emitHarborEvidence,
  fingerprintHarborEvidence,
  type HarborEvidenceHook,
} from "../core/evidence.js";
import { composePlayerInstructions, nativeTools } from "../core/profiles.js";
import { createSkillCapsule } from "../core/skills.js";

export interface CopilotOrchestratorOptions {
  /** Maximum time allowed for a single SDK setup or prompt operation. */
  operationTimeoutMs?: number;
  /** Maximum time allowed for each independent cleanup operation. */
  cleanupTimeoutMs?: number;
  /** Maximum time allowed for a requested SDK abort to settle. */
  abortTimeoutMs?: number;
}

function boundedTimeout(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 1
    ? Math.min(600_000, Math.floor(value))
    : fallback;
}

class CopilotOperationDeadlineError extends Error {
  constructor(readonly operation: string, readonly timeoutMs: number) {
    super(`${operation} exceeded its ${timeoutMs}ms deadline`);
    this.name = "CopilotOperationDeadlineError";
  }
}

function withDeadline<T>(label: string, operation: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      reject(new CopilotOperationDeadlineError(label, timeoutMs));
    }, timeoutMs);
    operation.then(
      (value) => { clearTimeout(timer); resolvePromise(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

function withAbortSignal<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  signal.throwIfAborted();
  return new Promise<T>((resolvePromise, reject) => {
    const aborted = (): void => reject(signal.reason ?? new Error("Copilot child was aborted"));
    signal.addEventListener("abort", aborted, { once: true });
    operation.then(
      (value) => { signal.removeEventListener("abort", aborted); resolvePromise(value); },
      (error) => { signal.removeEventListener("abort", aborted); reject(error); },
    );
  });
}

async function attemptBoundedCleanup(
  errors: unknown[],
  label: string,
  operation: () => Promise<unknown>,
  timeoutMs: number,
): Promise<void> {
  try {
    await withDeadline(label, Promise.resolve().then(operation), timeoutMs);
  } catch (error) {
    errors.push(error);
  }
}

/** Executes invocation-scoped contracts through the Copilot SDK. */
export class CopilotOrchestrator implements Orchestrator {
  readonly harness = "copilot" as const;
  private readonly lateCleanupLedger = new Set<Promise<void>>();
  constructor(
    private readonly createClient: () => CopilotClient = () => new CopilotClient(),
    private readonly directory = process.cwd(),
    private readonly github: GithubResolver = new GhResolver(),
    private readonly evidenceHook?: HarborEvidenceHook,
    private readonly options: CopilotOrchestratorOptions = {},
  ) {}

  private observeLateCleanup(operation: Promise<void>): void {
    let observed: Promise<void>;
    observed = operation
      .catch(() => undefined)
      .finally(() => { this.lateCleanupLedger.delete(observed); });
    if (this.lateCleanupLedger.size >= 32) {
      const oldest = this.lateCleanupLedger.values().next().value as Promise<void> | undefined;
      if (oldest) this.lateCleanupLedger.delete(oldest);
    }
    this.lateCleanupLedger.add(observed);
    void observed;
  }
  /**
   * Creates exactly one custom-agent session, returns its non-empty evidence,
   * and always deletes the session, stops the client, and removes its capsule.
   */
  async run(definition: ContractDefinition, signal?: AbortSignal): Promise<string> {
    const operationTimeoutMs = boundedTimeout(this.options.operationTimeoutMs, 180_000);
    const cleanupTimeoutMs = boundedTimeout(this.options.cleanupTimeoutMs, 10_000);
    const abortTimeoutMs = boundedTimeout(this.options.abortTimeoutMs, cleanupTimeoutMs);
    signal?.throwIfAborted();
    const capsule = await createSkillCapsule(definition, this.directory, this.github, trustedSkills, signal);
    const evidenceBase = { harness: this.harness, agent: definition.name, runtimeAgent: definition.name } as const;
    emitHarborEvidence(this.evidenceHook, {
      ...evidenceBase,
      phase: "target.resolved",
      outcome: "ok",
      task: fingerprintHarborEvidence(definition.task),
    });
    let client: CopilotClient | undefined;
    let session: CopilotSession | undefined;
    let createSessionPromise: Promise<CopilotSession> | undefined;
    let abort: (() => void) | undefined;
    let abortPromise: Promise<void> | undefined;
    let failed = false;
    let failure: unknown;
    let output = "";
    try {
      signal?.throwIfAborted();
      client = this.createClient();
      createSessionPromise = Promise.resolve().then(() => client!.createSession({
        model: definition.model ?? "auto",
        workingDirectory: this.directory,
        enableConfigDiscovery: false,
        enableSkills: capsule.skills.length > 0,
        skillDirectories: capsule.root ? [capsule.root] : [],
        customAgents: [{
          name: definition.name,
          displayName: definition.name,
          description: definition.description,
          prompt: composePlayerInstructions(definition),
          tools: nativeTools("copilot", definition.tools),
          skills: capsule.skills.map((skill) => skill.reference.name),
        }],
        agent: definition.name,
        onPermissionRequest: approveAll,
      }));
      session = await withAbortSignal(withDeadline(
        "Copilot child session creation",
        createSessionPromise,
        operationTimeoutMs,
      ), signal);
      emitHarborEvidence(this.evidenceHook, {
        ...evidenceBase,
        phase: "child.started",
        outcome: "ok",
        childId: session.sessionId,
      });
      abort = () => {
        if (!session || abortPromise) return;
        abortPromise = Promise.resolve().then(() => session!.abort());
        // The bounded cleanup path observes this rejection. Attach an early
        // handler so an immediate SDK rejection is never reported unhandled.
        void abortPromise.catch(() => undefined);
      };
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      signal?.throwIfAborted();
      emitHarborEvidence(this.evidenceHook, {
        ...evidenceBase,
        phase: "prompt.attempted",
        outcome: "ok",
        childId: session.sessionId,
      });
      const response = await withAbortSignal(withDeadline(
        "Copilot child prompt",
        session.sendAndWait({ prompt: definition.task }),
        operationTimeoutMs,
      ), signal);
      signal?.throwIfAborted();
      output = boundHarborEvidence(response?.data.content ?? "").text;
      if (!output.trim()) throw new Error(`Copilot child ${definition.name} returned empty evidence`);
      emitHarborEvidence(this.evidenceHook, {
        ...evidenceBase,
        phase: "evidence.returned",
        outcome: "ok",
        childId: session.sessionId,
        evidence: fingerprintHarborEvidence(output),
      });
      emitHarborEvidence(this.evidenceHook, {
        ...evidenceBase,
        phase: "child.completed",
        outcome: "ok",
        childId: session.sessionId,
      });
    } catch (error) {
      failed = true;
      failure = error;
      abort?.();
      emitHarborEvidence(this.evidenceHook, {
        ...evidenceBase,
        phase: "child.failed",
        outcome: "error",
        childId: session?.sessionId,
        error: fingerprintHarborEvidence(String(error)),
      });
    } finally {
      // Cleanup errors remain observable. If execution also failed, preserve
      // both causes in one AggregateError instead of masking either failure.
      const cleanupErrors: unknown[] = [];
      if (abort) signal?.removeEventListener("abort", abort);

      // A local deadline/abort can win while the SDK is still creating a
      // session. Give that raw promise one bounded cleanup grace period so a
      // late child can be claimed and deleted before the transport is stopped.
      if (!session && createSessionPromise) {
        try {
          session = await withDeadline(
            "Copilot late child session settlement",
            createSessionPromise,
            cleanupTimeoutMs,
          );
          abortPromise = Promise.resolve().then(() => session!.abort());
          void abortPromise.catch(() => undefined);
        } catch (error) {
          if (error instanceof CopilotOperationDeadlineError) {
            cleanupErrors.push(error);
            const lateClient = client;
            const lateCreation = createSessionPromise;
            this.observeLateCleanup(lateCreation.then(async (lateSession) => {
              const lateErrors: unknown[] = [];
              await attemptBoundedCleanup(
                lateErrors,
                "Copilot late child abort",
                () => lateSession.abort(),
                abortTimeoutMs,
              );
              await attemptBoundedCleanup(
                lateErrors,
                "Copilot late child session deletion",
                () => lateClient!.deleteSession(lateSession.sessionId),
                cleanupTimeoutMs,
              );
              await attemptBoundedCleanup(
                lateErrors,
                "Copilot late client stop",
                () => lateClient!.stop(),
                cleanupTimeoutMs,
              );
              const lateCleanupError = lateErrors.length === 0
                ? undefined
                : lateErrors.length === 1
                  ? lateErrors[0]
                  : new AggregateError(lateErrors, "Copilot late child cleanup failed");
              emitHarborEvidence(this.evidenceHook, {
                ...evidenceBase,
                phase: "child.cleaned",
                outcome: lateCleanupError === undefined ? "ok" : "error",
                childId: lateSession.sessionId,
                ...(lateCleanupError === undefined
                  ? {}
                  : { error: fingerprintHarborEvidence(String(lateCleanupError)) }),
              });
            }));
          }
          // A provider rejection creates no session and is already represented
          // by the primary execution failure; do not relabel it as cleanup.
        }
      }

      // Keep transport teardown ordered. Each phase has its own deadline, and
      // a failed phase never prevents the following one from being attempted.
      if (abortPromise) {
        await attemptBoundedCleanup(
          cleanupErrors,
          "Copilot child abort",
          () => abortPromise!,
          abortTimeoutMs,
        );
      }
      if (session) {
        await attemptBoundedCleanup(
          cleanupErrors,
          "Copilot child session deletion",
          () => client!.deleteSession(session!.sessionId),
          cleanupTimeoutMs,
        );
      }
      if (client) {
        await attemptBoundedCleanup(
          cleanupErrors,
          "Copilot client stop",
          () => client!.stop(),
          cleanupTimeoutMs,
        );
      }
      await attemptBoundedCleanup(
        cleanupErrors,
        "Copilot skill capsule cleanup",
        () => capsule.cleanup(),
        cleanupTimeoutMs,
      );
      if (session) {
        const cleanupError = cleanupErrors.length === 0
          ? undefined
          : cleanupErrors.length === 1 ? cleanupErrors[0] : new AggregateError(cleanupErrors, "Copilot child cleanup failed");
        emitHarborEvidence(this.evidenceHook, {
          ...evidenceBase,
          phase: "child.cleaned",
          outcome: cleanupError === undefined ? "ok" : "error",
          childId: session.sessionId,
          ...(cleanupError === undefined ? {} : { error: fingerprintHarborEvidence(String(cleanupError)) }),
        });
      }
      if (failed && cleanupErrors.length) {
        throw new AggregateError([failure, ...cleanupErrors], `Copilot child execution and cleanup failed: ${failure instanceof Error ? failure.message : String(failure)}`);
      }
      if (!failed && cleanupErrors.length) throw cleanupErrors.length === 1 ? cleanupErrors[0] : new AggregateError(cleanupErrors, "Copilot child cleanup failed");
    }
    if (failed) throw failure;
    return output;
  }
}
