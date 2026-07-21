/** Pi extension entrypoint, zero-model controls, live team status, and delegation. */
import * as hostPiSdk from "@earendil-works/pi-coding-agent";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  Model,
  ThinkingLevel,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { listInvocablePlayers, listManagedActiveIds, loadPiActivePlayer } from "../core/active.js";
import { parseContractDefinition } from "../core/commands.js";
import { bundledPlayers, rolePlayers, scoutPlayer, trustedSkills } from "../core/defaults.js";
import { GhResolver } from "../core/github.js";
import { isHarborId } from "../core/identity.js";
import { commandNames, type ContractDefinition, type PlayerDefinition } from "../core/types.js";
import { wrapPlainText } from "../core/text-layout.js";
import { normalizeDelegatedTaskPaths } from "../core/profiles.js";
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

function resolveConfiguredPiModel(configured: string | undefined, ctx: ExtensionContext): Model | undefined {
  if (configured === undefined) return ctx.model;
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

function zeroModelResult(command: string, result: string): string {
  return wrapPlainText(`Agent Harbor /${command} · 0 model tokens\n${result}`);
}

function stopResult(result: string): string {
  return wrapPlainText(`Agent Harbor stop · 0 model tokens\n${result}`);
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
  if (/active managed player preflight failed/iu.test(raw)) {
    return [
      `/${command} is no longer active or current in this Pi session.`,
      preflightZeroLine,
      commandHelp(command),
      "Run /team to inspect the roster, then /reload to remove stale aliases.",
    ].join("\n");
  }
  let message = raw;
  if (error instanceof SyntaxError || /JSON/u.test(error instanceof Error ? error.name : "")) {
    message = `Invalid JSON for /${command}. Expected exactly one JSON object.`;
  } else if (/usage:/iu.test(raw)) {
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
    const input = JSON.parse(args) as { name: string; description: string; tools: string[] };
    return [
      `✓ ${input.name} joined · personal · ready in this project`,
      `Role: ${input.description} · capacity: ${input.tools.join(", ")}`,
      `Run: /${input.name} <task>`,
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
  const normalized = value.replace(/[\p{Cc}\p{Cf}\s]+/gu, " ").trim();
  const points = [...normalized];
  return points.length <= limit ? normalized : `${points.slice(0, Math.max(0, limit - 1)).join("")}…`;
}

function leadRosterRow(definition: PlayerDefinition, busy = false): string {
  return JSON.stringify({
    id: definition.name,
    role: compactPublicText(definition.description, 120),
    tools: definition.tools,
    skills: (definition.skills ?? []).map(({ name }) => name).slice(0, 12),
    busy,
  });
}

function boundedLeadRoster(rows: readonly string[], maximumCharacters = 6_000): string {
  const shown: string[] = [];
  let length = 0;
  for (const row of rows) {
    const increment = row.length + (shown.length ? 2 : 0);
    if (length + increment > maximumCharacters) break;
    shown.push(row);
    length += increment;
  }
  const omitted = rows.length - shown.length;
  return `${shown.join("; ")}${omitted ? `; +${omitted} more active; use optional harbor_team_roster` : ""}`;
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
  const loadHostSdk = async () => hostPiSdk;
  let completionProject = process.cwd();
  let discoveryWarning: string | undefined;
  const metadataRefreshWarning = "Pi command metadata refresh failed after the roster change was committed; run /reload. No rollback was attempted.";

  const combineSignals = (...signals: Array<AbortSignal | undefined>): AbortSignal | undefined => {
    const present = signals.filter((signal): signal is AbortSignal => signal !== undefined);
    return present.length > 1 ? AbortSignal.any(present) : present[0];
  };

  const trackRootExecution = (
    runId: string,
    callerSignal: AbortSignal | undefined,
    execute: (signal: AbortSignal) => Promise<string>,
  ): Promise<string> => {
    const controller = new AbortController();
    rootAbortControllers.set(runId, controller);
    const effectiveSignal = combineSignals(callerSignal, controller.signal)!;
    let tracked: Promise<string>;
    try {
      tracked = execute(effectiveSignal).finally(() => {
        if (rootAbortControllers.get(runId) === controller) rootAbortControllers.delete(runId);
        if (rootPromises.get(runId) === tracked) rootPromises.delete(runId);
      });
    } catch (error) {
      rootAbortControllers.delete(runId);
      throw error;
    }
    rootPromises.set(runId, tracked);
    return tracked;
  };

  const stopProjectRoots = (project: string, selector = "all"): string[] => {
    const activeRoots = runtime.activeProjectRuns(project).filter((run) => run.parentRunId === undefined);
    const selected = selector === "all" ? activeRoots : activeRoots.filter((run) => run.id === selector);
    for (const run of selected) {
      const controller = rootAbortControllers.get(run.id);
      if (controller && !controller.signal.aborted) {
        controller.abort(new DOMException("Stopped by user", "AbortError"));
      }
    }
    return selected.map(({ id }) => id);
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
    if (kind === "contractor") return;
    const busy = runtime.activeProjectRuns(project).find((run) => run.kind !== "contractor" && run.agent === agent);
    if (busy) throw new Error(`${agent} is already working in ${busy.rootRunId}; wait or use /team stop ${busy.rootRunId}`);
  };

  const currentSessionOptions = (model: Model | undefined): PiSessionOptions => ({
    ...(model === undefined ? {} : { model }),
    thinkingLevel: pi.getThinkingLevel(),
  });

  const teamViewRuntimeOptions = (ctx: ExtensionContext) => {
    let nextThinking: ThinkingLevel | undefined;
    try { nextThinking = pi.getThinkingLevel(); } catch { /* Keep deterministic inspection available. */ }
    return {
      ...(ctx.model === undefined ? {} : {
        nextModel: {
          provider: ctx.model.provider,
          id: ctx.model.id,
          ...(typeof ctx.model.maxTokens === "number" ? { maxTokens: ctx.model.maxTokens } : {}),
        },
      }),
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
      runtime.finishIfOpen(runId, "completed");
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
    if (parentRunId === undefined) assertRootStartAllowed(cwd, definition.name, kind);
    const runId = runtime.begin({
      project: cwd,
      agent: definition.name,
      kind,
      task: definition.task,
      ...(parentRunId === undefined ? {} : { parentRunId }),
      ...(sessionOptions.model === undefined ? {} : { model: modelIdentity(sessionOptions.model) }),
      ...(sessionOptions.thinkingLevel === undefined ? {} : { thinking: sessionOptions.thinkingLevel }),
    });
    const execute = (effectiveSignal: AbortSignal | undefined) =>
      executeRun(definition, runId, cwd, sessionOptions, effectiveSignal, additionalTools, customTools);
    const result = parentRunId === undefined
      ? trackRootExecution(runId, signal, execute)
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
    const delegationTargets = [...delegationRoster.keys()];
    const compactRoster = boundedLeadRoster([...delegationRoster].map(([id, definition]) =>
      leadRosterRow(definition,
        runtime.activeProjectRuns(cwd).some((run) => run.kind !== "contractor" && run.agent === id))));
    return {
      name: "harbor_delegate",
      label: "Agent Harbor Delegate",
      description: `Run one active named specialist and return only its evidence. Compact active roster: ${compactRoster}.`,
      executionMode: "sequential",
      parameters: {
        type: "object",
        properties: {
          agent: { type: "string", enum: delegationTargets, description: "Exact active Agent Harbor agent ID" },
          task: { type: "string", description: "Complete bounded task for that agent" },
        },
        required: ["agent", "task"],
        additionalProperties: false,
      },
      execute: async (_id, params: { agent: string; task: string }, signal, _update, context) => {
        const project = context?.cwd || cwd;
        if (!isHarborId(params.agent) || params.agent === "team-lead") throw new Error("invalid or recursive delegation target");
        if (typeof params.task !== "string" || !params.task.trim()) throw new Error("delegation requires a non-empty task");
        const player = delegationRoster.get(params.agent);
        if (!player) throw new Error(`delegation target ${params.agent} is not in this team-lead roster snapshot`);
        const busy = runtime.activeProjectRuns(project).find((run) =>
          run.kind !== "contractor" && run.agent === params.agent && run.rootRunId !== parentRunId);
        if (busy) throw new Error(`delegation target ${params.agent} is busy in ${busy.rootRunId}; wait or stop that run`);
        if (calls >= 6) throw new Error("delegation limit reached (6)");
        if (delegatedAgents.has(params.agent)) throw new Error(`already delegated to ${params.agent} in this team-lead run`);
        calls += 1;
        delegatedAgents.add(params.agent);
        const delegateSessionOptions: PiSessionOptions = {
          ...leadSessionOptions,
          ...(context.model === undefined ? {} : { model: context.model }),
        };
        const definition = { ...player, task: normalizeDelegatedTaskPaths(params.task, project) };
        const child = startDefinition(definition, project, delegateSessionOptions, playerKind(player), signal, parentRunId);
        const text = await child.result;
        // Accounting remains outside this content so the lead reasons only over specialist evidence.
        return { content: [{ type: "text", text }], details: { harness: "pi", agent: params.agent, call: calls } };
      },
    };
  };

  const createTeamRosterTool = (cwd: string, rosterSnapshot: ReadonlyMap<string, PlayerDefinition>): ToolDefinition => ({
    name: "harbor_team_roster",
    label: "Agent Harbor Team Roster",
    description: "Optionally search current active specialists by public role, tool, or skill metadata; deterministic and creates no child.",
    executionMode: "sequential",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Optional concise ID, role, tool, or skill filter; use an empty string for all" },
      },
      required: ["query"],
      additionalProperties: false,
    },
    execute: async (_id, params: { query: string }, _signal, _update, context) => {
      if (typeof params.query !== "string" || [...params.query].length > 80) throw new Error("team roster query must be at most 80 characters");
      const project = context?.cwd || cwd;
      const query = params.query.trim().toLowerCase();
      const definitions = [...rosterSnapshot.values()];
      const matches = definitions.filter((definition) => !query || [
        definition.name,
        definition.description,
        ...definition.tools,
        ...(definition.skills ?? []).map(({ name }) => name),
      ].some((value) => value.toLowerCase().includes(query)));
      const shown = matches.slice(0, 24);
      const text = matches.length
        ? [`Lead-start roster snapshot · showing ${shown.length}/${matches.length}`,
          ...shown.map((definition) => leadRosterRow(definition,
            runtime.activeProjectRuns(project).some((run) => run.kind !== "contractor" && run.agent === definition.name))),
          ...(matches.length > shown.length ? ["Refine query to see omitted matches."] : [])].join("\n")
        : `No active specialist matches “${compactPublicText(params.query, 80)}”.`;
      return { content: [{ type: "text", text }], details: { harness: "pi", deterministic: true, childCreated: false } };
    },
  });

  const createScoutTools = (cwd: string, onJoinCommitted: (id: string) => void): ToolDefinition[] => {
    let filterCalls = 0;
    let joinCalls = 0;
    return [{
    name: "harbor_filter_skills",
    label: "Agent Harbor Skill Filter",
    description: "Search only the exact execution-trusted skill group by public metadata.",
    executionMode: "sequential",
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "Concise capability keywords" } },
      required: ["query"], additionalProperties: false,
    },
    execute: async (_id, params: { query: string }, signal) => {
      if (filterCalls >= 3) throw new Error("talent scout filter limit reached (3)");
      filterCalls += 1;
      const text = formatScoutSkillMatches(await filterTrustedSkills(params.query, trustedSkills, new GhResolver(), signal));
      return { content: [{ type: "text", text }], details: { harness: "pi", scope: "trusted-skills" } };
    },
  }, {
    name: "harbor_join_player",
    label: "Agent Harbor Join Player",
    description: "Validate, register, and activate exactly one persistent player.",
    executionMode: "sequential",
    parameters: {
      type: "object",
      properties: { definition: { type: "string", description: "Complete player definition serialized as JSON" } },
      required: ["definition"], additionalProperties: false,
    },
    execute: async (_id, params: { definition: string }, signal, _update, context) => {
      if (joinCalls >= 1) throw new Error("talent scout may join at most one player per run");
      joinCalls += 1;
      const project = context?.cwd || cwd;
      const text = await runDeterministicCommand("pi", "join", params.definition, project, signal);
      const joined = JSON.parse(params.definition) as { name: string };
      onJoinCommitted(joined.name);
      return {
        content: [{ type: "text", text: conciseLifecycleResult("join", params.definition, text) }],
        details: { harness: "pi", action: "join", modelTokens: 0 },
      };
    },
    }];
  };

  const startPlayer = (
    player: PlayerDefinition,
    task: string,
    cwd: string,
    model: Model | undefined,
    thinkingLevel: ThinkingLevel,
    signal?: AbortSignal,
    onScoutJoinCommitted: (id: string) => void = () => {},
  ): StartedPiRun => {
    if (!task.trim()) throw new Error(`/${player.name} requires a non-empty task`);
    assertRootStartAllowed(cwd, player.name, playerKind(player));
    const leadSnapshot = player.name === "team-lead"
      ? new Map(listInvocablePlayers("pi", cwd)
        .filter(({ id }) => id !== "team-lead")
        .map(({ id, definition }) => [id, definition] as const))
      : new Map<string, PlayerDefinition>();
    if (leadSnapshot.size > 32) {
      throw new Error(`team lead supports at most 32 active specialists; found ${leadSnapshot.size}. Use /team, then /bench off <id...> to reduce the active roster`);
    }
    const sessionOptions: PiSessionOptions = { ...(model === undefined ? {} : { model }), thinkingLevel };
    completionProject = cwd;
    const runId = runtime.begin({
      project: cwd,
      agent: player.name,
      kind: playerKind(player),
      task,
      ...(model === undefined ? {} : { model: modelIdentity(model) }),
      thinking: thinkingLevel,
    });
    try {
      const customTools = player.name === "team-lead"
        ? [createDelegateTool(cwd, sessionOptions, runId, leadSnapshot), createTeamRosterTool(cwd, leadSnapshot)]
        : player.name === scoutPlayer.name ? createScoutTools(cwd, onScoutJoinCommitted) : [];
      const additionalTools = customTools.map((tool) => tool.name);
      return {
        runId,
        result: trackRootExecution(runId, signal, (effectiveSignal) =>
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
    pi.registerCommand(id, {
      description: `${cost} · /${id} <task> · ${display?.description ?? `Run active Agent Harbor player ${id}`}`,
      handler: async (args, ctx) => {
        completionProject = ctx.cwd;
        let run: StartedPiRun | undefined;
        try {
          let player: PlayerDefinition;
          try { player = fixed ?? loadPiActivePlayer(ctx.cwd, id); }
          catch { throw new Error(`active managed player preflight failed: ${id}`); }
          run = startPlayer(player, args, ctx.cwd, resolveConfiguredPiModel(player.model, ctx), pi.getThinkingLevel(), ctx.signal);
          const text = await trackUi(ctx, run);
          notify(ctx, `${text}${formatPiMissionReport(runtime, run.runId)}`, "info");
        } catch (error) {
          if (run && runtime.get(run.runId)?.state === "cancelled") {
            notify(ctx, `Cancelled.${formatPiMissionReport(runtime, run.runId)}`, "warning");
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
    for (const id of listManagedActiveIds("pi", project)) {
      const display = bundledPlayers.get(id) ?? loadPiActivePlayer(project, id);
      registerPlayer(id, undefined, display, true);
    }
    discoveryWarning = undefined;
  };

  const teamCompletions = async (prefix: string) => {
    try {
      const members = await collectPiTeamMembers(completionProject);
      const normalized = prefix.trim().toLowerCase();
      const activeRoots = runtime.activeProjectRuns(completionProject).filter((run) => run.parentRunId === undefined);
      const items = [...members.map((member) => ({
        value: member.id,
        label: `${member.id} · ${member.kind}/${member.availability}`,
        description: `${member.description} (${member.capacity})`,
      })), ...(activeRoots.length ? [{ value: "stop all", label: "stop all · deterministic", description: "Stop all active Harbor root runs" }] : []),
      ...activeRoots.map((run) => ({
        value: `stop ${run.id}`,
        label: `stop ${run.id} · ${run.agent}`,
        description: `Stop ${run.agent}: ${run.task}`,
      }))].filter((item) => !normalized || item.value.includes(normalized) || item.description.toLowerCase().includes(normalized));
      return items.length ? items : null;
    } catch { return null; }
  };

  const benchCompletions = async (prefix: string) => {
    try {
      const members = await collectPiTeamMembers(completionProject);
      const values = ["list", "on all", "off all", ...members
        .filter((member) => member.kind === "bundled" || member.kind === "personal")
        .flatMap((member) => [`list ${member.id}`, `on ${member.id}`, `off ${member.id}`])];
      const normalized = prefix.trim().toLowerCase();
      const items = values.filter((value) => !normalized || value.startsWith(normalized))
        .map((value) => ({ value, label: value }));
      return items.length ? items : null;
    } catch { return null; }
  };

  pi.registerTool({
    name: "harbor_contract",
    label: "Agent Harbor Contract",
    description: "Run exactly one invocation-scoped Agent Harbor child through the Pi SDK; returns child evidence only.",
    executionMode: "sequential",
    parameters: {
      type: "object",
      properties: { definition: { type: "string", description: "Complete /contract JSON object" } },
      required: ["definition"],
      additionalProperties: false,
    },
    execute: async (_id: string, params: { definition: string }, signal: AbortSignal | undefined, _update: unknown, ctx: ExtensionContext) => {
      const definition = parseContractDefinition(params.definition);
      const options = currentSessionOptions(resolveConfiguredPiModel(definition.model, ctx));
      const run = startDefinition(definition, ctx.cwd, options, "contractor", signal);
      const text = await trackUi(ctx, run);
      return {
        content: [{ type: "text", text }],
        details: { harness: "pi", runId: run.runId, usage: runtime.missionUsage(run.runId) },
      };
    },
  });

  pi.registerCommand("team", {
    description: `0 model tokens · ${commandSyntax.team} · Show roster, live work, model, thinking, native usage, and last mission.`,
    getArgumentCompletions: teamCompletions,
    handler: async (args, ctx) => {
      completionProject = ctx.cwd;
      try {
        const value = args.trim();
        if (value === "stop" || value.startsWith("stop ")) {
          const selector = value.slice("stop".length).trim();
          if (!selector) throw new Error("usage: /team stop <run-id|all>");
          const stopped = stopProjectRoots(ctx.cwd, selector);
          if (!stopped.length && selector === "all") {
            notify(ctx, stopResult("No Agent Harbor work is active in this project."), "info");
            return;
          }
          if (!stopped.length) throw new Error(`no active Harbor root matches ${selector}`);
          notify(ctx, stopResult(`Stopping ${stopped.length} root run(s): ${stopped.join(", ")}.`), "warning");
          return;
        }
        const result = value === "--help" || value === "help"
          ? wrapPlainText(`${commandHelp("team")}\nFilters match member ID, role, description, tool, skill, configured/observed model, thinking, state, safe task label, and run ID.\nTUI: Alt+H stops all active Harbor work. RPC: /team stop <run-id|all>.`)
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
            const definition = parseContractDefinition(args);
            run = startDefinition(definition, ctx.cwd, currentSessionOptions(resolveConfiguredPiModel(definition.model, ctx)), "contractor", ctx.signal);
            const text = await trackUi(ctx, run);
            notify(ctx, `${text}${formatPiMissionReport(runtime, run.runId)}`, "info");
          } catch (error) {
            if (run && runtime.get(run.runId)?.state === "cancelled") {
              notify(ctx, `Cancelled.${formatPiMissionReport(runtime, run.runId)}`, "warning");
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
          if (name === "retire" && !args.trim()) throw new Error("usage: /retire <personal-id>");
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
      try {
        run = startPlayer(
          scoutPlayer, args, ctx.cwd, ctx.model, pi.getThinkingLevel(), ctx.signal,
          (id) => { joinedPlayer = id; },
        );
        text = await trackUi(ctx, run);
      } catch (error) { failed = true; failure = error; }
      finally {
        if (joinedPlayer) {
          try { syncActivePlayers(ctx.cwd); }
          catch { discoveryWarning = metadataRefreshWarning; refresh = `\nWarning: ${metadataRefreshWarning}`; }
        }
      }
      const committed = joinedPlayer
        ? `\nRoster commit preserved: ${joinedPlayer} is joined and active in this project.${failed ? " The recruiter child ended after that commit." : ""}`
        : "";
      if (failed) {
        if (run && runtime.get(run.runId)?.state === "cancelled") {
          notify(ctx, wrapPlainText(`Cancelled.${committed}${formatPiMissionReport(runtime, run.runId)}${refresh}`), "warning");
        } else {
          failCommand(ctx, wrapPlainText(run
            ? `${humanError("scout", failure)}${committed}${formatPiMissionReport(runtime, run.runId)}${refresh}`
            : modelPreflightError("scout", failure)));
        }
        return;
      }
      notify(ctx, wrapPlainText(`${text ?? "Scout completed."}${committed}${run ? formatPiMissionReport(runtime, run.runId) : ""}${refresh}`), "info");
    },
  });
  registered.add("scout");
  pi.registerShortcut?.("alt+h", {
    description: "Stop active Agent Harbor work",
    handler: (ctx) => {
      const stopped = stopProjectRoots(ctx.cwd);
      notify(ctx, stopResult(stopped.length
        ? `Stopping ${stopped.length} Agent Harbor root run(s): ${stopped.join(", ")}.`
        : "No Agent Harbor work is active in this project."), stopped.length ? "warning" : "info");
    },
  });
  pi.on?.("session_shutdown", async () => {
    for (const controller of rootAbortControllers.values()) {
      if (!controller.signal.aborted) controller.abort(new DOMException("Pi session shutdown", "AbortError"));
    }
    await settlePiRootPromises([...rootPromises.values()]);
  });
  try { syncActivePlayers(process.cwd()); }
  catch { discoveryWarning = "Active alias discovery failed; fixed controls remain available. Inspect /team, then run /reload after repairing the roster."; }
}
