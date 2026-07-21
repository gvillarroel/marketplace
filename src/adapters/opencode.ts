/** OpenCode plugin entrypoint and translation to Agent Harbor's shared core. */
import { Buffer } from "node:buffer";
import { resolve } from "node:path";
import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import { discoverStartupActiveProfiles, listInvocablePlayers, listOwnedActiveIds, loadManagedActivePlayer, requireInvocablePlayer } from "../core/active.js";
import { executeCommand } from "../core/commands.js";
import {
  assertHarborCustomToolAccess,
  formatHarborTeamRosterSnapshot,
  harborCustomToolNames,
  harborCustomToolPolicy,
  harborStaticCustomToolSpecs,
  HarborInvocationLedger,
  HarborScoutTurnGuard,
  validateHarborCustomToolArguments,
  type HarborCustomToolPrincipal,
  type HarborCustomToolSpec,
} from "../core/custom-tools.js";
import { bundledPlayers, rolePlayers, scoutPlayer, trustedSkills } from "../core/defaults.js";
import { GhResolver } from "../core/github.js";
import { validatePlayer } from "../core/lifecycle.js";
import { composePlayerInstructions, normalizeDelegatedTaskPaths, openCodePermissionPolicy, openCodeToolPolicy, playerDefinitionDigest } from "../core/profiles.js";
import { publicErrorText, publicMetadataText } from "../core/public-metadata.js";
import { formatLoadedSkillGroup, loadConfiguredSkills } from "../core/skills.js";
import { filterTrustedSkills, formatScoutSkillMatches } from "../core/scout.js";
import { commandNames, type CommandName } from "../core/types.js";
import { OpenCodeOrchestrator, type OpenCodeModel } from "../orchestrators/opencode.js";
import {
  claimOpenCodeAgentActivity,
  readOpenCodeAgentActivities,
  type OpenCodeAgentActivityClaim,
} from "./opencode-agent-activity.js";
import { recordOpenCodeAgentConflicts } from "./opencode-agent-conflicts.js";
import { harborContext } from "./shared.js";

const maximumOpenCodeDirectTaskBytes = 30 * 1_024;
const maximumOpenCodeProjectReservations = 32;
const openCodeAncestryRpcDeadlineMs = 1_000;
const openCodeAncestryTotalDeadlineMs = 5_000;
const maximumOpenCodeHostIdentityBytes = 512;
const maximumOpenCodeModelIdentityBytes = 800;
const openCodeActivityRpcDeadlineMs = 750;
const openCodeActivityTotalDeadlineMs = 1_800;
const maximumOpenCodeAuthoritativeActivities = 32;
const maximumOpenCodeActivityConcurrency = 4;
const maximumOpenCodeActivityMessagesPerSession = 8;
const maximumOpenCodeActivityRetryMessageBytes = 1_024;

class OpenCodeAncestryError extends Error {}
class OpenCodeActivityError extends Error {}

interface OpenCodeActivityClient {
  readonly session: {
    status(options?: {
      readonly query?: { readonly directory?: string };
      readonly signal?: AbortSignal;
    }): Promise<unknown>;
    messages(options: {
      readonly path: { readonly id: string };
      readonly query?: { readonly directory?: string; readonly limit?: number };
      readonly signal?: AbortSignal;
    }): Promise<unknown>;
  };
}

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function openCodeRpcData(value: unknown): unknown {
  const result = plainRecord(value);
  if (!result || result.error !== undefined && result.error !== null || !Object.hasOwn(result, "data")) {
    throw new OpenCodeActivityError("OpenCode activity verification returned an error; team availability remains unknown");
  }
  return result.data;
}

async function boundedOpenCodeActivityRpc<T>(
  label: string,
  invoke: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  externalSignal?: AbortSignal,
): Promise<T> {
  externalSignal?.throwIfAborted();
  const controller = new AbortController();
  const signal = externalSignal
    ? AbortSignal.any([controller.signal, externalSignal])
    : controller.signal;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() => invoke(signal)),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new OpenCodeActivityError(`${label} timed out; team availability remains unknown`)), timeoutMs);
      }),
      new Promise<never>((_resolve, reject) => {
        if (!externalSignal) return;
        abortListener = () => reject(new DOMException("The operation was aborted", "AbortError"));
        externalSignal.addEventListener("abort", abortListener, { once: true });
        if (externalSignal.aborted) abortListener();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (abortListener) externalSignal?.removeEventListener("abort", abortListener);
    controller.abort();
  }
}

function validOpenCodeHostModelIdentity(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 200
    && Buffer.byteLength(value, "utf8") <= maximumOpenCodeModelIdentityBytes
    && value === value.trim() && !/[\p{Cc}\p{Cf}]/u.test(value);
}

async function publicOpenCodeToolCall<T>(
  name: string,
  signal: AbortSignal | undefined,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    let raw = "";
    try { raw = error instanceof Error ? error.message : String(error); }
    catch { raw = ""; }
    const publicMessage = publicErrorText(raw, 600) ?? "operation failed without a public diagnostic";
    const cancelled = signal?.aborted === true || error instanceof Error && error.name === "AbortError";
    const bounded = new Error(`${name} ${cancelled ? "was cancelled" : "failed"}: ${publicMessage}`);
    bounded.name = cancelled ? "AbortError" : "AgentHarborToolError";
    // Deliberately omit `cause`: SDK/Gh/loader errors may carry paths,
    // credentials, request payloads, or provider details outside `message`.
    throw bounded;
  }
}

function normalizedOpenCodeProject(project: string): string {
  const root = resolve(project);
  return process.platform === "win32" ? root.toLowerCase() : root;
}

function assertOpenCodeHostIdentity(value: unknown, label: "session" | "message", caller: string): asserts value is string {
  if (typeof value !== "string" || !value || value.length > maximumOpenCodeHostIdentityBytes
    || Buffer.byteLength(value, "utf8") > maximumOpenCodeHostIdentityBytes || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new OpenCodeAncestryError(`${caller} received an invalid OpenCode ${label} ID`);
  }
}

async function boundedOpenCodeAncestryRpc<T>(
  caller: string,
  invoke: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  externalSignal?: AbortSignal,
): Promise<T> {
  const cancelled = () => new OpenCodeAncestryError(`${caller} was cancelled while reading message ancestry`);
  if (externalSignal?.aborted) throw cancelled();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;
  const operation = Promise.resolve().then(() => invoke(controller.signal));
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new OpenCodeAncestryError(`${caller} message ancestry lookup timed out`));
      controller.abort();
    }, Math.max(1, timeoutMs));
  });
  const aborted = new Promise<never>((_resolve, reject) => {
    if (!externalSignal) return;
    let handled = false;
    abortListener = () => {
      if (handled) return;
      handled = true;
      reject(cancelled());
      controller.abort();
    };
    externalSignal.addEventListener("abort", abortListener, { once: true });
    // AbortSignal does not replay an event to listeners attached after the
    // transition, so close the check/register race explicitly.
    if (externalSignal.aborted) abortListener();
  });
  try {
    return await Promise.race([operation, timeout, aborted]);
  } catch (error) {
    if (error instanceof OpenCodeAncestryError) throw error;
    throw new OpenCodeAncestryError(`${caller} could not read message ancestry`);
  } finally {
    if (timer) clearTimeout(timer);
    if (abortListener) externalSignal?.removeEventListener("abort", abortListener);
    controller.abort();
  }
}

function openCodeToolArgs(spec: HarborCustomToolSpec): Record<string, ReturnType<typeof tool.schema.string>> {
  const parameters = spec.parameters as {
    readonly properties?: Readonly<Record<string, {
      readonly minLength?: number;
      readonly maxLength?: number;
      readonly pattern?: string;
    }>>;
  };
  return Object.fromEntries(Object.entries(parameters.properties ?? {}).map(([name, property]) => {
    let schema = tool.schema.string();
    if (property.minLength !== undefined) schema = schema.min(property.minLength);
    if (property.maxLength !== undefined) schema = schema.max(property.maxLength);
    if (property.pattern !== undefined) schema = schema.regex(new RegExp(property.pattern, "u"));
    return [name, schema];
  }));
}

function validatedOpenCodeCall(name: string, args: unknown, principal: HarborCustomToolPrincipal) {
  assertHarborCustomToolAccess(name, principal);
  return validateHarborCustomToolArguments(name, args);
}

function configuredOpenCodeModel(value: string | undefined, inherited: OpenCodeModel): OpenCodeModel {
  if (value === undefined) return inherited;
  if (typeof value !== "string" || value.length > 401 || Buffer.byteLength(value, "utf8") > 1_601) {
    throw new Error("configured OpenCode model must use bounded provider/model syntax");
  }
  const separator = value.indexOf("/");
  const providerID = separator < 0 ? "" : value.slice(0, separator);
  const modelID = separator < 0 ? "" : value.slice(separator + 1);
  if (!validOpenCodeHostModelIdentity(providerID) || !validOpenCodeHostModelIdentity(modelID)) {
    throw new Error("configured OpenCode model must use bounded provider/model syntax");
  }
  return { providerID, modelID };
}

function openCodeReservationKey(project: string, agent: string): string {
  return `${normalizedOpenCodeProject(project)}\u0000${agent}`;
}

function isAgentHarborOwnedConfigAgent(id: string, value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const options = record.options && typeof record.options === "object" && !Array.isArray(record.options)
    ? record.options as Record<string, unknown>
    : undefined;
  return [record.metadata, options?.metadata].some((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
    const metadata = candidate as Record<string, unknown>;
    return metadata.owner === "agent-foundry" && metadata.player === id &&
      [4, 5, "4", "5"].includes(metadata.revision as string | number);
  });
}

function openCodeStartupWarning(
  diagnostics: readonly { readonly code: string; readonly message: string; readonly repair: string }[],
): string {
  return [
    "Agent Harbor omitted unsafe or incomplete project profiles during bounded startup discovery.",
    ...diagnostics.flatMap((diagnostic) => [
      `[${diagnostic.code}] ${diagnostic.message}`,
      `Repair: ${diagnostic.repair}`,
    ]),
  ].join("\n").slice(0, 4_000);
}

function openCodeDirectCommand(id: string) {
  return {
    description: `Run Agent Harbor player ${id} in the current session`,
    template: "$ARGUMENTS",
    agent: id,
    subtask: false,
  } as const;
}

function openCodeScoutCommand() {
  return {
    description: "Reuse sufficient enabled capacity or recruit at most one trusted player",
    template: "$ARGUMENTS",
    agent: scoutPlayer.name,
    subtask: false,
  } as const;
}

function openCodeLifecycleCommand(name: CommandName) {
  return {
    description: `Agent Harbor ${name} model-routed fallback; prefer the direct TUI or agent-harbor CLI control`,
    template: `Call the harbor tool exactly once with command ${JSON.stringify(name)} and args $ARGUMENTS. Return its result verbatim.`,
  } as const;
}

function isAgentHarborDirectCommand(id: string, value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 4 &&
    record.description === `Run Agent Harbor player ${id} in the current session` &&
    record.template === "$ARGUMENTS" && record.agent === id && record.subtask === false;
}

function isAgentHarborScoutCommand(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 4 &&
    record.description === "Reuse sufficient enabled capacity or recruit at most one trusted player" &&
    record.template === "$ARGUMENTS" && record.agent === scoutPlayer.name && record.subtask === false;
}

function isAgentHarborLifecycleCommand(name: CommandName, value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const expected = openCodeLifecycleCommand(name);
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 2 &&
    record.description === expected.description && record.template === expected.template;
}

function openCodeConfigCollisionWarning(
  agentIds: readonly string[],
  commandAliases: readonly string[],
): string {
  return [
    "Agent Harbor preserved foreign OpenCode configuration entries instead of overwriting them.",
    ...(agentIds.length
      ? [`Unavailable Harbor agents: ${agentIds.join(", ")}. Repair: rename or remove the foreign agent entries, then reload OpenCode.`]
      : []),
    ...(commandAliases.length
      ? [`Unavailable Harbor slash aliases: ${commandAliases.join(", ")}. Repair: use the Agent Harbor TUI/CLI control or rename the foreign commands, then reload OpenCode.`]
      : []),
  ].join("\n").slice(0, 4_000);
}

function conciseOpenCodeScoutJoin(definition: string): string {
  const player = validatePlayer(JSON.parse(definition));
  const publicRole = publicMetadataText(player.description, 240) ?? "Personal Agent Harbor teammate";
  const capacity = publicMetadataText([
    ...player.tools,
    ...(player.skills ?? []).map(({ name }) => `skill:${name}`),
  ].join(", "), 500) ?? "advisory";
  const model = player.model ? publicMetadataText(player.model, 200) : undefined;
  return [
    `✓ ${player.name} joined · personal · enabled in this project`,
    `Role: ${publicRole}`,
    `Capacity: ${capacity}`,
    `Model: ${model ? `configured ${model}` : "inherits the OpenCode host when run"}`,
    "Reload OpenCode configuration to expose the /<id> convenience alias; ownership-validated invocation remains fail-closed.",
  ].join("\n");
}

/**
 * Creates the OpenCode plugin configuration, command tools, named players, and
 * bounded team-lead delegation for the current project directory.
 */
export const AgentHarborPlugin: Plugin = async ({ client, directory }) => {
  const activityCandidate = client as unknown as Partial<OpenCodeActivityClient>;
  const activityClient: OpenCodeActivityClient | undefined =
    typeof activityCandidate.session?.status === "function" && typeof activityCandidate.session.messages === "function"
      ? activityCandidate as OpenCodeActivityClient
      : undefined;
  const teamLead = rolePlayers.get("team-lead")!;
  const crafter = rolePlayers.get("crafter")!;
  interface DelegateTurnState {
    terminal: boolean;
    calls: number;
    rosterCalls: number;
    inFlight: boolean;
    agents: Set<string>;
  }
  const delegateLedger = new HarborInvocationLedger<DelegateTurnState>({
    create: () => ({ terminal: false, calls: 0, rosterCalls: 0, inFlight: false, agents: new Set() }),
    terminal: (state) => state.terminal,
    terminate: (state) => { state.terminal = true; },
  });
  const scoutLedger = new HarborInvocationLedger<HarborScoutTurnGuard>({
    create: () => new HarborScoutTurnGuard(),
    terminal: (guard) => guard.terminal,
    terminate: (guard, reason) => guard.terminate(reason),
  });
  interface RememberedModelState { terminal: boolean; model?: OpenCodeModel }
  const turnModelLedger = new HarborInvocationLedger<RememberedModelState>({
    create: () => ({ terminal: false }),
    terminal: (state) => state.terminal,
    terminate: (state) => { state.terminal = true; },
  });
  interface AgentReservation {
    readonly kind: "direct" | "delegated";
    readonly project: string;
    readonly sessionID: string;
    readonly owner: string;
    readonly activity: OpenCodeAgentActivityClaim;
  }
  const agentReservations = new Map<string, AgentReservation>();
  const directAgentCommands = new Map<string, { readonly id: string; readonly definitionDigest?: string }>();
  let configAgentConflicts = new Set<string>();
  const assertNoConfigAgentConflict = (id: string): void => {
    if (configAgentConflicts.has(id)) {
      throw new Error(`Agent Harbor player ${id} conflicts with a foreign OpenCode agent; rename or remove that agent entry, then reload OpenCode`);
    }
  };
  const authoritativeBusyAgents = async (
    project: string,
    callerSessionID: string | undefined,
    signal?: AbortSignal,
  ): Promise<ReadonlySet<string>> => {
    if (!activityClient) {
      throw new OpenCodeActivityError("OpenCode activity verification is unavailable; no team availability was announced or reserved");
    }
    if (callerSessionID !== undefined && (typeof callerSessionID !== "string" || !callerSessionID ||
        callerSessionID.length > maximumOpenCodeHostIdentityBytes ||
        Buffer.byteLength(callerSessionID, "utf8") > maximumOpenCodeHostIdentityBytes ||
        /[\u0000-\u001f\u007f]/u.test(callerSessionID))) {
      throw new OpenCodeActivityError("OpenCode activity verification received an invalid caller session ID; team availability remains unknown");
    }
    const deadlineAt = Date.now() + openCodeActivityTotalDeadlineMs;
    try {
      const remaining = Math.min(openCodeActivityRpcDeadlineMs, deadlineAt - Date.now());
      if (remaining <= 0) {
        throw new OpenCodeActivityError("OpenCode activity verification exceeded its total deadline; team availability remains unknown");
      }
      const statusResponse = await boundedOpenCodeActivityRpc(
        "OpenCode active-session inventory",
        (rpcSignal) => activityClient.session.status({ query: { directory: project }, signal: rpcSignal }),
        remaining,
        signal,
      );
      const statuses = plainRecord(openCodeRpcData(statusResponse));
      if (!statuses) throw new OpenCodeActivityError("OpenCode active-session inventory was incompatible; team availability remains unknown");
      const entries = Object.entries(statuses);
      if (entries.length > maximumOpenCodeAuthoritativeActivities) {
        throw new OpenCodeActivityError(`OpenCode reports more than ${maximumOpenCodeAuthoritativeActivities} active sessions; team availability remains unknown`);
      }
      const ids: string[] = [];
      for (const [id, value] of entries) {
        const status = plainRecord(value);
        if (!id || id.length > maximumOpenCodeHostIdentityBytes ||
            Buffer.byteLength(id, "utf8") > maximumOpenCodeHostIdentityBytes ||
            /[\u0000-\u001f\u007f]/u.test(id) || !status) {
          throw new OpenCodeActivityError("OpenCode active-session inventory contained an invalid session; team availability remains unknown");
        }
        if (status.type === "idle") continue;
        if (status.type === "retry") {
          if (!Number.isSafeInteger(status.attempt) || (status.attempt as number) < 0 ||
              typeof status.next !== "number" || !Number.isFinite(status.next) || (status.next as number) < 0 ||
              typeof status.message !== "string" ||
              status.message.length > maximumOpenCodeActivityRetryMessageBytes ||
              Buffer.byteLength(status.message, "utf8") > maximumOpenCodeActivityRetryMessageBytes) {
            throw new OpenCodeActivityError("OpenCode active-session retry telemetry was incompatible; team availability remains unknown");
          }
        } else if (status.type !== "busy") {
          throw new OpenCodeActivityError("OpenCode active-session inventory contained unknown telemetry; team availability remains unknown");
        }
        if (id !== callerSessionID) ids.push(id);
      }
      const busy = new Set<string>();
      let cursor = 0;
      await Promise.all(Array.from({ length: Math.min(maximumOpenCodeActivityConcurrency, ids.length) }, async () => {
        while (cursor < ids.length) {
          const id = ids[cursor++];
          const remaining = Math.min(openCodeActivityRpcDeadlineMs, deadlineAt - Date.now());
          if (remaining <= 0) throw new OpenCodeActivityError("OpenCode activity verification exceeded its total deadline; team availability remains unknown");
          const messagesResponse = await boundedOpenCodeActivityRpc(
            "OpenCode active-session messages",
            (rpcSignal) => activityClient.session.messages({
              path: { id },
              query: { directory: project, limit: maximumOpenCodeActivityMessagesPerSession },
              signal: rpcSignal,
            }),
            remaining,
            signal,
          );
          const messages = openCodeRpcData(messagesResponse);
          if (!Array.isArray(messages) || messages.length === 0 ||
              messages.length > maximumOpenCodeActivityMessagesPerSession) {
            throw new OpenCodeActivityError("OpenCode active-session messages were incompatible; team availability remains unknown");
          }
          let latestUser: { readonly agent: string; readonly created: number } | undefined;
          for (const message of messages) {
            const info = plainRecord(plainRecord(message)?.info);
            if (!info || typeof info.id !== "string" || !info.id ||
                info.id.length > maximumOpenCodeHostIdentityBytes ||
                Buffer.byteLength(info.id, "utf8") > maximumOpenCodeHostIdentityBytes ||
                /[\u0000-\u001f\u007f]/u.test(info.id) || info.sessionID !== id ||
                !["user", "assistant"].includes(info.role as string)) {
              throw new OpenCodeActivityError("OpenCode active-session message identity was incompatible; team availability remains unknown");
            }
            if (info.role !== "user") continue;
            const time = plainRecord(info.time);
            const created = time?.created;
            const agent = info.agent;
            if (!Number.isSafeInteger(created) || (created as number) < 0 ||
                !validOpenCodeHostModelIdentity(agent)) {
              throw new OpenCodeActivityError("OpenCode active-session agent identity was incompatible; team availability remains unknown");
            }
            if (!latestUser || (created as number) > latestUser.created) {
              latestUser = { agent, created: created as number };
            } else if (created === latestUser.created && agent !== latestUser.agent) {
              throw new OpenCodeActivityError("OpenCode active-session agent identity was ambiguous; team availability remains unknown");
            }
          }
          if (!latestUser) {
            throw new OpenCodeActivityError("OpenCode active-session agent identity was unavailable; team availability remains unknown");
          }
          busy.add(latestUser.agent);
        }
      }));
      return busy;
    } catch (error) {
      if (signal?.aborted) throw error;
      if (error instanceof OpenCodeActivityError) throw error;
      throw new OpenCodeActivityError("OpenCode activity verification failed; team availability remains unknown");
    }
  };
  const reserveAgent = (
    project: string,
    agent: string,
    reservation: Omit<AgentReservation, "project" | "activity">,
    busyMessage: string,
  ): { readonly key: string; readonly record: AgentReservation } => {
    const key = openCodeReservationKey(project, agent);
    if (agentReservations.has(key)) throw new Error(busyMessage);
    const projectKey = normalizedOpenCodeProject(project);
    let active = 0;
    for (const candidate of agentReservations.values()) {
      if (candidate.project === projectKey) active += 1;
    }
    if (active >= maximumOpenCodeProjectReservations) {
      throw new Error(`Agent Harbor allows at most ${maximumOpenCodeProjectReservations} active runs per project; wait for work to finish or use /team stop`);
    }
    let activity: OpenCodeAgentActivityClaim;
    try { activity = claimOpenCodeAgentActivity(projectKey, agent, reservation.kind); }
    catch (error) {
      if (error instanceof Error && /busy in another direct or delegated run/u.test(error.message)) {
        throw new Error(busyMessage);
      }
      throw error;
    }
    const record = { ...reservation, project: projectKey, activity };
    agentReservations.set(key, record);
    return { key, record };
  };
  const releaseDirectReservations = (sessionID: string): void => {
    for (const [key, reservation] of agentReservations) {
      if (reservation.kind === "direct" && reservation.sessionID === sessionID) {
        reservation.activity.release();
        agentReservations.delete(key);
      }
    }
  };
  const originatingUserTurn = async (
    sessionID: string,
    messageID: string,
    currentDirectory: string,
    caller: string,
    signal?: AbortSignal,
  ) => {
    assertOpenCodeHostIdentity(sessionID, "session", caller);
    assertOpenCodeHostIdentity(messageID, "message", caller);
    const seen = new Set<string>();
    let cursor = messageID;
    const deadlineAt = Date.now() + openCodeAncestryTotalDeadlineMs;
    for (let depth = 0; depth < 64; depth += 1) {
      if (seen.has(cursor)) throw new Error(`${caller} found a cyclic message ancestry`);
      seen.add(cursor);
      const remaining = deadlineAt - Date.now();
      if (remaining <= 0) throw new OpenCodeAncestryError(`${caller} message ancestry lookup exceeded its total deadline`);
      const message = await boundedOpenCodeAncestryRpc(
        caller,
        (rpcSignal) => client.session.message({
          path: { id: sessionID, messageID: cursor },
          query: { directory: currentDirectory },
          signal: rpcSignal,
          throwOnError: true,
        }),
        Math.min(openCodeAncestryRpcDeadlineMs, remaining),
        signal,
      );
      if (message.data.info.role === "user") {
        assertOpenCodeHostIdentity(message.data.info.id, "message", caller);
        return message.data.info;
      }
      if (message.data.info.role !== "assistant" || !message.data.info.parentID) break;
      cursor = message.data.info.parentID;
      assertOpenCodeHostIdentity(cursor, "message", caller);
    }
    throw new Error(`${caller} could not identify the originating user turn`);
  };
  const originatingUserMessage = async (
    sessionID: string,
    messageID: string,
    currentDirectory: string,
    signal?: AbortSignal,
  ): Promise<{ readonly id: string; readonly model: OpenCodeModel }> => {
    // SDK-created assistant messages do not reliably repeat the root model.
    const info = await originatingUserTurn(
      sessionID,
      messageID,
      currentDirectory,
      harborCustomToolNames.delegate,
      signal,
    );
    const { model } = info;
    if (!validOpenCodeHostModelIdentity(model?.providerID) ||
        !validOpenCodeHostModelIdentity(model?.modelID)) {
      throw new Error("harbor_delegate originating user turn has no explicit model with a valid bounded identity");
    }
    const remembered = turnModelLedger.acquire([sessionID], [sessionID, info.id]).value.model;
    const typedInfo = info as typeof info & { readonly variant?: string };
    const typedModel = model as typeof model & { readonly variant?: string };
    const variant = remembered?.variant ?? typedInfo.variant ?? typedModel.variant;
    if (variant !== undefined && !validOpenCodeHostModelIdentity(variant)) {
      throw new Error("harbor_delegate originating user turn has an invalid model variant");
    }
    return {
      id: info.id,
      model: {
        providerID: model.providerID,
        modelID: model.modelID,
        ...(variant === undefined ? {} : { variant }),
      },
    };
  };
  const turnIdentity = async (
    execution: { readonly sessionID: string; readonly messageID: string; readonly abort?: AbortSignal },
    currentDirectory: string,
    caller: string,
  ) => {
    const turn = await originatingUserTurn(
      execution.sessionID,
      execution.messageID,
      currentDirectory,
      caller,
      execution.abort,
    );
    return { turn, scope: [execution.sessionID], invocation: [execution.sessionID, turn.id] } as const;
  };
  const acquireDelegateTurn = async (
    execution: { readonly sessionID: string; readonly messageID: string; readonly abort?: AbortSignal },
    currentDirectory: string,
    caller: string,
  ) => {
    const identity = await turnIdentity(execution, currentDirectory, caller);
    const entry = delegateLedger.acquire(identity.scope, identity.invocation);
    if (entry.value.terminal) throw new Error("Agent Harbor team-lead turn is terminal or replayed");
    return { ...identity, id: entry.id, state: entry.value };
  };
  const rosterSnapshot = (
    currentDirectory: string,
    query: string,
    authoritativeBusy: ReadonlySet<string>,
  ) => {
    const processBusy = new Set(readOpenCodeAgentActivities(currentDirectory).map(({ agent }) => agent));
    return formatHarborTeamRosterSnapshot(
    listInvocablePlayers("opencode", currentDirectory)
      .filter(({ id }) => id !== "team-lead")
      .map(({ definition }) => ({
        id: definition.name,
        role: definition.description,
        tools: definition.tools,
        skills: (definition.skills ?? []).map(({ name }) => name),
        ...(definition.model ? { configuredModel: definition.model } : {}),
        availability: configAgentConflicts.has(definition.name) || authoritativeBusy.has(definition.name) ||
          processBusy.has(definition.name)
          ? "busy" as const
          : "ready" as const,
      })),
    query,
    );
  };
  const runScoutCall = async <T>(
    name: typeof harborCustomToolNames.teamRoster | typeof harborCustomToolNames.filterSkills |
      typeof harborCustomToolNames.joinPlayer,
    execution: { readonly sessionID: string; readonly messageID: string; readonly abort?: AbortSignal },
    currentDirectory: string,
    action: () => Promise<{ readonly result: T; readonly rosterComplete?: boolean }>,
  ): Promise<T> => {
    const signal = execution.abort;
    const identity = await turnIdentity(execution, currentDirectory, name);
    const { value: guard } = scoutLedger.acquire(identity.scope, identity.invocation);
    const ticket = guard.begin(name, signal);
    try {
      const outcome = await action();
      guard.succeed(ticket, { rosterComplete: outcome.rosterComplete });
      return outcome.result;
    } catch (error) {
      guard.fail(ticket, signal);
      throw error;
    }
  };
  return {
    "chat.message": async (input, output) => {
      const messageID = input.messageID ?? output.message.id;
      const model = input.model ?? output.message.model;
      const typedMessage = output.message as typeof output.message & {
        readonly variant?: string;
        readonly model: typeof output.message.model & { readonly variant?: string };
      };
      const variant = input.variant ?? typedMessage.variant ?? typedMessage.model.variant;
      if (typeof input.sessionID !== "string" || !input.sessionID ||
          input.sessionID.length > maximumOpenCodeHostIdentityBytes ||
          Buffer.byteLength(input.sessionID, "utf8") > maximumOpenCodeHostIdentityBytes ||
          typeof messageID !== "string" || !messageID || messageID.length > maximumOpenCodeHostIdentityBytes ||
          Buffer.byteLength(messageID, "utf8") > maximumOpenCodeHostIdentityBytes ||
          !validOpenCodeHostModelIdentity(model?.providerID) ||
          !validOpenCodeHostModelIdentity(model?.modelID) ||
          variant !== undefined && !validOpenCodeHostModelIdentity(variant)) return;
      for (const reservation of agentReservations.values()) {
        if (reservation.kind === "direct" && reservation.sessionID === input.sessionID) {
          reservation.activity.setPhase("working");
        }
      }
      turnModelLedger.acquire([input.sessionID], [input.sessionID, messageID]).value.model = {
        providerID: model.providerID,
        modelID: model.modelID,
        ...(variant === undefined ? {} : { variant }),
      };
    },
    "chat.params": async (input, output) => {
      if (input.model.providerID === "openai" &&
          (input.model.id === "gpt-5.3-codex-spark" || input.model.id === "gpt-5.6-luna")) {
        // The Codex OAuth Responses endpoint rejects metadata injected for SDK-created sessions.
        delete output.options.metadata;
      }
    },
    event: async ({ event }) => {
      const sessionID = event.type === "session.idle"
        ? event.properties.sessionID
        : event.type === "session.status" && event.properties.status.type === "idle"
          ? event.properties.sessionID
          : event.type === "session.deleted"
            ? event.properties.info.id
            : event.type === "session.error"
              ? event.properties.sessionID
              : undefined;
      if (!sessionID) return;
      releaseDirectReservations(sessionID);
      try {
        scoutLedger.terminateScope([sessionID], `OpenCode ${event.type}`);
        delegateLedger.terminateScope([sessionID], `OpenCode ${event.type}`);
        turnModelLedger.terminateScope([sessionID], `OpenCode ${event.type}`);
      } catch { /* Oversized/invalid host IDs fail closed at the call boundary. */ }
    },
    dispose: async () => {
      scoutLedger.terminateAll("OpenCode plugin disposed");
      delegateLedger.terminateAll("OpenCode plugin disposed");
      turnModelLedger.terminateAll("OpenCode plugin disposed");
      for (const reservation of agentReservations.values()) reservation.activity.release();
      agentReservations.clear();
    },
    config: async (config) => {
      config.command ??= {};
      // Remove only exact prior Harbor aliases. This also cleans stale aliases
      // when a fresh plugin instance receives a reused host config object.
      for (const [alias, candidate] of Object.entries(config.command)) {
        const agent = candidate && typeof candidate === "object" && !Array.isArray(candidate)
          ? (candidate as Record<string, unknown>).agent
          : undefined;
        if (alias === "scout" && isAgentHarborScoutCommand(candidate) ||
            typeof agent === "string" && isAgentHarborDirectCommand(agent, candidate)) {
          delete config.command[alias];
        }
      }
      // While configuration is being reconciled, every direct alias fails
      // closed instead of using a stale ownership decision.
      directAgentCommands.clear();
      const commandCollisions = new Set<string>();
      for (const name of commandNames) {
        const existing = config.command[name];
        // Lifecycle names are preferred Harbor aliases, not destructive host
        // namespaces. Deterministic TUI/CLI controls remain available if a
        // user-owned slash command already has the exact name.
        if (existing === undefined || isAgentHarborLifecycleCommand(name, existing)) {
          config.command[name] = openCodeLifecycleCommand(name);
        } else {
          commandCollisions.add(name);
        }
      }
      const startupProfiles = discoverStartupActiveProfiles("opencode", directory);
      if (startupProfiles.diagnostics.length && typeof client.app?.log === "function") {
        try {
          await client.app.log({
            body: {
              service: "agent-harbor",
              level: "warn",
              message: openCodeStartupWarning(startupProfiles.diagnostics),
            },
            query: { directory },
          });
        } catch { /* Host logging failure must not disable fixed controls. */ }
      }
      config.agent ??= {};
      // These three built-in IDs are the fixed Agent Harbor namespace. Unlike
      // personal/bundled profiles, they are required control-plane principals.
      config.agent["team-lead"] = {
        description: teamLead.description, mode: "subagent",
        steps: 7,
        prompt: `${composePlayerInstructions(teamLead)} In OpenCode, ${harborCustomToolNames.teamRoster} returns the complete enabled roster without a child; use it when exact eligible IDs or current availability are not already known. ${harborCustomToolNames.delegate} runs one exact specialist. Never delegate to a busy target.`,
        tools: openCodeToolPolicy([], [harborCustomToolNames.delegate, harborCustomToolNames.teamRoster]),
        permission: openCodePermissionPolicy([], [harborCustomToolNames.delegate, harborCustomToolNames.teamRoster], directory),
      };
      config.agent.crafter = {
        description: crafter.description, mode: "subagent",
        steps: 4,
        prompt: composePlayerInstructions(crafter, "opencode"),
        tools: { ...openCodeToolPolicy(crafter.tools, ["agent_harbor_skills"]), harbor_delegate: false },
        permission: openCodePermissionPolicy(crafter.tools, ["agent_harbor_skills"], directory),
      };
      config.agent[scoutPlayer.name] = {
        description: scoutPlayer.description, mode: "subagent",
        steps: 6,
        prompt: `${composePlayerInstructions(scoutPlayer)} In OpenCode, call ${harborCustomToolNames.teamRoster} exactly once before deciding whether recruitment is necessary. Stop with the existing member when it is sufficient; otherwise call ${harborCustomToolNames.filterSkills} with a query string, then call ${harborCustomToolNames.joinPlayer} exactly once with the complete player definition serialized as JSON.`,
        tools: openCodeToolPolicy([], [
          harborCustomToolNames.teamRoster,
          harborCustomToolNames.filterSkills,
          harborCustomToolNames.joinPlayer,
        ]),
        permission: openCodePermissionPolicy([], [
          harborCustomToolNames.teamRoster,
          harborCustomToolNames.filterSkills,
          harborCustomToolNames.joinPlayer,
        ], directory),
      };
      for (const [id, player] of rolePlayers) {
        if (Object.hasOwn(config.agent, id)) continue;
        const additional = player.skills?.length ? ["agent_harbor_skills"] : [];
        config.agent[id] = {
          description: player.description,
          mode: "subagent",
          steps: 4,
          ...(player.model ? { model: player.model } : {}),
          prompt: composePlayerInstructions(player, "opencode"),
          tools: openCodeToolPolicy(player.tools, additional),
          permission: openCodePermissionPolicy(player.tools, additional, directory),
        };
      }
      const managedIds = new Set(startupProfiles.ids);
      const managedDefinitions = new Map<string, ReturnType<typeof loadManagedActivePlayer>>();
      const fixedIds = new Set([...rolePlayers.keys(), scoutPlayer.name]);
      const nextAgentConflicts = new Set<string>();
      for (const [id, candidate] of Object.entries(config.agent)) {
        if (!fixedIds.has(id) && !managedIds.has(id) && isAgentHarborOwnedConfigAgent(id, candidate)) {
          delete config.agent[id];
        }
      }
      // Owned-but-stale profiles must be removed from host discovery. Leaving
      // an old host entry could silently retain broader tools than revision 5.
      if (startupProfiles.complete) {
        for (const id of listOwnedActiveIds("opencode", directory)) {
          // The active file's ownership marker is authoritative even when its
          // payload is stale/corrupt and the host-projected object lost marker
          // metadata. This is owned residue, not a foreign config collision.
          if (!managedIds.has(id)) delete config.agent[id];
        }
      }
      for (const id of managedIds) {
        let player;
        try { player = loadManagedActivePlayer("opencode", directory, id); }
        catch {
          if (isAgentHarborOwnedConfigAgent(id, config.agent[id])) delete config.agent[id];
          else if (config.agent[id] !== undefined) nextAgentConflicts.add(id);
          continue;
        }
        managedDefinitions.set(id, player);
        const existing = config.agent[id];
        if (existing !== undefined && !isAgentHarborOwnedConfigAgent(id, existing)) {
          nextAgentConflicts.add(id);
          continue;
        }
        const additional = player.skills?.length ? ["agent_harbor_skills"] : [];
        config.agent[id] = {
          description: player.description,
          mode: "subagent",
          steps: 4,
          metadata: {
            owner: "agent-foundry",
            roster: bundledPlayers.has(id) ? "sdlc" : "personal",
            player: id,
            revision: "5",
            definitionDigest: playerDefinitionDigest(player),
          },
          ...(player.model ? { model: player.model } : {}),
          prompt: composePlayerInstructions(player, "opencode"),
          tools: openCodeToolPolicy(player.tools, additional),
          permission: openCodePermissionPolicy(player.tools, additional, directory),
        };
      }
      const sortedAgentConflicts = [...nextAgentConflicts].sort();
      configAgentConflicts = new Set(sortedAgentConflicts);
      recordOpenCodeAgentConflicts(directory, sortedAgentConflicts);

      const nextDirectAgentCommands = new Map<string, { readonly id: string; readonly definitionDigest?: string }>();
      const registerDirectAlias = (
        alias: string,
        id: string,
        definition: unknown,
        player: ReturnType<typeof loadManagedActivePlayer> | undefined,
      ): void => {
        if (configAgentConflicts.has(id)) return;
        if (config.command![alias] !== undefined) {
          commandCollisions.add(alias);
          return;
        }
        config.command![alias] = definition as typeof config.command[string];
        nextDirectAgentCommands.set(alias, {
          id,
          ...(player ? { definitionDigest: playerDefinitionDigest(player) } : {}),
        });
      };
      for (const id of new Set([...rolePlayers.keys(), ...startupProfiles.ids])) {
        registerDirectAlias(id, id, openCodeDirectCommand(id), rolePlayers.get(id) ?? managedDefinitions.get(id));
      }
      registerDirectAlias("scout", scoutPlayer.name, openCodeScoutCommand(), undefined);
      for (const [alias, direct] of nextDirectAgentCommands) directAgentCommands.set(alias, direct);

      const sortedCommandCollisions = [...commandCollisions].sort();
      if ((sortedAgentConflicts.length || sortedCommandCollisions.length) && typeof client.app?.log === "function") {
        try {
          await client.app.log({
            body: {
              service: "agent-harbor",
              level: "warn",
              message: openCodeConfigCollisionWarning(sortedAgentConflicts, sortedCommandCollisions),
            },
            query: { directory },
          });
        } catch { /* Host logging failure must not weaken collision handling. */ }
      }
    },
    "command.execute.before": async ({ command, sessionID, arguments: args }) => {
      const direct = directAgentCommands.get(command);
      if (!direct) return;
      const { id } = direct;
      if (typeof args !== "string") throw new Error(`/${command} requires a string task`);
      if (args.length > maximumOpenCodeDirectTaskBytes ||
          Buffer.byteLength(args, "utf8") > maximumOpenCodeDirectTaskBytes) {
        throw new Error(`/${command} task exceeds the ${maximumOpenCodeDirectTaskBytes / 1_024} KiB direct-run limit`);
      }
      if (!args.trim()) throw new Error(`/${command} requires a non-empty task`);
      if (typeof sessionID !== "string" || !sessionID || sessionID.length > maximumOpenCodeHostIdentityBytes ||
          Buffer.byteLength(sessionID, "utf8") > maximumOpenCodeHostIdentityBytes ||
          /[\u0000-\u001f\u007f]/u.test(sessionID)) {
        throw new Error(`/${command} received an invalid OpenCode session ID`);
      }
      assertNoConfigAgentConflict(id);
      if (id !== scoutPlayer.name) {
        const current = requireInvocablePlayer("opencode", directory, id);
        if (!direct.definitionDigest || playerDefinitionDigest(current.definition) !== direct.definitionDigest) {
          throw new Error(`/${command} requires an OpenCode reload because its loaded Agent Harbor definition changed`);
        }
      }
      const authoritativeBusy = await authoritativeBusyAgents(directory, sessionID);
      if (authoritativeBusy.has(id)) {
        throw new Error(`Agent Harbor player ${id} is busy in an active OpenCode session`);
      }
      reserveAgent(
        directory,
        id,
        { kind: "direct", sessionID, owner: `direct:${sessionID}` },
        `Agent Harbor player ${id} is busy in another direct or delegated run`,
      );
    },
    tool: {
      harbor: tool({
        description: "Execute one deterministic Agent Harbor lifecycle or orchestration command.",
        args: { command: tool.schema.enum(commandNames), args: tool.schema.string() },
        execute: async ({ command, args }, execution) => {
          const currentDirectory = execution.directory || directory;
          const context = await harborContext("opencode", currentDirectory, new OpenCodeOrchestrator(client, currentDirectory));
          return executeCommand(command as CommandName, args, context, execution.abort);
        },
      }),
      [harborCustomToolNames.teamRoster]: tool({
        description: `${harborStaticCustomToolSpecs[harborCustomToolNames.teamRoster].description} Returns every enabled specialist or a fail-closed over-capacity diagnostic; a query ranks matches but never hides other members.`,
        args: openCodeToolArgs(harborStaticCustomToolSpecs[harborCustomToolNames.teamRoster]),
        execute: (args, execution) => publicOpenCodeToolCall(
          harborCustomToolNames.teamRoster,
          execution.abort,
          async () => {
          const call = validatedOpenCodeCall(
            harborCustomToolNames.teamRoster,
            args,
            { agent: execution.agent },
          );
          if (call.kind !== "team-roster") throw new Error("invalid Agent Harbor team-roster dispatch");
          const currentDirectory = execution.directory || directory;
          if (execution.agent === scoutPlayer.name) {
            return runScoutCall(harborCustomToolNames.teamRoster, execution, currentDirectory, async () => {
              const snapshot = rosterSnapshot(
                currentDirectory,
                call.query,
                await authoritativeBusyAgents(currentDirectory, execution.sessionID, execution.abort),
              );
              return { result: snapshot.text, rosterComplete: snapshot.complete };
            });
          }
          const turn = await acquireDelegateTurn(execution, currentDirectory, harborCustomToolNames.teamRoster);
          const policy = harborCustomToolPolicy(harborCustomToolNames.teamRoster)!;
          if (turn.state.inFlight) throw new Error("Agent Harbor team-lead tools must run sequentially");
          if (turn.state.rosterCalls >= policy.maximumCalls) {
            throw new Error(`harbor_team_roster reached its per-run limit (${policy.maximumCalls})`);
          }
          turn.state.rosterCalls += 1;
          turn.state.inFlight = true;
          try {
            return rosterSnapshot(
              currentDirectory,
              call.query,
              await authoritativeBusyAgents(currentDirectory, execution.sessionID, execution.abort),
            ).text;
          }
          finally { turn.state.inFlight = false; }
          },
        ),
      }),
      [harborCustomToolNames.filterSkills]: tool({
        description: harborStaticCustomToolSpecs[harborCustomToolNames.filterSkills].description,
        args: openCodeToolArgs(harborStaticCustomToolSpecs[harborCustomToolNames.filterSkills]),
        execute: (args, execution) => publicOpenCodeToolCall(
          harborCustomToolNames.filterSkills,
          execution.abort,
          async () => {
          const call = validatedOpenCodeCall(
            harborCustomToolNames.filterSkills,
            args,
            { agent: execution.agent },
          );
          if (call.kind !== "filter-skills") throw new Error("invalid Agent Harbor skill-filter dispatch");
          const currentDirectory = execution.directory || directory;
          return runScoutCall(harborCustomToolNames.filterSkills, execution, currentDirectory, async () => ({
            result: formatScoutSkillMatches(await filterTrustedSkills(call.query, trustedSkills, new GhResolver(), execution.abort)),
          }));
          },
        ),
      }),
      [harborCustomToolNames.joinPlayer]: tool({
        description: harborStaticCustomToolSpecs[harborCustomToolNames.joinPlayer].description,
        args: openCodeToolArgs(harborStaticCustomToolSpecs[harborCustomToolNames.joinPlayer]),
        execute: (args, execution) => publicOpenCodeToolCall(
          harborCustomToolNames.joinPlayer,
          execution.abort,
          async () => {
          const call = validatedOpenCodeCall(
            harborCustomToolNames.joinPlayer,
            args,
            { agent: execution.agent },
          );
          if (call.kind !== "join-player") throw new Error("invalid Agent Harbor join-player dispatch");
          const currentDirectory = execution.directory || directory;
          return runScoutCall(harborCustomToolNames.joinPlayer, execution, currentDirectory, async () => {
            const context = await harborContext("opencode", currentDirectory, new OpenCodeOrchestrator(client, currentDirectory));
            await executeCommand("join", call.definition, context, execution.abort);
            return { result: conciseOpenCodeScoutJoin(call.definition) };
          });
          },
        ),
      }),
      [harborCustomToolNames.delegate]: tool({
        description: `${harborStaticCustomToolSpecs[harborCustomToolNames.delegate].description} The target is ownership-validated against the live roster at invocation time, including players added by /join during this session.`,
        args: openCodeToolArgs(harborStaticCustomToolSpecs[harborCustomToolNames.delegate]),
        execute: (args, execution) => publicOpenCodeToolCall(
          harborCustomToolNames.delegate,
          execution.abort,
          async () => {
          const call = validatedOpenCodeCall(
            harborCustomToolNames.delegate,
            args,
            { agent: execution.agent },
          );
          if (call.kind !== "delegate") throw new Error("invalid Agent Harbor delegate dispatch");
          const { agent, task } = call;
          const currentDirectory = execution.directory || directory;
          assertNoConfigAgentConflict(agent);
          const player = requireInvocablePlayer("opencode", currentDirectory, agent).definition;
          const originatingTurn = await originatingUserMessage(
            execution.sessionID,
            execution.messageID,
            currentDirectory,
            execution.abort,
          );
          const turn = delegateLedger.acquire(
            [execution.sessionID],
            [execution.sessionID, originatingTurn.id],
          );
          const state = turn.value;
          if (state.terminal) throw new Error("Agent Harbor team-lead turn is terminal or replayed");
          const policy = harborCustomToolPolicy(harborCustomToolNames.delegate)!;
          if (state.calls >= policy.maximumCalls) {
            const maximum = policy.maximumCalls === 6 ? "six" : String(policy.maximumCalls);
            throw new Error(`harbor_delegate allows at most ${maximum} delegations per user turn`);
          }
          if (state.inFlight) throw new Error("harbor_delegate calls must run sequentially");
          if (state.agents.has(agent)) throw new Error(`harbor_delegate already delegated to ${agent} in this user turn`);
          const model = configuredOpenCodeModel(player.model, originatingTurn.model);
          const authoritativeBusy = await authoritativeBusyAgents(currentDirectory, execution.sessionID, execution.abort);
          if (authoritativeBusy.has(agent)) {
            throw new Error(`delegation target ${agent} is busy in an active OpenCode session`);
          }
          const reservationRecord = reserveAgent(
            currentDirectory,
            agent,
            { kind: "delegated", sessionID: execution.sessionID, owner: turn.id },
            `delegation target ${agent} is busy in another direct or delegated Agent Harbor run`,
          );
          state.calls += 1;
          state.agents.add(agent);
          state.inFlight = true;
          try {
            return await new OpenCodeOrchestrator(client, currentDirectory).runAgent(
              agent,
              normalizeDelegatedTaskPaths(task, currentDirectory),
              execution.sessionID,
              model,
              execution.abort,
              (phase) => reservationRecord.record.activity.setPhase(phase),
            );
          }
          finally {
            state.inFlight = false;
            if (agentReservations.get(reservationRecord.key) === reservationRecord.record) {
              reservationRecord.record.activity.release();
              agentReservations.delete(reservationRecord.key);
            }
          }
          },
        ),
      }),
      agent_harbor_skills: tool({
        description: "Load only the complete skill group configured for the current Agent Harbor player.",
        args: {},
        execute: (_args, execution) => publicOpenCodeToolCall(
          "agent_harbor_skills",
          execution.abort,
          async () => {
          const currentDirectory = execution.directory || directory;
          assertNoConfigAgentConflict(execution.agent);
          const player = requireInvocablePlayer("opencode", currentDirectory, execution.agent).definition;
          const loaded = await loadConfiguredSkills(player, currentDirectory, new GhResolver(), trustedSkills, execution.abort);
          return formatLoadedSkillGroup(loaded);
          },
        ),
      }),
    },
  };
};

export default AgentHarborPlugin;
