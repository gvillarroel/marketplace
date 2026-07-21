/** Process-local, zero-model observability for Agent Harbor runs hosted by Copilot. */
import { createHmac, randomBytes } from "node:crypto";
import { basename, resolve } from "node:path";
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
const activeStates = new Set<CopilotTeamRunState>(["starting", "working", "waiting", "cleaning"]);
const childAdmissionStates = new Set<CopilotTeamRunState>(["starting", "working", "waiting"]);
const terminalStates = new Set<CopilotTeamRunState>(["completed", "failed", "cancelled", "cleanup-error"]);

function nativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function projectKey(project: string): string {
  const absolute = resolve(project);
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

/** Strips terminal controls and bounds host-provided public identifiers. */
export function copilotPublicIdentifier(value: unknown, limit = 120): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, " ")
    .replace(/[\p{Cc}\p{Cf}\s]+/gu, " ")
    .trim();
  return normalized ? [...normalized].slice(0, limit).join("") : undefined;
}

/** Produces a deliberately lossy label without retaining paths, URLs, or likely secrets. */
export function copilotTaskLabel(task: string): string {
  const normalized = task
    .replace(/https?:\/\/\S+/giu, "[url]")
    .replace(/\\\\[^\\\s"'`]+(?:\\[^\\\s"'`]+)+/gu, "[path]")
    .replace(/\b[A-Za-z]:\\(?:[^\s"']+\\)*[^\s"']*/gu, "[path]")
    .replace(/(^|[\s"'`(])\/(?:[A-Za-z0-9._~-]+\/)*[A-Za-z0-9._~-]+(?=$|[\s"'`,.;:!?)}\]])/gu, "$1[path]")
    .replace(/(^|[\s"'`(])\.{1,2}[\\/](?:[^\s"'`\\/()]+[\\/])*[^\s"'`()]+/gu, "$1[path]")
    .replace(/(^|[\s"'`(])(?:[A-Za-z0-9_.-]+[\\/])+(?:[A-Za-z0-9_.-]*\.[A-Za-z0-9_.-]+)(?=$|[\s"'`,.;:!?)}\]])/gu, "$1[path]")
    .replace(/\b(?:authorization\s*:\s*)?bearer\s+[A-Za-z0-9._~+/=-]{12,}/giu, "[redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, "[redacted]")
    .replace(/\b(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu, "$1=[redacted]")
    .replace(/\b(?:sk|pk|api|token|secret|key)[-_][A-Za-z0-9_-]{12,}\b/giu, "[redacted]")
    .replace(/[\p{Cc}\p{Cf}\s]+/gu, " ")
    .trim();
  if (!normalized) return "(task not disclosed)";
  const points = [...normalized];
  return points.length <= 72 ? normalized : `${points.slice(0, 69).join("")}…`;
}

function privateKey(value: unknown, key: Uint8Array): string {
  const digest = createHmac("sha256", key);
  digest.update(typeof value === "string" ? value : JSON.stringify(value), "utf8");
  return digest.digest("base64url");
}

function cloneUsage(run: MutableRun): CopilotNativeTokenUsage {
  return Object.fromEntries(usageFields.flatMap((field) => {
    const value = run.usage[field];
    return value === undefined ? [] : [[field, value]];
  })) as CopilotNativeTokenUsage;
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
      const key = privateKey(input.agentId, this.fingerprintKey);
      this.agentRuns.set(key, runId);
      run.agentKeys.add(key);
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
    const runId = event.agentId
      ? this.agentRuns.get(privateKey(event.agentId, this.fingerprintKey))
      : rootRunId;
    if (!runId) return false;
    const run = this.runs.get(runId);
    if (!run) return false;
    if (terminalStates.has(run.state)) return false;
    // A replay may arrive under a new event ID and with richer request IDs
    // than its first observation. Treat every available namespaced identity
    // as an alias, reject when any alias is known, then remember all aliases.
    // Only HMACs enter runtime state; opaque host identifiers are never kept.
    const identities: unknown[] = [
      event.data.apiCallId === undefined ? undefined : ["api", event.data.apiCallId],
      event.data.serviceRequestId === undefined ? undefined : ["service", event.data.serviceRequestId],
      event.data.providerCallId === undefined ? undefined : ["provider", event.data.providerCallId],
      event.id === undefined ? undefined : ["event", event.id],
    ].filter((value) => value !== undefined);
    const usesFallbackIdentity = identities.length === 0;
    if (usesFallbackIdentity) {
      identities.push(["fallback", {
        timestamp: event.timestamp,
        agent: event.agentId ? privateKey(event.agentId, this.fingerprintKey) : "root",
        model: event.data.model,
        input: event.data.inputTokens,
        output: event.data.outputTokens,
        reasoning: event.data.reasoningTokens,
        cacheRead: event.data.cacheReadTokens,
        cacheWrite: event.data.cacheWriteTokens,
      }]);
      // Without any host/provider call identity, equal payloads cannot be
      // distinguished from replays. Keep deduplication deterministic but make
      // both the call count and every token counter an explicit lower bound.
      run.usageIdentityAmbiguous = true;
      for (const field of usageFields) run.usageLowerBounds.add(field);
    }
    const keys = identities.map((identity) => privateKey(identity, this.fingerprintKey));
    const replay = keys.some((key) => run.seenUsageKeys.has(key));
    const unseenKeys = [...new Set(keys)].filter((key) => !run.seenUsageKeys.has(key));
    if (run.usageIdentityTruncated ||
        run.seenUsageKeys.size + unseenKeys.length > maximumCopilotUsageIdentityKeys) {
      if (!run.usageIdentityTruncated) {
        run.usageIdentityTruncated = true;
        for (const field of usageFields) run.usageLowerBounds.add(field);
        this.emit(runId);
      }
      return false;
    }
    for (const key of unseenKeys) run.seenUsageKeys.add(key);
    if (replay) {
      if (usesFallbackIdentity) this.emit(runId);
      return false;
    }
    this.observeModel(run, event.data.model);
    this.observeEffort(run, event.data.reasoningEffort);
    const input = nativeNumber(event.data.inputTokens);
    const output = nativeNumber(event.data.outputTokens);
    const incoming: Record<CopilotNativeUsageField, number | undefined> = {
      input,
      output,
      reasoning: nativeNumber(event.data.reasoningTokens),
      cacheRead: nativeNumber(event.data.cacheReadTokens),
      cacheWrite: nativeNumber(event.data.cacheWriteTokens),
      total: input === undefined && output === undefined ? undefined : (input ?? 0) + (output ?? 0),
    };
    for (const field of usageFields) {
      const amount = incoming[field];
      if (amount === undefined) run.usageLowerBounds.add(field);
      else run.usage[field] = (run.usage[field] ?? 0) + amount;
    }
    if (input === undefined || output === undefined) run.usageLowerBounds.add("total");
    run.nativeCalls += 1;
    if (run.state === "starting") run.state = "working";
    this.emit(runId);
    return true;
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
    const duration = nativeNumber(summary.durationMs);
    const tools = nativeNumber(summary.totalToolCalls);
    const total = nativeNumber(summary.totalTokens);
    if (duration !== undefined) run.durationMs = duration;
    if (tools !== undefined) run.totalToolCalls = tools;
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
        run.usageLowerBounds.add("total");
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
      return known.length ? [[field, known.reduce((sum, value) => sum + value, 0)]] : [];
    })) as CopilotNativeTokenUsage;
  }

  missionUsageLowerBounds(rootRunId: string): CopilotNativeUsageField[] {
    const runs = this.mission(rootRunId);
    const usage = this.missionUsage(rootRunId);
    return usageFields.filter((field) => usage[field] !== undefined && runs.some((run) =>
      run.usage[field] === undefined || run.usageLowerBounds.includes(field)));
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
    for (const root of roots.slice(this.maxRootRuns)) {
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
    return [eventLabel, "token counters unavailable", ...identityNotes].join(" · ");
  }
  const summary = detailed
    ? `${eventLabel} · ${formatCopilotUsage(run.usage, run.usageLowerBounds)}`
    : `${eventLabel} · ${formatCopilotTokenCount(run.usage.total, run.usageLowerBounds.includes("total"))} native tokens`;
  return [summary, ...identityNotes].join(" · ");
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
  lines.push(`Mission total · ${formatCopilotElapsed(root.elapsedMs)} · ${formatCopilotUsage(runtime.missionUsage(rootRunId), runtime.missionUsageLowerBounds(rootRunId))}${attributionNote}`);
  return wrapPlainLines(lines);
}

export function formatCopilotMissionReport(runtime: CopilotTeamRuntime, rootRunId: string): string {
  return ["", "TEAM RUN (native Copilot telemetry)", ...formatCopilotMissionDetails(runtime, rootRunId)].join("\n");
}
