/** Pi extension entrypoint, zero-model controls, live team status, and delegation. */
import { randomBytes } from "node:crypto";
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
import { parseContractDefinition, type HarborLifecycleOutcome } from "../core/commands.js";
import {
  assertHarborCustomToolAccess,
  formatHarborTeamRosterSnapshot,
  harborCustomToolNames,
  harborCustomToolPolicy,
  harborStaticCustomToolSpecs,
  HarborScoutTurnGuard,
  maximumHarborTeamRosterMembers,
  validateHarborCustomToolArguments,
} from "../core/custom-tools.js";
import { bundledPlayers, rolePlayers, scoutPlayer, trustedSkills } from "../core/defaults.js";
import { GhResolver } from "../core/github.js";
import { commandNames, type ContractDefinition, type PlayerDefinition } from "../core/types.js";
import { visibleTextWidth, wrapPlainText } from "../core/text-layout.js";
import { normalizeDelegatedTaskPaths, playerDefinitionDigest } from "../core/profiles.js";
import { canonicalProjectIdentity, sameCanonicalProject } from "../core/project-identity.js";
import { publicErrorText, publicMetadataText } from "../core/public-metadata.js";
import { filterTrustedSkills, formatScoutSkillMatches } from "../core/scout.js";
import { PiOrchestrator, type PiSessionOptions } from "../orchestrators/pi.js";
import { runDeterministicCommandResult } from "./direct.js";
import {
  formatPiMissionReport,
  formatPiProjectLiveStatus,
  formatPiProjectLiveWidget,
  PiTeamRuntime,
  settlePiRootPromises,
  type PiRunObserver,
  type PiTeamMemberKind,
} from "./pi-team-runtime.js";
import { collectPiTeamMembers, formatPiTeamView } from "./pi-team-view.js";
import {
  claimValidatedSharedAgentActivity,
  readSharedAgentActivities,
  withSharedRosterMutationGate,
  type OpenCodeAgentActivityClaim,
} from "./opencode-agent-activity.js";

type NoticeLevel = "info" | "warning" | "error";
const preflightZeroLine = "Preflight stopped · no model was called · 0 model tokens.";
const maximumConcurrentPiRoots = 32;
const maximumPiCompletionItems = 50;
const piCompletionCacheTtlMs = 750;
const maximumPiTaskBytes = 30_000;
const maximumPiFilterBytes = 4_096;
const maximumPiStopSelectorBytes = 256;
const maximumPiDefinitionBytes = 100_000;
const maximumPiTeamOutputLines = 30;

interface StartedPiRun {
  readonly runId: string;
  readonly result: Promise<string>;
}

const commandSyntax: Record<string, string> = {
  team: "/team [filter|stop <run-id|all>]",
  bench: "/bench [list [filter]|on <id...>|off <id...>]",
  join: "/join {\"name\":\"reviewer\",\"description\":\"Review\",\"prompt\":\"Review\",\"tools\":[\"read\"]}",
  retire: "/retire <personal-id>",
  contract: "/contract {\"name\":\"a\",\"description\":\"Audit\",\"prompt\":\"Audit\",\"tools\":[\"read\"],\"task\":\"Review\"}",
  "list-skills": "/list-skills [--descriptions|-d] [filter] [--page N]",
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

function boundedPiTeamOutput(
  text: string,
  mandatoryTail: readonly string[] = [],
): string {
  const primary = wrapPlainText(text).split("\n");
  const tail = mandatoryTail.length ? wrapPlainText(mandatoryTail.join("\n")).split("\n") : [];
  if (primary.length + tail.length <= maximumPiTeamOutputLines) {
    return [...primary, ...tail].join("\n");
  }
  const omission = (count: number) => `+${count} /team lines omitted; narrow with a field filter or /team run:<id>.`;
  const prefixLimit = Math.max(0, maximumPiTeamOutputLines - tail.length - 1);
  const prefix = primary.slice(0, prefixLimit);
  while (prefix.length && !prefix[prefix.length - 1].trim()) prefix.pop();
  const omitted = primary.length - prefix.length;
  return [...prefix, omission(omitted), ...tail].slice(0, maximumPiTeamOutputLines).join("\n");
}

function stopResult(result: string): string {
  return boundedPiTeamOutput(`Agent Harbor stop · 0 model tokens\n${result}`);
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

function piTeamHelp(value: string): string {
  const match = /^(?:help|--help)(?:\s+page:([1-9]\d*))?$/u.exec(value);
  if (!match) throw new Error("usage: /team help [page:1|page:2|page:3]");
  const page = Number(match[1] ?? 1);
  const pages: readonly (readonly string[])[] = [
    [
      "Agent Harbor /team help · page 1/3 · 0 model tokens",
      "TEAM STATUS AND COMPLETE INDEXES",
      "Overview: /team",
      "Every teammate: /team roster-page:1",
      "Every active run: /team activity-page:1",
      "Every retained mission: /team history-page:1",
      "Exact teammate: /team member:<id>",
      "Exact run telemetry: /team run:<id>",
      "Roster-first maintenance: /bench list page:1",
      "States: ready/idle, starting, working, cleaning, bench, stale, conflict.",
      "Symbols: ● ready/working · ○ benched · ! unhealthy · ↳ child.",
      "Next: /team help page:2",
    ],
    [
      "Agent Harbor /team help · page 2/3 · 0 model tokens",
      "FILTERS AND ZERO-MODEL CONTROLS",
      "Fields: member:, kind:, description:, capability:, tool:, skill:, status:, model:,",
      "thinking:, task:, run:, owner:, pid:, heartbeat:.",
      "Examples: /team status:working · /team member:reviewer · /team owner:copilot.",
      "Every structured field requires a value; unknown prefixes are rejected.",
      "Stop one/all: /team stop <run-id|all>",
      "Bench: /bench list page:1 · /bench on <id...> · /bench off <id...>",
      "Retire personal: /retire <personal-id>",
      "Refresh native aliases after changes: /reload",
      "Previous: /team help page:1 · Next: /team help page:3",
    ],
    [
      "Agent Harbor /team help · page 3/3 · 0 model tokens",
      "MODEL WORK AND DEFINITIONS",
      `Direct teammate: /<id> <task> · ${commandHelp("team-lead").split("\n")[1]}`,
      "Disposable child (exactly one):",
      commandSyntax.contract,
      "Contract requires name, description, prompt, tools, task; optional skills and model.",
      `Recruit: ${commandSyntax.scout} · 1 recruiter model child.`,
      "Persistent teammate:",
      commandSyntax.join,
      "Join requires name, description, prompt, tools; optional skills, model, replace:true.",
      "Observed tokens/cost are provider facts; unreported values stay unobserved.",
      "Capacity: 32 local roots; 32 shared Pi/Copilot persistent claims; contractors excluded",
      "from shared claims. A new team-lead needs two free shared slots for root + first child.",
      "Alt+H or /team stop requests cancellation; cleaning remains until terminal settlement.",
      "Previous: /team help page:2 · Back: /team",
    ],
  ];
  if (page > pages.length) throw new Error(`team help page ${page} is out of range; available pages: 1-${pages.length}`);
  return wrapPlainText(pages[page - 1].join("\n"));
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

function conciseLifecycleResult(
  command: string,
  args: string,
  raw: string,
  lifecycle?: HarborLifecycleOutcome,
): string {
  if (command === "join") {
    const input = JSON.parse(args) as {
      name: string;
      description: string;
      tools: string[];
      skills?: Array<{ name: string }>;
      model?: string;
    };
    const joinLifecycle = requirePiJoinLifecycleOutcome(args, lifecycle);
    const capacity = [
      ...input.tools,
      ...(input.skills ?? []).map(({ name }) => `skill:${name}`),
    ];
    const id = publicMetadataText(input.name, 48) ?? "joined-player";
    const role = publicMetadataText(input.description, 240) ?? "Personal Agent Harbor teammate";
    const model = publicMetadataText(input.model ?? "", 200);
    const alreadyCurrent = joinLifecycle.status === "already-current";
    return [
      alreadyCurrent
        ? `○ ${id} is already joined and current · no roster files changed.`
        : `✓ ${id} joined · personal · ready in this project`,
      `Role: ${role}`,
      `Capacity: ${capacity.join(", ") || "advisory"}`,
      `Model: ${model ? `configured ${model}` : "inherits the Pi host when run"}`,
      `Run: /${id} <task>`,
    ].join("\n");
  }
  if (command === "retire") {
    const id = args.trim();
    const retireLifecycle = requirePiRetireLifecycleOutcome(args, lifecycle);
    const alreadyRetired = retireLifecycle.status === "already-current";
    return [
      alreadyRetired
        ? `○ ${id} was already retired here · no roster files changed.`
        : `✓ ${id} unregistered and deactivated here.`,
      "Other project copies, if any, remain intentionally untouched.",
      "Pi cannot unregister this session's alias in-place; run /reload to remove it from completion.",
    ].join("\n");
  }
  return raw;
}

type BenchLifecycleOutcome = Extract<HarborLifecycleOutcome, { readonly command: "bench" }>;

type JoinLifecycleOutcome = Extract<HarborLifecycleOutcome, { readonly command: "join" }>;
type RetireLifecycleOutcome = Extract<HarborLifecycleOutcome, { readonly command: "retire" }>;

function isLifecycleMutationStatus(value: unknown): value is "changed" | "already-current" {
  return value === "changed" || value === "already-current";
}

/** Fails closed before Pi refreshes or presents an unverified join result. */
export function requirePiJoinLifecycleOutcome(
  args: string,
  lifecycle: HarborLifecycleOutcome | undefined,
): JoinLifecycleOutcome {
  const input = JSON.parse(args) as { name?: unknown };
  if (
    lifecycle?.command !== "join" ||
    typeof input?.name !== "string" ||
    lifecycle.player !== input.name ||
    !isLifecycleMutationStatus(lifecycle.status)
  ) {
    throw new Error("Agent Harbor join returned an incomplete or mismatched lifecycle outcome; roster state is unverified");
  }
  return lifecycle;
}

/** Fails closed before Pi refreshes or presents an unverified retire result. */
export function requirePiRetireLifecycleOutcome(
  args: string,
  lifecycle: HarborLifecycleOutcome | undefined,
): RetireLifecycleOutcome {
  const player = args.trim();
  if (
    lifecycle?.command !== "retire" ||
    lifecycle.player !== player ||
    !isLifecycleMutationStatus(lifecycle.status)
  ) {
    throw new Error("Agent Harbor retire returned an incomplete or mismatched lifecycle outcome; roster state is unverified");
  }
  return lifecycle;
}

function expectedPiBenchMutation(args: string): { readonly action: "on" | "off"; readonly ids: readonly string[] } {
  const match = /^(on|off)\s+(.+)$/u.exec(args.trim());
  if (!match) throw new Error("Agent Harbor bench mutation could not be verified");
  const requested = match[2]!.split(/[\s,]+/u).filter(Boolean);
  const ids = requested.length === 1 && requested[0] === "all"
    ? [...bundledPlayers.keys()]
    : [...new Set(requested)];
  if (!ids.length) throw new Error("Agent Harbor bench mutation could not be verified");
  return { action: match[1] as "on" | "off", ids };
}

/** Fails closed before Pi refreshes or presents an unverified bench mutation. */
export function requirePiBenchLifecycleOutcome(
  args: string,
  lifecycle: HarborLifecycleOutcome | undefined,
): BenchLifecycleOutcome {
  const expected = expectedPiBenchMutation(args);
  if (
    lifecycle?.command !== "bench" ||
    !isLifecycleMutationStatus(lifecycle.status) ||
    !Array.isArray(lifecycle.rows) ||
    lifecycle.rows.length !== expected.ids.length ||
    lifecycle.rows.some((row, index) =>
      row?.id !== expected.ids[index] ||
      row.action !== expected.action ||
      !isLifecycleMutationStatus(row.status)) ||
    lifecycle.status !== (lifecycle.rows.some(({ status }) => status === "changed") ? "changed" : "already-current")
  ) {
    throw new Error("Agent Harbor bench returned an incomplete or mismatched lifecycle outcome; roster state is unverified");
  }
  return lifecycle;
}

function conciseBenchLifecycleResult(lifecycle: BenchLifecycleOutcome): string {
  const rows = lifecycle.rows.map(({ id, action, status }) => status === "changed"
    ? action === "on"
      ? `✓ ${id} enabled in this project.`
      : `✓ ${id} moved to the bench in this project.`
    : `○ ${id} is already ${action === "on" ? "enabled" : "benched"} · this member was unchanged.`);
  if (lifecycle.status === "already-current") rows.push("No roster files changed.");
  return rows.join("\n");
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
  try { return sameCanonicalProject(left, right); }
  catch { return false; }
}

function childToolProject(context: ExtensionContext | undefined, expected: string): string {
  const project = context?.cwd || expected;
  if (!sameProject(project, expected)) {
    throw new Error("Agent Harbor child custom tool cannot cross its invocation project boundary");
  }
  return canonicalProjectIdentity(project);
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
 * Every run is one isolated SDK child. Persistent-player admission/activity
 * is project-shared; anonymous contractor telemetry remains process-local.
 */
export default function agentHarbor(pi: ExtensionAPI): void {
  const registered = new Set<string>();
  const runtime = new PiTeamRuntime();
  const sharedActivityClaims = new Map<string, OpenCodeAgentActivityClaim>();
  const sharedActivityOwnershipUnsubscribers = new Map<string, () => void>();
  const sharedActivityAuthorityFailures = new Map<string, Error>();
  const rootRosterReservations = new Map<string, ReadonlySet<string>>();
  let rosterLifecycleTail = Promise.resolve();
  const withRosterLifecycleGate = async <T>(action: () => T | Promise<T>): Promise<T> => {
    const previous = rosterLifecycleTail;
    let release!: () => void;
    rosterLifecycleTail = new Promise<void>((resolveGate) => { release = resolveGate; });
    await previous;
    try { return await action(); }
    finally { release(); }
  };
  const rootAbortControllers = new Map<string, AbortController>();
  const rootPromises = new Map<string, Promise<unknown>>();
  const rootSettlements = new Map<string, Promise<unknown>>();
  const rootSettlementProjects = new Map<string, string>();
  const lateSettlementNotifications = new Set<string>();
  const liveUiKey = "agent-harbor:team";
  interface LiveUiSurface {
    project: string;
    ctx: ExtensionCommandContext | ExtensionContext;
    timer?: ReturnType<typeof setInterval>;
    unsubscribe?: () => void;
  }
  let liveUiSurface: LiveUiSurface | undefined;
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

  const failSharedActivityOwnership = (runId: string, detail: string): Error => {
    const run = runtime.get(runId);
    const prior = sharedActivityAuthorityFailures.get(runId);
    const owner = run ? `${run.agent}'s` : "the player's";
    const failure = prior ?? new Error(
      `Agent Harbor lost ${owner} exact project-shared activity ownership ${detail}; model work was aborted`,
    );
    sharedActivityAuthorityFailures.set(runId, failure);
    if (run && run.state !== "cleanup-error") runtime.setState(runId, "cleanup-error");
    const controller = run && rootAbortControllers.get(run.rootRunId);
    if (controller && !controller.signal.aborted) controller.abort(failure);
    return failure;
  };

  runtime.subscribe((runId) => {
    const claim = sharedActivityClaims.get(runId);
    const run = runtime.get(runId);
    if (!claim || !run) return;
    const phase = run.state === "working" ? "working"
      : run.state === "cleaning" ? "cleaning" : undefined;
    if (!phase || claim.setPhase(phase)) return;
    failSharedActivityOwnership(runId, `before ${phase}`);
  });

  const sharedRunIdentity = (harness: "pi", agent: string): string =>
    `${harness}:${process.pid}:${agent}:${randomBytes(12).toString("base64url")}`;

  const releaseSharedActivity = (runId: string): boolean => {
    const claim = sharedActivityClaims.get(runId);
    if (!claim) return true;
    sharedActivityOwnershipUnsubscribers.get(runId)?.();
    sharedActivityOwnershipUnsubscribers.delete(runId);
    const released = claim.release();
    if (released) sharedActivityClaims.delete(runId);
    return released;
  };

  const releaseSharedActivityAfter = <T>(runId: string, promise: Promise<T>): Promise<T> => promise.then(
    (value) => {
      const authorityFailure = sharedActivityAuthorityFailures.get(runId);
      if (!releaseSharedActivity(runId)) {
        runtime.setState(runId, "cleanup-error");
        throw new Error(`Agent Harbor work finished, but ${runtime.get(runId)?.agent ?? "the player"}'s shared activity claim could not be released`);
      }
      sharedActivityAuthorityFailures.delete(runId);
      if (authorityFailure) throw authorityFailure;
      return value;
    },
    (error) => {
      const authorityFailure = sharedActivityAuthorityFailures.get(runId);
      if (!releaseSharedActivity(runId)) {
        runtime.setState(runId, "cleanup-error");
        throw new AggregateError([error], `Agent Harbor work failed and ${runtime.get(runId)?.agent ?? "the player"}'s shared activity claim could not be released`);
      }
      sharedActivityAuthorityFailures.delete(runId);
      if (authorityFailure && authorityFailure !== error) {
        throw new AggregateError([error, authorityFailure], "Agent Harbor model work failed after shared activity ownership was lost");
      }
      throw authorityFailure ?? error;
    },
  );

  const currentPersistentPlayer = (project: string, id: string): PlayerDefinition => {
    if (id === scoutPlayer.name) return scoutPlayer;
    const fixed = rolePlayers.get(id);
    return fixed ?? loadPiActivePlayer(project, id);
  };

  const validatePersistentAdmission = (
    project: string,
    expected: PlayerDefinition,
    expectedRoster?: ReadonlyMap<string, PlayerDefinition>,
  ): void => {
    const current = currentPersistentPlayer(project, expected.name);
    // Delegated ContractDefinition values add an invocation-only task. Roster
    // identity is the canonical player profile; task text must never make the
    // same persistent player look stale during its final shared admission.
    const { task: _invocationTask, ...expectedProfile } = expected as PlayerDefinition & { readonly task?: string };
    if (playerDefinitionDigest(current) !== playerDefinitionDigest(expectedProfile as PlayerDefinition)) {
      throw new Error(`active managed player changed during admission: ${expected.name}; inspect /team and retry`);
    }
    if (expectedRoster !== undefined) {
      const currentRoster = preparePlayerRoster(current, project);
      if (rosterSnapshotDigest(currentRoster) !== rosterSnapshotDigest(expectedRoster)) {
        throw new Error(`active roster changed during ${expected.name} admission; inspect /team and retry`);
      }
    }
  };

  const persistentBusyAgents = (project: string): ReadonlySet<string> => new Set([
    ...runtime.activeProjectRuns(project)
      .filter(({ kind }) => kind !== "contractor")
      .map(({ agent }) => agent),
    ...readSharedAgentActivities(project).map(({ agent }) => agent),
  ]);

  const formattedPlayerRosterSnapshot = (
    project: string,
    rosterSnapshot: ReadonlyMap<string, PlayerDefinition>,
    query = "",
  ) => {
    const busyAgents = persistentBusyAgents(project);
    return formatHarborTeamRosterSnapshot(
      [...rosterSnapshot.values()].map((definition) => ({
        id: definition.name,
        role: publicMetadataText(definition.description, 240) ?? "Role not disclosed",
        tools: definition.tools,
        skills: (definition.skills ?? []).map(({ name }) => name),
        ...(definition.model
          ? { configuredModel: publicMetadataText(definition.model, 200) ?? "redacted" }
          : {}),
        availability: busyAgents.has(definition.name) ? "busy" as const : "ready" as const,
      })),
      query,
    );
  };

  const beginClaimedPersistentRun = (
    project: string,
    definition: PlayerDefinition,
    kind: PiTeamMemberKind,
    input: Parameters<PiTeamRuntime["begin"]>[0],
    claimKind: "direct" | "delegated",
    expectedRoster?: ReadonlyMap<string, PlayerDefinition>,
  ): string => {
    const claim = claimValidatedSharedAgentActivity(
      project,
      definition.name,
      claimKind,
      sharedRunIdentity("pi", definition.name),
      "pi",
      () => validatePersistentAdmission(project, definition, expectedRoster),
    );
    try {
      const runId = runtime.begin(input);
      sharedActivityClaims.set(runId, claim);
      sharedActivityOwnershipUnsubscribers.set(runId, claim.onOwnershipLost(() => {
        failSharedActivityOwnership(runId, "while its heartbeat was active");
      }));
      return runId;
    } catch (error) {
      if (!claim.release()) {
        throw new AggregateError([error], `Pi admission failed and ${definition.name}'s shared activity claim could not be released`);
      }
      throw error;
    }
  };

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
    const authorityFailure = sharedActivityAuthorityFailures.get(runId);
    if (authorityFailure && !controller.signal.aborted) controller.abort(authorityFailure);
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
    const settlement = releaseSharedActivityAfter(runId, execution.catch((error) => {
      runtime.finishIfOpen(runId, cancellation(error, effectiveSignal) ? "cancelled" : "failed");
      throw error;
    })).finally(() => {
      callerSignal?.removeEventListener("abort", relayCallerAbort);
      if (rootAbortControllers.get(runId) === controller) rootAbortControllers.delete(runId);
      rootRosterReservations.delete(runId);
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
    const unavailableLocal: string[] = [];
    const externalOwners: Array<{
      id: string;
      ownerRuntime?: "pi" | "copilot";
      processID: number;
    }> = [];
    for (const run of selected) {
      const controller = rootAbortControllers.get(run.id);
      if (run.state === "cleaning" || controller?.signal.aborted) {
        alreadyStopping.push(run.id);
        continue;
      }
      if (!controller) {
        unavailableLocal.push(run.id);
        continue;
      }
      runtime.setState(run.id, "cleaning");
      controller.abort(new DOMException("Stopped by user", "AbortError"));
      stopped.push(run.id);
    }
    let activityAuthorityUnavailable = false;
    try {
      const localPersistent = new Set(active.filter(({ kind }) => kind !== "contractor").map(({ agent }) => agent));
      const external = readSharedAgentActivities(project)
        .filter(({ agent }) => !localPersistent.has(agent))
        .map(({ agent, ownerRuntime, processID }) => ({
          id: `shared-${agent}`,
          ...(ownerRuntime === "pi" || ownerRuntime === "copilot" ? { ownerRuntime } : {}),
          processID,
        }))
        .filter(({ id }) => selector === "all" || selector === id);
      externalOwners.push(...external);
    } catch {
      activityAuthorityUnavailable = true;
    }
    return { stopped, alreadyStopping, unavailableLocal, externalOwners, activityAuthorityUnavailable };
  };

  const stopProjectRootsMessage = (
    result: ReturnType<typeof stopProjectRoots>,
    empty = "No project-shared persistent-player work is visible; disposable contractor work is process-local.",
  ): string => {
    const localLines = [
      ...(result.stopped.length
        ? [`Stopping ${result.stopped.length} Agent Harbor root run(s): ${result.stopped.join(", ")}.`]
        : []),
      ...(result.alreadyStopping.length
        ? [`Already stopping ${result.alreadyStopping.length} root run(s): ${result.alreadyStopping.join(", ")}; waiting for provider cleanup.`]
        : []),
      ...(result.unavailableLocal.length
        ? [`Local stop handle is unavailable for ${result.unavailableLocal.length} root run(s): ${result.unavailableLocal.join(", ")}; inspect /team in this Pi process before retrying.`]
        : []),
    ];
    const authorityLines = [
      ...(result.activityAuthorityUnavailable
        ? ["Persistent-player activity authority is unavailable; Agent Harbor cannot verify or stop work owned by another process."]
        : []),
    ];
    const ownerGroups = new Map<string, {
      ownerRuntime?: "pi" | "copilot";
      processID?: number;
      ids: string[];
    }>();
    for (const { id, ownerRuntime, processID } of result.externalOwners) {
      const validProcessID = Number.isSafeInteger(processID) && processID > 0 ? processID : undefined;
      const key = `${ownerRuntime ?? "unverified"}:${validProcessID ?? "unverified"}`;
      const group = ownerGroups.get(key) ?? {
        ...(ownerRuntime ? { ownerRuntime } : {}),
        ...(validProcessID === undefined ? {} : { processID: validProcessID }),
        ids: [],
      };
      group.ids.push(id);
      ownerGroups.set(key, group);
    }
    const ownerRouteFragments = [...ownerGroups.values()].map(({ ownerRuntime, processID, ids }) => {
      const owner = ownerRuntime && processID !== undefined
        ? `owner ${ownerRuntime} PID ${processID}`
        : processID !== undefined
          ? `owner runtime unverified (legacy claim) · PID ${processID}`
          : "owner runtime/PID unverified";
      const route = `${owner} ×${ids.length}`;
      if (ownerGroups.size > 4 || ids.length !== 1) return route;
      const identified = `${ids[0]} · ${route}`;
      return visibleTextWidth(`• ${identified}`) <= 96 ? identified : route;
    });
    const packedOwnerRoutes: string[] = [];
    for (const fragment of ownerRouteFragments) {
      const current = packedOwnerRoutes.at(-1);
      const candidate = current === undefined ? `• ${fragment}` : `${current} · ${fragment}`;
      if (current !== undefined && visibleTextWidth(candidate) <= 96) {
        packedOwnerRoutes[packedOwnerRoutes.length - 1] = candidate;
      } else {
        packedOwnerRoutes.push(`• ${fragment}`);
      }
    }
    const lines = [
      ...localLines,
      ...(result.externalOwners.length
        ? [
          `Stop authority is in another process for ${result.externalOwners.length} project-shared persistent run(s) across ${ownerGroups.size} owner process route(s):`,
          ...packedOwnerRoutes,
          "Filter external work with /team owner:<runtime> or /team pid:<pid>.",
          "Action: in each listed owning process run /team stop all.",
        ]
        : []),
      ...authorityLines,
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

  const rosterSnapshotDigest = (snapshot: ReadonlyMap<string, PlayerDefinition>): string =>
    [...snapshot.entries()]
      .map(([id, definition]) => `${id}:${playerDefinitionDigest(definition)}`)
      .sort()
      .join("\n");

  const destructiveRosterTargets = (command: string, args: string): string[] => {
    const value = args.trim();
    if (command === "retire") return value ? [value] : [];
    if (command === "join") {
      try {
        const input = JSON.parse(value) as { name?: unknown; replace?: unknown };
        return input.replace === true && typeof input.name === "string" ? [input.name] : [];
      } catch { return []; }
    }
    if (command !== "bench") return [];
    const match = /^off\s+(.+)$/u.exec(value);
    if (!match) return [];
    const requested = [...new Set(match[1].split(/[\s,]+/u).filter(Boolean))];
    return requested.length === 1 && requested[0] === "all"
      ? [...bundledPlayers.keys()]
      : requested;
  };

  const assertRosterMutationAllowed = (
    project: string,
    command: string,
    args: string,
    ignoredRunId?: string,
  ): void => {
    for (const target of destructiveRosterTargets(command, args)) {
      const action = command === "retire"
        ? `retire ${target}`
        : command === "join" ? `replace ${target}` : `bench off ${target}`;
      const busy = runtime.activeProjectRuns(project).find((run) =>
        run.kind !== "contractor" && run.agent === target && run.id !== ignoredRunId);
      if (busy) {
        throw new Error(
          `cannot ${action} while it is ${busy.state} in ${busy.rootRunId}; ` +
          `use /team stop ${busy.rootRunId}, then wait for cleanup to settle`,
        );
      }
      const owner = runtime.activeProjectRuns(project).find((run) =>
        run.parentRunId === undefined && run.id !== ignoredRunId && rootRosterReservations.get(run.rootRunId)?.has(target));
      if (owner) {
        throw new Error(
          `cannot ${action} while ${owner.agent} owns its active roster snapshot in ${owner.rootRunId}; ` +
          `use /team stop ${owner.rootRunId}, then wait for cleanup to settle`,
        );
      }
    }
  };

  const withProjectRosterMutationGate = <T>(
    project: string,
    command: string,
    args: string,
    action: () => Promise<T>,
    ignoredRunId?: string,
  ): Promise<T> => {
    const targets = destructiveRosterTargets(command, args);
    // Preserve the exact process-local run/root guidance when this Pi owns the
    // conflict. The shared gate immediately below is still the final
    // cross-process validation and is acquired synchronously before `action`
    // can yield, so another runtime cannot win the admission gap.
    assertRosterMutationAllowed(project, command, args, ignoredRunId);
    if (!targets.length) return action();
    const label = command === "retire"
      ? `retire ${targets.join(", ")}`
      : command === "join"
        ? `replace ${targets.join(", ")}`
        : `turn off ${targets.join(", ")}`;
    return withSharedRosterMutationGate(
      project,
      targets,
      label,
      action,
      ignoredRunId === undefined ? undefined : sharedActivityClaims.get(ignoredRunId)?.snapshot.claimToken,
    );
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
    const runInput = {
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
    } satisfies Parameters<PiTeamRuntime["begin"]>[0];
    const runId = kind === "contractor"
      ? runtime.begin(runInput)
      : beginClaimedPersistentRun(cwd, definition, kind, runInput, parentRunId === undefined ? "direct" : "delegated");
    const execute = (effectiveSignal: AbortSignal | undefined) =>
      executeRun(definition, runId, cwd, sessionOptions, effectiveSignal, additionalTools, customTools);
    const result = parentRunId === undefined
      ? trackRootExecution(runId, cwd, signal, execute)
      : releaseSharedActivityAfter(
        runId,
        execute(combineSignals(signal, rootAbortControllers.get(runtime.get(runId)!.rootRunId)?.signal)),
      );
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
    const busyAtAdmission = persistentBusyAgents(cwd);
    const compactRoster = boundedLeadRoster([...delegationRoster].map(([id, definition]) =>
      leadRosterPreviewRow(definition, busyAtAdmission.has(id))));
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
      const snapshot = formattedPlayerRosterSnapshot(project, rosterSnapshot, call.query);
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
      const snapshot = formattedPlayerRosterSnapshot(project, rosterSnapshot, call.query);
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
      const committed = await withRosterLifecycleGate(() => withProjectRosterMutationGate(
        project,
        "join",
        call.definition,
        async () => {
        const result = await runDeterministicCommandResult("pi", "join", call.definition, project, effectiveSignal);
        const joined = JSON.parse(call.definition) as { name: string };
        const lifecycle = requirePiJoinLifecycleOutcome(call.definition, result.lifecycle);
        if (lifecycle.status === "changed") onJoinCommitted(joined.name);
        return { ...result, lifecycle };
        },
        parentRunId,
      ));
      guard.succeed(ticket);
      return {
        content: [{ type: "text", text: conciseLifecycleResult(
          "join",
          call.definition,
          committed.text,
          committed.lifecycle,
        ) }],
        details: {
          harness: "pi",
          action: "join",
          lifecycleStatus: committed.lifecycle?.status,
          modelTokens: 0,
        },
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
    if (player.name === "team-lead" && rosterSnapshot.size > maximumHarborTeamRosterMembers) {
      throw new Error(`team lead supports at most ${maximumHarborTeamRosterMembers} enabled specialists; found ${rosterSnapshot.size}. Use /team, then /bench off <id...> to reduce the enabled roster`);
    }
    return rosterSnapshot;
  };

  const assertPlayerRosterStartPreflight = (
    player: PlayerDefinition,
    cwd: string,
    rosterSnapshot: ReadonlyMap<string, PlayerDefinition>,
  ): void => {
    if (rosterSnapshot.size) {
      const formatted = formattedPlayerRosterSnapshot(cwd, rosterSnapshot);
      if (!formatted.complete) throw new Error(formatted.text);
    }
    if (player.name === "team-lead") {
      const sharedClaims = readSharedAgentActivities(cwd).length;
      const maximumExistingClaims = maximumConcurrentPiRoots - 2;
      if (sharedClaims > maximumExistingClaims) {
        throw new Error(
          `team-lead needs two project-shared slots for its root and first specialist; ` +
          `${sharedClaims}/${maximumConcurrentPiRoots} are already occupied. Wait or use /team stop all`,
        );
      }
    }
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
    const runInput = {
      project: cwd,
      agent: player.name,
      kind: playerKind(player),
      task,
      ...(model === undefined ? {} : { model: modelIdentity(model) }),
      ...(model === undefined ? {} : {
        modelSource: player.model === undefined ? "inherited" as const : "configured" as const,
      }),
      ...(thinkingLevel === undefined ? {} : { thinking: thinkingLevel }),
    } satisfies Parameters<PiTeamRuntime["begin"]>[0];
    const runId = beginClaimedPersistentRun(
      cwd,
      player,
      playerKind(player),
      runInput,
      "direct",
      rosterSnapshot.size ? rosterSnapshot : undefined,
    );
    if (rosterSnapshot.size) {
      rootRosterReservations.set(runId, new Set(rosterSnapshot.keys()));
    }
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
      rootRosterReservations.delete(runId);
      runtime.finishIfOpen(runId, "failed");
      if (!releaseSharedActivity(runId)) {
        runtime.setState(runId, "cleanup-error");
        throw new AggregateError([error], `Pi startup failed and ${player.name}'s shared activity claim could not be released`);
      }
      throw error;
    }
  };

  const startPlayerAfterPreflight = async (
    player: PlayerDefinition,
    managed: boolean,
    task: string,
    cwd: string,
    sessionOptions: PiSessionOptions,
    rosterSnapshot: ReadonlyMap<string, PlayerDefinition>,
    signal?: AbortSignal,
    onScoutJoinCommitted: (id: string) => void = () => {},
  ): Promise<StartedPiRun> => withRosterLifecycleGate(() => {
    signal?.throwIfAborted();
    let current = player;
    if (managed) {
      try { current = loadPiActivePlayer(cwd, player.name); }
      catch {
        throw new Error(`active managed player changed during preflight: ${player.name}; inspect /team and retry`);
      }
    }
    if (playerDefinitionDigest(current) !== playerDefinitionDigest(player)) {
      throw new Error(`active managed player changed during preflight: ${player.name}; inspect /team and retry`);
    }
    const currentRoster = preparePlayerRoster(current, cwd);
    if (rosterSnapshotDigest(currentRoster) !== rosterSnapshotDigest(rosterSnapshot)) {
      throw new Error(`active roster changed during ${player.name} preflight; inspect /team and retry`);
    }
    return startPlayer(current, task, cwd, sessionOptions, currentRoster, signal, onScoutJoinCommitted);
  });

  const disposeLiveUi = (surface: LiveUiSurface): void => {
    if (surface.timer) clearInterval(surface.timer);
    surface.unsubscribe?.();
    safeUi(() => surface.ctx.ui.setStatus?.(liveUiKey, undefined));
    safeUi(() => surface.ctx.ui.setWidget?.(liveUiKey, undefined));
    if (liveUiSurface === surface) liveUiSurface = undefined;
  };

  const renderLiveUi = (surface: LiveUiSurface): void => {
    if (liveUiSurface !== surface) return;
    if (!runtime.activeProjectRuns(surface.project).length) {
      disposeLiveUi(surface);
      return;
    }
    safeUi(() => surface.ctx.ui.setStatus?.(
      liveUiKey,
      formatPiProjectLiveStatus(runtime, surface.project),
    ));
    safeUi(() => surface.ctx.ui.setWidget?.(
      liveUiKey,
      formatPiProjectLiveWidget(runtime, surface.project),
      { placement: "aboveEditor" },
    ));
  };

  const focusLiveUi = (ctx: ExtensionCommandContext | ExtensionContext): LiveUiSurface => {
    if (liveUiSurface && sameProject(liveUiSurface.project, ctx.cwd)) {
      liveUiSurface.ctx = ctx;
      renderLiveUi(liveUiSurface);
      return liveUiSurface;
    }
    if (liveUiSurface) disposeLiveUi(liveUiSurface);
    const surface: LiveUiSurface = { project: ctx.cwd, ctx };
    liveUiSurface = surface;
    surface.unsubscribe = runtime.subscribe(() => renderLiveUi(surface));
    surface.timer = setInterval(() => renderLiveUi(surface), 1000);
    surface.timer.unref?.();
    renderLiveUi(surface);
    return surface;
  };

  const notifyLateSettlement = (
    ctx: ExtensionCommandContext | ExtensionContext,
    run: StartedPiRun,
  ): void => {
    if (lateSettlementNotifications.has(run.runId)) return;
    const settlement = rootSettlements.get(run.runId);
    if (!settlement) return;
    lateSettlementNotifications.add(run.runId);
    void settlement.then(() => undefined, () => undefined).then(() => {
      // Let the slash handler publish its immediate "cleanup pending" result
      // before this detached terminal update, even for a very fast provider.
      setTimeout(() => {
        lateSettlementNotifications.delete(run.runId);
        const state = runtime.get(run.runId)?.state;
        if (!state || state === "starting" || state === "working" || state === "cleaning") return;
        const level: NoticeLevel = state === "completed" ? "info"
          : state === "cancelled" ? "warning" : "error";
        const outcome = state === "cancelled"
          ? `Provider cleanup settled · ${run.runId} is cancelled.`
          : state === "completed"
            ? `Provider cleanup settled · ${run.runId} completed.`
            : `Provider cleanup settled · ${run.runId} ended ${state}.`;
        safeUi(() => notify(ctx, wrapPlainText(`${outcome}${formatPiMissionReport(runtime, run.runId)}`), level));
      }, 0);
    }).catch(() => { lateSettlementNotifications.delete(run.runId); });
  };

  const trackUi = async (ctx: ExtensionCommandContext | ExtensionContext, run: StartedPiRun): Promise<string> => {
    const surface = focusLiveUi(ctx);
    try { return await run.result; }
    finally {
      // A different root may still own the shared project surface. A provider
      // that ignored abort also remains truthfully visible as cleaning until
      // its real settlement emits a terminal state.
      if (liveUiSurface === surface) renderLiveUi(surface);
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
          assertPlayerRosterStartPreflight(player, ctx.cwd, rosterSnapshot);
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
          run = await startPlayerAfterPreflight(
            player,
            fixed === undefined,
            args,
            ctx.cwd,
            sessionOptions,
            rosterSnapshot,
            ctx.signal,
          );
          const text = await trackUi(ctx, run);
          notify(ctx, `${text}${formatPiMissionReport(runtime, run.runId)}`, "info");
        } catch (error) {
          const state = run ? runtime.get(run.runId)?.state : undefined;
          if (run && (state === "cancelled" || state === "cleaning")) {
            if (state === "cleaning") notifyLateSettlement(ctx, run);
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
      const observedOwnerItems: Array<{ value: string; label: string; description: string }> = [];
      try {
        const values = new Set<string>();
        for (const { ownerRuntime, processID } of readSharedAgentActivities(completionProject)) {
          if (ownerRuntime === "pi" || ownerRuntime === "copilot") values.add(`owner:${ownerRuntime}`);
          if (Number.isSafeInteger(processID) && processID > 0) values.add(`pid:${processID}`);
        }
        for (const value of values) {
          observedOwnerItems.push({
            value,
            label: `${value} · observed owner route`,
            description: value.startsWith("pid:")
              ? "Filter project-shared work owned by this observed process"
              : "Filter project-shared work owned by this observed runtime",
          });
        }
      } catch { /* Completion remains useful when shared activity authority is unavailable. */ }
      const filterItems = [
        { value: "help", label: "help · page 1/3", description: "Show status and index routes" },
        { value: "help page:2", label: "help page:2 · filters", description: "Show filters and zero-model controls" },
        { value: "help page:3", label: "help page:3 · model work", description: "Show schemas, costs, and capacity" },
        { value: "roster-page:1", label: "roster-page:1 · complete index", description: "Enumerate every teammate with exact detail routes" },
        { value: "activity-page:1", label: "activity-page:1 · complete index", description: "Enumerate every active run with exact IDs" },
        { value: "history-page:1", label: "history-page:1 · retained missions", description: "Enumerate retained terminal mission IDs" },
        { value: "status:bench", label: "status:bench · roster", description: "Show benched teammates" },
        { value: "status:idle", label: "status:idle · roster", description: "Show ready teammates with no active work" },
        { value: "status:ready", label: "status:ready · roster", description: "Show teammates available now" },
        { value: "status:working", label: "status:working · live", description: "Show teammates working now" },
        { value: "heartbeat:overdue", label: "heartbeat:overdue · recovery", description: "Show external claims whose heartbeat is overdue" },
        { value: "kind:personal", label: "kind:personal · roster", description: "Show personal teammates" },
        { value: "model:", label: "model:<name> · roster/activity", description: "Filter configured or observed model" },
        { value: "task:", label: "task:<label> · activity", description: "Filter safe active or historical task labels" },
        { value: "owner:", label: "owner:<pi|copilot> · external activity", description: "Filter project-shared work by owner runtime" },
        { value: "pid:", label: "pid:<number> · external activity", description: "Filter project-shared work by owner process ID" },
        ...observedOwnerItems,
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
        const stopValue = args.trimStart();
        if (stopValue === "stop" || stopValue.startsWith("stop ")) {
          const selector = stopValue.slice("stop".length).trim();
          if (!selector) throw new Error("usage: /team stop <run-id|all>");
          requireBoundedArguments(selector, maximumPiStopSelectorBytes, "/team stop selector");
          const result = stopProjectRoots(ctx.cwd, selector);
          const matched = result.stopped.length + result.alreadyStopping.length
            + result.unavailableLocal.length + result.externalOwners.length;
          if (!matched && selector === "all" && !result.activityAuthorityUnavailable) {
            notify(ctx, stopResult("No project-shared persistent-player work is visible; disposable contractor work is process-local."), "info");
            return;
          }
          if (!matched && !result.activityAuthorityUnavailable) throw new Error(`no active Harbor root matches ${selector}`);
          notify(ctx, stopResult(stopProjectRootsMessage(result)), "warning");
          return;
        }
        requireBoundedArguments(args, maximumPiFilterBytes, "/team arguments");
        const value = args.trim();
        const help = /^(?:help|--help)(?:\s+page:.*)?$/u.test(value);
        const result = help
          ? piTeamHelp(value)
          : await formatPiTeamView(ctx.cwd, runtime, {
            filter: value,
            title: "team",
            ...teamViewRuntimeOptions(ctx),
            ...(discoveryWarning ? { discoveryWarning } : {}),
          });
        notify(ctx, boundedPiTeamOutput(
          result,
          help && discoveryWarning ? ["", `Warning: ${discoveryWarning}`] : [],
        ), "info");
      } catch (error) { failCommand(ctx, boundedPiTeamOutput(humanError("team", error, true))); }
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
            let { lifecycle, refresh } = await withRosterLifecycleGate(() => withProjectRosterMutationGate(
              ctx.cwd,
              name,
              args,
              async () => {
              const committed = await runDeterministicCommandResult("pi", name, args, ctx.cwd, ctx.signal);
              const lifecycle = requirePiBenchLifecycleOutcome(args, committed.lifecycle);
              let refreshWarning = "";
              // A filesystem no-op can still be new to this Pi process when a
              // CLI or another session committed it after startup. Reconcile
              // discovery on every verified lifecycle outcome.
              try { syncActivePlayers(ctx.cwd); }
              catch {
                discoveryWarning = metadataRefreshWarning;
                refreshWarning = `\nWarning: ${metadataRefreshWarning}`;
              }
              return { lifecycle, refresh: refreshWarning };
              },
            ));
            let view: string;
            try { view = await formatPiTeamView(ctx.cwd, runtime, { title: "bench", ...teamViewRuntimeOptions(ctx) }); }
            catch {
              discoveryWarning = metadataRefreshWarning;
              if (!refresh) refresh = `\nWarning: ${metadataRefreshWarning}`;
              view = "Team view unavailable until roster repair and /reload.";
            }
            const changedOff = lifecycle.rows.some(({ action, status }) => action === "off" && status === "changed");
            const unchangedOff = lifecycle.rows.some(({ action, status }) => action === "off" && status === "already-current");
            const reload = changedOff
              ? "\nPi cannot unregister deactivated aliases in-place; run /reload to remove them from completion."
              : unchangedOff
                ? "\nIf this session still lists a benched alias, run /reload to remove it from completion."
                : "";
            const all = /^(?:on|off)\s+all$/u.test(args.trim()) ? `\n${benchAllNote}` : "";
            notify(ctx, `${zeroModelResult(name, conciseBenchLifecycleResult(lifecycle))}${all}${reload}${refresh}\n\n${withoutViewHeader(view)}`, "info");
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
              if (state === "cleaning") notifyLateSettlement(ctx, run);
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
          const execute = async () => {
            const result = await runDeterministicCommandResult(
              "pi",
              name,
              args,
              ctx.cwd,
              ctx.signal,
              name === "list-skills" ? "ansi" : "plain",
            );
            let refresh = "";
            const joinLifecycle = name === "join"
              ? requirePiJoinLifecycleOutcome(args, result.lifecycle)
              : undefined;
            const retireLifecycle = name === "retire"
              ? requirePiRetireLifecycleOutcome(args, result.lifecycle)
              : undefined;
            const lifecycle = joinLifecycle ?? retireLifecycle;
            const verifiedResult = lifecycle ? { ...result, lifecycle } : result;
            if (lifecycle) {
              // Reconcile even after a verified no-op: another process may
              // have changed discovery state since this extension started.
              try { syncActivePlayers(ctx.cwd); }
              catch { discoveryWarning = metadataRefreshWarning; refresh = `\nWarning: ${metadataRefreshWarning}`; }
            }
            return { result: verifiedResult, refresh };
          };
          const { result, refresh } = name === "join" || name === "retire"
            ? await withRosterLifecycleGate(() => withProjectRosterMutationGate(ctx.cwd, name, args, execute))
            : await execute();
          notify(ctx, `${zeroModelResult(name, conciseLifecycleResult(name, args, result.text, result.lifecycle))}${refresh}`, "info");
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
        assertPlayerRosterStartPreflight(scoutPlayer, ctx.cwd, rosterSnapshot);
        const model = resolveConfiguredPiModel(undefined, ctx);
        const sessionOptions = await captureSessionOptions(ctx, model, pi.getThinkingLevel());
        run = await startPlayerAfterPreflight(
          scoutPlayer,
          false,
          args,
          ctx.cwd,
          sessionOptions,
          rosterSnapshot,
          ctx.signal,
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
            if (state === "cleaning") notifyLateSettlement(ctx, run);
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
      const matched = result.stopped.length + result.alreadyStopping.length
        + result.unavailableLocal.length + result.externalOwners.length;
      notify(ctx, stopResult(stopProjectRootsMessage(result)), matched ? "warning" : "info");
    },
  });
  pi.on?.("session_shutdown", async () => {
    for (const controller of rootAbortControllers.values()) {
      if (!controller.signal.aborted) controller.abort(new DOMException("Pi session shutdown", "AbortError"));
    }
    try { await settlePiRootPromises([...rootSettlements.values()]); }
    finally { if (liveUiSurface) disposeLiveUi(liveUiSurface); }
  });
  try { syncActivePlayers(process.cwd()); }
  catch { discoveryWarning = "Active alias discovery failed; fixed controls remain available. Inspect /team, then run /reload after repairing the roster."; }
}
