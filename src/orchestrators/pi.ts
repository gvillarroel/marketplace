import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { ContractDefinition, GithubResolver, Orchestrator } from "../core/types.js";
import { GhResolver } from "../core/github.js";
import { trustedSkills } from "../core/defaults.js";
import { emitHarborEvidence, fingerprintHarborEvidence, type HarborEvidenceHook } from "../core/evidence.js";
import { composeContractPrompt, nativeTools } from "../core/profiles.js";
import { createSkillCapsule, type MaterializedConfiguredSkill, type SkillCapsule } from "../core/skills.js";

type PiSdk = typeof import("@earendil-works/pi-coding-agent");
type PiModel = import("@earendil-works/pi-coding-agent").Model;
type PiToolDefinition = import("@earendil-works/pi-coding-agent").ToolDefinition;
type PiSession = Awaited<ReturnType<PiSdk["createAgentSession"]>>["session"];
type PiThinkingLevel = import("@earendil-works/pi-coding-agent").ThinkingLevel;
type PiSkill = import("@earendil-works/pi-coding-agent").Skill;
type PiSkillLoadResult = import("@earendil-works/pi-coding-agent").SkillLoadResult;

export interface PiSessionOptions {
  readonly model?: PiModel;
  readonly thinkingLevel?: PiThinkingLevel;
}

function pathKey(path: string): string {
  const absolute = resolve(path);
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

function assertIsolatedSkills(
  result: PiSkillLoadResult,
  expectedSkills: readonly MaterializedConfiguredSkill[],
): PiSkill[] {
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
    const capsule = await createSkillCapsule(definition, this.directory, this.github, trustedSkills, signal);
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
      return await cleanupCapsuleAfterPreparationFailure(capsule, error);
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
      if (failed && cleanupErrors.length) {
        throw new AggregateError([failure, ...cleanupErrors], `Pi child execution and cleanup failed: ${failure instanceof Error ? failure.message : String(failure)}`);
      }
      if (!failed && cleanupErrors.length) throw cleanupErrors.length === 1 ? cleanupErrors[0] : new AggregateError(cleanupErrors, "Pi child cleanup failed");
    }
    if (failed) throw failure;
    return output;
  }
}
