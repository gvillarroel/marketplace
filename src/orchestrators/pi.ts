/** Pi in-memory child orchestration with a fail-closed skill registry. */
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { ContractDefinition, GithubResolver, Orchestrator } from "../core/types.js";
import { GhResolver } from "../core/github.js";
import { trustedSkills } from "../core/defaults.js";
import { emitHarborEvidence, fingerprintHarborEvidence, type HarborEvidenceHook } from "../core/evidence.js";
import type { PiRunObserver, PiTeamRunState } from "../core/pi-observability.js";
import { composeContractPrompt, nativeTools } from "../core/profiles.js";
import { createSkillCapsule, type MaterializedConfiguredSkill, type SkillCapsule } from "../core/skills.js";

type PiSdk = typeof import("@earendil-works/pi-coding-agent");
type PiModel = import("@earendil-works/pi-coding-agent").Model;
type PiToolDefinition = import("@earendil-works/pi-coding-agent").ToolDefinition;
type PiSession = Awaited<ReturnType<PiSdk["createAgentSession"]>>["session"];
type PiThinkingLevel = import("@earendil-works/pi-coding-agent").ThinkingLevel;
type PiSkill = import("@earendil-works/pi-coding-agent").Skill;
type PiSkillLoadResult = import("@earendil-works/pi-coding-agent").SkillLoadResult;

/** Optional host model and reasoning settings inherited by a Pi child. */
export interface PiSessionOptions {
  readonly model?: PiModel;
  readonly thinkingLevel?: PiThinkingLevel;
}

function pathKey(path: string): string {
  const absolute = resolve(path);
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

function latestAssistantText(messages: readonly unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || typeof message !== "object" || (message as any).role !== "assistant") continue;
    const content = (message as any).content;
    if (!Array.isArray(content)) continue;
    const text = content
      .filter((part: any) => part?.type === "text" && typeof part.text === "string")
      .map((part: any) => part.text)
      .join("");
    if (text.trim()) return text;
  }
  return "";
}

function emptyEvidenceDiagnostic(messages: readonly unknown[]): string {
  const assistants = messages.filter((message: any) => message?.role === "assistant");
  const last = assistants.at(-1) as any;
  const contentTypes = Array.isArray(last?.content)
    ? last.content.map((part: any) => typeof part?.type === "string" ? part.type : "unknown")
    : [];
  return JSON.stringify({
    messages: messages.length,
    assistants: assistants.length,
    stopReason: typeof last?.stopReason === "string" ? last.stopReason : undefined,
    error: typeof last?.errorMessage === "string" ? last.errorMessage.slice(0, 500) : undefined,
    contentTypes,
  });
}

function assertIsolatedSkills(
  result: PiSkillLoadResult,
  expectedSkills: readonly MaterializedConfiguredSkill[],
): PiSkill[] {
  // Pi's loader remains the parser of record, but every discovered name and
  // physical file must exactly match the invocation capsule allowlist.
  if (result.diagnostics.length) {
    const details = result.diagnostics.map((diagnostic) =>
      `${diagnostic.type}: ${diagnostic.message}${diagnostic.path ? ` (${diagnostic.path})` : ""}`,
    ).join("; ");
    throw new Error(`Pi rejected the isolated skill capsule diagnostics: ${details}`);
  }
  const expectedByName = new Map(expectedSkills.map((skill) => [skill.reference.name, pathKey(skill.filePath)]));
  if (expectedByName.size !== expectedSkills.length) throw new Error("Pi isolated skill capsule contains duplicate names");
  if (result.skills.length !== expectedByName.size) {
    throw new Error(`Pi isolated skill allowlist mismatch: expected ${expectedByName.size}, discovered ${result.skills.length}`);
  }
  const seen = new Set<string>();
  const isolated = result.skills.map((skill) => {
    const expectedPath = expectedByName.get(skill.name);
    if (expectedPath === undefined || pathKey(skill.filePath) !== expectedPath || seen.has(skill.name)) {
      throw new Error(`Pi discovered a skill outside the configured allowlist: ${skill.name}`);
    }
    seen.add(skill.name);
    return { ...skill, disableModelInvocation: false };
  });
  if (seen.size !== expectedByName.size) throw new Error("Pi did not discover every configured skill");
  return isolated;
}

async function cleanupCapsuleAfterPreparationFailure(capsule: SkillCapsule, failure: unknown): Promise<never> {
  try { await capsule.cleanup(); }
  catch (cleanupError) {
    throw new AggregateError([failure, cleanupError], `Pi child preparation and skill capsule cleanup failed: ${failure instanceof Error ? failure.message : String(failure)}`);
  }
  throw failure;
}

function isCancellation(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true || (error instanceof Error && error.name === "AbortError");
}

function observe(observer: PiRunObserver | undefined, action: (observer: PiRunObserver) => void): void {
  if (!observer) return;
  try { action(observer); } catch { /* Telemetry must never alter child execution. */ }
}

/** Executes each contract in one isolated, in-memory Pi SDK session. */
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
    private readonly runObserver?: PiRunObserver,
  ) {}
  /**
   * Loads only the invocation capsule, creates one child, captures text
   * evidence, and disposes every session/capsule resource on all exit paths.
   */
  async run(definition: ContractDefinition, signal?: AbortSignal): Promise<string> {
    let capsule: SkillCapsule;
    try {
      signal?.throwIfAborted();
      capsule = await createSkillCapsule(definition, this.directory, this.github, trustedSkills, signal);
    } catch (error) {
      observe(this.runObserver, (observer) => observer.state(isCancellation(error, signal) ? "cancelled" : "failed"));
      throw error;
    }
    const evidenceBase = { harness: this.harness, agent: definition.name, runtimeAgent: definition.name } as const;
    emitHarborEvidence(this.evidenceHook, {
      ...evidenceBase,
      phase: "target.resolved",
      outcome: "ok",
      task: fingerprintHarborEvidence(definition.task),
    });
    let session: PiSession;
    try {
      signal?.throwIfAborted();
      const sdk = await this.loadSdk();
      signal?.throwIfAborted();
      const skillPaths = capsule.skills.map((skill) => skill.filePath);
      const resourceLoader = new sdk.DefaultResourceLoader({
        cwd: this.directory,
        agentDir: sdk.getAgentDir(),
        additionalSkillPaths: skillPaths,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        skillsOverride: (base) => ({
          skills: assertIsolatedSkills(base, capsule.skills),
          diagnostics: [],
        }),
      });
      await resourceLoader.reload();
      signal?.throwIfAborted();
      assertIsolatedSkills(resourceLoader.getSkills(), capsule.skills);
      const created = await sdk.createAgentSession({
        cwd: this.directory,
        sessionManager: sdk.SessionManager.inMemory(this.directory),
        tools: [...new Set([...nativeTools("pi", definition.tools), ...this.additionalTools, ...this.customTools.map((tool) => tool.name)])],
        customTools: [...this.customTools],
        ...(this.sessionOptions.model === undefined ? {} : { model: this.sessionOptions.model }),
        ...(this.sessionOptions.thinkingLevel === undefined ? {} : { thinkingLevel: this.sessionOptions.thinkingLevel }),
        resourceLoader,
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
      observe(this.runObserver, (observer) => observer.state("cleaning"));
      try { return await cleanupCapsuleAfterPreparationFailure(capsule, error); }
      catch (finalError) {
        const cleanupFailed = finalError instanceof AggregateError && finalError.message.startsWith("Pi child preparation and skill capsule cleanup failed:");
        observe(this.runObserver, (observer) => observer.state(cleanupFailed ? "cleanup-error" : isCancellation(error, signal) ? "cancelled" : "failed"));
        throw finalError;
      }
    }
    const sessionIdentity = session as unknown as { sessionId?: unknown };
    const childId = typeof sessionIdentity.sessionId === "string"
      ? sessionIdentity.sessionId
      : this.evidenceHook ? `pi-hook:${randomUUID()}` : undefined;
    const effectiveSessionModel = session.model ?? this.sessionOptions.model;
    const effectiveThinking = session.thinkingLevel ?? this.sessionOptions.thinkingLevel;
    observe(this.runObserver, (observer) => observer.sessionStarted({
      ...(childId === undefined ? {} : { sessionId: childId }),
      ...(effectiveSessionModel === undefined ? {} : {
        model: { provider: effectiveSessionModel.provider, id: effectiveSessionModel.id },
      }),
      ...(effectiveThinking === undefined ? {} : { thinking: effectiveThinking }),
    }));
    emitHarborEvidence(this.evidenceHook, { ...evidenceBase, phase: "child.started", outcome: "ok", childId });
    let output = "";
    let unsubscribe: (() => void) | undefined;
    let abortPromise: Promise<void> | undefined;
    let failed = false;
    let failure: unknown;
    let executionState: Extract<PiTeamRunState, "completed" | "failed" | "cancelled"> = "completed";
    const abort = () => { abortPromise ??= session.abort(); };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      unsubscribe = session.subscribe((event: any) => {
        if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") output += event.assistantMessageEvent.delta;
        if (event.type === "message_end" && event.message?.role === "assistant") {
          observe(this.runObserver, (observer) => observer.messageEnd(event.message));
        }
      });
      if (signal?.aborted) await session.abort();
      signal?.throwIfAborted();
      emitHarborEvidence(this.evidenceHook, { ...evidenceBase, phase: "prompt.attempted", outcome: "ok", childId });
      await session.prompt(composeContractPrompt(definition, this.additionalTools));
      signal?.throwIfAborted();
      // A few providers settle the transcript without emitting a complete
      // message_end stream. Observe the authoritative transcript as a fallback;
      // PiTeamRuntime deduplicates messages already seen through subscribe().
      for (const message of Array.isArray(session.messages) ? session.messages : []) {
        if (message?.role === "assistant") observe(this.runObserver, (observer) => observer.messageEnd(message));
      }
      // Some Pi providers deliver the completed assistant message without
      // emitting text_delta updates. The settled in-memory transcript is the
      // authoritative fallback and remains inside this disposable child.
      const settledEvidence = latestAssistantText(Array.isArray(session.messages) ? session.messages : []);
      if (settledEvidence.trim()) output = settledEvidence;
      if (!output.trim()) throw new Error(`Pi child ${definition.name} returned empty evidence: ${emptyEvidenceDiagnostic(session.messages)}`);
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
      executionState = isCancellation(error, signal) ? "cancelled" : "failed";
      emitHarborEvidence(this.evidenceHook, {
        ...evidenceBase,
        phase: "child.failed",
        outcome: "error",
        childId,
        error: fingerprintHarborEvidence(String(error)),
      });
    } finally {
      // Preserve all cleanup failures, and combine them with a prompt failure
      // when both occur so callers never receive a misleading single cause.
      // Failure and cancellation paths may still have settled native telemetry
      // even when the provider omitted message_end; capture it before dispose.
      for (const message of Array.isArray(session.messages) ? session.messages : []) {
        if (message?.role === "assistant") observe(this.runObserver, (observer) => observer.messageEnd(message));
      }
      observe(this.runObserver, (observer) => observer.state("cleaning"));
      const cleanupErrors: unknown[] = [];
      signal?.removeEventListener("abort", abort);
      if (abortPromise) {
        try { await abortPromise; } catch (error) { cleanupErrors.push(error); }
      }
      try { unsubscribe?.(); } catch (error) { cleanupErrors.push(error); }
      try { session.dispose(); } catch (error) { cleanupErrors.push(error); }
      try { await capsule.cleanup(); } catch (error) { cleanupErrors.push(error); }
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
      observe(this.runObserver, (observer) => observer.state(cleanupError === undefined ? executionState : "cleanup-error"));
      if (failed && cleanupErrors.length) {
        throw new AggregateError([failure, ...cleanupErrors], `Pi child execution and cleanup failed: ${failure instanceof Error ? failure.message : String(failure)}`);
      }
      if (!failed && cleanupErrors.length) throw cleanupErrors.length === 1 ? cleanupErrors[0] : new AggregateError(cleanupErrors, "Pi child cleanup failed");
    }
    if (failed) throw failure;
    return output;
  }
}
