/** One-child Copilot SDK orchestration with isolated skills and full cleanup. */
import { CopilotClient, approveAll } from "@github/copilot-sdk";
import type { CopilotSession } from "@github/copilot-sdk";
import type { ContractDefinition, GithubResolver, Orchestrator } from "../core/types.js";
import { GhResolver } from "../core/github.js";
import { trustedSkills } from "../core/defaults.js";
import { emitHarborEvidence, fingerprintHarborEvidence, type HarborEvidenceHook } from "../core/evidence.js";
import { composePlayerInstructions, nativeTools } from "../core/profiles.js";
import { createSkillCapsule } from "../core/skills.js";

/** Executes invocation-scoped contracts through the Copilot SDK. */
export class CopilotOrchestrator implements Orchestrator {
  readonly harness = "copilot" as const;
  constructor(
    private readonly createClient: () => CopilotClient = () => new CopilotClient(),
    private readonly directory = process.cwd(),
    private readonly github: GithubResolver = new GhResolver(),
    private readonly evidenceHook?: HarborEvidenceHook,
  ) {}
  /**
   * Creates exactly one custom-agent session, returns its non-empty evidence,
   * and always deletes the session, stops the client, and removes its capsule.
   */
  async run(definition: ContractDefinition, signal?: AbortSignal): Promise<string> {
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
    let abort: (() => void) | undefined;
    let abortPromise: Promise<void> | undefined;
    let failed = false;
    let failure: unknown;
    let output = "";
    try {
      signal?.throwIfAborted();
      client = this.createClient();
      session = await client.createSession({
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
      });
      emitHarborEvidence(this.evidenceHook, {
        ...evidenceBase,
        phase: "child.started",
        outcome: "ok",
        childId: session.sessionId,
      });
      abort = () => { abortPromise ??= session?.abort(); };
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) await session.abort();
      signal?.throwIfAborted();
      emitHarborEvidence(this.evidenceHook, {
        ...evidenceBase,
        phase: "prompt.attempted",
        outcome: "ok",
        childId: session.sessionId,
      });
      const response = await session.sendAndWait({ prompt: definition.task });
      signal?.throwIfAborted();
      output = response?.data.content ?? "";
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
      if (abortPromise) {
        try { await abortPromise; } catch (error) { cleanupErrors.push(error); }
      }
      if (session) {
        try { await client!.deleteSession(session.sessionId); } catch (error) { cleanupErrors.push(error); }
      }
      if (client) {
        try { await client.stop(); } catch (error) { cleanupErrors.push(error); }
      }
      try { await capsule.cleanup(); } catch (error) { cleanupErrors.push(error); }
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
