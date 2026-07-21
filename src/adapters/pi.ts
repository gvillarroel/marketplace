/** Pi extension entrypoint, zero-model controls, live team status, and delegation. */
import { resolve } from "node:path";
import * as hostPiSdk from "@earendil-works/pi-coding-agent";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  Model,
  ProviderConfig,
  ThinkingLevel,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { listInvocablePlayers, listManagedActiveIds, loadPiActivePlayer } from "../core/active.js";
import { parseContractDefinition } from "../core/commands.js";
import {
  assertHarborCustomToolAccess,
  formatHarborTeamRosterSnapshot,
  harborCustomToolNames,
  harborCustomToolPolicy,
  harborStaticCustomToolSpecs,
  HarborScoutTurnGuard,
  validateHarborCustomToolArguments,
} from "../core/custom-tools.js";
import { bundledPlayers, rolePlayers, scoutPlayer, trustedSkills } from "../core/defaults.js";
import { GhResolver } from "../core/github.js";
import { commandNames, type ContractDefinition, type PlayerDefinition } from "../core/types.js";
import { wrapPlainText } from "../core/text-layout.js";
import { normalizeDelegatedTaskPaths } from "../core/profiles.js";
import { publicErrorText, publicMetadataText } from "../core/public-metadata.js";
import { filterTrustedSkills, formatScoutSkillMatches } from "../core/scout.js";
import { PiOrchestrator, type PiSessionOptions } from "../orchestrators/pi.js";
import { runDeterministicCommand } from "./direct.js";
import {
  formatPiLiveStatus,
  formatPiLiveWidget,
  formatPiMissionReport,
  PiTeamRuntime,
  settlePiRootPromises,
  type PiRunObserver,
  type PiTeamMemberKind,
} from "./pi-team-runtime.js";
import { collectPiTeamMembers, formatPiTeamView } from "./pi-team-view.js";

type NoticeLevel = "info" | "warning" | "error";
const preflightZeroLine = "Preflight stopped · no model was called · 0 model tokens.";
const maximumConcurrentPiRoots = 32;
const maximumPiCompletionItems = 50;
const piCompletionCacheTtlMs = 750;
const maximumPiTaskBytes = 30_000;
const maximumPiFilterBytes = 4_096;
const maximumPiDefinitionBytes = 100_000;

interface StartedPiRun {
  readonly runId: string;
  readonly result: Promise<string>;
}

const commandSyntax: Record<string, string> = {
  team: "/team [filter|stop <run-id|all>]",
  bench: "/bench [list [filter]|on <id...>|off <id...>]",
  join: "/join {\"name\":\"...\",\"description\":\"...\",\"prompt\":\"...\",\"tools\":[\"read\"]}",
  retire: "/retire <personal-id>",
  contract: "/contract {\"name\":\"...\",...,\"task\":\"...\"}",
  "list-skills": "/list-skills [--descriptions|-d] [filter]",
  scout: "/scout <capability needed>",
};

function cancellation(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true || (error instanceof Error && error.name === "AbortError");
}

function modelIdentity(model: Model | undefined): { provider: string; id: string } | undefined {
  return model === undefined ? undefined : { provider: model.provider, id: model.id };
}

function boundedPiModelPart(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 200) return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

function isPiOfflinePlaceholder(model: Model | undefined): boolean {
  if (model === undefined) return false;
  const provider = boundedPiModelPart(model.provider)?.toLowerCase();
  const id = boundedPiModelPart(model.id ?? (model as unknown as { readonly model?: unknown }).model)?.toLowerCase();
  const api = boundedPiModelPart((model as unknown as { readonly api?: unknown }).api)?.toLowerCase();
  return provider === "unknown" && (id === "unknown" || id === "default") &&
    (api === undefined || api === "unknown") && model.maxTokens === 0;
}

function resolveInheritedPiModel(ctx: ExtensionContext): Model {
  // Pi exposes model through a live getter. Capture one coherent command-time
  // value so a concurrent host selection cannot split this preflight.
  const current = ctx.model;
  const registry = ctx.modelRegistry as {
    readonly getAvailable?: () => readonly Model[];
    readonly getError?: () => string | undefined;
    readonly hasConfiguredAuth?: (model: Model) => boolean;
  } | undefined;
  if (current === undefined || isPiOfflinePlaceholder(current)) {
    try {
      if (typeof registry?.getAvailable === "function" && typeof registry.getError === "function") {
        const available = registry.getAvailable();
        const registryError = registry.getError();
        if (registryError === undefined && Array.isArray(available)) {
          if (available.length > 0) {
            throw new Error(`Pi has ${available.length} usable model${available.length === 1 ? "" : "s"}, but none is selected. Use /model to select one before running Agent Harbor work`);
          }
          throw new Error("Pi reports no usable authenticated model. Use /login to configure a provider, then /model to select it");
        }
      }
    } catch (error) {
      if (error instanceof Error && /^Pi (?:has|reports) /u.test(error.message)) throw error;
    }
    throw new Error("Pi has no active model and model availability is unobserved. Use /model to select one or /login to configure a provider");
  }

  const provider = boundedPiModelPart(current.provider) ?? "unknown";
  const id = boundedPiModelPart(current.id) ?? "unknown";
  if (typeof registry?.hasConfiguredAuth === "function" && !registry.hasConfiguredAuth(current)) {
    throw new Error(`selected Pi model has no configured authentication: ${provider}/${id}. Use /login ${provider} or select another model with /model`);
  }
  if (typeof registry?.getAvailable === "function" && typeof registry.getError === "function") {
    try {
      const available = registry.getAvailable();
      if (registry.getError() === undefined && Array.isArray(available) &&
          !available.some((model) => model.provider === current.provider && model.id === current.id)) {
        throw new Error(`selected Pi model is no longer available: ${provider}/${id}. Use /model to select an available authenticated model`);
      }
    } catch (error) {
      if (error instanceof Error && /^selected Pi model /u.test(error.message)) throw error;
    }
  }
  return current;
}

function resolveConfiguredPiModel(configured: string | undefined, ctx: ExtensionContext): Model {
  if (configured === undefined) return resolveInheritedPiModel(ctx);
  const separator = configured.indexOf("/");
  const provider = separator > 0 ? configured.slice(0, separator) : undefined;
  const id = separator > 0 ? configured.slice(separator + 1) : undefined;
  if (!provider || !id) throw new Error(`configured Pi model must use provider/model syntax: ${configured}`);
  const resolved = ctx.modelRegistry?.find(provider, id);
  if (!resolved) throw new Error(`configured Pi model is unavailable: ${provider}/${id}`);
  if (ctx.modelRegistry.hasConfiguredAuth && !ctx.modelRegistry.hasConfiguredAuth(resolved)) {
    throw new Error(`configured Pi model has no available authentication: ${provider}/${id}`);
  }
  return resolved;
}

function configuredPiProvider(route: string): string {
  const separator = route.indexOf("/");
  const provider = separator > 0 ? boundedPiModelPart(route.slice(0, separator)) : undefined;
  const id = separator > 0 ? boundedPiModelPart(route.slice(separator + 1)) : undefined;
  if (!provider || !id) throw new Error(`configured Pi model must use provider/model syntax: ${route}`);
  return provider;
}

async function capturePiProviderProjections(
  ctx: ExtensionContext,
  requiredProviderIds: readonly string[],
): Promise<NonNullable<PiSessionOptions["providerProjections"]>> {
  const registry = ctx.modelRegistry as {
    readonly getRegisteredProviderConfig?: (providerId: string) => ProviderConfig | undefined;
    readonly getProviderAuthStatus?: (providerId: string) => { readonly source?: string };
    readonly getApiKeyForProvider?: (providerId: string) => Promise<string | undefined>;
  } | undefined;
  const projections: Array<NonNullable<PiSessionOptions["providerProjections"]>[number]> = [];
  const seen = new Set<string>();
  for (const rawProviderId of requiredProviderIds) {
    const providerId = boundedPiModelPart(rawProviderId);
    if (!providerId || seen.has(providerId)) continue;
    seen.add(providerId);
    let config: ProviderConfig | undefined;
    try { config = registry?.getRegisteredProviderConfig?.(providerId); }
    catch { throw new Error(`Pi could not inspect the registered provider configuration for ${providerId}`); }
    let runtimeKey: string | undefined;
    let authSource: string | undefined;
    try { authSource = registry?.getProviderAuthStatus?.(providerId)?.source; }
    catch { throw new Error(`Pi could not inspect authentication for provider ${providerId}`); }
    if (authSource === "runtime") {
      if (typeof registry?.getApiKeyForProvider !== "function") {
        throw new Error(`Pi cannot transfer runtime-only authentication for provider ${providerId}`);
      }
      try { runtimeKey = await registry.getApiKeyForProvider(providerId); }
      catch { throw new Error(`Pi could not transfer runtime-only authentication for provider ${providerId}`); }
      if (!runtimeKey) throw new Error(`Pi runtime-only authentication is unavailable for provider ${providerId}`);
    }
    if (config === undefined && runtimeKey === undefined) continue;
    projections.push({
      id: providerId,
      ...(config === undefined ? {} : { config: { ...config } }),
      ...(runtimeKey === undefined ? {} : { runtimeKey }),
    });
  }
  return projections;
}

function playerKind(player: PlayerDefinition): PiTeamMemberKind {
  if (player.name === "team-lead") return "manager";
  if (player.name === scoutPlayer.name) return "utility";
  if (rolePlayers.has(player.name)) return "fixed";
  if (bundledPlayers.has(player.name)) return "bundled";
  return "personal";
}

function safeUi(action: () => void): void {
  try { action(); } catch { /* A presentation failure must not change command semantics. */ }
}

function notify(ctx: ExtensionCommandContext | ExtensionContext, message: string, level: NoticeLevel): void {
  ctx.ui.notify(message, level);
}

function failCommand(ctx: ExtensionCommandContext, message: string): void {
  // TUI owns presentation. Headless modes instead get one structured command
  // failure, without a duplicate extension_ui_request notification.
  if (ctx.mode === undefined || ctx.mode === "tui") {
    notify(ctx, message, "error");
    return;
  }
  throw new Error(message);
}

/** Public model/tool boundary: preserve cancellation identity, never a raw cause. */
function publicPiToolFailure(error: unknown): Error {
  const raw = error instanceof Error ? error.message : String(error);
  const visible = new Error(publicErrorText(raw, 600) ?? "Agent Harbor tool failed safely");
  visible.name = error instanceof Error && error.name === "AbortError"
    ? "AbortError"
    : publicMetadataText(error instanceof Error ? error.name : "Error", 80) ?? "Error";
  return visible;
}

function zeroModelResult(command: string, result: string): string {
  return wrapPlainText(`Agent Harbor /${command} · 0 model tokens\n${result}`);
}

function stopResult(result: string): string {
  return wrapPlainText(`Agent Harbor stop · 0 model tokens\n${result}`);
}

function requireBoundedArguments(value: string, maximumBytes: number, label: string): string {
  if (value.length > maximumBytes || Buffer.byteLength(value, "utf8") > maximumBytes) {
    throw new Error(`Agent Harbor ${label} exceeds ${maximumBytes} bytes`);
  }
  return value;
}

function commandHelp(command: string): string {
  const syntax = commandSyntax[command] ?? `/${command} <task>`;
  const cost = command === "contract" ? "exactly 1 model child"
    : command === "scout" ? "1 recruiter model child"
      : command === "team-lead" ? "1 lead + up to 6 sequential specialist children"
        : rolePlayers.has(command) || bundledPlayers.has(command) || !commandSyntax[command]
          ? "1 model child when active"
          : "0 model tokens";
  return `Usage: ${syntax}\nCost: ${cost}.`;
}

function humanError(command: string, error: unknown, deterministic = false): string {
  const raw = error instanceof Error ? error.message : String(error);
  const rawPrefix = raw.length > 4_096 ? raw.slice(0, 4_096) : raw;
  if (/active managed player preflight failed/iu.test(rawPrefix)) {
    return [
      `/${command} is no longer active or current in this Pi session.`,
      preflightZeroLine,
      commandHelp(command),
      "Run /team to inspect the roster, then /reload to remove stale aliases.",
    ].join("\n");
  }
  let message = publicErrorText(raw, 600, [`/${command}`, "/login", "/model"])
    ?? "Agent Harbor command failed.";
  if (error instanceof SyntaxError || /JSON/u.test(error instanceof Error ? error.name : "")) {
    message = `Invalid JSON for /${command}. Expected exactly one JSON object.`;
  } else if (/usage:/iu.test(rawPrefix)) {
    return `${commandHelp(command)}${deterministic ? "\nNo model was called." : ""}`;
  }
  return deterministic
    ? `${message}\nUsage: ${commandSyntax[command] ?? `/${command}`}\nNo model was called · 0 model tokens.`
    : `${message}\n${commandHelp(command)}`;
}

function modelPreflightError(command: string, error: unknown): string {
  const message = humanError(command, error);
  return message.includes(preflightZeroLine) ? message : `${message}\n${preflightZeroLine}`;
}

function withoutViewHeader(view: string): string {
  return view.split(/\r?\n/gu).slice(1).join("\n");
}

function conciseLifecycleResult(command: string, args: string, raw: string): string {
  if (command === "join") {
    const input = JSON.parse(args) as {
      name: string;
      description: string;
      tools: string[];
      skills?: Array<{ name: string }>;
      model?: string;
    };
    const capacity = [
      ...input.tools,
      ...(input.skills ?? []).map(({ name }) => `skill:${name}`),
    ];
    const id = publicMetadataText(input.name, 48) ?? "joined-player";
    const role = publicMetadataText(input.description, 240) ?? "Personal Agent Harbor teammate";
    const model = publicMetadataText(input.model ?? "", 200);
    return [
      `✓ ${id} joined · personal · ready in this project`,
      `Role: ${role}`,
      `Capacity: ${capacity.join(", ") || "advisory"}`,
      `Model: ${model ? `configured ${model}` : "inherits the Pi host when run"}`,
      `Run: /${id} <task>`,
    ].join("\n");
  }
  if (command === "retire") {
    const id = args.trim();
    return [
      `✓ ${id} unregistered and deactivated here.`,
      "Other project copies, if any, remain intentionally untouched.",
      "Pi cannot unregister this session's alias in-place; run /reload to remove it from completion.",
    ].join("\n");
  }
  return raw;
}

function benchListFilter(args: string): string | undefined {
  const value = args.trim();
  if (!value || value === "list") return "";
  return value.startsWith("list ") ? value.slice(5).trim() : undefined;
}

const benchAllNote = "Here, all means the six bundled SDLC specialists only; personal members are unchanged.";

function compactPublicText(value: string, limit: number): string {
  return publicMetadataText(value, limit) ?? "not disclosed";
}

function sameProject(left: string, right: string): boolean {
  const normalize = (value: string): string => process.platform === "win32"
    ? resolve(value).replace(/\\/gu, "/").replace(/\/$/u, "").toLowerCase()
    : resolve(value).replace(/\/$/u, "");
  return normalize(left) === normalize(right);
}

function childToolProject(context: ExtensionContext | undefined, expected: string): string {
  const project = context?.cwd || expected;
  if (!sameProject(project, expected)) {
    throw new Error("Agent Harbor child custom tool cannot cross its invocation project boundary");
  }
  return project;
}

function leadRosterPreviewRow(definition: PlayerDefinition, busy = false): string {
  const capacity = [
    ...definition.tools,
    ...(definition.skills ?? []).map(({ name }) => `skill:${name}`),
  ].slice(0, 6);
  return JSON.stringify({
    id: definition.name,
    state: busy ? "busy" : "ready",
    role: compactPublicText(definition.description, 48),
    capacity,
  });
}

function boundedLeadRoster(rows: readonly string[], maximumCharacters = 1_500): string {
  const shown: string[] = [];
  let length = 0;
  for (const row of rows) {
    const increment = row.length + (shown.length ? 2 : 0);
    if (length + increment > maximumCharacters) break;
    shown.push(row);
    length += increment;
  }
  const omitted = rows.length - shown.length;
  return `${shown.join("; ")}${omitted ? `; +${omitted} more enabled specialists omitted from this preview` : ""}`;
}

/**
 * Registers Agent Harbor's command and tool surface in the active Pi host.
 * Every run is one isolated SDK child; team inspection is process-local and
 * deterministic, and never sends a prompt to a model.
 */
export default function agentHarbor(pi: ExtensionAPI): void {
  const registered = new Set<string>();
  const runtime = new PiTeamRuntime();
  const rootAbortControllers = new Map<string, AbortController>();
  const rootPromises = new Map<string, Promise<unknown>>();
  const rootSettlements = new Map<string, Promise<unknown>>();
  const rootSettlementProjects = new Map<string, string>();
  const loadHostSdk = async () => hostPiSdk;
  let completionProject = process.cwd();
  let discoveryWarning: string | undefined;
  let completionRosterCache: {
    readonly project: string;
    readonly expiresAt: number;
    readonly members: Awaited<ReturnType<typeof collectPiTeamMembers>>;
  } | undefined;
  let completionRosterInFlight: {
    readonly project: string;
    readonly promise: Promise<Awaited<ReturnType<typeof collectPiTeamMembers>>>;
  } | undefined;
  const metadataRefreshWarning = "Pi command metadata refresh failed after the roster change was committed; run /reload. No rollback was attempted.";

  const invalidateCompletionRoster = (project?: string): void => {
    if (!project || (completionRosterCache && sameProject(completionRosterCache.project, project))) {
      completionRosterCache = undefined;
    }
    if (!project || (completionRosterInFlight && sameProject(completionRosterInFlight.project, project))) {
      completionRosterInFlight = undefined;
    }
  };

  const completionMembers = async (project: string): Promise<Awaited<ReturnType<typeof collectPiTeamMembers>>> => {
    if (completionRosterCache && sameProject(completionRosterCache.project, project) &&
        completionRosterCache.expiresAt > Date.now()) {
      return completionRosterCache.members;
    }
    if (completionRosterInFlight && sameProject(completionRosterInFlight.project, project)) {
      return completionRosterInFlight.promise;
    }
    const promise = collectPiTeamMembers(project);
    const inFlight = { project, promise };
    completionRosterInFlight = inFlight;
    try {
      const members = await promise;
      if (completionRosterInFlight === inFlight) {
        completionRosterCache = { project, expiresAt: Date.now() + piCompletionCacheTtlMs, members };
      }
      return members;
    } finally {
      if (completionRosterInFlight === inFlight) completionRosterInFlight = undefined;
    }
  };

  const combineSignals = (...signals: Array<AbortSignal | undefined>): AbortSignal | undefined => {
    const present = signals.filter((signal): signal is AbortSignal => signal !== undefined);
    return present.length > 1 ? AbortSignal.any(present) : present[0];
  };

  const rootToolSignal = (rootRunId: string, toolSignal?: AbortSignal): AbortSignal => {
    const run = runtime.get(rootRunId);
    if (!run || (run.state !== "starting" && run.state !== "working")) {
      throw new Error("Agent Harbor root is terminal or cleaning; late custom-tool calls are blocked");
    }
    const rootSignal = rootAbortControllers.get(rootRunId)?.signal;
    if (!rootSignal) throw new Error("Agent Harbor root execution authority is no longer available");
    const signal = combineSignals(rootSignal, toolSignal)!;
    signal.throwIfAborted();
    return signal;
  };

  const trackRootExecution = (
    runId: string,
    project: string,
    callerSignal: AbortSignal | undefined,
    execute: (signal: AbortSignal) => Promise<string>,
  ): Promise<string> => {
    const controller = rootAbortControllers.get(runId) ?? new AbortController();
    rootAbortControllers.set(runId, controller);
    const relayCallerAbort = (): void => {
      const state = runtime.get(runId)?.state;
      if (state === "starting" || state === "working") runtime.setState(runId, "cleaning");
      controller.abort(callerSignal?.reason);
    };
    if (callerSignal?.aborted) relayCallerAbort();
    else callerSignal?.addEventListener("abort", relayCallerAbort, { once: true });
    // The controller is the canonical root authority used by both the prompt
    // and every invocation-scoped tool. Relaying the caller here closes the
    // small race between caller cancellation and terminal-state observation.
    const effectiveSignal = controller.signal;
    let abortListener: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      const fail = (): void => reject(effectiveSignal.reason instanceof Error
        ? effectiveSignal.reason
        : new DOMException("Agent Harbor Pi run cancelled", "AbortError"));
      if (effectiveSignal.aborted) fail();
      else {
        abortListener = fail;
        effectiveSignal.addEventListener("abort", fail, { once: true });
      }
    });
    const execution = Promise.resolve().then(() => {
      effectiveSignal.throwIfAborted();
      return execute(effectiveSignal);
    });
    const settlement = execution.catch((error) => {
      runtime.finishIfOpen(runId, cancellation(error, effectiveSignal) ? "cancelled" : "failed");
      throw error;
    }).finally(() => {
      callerSignal?.removeEventListener("abort", relayCallerAbort);
      if (rootAbortControllers.get(runId) === controller) rootAbortControllers.delete(runId);
      rootSettlements.delete(runId);
      rootSettlementProjects.delete(runId);
    });
    rootSettlements.set(runId, settlement);
    rootSettlementProjects.set(runId, project);
    let tracked: Promise<string>;
    tracked = Promise.race([settlement, aborted]).finally(() => {
      if (abortListener) effectiveSignal.removeEventListener("abort", abortListener);
      if (rootPromises.get(runId) === tracked) rootPromises.delete(runId);
    });
    rootPromises.set(runId, tracked);
    return tracked;
  };

  const stopProjectRoots = (project: string, selector = "all") => {
    const active = runtime.activeProjectRuns(project);
    const matching = selector === "all"
      ? active
      : active.filter((run) => run.id === selector || run.rootRunId === selector);
    const rootIds = [...new Set(matching.map(({ rootRunId }) => rootRunId))];
    const selected = rootIds.flatMap((rootId) => active.find((run) => run.id === rootId) ?? []);
    const stopped: string[] = [];
    const alreadyStopping: string[] = [];
    const unavailable: string[] = [];
    for (const run of selected) {
      const controller = rootAbortControllers.get(run.id);
      if (run.state === "cleaning" || controller?.signal.aborted) {
        alreadyStopping.push(run.id);
        continue;
      }
      if (!controller) {
        unavailable.push(run.id);
        continue;
      }
      runtime.setState(run.id, "cleaning");
      controller.abort(new DOMException("Stopped by user", "AbortError"));
      stopped.push(run.id);
    }
    return { stopped, alreadyStopping, unavailable };
  };

  const stopProjectRootsMessage = (
    result: ReturnType<typeof stopProjectRoots>,
    empty = "No Agent Harbor work is active in this project.",
  ): string => {
    const lines = [
      ...(result.stopped.length
        ? [`Stopping ${result.stopped.length} Agent Harbor root run(s): ${result.stopped.join(", ")}.`]
        : []),
      ...(result.alreadyStopping.length
        ? [`Already stopping ${result.alreadyStopping.length} root run(s): ${result.alreadyStopping.join(", ")}; waiting for provider cleanup.`]
        : []),
      ...(result.unavailable.length
        ? [`Stop authority unavailable for ${result.unavailable.length} root run(s): ${result.unavailable.join(", ")}; inspect /team until they settle.`]
        : []),
    ];
    return lines.length ? lines.join("\n") : empty;
  };

  const assertRootStartAllowed = (
    project: string,
    agent: string,
    kind: PiTeamMemberKind,
  ): void => {
    const activeRoots = runtime.activeProjectRuns(project).filter((run) => run.parentRunId === undefined);
    if (activeRoots.length >= maximumConcurrentPiRoots) {
      throw new Error(`Agent Harbor allows at most ${maximumConcurrentPiRoots} concurrent root runs per project; wait or use /team stop <run-id|all>`);
    }
    const settlingRoots = [...rootSettlementProjects.values()]
      .filter((candidate) => sameProject(candidate, project)).length;
    if (settlingRoots >= maximumConcurrentPiRoots) {
      throw new Error(`Agent Harbor is still settling ${settlingRoots} stopped or active roots in this project; wait for cleanup before starting more model work`);
    }
    if (kind === "contractor") return;
    const busy = runtime.activeProjectRuns(project).find((run) => run.kind !== "contractor" && run.agent === agent);
    if (busy) throw new Error(`${agent} is already working in ${busy.rootRunId}; wait or use /team stop ${busy.rootRunId}`);
  };

  const captureSessionOptions = async (
    ctx: ExtensionContext,
    model: Model,
    thinkingLevel: ThinkingLevel,
    additionalProviderIds: readonly string[] = [],
  ): Promise<PiSessionOptions> => {
    const providerProjections = await capturePiProviderProjections(
      ctx,
      [model.provider, ...additionalProviderIds],
    );
    return {
      model,
      thinkingLevel,
      ...(providerProjections.length ? { providerProjections } : {}),
    };
  };

  const teamViewRuntimeOptions = (ctx: ExtensionContext) => {
    let nextThinking: ThinkingLevel | undefined;
    try { nextThinking = pi.getThinkingLevel(); } catch { /* Keep deterministic inspection available. */ }
    const currentModel = ctx.model;
    const rawProvider = boundedPiModelPart(currentModel?.provider);
    const rawId = boundedPiModelPart(currentModel?.id ?? (currentModel as unknown as { readonly model?: unknown } | undefined)?.model);
    const noActiveModel = currentModel === undefined || isPiOfflinePlaceholder(currentModel);
    let registryReportsNoAvailableModels = false;
    let availableModelCount: number | undefined;
    let modelAvailabilityUnobserved = noActiveModel;
    if (noActiveModel) {
      const registry = ctx.modelRegistry as {
        readonly getAvailable?: () => readonly unknown[];
        readonly getError?: () => string | undefined;
      } | undefined;
      try {
        if (typeof registry?.getAvailable === "function" && typeof registry.getError === "function") {
          const available = registry.getAvailable();
          if (Array.isArray(available) && registry.getError() === undefined) {
            registryReportsNoAvailableModels = available.length === 0;
            availableModelCount = available.length > 0 ? available.length : undefined;
            modelAvailabilityUnobserved = false;
          }
        }
      } catch { /* A missing or unhealthy registry is unobserved, not proof of no models. */ }
    }
    const nextModelUnavailable = noActiveModel && registryReportsNoAvailableModels;
    const provider = rawProvider?.toLowerCase() === "unknown" ? undefined : rawProvider;
    const id = rawId?.toLowerCase() === "unknown" ? undefined : rawId;
    const maxTokens = typeof currentModel?.maxTokens === "number" &&
      Number.isSafeInteger(currentModel.maxTokens) && currentModel.maxTokens > 0
      ? currentModel.maxTokens
      : undefined;
    return {
      ...(provider === undefined || id === undefined ? {} : {
        nextModel: {
          provider,
          id,
          ...(maxTokens === undefined ? {} : { maxTokens }),
        },
      }),
      ...(nextModelUnavailable ? { nextModelUnavailable: true } : {}),
      ...(availableModelCount === undefined ? {} : { nextModelAvailableCount: availableModelCount }),
      ...(modelAvailabilityUnobserved ? { nextModelAvailabilityUnobserved: true } : {}),
      ...(nextThinking === undefined ? {} : { nextThinking }),
    };
  };

  const createOrchestrator = (
    cwd: string,
    sessionOptions: PiSessionOptions,
    additionalTools: readonly string[] = [],
    customTools: readonly ToolDefinition[] = [],
    observer?: PiRunObserver,
  ): PiOrchestrator => new PiOrchestrator(
    cwd,
    loadHostSdk,
    additionalTools,
    undefined,
    customTools,
    undefined,
    sessionOptions,
    observer,
  );

  const executeRun = (
    definition: ContractDefinition,
    runId: string,
    cwd: string,
    sessionOptions: PiSessionOptions,
    signal: AbortSignal | undefined,
    additionalTools: readonly string[] = [],
    customTools: readonly ToolDefinition[] = [],
  ): Promise<string> => (async () => {
    try {
      const result = await createOrchestrator(
        cwd,
        sessionOptions,
        additionalTools,
        customTools,
        runtime.observer(runId),
      ).run(definition, signal);
      runtime.finishIfOpen(runId, signal?.aborted ? "cancelled" : "completed");
      return result;
    } catch (error) {
      runtime.finishIfOpen(runId, cancellation(error, signal) ? "cancelled" : "failed");
      throw error;
    }
  })();

  const startDefinition = (
    definition: ContractDefinition,
    cwd: string,
    sessionOptions: PiSessionOptions,
    kind: PiTeamMemberKind,
    signal?: AbortSignal,
    parentRunId?: string,
    additionalTools: readonly string[] = [],
    customTools: readonly ToolDefinition[] = [],
  ): StartedPiRun => {
    completionProject = cwd;
    requireBoundedArguments(definition.task, maximumPiTaskBytes, "contract task");
    if (parentRunId === undefined) assertRootStartAllowed(cwd, definition.name, kind);
    const runId = runtime.begin({
      project: cwd,
      agent: definition.name,
      kind,
      task: definition.task,
      ...(parentRunId === undefined ? {} : { parentRunId }),
      ...(sessionOptions.model === undefined ? {} : { model: modelIdentity(sessionOptions.model) }),
      ...(sessionOptions.model === undefined ? {} : {
        modelSource: definition.model === undefined ? "inherited" as const : "configured" as const,
      }),
      ...(sessionOptions.thinkingLevel === undefined ? {} : { thinking: sessionOptions.thinkingLevel }),
    });
    const execute = (effectiveSignal: AbortSignal | undefined) =>
      executeRun(definition, runId, cwd, sessionOptions, effectiveSignal, additionalTools, customTools);
    const result = parentRunId === undefined
      ? trackRootExecution(runId, cwd, signal, execute)
      : execute(combineSignals(signal, rootAbortControllers.get(runtime.get(runId)!.rootRunId)?.signal));
    return {
      runId,
      result,
    };
  };

  const createDelegateTool = (
    cwd: string,
    leadSessionOptions: PiSessionOptions,
    parentRunId: string,
    delegationRoster: ReadonlyMap<string, PlayerDefinition>,
  ): ToolDefinition => {
    // A fresh tool per team-lead child makes the six-call/sequential policy invocation-local.
    let calls = 0;
    const delegatedAgents = new Set<string>();
    const compactRoster = boundedLeadRoster([...delegationRoster].map(([id, definition]) =>
      leadRosterPreviewRow(definition,
        runtime.activeProjectRuns(cwd).some((run) => run.kind !== "contractor" && run.agent === id))));
    const spec = harborStaticCustomToolSpecs[harborCustomToolNames.delegate];
    const policy = harborCustomToolPolicy(spec.name)!;
    const staticParameters = spec.parameters as {
      readonly properties: Readonly<Record<string, Record<string, unknown>>>;
    };
    const parameters = {
      ...spec.parameters,
      properties: {
        ...staticParameters.properties,
        agent: {
          ...staticParameters.properties.agent,
          enum: [...delegationRoster.keys()],
        },
      },
    };
    return {
      name: spec.name,
      label: "Agent Harbor Delegate",
      description: `${spec.description} Enabled roster preview: ${compactRoster}. Call ${harborCustomToolNames.teamRoster} with query "" for the full invocation snapshot or a short query for details.`,
      executionMode: "sequential",
      parameters,
      execute: async (_id, params: unknown, signal, _update, context) => {
        try {
        const effectiveSignal = rootToolSignal(parentRunId, signal);
        const project = childToolProject(context, cwd);
        assertHarborCustomToolAccess(spec.name, { agent: "team-lead" });
        const call = validateHarborCustomToolArguments(spec.name, params);
        if (call.kind !== "delegate") throw new Error("invalid Agent Harbor delegate dispatch");
        const player = delegationRoster.get(call.agent);
        if (!player) throw new Error(`delegation target ${call.agent} is not in this team-lead roster snapshot`);
        const busy = runtime.activeProjectRuns(project).find((run) =>
          run.kind !== "contractor" && run.agent === call.agent && run.rootRunId !== parentRunId);
        if (busy) throw new Error(`delegation target ${call.agent} is busy in ${busy.rootRunId}; wait or stop that run`);
        if (calls >= policy.maximumCalls) throw new Error(`delegation limit reached (${policy.maximumCalls})`);
        if (delegatedAgents.has(call.agent)) throw new Error(`already delegated to ${call.agent} in this team-lead run`);
        const delegatedModel = player.model === undefined
          ? context.model ?? leadSessionOptions.model
          : resolveConfiguredPiModel(player.model, context);
        calls += 1;
        delegatedAgents.add(call.agent);
        const delegateSessionOptions: PiSessionOptions = {
          ...leadSessionOptions,
          ...(delegatedModel === undefined ? {} : { model: delegatedModel }),
        };
        const definition = { ...player, task: normalizeDelegatedTaskPaths(call.task, project) };
        const child = startDefinition(definition, project, delegateSessionOptions, playerKind(player), effectiveSignal, parentRunId);
        const text = await child.result;
        // Accounting remains outside this content so the lead reasons only over specialist evidence.
        return { content: [{ type: "text", text }], details: { harness: "pi", agent: call.agent, call: calls } };
        } catch (error) {
          throw publicPiToolFailure(error);
        }
      },
    };
  };

  const createTeamRosterTool = (
    cwd: string,
    rosterSnapshot: ReadonlyMap<string, PlayerDefinition>,
    parentRunId: string,
  ): ToolDefinition => {
    const spec = harborStaticCustomToolSpecs[harborCustomToolNames.teamRoster];
    const policy = harborCustomToolPolicy(spec.name)!;
    let calls = 0;
    return {
    name: spec.name,
    label: "Agent Harbor Team Roster",
    description: spec.description,
    executionMode: "sequential",
    parameters: spec.parameters,
    execute: async (_id, params: unknown, signal, _update, context) => {
      try {
      rootToolSignal(parentRunId, signal);
      const project = childToolProject(context, cwd);
      assertHarborCustomToolAccess(spec.name, { agent: "team-lead" });
      const call = validateHarborCustomToolArguments(spec.name, params);
      if (call.kind !== "team-roster") throw new Error("invalid Agent Harbor team-roster dispatch");
      if (calls >= policy.maximumCalls) throw new Error(`team roster limit reached (${policy.maximumCalls})`);
      calls += 1;
      const snapshot = formatHarborTeamRosterSnapshot(
        [...rosterSnapshot.values()].map((definition) => ({
          id: definition.name,
          role: publicMetadataText(definition.description, 240) ?? "Role not disclosed",
          tools: definition.tools,
          skills: (definition.skills ?? []).map(({ name }) => name),
          ...(definition.model ? { configuredModel: publicMetadataText(definition.model, 200) ?? "redacted" } : {}),
          availability: runtime.activeProjectRuns(project)
            .some((run) => run.kind !== "contractor" && run.agent === definition.name)
            ? "busy" as const
            : "ready" as const,
        })),
        call.query,
      );
      return { content: [{ type: "text", text: snapshot.text }], details: {
        harness: "pi", deterministic: true, childCreated: false, rosterComplete: snapshot.complete,
      } };
      } catch (error) {
        throw publicPiToolFailure(error);
      }
    },
  };
  };

  const createScoutTools = (
    cwd: string,
    onJoinCommitted: (id: string) => void,
    rosterSnapshot: ReadonlyMap<string, PlayerDefinition>,
    parentRunId: string,
  ): ToolDefinition[] => {
    const guard = new HarborScoutTurnGuard();
    const rosterSpec = harborStaticCustomToolSpecs[harborCustomToolNames.teamRoster];
    const filterSpec = harborStaticCustomToolSpecs[harborCustomToolNames.filterSkills];
    const joinSpec = harborStaticCustomToolSpecs[harborCustomToolNames.joinPlayer];
    return [{
    name: rosterSpec.name,
    label: "Agent Harbor Team Roster",
    description: `${rosterSpec.description} Call this exactly once before filtering skills or joining a player.`,
    executionMode: "sequential",
    parameters: rosterSpec.parameters,
    execute: async (_id, params: unknown, signal, _update, context) => {
      const effectiveSignal = rootToolSignal(parentRunId, signal);
      const ticket = guard.begin(harborCustomToolNames.teamRoster, effectiveSignal);
      try {
      const project = childToolProject(context, cwd);
      assertHarborCustomToolAccess(rosterSpec.name, { agent: scoutPlayer.name });
      const call = validateHarborCustomToolArguments(rosterSpec.name, params);
      if (call.kind !== "team-roster") throw new Error("invalid Agent Harbor team-roster dispatch");
      const snapshot = formatHarborTeamRosterSnapshot(
        [...rosterSnapshot.values()].map((definition) => ({
          id: definition.name,
          role: publicMetadataText(definition.description, 240) ?? "Role not disclosed",
          tools: definition.tools,
          skills: (definition.skills ?? []).map(({ name }) => name),
          ...(definition.model ? { configuredModel: publicMetadataText(definition.model, 200) ?? "redacted" } : {}),
          availability: runtime.activeProjectRuns(project)
            .some((run) => run.kind !== "contractor" && run.agent === definition.name)
            ? "busy" as const
            : "ready" as const,
        })),
        call.query,
      );
      guard.succeed(ticket, { rosterComplete: snapshot.complete });
      return { content: [{ type: "text", text: snapshot.text }], details: {
        harness: "pi", deterministic: true, childCreated: false, rosterComplete: snapshot.complete,
      } };
      } catch (error) {
        guard.fail(ticket, effectiveSignal);
        throw publicPiToolFailure(error);
      }
    },
  }, {
    name: filterSpec.name,
    label: "Agent Harbor Skill Filter",
    description: filterSpec.description,
    executionMode: "sequential",
    parameters: filterSpec.parameters,
    execute: async (_id, params: unknown, signal, _update, context) => {
      const effectiveSignal = rootToolSignal(parentRunId, signal);
      const ticket = guard.begin(harborCustomToolNames.filterSkills, effectiveSignal);
      try {
      const project = childToolProject(context, cwd);
      assertHarborCustomToolAccess(filterSpec.name, { agent: scoutPlayer.name });
      const call = validateHarborCustomToolArguments(filterSpec.name, params);
      if (call.kind !== "filter-skills") throw new Error("invalid Agent Harbor skill-filter dispatch");
      const text = formatScoutSkillMatches(await filterTrustedSkills(call.query, trustedSkills, new GhResolver(), effectiveSignal));
      guard.succeed(ticket);
      return { content: [{ type: "text", text }], details: { harness: "pi", scope: "trusted-skills" } };
      } catch (error) {
        guard.fail(ticket, effectiveSignal);
        throw publicPiToolFailure(error);
      }
    },
  }, {
    name: joinSpec.name,
    label: "Agent Harbor Join Player",
    description: joinSpec.description,
    executionMode: "sequential",
    parameters: joinSpec.parameters,
    execute: async (_id, params: unknown, signal, _update, context) => {
      const effectiveSignal = rootToolSignal(parentRunId, signal);
      const ticket = guard.begin(harborCustomToolNames.joinPlayer, effectiveSignal);
      try {
      const project = childToolProject(context, cwd);
      assertHarborCustomToolAccess(joinSpec.name, { agent: scoutPlayer.name });
      const call = validateHarborCustomToolArguments(joinSpec.name, params);
      if (call.kind !== "join-player") throw new Error("invalid Agent Harbor join-player dispatch");
      const text = await runDeterministicCommand("pi", "join", call.definition, project, effectiveSignal);
      const joined = JSON.parse(call.definition) as { name: string };
      onJoinCommitted(joined.name);
      guard.succeed(ticket);
      return {
        content: [{ type: "text", text: conciseLifecycleResult("join", call.definition, text) }],
        details: { harness: "pi", action: "join", modelTokens: 0 },
      };
      } catch (error) {
        guard.fail(ticket, effectiveSignal);
        throw publicPiToolFailure(error);
      }
    },
    }];
  };

  const preparePlayerRoster = (
    player: PlayerDefinition,
    cwd: string,
  ): ReadonlyMap<string, PlayerDefinition> => {
    const rosterSnapshot = player.name === "team-lead" || player.name === scoutPlayer.name
      ? new Map(listInvocablePlayers("pi", cwd)
        .filter(({ id }) => id !== player.name &&
          (player.name !== scoutPlayer.name || id !== "team-lead"))
        .map(({ id, definition }) => [id, definition] as const))
      : new Map<string, PlayerDefinition>();
    if (player.name === "team-lead" && rosterSnapshot.size > 32) {
      throw new Error(`team lead supports at most 32 enabled specialists; found ${rosterSnapshot.size}. Use /team, then /bench off <id...> to reduce the enabled roster`);
    }
    return rosterSnapshot;
  };

  const startPlayer = (
    player: PlayerDefinition,
    task: string,
    cwd: string,
    sessionOptions: PiSessionOptions,
    rosterSnapshot: ReadonlyMap<string, PlayerDefinition>,
    signal?: AbortSignal,
    onScoutJoinCommitted: (id: string) => void = () => {},
  ): StartedPiRun => {
    requireBoundedArguments(task, maximumPiTaskBytes, "task");
    if (!task.trim()) throw new Error(`/${player.name} requires a non-empty task`);
    assertRootStartAllowed(cwd, player.name, playerKind(player));
    const model = sessionOptions.model;
    const thinkingLevel = sessionOptions.thinkingLevel;
    completionProject = cwd;
    const runId = runtime.begin({
      project: cwd,
      agent: player.name,
      kind: playerKind(player),
      task,
      ...(model === undefined ? {} : { model: modelIdentity(model) }),
      ...(model === undefined ? {} : {
        modelSource: player.model === undefined ? "inherited" as const : "configured" as const,
      }),
      ...(thinkingLevel === undefined ? {} : { thinking: thinkingLevel }),
    });
    try {
      const customTools = player.name === "team-lead"
        ? [createDelegateTool(cwd, sessionOptions, runId, rosterSnapshot), createTeamRosterTool(cwd, rosterSnapshot, runId)]
        : player.name === scoutPlayer.name ? createScoutTools(cwd, onScoutJoinCommitted, rosterSnapshot, runId) : [];
      const additionalTools = customTools.map((tool) => tool.name);
      return {
        runId,
        result: trackRootExecution(runId, cwd, signal, (effectiveSignal) =>
          executeRun({ ...player, task }, runId, cwd, sessionOptions, effectiveSignal, additionalTools, customTools)),
      };
    } catch (error) {
      runtime.finishIfOpen(runId, "failed");
      throw error;
    }
  };

  const trackUi = async (ctx: ExtensionCommandContext | ExtensionContext, run: StartedPiRun): Promise<string> => {
    const key = `agent-harbor:${run.runId}`;
    const render = (): void => {
      safeUi(() => ctx.ui.setStatus?.(key, formatPiLiveStatus(runtime, run.runId)));
      safeUi(() => ctx.ui.setWidget?.(key, formatPiLiveWidget(runtime, run.runId), { placement: "aboveEditor" }));
    };
    const unsubscribe = runtime.subscribe((changedId) => {
      if (runtime.get(changedId)?.rootRunId === run.runId) render();
    });
    render();
    const timer = setInterval(render, 1000);
    timer.unref?.();
    try { return await run.result; }
    finally {
      clearInterval(timer);
      unsubscribe();
      safeUi(() => ctx.ui.setStatus?.(key, undefined));
      safeUi(() => ctx.ui.setWidget?.(key, undefined));
    }
  };

  const registerPlayer = (
    id: string,
    fixed?: PlayerDefinition,
    display: PlayerDefinition | undefined = fixed,
    refresh = false,
  ): void => {
    if (registered.has(id) && !refresh) return;
    const cost = id === "team-lead" ? "1 lead + up to 6 sequential specialist children" : "1 model child";
    const publicDescription = publicMetadataText(display?.description ?? `Run active Agent Harbor player ${id}`, 240)
      ?? `Run active Agent Harbor player ${id}`;
    pi.registerCommand(id, {
      description: `${cost} · /${id} <task> · ${publicDescription}`,
      handler: async (args, ctx) => {
        completionProject = ctx.cwd;
        let run: StartedPiRun | undefined;
        try {
          requireBoundedArguments(args, maximumPiTaskBytes, `/${id} task`);
          let player: PlayerDefinition;
          try { player = fixed ?? loadPiActivePlayer(ctx.cwd, id); }
          catch { throw new Error(`active managed player preflight failed: ${id}`); }
          if (!args.trim()) throw new Error(`/${player.name} requires a non-empty task`);
          const rosterSnapshot = preparePlayerRoster(player, ctx.cwd);
          const model = resolveConfiguredPiModel(player.model, ctx);
          const additionalProviderIds = player.name === "team-lead"
            ? [...rosterSnapshot.values()].flatMap(({ model: route }) =>
              route === undefined ? [] : [configuredPiProvider(route)])
            : [];
          const sessionOptions = await captureSessionOptions(
            ctx,
            model,
            pi.getThinkingLevel(),
            additionalProviderIds,
          );
          run = startPlayer(player, args, ctx.cwd, sessionOptions, rosterSnapshot, ctx.signal);
          const text = await trackUi(ctx, run);
          notify(ctx, `${text}${formatPiMissionReport(runtime, run.runId)}`, "info");
        } catch (error) {
          const state = run ? runtime.get(run.runId)?.state : undefined;
          if (run && (state === "cancelled" || state === "cleaning")) {
            notify(ctx, `${state === "cleaning" ? "Cancellation requested; provider cleanup is still settling." : "Cancelled."}${formatPiMissionReport(runtime, run.runId)}`, "warning");
          } else {
            failCommand(ctx, run
              ? `${humanError(id, error)}${formatPiMissionReport(runtime, run.runId)}`
              : modelPreflightError(id, error));
          }
        }
      },
    });
    registered.add(id);
  };

  const syncActivePlayers = (project: string): void => {
    completionProject = project;
    invalidateCompletionRoster(project);
    for (const id of listManagedActiveIds("pi", project)) {
      const display = bundledPlayers.get(id) ?? loadPiActivePlayer(project, id);
      registerPlayer(id, undefined, display, true);
    }
    discoveryWarning = undefined;
  };

  const teamCompletions = async (prefix: string) => {
    try {
      requireBoundedArguments(prefix, maximumPiFilterBytes, "/team completion prefix");
      const members = await completionMembers(completionProject);
      const normalized = prefix.trim().toLowerCase();
      const activeRoots = runtime.activeProjectRuns(completionProject).filter((run) => run.parentRunId === undefined);
      const memberItems: Array<{ value: string; label: string; description: string }> = [];
      for (const member of members) {
        if (memberItems.length >= maximumPiCompletionItems) break;
        const description = `${member.description} (${member.capacity})`;
        if (!normalized || member.id.includes(normalized) || description.toLowerCase().includes(normalized)) {
          memberItems.push({ value: member.id, label: `${member.id} · ${member.kind}/${member.availability}`, description });
        }
      }
      const stopItems = [...(activeRoots.length ? [{ value: "stop all", label: "stop all · deterministic", description: "Stop all active Harbor root runs" }] : []),
      ...activeRoots.map((run) => ({
        value: `stop ${run.id}`,
        label: `stop ${run.id} · ${run.agent}`,
        description: `Stop ${run.agent}: ${run.task}`,
      }))].filter((item) => !normalized || item.value.includes(normalized) || item.description.toLowerCase().includes(normalized));
      const filterItems = [
        { value: "status:bench", label: "status:bench · roster", description: "Show benched teammates" },
        { value: "status:ready", label: "status:ready · roster", description: "Show teammates available now" },
        { value: "status:working", label: "status:working · live", description: "Show teammates working now" },
        { value: "kind:personal", label: "kind:personal · roster", description: "Show personal teammates" },
        { value: "model:", label: "model:<name> · roster/activity", description: "Filter configured or observed model" },
        { value: "task:", label: "task:<label> · activity", description: "Filter safe active or historical task labels" },
      ].filter((item) => !normalized || item.value.startsWith(normalized) || item.description.toLowerCase().includes(normalized));
      const items = normalized.startsWith("stop")
        ? [...stopItems, ...memberItems, ...filterItems]
        : normalized.includes(":")
          ? [...filterItems, ...memberItems, ...stopItems]
          : [...memberItems, ...stopItems, ...filterItems];
      return items.length ? items.slice(0, maximumPiCompletionItems) : null;
    } catch { return null; }
  };

  const benchCompletions = async (prefix: string) => {
    try {
      const members = await completionMembers(completionProject);
      const normalized = prefix.trim().toLowerCase();
      const items: Array<{ value: string; label: string }> = [];
      const append = (value: string): void => {
        if (items.length >= maximumPiCompletionItems) return;
        if (!normalized || value.startsWith(normalized)) items.push({ value, label: value });
      };
      for (const value of ["list", "on all", "off all"]) append(value);
      for (const member of members) {
        if (items.length >= maximumPiCompletionItems) break;
        if (member.kind !== "bundled" && member.kind !== "personal") continue;
        for (const action of ["list", "on", "off"]) append(`${action} ${member.id}`);
      }
      return items.length ? items : null;
    } catch { return null; }
  };

  pi.registerCommand("team", {
    description: `0 model tokens · ${commandSyntax.team} · Show roster, live work, model, thinking, native usage, and last mission.`,
    getArgumentCompletions: teamCompletions,
    handler: async (args, ctx) => {
      completionProject = ctx.cwd;
      try {
        requireBoundedArguments(args, maximumPiFilterBytes, "/team arguments");
        const value = args.trim();
        if (value === "stop" || value.startsWith("stop ")) {
          const selector = value.slice("stop".length).trim();
          if (!selector) throw new Error("usage: /team stop <run-id|all>");
          const result = stopProjectRoots(ctx.cwd, selector);
          const matched = result.stopped.length + result.alreadyStopping.length + result.unavailable.length;
          if (!matched && selector === "all") {
            notify(ctx, stopResult("No Agent Harbor work is active in this project."), "info");
            return;
          }
          if (!matched) throw new Error(`no active Harbor root matches ${selector}`);
          notify(ctx, stopResult(stopProjectRootsMessage(result)), "warning");
          return;
        }
        const result = value === "--help" || value === "help"
          ? wrapPlainText(`${commandHelp("team")}\nChoose one exact teammate: /<id> <task> (or /player <id> <task> in hosts that expose it).\nSet a personal model with /join JSON model:"provider/model"; add replace:true to change it.\nDisposable work: /contract <json> (exactly 1 model child). Recruit: /scout <need> (1 recruiter model child).\nTokens, AI credits, and max-output are observations only when the host reports them; Agent Harbor does not simulate a hard per-run token cap.\nAgent Harbor limits 32 concurrent roots per project and 6 sequential team-lead delegations per prompt.\nField filters: member:/id: · kind:/role: · description: · capability:/tool:/skill: · status:/state: · model: · thinking: · task: · run:.\nExamples: /team status:working · /team member:reviewer · /team model:gpt.\nTUI: Alt+H stops all active Harbor work. RPC: /team stop <run-id|all>.`)
          : await formatPiTeamView(ctx.cwd, runtime, { filter: value, title: "team", ...teamViewRuntimeOptions(ctx) });
        notify(ctx, `${result}${discoveryWarning ? `\n\nWarning: ${discoveryWarning}` : ""}`, "info");
      } catch (error) { failCommand(ctx, humanError("team", error, true)); }
    },
  });
  registered.add("team");

  for (const name of commandNames) {
    if (name === "bench") {
      pi.registerCommand(name, {
        description: `0 model tokens · ${commandSyntax.bench} · Inspect the roster; on/off all affects only the six bundled SDLC specialists.`,
        getArgumentCompletions: benchCompletions,
        handler: async (args, ctx) => {
          completionProject = ctx.cwd;
          try {
            requireBoundedArguments(args, maximumPiFilterBytes, "/bench arguments");
            if (["help", "--help"].includes(args.trim())) {
              notify(ctx, `${commandHelp("bench")}\n${benchAllNote}\nUse /team for live work and mission accounting.`, "info");
              return;
            }
            const filter = benchListFilter(args);
            if (filter !== undefined) {
              notify(ctx, await formatPiTeamView(ctx.cwd, runtime, { filter, title: "bench", ...teamViewRuntimeOptions(ctx) }), "info");
              return;
            }
            const result = await runDeterministicCommand("pi", name, args, ctx.cwd, ctx.signal);
            let refresh = "";
            try { syncActivePlayers(ctx.cwd); }
            catch { discoveryWarning = metadataRefreshWarning; refresh = `\nWarning: ${metadataRefreshWarning}`; }
            let view: string;
            try { view = await formatPiTeamView(ctx.cwd, runtime, { title: "bench", ...teamViewRuntimeOptions(ctx) }); }
            catch {
              discoveryWarning = metadataRefreshWarning;
              if (!refresh) refresh = `\nWarning: ${metadataRefreshWarning}`;
              view = "Team view unavailable until roster repair and /reload.";
            }
            const reload = /^off(?:\s|$)/u.test(args.trim())
              ? "\nPi cannot unregister deactivated aliases in-place; run /reload to remove them from completion."
              : "";
            const all = /^(?:on|off)\s+all$/u.test(args.trim()) ? `\n${benchAllNote}` : "";
            notify(ctx, `${zeroModelResult(name, result)}${all}${reload}${refresh}\n\n${withoutViewHeader(view)}`, "info");
          } catch (error) { failCommand(ctx, humanError(name, error, true)); }
        },
      });
      registered.add(name);
      continue;
    }

    if (name === "contract") {
      pi.registerCommand(name, {
        description: `exactly 1 model child · ${commandSyntax.contract} · Run one disposable specialist without roster mutation.`,
        handler: async (args, ctx) => {
          completionProject = ctx.cwd;
          let run: StartedPiRun | undefined;
          try {
            requireBoundedArguments(args, maximumPiDefinitionBytes, "/contract definition");
            const definition = parseContractDefinition(args);
            const model = resolveConfiguredPiModel(definition.model, ctx);
            const sessionOptions = await captureSessionOptions(ctx, model, pi.getThinkingLevel());
            run = startDefinition(definition, ctx.cwd, sessionOptions, "contractor", ctx.signal);
            const text = await trackUi(ctx, run);
            notify(ctx, `${text}${formatPiMissionReport(runtime, run.runId)}`, "info");
          } catch (error) {
            const state = run ? runtime.get(run.runId)?.state : undefined;
            if (run && (state === "cancelled" || state === "cleaning")) {
              notify(ctx, `${state === "cleaning" ? "Cancellation requested; provider cleanup is still settling." : "Cancelled."}${formatPiMissionReport(runtime, run.runId)}`, "warning");
            } else {
              failCommand(ctx, run
                ? `${humanError(name, error)}${formatPiMissionReport(runtime, run.runId)}`
                : modelPreflightError(name, error));
            }
          }
        },
      });
      registered.add(name);
      continue;
    }

    const deterministicPurpose = name === "join"
      ? "Validate, persist, and activate one personal teammate in this project."
      : name === "retire"
        ? "Unregister one personal teammate and deactivate its current-project copy."
        : "Search the trusted skill catalog; optionally include public descriptions.";
    pi.registerCommand(name, {
      description: `0 model tokens · ${commandSyntax[name]} · ${deterministicPurpose}`,
      handler: async (args, ctx) => {
        completionProject = ctx.cwd;
        try {
          requireBoundedArguments(
            args,
            name === "join" ? maximumPiDefinitionBytes : maximumPiFilterBytes,
            `/${name} arguments`,
          );
          if (name === "retire" && !args.trim()) throw new Error("usage: /retire <personal-id>");
          if (name === "retire") {
            const id = args.trim();
            const busy = runtime.activeProjectRuns(ctx.cwd).find((run) =>
              run.kind !== "contractor" && run.agent === id);
            if (busy) {
              throw new Error(
                `cannot retire ${id} while it is ${busy.state} in ${busy.rootRunId}; ` +
                `use /team stop ${busy.rootRunId}, then wait for cleanup to settle`,
              );
            }
          }
          const result = await runDeterministicCommand(
            "pi",
            name,
            args,
            ctx.cwd,
            ctx.signal,
            name === "list-skills" ? "ansi" : "plain",
          );
          let refresh = "";
          if (name === "join" || name === "retire") {
            try { syncActivePlayers(ctx.cwd); }
            catch { discoveryWarning = metadataRefreshWarning; refresh = `\nWarning: ${metadataRefreshWarning}`; }
          }
          notify(ctx, `${zeroModelResult(name, conciseLifecycleResult(name, args, result))}${refresh}`, "info");
        } catch (error) { failCommand(ctx, humanError(name, error, true)); }
      },
    });
    registered.add(name);
  }

  for (const [id, player] of rolePlayers) registerPlayer(id, player);
  pi.registerCommand("scout", {
    description: `1 recruiter model child · ${commandSyntax.scout} · ${scoutPlayer.description}`,
    handler: async (args, ctx) => {
      completionProject = ctx.cwd;
      let run: StartedPiRun | undefined;
      let joinedPlayer: string | undefined;
      let text: string | undefined;
      let failure: unknown;
      let failed = false;
      let refresh = "";
      let handlerSettled = false;
      const reconcileCommittedJoin = (id: string): void => {
        joinedPlayer = id;
        let reconciled = true;
        try { syncActivePlayers(ctx.cwd); }
        catch {
          reconciled = false;
          discoveryWarning = metadataRefreshWarning;
          refresh = `\nWarning: ${metadataRefreshWarning}`;
        }
        if (handlerSettled) {
          safeUi(() => notify(ctx, wrapPlainText(
            `Roster commit preserved: ${id} is joined and active in this project. ` +
            (reconciled
              ? "The recruiter UI had already settled, so Agent Harbor reconciled the alias after commit."
              : "The recruiter UI had already settled; the commit is durable, but alias metadata refresh failed.") +
            refresh,
          ), "warning"));
        }
      };
      try {
        requireBoundedArguments(args, maximumPiTaskBytes, "/scout task");
        if (!args.trim()) throw new Error(`/${scoutPlayer.name} requires a non-empty task`);
        const rosterSnapshot = preparePlayerRoster(scoutPlayer, ctx.cwd);
        const model = resolveConfiguredPiModel(undefined, ctx);
        const sessionOptions = await captureSessionOptions(ctx, model, pi.getThinkingLevel());
        run = startPlayer(
          scoutPlayer, args, ctx.cwd, sessionOptions, rosterSnapshot, ctx.signal,
          reconcileCommittedJoin,
        );
        text = await trackUi(ctx, run);
      } catch (error) { failed = true; failure = error; }
      const committed = joinedPlayer
        ? `\nRoster commit preserved: ${joinedPlayer} is joined and active in this project.${failed ? " The recruiter child ended after that commit." : ""}`
        : "";
      try {
        if (failed) {
          const state = run ? runtime.get(run.runId)?.state : undefined;
          if (run && (state === "cancelled" || state === "cleaning")) {
            const status = state === "cleaning" ? "Cancellation requested; provider cleanup is still settling." : "Cancelled.";
            notify(ctx, wrapPlainText(`${status}${committed}${formatPiMissionReport(runtime, run.runId)}${refresh}`), "warning");
          } else {
            failCommand(ctx, wrapPlainText(run
              ? `${humanError("scout", failure)}${committed}${formatPiMissionReport(runtime, run.runId)}${refresh}`
              : modelPreflightError("scout", failure)));
          }
          return;
        }
        notify(ctx, wrapPlainText(`${text ?? "Scout completed."}${committed}${run ? formatPiMissionReport(runtime, run.runId) : ""}${refresh}`), "info");
      } finally {
        handlerSettled = true;
      }
    },
  });
  registered.add("scout");
  pi.registerShortcut?.("alt+h", {
    description: "Stop active Agent Harbor work",
    handler: (ctx) => {
      const result = stopProjectRoots(ctx.cwd);
      const matched = result.stopped.length + result.alreadyStopping.length + result.unavailable.length;
      notify(ctx, stopResult(stopProjectRootsMessage(result)), matched ? "warning" : "info");
    },
  });
  pi.on?.("session_shutdown", async () => {
    for (const controller of rootAbortControllers.values()) {
      if (!controller.signal.aborted) controller.abort(new DOMException("Pi session shutdown", "AbortError"));
    }
    await settlePiRootPromises([...rootSettlements.values()]);
  });
  try { syncActivePlayers(process.cwd()); }
  catch { discoveryWarning = "Active alias discovery failed; fixed controls remain available. Inspect /team, then run /reload after repairing the roster."; }
}
