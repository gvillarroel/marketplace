/** Process-local, zero-model observability for Agent Harbor runs hosted by Copilot. */
import { createHmac, randomBytes } from "node:crypto";
import { basename, resolve } from "node:path";
import { publicMetadataText, publicTaskLabel } from "../core/public-metadata.js";
import { wrapPlainLines } from "../core/text-layout.js";

export const maximumConcurrentCopilotRoots = 32;
export const maximumCopilotUsageIdentityKeys = 4_096;

export type CopilotTeamRunState =
  | "starting"
  | "working"
  | "waiting"
  | "cleaning"
  | "completed"
  | "failed"
  | "cancelled"
  | "cleanup-error";

export type CopilotTeamMemberKind = "manager" | "fixed" | "bundled" | "personal" | "contractor" | "utility";

export interface CopilotNativeTokenUsage {
  readonly input?: number;
  readonly output?: number;
  readonly reasoning?: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
  readonly total?: number;
}

export type CopilotNativeUsageField = keyof CopilotNativeTokenUsage;

export interface CopilotNativeBillingUsage {
  /** Sum of Copilot's per-request model-multiplier cost values; not USD. */
  readonly modelMultiplier?: number;
  /** Sum of Copilot's native nano-AI-unit values. */
  readonly totalNanoAiu?: number;
}

export type CopilotNativeBillingField = keyof CopilotNativeBillingUsage;

export interface CopilotTeamRunSnapshot {
  readonly id: string;
  readonly sequence: number;
  readonly rootRunId: string;
  readonly parentRunId?: string;
  readonly agent: string;
  readonly kind: CopilotTeamMemberKind;
  readonly task: string;
  readonly state: CopilotTeamRunState;
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly elapsedMs: number;
  readonly model?: string;
  readonly modelSource?: "configured" | "inherited" | "observed";
  readonly observedModels: readonly string[];
  readonly observedModelsTruncated: boolean;
  readonly reasoningEffort?: string;
  readonly reasoningSource?: "inherited" | "observed";
  readonly observedReasoningEfforts: readonly string[];
  readonly observedReasoningEffortsTruncated: boolean;
  readonly usage: CopilotNativeTokenUsage;
  readonly usageLowerBounds: readonly CopilotNativeUsageField[];
  readonly billing: CopilotNativeBillingUsage;
  readonly billingLowerBounds: readonly CopilotNativeBillingField[];
  /** The authoritative terminal total contradicted the per-call token sum. */
  readonly usageAggregateConflict: boolean;
  readonly usageIdentityTruncated: boolean;
  readonly usageIdentityAmbiguous: boolean;
  readonly usageAttributionUnverified: boolean;
  readonly nativeCalls?: number;
  readonly durationMs?: number;
  readonly totalToolCalls?: number;
}

export interface CopilotRunStart {
  readonly project: string;
  readonly agent: string;
  readonly kind: CopilotTeamMemberKind;
  readonly task: string;
  readonly parentRunId?: string;
  readonly model?: string;
  readonly modelSource?: "configured" | "inherited";
  readonly reasoningEffort?: string;
}

export interface CopilotUsageEvent {
  readonly id?: string;
  readonly timestamp?: string;
  readonly type: "assistant.usage";
  readonly agentId?: string;
  readonly data: {
    readonly apiCallId?: string;
    readonly serviceRequestId?: string;
    readonly providerCallId?: string;
    readonly model?: string;
    readonly reasoningEffort?: string;
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly reasoningTokens?: number;
    readonly cacheReadTokens?: number;
    readonly cacheWriteTokens?: number;
    /** Copilot's model-multiplier cost for this request; not USD. */
    readonly cost?: number;
    readonly copilotUsage?: { readonly totalNanoAiu?: number };
  };
}

export interface CopilotRunObserver {
  event(event: CopilotUsageEvent): boolean;
  state(state: CopilotTeamRunState): void;
}

interface MutableRun {
  id: string;
  sequence: number;
  rootRunId: string;
  parentRunId?: string;
  project: string;
  agent: string;
  kind: CopilotTeamMemberKind;
  task: string;
  state: CopilotTeamRunState;
  startedAt: number;
  endedAt?: number;
  model?: string;
  modelSource?: "configured" | "inherited" | "observed";
  observedModels: Map<string, string>;
  observedModelsTruncated: boolean;
  reasoningEffort?: string;
  reasoningSource?: "inherited" | "observed";
  observedReasoningEfforts: Map<string, string>;
  observedReasoningEffortsTruncated: boolean;
  usage: Partial<Record<CopilotNativeUsageField, number>>;
  usageLowerBounds: Set<CopilotNativeUsageField>;
  billing: Partial<Record<CopilotNativeBillingField, number>>;
  billingLowerBounds: Set<CopilotNativeBillingField>;
  usageAggregateConflict: boolean;
  usageIdentityTruncated: boolean;
  usageIdentityAmbiguous: boolean;
  usageAttributionUnverified: boolean;
  nativeCalls: number;
  durationMs?: number;
  totalToolCalls?: number;
  seenUsageKeys: Set<string>;
  agentKeys: Set<string>;
}

const usageFields: readonly CopilotNativeUsageField[] = ["input", "output", "reasoning", "cacheRead", "cacheWrite", "total"];
const billingFields: readonly CopilotNativeBillingField[] = ["modelMultiplier", "totalNanoAiu"];
const activeStates = new Set<CopilotTeamRunState>(["starting", "working", "waiting", "cleaning"]);
const childAdmissionStates = new Set<CopilotTeamRunState>(["starting", "working", "waiting"]);
const terminalStates = new Set<CopilotTeamRunState>(["completed", "failed", "cancelled", "cleanup-error"]);

function nativeFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function nativeInteger(value: unknown): number | undefined {
  return nativeFiniteNumber(value) !== undefined && Number.isSafeInteger(value) ? value as number : undefined;
}

function addSafeInteger(left: number, right: number): { value: number; overflow: boolean } {
  if (left > Number.MAX_SAFE_INTEGER - right) {
    return { value: Number.MAX_SAFE_INTEGER, overflow: true };
  }
  return { value: left + right, overflow: false };
}

function addFiniteNumber(left: number, right: number): { value: number; overflow: boolean } {
  const value = left + right;
  return Number.isFinite(value)
    ? { value, overflow: false }
    : { value: Number.MAX_VALUE, overflow: true };
}

function sumSafeIntegers(values: readonly number[]): { value: number | undefined; overflow: boolean } {
  if (!values.length) return { value: undefined, overflow: false };
  let value = 0;
  let overflow = false;
  for (const amount of values) {
    const next = addSafeInteger(value, amount);
    value = next.value;
    overflow ||= next.overflow;
  }
  return { value, overflow };
}

function sumFiniteNumbers(values: readonly number[]): { value: number | undefined; overflow: boolean } {
  if (!values.length) return { value: undefined, overflow: false };
  let value = 0;
  let overflow = false;
  for (const amount of values) {
    const next = addFiniteNumber(value, amount);
    value = next.value;
    overflow ||= next.overflow;
  }
  return { value, overflow };
}

function projectKey(project: string): string {
  const absolute = resolve(project);
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

/** Strips terminal controls and bounds host-provided public identifiers. */
export function copilotPublicIdentifier(value: unknown, limit = 120): string | undefined {
  return typeof value === "string" ? publicMetadataText(value, limit) : undefined;
}

/** Produces a deliberately lossy label without retaining paths, URLs, or likely secrets. */
export function copilotTaskLabel(task: string): string {
  return publicTaskLabel(task);
}

const maximumPrivateIdentityCodeUnits = 4_096;
const maximumPrivateEncodingDepth = 8;
const maximumPrivateEncodingEntries = 32;

function boundedOpaqueIdentity(value: unknown): string | undefined {
  if (typeof value !== "string" || !value || value.length > maximumPrivateIdentityCodeUnits) return undefined;
  return Buffer.byteLength(value, "utf8") <= maximumPrivateIdentityCodeUnits * 4 ? value : undefined;
}

function privateEncoding(value: unknown, depth = 0, seen = new Map<object, number>()): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") {
    const bounded = value.slice(0, maximumPrivateIdentityCodeUnits);
    return `s${value.length}:${JSON.stringify(bounded)}`;
  }
  if (typeof value === "number") return `n:${Object.is(value, -0) ? "-0" : String(value)}`;
  if (typeof value === "bigint") return `i:${value.toString().slice(0, maximumPrivateIdentityCodeUnits)}`;
  if (typeof value === "boolean") return value ? "b:1" : "b:0";
  if (typeof value === "symbol") return "symbol";
  if (typeof value === "function") return "function";
  if (depth >= maximumPrivateEncodingDepth) return "bounded-depth";
  const reference = seen.get(value);
  if (reference !== undefined) return `ref:${reference}`;
  seen.set(value, seen.size);
  if (Array.isArray(value)) {
    const entries = value.slice(0, maximumPrivateEncodingEntries)
      .map((entry) => privateEncoding(entry, depth + 1, seen));
    return `a${value.length}:[${entries.join(",")}]`;
  }
  const entries: string[] = [];
  try {
    for (const name in value) {
      if (!Object.hasOwn(value, name)) continue;
      if (entries.length === maximumPrivateEncodingEntries) break;
      let field: unknown;
      try { field = (value as Record<string, unknown>)[name]; }
      catch { field = "unreadable"; }
      entries.push(`${JSON.stringify(name.slice(0, 256))}:${privateEncoding(field, depth + 1, seen)}`);
    }
  } catch {
    return "unreadable-object";
  }
  entries.sort();
  return `o:{${entries.join(",")}}`;
}

function privateKey(value: unknown, key: Uint8Array): string {
  const digest = createHmac("sha256", key);
  digest.update(privateEncoding(value), "utf8");
  return digest.digest("base64url");
}

function cloneUsage(run: MutableRun): CopilotNativeTokenUsage {
  return Object.fromEntries(usageFields.flatMap((field) => {
    const value = run.usage[field];
    return value === undefined ? [] : [[field, value]];
  })) as CopilotNativeTokenUsage;
}

function cloneBilling(run: MutableRun): CopilotNativeBillingUsage {
  return Object.fromEntries(billingFields.flatMap((key) => {
    const value = run.billing[key];
    return value === undefined ? [] : [[key, value]];
  })) as CopilotNativeBillingUsage;
}

/** In-memory registry; it never persists model content or asks a model to summarize activity. */
export class CopilotTeamRuntime {
  private readonly runs = new Map<string, MutableRun>();
  private readonly listeners = new Set<(runId: string) => void>();
  private readonly agentRuns = new Map<string, string>();
  private readonly fingerprintKey = randomBytes(32);
  private sequence = 0;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly maxRootRuns = maximumConcurrentCopilotRoots,
  ) {}

  assertRootStartAllowed(project: string, agent: string, kind: CopilotTeamMemberKind): void {
    const safeAgent = copilotPublicIdentifier(agent, 120) ?? "unknown-agent";
    const roots = this.activeProjectRuns(project).filter((run) => run.parentRunId === undefined);
    if (roots.length >= this.maxRootRuns) {
      throw new Error(`Agent Harbor allows at most ${this.maxRootRuns} concurrent root runs per project`);
    }
    if (kind === "contractor") return;
    const busy = this.activeProjectRuns(project).find((run) => run.kind !== "contractor" && run.agent === safeAgent);
    if (busy) throw new Error(`${safeAgent} is already working in ${busy.rootRunId}`);
  }

  assertChildStartAllowed(
    project: string,
    agent: string,
    parentRunId: string,
    kind: CopilotTeamMemberKind = "personal",
  ): void {
    const parent = this.runs.get(parentRunId);
    if (!parent) throw new Error("unknown parent team run");
    if (parent.project !== projectKey(project)) throw new Error("child team run must use its parent's project");
    if (!childAdmissionStates.has(parent.state)) throw new Error(`parent team run is not accepting children: ${parentRunId}`);
    if (kind === "contractor") return;
    const safeAgent = copilotPublicIdentifier(agent, 120) ?? "unknown-agent";
    const busy = this.activeProjectRuns(project).find((run) =>
      run.kind !== "contractor" && run.agent === safeAgent);
    if (busy) throw new Error(`${safeAgent} is already working in ${busy.rootRunId}`);
  }

  assertStartAllowed(input: CopilotRunStart): void {
    if (input.parentRunId === undefined) this.assertRootStartAllowed(input.project, input.agent, input.kind);
    else this.assertChildStartAllowed(input.project, input.agent, input.parentRunId, input.kind);
  }

  begin(input: CopilotRunStart): string {
    const parent = input.parentRunId === undefined ? undefined : this.runs.get(input.parentRunId);
    if (input.parentRunId !== undefined && !parent) throw new Error("unknown parent team run");
    if (parent && parent.project !== projectKey(input.project)) throw new Error("child team run must use its parent's project");
    this.assertStartAllowed(input);
    const sequence = ++this.sequence;
    const id = `copilot-run-${sequence}`;
    const model = copilotPublicIdentifier(input.model, 200);
    const effort = copilotPublicIdentifier(input.reasoningEffort, 80);
    const run: MutableRun = {
      id,
      sequence,
      rootRunId: parent?.rootRunId ?? id,
      ...(parent ? { parentRunId: parent.id } : {}),
      project: projectKey(input.project),
      agent: copilotPublicIdentifier(input.agent, 120) ?? "unknown-agent",
      kind: input.kind,
      task: copilotTaskLabel(input.task),
      state: "starting",
      startedAt: this.now(),
      ...(model ? { model, modelSource: input.modelSource ?? "inherited" as const } : {}),
      observedModels: new Map(),
      observedModelsTruncated: false,
      ...(effort ? { reasoningEffort: effort, reasoningSource: "inherited" as const } : {}),
      observedReasoningEfforts: new Map(),
      observedReasoningEffortsTruncated: false,
      usage: {},
      usageLowerBounds: new Set(),
      billing: {},
      billingLowerBounds: new Set(),
      usageAggregateConflict: false,
      usageIdentityTruncated: false,
      usageIdentityAmbiguous: false,
      usageAttributionUnverified: false,
      nativeCalls: 0,
      seenUsageKeys: new Set(),
      agentKeys: new Set(),
    };
    this.runs.set(id, run);
    this.prune();
    this.emit(id);
    return id;
  }

  observer(runId: string): CopilotRunObserver {
    return {
      event: (event) => this.observeUsageEvent(event, runId),
      state: (state) => this.setState(runId, state),
    };
  }

  attachChild(runId: string, input: { agentId?: string; model?: string }): void {
    const run = this.require(runId);
    if (input.agentId) {
      const agentId = boundedOpaqueIdentity(input.agentId);
      if (!agentId) {
        run.usageAttributionUnverified = true;
      } else {
        const key = privateKey(agentId, this.fingerprintKey);
        const existingId = this.agentRuns.get(key);
        const existing = existingId === undefined ? undefined : this.runs.get(existingId);
        if (existing && existing.id !== runId && !terminalStates.has(existing.state)) {
          this.agentRuns.delete(key);
          existing.agentKeys.delete(key);
          existing.usageAttributionUnverified = true;
          run.usageAttributionUnverified = true;
          this.emit(existing.id);
        } else {
          this.agentRuns.set(key, runId);
          run.agentKeys.add(key);
        }
      }
    }
    this.observeModel(run, input.model);
    this.setState(runId, "working");
  }

  /** Reclassifies one still-active root when an exact user-invoked wrapper is observed after prompt submission. */
  relabelActiveRoot(
    runId: string,
    input: { agent: string; kind: Exclude<CopilotTeamMemberKind, "contractor">; task: string },
  ): void {
    const run = this.require(runId);
    if (run.parentRunId !== undefined || !childAdmissionStates.has(run.state)) {
      throw new Error("only a root accepting work can be relabeled");
    }
    run.agent = copilotPublicIdentifier(input.agent, 120) ?? "unknown-agent";
    run.kind = input.kind;
    run.task = copilotTaskLabel(input.task);
    this.emit(runId);
  }

  observeRootModel(runId: string, model?: string, reasoningEffort?: string): void {
    const run = this.require(runId);
    const nextModel = copilotPublicIdentifier(model, 200);
    if (nextModel && run.model && run.model !== nextModel) this.rememberObservedModel(run, run.model);
    const nextEffort = copilotPublicIdentifier(reasoningEffort, 80);
    if (nextEffort && run.reasoningEffort && run.reasoningEffort !== nextEffort) {
      this.rememberObservedEffort(run, run.reasoningEffort);
    }
    this.observeModel(run, model);
    this.observeEffort(run, reasoningEffort);
    this.emit(runId);
  }

  observeUsageEvent(event: CopilotUsageEvent, rootRunId?: string): boolean {
    let runId = rootRunId;
    try {
    if (!event || typeof event !== "object") return false;
    if ((event as CopilotUsageEvent).type !== "assistant.usage") return false;
    const data = (event as CopilotUsageEvent).data;
    if (!data || typeof data !== "object" || Array.isArray(data)) return false;
    const rawAgentId = (event as CopilotUsageEvent).agentId;
    const agentId = rawAgentId === undefined ? undefined : boundedOpaqueIdentity(rawAgentId);
    if (rawAgentId !== undefined && !agentId) {
      if (rootRunId) this.markUsageAttributionUnverified(rootRunId);
      return false;
    }
    runId = agentId
      ? this.agentRuns.get(privateKey(agentId, this.fingerprintKey))
      : rootRunId;
    if (!runId) return false;
    const run = this.runs.get(runId);
    if (!run) return false;
    if (terminalStates.has(run.state)) return false;
    if (run.usageAggregateConflict) return false;
    // A replay may arrive under a new event ID and with richer request IDs
    // than its first observation. Treat every available namespaced identity
    // as an alias, reject when any alias is known, then remember all aliases.
    // Only HMACs enter runtime state; opaque host identifiers are never kept.
    const identities: unknown[] = [
      boundedOpaqueIdentity(data.apiCallId) === undefined ? undefined : ["api", boundedOpaqueIdentity(data.apiCallId)],
      boundedOpaqueIdentity(data.serviceRequestId) === undefined ? undefined : ["service", boundedOpaqueIdentity(data.serviceRequestId)],
      boundedOpaqueIdentity(data.providerCallId) === undefined ? undefined : ["provider", boundedOpaqueIdentity(data.providerCallId)],
      boundedOpaqueIdentity(event.id) === undefined ? undefined : ["event", boundedOpaqueIdentity(event.id)],
    ].filter((value) => value !== undefined);
    const usesFallbackIdentity = identities.length === 0;
    if (usesFallbackIdentity) {
      identities.push(["fallback", {
        timestamp: event.timestamp,
        agent: agentId ? privateKey(agentId, this.fingerprintKey) : "root",
        model: data.model,
        input: data.inputTokens,
        output: data.outputTokens,
        reasoning: data.reasoningTokens,
        cacheRead: data.cacheReadTokens,
        cacheWrite: data.cacheWriteTokens,
        modelMultiplier: data.cost,
        totalNanoAiu: data.copilotUsage?.totalNanoAiu,
      }]);
      // Without any host/provider call identity, equal payloads cannot be
      // distinguished from replays. Keep deduplication deterministic but make
      // both the call count and every token counter an explicit lower bound.
      run.usageIdentityAmbiguous = true;
      for (const field of usageFields) run.usageLowerBounds.add(field);
      for (const field of billingFields) run.billingLowerBounds.add(field);
    }
    const keys = identities.map((identity) => privateKey(identity, this.fingerprintKey));
    const replay = keys.some((key) => run.seenUsageKeys.has(key));
    const unseenKeys = [...new Set(keys)].filter((key) => !run.seenUsageKeys.has(key));
    if (run.usageIdentityTruncated ||
        run.seenUsageKeys.size + unseenKeys.length > maximumCopilotUsageIdentityKeys) {
      if (!run.usageIdentityTruncated) {
        run.usageIdentityTruncated = true;
        for (const field of usageFields) run.usageLowerBounds.add(field);
        for (const field of billingFields) run.billingLowerBounds.add(field);
        this.emit(runId);
      }
      return false;
    }
    for (const key of unseenKeys) run.seenUsageKeys.add(key);
    if (replay) {
      if (usesFallbackIdentity) this.emit(runId);
      return false;
    }
    this.observeModel(run, data.model);
    this.observeEffort(run, data.reasoningEffort);
    const input = nativeInteger(data.inputTokens);
    const output = nativeInteger(data.outputTokens);
    const incomingTotal = input === undefined && output === undefined
      ? { value: undefined, overflow: false }
      : sumSafeIntegers([input ?? 0, output ?? 0]);
    const incoming: Record<CopilotNativeUsageField, number | undefined> = {
      input,
      output,
      reasoning: nativeInteger(data.reasoningTokens),
      cacheRead: nativeInteger(data.cacheReadTokens),
      cacheWrite: nativeInteger(data.cacheWriteTokens),
      total: incomingTotal.value,
    };
    for (const field of usageFields) {
      const amount = incoming[field];
      if (amount === undefined) run.usageLowerBounds.add(field);
      else {
        const next = addSafeInteger(run.usage[field] ?? 0, amount);
        run.usage[field] = next.value;
        if (next.overflow) run.usageLowerBounds.add(field);
      }
    }
    const incomingBilling: Record<CopilotNativeBillingField, number | undefined> = {
      modelMultiplier: nativeFiniteNumber(data.cost),
      totalNanoAiu: nativeInteger(data.copilotUsage?.totalNanoAiu),
    };
    for (const field of billingFields) {
      const amount = incomingBilling[field];
      if (amount === undefined) run.billingLowerBounds.add(field);
      else {
        const next = field === "modelMultiplier"
          ? addFiniteNumber(run.billing[field] ?? 0, amount)
          : addSafeInteger(run.billing[field] ?? 0, amount);
        run.billing[field] = next.value;
        if (next.overflow) run.billingLowerBounds.add(field);
      }
    }
    if (input === undefined || output === undefined || incomingTotal.overflow) run.usageLowerBounds.add("total");
    run.nativeCalls += 1;
    if (run.state === "starting") run.state = "working";
    this.emit(runId);
    return true;
    } catch {
      if (runId) this.markUsageAttributionUnverified(runId);
      return false;
    }
  }

  markUsageAttributionUnverified(runId: string): void {
    const run = this.runs.get(runId);
    if (!run || terminalStates.has(run.state) || run.usageAttributionUnverified) return;
    // Deliberately do not increment nativeCalls, add counters, or synthesize a
    // lower bound: the ambiguous host payload may belong to another root.
    run.usageAttributionUnverified = true;
    this.emit(runId);
  }

  childTerminal(
    runId: string,
    outcome: "completed" | "failed",
    summary: { model?: string; durationMs?: number; totalTokens?: number; totalToolCalls?: number } = {},
  ): void {
    const run = this.require(runId);
    this.observeModel(run, summary.model);
    const duration = nativeFiniteNumber(summary.durationMs);
    const tools = nativeInteger(summary.totalToolCalls);
    const total = nativeInteger(summary.totalTokens);
    if (duration !== undefined) run.durationMs = duration;
    if (tools !== undefined) run.totalToolCalls = tools;
    if (summary.totalTokens !== undefined && total === undefined) run.usageLowerBounds.add("total");
    if (total !== undefined) {
      const observed = run.usage.total;
      if (observed === undefined || total >= observed) {
        // A larger terminal aggregate proves at least one native contribution
        // was not present in the per-call stream. Keep the aggregate exact,
        // but render every observed component as a lower bound rather than an
        // internally inconsistent exact breakdown.
        if (observed === undefined || total > observed) {
          for (const field of usageFields) {
            if (field !== "total" && run.usage[field] !== undefined) run.usageLowerBounds.add(field);
          }
        }
        run.usage.total = total;
        run.usageLowerBounds.delete("total");
      } else {
        // The terminal aggregate is authoritative. A smaller value proves the
        // per-call breakdown cannot be combined under one token definition, so
        // retain the exact total and omit the incompatible component values.
        run.usage.total = total;
        run.usageLowerBounds.delete("total");
        run.usageAggregateConflict = true;
        for (const field of usageFields) {
          if (field === "total") continue;
          delete run.usage[field];
          run.usageLowerBounds.delete(field);
        }
      }
    }
    run.state = "cleaning";
    (run as MutableRun & { terminalOutcome?: "completed" | "failed" }).terminalOutcome = outcome;
    this.emit(runId);
  }

  finishChild(runId: string, fallback: "completed" | "failed"): void {
    const run = this.require(runId) as MutableRun & { terminalOutcome?: "completed" | "failed" };
    this.setState(runId, run.terminalOutcome ?? fallback);
  }

  setState(runId: string, state: CopilotTeamRunState): void {
    const run = this.require(runId);
    if (terminalStates.has(run.state) && state !== "cleanup-error") return;
    if (run.state === "cleanup-error") return;
    // Once cancellation or child teardown starts, late host activity/idle
    // events must not make the run appear delegable again. Only another
    // cleaning signal or a terminal outcome may advance this state.
    if (run.state === "cleaning" && (state === "starting" || state === "working" || state === "waiting")) return;
    run.state = state;
    if (terminalStates.has(state)) run.endedAt = this.now();
    if (terminalStates.has(state)) this.releaseAgentKeys(run);
    this.emit(runId);
    if (terminalStates.has(state)) this.prune();
  }

  finishIfOpen(runId: string, outcome: "completed" | "failed" | "cancelled"): void {
    const run = this.require(runId);
    if (!terminalStates.has(run.state)) this.setState(runId, outcome);
  }

  finish(runId: string, outcome: "completed" | "failed" | "cancelled"): void {
    this.finishIfOpen(runId, outcome);
  }

  subscribe(listener: (runId: string) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  get(runId: string): CopilotTeamRunSnapshot | undefined {
    const run = this.runs.get(runId);
    return run ? this.snapshot(run) : undefined;
  }

  mission(rootRunId: string): CopilotTeamRunSnapshot[] {
    return [...this.runs.values()]
      .filter((run) => run.rootRunId === rootRunId)
      .sort((left, right) => left.sequence - right.sequence)
      .map((run) => this.snapshot(run));
  }

  projectRuns(project: string): CopilotTeamRunSnapshot[] {
    const key = projectKey(project);
    return [...this.runs.values()]
      .filter((run) => run.project === key)
      .sort((left, right) => right.sequence - left.sequence)
      .map((run) => this.snapshot(run));
  }

  list(project: string): CopilotTeamRunSnapshot[] {
    return this.projectRuns(project);
  }

  activeProjectRuns(project: string): CopilotTeamRunSnapshot[] {
    return this.projectRuns(project).filter((run) => activeStates.has(run.state));
  }

  activeRoot(project: string, agent: string): CopilotTeamRunSnapshot | undefined {
    return this.activeProjectRuns(project).find((run) => run.parentRunId === undefined && run.agent === agent);
  }

  latestRoot(project: string): CopilotTeamRunSnapshot | undefined {
    return this.projectRuns(project).find((run) => run.parentRunId === undefined);
  }

  missionUsage(rootRunId: string): CopilotNativeTokenUsage {
    const runs = this.mission(rootRunId);
    return Object.fromEntries(usageFields.flatMap((field) => {
      const known = runs.flatMap((run) => run.usage[field] === undefined ? [] : [run.usage[field]!]);
      const aggregate = sumSafeIntegers(known);
      return aggregate.value === undefined ? [] : [[field, aggregate.value]];
    })) as CopilotNativeTokenUsage;
  }

  missionUsageLowerBounds(rootRunId: string): CopilotNativeUsageField[] {
    const runs = this.mission(rootRunId);
    const usage = this.missionUsage(rootRunId);
    return usageFields.filter((field) => {
      if (usage[field] === undefined) return false;
      const known = runs.flatMap((run) => run.usage[field] === undefined ? [] : [run.usage[field]!]);
      return sumSafeIntegers(known).overflow || runs.some((run) =>
        run.usage[field] === undefined || run.usageLowerBounds.includes(field));
    });
  }

  missionBilling(rootRunId: string): CopilotNativeBillingUsage {
    const runs = this.mission(rootRunId);
    return Object.fromEntries(billingFields.flatMap((field) => {
      const known = runs.flatMap((run) => run.billing[field] === undefined ? [] : [run.billing[field]!]);
      const aggregate = field === "modelMultiplier" ? sumFiniteNumbers(known) : sumSafeIntegers(known);
      return aggregate.value === undefined ? [] : [[field, aggregate.value]];
    })) as CopilotNativeBillingUsage;
  }

  missionBillingLowerBounds(rootRunId: string): CopilotNativeBillingField[] {
    const runs = this.mission(rootRunId);
    const billing = this.missionBilling(rootRunId);
    return billingFields.filter((field) => {
      if (billing[field] === undefined) return false;
      const known = runs.flatMap((run) => run.billing[field] === undefined ? [] : [run.billing[field]!]);
      const overflow = (field === "modelMultiplier" ? sumFiniteNumbers(known) : sumSafeIntegers(known)).overflow;
      return overflow || runs.some((run) =>
        run.billing[field] === undefined || run.billingLowerBounds.includes(field));
    });
  }

  missionUsageAggregateConflict(rootRunId: string): boolean {
    return this.mission(rootRunId).some((run) => run.usageAggregateConflict);
  }

  missionUsageAttributionUnverified(rootRunId: string): boolean {
    return this.mission(rootRunId).some((run) => run.usageAttributionUnverified);
  }

  projectName(project: string): string {
    return basename(resolve(project)) || "project";
  }

  private observeModel(run: MutableRun, value: unknown): void {
    const model = copilotPublicIdentifier(value, 200);
    if (!model) return;
    run.model = model;
    run.modelSource = "observed";
    this.rememberObservedModel(run, model);
  }

  private rememberObservedModel(run: MutableRun, model: string): void {
    const key = privateKey(model, this.fingerprintKey);
    if (!run.observedModels.has(key)) {
      if (run.observedModels.size < 8) run.observedModels.set(key, model);
      else run.observedModelsTruncated = true;
    }
  }

  private observeEffort(run: MutableRun, value: unknown): void {
    const effort = copilotPublicIdentifier(value, 80);
    if (!effort) return;
    run.reasoningEffort = effort;
    run.reasoningSource = "observed";
    this.rememberObservedEffort(run, effort);
  }

  private rememberObservedEffort(run: MutableRun, effort: string): void {
    const key = privateKey(effort, this.fingerprintKey);
    if (!run.observedReasoningEfforts.has(key)) {
      if (run.observedReasoningEfforts.size < 8) run.observedReasoningEfforts.set(key, effort);
      else run.observedReasoningEffortsTruncated = true;
    }
  }

  private snapshot(run: MutableRun): CopilotTeamRunSnapshot {
    const end = run.endedAt ?? this.now();
    return {
      id: run.id,
      sequence: run.sequence,
      rootRunId: run.rootRunId,
      ...(run.parentRunId === undefined ? {} : { parentRunId: run.parentRunId }),
      agent: run.agent,
      kind: run.kind,
      task: run.task,
      state: run.state,
      startedAt: run.startedAt,
      ...(run.endedAt === undefined ? {} : { endedAt: run.endedAt }),
      elapsedMs: Math.max(0, end - run.startedAt),
      ...(run.model === undefined ? {} : { model: run.model }),
      ...(run.modelSource === undefined ? {} : { modelSource: run.modelSource }),
      observedModels: [...run.observedModels.values()],
      observedModelsTruncated: run.observedModelsTruncated,
      ...(run.reasoningEffort === undefined ? {} : { reasoningEffort: run.reasoningEffort }),
      ...(run.reasoningSource === undefined ? {} : { reasoningSource: run.reasoningSource }),
      observedReasoningEfforts: [...run.observedReasoningEfforts.values()],
      observedReasoningEffortsTruncated: run.observedReasoningEffortsTruncated,
      usage: cloneUsage(run),
      usageLowerBounds: [...run.usageLowerBounds],
      billing: cloneBilling(run),
      billingLowerBounds: [...run.billingLowerBounds],
      usageAggregateConflict: run.usageAggregateConflict,
      usageIdentityTruncated: run.usageIdentityTruncated,
      usageIdentityAmbiguous: run.usageIdentityAmbiguous,
      usageAttributionUnverified: run.usageAttributionUnverified,
      ...(run.nativeCalls > 0 ? { nativeCalls: run.nativeCalls } : {}),
      ...(run.durationMs === undefined ? {} : { durationMs: run.durationMs }),
      ...(run.totalToolCalls === undefined ? {} : { totalToolCalls: run.totalToolCalls }),
    };
  }

  private require(runId: string): MutableRun {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`unknown Copilot team run: ${runId}`);
    return run;
  }

  private emit(runId: string): void {
    for (const listener of this.listeners) {
      try { listener(runId); } catch { /* Observability must never break a run. */ }
    }
  }

  private releaseAgentKeys(run: MutableRun): void {
    for (const key of run.agentKeys) {
      if (this.agentRuns.get(key) === run.id) this.agentRuns.delete(key);
    }
    run.agentKeys.clear();
  }

  private prune(): void {
    const values = [...this.runs.values()];
    const roots = values.filter((run) => run.parentRunId === undefined && terminalStates.has(run.state) &&
      values.every((candidate) => candidate.rootRunId !== run.id || terminalStates.has(candidate.state)))
      .sort((left, right) => right.sequence - left.sequence);
    const keep = new Set<string>();
    const newestByProject = new Map<string, MutableRun>();
    for (const root of roots) if (!newestByProject.has(root.project)) newestByProject.set(root.project, root);
    for (const root of [...newestByProject.values()]
      .sort((left, right) => right.sequence - left.sequence)
      .slice(0, this.maxRootRuns)) keep.add(root.id);
    for (const root of roots) {
      if (keep.size >= this.maxRootRuns) break;
      keep.add(root.id);
    }
    for (const root of roots) {
      if (keep.has(root.id)) continue;
      for (const run of this.runs.values()) {
        if (run.rootRunId !== root.id) continue;
        this.releaseAgentKeys(run);
        this.runs.delete(run.id);
      }
    }
  }
}

export function formatCopilotElapsed(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return hours > 0
    ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}

function formatCopilotNativeDuration(milliseconds: number): string {
  return `${formatCopilotElapsed(milliseconds)}.${String(Math.floor(milliseconds % 1_000)).padStart(3, "0")}`;
}

export function formatCopilotTokenCount(value: number | undefined, lowerBound = false): string {
  return value === undefined ? "—" : `${lowerBound ? "≥" : ""}${new Intl.NumberFormat("en-US").format(value)}`;
}

function formatCopilotBillingCount(value: number | undefined, lowerBound = false): string {
  if (value === undefined) return "—";
  const formatted = value > Number.MAX_SAFE_INTEGER
    ? value.toExponential(6)
    : new Intl.NumberFormat("en-US", { maximumFractionDigits: 6 }).format(value);
  return `${lowerBound ? "≥" : ""}${formatted}`;
}

export function formatCopilotBilling(
  billing: CopilotNativeBillingUsage,
  lowerBounds: readonly CopilotNativeBillingField[] = [],
): string {
  const lower = new Set(lowerBounds);
  return [
    `model-multiplier cost ${formatCopilotBillingCount(billing.modelMultiplier, lower.has("modelMultiplier"))}`,
    `nano AIU ${formatCopilotBillingCount(billing.totalNanoAiu, lower.has("totalNanoAiu"))}`,
  ].join(" · ");
}

export function formatCopilotModel(run: CopilotTeamRunSnapshot): string {
  if (run.observedModels.length > 1 || run.observedModelsTruncated) {
    if (run.model) {
      const also = run.observedModels.filter((model) => model !== run.model);
      return `${run.model} (${run.modelSource ?? "observed"}${also.length || run.observedModelsTruncated
        ? `; also ${also.join(", ")}${run.observedModelsTruncated ? `${also.length ? ", " : ""}+more` : ""}`
        : ""})`;
    }
    return `mixed observed: ${run.observedModels.join(", ")}${run.observedModelsTruncated ? ", +more" : ""}`;
  }
  return run.model ? `${run.model} (${run.modelSource ?? "inherited"})` : "unknown/default (unobserved)";
}

export function formatCopilotReasoning(run: CopilotTeamRunSnapshot): string {
  if (run.observedReasoningEfforts.length > 1 || run.observedReasoningEffortsTruncated) {
    if (run.reasoningEffort) {
      const also = run.observedReasoningEfforts.filter((effort) => effort !== run.reasoningEffort);
      return `reasoning effort ${run.reasoningEffort}${run.reasoningSource ? ` (${run.reasoningSource}` : " (observed"}${
        also.length || run.observedReasoningEffortsTruncated
          ? `; also ${also.join(", ")}${run.observedReasoningEffortsTruncated ? `${also.length ? ", " : ""}+more` : ""}`
          : ""})`;
    }
    return `reasoning effort mixed: ${run.observedReasoningEfforts.join(", ")}${run.observedReasoningEffortsTruncated ? ", +more" : ""}`;
  }
  return `reasoning effort ${run.reasoningEffort ?? "unknown"}${run.reasoningSource ? ` (${run.reasoningSource})` : ""}`;
}

export function formatCopilotUsage(
  usage: CopilotNativeTokenUsage,
  lowerBounds: readonly CopilotNativeUsageField[] = [],
): string {
  const lower = new Set(lowerBounds);
  return [
    `in ${formatCopilotTokenCount(usage.input, lower.has("input"))}`,
    `out ${formatCopilotTokenCount(usage.output, lower.has("output"))}`,
    `reason ${formatCopilotTokenCount(usage.reasoning, lower.has("reasoning"))}`,
    `cache r/w ${formatCopilotTokenCount(usage.cacheRead, lower.has("cacheRead"))}/${formatCopilotTokenCount(usage.cacheWrite, lower.has("cacheWrite"))}`,
    `total ${formatCopilotTokenCount(usage.total, lower.has("total"))}`,
  ].join(" · ");
}

export function formatCopilotNativeTelemetry(
  run: CopilotTeamRunSnapshot,
  detailed = true,
): string {
  const hasCounters = Object.values(run.usage).some((value) => value !== undefined);
  const hasBilling = Object.values(run.billing).some((value) => value !== undefined);
  const identityNotes = [
    ...(run.usageIdentityAmbiguous
      ? ["native usage identity unavailable; indistinguishable events deduplicated"]
      : []),
    ...(run.usageIdentityTruncated
      ? ["identity capacity reached; later events omitted"]
      : []),
    ...(run.usageAttributionUnverified
      ? ["native usage attribution unverified; ambiguous counters omitted"]
      : []),
    ...(run.usageAggregateConflict
      ? ["terminal total conflicted with per-call counters; token breakdown omitted"]
      : []),
  ];
  if (run.usageAttributionUnverified && (run.nativeCalls ?? 0) === 0 && !hasCounters) {
    return identityNotes.join(" · ");
  }
  if (run.nativeCalls === undefined && !hasCounters) {
    return [
      run.usageIdentityTruncated
        ? "native telemetry identity capacity reached; later events omitted"
        : "native telemetry not observed yet",
      ...identityNotes.filter((note) => note !== "identity capacity reached; later events omitted"),
    ].join(" · ");
  }
  const eventLabel = run.nativeCalls === undefined
    ? "native aggregate"
    : run.usageIdentityTruncated || run.usageIdentityAmbiguous
      ? `${formatCopilotTokenCount(run.nativeCalls, true)} native usage ${run.nativeCalls === 1 ? "event" : "events"}`
      : `${formatCopilotTokenCount(run.nativeCalls)} native usage ${run.nativeCalls === 1 ? "event" : "events"}`;
  if (!hasCounters) {
    return [
      eventLabel,
      run.usageAggregateConflict ? `total ${formatCopilotTokenCount(run.usage.total)}` : "token counters unavailable",
      ...(hasBilling ? [formatCopilotBilling(run.billing, run.billingLowerBounds)] : []),
      ...identityNotes,
    ].join(" · ");
  }
  const summary = detailed
    ? `${eventLabel} · ${formatCopilotUsage(run.usage, run.usageLowerBounds)}`
    : `${eventLabel} · ${formatCopilotTokenCount(run.usage.total, run.usageLowerBounds.includes("total"))} native tokens`;
  return [
    summary,
    ...(hasBilling ? [formatCopilotBilling(run.billing, run.billingLowerBounds)] : []),
    ...identityNotes,
  ].join(" · ");
}

export function formatCopilotRunDetails(runs: readonly CopilotTeamRunSnapshot[]): string[] {
  const lines: string[] = [];
  for (const run of runs) {
    const branch = run.parentRunId ? "  └─" : "●";
    const detail = run.parentRunId ? "     " : "  ";
    lines.push(`${branch} ${run.agent} · run ${run.id}${run.parentRunId ? ` · parent ${run.parentRunId}` : ""} · ${run.kind} · ${run.state} · ${formatCopilotElapsed(run.elapsedMs)}`);
    lines.push(`${detail}Task: “${run.task}”`);
    lines.push(`${detail}${formatCopilotModel(run)} · ${formatCopilotReasoning(run)} · ${formatCopilotNativeTelemetry(run)}`);
    if (run.parentRunId && (run.durationMs !== undefined || run.totalToolCalls !== undefined)) {
      lines.push(`${detail}Native child: duration ${run.durationMs === undefined ? "—" : formatCopilotNativeDuration(run.durationMs)} · tool calls ${run.totalToolCalls ?? "—"}`);
    }
  }
  return wrapPlainLines(lines);
}

export function formatCopilotMissionDetails(runtime: CopilotTeamRuntime, rootRunId: string): string[] {
  const runs = runtime.mission(rootRunId);
  if (!runs.length) return ["Team run unavailable."];
  const root = runs.find((run) => run.id === rootRunId) ?? runs[0];
  const lines = formatCopilotRunDetails(runs);
  const attributionNote = runtime.missionUsageAttributionUnverified(rootRunId)
    ? " · native usage attribution unverified; mission counters incomplete"
    : "";
  const aggregateConflictNote = runtime.missionUsageAggregateConflict(rootRunId)
    ? " · terminal/per-call token conflict; incompatible breakdown omitted"
    : "";
  const missionBilling = runtime.missionBilling(rootRunId);
  const billingNote = Object.values(missionBilling).some((value) => value !== undefined)
    ? ` · ${formatCopilotBilling(missionBilling, runtime.missionBillingLowerBounds(rootRunId))}`
    : "";
  lines.push(`Mission total · ${formatCopilotElapsed(root.elapsedMs)} · ${formatCopilotUsage(runtime.missionUsage(rootRunId), runtime.missionUsageLowerBounds(rootRunId))}${billingNote}${attributionNote}${aggregateConflictNote}`);
  return wrapPlainLines(lines);
}

export function formatCopilotMissionReport(runtime: CopilotTeamRuntime, rootRunId: string): string {
  return ["", "TEAM RUN (native Copilot telemetry)", ...formatCopilotMissionDetails(runtime, rootRunId)].join("\n");
}
