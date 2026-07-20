import { randomUUID } from "node:crypto";
import type { ContractDefinition, GithubResolver, Orchestrator } from "../core/types.js";
import { GhResolver, materializeGithubSkills } from "../core/github.js";
import { trustedSkills } from "../core/defaults.js";
import { emitHarborEvidence, fingerprintHarborEvidence, type HarborEvidenceHook } from "../core/evidence.js";
import { composeContractPrompt, nativeTools } from "../core/profiles.js";

type PiSdk = typeof import("@earendil-works/pi-coding-agent");
type PiModel = import("@earendil-works/pi-coding-agent").Model;
type PiToolDefinition = import("@earendil-works/pi-coding-agent").ToolDefinition;
type PiSession = Awaited<ReturnType<PiSdk["createAgentSession"]>>["session"];
type PiThinkingLevel = import("@earendil-works/pi-coding-agent").ThinkingLevel;

export interface PiSessionOptions {
  readonly model?: PiModel;
  readonly thinkingLevel?: PiThinkingLevel;
}

export class PiOrchestrator implements Orchestrator {
  readonly harness = "pi" as const;
  constructor(
    private readonly directory = process.cwd(),
    private readonly loadSdk: () => Promise<PiSdk> = () => import("@earendil-works/pi-coding-agent"),
    private readonly additionalTools: readonly string[] = [],
    private readonly github: GithubResolver = new GhResolver(),
    private readonly customTools: readonly PiToolDefinition[] = [],
    private readonly evidenceHook?: HarborEvidenceHook,
    private readonly sessionOptions: PiSessionOptions = {},
  ) {}
  async run(definition: ContractDefinition, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    definition = await materializeGithubSkills(definition, this.github, trustedSkills, signal);
    signal?.throwIfAborted();
    const evidenceBase = { harness: this.harness, agent: definition.name, runtimeAgent: definition.name } as const;
    emitHarborEvidence(this.evidenceHook, {
      ...evidenceBase,
      phase: "target.resolved",
      outcome: "ok",
      task: fingerprintHarborEvidence(definition.task),
    });
    let session: PiSession;
    try {
      const sdk = await this.loadSdk();
      const resourceLoader = sdk.DefaultResourceLoader && sdk.getAgentDir
        ? new sdk.DefaultResourceLoader({
            cwd: this.directory,
            agentDir: sdk.getAgentDir(),
            noExtensions: true,
            noSkills: true,
            noPromptTemplates: true,
            noThemes: true,
            noContextFiles: true,
          })
        : undefined;
      await resourceLoader?.reload();
      const created = await sdk.createAgentSession({
        cwd: this.directory,
        sessionManager: sdk.SessionManager.inMemory(this.directory),
        tools: [...new Set([...nativeTools("pi", definition.tools), ...this.additionalTools, ...this.customTools.map((tool) => tool.name)])],
        customTools: [...this.customTools],
        ...(this.sessionOptions.model === undefined ? {} : { model: this.sessionOptions.model }),
        ...(this.sessionOptions.thinkingLevel === undefined ? {} : { thinkingLevel: this.sessionOptions.thinkingLevel }),
        ...(resourceLoader ? { resourceLoader } : {}),
      });
      if (!created?.session) throw new Error("Pi SDK did not create a child session");
      session = created.session;
    } catch (error) {
      emitHarborEvidence(this.evidenceHook, {
        ...evidenceBase,
        phase: "child.failed",
        outcome: "error",
        error: fingerprintHarborEvidence(String(error)),
      });
      throw error;
    }
    const sessionIdentity = session as unknown as { sessionId?: unknown };
    const childId = typeof sessionIdentity.sessionId === "string"
      ? sessionIdentity.sessionId
      : this.evidenceHook ? `pi-hook:${randomUUID()}` : undefined;
    emitHarborEvidence(this.evidenceHook, { ...evidenceBase, phase: "child.started", outcome: "ok", childId });
    let output = "";
    let unsubscribe: (() => void) | undefined;
    let abortPromise: Promise<void> | undefined;
    let failed = false;
    let failure: unknown;
    const abort = () => { abortPromise ??= session.abort(); };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      unsubscribe = session.subscribe((event: any) => {
        if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") output += event.assistantMessageEvent.delta;
      });
      if (signal?.aborted) await session.abort();
      signal?.throwIfAborted();
      emitHarborEvidence(this.evidenceHook, { ...evidenceBase, phase: "prompt.attempted", outcome: "ok", childId });
      await session.prompt(composeContractPrompt(definition, this.additionalTools));
      signal?.throwIfAborted();
      if (!output.trim()) throw new Error(`Pi child ${definition.name} returned empty evidence`);
      emitHarborEvidence(this.evidenceHook, {
        ...evidenceBase,
        phase: "evidence.returned",
        outcome: "ok",
        childId,
        evidence: fingerprintHarborEvidence(output),
      });
      emitHarborEvidence(this.evidenceHook, { ...evidenceBase, phase: "child.completed", outcome: "ok", childId });
    } catch (error) {
      failed = true;
      failure = error;
      emitHarborEvidence(this.evidenceHook, {
        ...evidenceBase,
        phase: "child.failed",
        outcome: "error",
        childId,
        error: fingerprintHarborEvidence(String(error)),
      });
    } finally {
      const cleanupErrors: unknown[] = [];
      signal?.removeEventListener("abort", abort);
      if (abortPromise) {
        try { await abortPromise; } catch (error) { cleanupErrors.push(error); }
      }
      try { unsubscribe?.(); } catch (error) { cleanupErrors.push(error); }
      try { session.dispose(); } catch (error) { cleanupErrors.push(error); }
      const cleanupError = cleanupErrors.length === 0
        ? undefined
        : cleanupErrors.length === 1 ? cleanupErrors[0] : new AggregateError(cleanupErrors, "Pi child cleanup failed");
      emitHarborEvidence(this.evidenceHook, {
        ...evidenceBase,
        phase: "child.cleaned",
        outcome: cleanupError === undefined ? "ok" : "error",
        childId,
        ...(cleanupError === undefined ? {} : { error: fingerprintHarborEvidence(String(cleanupError)) }),
      });
      if (failed && cleanupErrors.length) {
        throw new AggregateError([failure, ...cleanupErrors], `Pi child execution and cleanup failed: ${failure instanceof Error ? failure.message : String(failure)}`);
      }
      if (!failed && cleanupErrors.length) throw cleanupErrors.length === 1 ? cleanupErrors[0] : new AggregateError(cleanupErrors, "Pi child cleanup failed");
    }
    if (failed) throw failure;
    return output;
  }
}
