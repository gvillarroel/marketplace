/**
 * Copilot hook guard that constrains native `task` delegation and correlates
 * host lifecycle events into privacy-preserving Agent Harbor evidence.
 */
import { createHmac, randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { listManagedActiveIds } from "../core/active.js";
import { rolePlayers } from "../core/defaults.js";
import { emitHarborEvidence, fingerprintHarborEvidence, type HarborEvidenceHook } from "../core/evidence.js";
import { harnessProfileLayout } from "../core/harnesses.js";
import { isHarborId } from "../core/identity.js";
import { copilotTaskLabel } from "./copilot-team-runtime.js";

/** Minimal host identity needed to resolve a logical Harbor player. */
export interface CopilotAgentIdentity {
  id: string;
  path?: string;
  model?: string;
  userInvocable?: boolean;
}

/** Narrow RPC surface used to refresh Copilot's selected and available agents. */
export interface CopilotCoordinatorSession {
  rpc: {
    agent: {
      getCurrent(): Promise<{ agent?: CopilotAgentIdentity | null }>;
      reload(): Promise<{ agents: CopilotAgentIdentity[] }>;
    };
  };
}

interface HookInvocation { sessionId: string }
interface HookBaseInput { sessionId: string; workingDirectory: string }
interface ToolHookInput extends HookBaseInput { toolName: string; toolArgs: unknown }
interface PostToolHookInput extends ToolHookInput { toolResult?: unknown }
interface PostToolFailureHookInput extends ToolHookInput { error?: string }
interface UserPromptHookInput extends HookBaseInput { prompt?: string }
interface PreToolDecision {
  permissionDecision: "allow" | "deny";
  permissionDecisionReason?: string;
}

/** Stable run metadata shared by every privacy-preserving lifecycle callback. */
export interface CopilotCoordinatorRunCorrelation {
  /** Copilot's native session identifier. */
  sessionId: string;
  /** Project-local scope used only by the in-process runtime; never persisted by the guard. */
  project: string;
  /** Agent Harbor's process-local ID for the current root user turn. */
  rootRunId: string;
  /** Agent Harbor's process-local ID for this root or child run. */
  runId: string;
  /** Present only for a child, and always equal to its root's run ID. */
  parentRunId?: string;
  kind: "root" | "child";
  /** Logical Harbor player ID. */
  agent: string;
  /** Copilot's plugin-qualified or project-profile agent ID. */
  runtimeAgent: string;
  /** Native sub-agent instance ID, once Copilot reports it. */
  childId?: string;
  /** Native `task` tool-call ID. */
  invocationId?: string;
  /** Native assistant turn ID, when the host event carries one. */
  turnId?: string;
  /** Native session event-chain IDs. */
  eventId?: string;
  parentEventId?: string | null;
  /** Native ISO timestamp, or callback time for hook-only observations. */
  timestamp?: string;
  /** Whether Copilot reported the lifecycle fact or the guard inferred it. */
  basis: "observed" | "inferred";
}

export interface CopilotCoordinatorRootStartedEvent extends CopilotCoordinatorRunCorrelation {
  type: "root.started";
  kind: "root";
  /** Bounded lossy label; the submitted prompt is never exposed or retained. */
  taskLabel: string;
  model?: string;
  modelSource?: "configured" | "inherited";
  reasoningEffort?: string | null;
}

export interface CopilotCoordinatorChildStartedEvent extends CopilotCoordinatorRunCorrelation {
  type: "child.started";
  kind: "child";
  parentRunId: string;
  /** Bounded lossy label; the delegated prompt is never exposed or retained. */
  taskLabel: string;
  model?: string;
}

export type CopilotCoordinatorRunState =
  | "starting"
  | "working"
  | "waiting"
  | "idle"
  | "cancelling"
  | "completed"
  | "failed"
  | "cancelled";

export interface CopilotCoordinatorRunStateEvent extends CopilotCoordinatorRunCorrelation {
  type: "run.state";
  state: CopilotCoordinatorRunState;
}

export interface CopilotCoordinatorRunModelEvent extends CopilotCoordinatorRunCorrelation {
  type: "run.model";
  model: string;
}

export interface CopilotCoordinatorRunReasoningEvent extends CopilotCoordinatorRunCorrelation {
  type: "run.reasoning";
  /** A setting such as `low` or `high`; never model reasoning content. */
  reasoningEffort: string | null;
}

export interface CopilotCoordinatorNativeUsage {
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** Computed only when both native input and output counters are present. */
  totalTokens?: number;
}

export interface CopilotCoordinatorRunUsageEvent extends CopilotCoordinatorRunCorrelation {
  type: "run.usage";
  apiCallId?: string;
  serviceRequestId?: string;
  providerCallId?: string;
  model?: string;
  reasoningEffort?: string | null;
  usage: CopilotCoordinatorNativeUsage;
}

export interface CopilotCoordinatorRunFinishedEvent extends CopilotCoordinatorRunCorrelation {
  type: "run.finished";
  outcome: "completed" | "failed" | "cancelled";
  durationMs?: number;
  /** Native aggregate supplied by Copilot for a sub-agent terminal event. */
  totalTokens?: number;
  totalToolCalls?: number;
}

/** Content-free lifecycle stream consumed by the in-memory Copilot team runtime. */
export type CopilotCoordinatorLifecycleEvent =
  | CopilotCoordinatorRootStartedEvent
  | CopilotCoordinatorChildStartedEvent
  | CopilotCoordinatorRunStateEvent
  | CopilotCoordinatorRunModelEvent
  | CopilotCoordinatorRunReasoningEvent
  | CopilotCoordinatorRunUsageEvent
  | CopilotCoordinatorRunFinishedEvent;

/** Best-effort observer; callback failures never change delegation behavior. */
export type CopilotCoordinatorLifecycleHook = (
  event: CopilotCoordinatorLifecycleEvent,
) => void | Promise<void>;

/** Synchronous child admission check; throwing denies the native `task` before model work starts. */
export type CopilotCoordinatorAdmissionHook = (input: {
  type: "child";
  project: string;
  rootRunId: string;
  parentRunId: string;
  runId: string;
  agent: string;
  runtimeAgent: string;
  taskLabel: string;
}) => void;

/** Hook callbacks installed into the Copilot extension session. */
export interface CopilotCoordinatorHooks {
  onUserPromptSubmitted(input: UserPromptHookInput, invocation: HookInvocation): Promise<void>;
  onPreToolUse(input: ToolHookInput, invocation: HookInvocation): Promise<PreToolDecision | void>;
  onPostToolUse(input: PostToolHookInput, invocation: HookInvocation): Promise<void>;
  onPostToolUseFailure(input: PostToolFailureHookInput, invocation: HookInvocation): Promise<void>;
}
/** Stateful guard plus host-event observer used by the Copilot extension. */
export interface CopilotCoordinatorGuard {
  hooks: CopilotCoordinatorHooks;
  refresh(expectedCurrentId?: string): Promise<void>;
  refreshAuthoritative(): Promise<void>;
  observeEvent(event: CopilotCoordinatorHostEvent): void;
}

/** Structural subset of Copilot SDK 1.0.6 session events used by the guard. */
export interface CopilotCoordinatorHostEvent {
  type?: string;
  id?: string;
  parentId?: string | null;
  timestamp?: string;
  agentId?: string;
  data?: {
    aborted?: boolean;
    agentName?: string;
    apiCallId?: string;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    currentModel?: string;
    durationMs?: number;
    error?: unknown;
    inputTokens?: number;
    initiator?: string;
    model?: string;
    newModel?: string;
    outputTokens?: number;
    parentToolCallId?: string;
    providerCallId?: string;
    reasoningEffort?: string | null;
    reasoningTokens?: number;
    result?: unknown;
    selectedModel?: string;
    serviceRequestId?: string;
    sessionId?: string;
    shutdownType?: string;
    success?: boolean;
    toolCallId?: string;
    toolName?: string;
    toolDescription?: { name?: string };
    tools?: string[] | null;
    totalTokens?: number;
    totalToolCalls?: number;
    turnId?: string;
    /** Other SDK fields, including content-bearing fields, are deliberately ignored. */
    [key: string]: unknown;
  };
}

/** Maps stable Harbor role IDs to Copilot's plugin-qualified runtime IDs. */
const specializedCopilotRoles = new Map([
  ["team-lead", "agent-foundry:team-lead"],
]);
export const copilotFixedAgentIds: ReadonlyMap<string, string> = new Map(
  [...rolePlayers.keys()].map((id) => [id, specializedCopilotRoles.get(id) ?? `agent-foundry:${id}`]),
);

/** Plugin-qualified identity used only by the explicit `/scout` command. */
export const copilotScoutAgentId = "agent-foundry:talent-scout";

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) => process.platform === "win32" ? resolve(value).toLowerCase() : resolve(value);
  return normalize(left) === normalize(right);
}

function activePath(project: string, id: string): string {
  const { activeDir, extension } = harnessProfileLayout("copilot");
  return resolve(project, activeDir, `${id}${extension}`);
}

/** Lists canonical active project profile IDs without trusting arbitrary files. */
export function listCopilotActiveProfileIds(project: string): string[] {
  return listManagedActiveIds("copilot", project);
}

/** Resolves one logical ID to exactly one currently invocable Copilot identity. */
export function resolveCopilotPlayer(
  id: string,
  agents: readonly CopilotAgentIdentity[],
  project: string,
  activeProfileIds: readonly string[] = listCopilotActiveProfileIds(project),
): CopilotAgentIdentity {
  const fixedId = id === "talent-scout" ? copilotScoutAgentId : copilotFixedAgentIds.get(id);
  if (fixedId) {
    const matches = agents.filter((agent) => agent.id === fixedId);
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) throw new Error(`active Agent Harbor player is ambiguous: ${id}`);
    throw new Error(`Agent Harbor player is not active in Copilot: ${id}`);
  }

  if (!activeProfileIds.includes(id)) {
    throw new Error(`Agent Harbor player is not active: ${id}; run /bench on ${id}`);
  }
  const expectedPath = activePath(project, id);
  const matches = agents.filter((agent) => agent.id === id && agent.path && samePath(agent.path, expectedPath));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) throw new Error(`active Agent Harbor player is ambiguous: ${id}`);
  throw new Error(`Agent Harbor player is not active in Copilot: ${id}`);
}

function deny(reason: string) {
  return { permissionDecision: "deny" as const, permissionDecisionReason: reason };
}

function structuredToolArgs(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    try {
      const serialized = JSON.stringify(value);
      return Buffer.byteLength(serialized, "utf8") <= 100_000 ? value as Record<string, unknown> : undefined;
    } catch {
      return undefined;
    }
  }
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value, "utf8") > 100_000) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function publicCopilotMetadata(value: unknown, limit = 200): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, " ")
    .replace(/[\p{Cc}\p{Cf}\s]+/gu, " ")
    .trim();
  return normalized ? [...normalized].slice(0, limit).join("") : undefined;
}

function nativeCounter(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function coordinatorRpcTimeoutMs(): number {
  const configured = Number(process.env.AGENT_HARBOR_COPILOT_RPC_TIMEOUT_MS);
  return Number.isFinite(configured) ? Math.min(60_000, Math.max(250, Math.floor(configured))) : 15_000;
}

async function boundedCoordinatorRpc<T>(
  label: string,
  action: () => Promise<T>,
  timeoutMs = coordinatorRpcTimeoutMs(),
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(action),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

interface MutableCopilotLifecycleRun {
  runId: string;
  rootRunId: string;
  parentRunId?: string;
  sessionId: string;
  project: string;
  kind: "root" | "child";
  agent: string;
  runtimeAgent: string;
  taskLabel: string;
  childId?: string;
  invocationId?: string;
  turnId?: string;
  model?: string;
  modelSource?: "configured" | "inherited";
  reasoningEffort?: string | null;
  state?: CopilotCoordinatorRunState;
  started: boolean;
  finished: boolean;
  startedAt: number;
  observedActivity: boolean;
  observedEventIds: Set<string>;
  seenUsageIds: Set<string>;
}

/**
 * Enforce the team-lead contract around Copilot's native synchronous `task`
 * tool. The host remains responsible for the child lifecycle and result.
 */
export function createCopilotCoordinatorGuard(
  getSession: () => CopilotCoordinatorSession,
  evidenceHook?: HarborEvidenceHook,
  lifecycleHook?: CopilotCoordinatorLifecycleHook,
  admissionHook?: CopilotCoordinatorAdmissionHook,
): CopilotCoordinatorGuard {
  const correlationKey = randomBytes(32);
  const privateCorrelationKey = (namespace: string, value: unknown): string => {
    const digest = createHmac("sha256", correlationKey);
    digest.update(namespace, "utf8");
    digest.update("\0", "utf8");
    digest.update(typeof value === "string" ? value : JSON.stringify(value) ?? String(value), "utf8");
    return digest.digest("base64url");
  };
  const publicOpaqueCorrelation = (namespace: string, value: unknown, limit = 200): string | undefined => {
    const publicValue = publicCopilotMetadata(value, limit);
    if (!publicValue || typeof value !== "string" || [...value].length <= limit) return publicValue;
    const suffix = privateCorrelationKey(namespace, value).slice(0, 16);
    const prefix = publicCopilotMetadata(value, Math.max(1, limit - suffix.length - 1));
    return prefix ? `${prefix}~${suffix}` : suffix;
  };
  const opaqueEventKey = (value: unknown): string | undefined => typeof value === "string" && value
    ? privateCorrelationKey("event", value)
    : undefined;
  const counts = new Map<string, number>();
  const inFlight = new Set<string>();
  const unclaimedTaskCalls: string[] = [];
  const pending = new Map<string, {
    agent: string;
    runtimeAgent: string;
    lifecycle: MutableCopilotLifecycleRun;
    childId?: string;
    invocationId?: string;
    terminal?: "completed" | "failed";
    errorFingerprint?: ReturnType<typeof fingerprintHarborEvidence>;
  }>();
  let snapshot: {
    ready: boolean;
    current?: CopilotAgentIdentity;
    agents: CopilotAgentIdentity[];
  } = { ready: false, agents: [] };
  let selectionEpoch = 0;
  let refreshEpoch = 0;
  let lifecycleSequence = 0;
  let selectedModel: string | undefined;
  let selectedReasoningEffort: string | null | undefined;
  const activeRoots = new Map<string, MutableCopilotLifecycleRun>();
  let guard = Promise.resolve();
  // Hook callbacks and asynchronous refreshes share state. A tiny promise lock
  // makes their ordering deterministic without blocking the host event loop.
  const locked = <T>(action: () => Promise<T> | T): Promise<T> => {
    const result = guard.then(action, action);
    guard = result.then(() => undefined, () => undefined);
    return result;
  };

  const serialized = (value: unknown): string => {
    if (typeof value === "string") return value;
    if (value === undefined) return "";
    try { return JSON.stringify(value); }
    catch { return String(value); }
  };

  const emitLifecycle = (event: CopilotCoordinatorLifecycleEvent): void => {
    if (!lifecycleHook) return;
    try {
      const result = lifecycleHook(event);
      if (result && typeof (result as PromiseLike<void>).then === "function") {
        void Promise.resolve(result).catch(() => undefined);
      }
    } catch { /* Observability must never change delegation or cleanup. */ }
  };

  const correlation = (
    run: MutableCopilotLifecycleRun,
    basis: "observed" | "inferred",
    event?: CopilotCoordinatorHostEvent,
  ): CopilotCoordinatorRunCorrelation => {
    const eventId = publicOpaqueCorrelation("event", event?.id);
    const parentEventId = event?.parentId === null ? null : publicOpaqueCorrelation("event", event?.parentId);
    const timestamp = publicCopilotMetadata(event?.timestamp, 80);
    return {
      sessionId: run.sessionId,
      project: run.project,
      rootRunId: run.rootRunId,
      runId: run.runId,
      ...(run.parentRunId === undefined ? {} : { parentRunId: run.parentRunId }),
      kind: run.kind,
      agent: run.agent,
      runtimeAgent: run.runtimeAgent,
      ...(run.childId === undefined ? {} : { childId: run.childId }),
      ...(run.invocationId === undefined ? {} : { invocationId: run.invocationId }),
      ...(run.turnId === undefined ? {} : { turnId: run.turnId }),
      ...(eventId === undefined ? {} : { eventId }),
      ...(parentEventId === undefined ? {} : { parentEventId }),
      ...(timestamp === undefined ? {} : { timestamp }),
      basis,
    };
  };

  const setLifecycleState = (
    run: MutableCopilotLifecycleRun,
    state: CopilotCoordinatorRunState,
    basis: "observed" | "inferred",
    event?: CopilotCoordinatorHostEvent,
  ): void => {
    if (run.state === state || run.finished) return;
    run.state = state;
    emitLifecycle({ ...correlation(run, basis, event), type: "run.state", state });
  };

  const observeLifecycleModel = (
    run: MutableCopilotLifecycleRun,
    value: unknown,
    basis: "observed" | "inferred",
    event?: CopilotCoordinatorHostEvent,
  ): void => {
    const model = publicCopilotMetadata(value);
    if (!model || run.model === model || run.finished) return;
    run.model = model;
    emitLifecycle({ ...correlation(run, basis, event), type: "run.model", model });
  };

  const observeLifecycleReasoning = (
    run: MutableCopilotLifecycleRun,
    value: unknown,
    basis: "observed" | "inferred",
    event?: CopilotCoordinatorHostEvent,
  ): void => {
    const reasoningEffort = value === null ? null : publicCopilotMetadata(value, 40);
    if (reasoningEffort === undefined || run.reasoningEffort === reasoningEffort || run.finished) return;
    run.reasoningEffort = reasoningEffort;
    emitLifecycle({ ...correlation(run, basis, event), type: "run.reasoning", reasoningEffort });
  };

  const startLifecycle = (
    run: MutableCopilotLifecycleRun,
    basis: "observed" | "inferred",
    event?: CopilotCoordinatorHostEvent,
    model?: unknown,
  ): void => {
    if (run.started || run.finished) return;
    run.started = true;
    const publicModel = publicCopilotMetadata(model);
    if (run.kind === "root") {
      emitLifecycle({
        ...correlation(run, basis, event),
        type: "root.started",
        kind: "root",
        taskLabel: run.taskLabel,
        ...(publicModel === undefined ? {} : { model: publicModel }),
        ...(publicModel === undefined ? {} : { modelSource: run.modelSource ?? "inherited" as const }),
        ...(selectedReasoningEffort === undefined ? {} : { reasoningEffort: selectedReasoningEffort }),
      });
    } else {
      emitLifecycle({
        ...correlation(run, basis, event),
        type: "child.started",
        kind: "child",
        parentRunId: run.parentRunId!,
        taskLabel: run.taskLabel,
        ...(publicModel === undefined ? {} : { model: publicModel }),
      });
    }
    setLifecycleState(run, "starting", basis, event);
    if (publicModel) observeLifecycleModel(run, publicModel, basis, event);
    if (run.kind === "root" && selectedReasoningEffort !== undefined) {
      observeLifecycleReasoning(run, selectedReasoningEffort, basis, event);
    }
  };

  const finishLifecycle = (
    run: MutableCopilotLifecycleRun,
    outcome: "completed" | "failed" | "cancelled",
    basis: "observed" | "inferred",
    event?: CopilotCoordinatorHostEvent,
    aggregates?: { durationMs?: unknown; totalTokens?: unknown; totalToolCalls?: unknown },
  ): void => {
    if (run.finished) return;
    if (!run.started) startLifecycle(run, "inferred", event, event?.data?.model);
    const state = outcome === "completed" ? "completed" : outcome === "failed" ? "failed" : "cancelled";
    setLifecycleState(run, state, basis, event);
    run.finished = true;
    const nativeDuration = nativeCounter(aggregates?.durationMs);
    const durationMs = nativeDuration ?? Math.max(0, Date.now() - run.startedAt);
    const totalTokens = nativeCounter(aggregates?.totalTokens);
    const totalToolCalls = nativeCounter(aggregates?.totalToolCalls);
    emitLifecycle({
      ...correlation(run, basis, event),
      type: "run.finished",
      outcome,
      durationMs,
      ...(totalTokens === undefined ? {} : { totalTokens }),
      ...(totalToolCalls === undefined ? {} : { totalToolCalls }),
    });
  };

  const harborPlayerForIdentity = (
    project: string,
    identity?: CopilotAgentIdentity | null,
  ): { agent: string; runtimeAgent: string; model?: string } | undefined => {
    const runtimeAgent = identity?.id;
    if (!runtimeAgent) return undefined;
    const fixed = [...copilotFixedAgentIds].find(([, exact]) => exact === runtimeAgent);
    const logicalId = runtimeAgent === copilotScoutAgentId ? "talent-scout" : fixed?.[0];
    try {
      if (logicalId) {
        const resolved = resolveCopilotPlayer(logicalId, snapshot.agents, project);
        return resolved.id === runtimeAgent
          ? { agent: logicalId, runtimeAgent, ...(resolved.model === undefined ? {} : { model: resolved.model }) }
          : undefined;
      }
      if (!listCopilotActiveProfileIds(project).includes(runtimeAgent)) return undefined;
      // An id-only current selection is common in the SDK. Validate it against
      // every same-id registry entry so order cannot select a foreign path and
      // duplicate exact definitions remain fail-closed as ambiguous.
      const candidates = identity.path
        ? [identity]
        : snapshot.agents.filter(({ id }) => id === runtimeAgent);
      const resolved = resolveCopilotPlayer(runtimeAgent, candidates, project);
      return resolved.id === runtimeAgent
        ? { agent: runtimeAgent, runtimeAgent, ...(resolved.model === undefined ? {} : { model: resolved.model }) }
        : undefined;
    } catch {
      return undefined;
    }
  };

  const selectedHarborPlayer = (project: string): { agent: string; runtimeAgent: string; model?: string } | undefined => {
    const selected = snapshot.current;
    if (!selected) return undefined;
    return harborPlayerForIdentity(project, selected);
  };

  const startRootLifecycle = (
    sessionId: string,
    project: string,
    taskLabel: string,
    player: { agent: string; runtimeAgent: string; model?: string },
    basis: "observed" | "inferred",
  ): MutableCopilotLifecycleRun => {
    const runId = `copilot-root-${++lifecycleSequence}`;
    const root: MutableCopilotLifecycleRun = {
      sessionId,
      project,
      runId,
      rootRunId: runId,
      kind: "root",
      agent: player.agent,
      runtimeAgent: player.runtimeAgent,
      taskLabel,
      ...(player.model === undefined ? {} : { modelSource: "configured" as const }),
      started: false,
      finished: false,
      startedAt: Date.now(),
      observedActivity: false,
      observedEventIds: new Set(),
      seenUsageIds: new Set(),
    };
    activeRoots.set(sessionId, root);
    startLifecycle(root, basis, { timestamp: new Date(root.startedAt).toISOString() }, player.model ?? selectedModel);
    setLifecycleState(root, "working", basis);
    return root;
  };

  const latestRootLifecycle = (): MutableCopilotLifecycleRun | undefined => {
    const roots = [...activeRoots.values()].filter((run) => !run.finished);
    return roots.at(-1);
  };

  const lifecycleItemForEvent = (event: CopilotCoordinatorHostEvent) => {
    const childId = event.agentId;
    const invocationId = event.data?.toolCallId ?? event.data?.parentToolCallId;
    return [...pending.values()].find((item) =>
      (childId !== undefined && item.childId === childId) ||
      (invocationId !== undefined && item.invocationId === invocationId));
  };

  const lifecycleRunForEvent = (event: CopilotCoordinatorHostEvent): MutableCopilotLifecycleRun | undefined => {
    if (event.agentId || event.data?.parentToolCallId || event.data?.initiator === "sub-agent") {
      const correlated = lifecycleItemForEvent(event)?.lifecycle;
      if (correlated) return correlated;
      if (event.data?.initiator === "sub-agent" && pending.size === 1) return [...pending.values()][0].lifecycle;
      return undefined;
    }
    return latestRootLifecycle();
  };

  const rememberLifecycleEventId = (run: MutableCopilotLifecycleRun, event?: CopilotCoordinatorHostEvent): void => {
    const eventId = opaqueEventKey(event?.id);
    if (!eventId || run.observedEventIds.has(eventId)) return;
    if (run.observedEventIds.size >= 256) {
      const oldest = run.observedEventIds.values().next().value as string | undefined;
      if (oldest) run.observedEventIds.delete(oldest);
    }
    run.observedEventIds.add(eventId);
  };

  const markLifecycleActivity = (run: MutableCopilotLifecycleRun, event?: CopilotCoordinatorHostEvent): void => {
    run.observedActivity = true;
    rememberLifecycleEventId(run, event);
    const root = run.kind === "root" ? run : activeRoots.get(run.sessionId);
    if (root && root !== run) {
      root.observedActivity = true;
      rememberLifecycleEventId(root, event);
    }
  };

  const lifecycleEventBelongsToRun = (
    run: MutableCopilotLifecycleRun,
    event: CopilotCoordinatorHostEvent,
  ): boolean => {
    const timestamp = event.timestamp === undefined ? Number.NaN : Date.parse(event.timestamp);
    if (Number.isFinite(timestamp) && timestamp < run.startedAt) return false;
    const parentEventId = opaqueEventKey(event.parentId);
    if (parentEventId === undefined || run.observedEventIds.has(parentEventId)) return true;
    if (run.kind === "child" && activeRoots.get(run.sessionId)?.observedEventIds.has(parentEventId)) return true;
    // The first current event seeds the native chain. Once activity exists,
    // an unknown parent is evidence that a delayed event belongs elsewhere.
    return !run.observedActivity;
  };

  const extendLifecycleEventChain = (event: CopilotCoordinatorHostEvent): void => {
    if (event.type === "session.idle") return;
    const run = lifecycleRunForEvent(event);
    if (!run || run.finished || !lifecycleEventBelongsToRun(run, event)) return;
    rememberLifecycleEventId(run, event);
    const root = run.kind === "root" ? run : activeRoots.get(run.sessionId);
    if (root && root !== run && !root.finished && lifecycleEventBelongsToRun(root, event)) {
      rememberLifecycleEventId(root, event);
    }
  };

  const sessionIdleBelongsToRoot = (root: MutableCopilotLifecycleRun, event: CopilotCoordinatorHostEvent): boolean => {
    return root.observedActivity && lifecycleEventBelongsToRun(root, event);
  };

  const observeLifecycleUsage = (event: CopilotCoordinatorHostEvent): void => {
    const run = lifecycleRunForEvent(event);
    if (!run || run.finished || !lifecycleEventBelongsToRun(run, event)) return;
    const apiCallId = publicOpaqueCorrelation("usage:api", event.data?.apiCallId);
    const serviceRequestId = publicOpaqueCorrelation("usage:service", event.data?.serviceRequestId);
    const providerCallId = publicOpaqueCorrelation("usage:provider", event.data?.providerCallId);
    const usageAliases = [
      event.data?.apiCallId === undefined ? undefined : privateCorrelationKey("usage:api", event.data.apiCallId),
      event.data?.serviceRequestId === undefined ? undefined : privateCorrelationKey("usage:service", event.data.serviceRequestId),
      event.data?.providerCallId === undefined ? undefined : privateCorrelationKey("usage:provider", event.data.providerCallId),
      event.id === undefined ? undefined : privateCorrelationKey("usage:event", event.id),
    ].filter((value): value is string => value !== undefined);
    const replay = usageAliases.some((alias) => run.seenUsageIds.has(alias));
    for (const alias of usageAliases) {
      if (!run.seenUsageIds.has(alias) && run.seenUsageIds.size >= 512) {
        const oldest = run.seenUsageIds.values().next().value as string | undefined;
        if (oldest) run.seenUsageIds.delete(oldest);
      }
      run.seenUsageIds.add(alias);
    }
    if (replay) return;
    const inputTokens = nativeCounter(event.data?.inputTokens);
    const outputTokens = nativeCounter(event.data?.outputTokens);
    const reasoningTokens = nativeCounter(event.data?.reasoningTokens);
    const cacheReadTokens = nativeCounter(event.data?.cacheReadTokens);
    const cacheWriteTokens = nativeCounter(event.data?.cacheWriteTokens);
    const usage: CopilotCoordinatorNativeUsage = {
      ...(inputTokens === undefined ? {} : { inputTokens }),
      ...(outputTokens === undefined ? {} : { outputTokens }),
      ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
      ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
      ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
      ...(inputTokens === undefined || outputTokens === undefined ? {} : { totalTokens: inputTokens + outputTokens }),
    };
    observeLifecycleModel(run, event.data?.model, "observed", event);
    observeLifecycleReasoning(run, event.data?.reasoningEffort, "observed", event);
    emitLifecycle({
      ...correlation(run, "observed", event),
      type: "run.usage",
      ...(apiCallId === undefined ? {} : { apiCallId }),
      ...(serviceRequestId === undefined ? {} : { serviceRequestId }),
      ...(providerCallId === undefined ? {} : { providerCallId }),
      ...(run.model === undefined ? {} : { model: run.model }),
      ...(run.reasoningEffort === undefined ? {} : { reasoningEffort: run.reasoningEffort }),
      usage,
    });
  };

  const finishTaskNow = (
    input: PostToolHookInput | PostToolFailureHookInput,
    sessionId: string,
    outcome: "completed" | "failed",
  ): void => {
    if (input.toolName !== "task") return;
    const item = pending.get(sessionId);
    if (item) {
      const base = {
        harness: "copilot" as const,
        agent: item.agent,
        runtimeAgent: item.runtimeAgent,
        parentSessionId: sessionId,
        childId: item.childId,
        invocationId: item.lifecycle.invocationId,
      };
      if (!item.childId) {
        emitHarborEvidence(evidenceHook, { ...base, phase: "child.started", outcome: "ok", basis: "inferred" });
        emitHarborEvidence(evidenceHook, { ...base, phase: "prompt.attempted", outcome: "ok", basis: "inferred" });
      }
      if (outcome === "completed") {
        const result = serialized((input as PostToolHookInput).toolResult);
        emitHarborEvidence(evidenceHook, { ...base, phase: "evidence.returned", outcome: "ok", evidence: fingerprintHarborEvidence(result) });
        emitHarborEvidence(evidenceHook, { ...base, phase: "child.completed", outcome: "ok" });
      } else {
        const error = (input as PostToolFailureHookInput).error;
        emitHarborEvidence(evidenceHook, {
          ...base,
          phase: "child.failed",
          outcome: "error",
          error: error === undefined
            ? item.errorFingerprint ?? fingerprintHarborEvidence("Copilot task failed")
            : fingerprintHarborEvidence(error),
        });
      }
      emitHarborEvidence(evidenceHook, { ...base, phase: "child.cleaned", outcome: "ok", basis: "inferred" });
      finishLifecycle(item.lifecycle, outcome, item.terminal ? "observed" : "inferred");
      const root = activeRoots.get(sessionId);
      if (root && !root.finished) setLifecycleState(root, "working", "inferred");
      pending.delete(sessionId);
    }
    inFlight.delete(sessionId);
  };

  const finishTask = async (
    input: PostToolHookInput | PostToolFailureHookInput,
    sessionId: string,
    outcome: "completed" | "failed",
  ): Promise<void> => {
    await locked(() => { finishTaskNow(input, sessionId, outcome); });
  };

  const finishSessionLifecycle = (
    rootOutcome: "completed" | "failed" | "cancelled",
    event: CopilotCoordinatorHostEvent,
  ): void => {
    const root = latestRootLifecycle();
    const sessionId = root?.sessionId ?? [...pending.keys()].at(-1);
    if (sessionId) {
      const item = pending.get(sessionId);
      if (item && !item.lifecycle.finished) {
        finishLifecycle(
          item.lifecycle,
          rootOutcome === "cancelled" ? "cancelled" : "failed",
          "inferred",
          event,
        );
      }
      pending.delete(sessionId);
      inFlight.delete(sessionId);
      counts.delete(sessionId);
    }
    unclaimedTaskCalls.length = 0;
    if (root) {
      finishLifecycle(root, rootOutcome, "observed", event);
      activeRoots.delete(root.sessionId);
    }
  };

  const refreshSnapshot = async (expectedCurrentId?: string, requirePublication = false): Promise<void> => {
    const strict = requirePublication || expectedCurrentId !== undefined;
    const generation = ++refreshEpoch;
    let refreshSelectionEpoch = 0;
    const currentGeneration = await locked(() => {
      if (generation !== refreshEpoch) return false;
      refreshSelectionEpoch = selectionEpoch;
      snapshot = { ready: false, current: snapshot.current, agents: [] };
      return true;
    });
    if (!currentGeneration) {
      if (strict) throw new Error(expectedCurrentId === undefined
        ? "Copilot coordinator snapshot refresh was superseded"
        : "Copilot coordinator selection synchronization was superseded");
      return;
    }
    try {
      const listed = await boundedCoordinatorRpc("Copilot agent registry reload", () => getSession().rpc.agent.reload());
      const current = await boundedCoordinatorRpc("Copilot current agent read", () => getSession().rpc.agent.getCurrent());
      if (expectedCurrentId !== undefined && current.agent?.id !== expectedCurrentId) {
        throw new Error(`Copilot selected agent did not stabilize as ${expectedCurrentId}`);
      }
      const publication = await locked((): "published" | "stale" | "selection-changed" => {
        if (generation !== refreshEpoch) return "stale";
        const selected = selectionEpoch === refreshSelectionEpoch
          ? current.agent ?? undefined
          : snapshot.current;
        if (expectedCurrentId !== undefined && selected?.id !== expectedCurrentId) {
          snapshot = { ready: false, current: selected, agents: [] };
          return "selection-changed";
        }
        snapshot = {
          ready: true,
          current: selected,
          agents: [...listed.agents],
        };
        return "published";
      });
      if (publication !== "published" && strict) {
        throw new Error(publication === "stale"
          ? expectedCurrentId === undefined
            ? "Copilot coordinator snapshot refresh was superseded"
            : "Copilot coordinator selection synchronization was superseded"
          : `Copilot selected agent changed before ${expectedCurrentId} was synchronized`);
      }
    } catch (error) {
      const publishedFailure = await locked(() => {
        if (generation !== refreshEpoch) return false;
        snapshot = {
          ready: false,
          current: selectionEpoch === refreshSelectionEpoch ? undefined : snapshot.current,
          agents: [],
        };
        return true;
      });
      // A newer refresh owns the snapshot and its result supersedes this one.
      if (publishedFailure || strict) throw error;
    }
  };
  const refresh = (expectedCurrentId?: string): Promise<void> => refreshSnapshot(expectedCurrentId);
  const refreshAuthoritative = (): Promise<void> => refreshSnapshot(undefined, true);

  const hooks: CopilotCoordinatorHooks = {
    onUserPromptSubmitted: async (input, invocation) => {
      if (input.sessionId !== invocation.sessionId) return;
      const currentRoot = activeRoots.get(invocation.sessionId);
      if (currentRoot && !currentRoot.finished) return;
      const selectionEpochBeforeRead = selectionEpoch;
      let authoritativeCurrent: CopilotAgentIdentity | undefined;
      let authoritativeRead = false;
      try {
        authoritativeCurrent = (await boundedCoordinatorRpc(
          "Copilot prompt agent observation",
          () => getSession().rpc.agent.getCurrent(),
          Math.min(coordinatorRpcTimeoutMs(), 500),
        )).agent ?? undefined;
        authoritativeRead = true;
      } catch { /* Best-effort observation falls back after its short independent deadline. */ }
      await locked(() => {
        const previousRoot = activeRoots.get(invocation.sessionId);
        if (previousRoot && !previousRoot.finished) {
          // Copilot can steer or queue another user prompt while a turn/child is
          // active. It remains the same root until a native session terminal.
          return;
        }
        const previousChild = pending.get(invocation.sessionId);
        if (previousChild) finishLifecycle(previousChild.lifecycle, "cancelled", "inferred");
        counts.delete(invocation.sessionId);
        inFlight.delete(invocation.sessionId);
        pending.delete(invocation.sessionId);
        unclaimedTaskCalls.length = 0;
        let player: { agent: string; runtimeAgent: string; model?: string } | undefined;
        if (authoritativeRead && selectionEpoch === selectionEpochBeforeRead) {
          if (snapshot.current?.id !== authoritativeCurrent?.id) selectionEpoch += 1;
          snapshot.current = authoritativeCurrent;
          player = harborPlayerForIdentity(input.workingDirectory, authoritativeCurrent);
        } else {
          // A native selection event observed while the RPC was pending is
          // newer than the read's starting generation and remains authoritative.
          player = selectedHarborPlayer(input.workingDirectory);
        }
        if (player) startRootLifecycle(
          invocation.sessionId,
          input.workingDirectory,
          copilotTaskLabel(input.prompt ?? ""),
          player,
          "observed",
        );
      });
    },
    onPreToolUse: async (input, invocation) => {
      if (input.toolName !== "task") return;
      const teamLeadId = copilotFixedAgentIds.get("team-lead")!;
      let authoritativeCurrent: CopilotAgentIdentity | undefined;
      try {
        authoritativeCurrent = (await boundedCoordinatorRpc(
          "Copilot current agent verification",
          () => getSession().rpc.agent.getCurrent(),
        )).agent ?? undefined;
      } catch (error) {
        return deny(`Agent Harbor cannot verify the current agent and fails closed for task delegation: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (authoritativeCurrent?.id !== teamLeadId) {
        await locked(() => {
          if (snapshot.current?.id !== authoritativeCurrent?.id) selectionEpoch += 1;
          snapshot.current = authoritativeCurrent;
        });
        return;
      }
      const activeRoot = activeRoots.get(invocation.sessionId);
      if (activeRoot && !activeRoot.finished) markLifecycleActivity(activeRoot);
      try {
        await refresh(teamLeadId);
      } catch (error) {
        return deny(`Agent Harbor coordinator snapshot is unavailable; reload the session: ${error instanceof Error ? error.message : String(error)}`);
      }
      return locked(async () => {
        try {
          if (!snapshot.ready) return deny("Agent Harbor coordinator snapshot is unavailable; reload the session");
          if (snapshot.current?.id !== teamLeadId) return deny("Agent Harbor team-lead selection changed during delegation preflight");
          const invocationId = unclaimedTaskCalls.shift();
          const publicInvocationId = publicOpaqueCorrelation("tool", invocationId);
          if (input.sessionId !== invocation.sessionId) {
            return deny("Agent Harbor blocks nested coordinator delegation");
          }
          const args = structuredToolArgs(input.toolArgs);
          if (!args) {
            return deny("Agent Harbor task arguments must be a bounded object");
          }
          const agentType = typeof args.agent_type === "string" ? args.agent_type.trim() : "";
          const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
          if (!agentType) return deny("Agent Harbor delegation requires an exact agent_type");
          if (!isHarborId(agentType) && ![...copilotFixedAgentIds.values()].includes(agentType)) {
            return deny("Agent Harbor delegation requires a canonical agent_type");
          }
          if (!prompt) return deny("Agent Harbor delegation requires a non-empty prompt");
          if (Buffer.byteLength(prompt, "utf8") > 30_000) return deny("Agent Harbor delegation prompt exceeds 30000 bytes");
          if (agentType === "team-lead" || agentType === copilotFixedAgentIds.get("team-lead")) {
            return deny("Agent Harbor cannot recursively invoke team-lead");
          }
          if (inFlight.has(invocation.sessionId)) {
            return deny("Agent Harbor coordinator delegations must run sequentially");
          }
          const count = counts.get(invocation.sessionId) ?? 0;
          if (count >= 6) return deny("Agent Harbor allows at most six delegations per user prompt");

          const fixed = [...copilotFixedAgentIds].find(([, exact]) => exact === agentType);
          const logicalId = fixed?.[0] ?? agentType;
          let target: CopilotAgentIdentity;
          try { target = resolveCopilotPlayer(logicalId, snapshot.agents, input.workingDirectory); }
          catch (error) { return deny(error instanceof Error ? error.message : String(error)); }
          if (target.id !== agentType) return deny(`Agent Harbor requires exact agent_type ${target.id}`);
          if (target.userInvocable === false) return deny(`Agent Harbor player is not invocable: ${logicalId}`);

          const root = activeRoots.get(invocation.sessionId) ?? startRootLifecycle(
            invocation.sessionId,
            input.workingDirectory,
            "(task not disclosed)",
            { agent: "team-lead", runtimeAgent: copilotFixedAgentIds.get("team-lead")! },
            "inferred",
          );
          const childRunId = `copilot-child-${++lifecycleSequence}`;
          const lifecycle: MutableCopilotLifecycleRun = {
            sessionId: invocation.sessionId,
            project: input.workingDirectory,
            runId: childRunId,
            rootRunId: root.rootRunId,
            parentRunId: root.runId,
            kind: "child",
            agent: logicalId,
            runtimeAgent: target.id,
            taskLabel: copilotTaskLabel(prompt),
            ...(publicInvocationId === undefined ? {} : { invocationId: publicInvocationId }),
            started: false,
            finished: false,
            startedAt: Date.now(),
            observedActivity: false,
            observedEventIds: new Set(),
            seenUsageIds: new Set(),
          };
          admissionHook?.({
            type: "child",
            project: input.workingDirectory,
            rootRunId: root.rootRunId,
            parentRunId: root.runId,
            runId: lifecycle.runId,
            agent: logicalId,
            runtimeAgent: target.id,
            taskLabel: lifecycle.taskLabel,
          });
          counts.set(invocation.sessionId, count + 1);
          inFlight.add(invocation.sessionId);
          pending.set(invocation.sessionId, { agent: logicalId, runtimeAgent: target.id, invocationId, lifecycle });
          setLifecycleState(root, "waiting", "observed");
          emitHarborEvidence(evidenceHook, {
            harness: "copilot",
            phase: "target.resolved",
            agent: logicalId,
            runtimeAgent: target.id,
            parentSessionId: invocation.sessionId,
            invocationId: publicInvocationId,
            outcome: "ok",
            task: fingerprintHarborEvidence(prompt),
          });
          return { permissionDecision: "allow" as const };
        } catch (error) {
          return deny(`Agent Harbor delegation preflight failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      });
    },
    onPostToolUse: async (input, invocation) => finishTask(input, invocation.sessionId, "completed"),
    onPostToolUseFailure: async (input, invocation) => finishTask(input, invocation.sessionId, "failed"),
  };
  return {
    hooks,
    refresh,
    refreshAuthoritative,
    observeEvent: (event) => {
      extendLifecycleEventChain(event);
      if (
        event.type === "assistant.turn_start" ||
        event.type === "assistant.usage" ||
        event.type === "assistant.message" ||
        event.type === "assistant.idle" ||
        event.type === "tool.execution_start" ||
        event.type === "tool.execution_complete" ||
        event.type === "subagent.started" ||
        event.type === "subagent.completed" ||
        event.type === "subagent.failed" ||
        event.type === "abort"
      ) {
        const activityRun = lifecycleRunForEvent(event);
        if (activityRun && lifecycleEventBelongsToRun(activityRun, event)) markLifecycleActivity(activityRun, event);
      }
      if (event.type === "session.start") {
        selectedModel = publicCopilotMetadata(event.data?.selectedModel);
        selectedReasoningEffort = event.data?.reasoningEffort === null
          ? null
          : publicCopilotMetadata(event.data?.reasoningEffort, 40);
      }
      if (event.type === "subagent.selected" && !event.agentId && event.data?.agentName) {
        selectionEpoch += 1;
        snapshot.current = {
          id: copilotFixedAgentIds.get(event.data.agentName) ?? event.data.agentName,
          userInvocable: true,
        };
      } else if (event.type === "subagent.deselected" && !event.agentId) {
        selectionEpoch += 1;
        snapshot.current = undefined;
      }

      if (event.type === "assistant.turn_start") {
        const run = lifecycleRunForEvent(event);
        if (run && lifecycleEventBelongsToRun(run, event)) {
          run.turnId = publicCopilotMetadata(event.data?.turnId) ?? run.turnId;
          if (event.agentId) run.childId = publicOpaqueCorrelation("child", event.agentId) ?? run.childId;
          if (!run.started) startLifecycle(run, "observed", event, event.data?.model);
          setLifecycleState(run, "working", "observed", event);
          observeLifecycleModel(run, event.data?.model, "observed", event);
        }
      } else if (event.type === "session.model_change") {
        const run = lifecycleRunForEvent(event);
        const model = publicCopilotMetadata(event.data?.newModel);
        const effort = event.data?.reasoningEffort === null
          ? null
          : publicCopilotMetadata(event.data?.reasoningEffort, 40);
        if (!event.agentId) {
          if (model) selectedModel = model;
          if (effort !== undefined) selectedReasoningEffort = effort;
        }
        if (run && lifecycleEventBelongsToRun(run, event)) {
          if (!run.started) startLifecycle(run, "inferred", event, model);
          observeLifecycleModel(run, model, "observed", event);
          observeLifecycleReasoning(run, effort, "observed", event);
        }
      } else if (event.type === "assistant.usage") {
        const run = lifecycleRunForEvent(event);
        if (run && lifecycleEventBelongsToRun(run, event)) {
          if (event.agentId) run.childId = publicOpaqueCorrelation("child", event.agentId) ?? run.childId;
          if (!run.started) startLifecycle(run, "inferred", event, event.data?.model);
        }
        observeLifecycleUsage(event);
      } else if (event.type === "assistant.idle") {
        const run = lifecycleRunForEvent(event);
        if (run && lifecycleEventBelongsToRun(run, event)) {
          if (!run.started) startLifecycle(run, "inferred", event, event.data?.model);
          setLifecycleState(run, "idle", "observed", event);
        }
      } else if (event.type === "abort") {
        const run = lifecycleRunForEvent(event);
        if (run && lifecycleEventBelongsToRun(run, event)) {
          if (!run.started) startLifecycle(run, "inferred", event, event.data?.model);
          setLifecycleState(run, "cancelling", "observed", event);
        }
      } else if (event.type === "session.idle") {
        const root = latestRootLifecycle();
        if (!event.agentId && !event.data?.parentToolCallId && root && sessionIdleBelongsToRoot(root, event)) {
          finishSessionLifecycle(event.data?.aborted === true ? "cancelled" : "completed", event);
        }
      } else if (event.type === "session.error") {
        const root = latestRootLifecycle();
        if (!event.agentId && !event.data?.parentToolCallId && (!root || lifecycleEventBelongsToRun(root, event))) {
          finishSessionLifecycle("failed", event);
        }
      } else if (event.type === "session.shutdown") {
        const root = latestRootLifecycle();
        if (!event.agentId && !event.data?.parentToolCallId && (!root || lifecycleEventBelongsToRun(root, event))) {
          finishSessionLifecycle(event.data?.shutdownType === "error" ? "failed" : "cancelled", event);
        }
      }

      const entries = [...pending.entries()];
      const toolCallId = event.data?.toolCallId;
      if (event.type === "tool.execution_start" && !event.agentId && event.data?.toolName === "task" && toolCallId) {
        const uncorrelated = entries.filter(([, state]) => !state.invocationId);
        if (uncorrelated.length === 1) {
          uncorrelated[0][1].invocationId = toolCallId;
          uncorrelated[0][1].lifecycle.invocationId = publicOpaqueCorrelation("tool", toolCallId);
        }
        else if (snapshot.current?.id === copilotFixedAgentIds.get("team-lead")) unclaimedTaskCalls.push(toolCallId);
        return;
      }

      const item = toolCallId
        ? entries.find(([, state]) => state.invocationId === toolCallId)
        : event.type === "tool.execution_complete" && event.data?.toolDescription?.name === "task" && entries.length === 1
          ? entries[0]
          : undefined;
      if (!item) return;
      const [sessionId, state] = item;
      if (event.type === "subagent.started" && event.data?.agentName === state.runtimeAgent && toolCallId === state.invocationId) {
        state.childId = event.agentId;
        state.lifecycle.childId = publicOpaqueCorrelation("child", event.agentId);
        state.lifecycle.invocationId = publicOpaqueCorrelation("tool", toolCallId) ?? state.lifecycle.invocationId;
        startLifecycle(state.lifecycle, "observed", event, event.data?.model);
        setLifecycleState(state.lifecycle, "working", "observed", event);
        observeLifecycleModel(state.lifecycle, event.data?.model, "observed", event);
        const base = {
          harness: "copilot" as const,
          agent: state.agent,
          runtimeAgent: state.runtimeAgent,
          parentSessionId: sessionId,
          childId: state.lifecycle.childId,
          invocationId: state.lifecycle.invocationId,
        };
        emitHarborEvidence(evidenceHook, { ...base, phase: "child.started", outcome: "ok" });
        emitHarborEvidence(evidenceHook, { ...base, phase: "prompt.attempted", outcome: "ok" });
      } else if (event.type === "subagent.completed" && event.data?.agentName === state.runtimeAgent && toolCallId === state.invocationId) {
        state.terminal = "completed";
        observeLifecycleModel(state.lifecycle, event.data?.model, "observed", event);
        finishLifecycle(state.lifecycle, "completed", "observed", event, event.data);
        const root = activeRoots.get(sessionId);
        if (root) setLifecycleState(root, "working", "observed", event);
      } else if (event.type === "subagent.failed" && event.data?.agentName === state.runtimeAgent && toolCallId === state.invocationId) {
        state.terminal = "failed";
        state.errorFingerprint = fingerprintHarborEvidence(serialized(event.data.error));
        observeLifecycleModel(state.lifecycle, event.data?.model, "observed", event);
        finishLifecycle(state.lifecycle, "failed", "observed", event, event.data);
        const root = activeRoots.get(sessionId);
        if (root) setLifecycleState(root, "working", "observed", event);
      } else if (event.type === "tool.execution_complete" && !event.agentId && (
        event.data?.toolDescription?.name === "task" ||
        Boolean(state.invocationId && event.data?.toolCallId === state.invocationId)
      )) {
        const data = event.data!;
        const result = serialized(data.result);
        const input: PostToolHookInput = {
          sessionId,
          workingDirectory: "",
          toolName: "task",
          toolArgs: {},
          toolResult: result,
        };
        // Host events are observed synchronously. Finalize the child before a
        // contiguous session.idle can infer a contradictory failure.
        finishTaskNow(input, sessionId, data.success === false || state.terminal === "failed" ? "failed" : "completed");
      }
    },
  };
}
