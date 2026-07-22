/** OpenCode plugin entrypoint and translation to Agent Harbor's shared core. */
import { Buffer } from "node:buffer";
import { resolve } from "node:path";
import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import { discoverStartupActiveProfiles, listInvocablePlayers, listOwnedActiveIds, loadManagedActivePlayer, requireInvocablePlayer } from "../core/active.js";
import { executeCommandResult } from "../core/commands.js";
import {
  assertHarborCustomToolAccess,
  formatHarborTeamRosterSnapshot,
  harborCustomToolNames,
  harborCustomToolPolicy,
  harborStaticCustomToolSpecs,
  HarborInvocationLedger,
  HarborScoutTurnGuard,
  maximumHarborTeamRosterMembers,
  validateHarborCustomToolArguments,
  type HarborCustomToolPrincipal,
  type HarborCustomToolSpec,
} from "../core/custom-tools.js";
import { bundledPlayers, rolePlayers, scoutPlayer, trustedSkills } from "../core/defaults.js";
import { GhResolver } from "../core/github.js";
import { isHarborId } from "../core/identity.js";
import { validatePlayer, type LifecycleMutationStatus } from "../core/lifecycle.js";
import { composePlayerInstructions, normalizeDelegatedTaskPaths, openCodePermissionPolicy, openCodeToolPolicy, playerDefinitionDigest } from "../core/profiles.js";
import { publicErrorText, publicMetadataText } from "../core/public-metadata.js";
import { formatLoadedSkillGroup, loadConfiguredSkills } from "../core/skills.js";
import { filterTrustedSkills, formatScoutSkillMatches } from "../core/scout.js";
import { commandNames, type CommandName } from "../core/types.js";
import { OpenCodeOrchestrator, type OpenCodeModel } from "../orchestrators/opencode.js";
import {
  claimValidatedOpenCodeAgentActivity,
  readOpenCodeAgentActivities,
  runOpenCodeRosterMutationGate,
  type OpenCodeAgentActivityClaim,
} from "./opencode-agent-activity.js";
import { recordOpenCodeAgentConflicts } from "./opencode-agent-conflicts.js";
import { assertOpenCodeLifecycleMutationTruth } from "./opencode-lifecycle-result.js";
import { recordOpenCodeDirectAliasCollisions } from "./opencode-team-runtime.js";
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
const openCodeDirectPreflightToastDeadlineMs = 500;

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
    abort?(options: {
      readonly path: { readonly id: string };
      readonly query?: { readonly directory?: string };
      readonly signal?: AbortSignal;
      readonly throwOnError?: boolean;
    }): Promise<unknown>;
  };
}

interface OpenCodeTuiNotificationClient {
  readonly tui?: {
    showToast(options: {
      readonly body: {
        readonly title: string;
        readonly message: string;
        readonly variant: "error";
        readonly duration: number;
      };
      readonly query: { readonly directory: string };
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

function publicOpenCodeDirectPreflightError(command: string, error: unknown): Error {
  let raw = "";
  try { raw = error instanceof Error ? error.message : String(error); }
  catch { raw = ""; }
  const message = publicErrorText(raw, 600, [command])
    ?? `/${command} was blocked before model execution without a public diagnostic`;
  const result = new Error(message);
  result.name = "AgentHarborDirectPreflightError";
  return result;
}

async function showOpenCodeDirectPreflightError(
  client: OpenCodeTuiNotificationClient,
  directory: string,
  message: string,
): Promise<void> {
  if (typeof client.tui?.showToast !== "function") return;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const operation = Promise.resolve().then(() => client.tui!.showToast({
    body: {
      title: "Agent Harbor command blocked",
      message,
      variant: "error",
      duration: 8_000,
    },
    query: { directory },
    signal: controller.signal,
  })).then(() => undefined, () => undefined);
  const deadline = new Promise<void>((resolveDeadline) => {
    timer = setTimeout(() => {
      controller.abort();
      resolveDeadline();
    }, openCodeDirectPreflightToastDeadlineMs);
  });
  try { await Promise.race([operation, deadline]); }
  finally {
    if (timer) clearTimeout(timer);
    controller.abort();
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

function validOpenCodeHostIdentity(value: unknown): value is string {
  return typeof value === "string" && Boolean(value) && value.length <= maximumOpenCodeHostIdentityBytes
    && Buffer.byteLength(value, "utf8") <= maximumOpenCodeHostIdentityBytes
    && !/[\u0000-\u001f\u007f]/u.test(value);
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

function conciseOpenCodeScoutJoin(definition: string, status: LifecycleMutationStatus): string {
  const player = validatePlayer(JSON.parse(definition));
  const publicRole = publicMetadataText(player.description, 240) ?? "Personal Agent Harbor teammate";
  const capacity = publicMetadataText([
    ...player.tools,
    ...(player.skills ?? []).map(({ name }) => `skill:${name}`),
  ].join(", "), 500) ?? "advisory";
  const model = player.model ? publicMetadataText(player.model, 200) : undefined;
  return [
    status === "already-current"
      ? `○ ${player.name} is already joined and current · no roster files changed.`
      : `✓ ${player.name} joined · personal · enabled in this project`,
    `Role: ${publicRole}`,
    `Capacity: ${capacity}`,
    `Model: ${model ? `configured ${model}` : "inherits the OpenCode host when run"}`,
    "Reload OpenCode before native selection, /<id>, or team-lead delegation can use this definition.",
    "Until reload, the live roster remains visible to zero-model controls but invocation fails closed.",
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
    readonly agent: string;
    readonly project: string;
    readonly sessionID: string;
    readonly owner: string;
    /** A direct slash claim is provisional until chat.message establishes an
     * exact user-turn boundary; every reservation published to the shared
     * store remains generation-checked before use and release. */
    activity?: OpenCodeAgentActivityClaim;
    /** A native busy/retry transition observed for this exact reservation generation. */
    observedBusy: boolean;
    /** Current user-turn boundary; set only after chat.message identity validation. */
    messageID?: string;
  }
  const agentReservations = new Map<string, AgentReservation>();
  const directAgentCommands = new Map<string, { readonly id: string; readonly definitionDigest?: string }>();
  let loadedHarborAgentDigests = new Map<string, string>();
  let configAgentConflicts = new Set<string>();
  const assertNoConfigAgentConflict = (id: string): void => {
    if (configAgentConflicts.has(id)) {
      throw new Error(`Agent Harbor player ${id} conflicts with a foreign OpenCode agent; rename or remove that agent entry, then reload OpenCode`);
    }
  };
  const validateLoadedHarborAgent = (id: string, expectedDigest: string): void => {
    assertNoConfigAgentConflict(id);
    const current = id === scoutPlayer.name
      ? scoutPlayer
      : requireInvocablePlayer("opencode", directory, id).definition;
    if (playerDefinitionDigest(current) !== expectedDigest) {
      throw new Error(`Agent Harbor player ${id} changed after OpenCode loaded it; reload before model execution`);
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
    reservation: Omit<AgentReservation, "agent" | "project" | "activity" | "observedBusy" | "messageID">,
    busyMessage: string,
    validateAdmission: () => void,
  ): { readonly key: string; readonly record: AgentReservation } => {
    const key = openCodeReservationKey(project, agent);
    if (agentReservations.has(key)) throw new Error(busyMessage);
    const projectKey = normalizedOpenCodeProject(project);
    let active = 0;
    for (const candidate of agentReservations.values()) {
      if (candidate.project === projectKey) active += 1;
    }
    if (active >= maximumOpenCodeProjectReservations) {
      throw new Error(`Agent Harbor allows at most ${maximumOpenCodeProjectReservations} active runs per project; wait for work to finish or open /team and enter stop all`);
    }
    let activity: OpenCodeAgentActivityClaim;
    try {
      activity = claimValidatedOpenCodeAgentActivity(
        projectKey,
        agent,
        reservation.kind,
        reservation.sessionID,
        validateAdmission,
      );
    }
    catch (error) {
      if (error instanceof Error && /busy in another direct or delegated run/u.test(error.message)) {
        throw new Error(busyMessage);
      }
      throw error;
    }
    const record = { ...reservation, agent, project: projectKey, activity, observedBusy: false };
    agentReservations.set(key, record);
    return { key, record };
  };
  const releaseDirectReservations = (sessionID: string): void => {
    let failed = false;
    for (const [key, reservation] of agentReservations) {
      if (reservation.kind === "direct" && reservation.sessionID === sessionID) {
        if (!reservation.activity || reservation.activity.release()) agentReservations.delete(key);
        else failed = true;
      }
    }
    if (failed) throw new Error("Agent Harbor could not verify direct activity-claim cleanup; filesystem recovery is required");
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
    const enabled = listInvocablePlayers("opencode", currentDirectory)
      .filter(({ id }) => id !== "team-lead");
    if (enabled.length > maximumHarborTeamRosterMembers) {
      return {
        complete: false,
        total: enabled.length,
        text: `Complete roster unavailable: ${enabled.length} enabled specialists exceeds the ${maximumHarborTeamRosterMembers}-member model-facing limit. Disable surplus bundled/personal members with /bench-off <id...>, reload OpenCode, then start a new lead turn. No partial roster was disclosed and no model child was started.`,
      };
    }
    const pendingReload = enabled.filter(({ id, definition }) =>
      configAgentConflicts.has(id) || loadedHarborAgentDigests.get(id) !== playerDefinitionDigest(definition));
    if (pendingReload.length) {
      const shown = pendingReload.slice(0, 3).map(({ id }) => id).join(", ");
      const hidden = pendingReload.length > 3 ? `, +${pendingReload.length - 3} more` : "";
      return {
        complete: false,
        total: enabled.length,
        text: `Complete roster unavailable: ${pendingReload.length} of ${enabled.length} enabled specialists are not loaded by this OpenCode instance (${shown}${hidden}). Reload OpenCode before team-lead delegation. No partial roster was disclosed and no model child was started.`,
      };
    }
    return formatHarborTeamRosterSnapshot(
    enabled
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
    "/bench-off <id...>",
    );
  };
  const assertLeadRosterCapacity = (
    currentDirectory: string,
    authoritativeBusy: ReadonlySet<string>,
  ): void => {
    const snapshot = rosterSnapshot(currentDirectory, "", authoritativeBusy);
    if (!snapshot.complete) throw new Error(snapshot.text);
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
  const exactDirectClaimToken = (sessionID: string, agent: string): string | undefined => {
    const matches = [...agentReservations.values()].filter((reservation) =>
      reservation.kind === "direct" && reservation.sessionID === sessionID &&
      reservation.agent === agent && reservation.activity);
    if (matches.length > 1) {
      throw new Error(`Agent Harbor found ambiguous ${agent} activity ownership for this OpenCode session`);
    }
    return matches[0]?.activity?.snapshot.claimToken;
  };
  const abortAfterDirectOwnershipLoss = async (sessionID: string): Promise<never> => {
    // Replace a vanished exact claim with a fresh recovery generation before
    // awaiting host abort. If another process already won the slot, its claim
    // is itself the fence and the old native turn is still aborted below.
    for (const reservation of agentReservations.values()) {
      if (reservation.kind !== "direct" || reservation.sessionID !== sessionID) continue;
      const expectedDigest = loadedHarborAgentDigests.get(reservation.agent);
      if (!expectedDigest) continue;
      try {
        const recovery = claimValidatedOpenCodeAgentActivity(
          reservation.project,
          reservation.agent,
          "direct",
          reservation.sessionID,
          () => validateLoadedHarborAgent(reservation.agent, expectedDigest),
        );
        if (!recovery.setPhase("cleaning")) {
          recovery.release();
          continue;
        }
        reservation.activity = recovery;
        reservation.observedBusy = true;
      } catch { /* A competing exact claim already fences this member. */ }
    }
    let abortConfirmed = false;
    if (activityClient?.session.abort) {
      try {
        const response = await boundedOpenCodeActivityRpc(
          "OpenCode ownership-loss abort",
          (signal) => activityClient.session.abort!({
            path: { id: sessionID },
            query: { directory },
            signal,
            throwOnError: true,
          }),
          openCodeActivityRpcDeadlineMs,
        );
        abortConfirmed = openCodeRpcData(response) === true;
      } catch { /* The public failure below remains fail-closed and path-free. */ }
    }
    throw new Error(abortConfirmed
      ? "Agent Harbor lost the exact direct activity generation; the native session was aborted and recovery is required"
      : "Agent Harbor lost the exact direct activity generation; native abort outcome is unknown and recovery is required");
  };
  return {
    "chat.message": async (input, output) => {
      const messageID = input.messageID ?? output.message.id;
      const model = input.model ?? output.message.model;
      const typedMessage = output.message as typeof output.message & {
        readonly agent?: unknown;
        readonly variant?: string;
        readonly model: typeof output.message.model & { readonly variant?: string };
      };
      const typedInput = input as typeof input & { readonly agent?: unknown };
      const outputAgent = typedMessage.agent;
      const inputAgent = typedInput.agent;
      const variant = input.variant ?? typedMessage.variant ?? typedMessage.model.variant;
      const sessionReservations = typeof input.sessionID === "string"
        ? [...agentReservations.values()].filter((reservation) =>
          reservation.kind === "direct" && reservation.sessionID === input.sessionID)
        : [];
      let reservation = sessionReservations[0];
      const outputDigest = isHarborId(outputAgent)
        ? loadedHarborAgentDigests.get(outputAgent)
        : undefined;
      const inputDigest = isHarborId(inputAgent)
        ? loadedHarborAgentDigests.get(inputAgent)
        : undefined;
      // Foreign/native OpenCode agents remain entirely outside Agent Harbor's
      // admission policy. A loaded Harbor identity, however, must claim before
      // its first model turn even when invoked through native selection.
      if (!reservation && outputDigest === undefined && inputDigest === undefined) return;
      const rejectTurn = (error: Error): never => {
        if (!reservation) throw error;
        try { releaseDirectReservations(reservation.sessionID); }
        catch (cleanupError) {
          throw new AggregateError([error, cleanupError], "OpenCode direct turn validation and activity-claim cleanup both failed");
        }
        throw error;
      };
      if (sessionReservations.length > 1) {
        rejectTurn(new Error("Agent Harbor found multiple direct reservations for one OpenCode session"));
      }
      const expectedAgent = reservation?.agent ?? outputAgent;
      if (typeof expectedAgent !== "string" || outputAgent !== expectedAgent ||
          inputAgent !== undefined && inputAgent !== expectedAgent ||
          !validOpenCodeHostIdentity(input.sessionID) || !validOpenCodeHostIdentity(messageID) ||
          !validOpenCodeHostModelIdentity(model?.providerID) ||
          !validOpenCodeHostModelIdentity(model?.modelID) ||
          variant !== undefined && !validOpenCodeHostModelIdentity(variant)) {
        rejectTurn(new Error("Agent Harbor rejected mismatched agent identity, turn identity, or model telemetry before model execution"));
      }
      let authoritativeBusy: ReadonlySet<string> | undefined;
      if (!reservation || expectedAgent === "team-lead") {
        authoritativeBusy = await authoritativeBusyAgents(directory, input.sessionID);
      }
      if (expectedAgent === "team-lead") {
        try { assertLeadRosterCapacity(directory, authoritativeBusy!); }
        catch (error) {
          rejectTurn(error instanceof Error
            ? error
            : new Error("Agent Harbor could not verify the team-lead roster before model execution"));
        }
      }
      if (!reservation) {
        const expectedDigest = (outputDigest ?? inputDigest)!;
        validateLoadedHarborAgent(expectedAgent, expectedDigest);
        if (authoritativeBusy!.has(expectedAgent)) {
          throw new Error(`Agent Harbor player ${expectedAgent} is busy in an active OpenCode session`);
        }
        reservation = reserveAgent(
          directory,
          expectedAgent,
          { kind: "direct", sessionID: input.sessionID, owner: `native:${input.sessionID}` },
          `Agent Harbor player ${expectedAgent} is busy in another direct or delegated run`,
          () => {
            if (loadedHarborAgentDigests.get(expectedAgent) !== expectedDigest) {
              throw new Error(`Agent Harbor player ${expectedAgent} changed in loaded OpenCode configuration during admission`);
            }
            validateLoadedHarborAgent(expectedAgent, expectedDigest);
          },
        ).record;
      }
      if (!reservation.activity) {
        const expectedDigest = loadedHarborAgentDigests.get(expectedAgent);
        if (!expectedDigest) {
          rejectTurn(new Error(`Agent Harbor player ${expectedAgent} is not loaded; reload OpenCode before model execution`));
        }
        const admissionDigest = expectedDigest!;
        try {
          reservation.activity = claimValidatedOpenCodeAgentActivity(
            reservation.project,
            expectedAgent,
            "direct",
            reservation.sessionID,
            () => validateLoadedHarborAgent(expectedAgent, admissionDigest),
          );
        } catch (error) {
          rejectTurn(error instanceof Error ? error : new Error("Agent Harbor direct activity admission failed"));
        }
      }
      const directActivity = reservation.activity;
      if (!directActivity) rejectTurn(new Error("Agent Harbor direct activity admission did not publish an ownership claim"));
      if (!directActivity!.setPhase("working")) {
        rejectTurn(new Error("Agent Harbor could not publish and verify the direct working phase; the run was rejected before reliable activity publication"));
      }
      try {
        turnModelLedger.acquire([input.sessionID], [input.sessionID, messageID]).value.model = {
          providerID: model.providerID,
          modelID: model.modelID,
          ...(variant === undefined ? {} : { variant }),
        };
        reservation.messageID = messageID;
      } catch (error) {
        rejectTurn(error instanceof Error ? error : new Error("Agent Harbor model ledger publication failed"));
      }
    },
    "chat.params": async (input, output) => {
      if (input.model.providerID === "openai" &&
          (input.model.id === "gpt-5.3-codex-spark" || input.model.id === "gpt-5.6-luna")) {
        // The Codex OAuth Responses endpoint rejects metadata injected for SDK-created sessions.
        delete output.options.metadata;
      }
    },
    event: async ({ event }) => {
      if (event.type === "session.status" && event.properties.status.type !== "idle") {
        const sessionID = event.properties.sessionID;
        let ownershipLost = false;
        for (const reservation of agentReservations.values()) {
          if (reservation.kind === "direct" && reservation.sessionID === sessionID) {
            if (reservation.activity && !reservation.activity.setPhase("working")) ownershipLost = true;
            else reservation.observedBusy = true;
          }
        }
        if (ownershipLost) await abortAfterDirectOwnershipLoss(sessionID);
        return;
      }
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
      let directGeneration = [...agentReservations.values()].filter((reservation) =>
        reservation.kind === "direct" && reservation.sessionID === sessionID);
      // A slash-command claim without a user-turn boundary is provisional.
      // Any terminal can discard it: the later chat hook must still hold (or
      // win) a fresh validated claim before model work, so a replayed terminal
      // cannot weaken admission safety.
      for (const [key, reservation] of agentReservations) {
        if (reservation.kind === "direct" && reservation.sessionID === sessionID && !reservation.messageID) {
          if (!reservation.activity || reservation.activity.release()) agentReservations.delete(key);
        }
      }
      directGeneration = directGeneration.filter((reservation) => reservation.activity !== undefined && reservation.messageID !== undefined);
      if (event.type !== "session.deleted" && directGeneration.length) {
        // Idle/error events carry only a reusable session ID. Never let a
        // delayed terminal from turn N erase the claim for turn N+1. A current
        // An idle must first follow a busy/retry transition. session.error is
        // equally session-scoped and may also be replayed, so without current-
        // generation busy evidence it additionally needs an exact terminal
        // assistant message parented by this reservation's user turn.
        if (event.type !== "session.error" &&
            directGeneration.some((reservation) => !reservation.observedBusy || !reservation.messageID)) return;
        const tokens = directGeneration.map(({ activity }) => activity!.snapshot.claimToken).sort();
        const exactTurnTerminal = async (reservation: AgentReservation): Promise<boolean> => {
          if (!activityClient || !reservation.messageID) return false;
          let response: unknown;
          try {
            response = await boundedOpenCodeActivityRpc(
              "OpenCode direct-error turn reconciliation",
              (signal) => activityClient.session.messages({
                path: { id: sessionID },
                query: { directory, limit: maximumOpenCodeActivityMessagesPerSession },
                signal,
              }),
              openCodeActivityRpcDeadlineMs,
            );
          } catch { return false; }
          let messages: unknown;
          try { messages = openCodeRpcData(response); }
          catch { return false; }
          if (!Array.isArray(messages) || messages.length === 0 ||
              messages.length > maximumOpenCodeActivityMessagesPerSession) return false;
          for (const message of messages) {
            const info = plainRecord(plainRecord(message)?.info);
            if (!info || info.role !== "assistant") continue;
            if (info.sessionID !== sessionID || info.parentID !== reservation.messageID ||
                typeof info.id !== "string" || !validOpenCodeHostIdentity(info.id)) continue;
            const time = plainRecord(info.time);
            const completed = time?.completed;
            const hasCompleted = Number.isSafeInteger(completed) && (completed as number) >= 0;
            const hasError = Object.hasOwn(info, "error") && info.error !== undefined;
            const hasFinish = typeof info.finish === "string" && info.finish.length > 0 &&
              info.finish.length <= maximumOpenCodeHostIdentityBytes;
            if (hasCompleted || hasError || hasFinish) return true;
          }
          return false;
        };
        if (event.type === "session.error" && directGeneration.some((reservation) => !reservation.observedBusy)) {
          const terminal = await Promise.all(directGeneration.map(exactTurnTerminal));
          if (terminal.some((value) => !value)) {
            if (directGeneration.some((reservation) => !reservation.activity!.setPhase("cleaning"))) {
              await abortAfterDirectOwnershipLoss(sessionID);
            }
            return;
          }
        }
        const confirmedIdle = async (): Promise<boolean> => {
          if (!activityClient) return false;
          const deadline = Date.now() + openCodeActivityTotalDeadlineMs;
          let consecutiveIdle = 0;
          while (Date.now() < deadline) {
            let response: unknown;
            try {
              response = await boundedOpenCodeActivityRpc(
                "OpenCode direct-terminal reconciliation",
                (signal) => activityClient.session.status({ query: { directory }, signal }),
                openCodeActivityRpcDeadlineMs,
              );
            } catch { return false; }
            const statuses = plainRecord(openCodeRpcData(response));
            if (!statuses) return false;
            const status = plainRecord(statuses[sessionID]);
            if (status !== undefined && status.type !== "idle") {
              if (status.type !== "busy" && status.type !== "retry") return false;
              consecutiveIdle = 0;
            } else {
              consecutiveIdle += 1;
            }
            const current = [...agentReservations.values()]
              .filter((reservation) => reservation.kind === "direct" && reservation.sessionID === sessionID && reservation.activity)
              .map(({ activity }) => activity!.snapshot.claimToken)
              .sort();
            if (current.length !== tokens.length || !current.every((token, index) => token === tokens[index])) return false;
            if (consecutiveIdle >= 2) return true;
            await new Promise<void>((resolve) => setTimeout(resolve, 20));
          }
          return false;
        };
        if (!await confirmedIdle()) {
          // The terminal was observed but the native host has not converged.
          // Publish that cleanup is pending instead of falsely leaving the
          // player "working" forever; stop/reload recovery remains fail-closed.
          if (directGeneration.some((reservation) => !reservation.activity!.setPhase("cleaning"))) {
            await abortAfterDirectOwnershipLoss(sessionID);
          }
          return;
        }
      }
      let releaseFailure: unknown;
      try { releaseDirectReservations(sessionID); }
      catch (error) { releaseFailure = error; }
      let ledgerFailure: unknown;
      try {
        scoutLedger.terminateScope([sessionID], `OpenCode ${event.type}`);
        delegateLedger.terminateScope([sessionID], `OpenCode ${event.type}`);
        turnModelLedger.terminateScope([sessionID], `OpenCode ${event.type}`);
      } catch (error) { ledgerFailure = error; /* Oversized/invalid host IDs fail closed at the call boundary. */ }
      if (releaseFailure !== undefined && ledgerFailure !== undefined) {
        throw new AggregateError([releaseFailure, ledgerFailure], "OpenCode activity cleanup and lifecycle-ledger termination both failed");
      }
      if (releaseFailure !== undefined) throw releaseFailure;
      if (ledgerFailure !== undefined) throw ledgerFailure;
    },
    dispose: async () => {
      scoutLedger.terminateAll("OpenCode plugin disposed");
      delegateLedger.terminateAll("OpenCode plugin disposed");
      turnModelLedger.terminateAll("OpenCode plugin disposed");
      let releaseFailed = false;
      for (const [key, reservation] of agentReservations) {
        if (!reservation.activity || reservation.activity.release()) agentReservations.delete(key);
        else releaseFailed = true;
      }
      if (releaseFailed) throw new Error("Agent Harbor could not verify activity-claim cleanup during disposal; filesystem recovery is required");
    },
    config: async (config) => {
      config.command ??= {};
      // Remove only exact prior Harbor aliases. This also cleans stale aliases
      // when a fresh plugin instance receives a reused host config object.
      for (const [alias, candidate] of Object.entries(config.command)) {
        const agent = candidate && typeof candidate === "object" && !Array.isArray(candidate)
          ? (candidate as Record<string, unknown>).agent
          : undefined;
        if ((commandNames as readonly string[]).includes(alias) &&
            isAgentHarborLifecycleCommand(alias as CommandName, candidate) ||
            alias === "scout" && isAgentHarborScoutCommand(candidate) ||
            typeof agent === "string" && isAgentHarborDirectCommand(agent, candidate)) {
          delete config.command[alias];
        }
      }
      // While configuration is being reconciled, every direct alias fails
      // closed instead of using a stale ownership decision.
      directAgentCommands.clear();
      recordOpenCodeDirectAliasCollisions(directory, []);
      const commandCollisions = new Map<string, string>();
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
      const nextLoadedHarborAgentDigests = new Map<string, string>();
      for (const [id, player] of rolePlayers) {
        nextLoadedHarborAgentDigests.set(id, playerDefinitionDigest(player));
      }
      nextLoadedHarborAgentDigests.set(scoutPlayer.name, playerDefinitionDigest(scoutPlayer));
      for (const [id, player] of managedDefinitions) {
        if (!configAgentConflicts.has(id)) {
          nextLoadedHarborAgentDigests.set(id, playerDefinitionDigest(player));
        }
      }
      loadedHarborAgentDigests = nextLoadedHarborAgentDigests;

      const nextDirectAgentCommands = new Map<string, { readonly id: string; readonly definitionDigest?: string }>();
      const registerDirectAlias = (
        alias: string,
        id: string,
        definition: unknown,
        player: ReturnType<typeof loadManagedActivePlayer> | undefined,
      ): void => {
        if (configAgentConflicts.has(id)) {
          // Alias ownership remains independently observable even when the
          // same member also has an agent-definition collision.
          if (config.command![alias] !== undefined) commandCollisions.set(alias, id);
          return;
        }
        if (config.command![alias] !== undefined) {
          commandCollisions.set(alias, id);
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

      const sortedCommandCollisions = [...commandCollisions.keys()].sort();
      recordOpenCodeDirectAliasCollisions(directory, sortedCommandCollisions.map((alias) => ({
        alias,
        agent: commandCollisions.get(alias)!,
      })));
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
      try {
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
        const validateCurrentDefinition = (): void => {
          assertNoConfigAgentConflict(id);
          if (id !== scoutPlayer.name) {
            let current: ReturnType<typeof requireInvocablePlayer>;
            try { current = requireInvocablePlayer("opencode", directory, id); }
            catch (error) {
              if (error instanceof Error && /^active managed player not found: [a-z0-9-]+$/u.test(error.message)) {
                throw new Error(`/${command} is no longer active in Agent Harbor; reload OpenCode to remove this stale alias`);
              }
              throw error;
            }
            if (!direct.definitionDigest || playerDefinitionDigest(current.definition) !== direct.definitionDigest) {
              throw new Error(`/${command} requires an OpenCode reload because its loaded Agent Harbor definition changed`);
            }
          }
        };
        validateCurrentDefinition();
        const authoritativeBusy = await authoritativeBusyAgents(directory, sessionID);
        if (id === "team-lead") assertLeadRosterCapacity(directory, authoritativeBusy);
        if (authoritativeBusy.has(id)) {
          throw new Error(`Agent Harbor player ${id} is busy in an active OpenCode session`);
        }
        reserveAgent(
          directory,
          id,
          { kind: "direct", sessionID, owner: `direct:${sessionID}` },
          `Agent Harbor player ${id} is busy in another direct or delegated run`,
          validateCurrentDefinition,
        );
      } catch (error) {
        const publicError = publicOpenCodeDirectPreflightError(command, error);
        await showOpenCodeDirectPreflightError(
          client as unknown as OpenCodeTuiNotificationClient,
          directory,
          publicError.message,
        );
        throw publicError;
      }
    },
    tool: {
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
            const committed = await runOpenCodeRosterMutationGate(
              "join",
              call.definition,
              currentDirectory,
              () => executeCommandResult("join", call.definition, context, execution.abort),
              exactDirectClaimToken(execution.sessionID, scoutPlayer.name),
            );
            assertOpenCodeLifecycleMutationTruth("join", call.definition, committed);
            if (committed.lifecycle?.command !== "join") throw new Error("OpenCode scout join lifecycle verification was not retained");
            const status = committed.lifecycle.status;
            return { result: conciseOpenCodeScoutJoin(call.definition, status) };
          });
          },
        ),
      }),
      [harborCustomToolNames.delegate]: tool({
        description: `${harborStaticCustomToolSpecs[harborCustomToolNames.delegate].description} The target must be ownership-validated and loaded by the current OpenCode configuration; newly joined or replaced players require reload before delegation.`,
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
          const expectedDefinitionDigest = playerDefinitionDigest(player);
          const loadedDefinitionDigest = loadedHarborAgentDigests.get(agent);
          if (loadedDefinitionDigest !== expectedDefinitionDigest) {
            throw new Error(`delegation target ${agent} is enabled but not loaded by this OpenCode instance; reload OpenCode before delegation`);
          }
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
            () => {
              assertNoConfigAgentConflict(agent);
              const current = requireInvocablePlayer("opencode", currentDirectory, agent).definition;
              if (playerDefinitionDigest(current) !== expectedDefinitionDigest) {
                throw new Error(`delegation target ${agent} changed during admission; retry with the live roster`);
              }
            },
          );
          state.calls += 1;
          state.agents.add(agent);
          state.inFlight = true;
          let result: string | undefined;
          let runFailure: unknown;
          let releaseFailure: Error | undefined;
          try {
            result = await new OpenCodeOrchestrator(client, currentDirectory).runAgent(
              agent,
              normalizeDelegatedTaskPaths(task, currentDirectory),
              execution.sessionID,
              model,
              execution.abort,
              (phase, childSessionID) => {
                if (childSessionID && reservationRecord.record.activity!.snapshot.sessionID !== childSessionID &&
                    !reservationRecord.record.activity!.setSessionID(childSessionID)) {
                  throw new Error("Agent Harbor could not publish and verify the disposable child identity; the child will be cleaned without prompting");
                }
                if (!reservationRecord.record.activity!.setPhase(phase)) {
                  throw new Error(`Agent Harbor could not publish and verify the delegated ${phase} phase`);
                }
              },
            );
          }
          catch (error) { runFailure = error; }
          finally {
            state.inFlight = false;
            if (agentReservations.get(reservationRecord.key) === reservationRecord.record) {
              if (reservationRecord.record.activity!.release()) agentReservations.delete(reservationRecord.key);
              else releaseFailure = new Error("Agent Harbor could not verify delegated activity-claim cleanup; filesystem recovery is required");
            }
          }
          if (runFailure !== undefined && releaseFailure) {
            throw new AggregateError([runFailure, releaseFailure], "OpenCode delegation and activity-claim cleanup both failed");
          }
          if (runFailure !== undefined) throw runFailure;
          if (releaseFailure) throw releaseFailure;
          return result!;
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
