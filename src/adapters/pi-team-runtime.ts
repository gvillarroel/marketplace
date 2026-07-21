/** In-memory, zero-model observability for Agent Harbor runs hosted by Pi. */
import { createHmac, randomBytes } from "node:crypto";
import { basename, resolve } from "node:path";
import type { PiObservedThinkingLevel, PiRunObserver, PiTeamRunState } from "../core/pi-observability.js";
import { wrapPlainLine, wrapPlainLines } from "../core/text-layout.js";

export type { PiRunObserver, PiTeamRunState } from "../core/pi-observability.js";

export type PiTeamMemberKind = "manager" | "fixed" | "bundled" | "personal" | "contractor" | "utility";
export interface PiNativeTokenUsage {
  readonly input?: number;
  readonly output?: number;
  readonly reasoning?: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
  readonly total?: number;
}
export type PiNativeUsageField = keyof PiNativeTokenUsage;

export interface PiTeamRunSnapshot {
  readonly id: string;
  readonly sequence: number;
  readonly rootRunId: string;
  readonly parentRunId?: string;
  readonly agent: string;
  readonly kind: PiTeamMemberKind;
  readonly task: string;
  readonly state: PiTeamRunState;
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly elapsedMs: number;
  readonly model?: { readonly provider: string; readonly id: string };
  readonly modelSource?: "inherited" | "observed";
  readonly observedModels: readonly { readonly provider: string; readonly id: string }[];
  readonly observedModelsTruncated: boolean;
  readonly thinking?: PiObservedThinkingLevel;
  readonly usage: PiNativeTokenUsage;
  /** Fields whose visible value is a known lower bound because at least one turn lacked native usage. */
  readonly usageLowerBounds: readonly PiNativeUsageField[];
  readonly nativeMessages: number;
}

export interface PiRunStart {
  readonly project: string;
  readonly agent: string;
  readonly kind: PiTeamMemberKind;
  readonly task: string;
  readonly parentRunId?: string;
  readonly model?: { readonly provider: string; readonly id: string };
  readonly thinking?: PiObservedThinkingLevel;
}

type UsageKey = PiNativeUsageField;

interface MutableRun {
  id: string;
  sequence: number;
  rootRunId: string;
  parentRunId?: string;
  project: string;
  agent: string;
  kind: PiTeamMemberKind;
  task: string;
  state: PiTeamRunState;
  startedAt: number;
  endedAt?: number;
  model?: { provider: string; id: string };
  modelSource?: "inherited" | "observed";
  observedModels: Map<string, { provider: string; id: string }>;
  observedModelsTruncated: boolean;
  thinking?: PiObservedThinkingLevel;
  usage: Partial<Record<UsageKey, number>>;
  usageLowerBounds: Set<UsageKey>;
  nativeMessages: number;
  seenMessageObjects: WeakSet<object>;
  seenMessageKeys: Set<string>;
}

const usageKeys: readonly UsageKey[] = ["input", "output", "reasoning", "cacheRead", "cacheWrite", "total"];
const activeStates = new Set<PiTeamRunState>(["starting", "working", "cleaning"]);
const terminalStates = new Set<PiTeamRunState>(["completed", "failed", "cancelled", "cleanup-error"]);

export function piPublicIdentifier(value: unknown, limit = 80): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, " ")
    .replace(/[\p{Cc}\p{Cf}\s]+/gu, " ")
    .trim();
  return normalized ? [...normalized].slice(0, limit).join("") : undefined;
}

/** Produces a useful but deliberately lossy task label without retaining prompts, paths, or likely secrets. */
export function piTaskLabel(task: string): string {
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

function nativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function updatePrivateFingerprint(
  fingerprint: ReturnType<typeof createHmac>,
  value: unknown,
  seen: Map<object, number>,
): void {
  const update = (tag: string, body = ""): void => {
    fingerprint.update(`${tag}:${Buffer.byteLength(body, "utf8")}:`);
    fingerprint.update(body, "utf8");
    fingerprint.update(";");
  };
  if (value === null) return update("null");
  if (value === undefined) return update("undefined");
  if (typeof value === "string") return update("string", value);
  if (typeof value === "boolean") return update("boolean", value ? "1" : "0");
  if (typeof value === "number") {
    return update("number", Object.is(value, -0) ? "-0" : String(value));
  }
  if (typeof value === "bigint") return update("bigint", value.toString());
  if (typeof value === "symbol") return update("symbol");
  if (typeof value === "function") return update("function");

  const priorReference = seen.get(value);
  if (priorReference !== undefined) return update("reference", String(priorReference));
  seen.set(value, seen.size);

  if (Array.isArray(value)) {
    update("array-start", String(value.length));
    for (let index = 0; index < value.length; index += 1) {
      update(Object.hasOwn(value, index) ? "item" : "hole", String(index));
      if (Object.hasOwn(value, index)) updatePrivateFingerprint(fingerprint, value[index], seen);
    }
    return update("array-end");
  }

  const keys = Object.keys(value).sort();
  update("object-start", String(keys.length));
  for (const key of keys) {
    update("key", key);
    updatePrivateFingerprint(fingerprint, (value as Record<string, unknown>)[key], seen);
  }
  update("object-end");
}

/**
 * Produces an opaque, process-local identity without retaining message content.
 * A random HMAC key prevents short or predictable responses from being recovered
 * with an offline dictionary if runtime internals are inspected.
 */
function privateFingerprint(value: unknown, key: Uint8Array): string {
  const fingerprint = createHmac("sha256", key);
  updatePrivateFingerprint(fingerprint, value, new Map());
  return fingerprint.digest("base64url");
}

function messageKey(message: Record<string, any>, fingerprintKey: Uint8Array): string | undefined {
  const responseId = typeof message.responseId === "string" && message.responseId.trim()
    ? message.responseId
    : undefined;
  if (responseId) return `response:${privateFingerprint(responseId, fingerprintKey)}`;
  const timestamp = nativeNumber(message.timestamp);
  const usage = message.usage && typeof message.usage === "object" ? message.usage : {};
  const hasContent = Object.hasOwn(message, "content");
  if (timestamp === undefined && !hasContent && !Object.keys(usage).length) return undefined;
  return `message:${privateFingerprint({
    timestamp,
    provider: message.provider,
    model: message.responseModel ?? message.model,
    stopReason: message.stopReason,
    content: message.content,
    usage: {
      input: nativeNumber(usage.input),
      output: nativeNumber(usage.output),
      cacheRead: nativeNumber(usage.cacheRead),
      cacheWrite: nativeNumber(usage.cacheWrite),
      reasoning: nativeNumber(usage.reasoning),
      totalTokens: nativeNumber(usage.totalTokens),
    },
  }, fingerprintKey)}`;
}

function modelFrom(value: unknown): { provider: string; id: string } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const provider = piPublicIdentifier((value as any).provider);
  // Routers such as OpenRouter retain the requested alias in `model` and
  // expose the concrete model that answered in `responseModel`.
  const id = piPublicIdentifier((value as any).responseModel ?? (value as any).id ?? (value as any).model);
  return provider && id ? { provider, id } : undefined;
}

function projectKey(project: string): string {
  const absolute = resolve(project);
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

function cloneUsage(run: MutableRun): PiNativeTokenUsage {
  return Object.fromEntries(usageKeys.flatMap((key) => {
    const value = run.usage[key];
    return value === undefined ? [] : [[key, value]];
  })) as PiNativeTokenUsage;
}

/** Process-local registry. It never persists task text or asks a model to summarize activity. */
export class PiTeamRuntime {
  private readonly runs = new Map<string, MutableRun>();
  private readonly listeners = new Set<(runId: string) => void>();
  private readonly messageFingerprintKey = randomBytes(32);
  private sequence = 0;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly maxRootRuns = 32,
  ) {}

  begin(input: PiRunStart): string {
    const parent = input.parentRunId === undefined ? undefined : this.runs.get(input.parentRunId);
    if (input.parentRunId !== undefined && !parent) throw new Error("unknown parent team run");
    const sequence = ++this.sequence;
    const id = `pi-run-${sequence}`;
    const initialModel = modelFrom(input.model);
    const run: MutableRun = {
      id,
      sequence,
      rootRunId: parent?.rootRunId ?? id,
      ...(parent ? { parentRunId: parent.id } : {}),
      project: projectKey(input.project),
      agent: piPublicIdentifier(input.agent) ?? "unknown-agent",
      kind: input.kind,
      task: piTaskLabel(input.task),
      state: "starting",
      startedAt: this.now(),
      ...(initialModel ? { model: initialModel } : {}),
      ...(initialModel ? { modelSource: "inherited" as const } : {}),
      observedModels: new Map(),
      observedModelsTruncated: false,
      ...(input.thinking === undefined ? {} : { thinking: input.thinking }),
      usage: {},
      usageLowerBounds: new Set(),
      nativeMessages: 0,
      seenMessageObjects: new WeakSet(),
      seenMessageKeys: new Set(),
    };
    this.runs.set(id, run);
    this.prune();
    this.emit(id);
    return id;
  }

  observer(runId: string): PiRunObserver {
    return {
      sessionStarted: (info) => {
        const run = this.require(runId);
        const model = modelFrom(info?.model);
        if (model) {
          run.model = model;
          run.modelSource = "inherited";
        }
        if (info?.thinking !== undefined) run.thinking = info.thinking;
        this.setState(runId, "working");
      },
      messageEnd: (message) => { this.observeMessageEnd(runId, message); },
      state: (state) => { this.setState(runId, state); },
    };
  }

  setState(runId: string, state: PiTeamRunState): void {
    const run = this.require(runId);
    if (terminalStates.has(run.state) && state !== "cleanup-error") return;
    if (run.state === "cleanup-error") return;
    run.state = state;
    if (terminalStates.has(state)) run.endedAt = this.now();
    this.emit(runId);
    if (terminalStates.has(state)) this.prune();
  }

  finishIfOpen(runId: string, outcome: "completed" | "failed" | "cancelled"): void {
    const run = this.require(runId);
    if (!terminalStates.has(run.state)) this.setState(runId, outcome);
  }

  observeMessageEnd(runId: string, value: unknown): boolean {
    const run = this.require(runId);
    if (!value || typeof value !== "object") return false;
    const message = value as Record<string, any>;
    if (message.role !== "assistant") return false;
    if (run.seenMessageObjects.has(message)) return false;
    const key = messageKey(message, this.messageFingerprintKey);
    if (key && run.seenMessageKeys.has(key)) return false;
    run.seenMessageObjects.add(message);
    if (key) run.seenMessageKeys.add(key);

    const actualModel = modelFrom(message);
    if (actualModel) {
      run.model = actualModel;
      run.modelSource = "observed";
      const key = `${actualModel.provider}\0${actualModel.id}`;
      if (!run.observedModels.has(key)) {
        if (run.observedModels.size < 8) run.observedModels.set(key, actualModel);
        else run.observedModelsTruncated = true;
      }
    }
    const usage = message.usage && typeof message.usage === "object" ? message.usage as Record<string, unknown> : {};
    const incoming: Record<UsageKey, number | undefined> = {
      input: nativeNumber(usage.input),
      output: nativeNumber(usage.output),
      reasoning: nativeNumber(usage.reasoning),
      cacheRead: nativeNumber(usage.cacheRead),
      cacheWrite: nativeNumber(usage.cacheWrite),
      total: nativeNumber(usage.totalTokens),
    };
    const componentFields = ["input", "output", "cacheRead", "cacheWrite"] as const;
    const componentValues = componentFields.map((field) => incoming[field]);
    const anyPositiveComponent = componentValues.some((value) => value !== undefined && value > 0);
    const everyComponentZero = componentValues.every((value) => value === 0);
    // Pi initializes absent provider usage to an all-zero object. A real model
    // turn cannot consume zero input/cache and zero output simultaneously.
    if (incoming.total === 0 && everyComponentZero) {
      for (const field of [...componentFields, "reasoning", "total"] as const) incoming[field] = undefined;
    } else {
      if (incoming.total === 0 && anyPositiveComponent) incoming.total = undefined;
      if (incoming.total !== undefined && incoming.total > 0 && everyComponentZero) {
        for (const field of componentFields) incoming[field] = undefined;
      }
    }
    for (const field of usageKeys) {
      const amount = incoming[field];
      if (amount === undefined) {
        run.usageLowerBounds.add(field);
      } else {
        run.usage[field] = (run.usage[field] ?? 0) + amount;
      }
    }
    run.nativeMessages += 1;
    this.emit(runId);
    return true;
  }

  subscribe(listener: (runId: string) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  get(runId: string): PiTeamRunSnapshot | undefined {
    const run = this.runs.get(runId);
    return run ? this.snapshot(run) : undefined;
  }

  mission(rootRunId: string): PiTeamRunSnapshot[] {
    return [...this.runs.values()]
      .filter((run) => run.rootRunId === rootRunId)
      .sort((left, right) => left.sequence - right.sequence)
      .map((run) => this.snapshot(run));
  }

  projectRuns(project: string): PiTeamRunSnapshot[] {
    const key = projectKey(project);
    return [...this.runs.values()]
      .filter((run) => run.project === key)
      .sort((left, right) => right.sequence - left.sequence)
      .map((run) => this.snapshot(run));
  }

  activeProjectRuns(project: string): PiTeamRunSnapshot[] {
    return this.projectRuns(project).filter((run) => activeStates.has(run.state));
  }

  latestRoot(project: string): PiTeamRunSnapshot | undefined {
    return this.projectRuns(project).find((run) => run.parentRunId === undefined);
  }

  missionUsage(rootRunId: string): PiNativeTokenUsage {
    const runs = this.mission(rootRunId);
    return Object.fromEntries(usageKeys.flatMap((field) => {
      const known = runs.flatMap((run) => run.usage[field] === undefined ? [] : [run.usage[field]!]);
      return known.length ? [[field, known.reduce((sum, value) => sum + value, 0)]] : [];
    })) as PiNativeTokenUsage;
  }

  missionUsageLowerBounds(rootRunId: string): PiNativeUsageField[] {
    const runs = this.mission(rootRunId);
    const usage = this.missionUsage(rootRunId);
    return usageKeys.filter((field) => usage[field] !== undefined && runs.some((run) =>
      run.usage[field] === undefined || run.usageLowerBounds.includes(field)));
  }

  projectName(project: string): string {
    return basename(resolve(project)) || "project";
  }

  private snapshot(run: MutableRun): PiTeamRunSnapshot {
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
      ...(run.model === undefined ? {} : { model: { ...run.model } }),
      ...(run.modelSource === undefined ? {} : { modelSource: run.modelSource }),
      observedModels: [...run.observedModels.values()].map((model) => ({ ...model })),
      observedModelsTruncated: run.observedModelsTruncated,
      ...(run.thinking === undefined ? {} : { thinking: run.thinking }),
      usage: cloneUsage(run),
      usageLowerBounds: [...run.usageLowerBounds],
      nativeMessages: run.nativeMessages,
    };
  }

  private require(runId: string): MutableRun {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`unknown Pi team run: ${runId}`);
    return run;
  }

  private emit(runId: string): void {
    for (const listener of this.listeners) {
      try { listener(runId); } catch { /* Observability must never break a child. */ }
    }
  }

  private prune(): void {
    // Active roots are never evicted: callers must always be able to finish
    // telemetry even if RPC starts more work than the retained-history limit.
    const roots = [...this.runs.values()].filter((run) =>
      run.parentRunId === undefined && terminalStates.has(run.state) &&
      [...this.runs.values()].every((candidate) => candidate.rootRunId !== run.id || terminalStates.has(candidate.state)))
      .sort((left, right) => right.sequence - left.sequence);
    for (const root of roots.slice(this.maxRootRuns)) {
      for (const run of this.runs.values()) if (run.rootRunId === root.id) this.runs.delete(run.id);
    }
  }
}

export function formatElapsed(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return hours > 0
    ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}

export function formatTokenCount(value: number | undefined, lowerBound = false): string {
  return value === undefined ? "—" : `${lowerBound ? "≥" : ""}${new Intl.NumberFormat("en-US").format(value)}`;
}

export function formatModel(run: PiTeamRunSnapshot): string {
  if (run.observedModels.length > 1 || run.observedModelsTruncated) {
    const models = run.observedModels.map(({ provider, id }) => `${provider}/${id}`).join(", ");
    return `mixed observed: ${models}${run.observedModelsTruncated ? ", +more" : ""}`;
  }
  return run.model
    ? `${run.model.provider}/${run.model.id} (${run.modelSource ?? "inherited"})`
    : "unknown/default (unobserved)";
}

export function formatUsage(
  usage: PiNativeTokenUsage,
  lowerBounds: readonly PiNativeUsageField[] = [],
): string {
  const lower = new Set(lowerBounds);
  return [
    `in ${formatTokenCount(usage.input, lower.has("input"))}`,
    `out ${formatTokenCount(usage.output, lower.has("output"))}`,
    `reason ${formatTokenCount(usage.reasoning, lower.has("reasoning"))}`,
    `cache r/w ${formatTokenCount(usage.cacheRead, lower.has("cacheRead"))}/${formatTokenCount(usage.cacheWrite, lower.has("cacheWrite"))}`,
    `total ${formatTokenCount(usage.total, lower.has("total"))}`,
  ].join(" · ");
}

/** Waits for best-effort shutdown cleanup without allowing a provider to hang Pi forever. */
export async function settlePiRootPromises(
  promises: readonly Promise<unknown>[],
  timeoutMs = 5_000,
): Promise<boolean> {
  if (!promises.length) return true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), Math.max(0, timeoutMs));
    timer.unref?.();
  });
  try {
    return await Promise.race([
      Promise.allSettled(promises).then(() => true as const),
      timeout,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Formats selected run rows without inventing or leaking an aggregate. */
export function formatPiRunDetails(runs: readonly PiTeamRunSnapshot[]): string[] {
  const lines: string[] = [];
  for (const run of runs) {
    const branch = run.parentRunId ? "  └─" : "●";
    const detail = run.parentRunId ? "     " : "  ";
    lines.push(`${branch} ${run.agent} · run ${run.id}${run.parentRunId ? ` · parent ${run.parentRunId}` : ""} · ${run.kind} · ${run.state} · ${formatElapsed(run.elapsedMs)}`);
    lines.push(`${detail}Task: “${run.task}”`);
    lines.push(`${detail}${formatModel(run)} · thinking setting ${run.thinking ?? "unknown"} · model turns ${run.nativeMessages} · ${formatUsage(run.usage, run.usageLowerBounds)}`);
  }
  return wrapPlainLines(lines);
}

/** Shared mission details for the final notification and the zero-model history view. */
export function formatPiMissionDetails(runtime: PiTeamRuntime, rootRunId: string): string[] {
  const runs = runtime.mission(rootRunId);
  if (!runs.length) return ["Team run unavailable."];
  const root = runs.find((run) => run.id === rootRunId) ?? runs[0];
  const lines = formatPiRunDetails(runs);
  lines.push(`Mission total · ${formatElapsed(root.elapsedMs)} · ${formatUsage(runtime.missionUsage(rootRunId), runtime.missionUsageLowerBounds(rootRunId))}`);
  return wrapPlainLines(lines);
}

/** Final accounting is composed outside child evidence, so a lead never sees or reasons over it. */
export function formatPiMissionReport(runtime: PiTeamRuntime, rootRunId: string): string {
  return ["", "TEAM RUN (native Pi telemetry)", ...formatPiMissionDetails(runtime, rootRunId)].join("\n");
}

export function formatPiLiveStatus(runtime: PiTeamRuntime, rootRunId: string): string {
  const runs = runtime.mission(rootRunId);
  const active = runs.filter((run) => activeStates.has(run.state));
  const focus = active.at(-1) ?? runs.at(-1);
  const usage = runtime.missionUsage(rootRunId);
  const totalLabel = formatTokenCount(usage.total, runtime.missionUsageLowerBounds(rootRunId).includes("total"));
  if (!focus) return "Agent Harbor · no active run";
  return wrapPlainLine(`Agent Harbor · ${active.length} working · ${focus.agent} ${focus.state} · ${totalLabel} tok · ${formatElapsed(focus.elapsedMs)}`).join("\n");
}

export function formatPiLiveWidget(runtime: PiTeamRuntime, rootRunId: string): string[] {
  const runs = runtime.mission(rootRunId);
  return wrapPlainLines([...runs.slice(-8).flatMap((run) => [
    `${run.parentRunId ? "  └─" : "●"} ${run.agent} · run ${run.id} · ${run.state} · ${formatModel(run)} · thinking setting ${run.thinking ?? "unknown"} · ${formatElapsed(run.elapsedMs)}`,
    `${run.parentRunId ? "     " : "  "}Task: “${run.task}” · model turns ${run.nativeMessages} · ${formatTokenCount(run.usage.total, run.usageLowerBounds.includes("total"))} native tokens`,
  ]), "Alt+H: stop active Agent Harbor work"]);
}
