/** OpenCode child-session orchestration for named agents and contracts. */
import type { PluginInput } from "@opencode-ai/plugin";
import type { ContractDefinition, GithubResolver, Orchestrator } from "../core/types.js";
import { GhResolver } from "../core/github.js";
import { trustedSkills } from "../core/defaults.js";
import {
  emitHarborEvidence,
  fingerprintHarborEvidence,
  HarborEvidenceAccumulator,
  maximumHarborEvidenceBytes,
  type BoundedHarborEvidence,
  type HarborEvidenceHook,
} from "../core/evidence.js";
import { composeContractPrompt, openCodeToolPolicy } from "../core/profiles.js";
import { loadConfiguredSkills, withLoadedSkillGuidance } from "../core/skills.js";
import { prepareSignedOpenCodeHarborTitle, type OpenCodeHarborInvocation } from "../core/opencode-session-claims.js";
import { isHarborId } from "../core/identity.js";
import {
  hasOpenCodeCleanupHazard,
  openCodeCleanupHazardRecovery,
  recordOpenCodeCleanupHazard,
} from "../core/opencode-cleanup-hazards.js";
import { defaultHome } from "../adapters/shared.js";

type LegacyClient = PluginInput["client"];
type PromptBody = NonNullable<Parameters<LegacyClient["session"]["prompt"]>[0]["body"]> & {
  readonly variant?: string;
};
type CreateRequest = NonNullable<Parameters<LegacyClient["session"]["create"]>[0]>;
type DeleteRequest = Parameters<LegacyClient["session"]["delete"]>[0];
type UpdateRequest = Parameters<LegacyClient["session"]["update"]>[0];
type PromptRequest = Omit<Parameters<LegacyClient["session"]["prompt"]>[0], "body"> & {
  readonly body: PromptBody;
};

/**
 * The deliberately small client surface required by disposable OpenCode
 * children. Keeping this structural lets the server use the legacy plugin SDK
 * while the TUI supplies an explicit v2 bridge; neither side can silently
 * pretend that the two incompatible request shapes are interchangeable.
 */
export interface OpenCodeOrchestratorClient {
  readonly session: {
    create(input: CreateRequest): Promise<{ readonly data?: { readonly id?: unknown } }>;
    delete(input: DeleteRequest): Promise<{ readonly data?: unknown }>;
    update(input: UpdateRequest): Promise<{
      readonly data?: { readonly id?: unknown; readonly title?: unknown };
    }>;
    prompt(input: PromptRequest): Promise<{
      readonly data?: { readonly info?: unknown; readonly parts?: unknown };
    }>;
  };
}

export interface OpenCodeContractTelemetry {
  readonly model?: OpenCodeModel;
  readonly input?: number;
  readonly output?: number;
  readonly reasoning?: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
  readonly total?: number;
  readonly totalSource?: "native" | "observed-components";
  readonly totalLowerBound?: true;
  readonly totalConflict?: true;
  readonly cost?: number;
}

export interface OpenCodeObservedContractResult {
  readonly text: string;
  readonly telemetry: OpenCodeContractTelemetry;
}
const openCodeCleanupTimeoutMs = 1_000;
const maximumPendingOpenCodeCreateReconciliations = 32;
// One timed-out provenance operation can require one concurrent compensating
// delete. Bound both while admitting no new child once the first 32 host
// operations are unreconciled.
const maximumPendingOpenCodeCleanupReconciliations = 64;
const maximumOpenCodeResponseParts = 256;
const maximumOpenCodeSessionIDCodeUnits = 512;
const maximumOpenCodeSessionIDBytes = 2_048;
const maximumSafeCleanupIDCodeUnits = 4_096;
const maximumSafeCleanupIDBytes = 16_384;
let pendingOpenCodeCreateReconciliations = 0;
let pendingOpenCodeCleanupReconciliations = 0;
let activeOpenCodeChildLifecycles = 0;

function requireBoundedTask(task: string): void {
  if (typeof task !== "string" || task.length > 30_000 || Buffer.byteLength(task, "utf8") > 30_000 || !task.trim()) {
    throw new Error("OpenCode task must be non-empty and at most 30000 UTF-8 bytes");
  }
}

function validModelIdentity(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 200
    && value === value.trim() && !/[\p{Cc}\p{Cf}]/u.test(value);
}

function validOpenCodeSessionID(value: unknown): value is string {
  return typeof value === "string" && value.length > 0
    && value.length <= maximumOpenCodeSessionIDCodeUnits
    && Buffer.byteLength(value, "utf8") <= maximumOpenCodeSessionIDBytes;
}

function telemetryRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function telemetryToken(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function telemetryCost(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER
    ? value
    : undefined;
}

function addTelemetryToken(left: number, right: number): { readonly value: number; readonly bounded: boolean } {
  return left > Number.MAX_SAFE_INTEGER - right
    ? { value: Number.MAX_SAFE_INTEGER, bounded: true }
    : { value: left + right, bounded: false };
}

function observeContractTelemetry(value: unknown): OpenCodeContractTelemetry {
  const info = telemetryRecord(value);
  if (!info || info.role !== "assistant") return {};
  const providerID = validModelIdentity(info.providerID) ? info.providerID : undefined;
  const modelID = validModelIdentity(info.modelID) ? info.modelID : undefined;
  const variant = validModelIdentity(info.variant) ? info.variant : undefined;
  const source = telemetryRecord(info.tokens);
  const cache = telemetryRecord(source?.cache);
  const input = telemetryToken(source?.input);
  const output = telemetryToken(source?.output);
  const reasoning = telemetryToken(source?.reasoning);
  const cacheRead = telemetryToken(cache?.read ?? source?.cacheRead);
  const cacheWrite = telemetryToken(cache?.write ?? source?.cacheWrite);
  const nativeTotal = telemetryToken(source?.total);
  const components = [input, output, reasoning, cacheRead, cacheWrite];
  let componentTotal = 0;
  let componentCount = 0;
  let componentBounded = false;
  for (const component of components) {
    if (component === undefined) continue;
    componentCount += 1;
    const next = addTelemetryToken(componentTotal, component);
    componentTotal = next.value;
    componentBounded ||= next.bounded;
  }
  let totalConflict = false;
  if (nativeTotal !== undefined) {
    let minimum = 0;
    for (const component of [input, output, cacheRead, cacheWrite]) {
      if (component === undefined) continue;
      minimum = addTelemetryToken(minimum, component).value;
    }
    totalConflict = nativeTotal < minimum;
    if (!totalConflict && [input, output, cacheRead, cacheWrite].every((component) => component !== undefined)
      && reasoning !== undefined) {
      totalConflict = nativeTotal > addTelemetryToken(minimum, reasoning).value;
    }
  }
  const total = nativeTotal ?? (componentCount ? componentTotal : undefined);
  return {
    ...(providerID && modelID ? { model: { providerID, modelID, ...(variant ? { variant } : {}) } } : {}),
    ...(input === undefined ? {} : { input }),
    ...(output === undefined ? {} : { output }),
    ...(reasoning === undefined ? {} : { reasoning }),
    ...(cacheRead === undefined ? {} : { cacheRead }),
    ...(cacheWrite === undefined ? {} : { cacheWrite }),
    ...(total === undefined ? {} : { total }),
    ...(nativeTotal !== undefined
      ? { totalSource: "native" as const }
      : componentCount ? { totalSource: "observed-components" as const } : {}),
    ...(nativeTotal === undefined && componentCount > 0 && (componentCount < components.length || componentBounded)
      ? { totalLowerBound: true as const }
      : {}),
    ...(totalConflict ? { totalConflict: true as const } : {}),
    ...(telemetryCost(info.cost) === undefined ? {} : { cost: telemetryCost(info.cost) }),
  };
}

function safeOpenCodeCleanupID(value: unknown): value is string {
  return typeof value === "string" && value.length > 0
    && value.length <= maximumSafeCleanupIDCodeUnits
    && Buffer.byteLength(value, "utf8") <= maximumSafeCleanupIDBytes;
}

/** Collects an SDK response without materializing or scanning an unbounded joined string. */
function collectOpenCodeResponseEvidence(parts: unknown): BoundedHarborEvidence {
  if (!Array.isArray(parts)) throw new Error("OpenCode child response did not contain a parts array");
  const evidence = new HarborEvidenceAccumulator();
  const inspectedParts = Math.min(parts.length, maximumOpenCodeResponseParts);
  let observedTextParts = 0;
  for (let index = 0; index < inspectedParts; index += 1) {
    const part = parts[index] as { readonly type?: unknown; readonly text?: unknown } | null;
    if (!part || part.type !== "text" || typeof part.text !== "string") continue;
    if (observedTextParts > 0) evidence.append("\n");
    observedTextParts += 1;
    // Bound both retained memory and byte-count work. A very large individual
    // string is sampled far enough to prove truncation, then marked incomplete.
    if (part.text.length > maximumHarborEvidenceBytes + 1) {
      evidence.append(part.text.slice(0, maximumHarborEvidenceBytes + 1));
      evidence.markIncomplete();
    } else {
      evidence.append(part.text);
    }
  }
  if (parts.length > inspectedParts) evidence.markIncomplete(parts.length - inspectedParts);
  const result = evidence.result();
  if (observedTextParts === 0 || result.utf8Bytes === 0) {
    throw new Error("OpenCode child response contained no bounded text evidence");
  }
  return result;
}

async function boundedOpenCodeCleanup<T>(
  label: string,
  invoke: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  parentSignal?: AbortSignal,
): Promise<T> {
  if (pendingOpenCodeCleanupReconciliations >= maximumPendingOpenCodeCleanupReconciliations) {
    throw new Error("OpenCode cleanup reconciliation limit reached; reload after host RPC recovers");
  }
  pendingOpenCodeCleanupReconciliations += 1;
  let operation: Promise<T>;
  try { operation = invoke(boundedSignal(parentSignal, timeoutMs)); }
  catch (error) {
    pendingOpenCodeCleanupReconciliations -= 1;
    throw error;
  }
  const observed = operation.finally(() => { pendingOpenCodeCleanupReconciliations -= 1; });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      observed,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function boundedSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function boundedOpenCodeCreate<T>(
  invoke: () => Promise<T>,
  lateCleanup: (value: T) => Promise<void>,
  timeoutMs: number,
): Promise<T> {
  if (pendingOpenCodeCreateReconciliations + pendingOpenCodeCleanupReconciliations
    >= maximumPendingOpenCodeCreateReconciliations) {
    throw new Error("OpenCode child creation reconciliation limit reached; reload after host RPC recovers");
  }
  pendingOpenCodeCreateReconciliations += 1;
  let promise: Promise<T>;
  try { promise = invoke(); }
  catch (error) {
    pendingOpenCodeCreateReconciliations -= 1;
    throw error;
  }
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const observed = promise.then(async (value) => {
    if (timedOut) await lateCleanup(value).catch(() => undefined);
    return value;
  }).finally(() => { pendingOpenCodeCreateReconciliations -= 1; });
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new Error(`OpenCode child creation timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try { return await Promise.race([observed, timeout]); }
  finally { if (timer) clearTimeout(timer); }
}

interface ChildLifecycle {
  readonly evidenceBase: {
    readonly harness: "opencode";
    readonly agent: string;
    readonly runtimeAgent: string;
    readonly parentSessionId?: string | undefined;
  };
  readonly titleInvocation: OpenCodeHarborInvocation;
  readonly titleAgent: string;
  readonly task: string;
  readonly buildPromptBody: () => PromptBody;
  readonly signal?: AbortSignal;
  readonly lifecyclePhaseHook?: (phase: OpenCodeChildLifecyclePhase, childSessionID?: string) => void;
}

/** Explicit OpenCode model identity inherited from the originating user turn. */
export interface OpenCodeModel {
  readonly providerID: string;
  readonly modelID: string;
  readonly variant?: string;
}

export type OpenCodeChildLifecyclePhase = "starting" | "working" | "cleaning";

function configuredContractModel(value: string | undefined): OpenCodeModel | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > 401 || Buffer.byteLength(value, "utf8") > 801) {
    throw new Error("configured OpenCode contract model must use bounded provider/model syntax");
  }
  const separator = value.indexOf("/");
  const providerID = separator < 0 ? "" : value.slice(0, separator);
  const modelID = separator < 0 ? "" : value.slice(separator + 1);
  if (!validModelIdentity(providerID) || !validModelIdentity(modelID)) {
    throw new Error("configured OpenCode contract model must use bounded provider/model syntax");
  }
  return { providerID, modelID };
}

/** Executes each OpenCode delegation or contract in one disposable session. */
export class OpenCodeOrchestrator implements Orchestrator {
  readonly harness = "opencode" as const;
  constructor(
    private readonly client: OpenCodeOrchestratorClient,
    private readonly directory: string,
    private readonly github: GithubResolver = new GhResolver(),
    private readonly evidenceHook?: HarborEvidenceHook,
    private readonly cleanupTimeoutMs = openCodeCleanupTimeoutMs,
    private readonly claimHome = defaultHome("opencode"),
    private readonly lifecyclePhaseHook?: (phase: OpenCodeChildLifecyclePhase, childSessionID?: string) => void,
  ) {}

  /** Runs an exact named OpenCode agent using an explicit inherited model. */
  async runAgent(
    agent: string,
    task: string,
    parentID: string | undefined,
    model: OpenCodeModel,
    signal?: AbortSignal,
    lifecyclePhaseHook?: (phase: OpenCodeChildLifecyclePhase, childSessionID?: string) => void,
  ): Promise<string> {
    signal?.throwIfAborted();
    if (!isHarborId(agent)) throw new Error("OpenCode agent id is invalid");
    requireBoundedTask(task);
    if (parentID !== undefined && (!parentID || parentID.length > 512)) throw new Error("OpenCode parent session id is invalid");
    if (!validModelIdentity(model?.providerID) || !validModelIdentity(model?.modelID)
      || model.variant !== undefined && !validModelIdentity(model.variant)) {
      throw new Error("OpenCode agent requires a bounded explicit model identity");
    }
    return (await this.runChildLifecycle({
      evidenceBase: { harness: this.harness, agent, runtimeAgent: agent, parentSessionId: parentID },
      titleInvocation: "agent",
      titleAgent: agent,
      task,
      buildPromptBody: () => ({
        agent,
        model: { providerID: model.providerID, modelID: model.modelID },
        ...(model.variant === undefined ? {} : { variant: model.variant }),
        parts: [{ type: "text", text: task }],
      }),
      signal,
      lifecyclePhaseHook: lifecyclePhaseHook ?? this.lifecyclePhaseHook,
    })).text;
  }

  /** Runs one portable contract using a closed OpenCode tool policy. */
  async run(definition: ContractDefinition, signal?: AbortSignal): Promise<string> {
    return (await this.runObserved(definition, signal)).text;
  }

  /** Retains bounded native prompt telemetry before the disposable child is deleted. */
  async runObserved(definition: ContractDefinition, signal?: AbortSignal): Promise<OpenCodeObservedContractResult> {
    signal?.throwIfAborted();
    requireBoundedTask(definition.task);
    const configuredModel = configuredContractModel(definition.model);
    const loaded = await loadConfiguredSkills(definition, this.directory, this.github, trustedSkills, signal);
    definition = withLoadedSkillGuidance(definition, loaded);
    signal?.throwIfAborted();
    const agent = definition.tools.some((tool) => tool === "edit" || tool === "execute") ? "general" : "explore";
    return this.runChildLifecycle({
      evidenceBase: { harness: this.harness, agent: definition.name, runtimeAgent: agent },
      titleInvocation: "contract",
      titleAgent: definition.name,
      task: definition.task,
      buildPromptBody: () => ({
        agent,
        tools: openCodeToolPolicy(definition.tools),
        ...(configuredModel ? { model: {
          providerID: configuredModel.providerID,
          modelID: configuredModel.modelID,
        } } : {}),
        parts: [{ type: "text", text: composeContractPrompt(definition) }],
      }),
      signal,
      lifecyclePhaseHook: this.lifecyclePhaseHook,
    });
  }

  /** Owns the complete create/prompt/evidence/cleanup lifecycle for one disposable child. */
  private async runChildLifecycle(input: ChildLifecycle): Promise<OpenCodeObservedContractResult> {
    if (hasOpenCodeCleanupHazard(this.directory)) {
      throw new Error(`OpenCode ${openCodeCleanupHazardRecovery}`);
    }
    if (activeOpenCodeChildLifecycles + pendingOpenCodeCleanupReconciliations
      >= maximumPendingOpenCodeCreateReconciliations) {
      throw new Error("OpenCode disposable child capacity reached; wait for active work or host cleanup to finish");
    }
    activeOpenCodeChildLifecycles += 1;
    try { return await this.runReservedChildLifecycle(input); }
    finally { activeOpenCodeChildLifecycles -= 1; }
  }

  /** Gives orphan-prevention cleanup one bounded retry before blocking the project. */
  private async deleteUnclaimedChild(id: string, label: string): Promise<void> {
    const errors: unknown[] = [];
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const removed = await boundedOpenCodeCleanup(
          `${label} (attempt ${attempt}/2)`,
          (cleanupSignal) => this.client.session.delete({
            path: { id }, query: { directory: this.directory }, signal: cleanupSignal, throwOnError: true,
          }),
          this.cleanupTimeoutMs,
        );
        if (removed.data !== true) throw new Error("OpenCode SDK did not confirm deletion");
        return;
      } catch (error) {
        errors.push(error);
      }
    }
    throw new AggregateError(errors, `${label} failed after two bounded attempts`);
  }

  /** Reconciles malformed create replies conservatively before any provenance or prompt RPC. */
  private async rejectMalformedCreatedChildID(value: unknown, label: string): Promise<never> {
    const invalid = new Error("OpenCode SDK returned an invalid bounded child session ID");
    if (!safeOpenCodeCleanupID(value)) {
      recordOpenCodeCleanupHazard(this.directory);
      throw invalid;
    }
    try {
      await this.deleteUnclaimedChild(value, label);
    } catch (cleanupError) {
      recordOpenCodeCleanupHazard(this.directory);
      throw new AggregateError([invalid, cleanupError], `${label} could not reconcile the malformed child ID`);
    }
    throw invalid;
  }

  private async runReservedChildLifecycle({
    evidenceBase,
    titleInvocation,
    titleAgent,
    task,
    buildPromptBody,
    signal,
    lifecyclePhaseHook,
  }: ChildLifecycle): Promise<OpenCodeObservedContractResult> {
    lifecyclePhaseHook?.("starting");
    emitHarborEvidence(this.evidenceHook, {
      ...evidenceBase,
      phase: "target.resolved",
      outcome: "ok",
      task: fingerprintHarborEvidence(task),
    });
    let id: string;
    try {
      const signTitle = await prepareSignedOpenCodeHarborTitle(
        this.claimHome,
        this.directory,
        titleInvocation,
        titleAgent,
      );
      signal?.throwIfAborted();
      const created = await boundedOpenCodeCreate(
        () => this.client.session.create({
          // OpenAI Codex OAuth rejects the `metadata` OpenCode derives from parented sessions.
          // The synchronous tool call and evidence hook already provide exact correlation.
          body: { title: "Agent Harbor child · provenance pending" },
          query: { directory: this.directory },
          signal: boundedSignal(signal, this.cleanupTimeoutMs),
          throwOnError: true,
        }),
        async (late) => {
          const lateID = late.data?.id;
          if (!validOpenCodeSessionID(lateID)) {
            await this.rejectMalformedCreatedChildID(lateID, "OpenCode malformed late-created child cleanup");
            throw new Error("OpenCode malformed late-created child reconciliation returned unexpectedly");
          }
          let cleanupError: unknown;
          try {
            await this.deleteUnclaimedChild(lateID, "OpenCode late-created child cleanup");
          } catch (error) { cleanupError = error; }
          emitHarborEvidence(this.evidenceHook, {
            ...evidenceBase,
            phase: "child.cleaned",
            outcome: cleanupError === undefined ? "ok" : "error",
            childId: lateID,
            ...(cleanupError === undefined ? {} : { error: fingerprintHarborEvidence(String(cleanupError)) }),
          });
          if (cleanupError !== undefined) {
            recordOpenCodeCleanupHazard(this.directory);
            throw cleanupError;
          }
        },
        this.cleanupTimeoutMs,
      );
      const createdID: unknown = created.data?.id;
      if (!validOpenCodeSessionID(createdID)) {
        await this.rejectMalformedCreatedChildID(createdID, "OpenCode malformed-ID child cleanup");
      }
      id = createdID as string;
      const title = signTitle(id);
      try {
        const updated = await boundedOpenCodeCleanup(
          "OpenCode child provenance",
          (cleanupSignal) => this.client.session.update({
            path: { id }, query: { directory: this.directory },
            signal: cleanupSignal, throwOnError: true,
            body: { title },
          }),
          this.cleanupTimeoutMs,
          signal,
        );
        if (updated.data?.id !== id || updated.data.title !== title) {
          throw new Error("OpenCode SDK did not confirm signed child provenance");
        }
      } catch (updateError) {
        let cleanupError: unknown;
        try {
          await this.deleteUnclaimedChild(id, "OpenCode unclaimed child cleanup");
        } catch (error) { cleanupError = error; }
        if (cleanupError !== undefined) {
          recordOpenCodeCleanupHazard(this.directory);
          throw new AggregateError([updateError, cleanupError], "OpenCode child provenance and cleanup failed");
        }
        throw updateError;
      }
    } catch (error) {
      emitHarborEvidence(this.evidenceHook, {
        ...evidenceBase,
        phase: "child.failed",
        outcome: "error",
        error: fingerprintHarborEvidence(String(error)),
      });
      throw error;
    }
    let failed = false;
    let failure: unknown;
    let lifecycleCleanupFailure: unknown;
    let output = "";
    let telemetry: OpenCodeContractTelemetry = {};
    try {
      // Publish and read back the exact disposable child identity before any
      // prompt or working state. The initial starting claim remains tied only
      // to its owner session and can never authorize interrupting that parent.
      lifecyclePhaseHook?.("working", id);
      emitHarborEvidence(this.evidenceHook, { ...evidenceBase, phase: "child.started", outcome: "ok", childId: id });
      emitHarborEvidence(this.evidenceHook, { ...evidenceBase, phase: "prompt.attempted", outcome: "ok", childId: id });
      const result = await this.client.session.prompt({
        path: { id }, query: { directory: this.directory }, signal, throwOnError: true,
        body: buildPromptBody(),
      });
      output = collectOpenCodeResponseEvidence(result.data?.parts).text;
      telemetry = observeContractTelemetry(result.data?.info);
      if (!output.trim()) throw new Error(`OpenCode child ${evidenceBase.agent} returned empty evidence`);
      emitHarborEvidence(this.evidenceHook, {
        ...evidenceBase,
        phase: "evidence.returned",
        outcome: "ok",
        childId: id,
        evidence: fingerprintHarborEvidence(output),
      });
      emitHarborEvidence(this.evidenceHook, { ...evidenceBase, phase: "child.completed", outcome: "ok", childId: id });
    } catch (error) {
      failed = true;
      failure = error;
      emitHarborEvidence(this.evidenceHook, {
        ...evidenceBase,
        phase: "child.failed",
        outcome: "error",
        childId: id,
        error: fingerprintHarborEvidence(String(error)),
      });
    } finally {
      // Deleting the child is part of correctness, not best-effort telemetry;
      // execution and cleanup failures are therefore reported together.
      try { lifecyclePhaseHook?.("cleaning", id); }
      catch (error) { lifecycleCleanupFailure = error; }
      let cleanupError: unknown;
      try {
        await this.deleteUnclaimedChild(id, "OpenCode child cleanup");
      } catch (error) {
        cleanupError = error;
      }
      emitHarborEvidence(this.evidenceHook, {
        ...evidenceBase,
        phase: "child.cleaned",
        outcome: cleanupError === undefined ? "ok" : "error",
        childId: id,
        ...(cleanupError === undefined ? {} : { error: fingerprintHarborEvidence(String(cleanupError)) }),
      });
      if (cleanupError !== undefined) {
        recordOpenCodeCleanupHazard(this.directory);
        if (failed || lifecycleCleanupFailure !== undefined) {
          throw new AggregateError(
            [failure, lifecycleCleanupFailure, cleanupError].filter((value) => value !== undefined),
            `OpenCode child execution and cleanup failed: ${failure instanceof Error ? failure.message : String(failure)}`,
          );
        }
        throw cleanupError;
      }
    }
    if (lifecycleCleanupFailure !== undefined) {
      if (failed) throw new AggregateError([failure, lifecycleCleanupFailure], "OpenCode child execution and lifecycle publication failed");
      throw lifecycleCleanupFailure;
    }
    if (failed) throw failure;
    return { text: output, telemetry };
  }
}
