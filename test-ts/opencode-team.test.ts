import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  collectOpenCodeTeamSnapshot,
  maximumOpenCodeMessagesPerSession,
  openCodePublicLabel,
  openCodeTaskLabel,
  readOpenCodeDirectAliasCollisions,
  recordOpenCodeDirectAliasCollisions,
  stopOpenCodeTeamRuns,
} from "../src/adapters/opencode-team-runtime.js";
import {
  formatOpenCodeTeamDiagnostics,
  formatOpenCodeTeamHelp,
  formatOpenCodeStopResult,
  formatOpenCodeTeamView,
  maximumOpenCodeTeamDialogLines,
} from "../src/adapters/opencode-team-view.js";
import { claimOpenCodeAgentActivity, readOpenCodeAgentActivities } from "../src/adapters/opencode-agent-activity.js";
import { assertOpenCodeLifecycleMutationTruth } from "../src/adapters/opencode-lifecycle-result.js";
import openCodeTuiPlugin, {
  openCodeDirectCommands,
  openCodeTuiOrchestratorClient,
  boundedContractEvidence,
  runOpenCodeTeamQuery,
} from "../src/adapters/opencode-tui.js";
import { readOpenCodeAgentConflicts, recordOpenCodeAgentConflicts } from "../src/adapters/opencode-agent-conflicts.js";
import { runDeterministicCommand } from "../src/adapters/direct.js";
import { loadManagedActivePlayer } from "../src/core/active.js";
import { GhResolver } from "../src/core/github.js";
import { playerDefinitionDigest } from "../src/core/profiles.js";
import { visibleTextWidth } from "../src/core/text-layout.js";
import {
  prepareSignedOpenCodeHarborTitle,
  verifySignedOpenCodeHarborTitle,
} from "../src/core/opencode-session-claims.js";
import { OpenCodeOrchestrator } from "../src/orchestrators/opencode.js";

function response(data: unknown): any {
  return { data, error: undefined, request: {}, response: {} };
}

function nativeSession(
  directory: string,
  id: string,
  title: string,
  agent?: string,
  parentID?: string,
): any {
  return {
    id,
    projectID: "project",
    title,
    ...(agent ? { agent } : {}),
    ...(parentID ? { parentID } : {}),
    location: { directory },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1_000, updated: 2_000 },
  };
}

function legacyUserMessage(sessionID: string, agent: string, id: string, text: string, created = 1_000): any {
  return {
    info: { id, sessionID, role: "user", agent, time: { created } },
    parts: [{ id: `${id}-text`, sessionID, messageID: id, type: "text", text }],
  };
}

function legacyAssistantMessage(sessionID: string, agent: string, id: string, created = 2_000): any {
  return {
    info: {
      id, sessionID, role: "assistant", agent, providerID: "local", modelID: "fake-model",
      cost: 0.0002,
      tokens: { input: 11, output: 7, reasoning: 3, cache: { read: 2, write: 1 } },
      time: { created },
    },
    parts: [{
      id: `${id}-private-text`, sessionID, messageID: id, type: "text",
      text: "assistant prose must never be retained",
    }],
  };
}

function fakeApi(input: {
  directory: string;
  sessions?: any[];
  sessionCursor?: Record<string, unknown>;
  active?: Record<string, unknown>;
  activeSequence?: Record<string, unknown>[];
  activeProvider?: (read: number) => Record<string, unknown>;
  legacyStatus?: Record<string, unknown>;
  legacyStatusSequence?: Record<string, unknown>[];
  legacyStatusProvider?: (read: number) => Record<string, unknown>;
  messages?: Record<string, any[]>;
  messageCursor?: Record<string, unknown>;
  messageProvider?: (sessionID: string, read: number) => any[] | Promise<any[]>;
  legacyMessages?: Record<string, any[]>;
  legacyMessageProvider?: (sessionID: string, read: number) => any[];
  current?: string;
  stateStatus?: "busy" | "retry" | "idle";
  hangList?: boolean;
  hangActive?: boolean;
  hangLegacyStatus?: boolean;
  getSession?: (sessionID: string, call: number) => any;
  abortSession?: (sessionID: string, call: number) => any | Promise<any>;
  interruptSession?: (sessionID: string, call: number) => any | Promise<any>;
  abortDelayMs?: number;
  stayActiveAfterAbort?: boolean;
  stateInfos?: any[];
  stateParts?: (messageID: string) => any[];
  configModel?: string;
  providers?: any[];
  loadedAgents?: readonly string[];
}) {
  const aborts: string[] = [];
  const abortInputs: Array<{ sessionID: string; directory?: string }> = [];
  const interrupts: string[] = [];
  const interruptInputs: Array<{ sessionID: string }> = [];
  const stopped = new Set<string>();
  const dialogs: any[] = [];
  const toasts: any[] = [];
  const messageReads: string[] = [];
  const messageLimits: Array<number | undefined> = [];
  const legacyMessageReads: string[] = [];
  const legacyStatusInputs: Array<{ directory?: string }> = [];
  const dialogSizes: string[] = [];
  let activeReads = 0;
  let listReads = 0;
  const listLimits: number[] = [];
  let getReads = 0;
  let abortReads = 0;
  let interruptReads = 0;
  let legacyStatusReads = 0;
  let dialogSize = "medium";
  let dialogOpen = false;
  let dialogClearCount = 0;
  let dialogOnClose: (() => void) | undefined;
  const lifecycleController = new AbortController();
  const lifecycleCallbacks: Array<() => void | Promise<void>> = [];
  let registeredLayer: any;
  let layerDisposeCount = 0;
  const byID = new Map((input.sessions ?? []).map((session) => [session.id, session]));
  const cachedMessages = input.current ? input.messages?.[input.current] ?? [] : [];
  const uiDialog = {
    replace: (render: () => unknown, onClose?: () => void) => {
      const close = dialogOnClose;
      dialogOnClose = undefined;
      close?.();
      dialogOnClose = onClose;
      dialogOpen = true;
      dialogs.push(render());
    },
    clear: () => {
      if (dialogOpen) dialogClearCount += 1;
      dialogOpen = false;
      const close = dialogOnClose; dialogOnClose = undefined; close?.();
    },
    setSize: (size: string) => { dialogSize = size; dialogSizes.push(size); },
    get size() { return dialogSize; },
    depth: 0,
    get open() { return dialogOpen; },
  };
  const api: any = {
    route: input.current ? { current: { name: "session", params: { sessionID: input.current } } } : { current: { name: "home" } },
    state: {
      path: { directory: input.directory },
      config: {
        ...(input.configModel ? { model: input.configModel } : {}),
        agent: Object.fromEntries([
          "team-lead", "crafter", "talent-scout", ...(input.loadedAgents ?? []),
        ].map((id) => {
          if (id === "team-lead" || id === "crafter" || id === "talent-scout") return [id, {}];
          const definition = loadManagedActivePlayer("opencode", input.directory, id);
          return [id, { metadata: {
            owner: "agent-foundry", player: id, revision: "5",
            definitionDigest: playerDefinitionDigest(definition),
          } }];
        })),
      },
      provider: input.providers ?? [],
      session: {
        get: (id: string) => byID.get(id),
        messages: (_id: string) => input.stateInfos ?? cachedMessages.flatMap((message) => {
          if (message.type === "user") return [{ id: `user-${message.text}`, role: "user", time: message.time ?? { created: 1_000 } }];
          if (message.type === "assistant") return [{
            id: `assistant-${message.agent}`,
            role: "assistant",
            agent: message.agent,
            providerID: message.model?.providerID,
            modelID: message.model?.id,
            cost: message.cost ?? 0,
            tokens: message.tokens ?? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            time: message.time ?? { created: 2_000 },
          }];
          return [];
        }),
        status: () => input.stateStatus ? { type: input.stateStatus } : undefined,
      },
      part: (messageID: string) => input.stateParts ? input.stateParts(messageID) : messageID.startsWith("user-")
        ? [{ type: "text", text: messageID.slice("user-".length) }]
        : [],
    },
    client: {
      session: {
        status: (request: { directory?: string } = {}) => {
          legacyStatusReads += 1;
          legacyStatusInputs.push({ ...request });
          const source = input.legacyStatusProvider?.(legacyStatusReads)
            ?? input.legacyStatusSequence?.[Math.min(legacyStatusReads - 1, input.legacyStatusSequence.length - 1)]
            ?? input.legacyStatus
            ?? {};
          const visible = { ...source };
          for (const sessionID of stopped) delete visible[sessionID];
          return input.hangLegacyStatus ? new Promise(() => {}) : Promise.resolve(response(visible));
        },
        messages: ({ sessionID }: { sessionID: string; directory?: string; limit?: number }) => {
          legacyMessageReads.push(sessionID);
          const source = input.legacyMessageProvider?.(sessionID, legacyMessageReads.length)
            ?? input.legacyMessages?.[sessionID]
            ?? (input.messages?.[sessionID] ?? []).slice().reverse().map((message, index) => ({
              info: {
                id: message.id ?? `${sessionID}-legacy-message-${index}`,
                sessionID,
                role: message.type,
                ...(message.type === "user" ? { agent: message.agent ?? byID.get(sessionID)?.agent } : {}),
                time: message.time ?? { created: 1_000 + index },
              },
              parts: [],
            }));
          return Promise.resolve(response(source));
        },
        get: async ({ sessionID }: { sessionID: string; directory?: string }) =>
          response(await input.getSession?.(sessionID, ++getReads) ?? byID.get(sessionID)),
        abort: async (request: { sessionID: string; directory?: string }) => {
          const { sessionID } = request;
          abortInputs.push({ ...request });
          aborts.push(sessionID);
          abortReads += 1;
          const result = input.abortSession
            ? await input.abortSession(sessionID, abortReads)
            : input.abortDelayMs
            ? new Promise((resolve) => setTimeout(() => resolve(response(true)), input.abortDelayMs))
            : response(true);
          if (!input.stayActiveAfterAbort && result?.data === true && result.error == null) {
            stopped.add(sessionID);
          }
          return result;
        },
      },
      v2: {
        session: {
          list: ({ limit }: { limit?: number } = {}) => {
            listReads += 1;
            if (typeof limit === "number") listLimits.push(limit);
            const sessions = typeof limit === "number" ? (input.sessions ?? []).slice(0, limit) : input.sessions ?? [];
            return input.hangList ? new Promise(() => {}) : Promise.resolve(response({
              data: sessions,
              cursor: input.sessionCursor ?? {},
            }));
          },
          active: () => {
            activeReads += 1;
            const value = input.activeProvider?.(activeReads)
              ?? input.activeSequence?.[Math.min(activeReads - 1, input.activeSequence.length - 1)]
              ?? input.active ?? {};
            const visible = { ...value };
            if (!input.stayActiveAfterAbort) {
              for (const sessionID of stopped) delete visible[sessionID];
            }
            return input.hangActive ? new Promise(() => {}) : Promise.resolve(response({ data: visible }));
          },
          get: async ({ sessionID }: { sessionID: string }) => {
            getReads += 1;
            return response({ data: await input.getSession?.(sessionID, getReads) ?? byID.get(sessionID) });
          },
          messages: async ({ sessionID, limit }: { sessionID: string; limit?: number }) => {
            messageReads.push(sessionID);
            messageLimits.push(limit);
            const source = await input.messageProvider?.(sessionID, messageReads.length) ?? input.messages?.[sessionID] ?? [];
            const values = source.map((message, index) =>
              ({
                ...message,
                ...(message.id ? {} : { id: `${sessionID}-message-${index}` }),
                ...(message.time ? {} : { time: { created: 1_000_000 - index } }),
              }));
            return response({ data: values, cursor: input.messageCursor ?? {} });
          },
          interrupt: async (request: { sessionID: string }) => {
            const { sessionID } = request;
            interruptInputs.push({ ...request });
            interrupts.push(sessionID);
            interruptReads += 1;
            const result = input.interruptSession
              ? await input.interruptSession(sessionID, interruptReads)
              : response({});
            if (!input.stayActiveAfterAbort && result?.error == null && Object.hasOwn(result ?? {}, "data")) {
              stopped.add(sessionID);
            }
            return result;
          },
        },
      },
    },
    ui: {
      dialog: uiDialog,
      DialogAlert: (props: unknown) => props,
      DialogPrompt: (props: unknown) => props,
      toast: (value: unknown) => { toasts.push(value); },
    },
    keymap: {
      registerLayer: (layer: unknown) => {
        registeredLayer = layer;
        let disposed = false;
        return () => { if (!disposed) layerDisposeCount += 1; disposed = true; return disposed; };
      },
    },
    lifecycle: {
      signal: lifecycleController.signal,
      onDispose: (callback: () => void | Promise<void>) => {
        lifecycleCallbacks.push(callback);
        return () => undefined;
      },
    },
  };
  const dispose = async (): Promise<void> => {
    lifecycleController.abort();
    for (const callback of lifecycleCallbacks) await callback();
  };
  return {
    api, aborts, abortInputs, interrupts, interruptInputs, dialogs, toasts, messageReads,
    legacyMessageReads, messageLimits, legacyStatusInputs, dialogSizes, listLimits, dispose,
    abortLifecycle: () => lifecycleController.abort(),
    get listReads() { return listReads; },
    get activeReads() { return activeReads; },
    get legacyStatusReads() { return legacyStatusReads; },
    get dialogSize() { return dialogSize; },
    get dialogOpen() { return dialogOpen; },
    get dialogClearCount() { return dialogClearCount; },
    get layerDisposeCount() { return layerDisposeCount; },
    get registeredLayer() { return registeredLayer; },
  };
}

async function isolatedProject(prefix: string): Promise<{ root: string; project: string; restore(): void }> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const prior = process.env.OPENCODE_CONFIG_DIR;
  process.env.OPENCODE_CONFIG_DIR = join(root, "home");
  return {
    root,
    project: join(root, "project"),
    restore: () => {
      if (prior === undefined) delete process.env.OPENCODE_CONFIG_DIR;
      else process.env.OPENCODE_CONFIG_DIR = prior;
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("OpenCode team view classifies direct/delegated activity, infers the only lead hierarchy, and redacts tasks", async () => {
  const fixture = await isolatedProject("harbor-opencode-team-");
  try {
    const lead = nativeSession(fixture.project, "lead-session-123456", "Ordinary project session", "team-lead");
    const signChild = await prepareSignedOpenCodeHarborTitle(join(fixture.root, "home"), fixture.project, "agent", "crafter");
    const child = nativeSession(fixture.project, "child-session-123456", signChild("child-session-123456"), "crafter");
    const foreign = nativeSession(fixture.project, "foreign-session", "Unrelated work", "general");
    const { api } = fakeApi({
      directory: fixture.project,
      sessions: [foreign, child, lead],
      active: {
        "lead-session-123456": { type: "running" },
        "child-session-123456": { type: "running" },
        "foreign-session": { type: "running" },
      },
      messages: {
        "lead-session-123456": [
          {
            type: "assistant", agent: "team-lead", model: { providerID: "openai", id: "gpt-observed" },
            tokens: { input: 21, output: 5, reasoning: 2, cache: { read: 3, write: 0 } }, cost: 0.012,
            content: [{ type: "text", text: "assistant-private-evidence" }], time: { created: 2_000 },
          },
          {
            type: "user",
            text: "Inspect C:\\private\\customer.txt using token-secret-abcdefghijklmnop and https://internal.example/a",
            time: { created: 1_000 },
          },
        ],
        "child-session-123456": [
          { type: "assistant", agent: "crafter", model: { providerID: "openai", id: "gpt-child" }, content: [], time: { created: 2_100 } },
          { type: "user", text: "Improve the team display", time: { created: 2_000 } },
        ],
        "foreign-session": [{ type: "user", text: "foreign-private-task", time: { created: 1_000 } }],
      },
    });

    const snapshot = await collectOpenCodeTeamSnapshot(api, { now: () => 3_000 });
    assert.equal(snapshot.activeAuthoritative, true);
    assert.deepEqual(snapshot.runs.map(({ agent, invocation }) => [agent, invocation]), [
      ["team-lead", "direct"], ["crafter", "delegated"],
    ]);
    assert.equal(snapshot.runs[1].parentRunId, snapshot.runs[0].id);
    assert.equal(snapshot.runs[1].parentSource, "inferred");
    assert.deepEqual(snapshot.runs[0].model, { provider: "openai", id: "gpt-observed" });
    assert.deepEqual(snapshot.runs[0].usage, {
      input: 21, output: 5, reasoning: 2, cacheRead: 3, cacheWrite: 0, total: 31, cost: 0.012,
    });
    assert.deepEqual(snapshot.runs[1].usage, {
      input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0,
    }, "explicit zero telemetry was confused with absent telemetry");
    assert.equal(snapshot.members.filter(({ kind }) => kind === "bundled" && snapshot.members.length).length, 6);
    assert.equal(snapshot.members.filter(({ availability }) => availability === "bench").length, 6);

    const leadRun = snapshot.runs.find(({ agent }) => agent === "team-lead")!;
    const childRun = snapshot.runs.find(({ agent }) => agent === "crafter")!;
    const leadView = formatOpenCodeTeamView(snapshot, `run:${leadRun.id}`);
    const childView = formatOpenCodeTeamView(snapshot, `run:${childRun.id}`);
    const flatLead = leadView.replace(/\s+/gu, " ");
    const flatChild = childView.replace(/\s+/gu, " ");
    assert.ok(leadView.includes(`team-lead · run ${leadRun.id}`));
    assert.ok(flatChild.includes(`↳ crafter · run ${childRun.id} · parent ${leadRun.id} (inferred from the only active lead)`));
    assert.match(flatLead, /input 21 · output 5 · reasoning 2 · cache read 3 · cache write 0 · observed component sum 31 · cost \$0\.012/u);
    assert.match(flatChild, /child session total observed.*input 0.*cost \$0/u);
    assert.match(leadView, /\[path\].*\[redacted\].*\[url\]/u);
    assert.doesNotMatch(JSON.stringify(snapshot), /customer|abcdefghijklmnop|internal\.example|assistant-private-evidence|foreign-private-task/u);
    assert.doesNotMatch(`${leadView}\n${childView}`, /foreign-session|foreign-private-task/u);
  } finally { fixture.restore(); }
});

test("OpenCode task and model filters report observed-only incomplete results when active telemetry is unknown", async () => {
  const fixture = await isolatedProject("harbor-opencode-filter-unknown-");
  try {
    const nativeCredential = "sk-privateNativeFilterCredential123456789";
    const unknown = nativeSession(fixture.project, nativeCredential, "Direct", "crafter");
    const { api } = fakeApi({
      directory: fixture.project,
      sessions: [unknown],
      active: { [unknown.id]: { type: "running" } },
      messages: { [unknown.id]: [] },
    });
    const snapshot = await collectOpenCodeTeamSnapshot(api);
    assert.equal(snapshot.activeAuthoritative, true);
    assert.equal(snapshot.runs.length, 1);
    assert.equal(snapshot.runs[0].taskObserved, false);
    assert.equal(snapshot.runs[0].model, undefined);

    for (const [filter, field] of [["task:release", "task"], ["model:private/router", "model"]] as const) {
      const view = formatOpenCodeTeamView(snapshot, filter);
      assert.match(view, field === "task"
        ? /No observed public task label matches/u
        : /No configured roster model or observed active model matches/u);
      assert.match(view, new RegExp(`not a proven no-match: 1 active entry has ${field} telemetry unobserved`, "u"));
      assert.match(view, /filter is\s+incomplete/u);
      assert.match(view, /Action: run \/team with no filter.*retry after host telemetry\s+recovers/su);
      assert.doesNotMatch(view, /No team member or active work matches|No active work matches this filter/u);
      assert.doesNotMatch(view, /privateNativeFilterCredential/u);
      assert.ok(view.split("\n").length <= maximumOpenCodeTeamDialogLines);
      assert.ok(view.split("\n").every((line) => visibleTextWidth(line) <= 96));
    }
    for (const filter of ["task:not disclosed", "not disclosed", "private-model-name"]) {
      const view = formatOpenCodeTeamView(snapshot, filter);
      assert.doesNotMatch(view, new RegExp(snapshot.runs[0].id, "u"),
        `undisclosed telemetry placeholder falsely matched ${filter}`);
      assert.match(view, /not a proven no-match/u);
      assert.match(view, /(?:task|task\/model) telemetry unobserved/u);
      assert.ok(view.split("\n").length <= maximumOpenCodeTeamDialogLines);
      assert.ok(view.split("\n").every((line) => visibleTextWidth(line) <= 96));
    }
    const secretFilter = formatOpenCodeTeamView(snapshot, "task:TOKEN=secret-value-that-must-not-leak");
    assert.match(secretFilter, /task:TOKEN=\[redacted\]/u);
    assert.doesNotMatch(secretFilter, /secret-value-that-must-not-leak/u);

    const observed = {
      ...snapshot.runs[0],
      id: "run-observed-filter-row",
      task: "Release evidence",
      taskObserved: true,
      model: { provider: "local", id: "known" },
    };
    const mixed = { ...snapshot, runs: [observed, snapshot.runs[0]] };
    for (const filter of ["task:release", "model:local/known"]) {
      const view = formatOpenCodeTeamView(mixed, filter);
      assert.match(view, /filter incomplete: 1 active entry has unobserved (?:task|model)/u);
      assert.match(view, /run-observed-filter-row/u);
      assert.doesNotMatch(view, /No active work matches this filter/u);
      assert.ok(view.split("\n").length <= maximumOpenCodeTeamDialogLines);
      assert.ok(view.split("\n").every((line) => visibleTextWidth(line) <= 96));
    }
    const tinyCost = {
      ...observed,
      id: "run-tiny-nonzero-cost",
      usage: { ...observed.usage, cost: 0.00000005 },
    };
    const tinyCostView = formatOpenCodeTeamView({ ...snapshot, runs: [tinyCost] }, `run:${tinyCost.id}`);
    assert.match(tinyCostView, /cost \$5e-8/u);
    assert.doesNotMatch(tinyCostView, /cost \$0\.000000(?:\D|$)/u,
      "a positive observed cost was rendered as zero");
  } finally { fixture.restore(); }
});

test("OpenCode status filters use effective activity while preserving inactive roster states", async () => {
  const fixture = await isolatedProject("harbor-opencode-effective-status-");
  try {
    const direct = nativeSession(fixture.project, "active-crafter", "Direct", "crafter");
    const { api } = fakeApi({
      directory: fixture.project,
      sessions: [direct], active: { [direct.id]: { type: "running" } },
      messages: { [direct.id]: [{ id: "active-boundary", type: "user", text: "Work", time: { created: 1_000 } }] },
    });
    const snapshot = await collectOpenCodeTeamSnapshot(api);
    const ready = formatOpenCodeTeamView(snapshot, "status:ready");
    assert.doesNotMatch(ready, /^● crafter · fixed · working$/mu);
    assert.doesNotMatch(ready, /crafter · run /u);

    const working = formatOpenCodeTeamView(snapshot, "state:working");
    assert.match(working, /crafter · run run-[A-Za-z0-9_-]{20} .* · working/u);
    assert.match(working, /^● crafter · fixed · working$/mu);

    const bench = formatOpenCodeTeamView(snapshot, "status:bench");
    assert.match(bench, /^○ portfolio-management · bundled · bench$/mu);
  } finally { fixture.restore(); }
});

test("OpenCode 30-line team views keep the factory roster complete and bound broad activity", async () => {
  const fixture = await isolatedProject("harbor-opencode-line-budget-");
  try {
    const { api } = fakeApi({ directory: fixture.project });
    const snapshot = await collectOpenCodeTeamSnapshot(api, { now: () => 10_000 });
    const overview = formatOpenCodeTeamView(snapshot);
    assert.ok(overview.split("\n").length <= maximumOpenCodeTeamDialogLines);
    assert.equal(snapshot.members.length, 9);
    for (const member of snapshot.members) {
      assert.match(overview, new RegExp(`^[●○!] ${member.id.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}.* · ${member.kind} · `, "mu"));
    }
    assert.match(overview, /Inspect: \/team member:<id> · \/team run:<run-id>/u);
    assert.match(overview, /Roster: \/bench-list\|on\|off · \/harbor-join\|retire · catalog: \/harbor-list-skills/u);

    const personal = Array.from({ length: 8 }, (_, index) => ({
      id: `worker-${index.toString().padStart(2, "0")}`,
      kind: "personal" as const,
      availability: "ready" as const,
      description: `Worker ${index}`,
      capacity: "read",
      tools: ["read"],
      skills: [],
    }));
    const longProvider = `provider-${"p".repeat(90)}`;
    const longModel = `model-${"m".repeat(150)}`;
    const longVariant = `variant-${"v".repeat(90)}`;
    const runs = personal.map((member, index) => ({
      id: `run-${index.toString().padStart(20, "0")}`,
      agent: member.id,
      kind: "personal" as const,
      rosterState: "ready" as const,
      invocation: "direct" as const,
      state: "working" as const,
      task: `Task ${index}`,
      startedAt: 1_000,
      elapsedMs: 9_000,
      usage: {},
      observedAssistantTurnsLowerBound: false,
      telemetryLowerBound: false,
      ...(index === 0 ? { model: { provider: longProvider, id: longModel, variant: longVariant } } : {}),
    }));
    const crowded = { ...snapshot, members: [...snapshot.members, ...personal], runs };
    const broad = formatOpenCodeTeamView(crowded, "status:working");
    assert.ok(broad.split("\n").length <= maximumOpenCodeTeamDialogLines);
    assert.match(broad, /ACTIVITY · COMPACT/u);
    assert.match(broad, /task\s+“Task 0”/u,
      "the first deterministic activity page omitted what its visible teammate is doing");
    assert.doesNotMatch(broad, /task\s+“Task 1”/u,
      "the first deterministic activity page rendered a partial next row");
    assert.match(broad, /ACTIVITY · COMPACT · rows 1–1 of 8/u);
    assert.match(broad, /Page 1\/8 · next: \/team status:working page:2/u);
    assert.match(broad, /tokens unobserved · cost unobserved/u);
    assert.match(broad, /Inspect: \/team member:<id> · \/team run:<run-id>/u);
    assert.match(broad, /Work: /u);
    assert.match(broad, /Roster:/u);
    assert.match(broad, /Privacy:/u);
    assert.match(broad, /model provider="provider-p+… \(abbreviated\)[\s\S]*Exact model: \/team run:run-0{20}/u,
      "a compact activity row did not mark its bounded model identity or route to exact detail");
    assert.equal(broad.includes(`${longProvider}/${longModel}@${longVariant}`), false,
      "a compact activity row spent the overview budget on a full oversized model identity");
    const shownRosterRows = (broad.match(/^[●○!] worker-\d{2} · personal · working$/gmu) ?? []).length;
    assert.match(broad,
      new RegExp(`ROSTER · COMPACT · rows 1–${shownRosterRows} of ${personal.length} · filtered`, "u"),
      "the compact roster lost its exact row range and total");
    const exact = formatOpenCodeTeamView(crowded, `run:${runs[0].id}`);
    assert.ok(exact.replace(/\s+/gu, "").includes(`provider="${longProvider}"`),
      "the run detail omitted the exact observed provider identity");
    assert.ok(exact.replace(/\s+/gu, "").includes(`model="${longModel}"`),
      "the run detail omitted the exact observed provider/model identity");
    assert.ok(exact.replace(/\s+/gu, "").includes(`variant="${longVariant}"(observed)`),
      "the run detail omitted the exact observed variant");
    assert.ok(exact.split("\n").length <= maximumOpenCodeTeamDialogLines);
    assert.ok(exact.split("\n").every((line) => visibleTextWidth(line) <= 96));
    assert.doesNotMatch(broad, /Task 7/u, "a broad multi-run filter leaked rich rows past its compact budget");
    assert.ok(broad.split("\n").every((line) => visibleTextWidth(line) <= 96));
  } finally { fixture.restore(); }
});

test("OpenCode team view blocks a lead whose enabled specialist roster exceeds the executable limit", async () => {
  const fixture = await isolatedProject("harbor-opencode-lead-roster-cap-");
  try {
    const { api } = fakeApi({ directory: fixture.project });
    const snapshot = await collectOpenCodeTeamSnapshot(api);
    const managersAndUtilities = snapshot.members.filter(({ kind }) => kind === "manager" || kind === "utility");
    const specialists = Array.from({ length: 33 }, (_, index) => ({
      id: `specialist-${index.toString().padStart(2, "0")}`,
      kind: "personal" as const,
      availability: "ready" as const,
      description: `Specialist ${index}`,
      capacity: "read",
      tools: ["read"],
      skills: [],
    }));
    const view = formatOpenCodeTeamView({ ...snapshot, members: [...managersAndUtilities, ...specialists] });
    assert.match(view, /Lead: blocked · 33\/32 enabled specialist limit/u);
    assert.match(view, /disable surplus bundled\/personal members with\s+\/bench-off <id\.\.\.>/u);
    assert.doesNotMatch(view, /Lead: \d+ available/u);
    assert.ok(view.split("\n").length <= maximumOpenCodeTeamDialogLines);
    assert.ok(view.split("\n").every((line) => visibleTextWidth(line) <= 96));
  } finally { fixture.restore(); }
});

test("OpenCode crowded team views preserve exact per-section omission counts under hostile metadata", async () => {
  const fixture = await isolatedProject("harbor-opencode-semantic-budget-");
  try {
    const { api } = fakeApi({ directory: fixture.project });
    const base = await collectOpenCodeTeamSnapshot(api);
    const nonSpecialists = base.members.filter(({ kind }) => kind === "manager" || kind === "utility");
    for (const runCount of [1, 2, 8, 32]) {
      const members = Array.from({ length: runCount }, (_, index) => ({
        id: `stress-${index.toString().padStart(2, "0")}`,
        kind: "personal" as const,
        availability: "ready" as const,
        description: `Stress teammate ${index} ${"界".repeat(80)}`,
        capacity: `read ${"x".repeat(120)}`,
        tools: ["read"],
        skills: [],
      }));
      const runs = members.map((member, index) => ({
        id: `run-stress-${index.toString().padStart(12, "0")}`,
        agent: member.id,
        kind: "personal" as const,
        rosterState: "ready" as const,
        invocation: "direct" as const,
        state: "working" as const,
        task: `Stress task ${index} ${"t".repeat(100)}`,
        startedAt: 1_000,
        elapsedMs: 9_000,
        usage: {},
        observedAssistantTurnsLowerBound: false,
        telemetryLowerBound: false,
        ...(index === 0 ? { model: {
          provider: `provider-${"p".repeat(90)}`,
          id: `model-${"m".repeat(150)}`,
          variant: `variant-${"v".repeat(90)}`,
        } } : {}),
      }));
      const snapshot = {
        ...base,
        members: [...nonSpecialists, ...members],
        runs,
        directAliasCollisions: members.slice(0, 6).map(({ id }) => ({ alias: id, agent: id })),
      };
      const view = formatOpenCodeTeamView(snapshot, "status:working");
      const visibleRuns = (view.match(/^● stress-\d{2} · run /gmu) ?? []).length;
      const visibleMembers = (view.match(/^[●○!] stress-\d{2} · personal · working/gmu) ?? []).length;
      assert.equal(visibleRuns > 0, true, `no useful active row survived for ${runCount} runs`);
      if (visibleRuns < runCount) {
        assert.match(view, new RegExp(`ACTIVITY · COMPACT · rows 1–${visibleRuns} of ${runCount}`, "u"));
        assert.match(view, /Page 1\/\d+ · next:/u);
      }
      if (visibleMembers < runCount) {
        assert.match(view, new RegExp(`ROSTER · COMPACT · rows 1–${visibleMembers} of ${runCount}`, "u"));
      }
      assert.match(view, /Privacy:/u);
      assert.match(view, /Inspect:/u);
      assert.ok(view.split("\n").length <= maximumOpenCodeTeamDialogLines);
      assert.ok(view.split("\n").every((line) => visibleTextWidth(line) <= 96));
    }
  } finally { fixture.restore(); }
});

test("OpenCode degraded roster reads retain all factory IDs and mark known bundled teammates unavailable", async () => {
  const fixture = await isolatedProject("harbor-opencode-degraded-roster-");
  try {
    await mkdir(join(fixture.root, "home", "agent-foundry"), { recursive: true });
    await writeFile(join(fixture.root, "home", "agent-foundry", "bench"), "not-a-directory", "utf8");
    const unproven = nativeSession(fixture.project, "degraded-design", "Direct", "design");
    const { api, messageReads } = fakeApi({
      directory: fixture.project,
      sessions: [unproven],
      active: { [unproven.id]: { type: "running" } },
      messages: { [unproven.id]: [{ type: "user", text: "must-not-be-read", time: { created: 1_000 } }] },
    });
    const snapshot = await collectOpenCodeTeamSnapshot(api);
    const bundled = snapshot.members.filter(({ kind }) => kind === "bundled");
    assert.equal(snapshot.members.length, 9);
    assert.equal(bundled.length, 6);
    assert.ok(bundled.every(({ availability }) => availability === "unavailable"));
    assert.match(snapshot.degradedReasons.join("\n"), /six known bundled teammates are shown as unavailable/u);
    assert.deepEqual(snapshot.runs, []);
    assert.deepEqual(messageReads, [], "an unavailable fallback row authorized direct-session message reads");

    const view = formatOpenCodeTeamView(snapshot);
    for (const id of ["team-lead", "crafter", "talent-scout", "portfolio-management", "design", "build", "manage", "consume", "dispose"]) {
      assert.match(view, new RegExp(`\\b${id}\\b`, "u"));
    }
    assert.match(view, /! portfolio-management · bundled · unavailable/u);
    assert.match(view, /Lead: blocked · teammate availability\/delegability unverified/u);
    assert.ok(view.split("\n").length <= maximumOpenCodeTeamDialogLines);
  } finally { fixture.restore(); }
});

test("OpenCode degraded team views never present exact readiness, idleness, or lead delegability", async () => {
  const fixture = await isolatedProject("harbor-opencode-degraded-truth-");
  try {
    const { api } = fakeApi({ directory: fixture.project });
    const healthy = await collectOpenCodeTeamSnapshot(api);
    const degraded = {
      ...healthy,
      activeAuthoritative: false,
      exactStopAvailable: false,
      degradedReasons: ["OpenCode active-session inventory is unavailable; stop is disabled"],
    };

    const overview = formatOpenCodeTeamView(degraded);
    assert.match(overview, /≥0 visible activity records \(lower bound\) · availability unverified/u);
    assert.match(overview, /Lead: blocked · teammate availability\/delegability unverified/u);
    assert.match(overview, /enabled · activity\/availability unverified/u);
    assert.match(overview, /No verified active work is visible; degraded discovery cannot confirm absence,\s+idleness, or\s+availability/isu);
    assert.doesNotMatch(overview, /\d+ ready\/invocable|Lead: \d+ available|No Agent Harbor teammate is working right now/u);

    const noMatch = formatOpenCodeTeamView(degraded, "member:missing-person");
    assert.match(noMatch, /visible activity is a lower bound · teammate availability unverified/u);
    assert.match(noMatch, /active-session inventory is unavailable/u);
    assert.match(noMatch, /does not prove absence, idleness, readiness, or\s+delegability/u);
    assert.match(noMatch, /Repair: run \/team diagnostics.*then retry this filter/su);
    assert.doesNotMatch(noMatch, /No team member or active work matches/u);
    assert.ok(noMatch.split("\n").length <= maximumOpenCodeTeamDialogLines);
  } finally { fixture.restore(); }
});

test("OpenCode bounded inactive history is a notice, not a degraded readiness claim", async () => {
  const fixture = await isolatedProject("harbor-opencode-bounded-history-");
  try {
    const { api } = fakeApi({ directory: fixture.project });
    const healthy = await collectOpenCodeTeamSnapshot(api);
    const view = formatOpenCodeTeamView({ ...healthy, sessionListTruncated: true });
    assert.match(view, /0 model tokens · bounded history/u);
    assert.match(view, /i Session history was bounded/u);
    assert.doesNotMatch(view.split("\n")[0], /degraded/u);
    assert.match(view, /\d+ ready\/invocable/u);
  } finally { fixture.restore(); }
});

test("OpenCode diagnostics paginate all sanitized reasons and repair steps without control or secret overflow", async () => {
  const fixture = await isolatedProject("harbor-opencode-diagnostics-");
  try {
    const { api } = fakeApi({ directory: fixture.project });
    const healthy = await collectOpenCodeTeamSnapshot(api);
    const credential = "postgres://admin:private-diagnostic-password@db.example/hidden";
    const degraded = {
      ...healthy,
      activeAuthoritative: false,
      exactStopAvailable: false,
      degradedReasons: [
        "OpenCode session inventory timed out",
        "OpenCode active-session inventory is unavailable; stop is disabled",
        "roster inventory unavailable; bundled definitions cannot be verified",
        "message telemetry is unavailable for one visible run",
        `DATABASE_URL=${credential} \u001b[31m${"界".repeat(2_000)}\u001b[0m`,
      ],
    };
    const first = formatOpenCodeTeamDiagnostics(degraded);
    const pageCount = Number(/Page 1\/(\d+)/u.exec(first)?.[1] ?? "1");
    assert.ok(pageCount >= 1 && pageCount <= 10);
    const pages = Array.from({ length: pageCount }, (_, index) =>
      formatOpenCodeTeamDiagnostics(degraded, index + 1));
    const combined = pages.join("\n");
    for (const expected of [
      "session inventory timed out",
      "active-session inventory is unavailable",
      "roster inventory unavailable",
      "message telemetry is unavailable",
    ]) assert.match(combined, new RegExp(expected, "u"));
    assert.equal((combined.match(/\d+\. Reason:/gu) ?? []).length, degraded.degradedReasons.length);
    assert.equal((combined.match(/Repair:/gu) ?? []).length, degraded.degradedReasons.length);
    assert.match(combined, /DATABASE_URL=\[redacted\]/u);
    assert.doesNotMatch(combined, /private-diagnostic-password|db\.example|\u001b|\x1b/u);
    for (const page of pages) {
      assert.ok(page.split("\n").length <= maximumOpenCodeTeamDialogLines);
      assert.ok(page.length < 24_000);
      assert.ok(page.split("\n").every((line) => visibleTextWidth(line) <= 96));
    }
  } finally { fixture.restore(); }
});

test("OpenCode /team diagnostics reads live degraded reasons instead of treating diagnostics as a filter", async () => {
  const fixture = await isolatedProject("harbor-opencode-diagnostics-route-");
  try {
    const fake = fakeApi({
      directory: fixture.project,
      hangList: true,
      hangActive: true,
      hangLegacyStatus: true,
    });
    await runOpenCodeTeamQuery(fake.api, "diagnostics", { rpcDeadlineMs: 10, collectionDeadlineMs: 80 });
    assert.equal(fake.dialogs.length, 1);
    assert.match(fake.dialogs[0].title, /team diagnostics/u);
    assert.match(fake.dialogs[0].message, /session inventory timed out/u);
    assert.match(fake.dialogs[0].message, /active-session inventory timed out/u);
    assert.match(fake.dialogs[0].message, /legacy session-status inventory timed out/u);
    assert.match(fake.dialogs[0].message, /Repair:/u);
    assert.doesNotMatch(fake.dialogs[0].message, /No team member or active work matches “diagnostics”/u);
  } finally { fixture.restore(); }
});

test("OpenCode signed titles are ID/project-bound, tamper-evident, and collision-safe on concurrent first use", async () => {
  const fixture = await isolatedProject("harbor-opencode-claims-");
  try {
    const home = join(fixture.root, "home");
    const signers = await Promise.all(Array.from({ length: 32 }, () =>
      prepareSignedOpenCodeHarborTitle(home, fixture.project, "agent", "crafter")));
    const titles = signers.map((sign, index) => sign(`session-${index}`));
    assert.equal(new Set(titles).size, titles.length, "title nonces collided");
    assert.deepEqual(
      await verifySignedOpenCodeHarborTitle(home, fixture.project, titles[0], "session-0"),
      { invocation: "agent", agent: "crafter" },
    );
    assert.equal(await verifySignedOpenCodeHarborTitle(home, fixture.project, titles[0], "session-copy"), undefined,
      "a valid title replayed onto another native ID retained ownership");
    assert.equal(await verifySignedOpenCodeHarborTitle(home, join(fixture.root, "other"), titles[0], "session-0"), undefined,
      "a signed title crossed project scope");
    const tampered = titles[0].replace(/.$/u, (value) => value === "A" ? "B" : "A");
    assert.equal(await verifySignedOpenCodeHarborTitle(home, fixture.project, tampered, "session-0"), undefined);
  } finally { fixture.restore(); }
});

test("OpenCode title-key publication ignores partial temp debris and never overwrites a malformed canonical key", async () => {
  const fixture = await isolatedProject("harbor-opencode-key-publication-");
  try {
    const home = join(fixture.root, "atomic-home");
    const directory = join(home, "agent-foundry");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "opencode-title-key-v1.tmp-crashed-writer"), Buffer.alloc(7, 1), { mode: 0o600 });
    const sign = await prepareSignedOpenCodeHarborTitle(home, fixture.project, "agent", "crafter");
    const title = sign("atomic-child");
    assert.equal((await stat(join(directory, "opencode-title-key-v1"))).size, 32);
    assert.deepEqual(await verifySignedOpenCodeHarborTitle(home, fixture.project, title, "atomic-child"), {
      invocation: "agent", agent: "crafter",
    });

    const badHome = join(fixture.root, "malformed-home");
    const badDirectory = join(badHome, "agent-foundry");
    const badKey = join(badDirectory, "opencode-title-key-v1");
    await mkdir(badDirectory, { recursive: true });
    await writeFile(badKey, Buffer.from("do-not-overwrite"), { mode: 0o600 });
    const before = await readFile(badKey);
    await assert.rejects(
      () => prepareSignedOpenCodeHarborTitle(badHome, fixture.project, "agent", "crafter"),
      /invalid OpenCode title-key file/u,
    );
    assert.deepEqual(await readFile(badKey), before);
  } finally { fixture.restore(); }
});

test("OpenCode child provenance update timeout deletes the unclaimed child before any prompt", async () => {
  const fixture = await isolatedProject("harbor-opencode-claim-timeout-");
  try {
    const deleted: string[] = [];
    let prompts = 0;
    const client: any = { session: {
      create: async () => ({ data: { id: "unclaimed-child" } }),
      update: ({ signal }: any) => new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => setTimeout(() => reject(new Error("host update observed abort")), 5), { once: true });
      }),
      delete: async ({ path }: any) => { deleted.push(path.id); return { data: true }; },
      prompt: async () => { prompts += 1; return { data: { parts: [{ type: "text", text: "unexpected" }] } }; },
    } };
    const orchestrator = new OpenCodeOrchestrator(client, fixture.project, undefined, undefined, 15, join(fixture.root, "home"));
    await assert.rejects(
      () => orchestrator.runAgent("crafter", "Work", undefined, { providerID: "openai", modelID: "gpt" }),
      /child provenance timed out/u,
    );
    assert.deepEqual(deleted, ["unclaimed-child"]);
    assert.equal(prompts, 0);
  } finally { fixture.restore(); }
});

test("OpenCode reconciles and deletes a child whose create response arrives after its deadline", async () => {
  const fixture = await isolatedProject("harbor-opencode-late-create-");
  try {
    const deleted: string[] = [];
    let updates = 0;
    let prompts = 0;
    const client: any = { session: {
      create: () => new Promise((resolve) => setTimeout(() => resolve({ data: { id: "late-child" } }), 30)),
      update: async () => { updates += 1; return { data: {} }; },
      delete: async ({ path }: any) => { deleted.push(path.id); return { data: true }; },
      prompt: async () => { prompts += 1; return { data: { parts: [] } }; },
    } };
    const orchestrator = new OpenCodeOrchestrator(client, fixture.project, undefined, undefined, 10, join(fixture.root, "home"));
    await assert.rejects(
      () => orchestrator.runAgent("crafter", "Work", undefined, { providerID: "openai", modelID: "gpt" }),
      /child creation timed out/u,
    );
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.deepEqual(deleted, ["late-child"]);
    assert.equal(updates, 0);
    assert.equal(prompts, 0);
  } finally { fixture.restore(); }
});

test("OpenCode malformed create IDs reconcile only safe strings and otherwise block later creates", async () => {
  const unknownFixture = await isolatedProject("harbor-opencode-malformed-id-unknown-");
  try {
    let creates = 0;
    let deletes = 0;
    let coercions = 0;
    const malformed = Object.defineProperty({}, Symbol.toPrimitive, {
      value: () => { coercions += 1; throw new Error("must not coerce malformed ID"); },
    });
    const orchestrator = new OpenCodeOrchestrator({ session: {
      create: async () => { creates += 1; return { data: { id: malformed } }; },
      update: async () => { throw new Error("unexpected provenance update"); },
      prompt: async () => { throw new Error("unexpected prompt"); },
      delete: async () => { deletes += 1; return { data: true }; },
    } } as any, unknownFixture.project, undefined, undefined, 25, join(unknownFixture.root, "home"));
    await assert.rejects(
      () => orchestrator.runAgent("crafter", "First", undefined, { providerID: "openai", modelID: "gpt" }),
      /invalid bounded child session ID/u,
    );
    await assert.rejects(
      () => orchestrator.runAgent("crafter", "Second", undefined, { providerID: "openai", modelID: "gpt" }),
      /cleanup is unreconciled/u,
    );
    assert.equal(creates, 1);
    assert.equal(deletes, 0);
    assert.equal(coercions, 0);
  } finally { unknownFixture.restore(); }

  const oversizedFixture = await isolatedProject("harbor-opencode-malformed-id-oversized-");
  try {
    const oversized = "x".repeat(513);
    let creates = 0;
    const deleted: string[] = [];
    const orchestrator = new OpenCodeOrchestrator({ session: {
      create: async () => ({ data: { id: ++creates === 1 ? oversized : "valid-child" } }),
      update: async ({ path, body }: any) => ({ data: { id: path.id, title: body.title } }),
      prompt: async () => ({ data: { parts: [{ type: "text", text: "verified after reconciliation" }] } }),
      delete: async ({ path }: any) => { deleted.push(path.id); return { data: true }; },
    } } as any, oversizedFixture.project, undefined, undefined, 25, join(oversizedFixture.root, "home"));
    await assert.rejects(
      () => orchestrator.runAgent("crafter", "First", undefined, { providerID: "openai", modelID: "gpt" }),
      /invalid bounded child session ID/u,
    );
    assert.equal(
      await orchestrator.runAgent("crafter", "Second", undefined, { providerID: "openai", modelID: "gpt" }),
      "verified after reconciliation",
    );
    assert.deepEqual(deleted, [oversized, "valid-child"]);
  } finally { oversizedFixture.restore(); }
});

test("OpenCode response evidence caps part iteration and huge text before serialization", async () => {
  const fixture = await isolatedProject("harbor-opencode-bounded-parts-");
  try {
    const huge = `first:${"x".repeat(2_000_000)}:unretained-tail`;
    const parts = Array.from({ length: 20_000 }, () => ({ type: "text", text: huge }));
    let deletes = 0;
    const orchestrator = new OpenCodeOrchestrator({ session: {
      create: async () => ({ data: { id: "bounded-parts-child" } }),
      update: async ({ path, body }: any) => ({ data: { id: path.id, title: body.title } }),
      prompt: async () => ({ data: { parts } }),
      delete: async () => { deletes += 1; return { data: true }; },
    } } as any, fixture.project, undefined, undefined, 25, join(fixture.root, "home"));
    const started = performance.now();
    const output = await orchestrator.runAgent(
      "crafter", "Bound response", undefined, { providerID: "openai", modelID: "gpt" },
    );
    assert.ok(Buffer.byteLength(output, "utf8") <= 30_000);
    assert.match(output, /^first:/u);
    assert.match(output, /\[HARBOR-EVIDENCE-TRUNCATED observed_utf8_bytes_at_least=\d+ omitted_segments_at_least=\d+ limit=30000\]$/u);
    assert.doesNotMatch(output, /unretained-tail/u);
    assert.ok(performance.now() - started < 1_500, "OpenCode response collection scanned all huge parts");
    assert.equal(deletes, 1);
  } finally { fixture.restore(); }
});

test("OpenCode ignores unsigned, tampered, and replayed Harbor-looking titles without reading foreign messages", async () => {
  const fixture = await isolatedProject("harbor-opencode-spoof-");
  try {
    const sign = await prepareSignedOpenCodeHarborTitle(join(fixture.root, "home"), fixture.project, "agent", "design");
    const validTitle = sign("real-child");
    const real = nativeSession(fixture.project, "real-child", validTitle, "design");
    const replay = nativeSession(fixture.project, "copied-child", validTitle, "crafter");
    const spoof = nativeSession(fixture.project, "spoofed-contract", "Harbor contract: spoofed", "crafter");
    const tampered = nativeSession(fixture.project, "tampered-child", `${validTitle.slice(0, -1)}A`, "crafter");
    const { api, messageReads, interrupts } = fakeApi({
      directory: fixture.project,
      sessions: [real, replay, spoof, tampered],
      active: Object.fromEntries([real, replay, spoof, tampered].map(({ id }) => [id, { type: "running" }])),
      messages: {
        "real-child": [{ type: "user", text: "Real Harbor work", time: { created: 1_000 } }],
        "copied-child": [{ type: "user", text: "foreign replay secret", time: { created: 1_000 } }],
        "spoofed-contract": [{ type: "user", text: "foreign spoof secret", time: { created: 1_000 } }],
        "tampered-child": [{ type: "user", text: "foreign tamper secret", time: { created: 1_000 } }],
      },
    });
    const snapshot = await collectOpenCodeTeamSnapshot(api, { now: () => 3_000 });
    assert.deepEqual(snapshot.runs.map(({ rosterState }) => rosterState), ["bench"],
      "an active signed child disappeared after its member was benched");
    assert.deepEqual(messageReads, ["real-child"], "foreign session messages were inspected before ownership proof");
    assert.match(snapshot.degradedReasons.join("\n"), /unsigned or tampered/u);
    const result = await stopOpenCodeTeamRuns(api, "all");
    assert.deepEqual(result.stopped, [snapshot.runs[0].id]);
    assert.deepEqual(interrupts, ["real-child"]);
  } finally { fixture.restore(); }
});

test("OpenCode silently omits valid global-active sessions from another project", async () => {
  const fixture = await isolatedProject("harbor-opencode-foreign-project-");
  try {
    const own = nativeSession(fixture.project, "own-session", "Own work", "crafter");
    const foreign = nativeSession(join(fixture.root, "another-project"), "foreign-session", "Foreign work", "design");
    const { api, messageReads } = fakeApi({
      directory: fixture.project,
      sessions: [own],
      active: { [own.id]: { type: "running" }, [foreign.id]: { type: "running" } },
      getSession: (id) => id === foreign.id ? foreign : own,
      messages: { [own.id]: [{ type: "user", text: "Own task", time: { created: 1_000 } }] },
    });
    const snapshot = await collectOpenCodeTeamSnapshot(api);
    assert.deepEqual(snapshot.runs.map(({ agent }) => agent), ["crafter"]);
    assert.equal(snapshot.activeAuthoritative, true);
    assert.doesNotMatch(snapshot.degradedReasons.join("\n"), /could not be inspected|project scope/u);
    assert.deepEqual(messageReads, [own.id]);
  } finally { fixture.restore(); }
});

test("OpenCode config collisions fail closed in /team and the process-local bridge is bounded and repairable", async () => {
  const fixture = await isolatedProject("harbor-opencode-config-conflict-");
  try {
    await runDeterministicCommand("opencode", "join", JSON.stringify({
      name: "reviewer", description: "Review", prompt: "Work", tools: ["read"],
    }), fixture.project);
    const direct = nativeSession(fixture.project, "conflicted-direct", "Direct", "reviewer");
    recordOpenCodeAgentConflicts(fixture.project, ["reviewer"]);
    const conflicted = fakeApi({
      directory: fixture.project,
      loadedAgents: ["reviewer"],
      sessions: [direct], active: { [direct.id]: { type: "running" } },
      messages: { [direct.id]: [{ id: "conflict-boundary", type: "user", text: "Private", time: { created: 1_000 } }] },
    });
    const blocked = await collectOpenCodeTeamSnapshot(conflicted.api);
    assert.equal(blocked.members.find(({ id }) => id === "reviewer")?.availability, "conflict");
    assert.deepEqual(blocked.runs, []);
    assert.deepEqual(conflicted.messageReads, [], "collision-owned session messages were read before ownership repair");

    const many = Array.from({ length: 300 }, (_, index) => `member-${index}`);
    recordOpenCodeAgentConflicts(fixture.project, many);
    const bounded = readOpenCodeAgentConflicts(fixture.project);
    assert.equal(bounded.size, 256);
    (bounded as Set<string>).clear();
    assert.equal(readOpenCodeAgentConflicts(fixture.project).size, 256, "callers mutated the stored conflict registry");

    recordOpenCodeAgentConflicts(fixture.project, []);
    const repaired = await collectOpenCodeTeamSnapshot(conflicted.api);
    assert.equal(repaired.members.find(({ id }) => id === "reviewer")?.availability, "ready");
    assert.equal(repaired.runs[0]?.agent, "reviewer");
  } finally {
    recordOpenCodeAgentConflicts(fixture.project, []);
    fixture.restore();
  }
});

test("OpenCode exposes direct-alias collisions without disabling native or lead invocation", async () => {
  const fixture = await isolatedProject("harbor-opencode-alias-conflict-");
  try {
    recordOpenCodeDirectAliasCollisions(fixture.project, [{ alias: "crafter", agent: "crafter" }]);
    const firstRead = readOpenCodeDirectAliasCollisions(fixture.project);
    assert.deepEqual(firstRead, [{ alias: "crafter", agent: "crafter" }]);
    (firstRead as Array<{ alias: string; agent: string }>)[0].alias = "mutated";
    assert.deepEqual(readOpenCodeDirectAliasCollisions(fixture.project), [{ alias: "crafter", agent: "crafter" }]);

    const { api, dialogs } = fakeApi({ directory: fixture.project });
    const snapshot = await collectOpenCodeTeamSnapshot(api);
    assert.deepEqual(snapshot.directAliasCollisions, [{ alias: "crafter", agent: "crafter" }]);
    assert.equal(snapshot.members.find(({ id }) => id === "crafter")?.availability, "ready",
      "a foreign slash alias incorrectly disabled the independently owned native agent");

    const overview = formatOpenCodeTeamView(snapshot);
    const detail = formatOpenCodeTeamView(snapshot, "member:crafter");
    for (const view of [overview, detail]) {
      assert.match(view, /\/crafter.*(?:alias|Alias).*unavailable|Alias \/crafter: unavailable/iu);
      assert.match(view, /foreign command/u);
      assert.match(view, /do not invoke (?:it|them|those aliases|the listed aliases) as Agent Harbor/iu);
      assert.ok(view.split("\n").length <= maximumOpenCodeTeamDialogLines);
      assert.ok(view.split("\n").every((line) => visibleTextWidth(line) <= 96));
    }
    assert.match(overview, /use native selection or team-lead instead/u);
    assert.match(detail, /Native agent selection remains available/u);
    assert.match(detail, /team-lead can delegate this specialist/u);
    assert.doesNotMatch(overview, /Work: \/<id> <task>/u,
      "the footer recommended an alias pattern without acknowledging the known foreign command");
    assert.match(overview, /Work: native agent selector · uncollided \/<id> aliases/u);
    assert.match(detail, /Repair: rename or remove the foreign \/crafter command, then reload OpenCode/u);

    await runOpenCodeTeamQuery(api, "help");
    const collisionHelp = formatOpenCodeTeamHelp(snapshot.directAliasCollisions);
    assert.match(dialogs.at(-1).message, /Do not invoke foreign Harbor aliases/u,
      "the static no-RPC help path ignored the config-hook alias bridge");
    assert.match(collisionHelp, /Do not invoke foreign Harbor aliases/u);
    assert.match(collisionHelp, /only aliases marked available by\s+\/team/u);
    assert.doesNotMatch(collisionHelp, /A ready · invocable teammate can run with \/<id>/u);
    assert.match(collisionHelp, /Privacy:/u,
      "the collision-expanded help clipped its mandatory privacy disclosure");
    assert.doesNotMatch(collisionHelp, /narrow with \/team member:<id>/u,
      "static help used the generic team-view clipping advice");
    assert.ok(collisionHelp.split("\n").length <= maximumOpenCodeTeamDialogLines);
    assert.ok(collisionHelp.split("\n").every((line) => visibleTextWidth(line) <= 96));

    const personal = {
      name: "alias-reviewer",
      description: "Review",
      prompt: "Review only the assigned evidence.",
      tools: ["read"],
    };
    await runDeterministicCommand("opencode", "join", JSON.stringify(personal), fixture.project);
    recordOpenCodeDirectAliasCollisions(fixture.project, [
      { alias: personal.name, agent: personal.name },
    ]);
    const loaded = fakeApi({ directory: fixture.project, loadedAgents: [personal.name] });
    const commands = openCodeDirectCommands(loaded.api);

    const join = commands.find(({ slashName }) => slashName === "harbor-join")!;
    join.run();
    await loaded.dialogs.at(-1).onConfirm(JSON.stringify(personal));
    assert.match(loaded.dialogs.at(-1).message,
      /Run now: select alias-reviewer natively; foreign \/alias-reviewer is unavailable/u);
    assert.doesNotMatch(loaded.dialogs.at(-1).message, /Run now: \/alias-reviewer/u);

    const benchOn = commands.find(({ slashName }) => slashName === "bench-on")!;
    benchOn.run();
    await loaded.dialogs.at(-1).onConfirm(personal.name);
    assert.match(loaded.dialogs.at(-1).message, /native alias-reviewer is ready/u);
    assert.match(loaded.dialogs.at(-1).message, /Do\s+not invoke it as Harbor/u);
    assert.doesNotMatch(loaded.dialogs.at(-1).message, /ready now · \/alias-reviewer/u);

    const benchOff = commands.find(({ slashName }) => slashName === "bench-off")!;
    benchOff.run();
    await loaded.dialogs.at(-1).onConfirm(personal.name);
    assert.match(loaded.dialogs.at(-1).message, /Foreign \/alias-reviewer\s+remains\s+unmanaged/u);
    assert.doesNotMatch(loaded.dialogs.at(-1).message, /removes it from native selection and \/alias-reviewer autocomplete/u);

    const retire = commands.find(({ slashName }) => slashName === "harbor-retire")!;
    retire.run();
    await loaded.dialogs.at(-1).onConfirm(personal.name);
    assert.match(loaded.dialogs.at(-1).message, /Foreign \/alias-reviewer\s+remains\s+unmanaged/u);
    assert.doesNotMatch(loaded.dialogs.at(-1).message, /remove its stale native agent and \/alias-reviewer alias/u);

    recordOpenCodeDirectAliasCollisions(fixture.project, []);
    const repaired = await collectOpenCodeTeamSnapshot(api);
    assert.deepEqual(repaired.directAliasCollisions, []);
    assert.doesNotMatch(formatOpenCodeTeamView(repaired, "member:crafter"), /foreign command/u);
  } finally {
    recordOpenCodeDirectAliasCollisions(fixture.project, []);
    fixture.restore();
  }
});

test("OpenCode distinguishes explicit zero child telemetry from absent telemetry", async () => {
  const fixture = await isolatedProject("harbor-opencode-zero-telemetry-");
  try {
    const signZero = await prepareSignedOpenCodeHarborTitle(join(fixture.root, "home"), fixture.project, "agent", "crafter");
    const signAbsent = await prepareSignedOpenCodeHarborTitle(join(fixture.root, "home"), fixture.project, "agent", "design");
    const zero = nativeSession(fixture.project, "zero-child", signZero("zero-child"), "crafter");
    const absent = nativeSession(fixture.project, "absent-child", signAbsent("absent-child"), "design");
    delete absent.cost;
    delete absent.tokens;
    const { api } = fakeApi({
      directory: fixture.project,
      sessions: [zero, absent],
      active: { [zero.id]: { type: "running" }, [absent.id]: { type: "running" } },
      messages: {
        [zero.id]: [{ type: "user", text: "Zero", time: { created: 1_000 } }],
        [absent.id]: [{ type: "user", text: "Absent", time: { created: 1_000 } }],
      },
    });
    const snapshot = await collectOpenCodeTeamSnapshot(api);
    const byAgent = new Map(snapshot.runs.map((run) => [run.agent, run]));
    assert.deepEqual(byAgent.get("crafter")?.usage, {
      input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0,
    });
    assert.deepEqual(byAgent.get("design")?.usage, {});
  } finally { fixture.restore(); }
});

test("OpenCode direct telemetry and elapsed time cover only the current turn in a reused TUI session", async () => {
  const fixture = await isolatedProject("harbor-opencode-direct-turn-");
  try {
    const now = 86_400_000;
    const direct = nativeSession(fixture.project, "reused-direct", "Old TUI", "crafter");
    direct.time = { created: 0, updated: now };
    direct.tokens = { input: 10_000, output: 2_000, reasoning: 500, cache: { read: 900, write: 10 } };
    direct.cost = 42;
    const { api } = fakeApi({
      directory: fixture.project,
      sessions: [direct], active: { [direct.id]: { type: "running" } },
      messages: { [direct.id]: [
        {
          type: "assistant", agent: "crafter", model: { providerID: "openai", id: "current" },
          tokens: { input: 7, output: 2, reasoning: 1, cache: { read: 0, write: 0 } }, cost: 0.01,
          time: { created: now - 100 },
        },
        { type: "user", text: "Current turn", time: { created: now - 1_000 } },
        {
          type: "assistant", agent: "general", model: { providerID: "foreign", id: "old" },
          tokens: { input: 9_999, output: 999, reasoning: 99, cache: { read: 99, write: 9 } }, cost: 40,
          time: { created: 10_000 },
        },
      ] },
    });
    const snapshot = await collectOpenCodeTeamSnapshot(api, { now: () => now });
    const run = snapshot.runs[0];
    assert.equal(run.elapsedMs, 1_000);
    assert.equal(run.usageScope, "current-turn");
    assert.deepEqual(run.usage, { input: 7, output: 2, reasoning: 1, cacheRead: 0, cacheWrite: 0, total: 10, cost: 0.01 });
    assert.deepEqual(run.model, { provider: "openai", id: "current" });
    const view = formatOpenCodeTeamView(snapshot, "member:crafter").replace(/\s+/gu, " ");
    assert.match(view, /current turn observed .* input 7 .* cost \$0\.01/u);
    assert.doesNotMatch(view, /10,000|\$42|foreign\/old/u);
  } finally { fixture.restore(); }
});

test("OpenCode prefers native assistant totals and labels zero, partial, and contradictory telemetry honestly", async () => {
  const fixture = await isolatedProject("harbor-opencode-native-total-");
  try {
    const exact = nativeSession(fixture.project, "native-total-exact", "Exact", "crafter");
    const zero = nativeSession(fixture.project, "native-total-zero", "Zero", "crafter");
    const partial = nativeSession(fixture.project, "native-total-partial", "Partial", "crafter");
    const conflict = nativeSession(fixture.project, "native-total-conflict", "Conflict", "crafter");
    const sessions = [exact, zero, partial, conflict];
    const { api } = fakeApi({
      directory: fixture.project,
      sessions,
      active: Object.fromEntries(sessions.map(({ id }) => [id, { type: "running" }])),
      messages: {
        [exact.id]: [
          {
            type: "assistant", agent: "crafter", model: { providerID: "openai", id: "exact" },
            tokens: { total: 10, input: 5, output: 3, reasoning: 2, cache: { read: 0, write: 0 } }, cost: 0.01,
            time: { created: 3_000 },
          },
          { type: "user", text: "Exact native", time: { created: 2_000 } },
        ],
        [zero.id]: [
          {
            type: "assistant", agent: "crafter",
            tokens: { total: 0, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0,
            time: { created: 3_000 },
          },
          { type: "user", text: "Exact zero", time: { created: 2_000 } },
        ],
        [partial.id]: [
          {
            type: "assistant", agent: "crafter",
            tokens: { total: 5, input: 0, output: 5, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0,
            time: { created: 4_000 },
          },
          {
            type: "assistant", agent: "crafter",
            tokens: { input: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: 3_000 },
          },
          { type: "user", text: "Partial fields", time: { created: 2_000 } },
        ],
        [conflict.id]: [
          {
            type: "assistant", agent: "crafter",
            tokens: { total: 7, input: 5, output: 3, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: 3_000 },
          },
          { type: "user", text: "Conflicting total", time: { created: 2_000 } },
        ],
      },
    });
    const snapshot = await collectOpenCodeTeamSnapshot(api);
    const byTask = new Map(snapshot.runs.map((run) => [run.task, run]));
    const exactRun = byTask.get("Exact native")!;
    const zeroRun = byTask.get("Exact zero")!;
    const partialRun = byTask.get("Partial fields")!;
    const conflictRun = byTask.get("Conflicting total")!;

    assert.equal(exactRun.usage.total, 10);
    assert.equal(exactRun.usageTotalSource, "native");
    assert.equal(exactRun.usageTotalLowerBound, undefined);
    assert.equal(exactRun.usageTotalConflict, undefined);
    assert.equal(zeroRun.usage.total, 0, "an explicit native zero was treated as absent");
    assert.equal(zeroRun.usageTotalSource, "native");
    assert.deepEqual(new Set(partialRun.usageLowerBounds), new Set(["output", "total", "cost"]));
    assert.equal(partialRun.usageLowerBounds?.includes("input"), false,
      "an explicit zero on every assistant turn was treated as an omitted field");
    assert.equal(partialRun.usageTotalSource, "mixed");
    assert.equal(partialRun.usageTotalLowerBound, true);
    assert.equal(conflictRun.usageTotalConflict, true);

    assert.match(formatOpenCodeTeamView(snapshot, `run:${exactRun.id}`), /native total 10/u);
    assert.match(formatOpenCodeTeamView(snapshot, `run:${zeroRun.id}`), /native total 0/u);
    assert.match(formatOpenCodeTeamView(snapshot, `run:${partialRun.id}`).replace(/\s+/gu, " "),
      /output ≥5.*combined native\/component total ≥5 \(partial\).*cost ≥\$0/u);
    assert.match(formatOpenCodeTeamView(snapshot, `run:${conflictRun.id}`),
      /native total 7 \(component conflict\)/u);
  } finally { fixture.restore(); }
});

test("OpenCode preserves native session aggregate totals and keeps component-only aggregates partial", async () => {
  const fixture = await isolatedProject("harbor-opencode-session-total-");
  try {
    const sign = await prepareSignedOpenCodeHarborTitle(
      join(fixture.root, "home"), fixture.project, "agent", "crafter",
    );
    const onlyTotal = nativeSession(
      fixture.project, "session-total-only", sign("session-total-only"), "crafter",
    );
    const exact = nativeSession(
      fixture.project, "session-total-exact", sign("session-total-exact"), "crafter",
    );
    const conflict = nativeSession(
      fixture.project, "session-total-conflict", sign("session-total-conflict"), "crafter",
    );
    const partial = nativeSession(
      fixture.project, "session-components-partial", sign("session-components-partial"), "crafter",
    );
    const nativePartial = nativeSession(
      fixture.project, "session-total-native-partial", sign("session-total-native-partial"), "crafter",
    );
    onlyTotal.tokens = { total: 13 };
    exact.tokens = { total: 10, input: 5, output: 3, reasoning: 2, cache: { read: 0, write: 0 } };
    conflict.tokens = { total: 7, input: 5, output: 3, reasoning: 0, cache: { read: 0, write: 0 } };
    partial.tokens = { input: 2, cache: { read: 1 } };
    nativePartial.tokens = { total: 9, input: 5 };
    for (const session of [onlyTotal, exact, conflict, partial, nativePartial]) delete session.cost;
    const sessions = [onlyTotal, exact, conflict, partial, nativePartial];
    const tasks = new Map([
      [onlyTotal.id, "Only native total"],
      [exact.id, "Exact native aggregate"],
      [conflict.id, "Conflicting native aggregate"],
      [partial.id, "Partial component aggregate"],
      [nativePartial.id, "Native total with partial components"],
    ]);
    const { api } = fakeApi({
      directory: fixture.project,
      sessions,
      active: Object.fromEntries(sessions.map(({ id }) => [id, { type: "running" }])),
      messages: Object.fromEntries(sessions.map(({ id }) => [id, [
        { type: "user", text: tasks.get(id), time: { created: 2_000 } },
      ]])),
    });

    const snapshot = await collectOpenCodeTeamSnapshot(api);
    const byTask = new Map(snapshot.runs.map((run) => [run.task, run]));
    const onlyTotalRun = byTask.get("Only native total")!;
    const exactRun = byTask.get("Exact native aggregate")!;
    const conflictRun = byTask.get("Conflicting native aggregate")!;
    const partialRun = byTask.get("Partial component aggregate")!;
    const nativePartialRun = byTask.get("Native total with partial components")!;

    assert.deepEqual(onlyTotalRun.usage, { total: 13 });
    assert.equal(onlyTotalRun.usageTotalSource, "native");
    assert.equal(onlyTotalRun.usageTotalLowerBound, undefined);
    assert.equal(onlyTotalRun.usageTotalConflict, undefined);
    assert.deepEqual(exactRun.usage, {
      input: 5, output: 3, reasoning: 2, cacheRead: 0, cacheWrite: 0, total: 10,
    });
    assert.equal(exactRun.usageTotalSource, "native");
    assert.equal(exactRun.usageTotalLowerBound, undefined);
    assert.equal(exactRun.usageTotalConflict, undefined);
    assert.equal(conflictRun.usage.total, 7);
    assert.equal(conflictRun.usageTotalSource, "native");
    assert.equal(conflictRun.usageTotalConflict, true);
    assert.deepEqual(partialRun.usage, { input: 2, cacheRead: 1, total: 3 });
    assert.equal(partialRun.usageTotalSource, "observed-components");
    assert.equal(partialRun.usageTotalLowerBound, true);
    assert.deepEqual(nativePartialRun.usage, { input: 5, total: 9 });
    assert.equal(nativePartialRun.usageTotalSource, "native");
    assert.equal(nativePartialRun.usageTotalLowerBound, undefined);
    assert.equal(nativePartialRun.usageTotalConflict, undefined);
  } finally { fixture.restore(); }
});

test("OpenCode never attributes a stale session model to a reused direct turn", async () => {
  const fixture = await isolatedProject("harbor-opencode-stale-direct-model-");
  try {
    const direct = nativeSession(fixture.project, "stale-direct-model", "Reused", "crafter");
    direct.model = { providerID: "legacy", id: "stale-session-model" };
    const { api } = fakeApi({
      directory: fixture.project,
      sessions: [direct], active: { [direct.id]: { type: "running" } },
      messages: { [direct.id]: [
        {
          type: "assistant", agent: "crafter",
          tokens: { total: 1, input: 1, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 3_000 },
        },
        { type: "user", text: "No current model", time: { created: 2_000 } },
      ] },
    });
    const snapshot = await collectOpenCodeTeamSnapshot(api);
    assert.equal(snapshot.runs[0].model, undefined);
    const view = formatOpenCodeTeamView(snapshot, `run:${snapshot.runs[0].id}`);
    assert.match(view, /model unobserved/u);
    assert.doesNotMatch(view, /stale-session-model/u);
  } finally { fixture.restore(); }
});

test("OpenCode team stop never aborts an active foreign session and rechecks Harbor ownership", async () => {
  const fixture = await isolatedProject("harbor-opencode-stop-");
  try {
    const harbor = nativeSession(fixture.project, "harbor-active-abcdef", "Direct Harbor work", "crafter");
    const foreign = nativeSession(fixture.project, "foreign-active-abcdef", "Foreign work", "general");
    const { api, interrupts } = fakeApi({
      directory: fixture.project,
      sessions: [harbor, foreign],
      active: { "harbor-active-abcdef": { type: "running" }, "foreign-active-abcdef": { type: "running" } },
      messages: {
        "harbor-active-abcdef": [{ type: "user", text: "Work", time: { created: 1_000 } }],
        "foreign-active-abcdef": [{ type: "user", text: "Do not touch", time: { created: 1_000 } }],
      },
    });
    const expected = await collectOpenCodeTeamSnapshot(api);
    const outcome = await stopOpenCodeTeamRuns(api, "all");
    assert.deepEqual(outcome.stopped, [expected.runs[0].id]);
    assert.deepEqual(interrupts, ["harbor-active-abcdef"]);
    await assert.rejects(() => stopOpenCodeTeamRuns(api, "foreign-active"), /no active Agent Harbor run matches/u);
    assert.deepEqual(interrupts, ["harbor-active-abcdef"], "foreign work was interrupted after a failed selector");
  } finally { fixture.restore(); }
});

test("OpenCode stop treats unknown recheck state as unknown, never idle, and aborts nothing", async () => {
  const fixture = await isolatedProject("harbor-opencode-stop-unknown-");
  try {
    const harbor = nativeSession(fixture.project, "unknown-recheck", "Direct", "crafter");
    const { api, interrupts } = fakeApi({
      directory: fixture.project,
      sessions: [harbor],
      activeSequence: [
        { [harbor.id]: { type: "running" } },
        { [harbor.id]: { type: "busy" } },
      ],
      messages: { [harbor.id]: [{ type: "user", text: "Work", time: { created: 1_000 } }] },
    });
    await assert.rejects(() => stopOpenCodeTeamRuns(api, "all"), /unknown status telemetry; no session was stopped/u);
    assert.deepEqual(interrupts, []);
  } finally { fixture.restore(); }
});

test("OpenCode treats an errored v2 interrupt response as outcome-unknown without retry", async () => {
  const fixture = await isolatedProject("harbor-opencode-abort-rejected-");
  try {
    const direct = nativeSession(fixture.project, "abort-rejected", "Direct", "crafter");
    const fake = fakeApi({
      directory: fixture.project,
      sessions: [direct],
      active: { [direct.id]: { type: "running" } },
      messages: { [direct.id]: [{ id: "abort-boundary", type: "user", text: "Stop", time: { created: 1_000 } }] },
      interruptSession: () => ({ ...response({}), error: { name: "rejected" } }),
    });
    const snapshot = await collectOpenCodeTeamSnapshot(fake.api);
    const result = await stopOpenCodeTeamRuns(fake.api, snapshot.runs[0].id);
    assert.deepEqual(result.stopped, []);
    assert.deepEqual(result.failed, []);
    assert.deepEqual(result.pendingConfirmation, [snapshot.runs[0].id]);
    assert.deepEqual(fake.interrupts, [direct.id]);
    assert.equal(fake.activeReads, 4, "a rejected interrupt was incorrectly terminal-polled after the cross-engine pre-dispatch proof");
    const duplicate = await stopOpenCodeTeamRuns(fake.api, snapshot.runs[0].id);
    assert.deepEqual(duplicate.pendingConfirmation, [snapshot.runs[0].id]);
    assert.deepEqual(fake.interrupts, [direct.id]);
  } finally { fixture.restore(); }
});

test("OpenCode keeps an unclaimed stop pending when a claim appears during terminal polling", async () => {
  const fixture = await isolatedProject("harbor-opencode-claim-during-confirm-");
  let lateClaim: ReturnType<typeof claimOpenCodeAgentActivity> | undefined;
  try {
    const session = nativeSession(fixture.project, "claim-during-confirm", "Direct", "crafter");
    const fake = fakeApi({
      directory: fixture.project,
      sessions: [session],
      activeProvider: (read) => {
        if (read >= 5 && !lateClaim) {
          lateClaim = claimOpenCodeAgentActivity(fixture.project, "crafter", "direct", session.id);
          lateClaim.setPhase("working");
        }
        return { [session.id]: { type: "running" } };
      },
      legacyStatus: {},
      messages: { [session.id]: [{ id: "claim-during-confirm-boundary", type: "user", text: "Stop" }] },
    });
    const snapshot = await collectOpenCodeTeamSnapshot(fake.api);
    const result = await stopOpenCodeTeamRuns(fake.api, snapshot.runs[0].id, {
      rpcDeadlineMs: 15, collectionDeadlineMs: 80,
    });
    assert.deepEqual(result.stopped, []);
    assert.deepEqual(result.pendingConfirmation, [snapshot.runs[0].id]);
    assert.deepEqual(fake.interrupts, [session.id]);
  } finally {
    lateClaim?.release();
    fixture.restore();
  }
});

test("OpenCode pending reconciliation keeps its ledger when a claim appears during status reads", async () => {
  const fixture = await isolatedProject("harbor-opencode-claim-during-reconcile-");
  let running = true;
  let publishClaim = false;
  let lateClaim: ReturnType<typeof claimOpenCodeAgentActivity> | undefined;
  try {
    const session = nativeSession(fixture.project, "claim-during-reconcile", "Direct", "crafter");
    const fake = fakeApi({
      directory: fixture.project,
      sessions: [session],
      activeProvider: () => {
        if (publishClaim && !lateClaim) {
          lateClaim = claimOpenCodeAgentActivity(fixture.project, "crafter", "direct", session.id);
          lateClaim.setPhase("working");
        }
        return running ? { [session.id]: { type: "running" } } : {};
      },
      legacyStatus: {},
      messages: { [session.id]: [{ id: "claim-during-reconcile-boundary", type: "user", text: "Stop" }] },
      interruptSession: () => {
        running = false;
        return { ...response(null), error: { name: "outcome unknown" } };
      },
    });
    const snapshot = await collectOpenCodeTeamSnapshot(fake.api);
    const first = await stopOpenCodeTeamRuns(fake.api, snapshot.runs[0].id);
    assert.deepEqual(first.pendingConfirmation, [snapshot.runs[0].id]);
    publishClaim = true;
    const pendingView = await collectOpenCodeTeamSnapshot(fake.api);
    const pending = pendingView.reservations.find(({ id }) => id === snapshot.runs[0].id)!;
    assert.equal(pending.stopBlockReason, "stop-confirmation-pending");
    assert.match(formatOpenCodeTeamView(pendingView), /stop\s+pending: do not\s+retry/u);
    const duplicate = await stopOpenCodeTeamRuns(fake.api, snapshot.runs[0].id);
    assert.deepEqual(duplicate.pendingConfirmation, [snapshot.runs[0].id]);
    assert.deepEqual(fake.interrupts, [session.id]);
  } finally {
    lateClaim?.release();
    fixture.restore();
  }
});

test("OpenCode stop revalidates current session agent and signed title after the active snapshot", async () => {
  const fixture = await isolatedProject("harbor-opencode-stop-toctou-");
  try {
    const direct = nativeSession(fixture.project, "changed-direct", "Direct", "crafter");
    const sign = await prepareSignedOpenCodeHarborTitle(join(fixture.root, "home"), fixture.project, "agent", "design");
    const child = nativeSession(fixture.project, "changed-child", sign("changed-child"), "design");
    const byID = new Map([[direct.id, direct], [child.id, child]]);
    const { api, interrupts } = fakeApi({
      directory: fixture.project,
      sessions: [direct, child],
      active: { [direct.id]: { type: "running" }, [child.id]: { type: "running" } },
      messages: {
        [direct.id]: [{ type: "user", text: "Direct", time: { created: 1_000 } }],
        [child.id]: [{ type: "user", text: "Child", time: { created: 1_000 } }],
      },
      getSession: (id) => {
        const fresh = structuredClone(byID.get(id));
        if (id === direct.id) fresh.agent = "general";
        else fresh.title = `${fresh.title.slice(0, -1)}${fresh.title.endsWith("A") ? "B" : "A"}`;
        return fresh;
      },
    });
    const before = await collectOpenCodeTeamSnapshot(api);
    const result = await stopOpenCodeTeamRuns(api, "all");
    assert.deepEqual(result.stopped, []);
    assert.deepEqual([...result.failed].sort(), before.runs.map(({ id }) => id).sort());
    assert.deepEqual(interrupts, []);
  } finally { fixture.restore(); }
});

test("OpenCode stop accepts legitimate session progress when the direct turn boundary is unchanged", async () => {
  const fixture = await isolatedProject("harbor-opencode-stop-progress-");
  try {
    const direct = nativeSession(fixture.project, "progressing-direct", "Direct", "crafter");
    const { api, interrupts } = fakeApi({
      directory: fixture.project,
      sessions: [direct],
      active: { [direct.id]: { type: "running" } },
      messages: { [direct.id]: [{ id: "stable-user-boundary", type: "user", text: "Direct", time: { created: 1_000 } }] },
      getSession: () => ({ ...structuredClone(direct), time: { ...direct.time, updated: direct.time.updated + 10_000 } }),
    });
    const result = await stopOpenCodeTeamRuns(api, "all");
    assert.equal(result.stopped.length, 1);
    assert.deepEqual(interrupts, [direct.id]);
  } finally { fixture.restore(); }
});

test("OpenCode revalidates each target ownership after messages before its abort", async () => {
  const fixture = await isolatedProject("harbor-opencode-stop-order-");
  try {
    const signA = await prepareSignedOpenCodeHarborTitle(join(fixture.root, "home"), fixture.project, "agent", "crafter");
    const signB = await prepareSignedOpenCodeHarborTitle(join(fixture.root, "home"), fixture.project, "agent", "design");
    const first = nativeSession(fixture.project, "a-child", signA("a-child"), "crafter");
    const second = nativeSession(fixture.project, "b-child", signB("b-child"), "design");
    const events: string[] = [];
    const { api } = fakeApi({
      directory: fixture.project,
      sessions: [first, second],
      active: { [first.id]: { type: "running" }, [second.id]: { type: "running" } },
      messages: {
        [first.id]: [{ type: "user", text: "A", time: { created: 1_000 } }],
        [second.id]: [{ type: "user", text: "B", time: { created: 1_000 } }],
      },
      getSession: async (id) => {
        events.push(`get-start:${id}`);
        if (id === second.id) await new Promise((resolve) => setTimeout(resolve, 40));
        events.push(`get-end:${id}`);
        return id === first.id ? first : second;
      },
      interruptSession: (id) => { events.push(`interrupt:${id}`); return response({}); },
    });
    const result = await stopOpenCodeTeamRuns(api, "all", { maximumConcurrency: 2, rpcDeadlineMs: 200 });
    assert.equal(result.stopped.length, 2);
    for (const session of [first, second]) {
      const interruptIndex = events.indexOf(`interrupt:${session.id}`);
      assert.ok(interruptIndex > 0, events.join(", "));
      const priorForTarget = events.slice(0, interruptIndex).filter((event) => event.endsWith(`:${session.id}`));
      assert.equal(priorForTarget.at(-1), `get-end:${session.id}`, events.join(", "));
      assert.ok(priorForTarget.filter((event) => event === `get-start:${session.id}`).length >= 2, events.join(", "));
    }
  } finally { fixture.restore(); }
});

test("OpenCode public run IDs are opaque, stable, and distinct for colliding native prefixes", async () => {
  const fixture = await isolatedProject("harbor-opencode-id-collision-");
  try {
    const shared = "session-prefix-that-is-identical-1234567890";
    const first = nativeSession(fixture.project, `${shared}-a`, "First", "crafter");
    const second = nativeSession(fixture.project, `${shared}-b`, "Second", "design");
    const { api, interrupts } = fakeApi({
      directory: fixture.project,
      sessions: [first, second],
      active: { [first.id]: { type: "running" }, [second.id]: { type: "running" } },
      messages: {
        [first.id]: [{ type: "user", text: "First", time: { created: 1_000 } }],
        [second.id]: [{ type: "user", text: "Second", time: { created: 1_000 } }],
      },
      interruptSession: (id) => id === second.id
        ? Promise.reject(new Error("simulated interrupt failure"))
        : response({}),
    });
    const snapshot = await collectOpenCodeTeamSnapshot(api);
    const ids = new Map(snapshot.runs.map((run) => [run.agent, run.id]));
    assert.notEqual(ids.get("crafter"), ids.get("design"));
    assert.ok([...ids.values()].every((id) => /^run-[A-Za-z0-9_-]{20}$/u.test(id)));
    const result = await stopOpenCodeTeamRuns(api, "all");
    assert.deepEqual(result.stopped, [ids.get("crafter")]);
    assert.deepEqual(result.failed, []);
    assert.deepEqual(result.pendingConfirmation, [ids.get("design")]);
    assert.deepEqual(new Set(interrupts), new Set([first.id, second.id]));
  } finally { fixture.restore(); }
});

test("OpenCode never exposes a credential-shaped native session ID but its public alias remains stoppable", async () => {
  const fixture = await isolatedProject("harbor-opencode-private-native-id-");
  try {
    const nativeID = "sk-privateNativeCredential123456789";
    const session = nativeSession(fixture.project, nativeID, "Direct", "crafter");
    const { api, interrupts } = fakeApi({
      directory: fixture.project,
      sessions: [session],
      active: { [nativeID]: { type: "running" } },
      messages: { [nativeID]: [{ id: "safe-boundary", type: "user", text: "Work", time: { created: 1_000 } }] },
    });
    const snapshot = await collectOpenCodeTeamSnapshot(api);
    const publicID = snapshot.runs[0].id;
    assert.match(publicID, /^run-[A-Za-z0-9_-]{20}$/u);
    assert.doesNotMatch(JSON.stringify(snapshot), /privateNativeCredential/u);
    assert.doesNotMatch(JSON.stringify(snapshot), new RegExp(fixture.root.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
    assert.doesNotMatch(formatOpenCodeTeamView(snapshot), /privateNativeCredential/u);
    await assert.rejects(() => stopOpenCodeTeamRuns(api, nativeID), (error: any) => {
      assert.match(error.message, /\[redacted\]/u);
      assert.doesNotMatch(error.message, /privateNativeCredential/u);
      return true;
    });
    const result = await stopOpenCodeTeamRuns(api, publicID);
    assert.deepEqual(result.stopped, [publicID]);
    assert.doesNotMatch(JSON.stringify(result), /privateNativeCredential/u);
    assert.deepEqual(interrupts, [nativeID]);
  } finally { fixture.restore(); }
});

test("OpenCode stop reports every abort omitted by its total deadline", async () => {
  const fixture = await isolatedProject("harbor-opencode-stop-bounded-");
  try {
    const sessions = Array.from({ length: 32 }, (_, index) =>
      nativeSession(fixture.project, `bounded-run-${String(index).padStart(2, "0")}`, "Direct", "crafter"));
    const active = Object.fromEntries(sessions.map(({ id }) => [id, { type: "running" }]));
    const { api } = fakeApi({
      directory: fixture.project,
      sessions,
      active,
      messages: Object.fromEntries(sessions.map(({ id }) => [id, [{ type: "user", text: id, time: { created: 1_000 } }]])),
      interruptSession: () => new Promise((resolve) => setTimeout(() => resolve(response({})), 25)),
    });
    const result = await stopOpenCodeTeamRuns(api, "all", {
      rpcDeadlineMs: 100,
      collectionDeadlineMs: 60,
      maximumConcurrency: 4,
    });
    assert.equal(
      result.stopped.length + result.failed.length + (result.pendingConfirmation?.length ?? 0),
      32,
      "deadline-omitted targets vanished from the outcome",
    );
    assert.ok(result.failed.length + (result.pendingConfirmation?.length ?? 0) > 0,
      "slow bounded fanout unexpectedly confirmed every target");
  } finally { fixture.restore(); }
});

test("OpenCode team RPC deadlines return a cached degraded view and disable stop fail-closed", async () => {
  const fixture = await isolatedProject("harbor-opencode-hang-");
  try {
    const current = nativeSession(fixture.project, "cached-direct-session", "Cached", "crafter");
    const { api, interrupts } = fakeApi({
      directory: fixture.project,
      sessions: [current],
      current: current.id,
      stateStatus: "busy",
      messages: { [current.id]: [{ type: "user", text: "Cached task", time: { created: 1_000 } }] },
      hangList: true,
      hangActive: true,
    });
    const started = Date.now();
    const snapshot = await collectOpenCodeTeamSnapshot(api, { rpcDeadlineMs: 15, collectionDeadlineMs: 60 });
    assert.ok(Date.now() - started < 500, "hung SDK RPC escaped the bounded deadline");
    assert.equal(snapshot.activeAuthoritative, false);
    assert.deepEqual(snapshot.runs.map(({ agent }) => agent), ["crafter"]);
    assert.match(formatOpenCodeTeamView(snapshot), /cached.*not authorized for stop|stop is disabled/isu);
    await assert.rejects(
      () => stopOpenCodeTeamRuns(api, "all", { rpcDeadlineMs: 15, collectionDeadlineMs: 60 }),
      /verification is unavailable; no session was stopped/u,
    );
    assert.deepEqual(interrupts, []);
  } finally { fixture.restore(); }
});

test("OpenCode cached-state fallback reads only the bounded newest suffix and bounded text parts", async () => {
  const fixture = await isolatedProject("harbor-opencode-cache-bound-");
  try {
    const current = nativeSession(fixture.project, "large-cached-session", "Cached", "crafter");
    const stateInfos = Array.from({ length: 50_000 }, (_, index) => ({
      id: `user-${index}`,
      role: "user",
      time: { created: index },
    }));
    let partReads = 0;
    const { api } = fakeApi({
      directory: fixture.project,
      sessions: [current], current: current.id, stateStatus: "busy",
      stateInfos,
      stateParts: (id) => { partReads += 1; return [{ type: "text", text: `latest ${id}` }]; },
      hangList: true, hangActive: true,
    });
    const started = Date.now();
    const snapshot = await collectOpenCodeTeamSnapshot(api, {
      rpcDeadlineMs: 10, collectionDeadlineMs: 50, maximumMessagesPerSession: 1,
    });
    assert.ok(Date.now() - started < 500);
    assert.equal(partReads, 1, "fallback called state.part for unbounded cached history");
    assert.equal(snapshot.runs[0].task, "latest user-49999");
    assert.equal(snapshot.runs[0].telemetryLowerBound, false, "a visible current user boundary was treated as partial usage");
  } finally { fixture.restore(); }
});

test("OpenCode stop all fails closed when an active identity cannot be resolved even if no target was recognized", async () => {
  const fixture = await isolatedProject("harbor-opencode-unresolved-active-");
  try {
    const fake = fakeApi({
      directory: fixture.project,
      sessions: [],
      active: { "unresolved-active-session": { type: "running" } },
      getSession: () => undefined,
    });
    const snapshot = await collectOpenCodeTeamSnapshot(fake.api);
    assert.deepEqual(snapshot.runs, []);
    assert.equal(snapshot.activeAuthoritative, false);
    assert.match(snapshot.degradedReasons.join("\n"), /could not be inspected/u);
    await assert.rejects(
      () => stopOpenCodeTeamRuns(fake.api, "all"),
      /verification is unavailable; no session was stopped/u,
    );
    assert.deepEqual(fake.aborts, []);
    assert.deepEqual(fake.interrupts, []);
  } finally { fixture.restore(); }
});

test("OpenCode public labels redact forward-slash Windows paths, credential URLs, auth headers, and common cloud tokens", () => {
  const cases = [
    ["Read C:/Users/private/customer.txt", /\[path\]/u, /customer/u],
    ["GITHUB_TOKEN=ghp_123456789012345678901234567890123456", /GITHUB_TOKEN=\[redacted\]/u, /ghp_/u],
    ["DATABASE_URL=postgres://admin:supersecret@db.example/private", /DATABASE_URL=\[redacted\]/u, /supersecret/u],
    ["AWS_ACCESS_KEY_ID=AKIA1234567890ABCDEF", /AWS_ACCESS_KEY_ID=\[redacted\]/u, /AKIA/u],
    ["Authorization: Basic YWRtaW46c3VwZXJzZWNyZXQ=", /\[redacted\]/u, /YWRtaW/u],
  ] as const;
  for (const [input, expected, secret] of cases) {
    const task = openCodeTaskLabel(input);
    assert.match(task, expected);
    assert.doesNotMatch(task, secret);
  }
  assert.equal(openCodePublicLabel("openrouter/openai/gpt-5.4", 200), "openrouter/openai/gpt-5.4");
  assert.equal(openCodePublicLabel("model C:/private/route.json", 200), "model [path]");
});

test("OpenCode team ignores unknown active telemetry and never invents zero model, token, or cost facts", async () => {
  const fixture = await isolatedProject("harbor-opencode-unknown-");
  try {
    const direct = nativeSession(fixture.project, "direct-unknown-telemetry", "Direct", "crafter");
    const ghost = nativeSession(fixture.project, "ghost-unknown-telemetry", "Ghost", "crafter");
    const { api } = fakeApi({
      directory: fixture.project,
      sessions: [direct, ghost],
      active: { [direct.id]: { type: "running" }, [ghost.id]: { type: "future-status" } },
      messages: { [direct.id]: [{ type: "user", text: "Observe without telemetry", time: { created: 1_000 } }] },
    });
    const snapshot = await collectOpenCodeTeamSnapshot(api);
    assert.equal(snapshot.runs.length, 1);
    assert.match(snapshot.runs[0].id, /^run-[A-Za-z0-9_-]{20}$/u);
    assert.doesNotMatch(JSON.stringify(snapshot), /direct-unknown-telemetry/u);
    assert.match(snapshot.degradedReasons.join("\n"), /ignored as unknown telemetry/u);
    const view = formatOpenCodeTeamView(snapshot, "member:crafter");
    assert.match(view, /model unobserved · usage and cost unobserved/u);
    assert.doesNotMatch(view, /input 0|output 0|reasoning 0|cost \$0|unknown\/unknown/u);
  } finally { fixture.restore(); }
});

test("OpenCode /team help and team snapshots use a persistent xlarge alert instead of a roster toast", async () => {
  const fixture = await isolatedProject("harbor-opencode-dialog-");
  try {
    const { api, dialogs, toasts } = fakeApi({ directory: fixture.project });
    await runOpenCodeTeamQuery(api, "help");
    assert.equal(dialogs.length, 1);
    assert.match(dialogs[0].message, /Stop fails closed/u);
    const helpPages = [1, 2, 3].map((page) => formatOpenCodeTeamHelp([], page));
    const help = helpPages.join("\n");
    assert.match(help, /0 model tokens/u);
    assert.match(help, /ready · invocable teammate can run with \/<id> <task> in the current session/u);
    assert.match(help, /Enabled · reload required is visible.*cannot run natively or via\s+team-lead/su);
    assert.match(help, /Optional join fields: skills, model, and replace/u);
    assert.match(help, /not a hard per-run token cap/u);
    assert.match(help, /at most six teammates sequentially/u);
    assert.match(help, /Exact examples:.*\/team status:bench page:2/u);
    assert.doesNotMatch(help, /member:crafter page:2/u);
    const examplePage = formatOpenCodeTeamView(await collectOpenCodeTeamSnapshot(api), "status:bench page:2");
    assert.match(examplePage, /Page 2\/2/u);
    assert.match(help, /Privacy:/u);
    assert.doesNotMatch(help, /view clipped/u);
    for (const page of helpPages) {
      assert.ok(page.split("\n").length <= maximumOpenCodeTeamDialogLines);
      assert.ok(page.split("\n").every((line) => visibleTextWidth(line) <= 96));
    }

    await runOpenCodeTeamQuery(api, "status:bench");
    assert.equal(dialogs.length, 2);
    assert.match(dialogs[1].message, /portfolio-management/u);
    assert.match(dialogs[1].message, /ROSTER/u);
    assert.equal(toasts.length, 1, "the long roster itself was emitted as an ephemeral toast");
    assert.match(toasts[0].message, /bounded OpenCode team snapshot/u);
  } finally { fixture.restore(); }
});

test("OpenCode reports the sanitized host default model, limits, and observed run variant without provider secrets", async () => {
  const fixture = await isolatedProject("harbor-opencode-model-info-");
  try {
    const direct = nativeSession(fixture.project, "variant-run", "Direct", "crafter");
    const { api } = fakeApi({
      directory: fixture.project,
      sessions: [direct], active: { [direct.id]: { type: "running" } },
      configModel: "openai/gpt-5.4",
      providers: [{
        id: "openai", key: "provider-private-secret", env: ["OPENAI_API_KEY"], options: { token: "nested-secret" },
        models: { "gpt-5.4": { limit: { context: 200_000, output: 32_000 } } },
      }],
      messages: { [direct.id]: [
        { type: "assistant", agent: "crafter", model: { providerID: "openai", id: "gpt-5.4", variant: "high" }, time: { created: 2_000 } },
        { type: "user", text: "Model task", time: { created: 1_000 } },
      ] },
    });
    const snapshot = await collectOpenCodeTeamSnapshot(api);
    assert.deepEqual(snapshot.hostDefaultModel, {
      provider: "openai", id: "gpt-5.4", contextLimit: 200_000, outputLimit: 32_000,
    });
    assert.equal(snapshot.runs[0].model?.variant, "high");
    const serialized = JSON.stringify(snapshot);
    assert.doesNotMatch(serialized, /provider-private-secret|nested-secret|OPENAI_API_KEY/u);
    const view = formatOpenCodeTeamView(snapshot, "member:crafter");
    assert.match(view,
      /Host default model: provider="openai" · model="gpt-5\.4" · context 200,000 · max output 32,000/u);
    assert.match(view, /variant="high" \(observed\)/u);
  } finally { fixture.restore(); }
});

test("OpenCode direct stop fingerprints the exact boundary ID and never falls back to timestamp equality", async () => {
  const fixture = await isolatedProject("harbor-opencode-boundary-digest-");
  try {
    const direct = nativeSession(fixture.project, "boundary-run", "Direct", "crafter");
    const prefix = "x".repeat(200);
    const { api, interrupts } = fakeApi({
      directory: fixture.project,
      sessions: [direct], active: { [direct.id]: { type: "running" } },
      messageProvider: (_id, read) => [{
        id: read === 1 ? `${prefix}A` : `${prefix}B`,
        type: "user", text: "Same timestamp", time: { created: 1_000 },
      }],
    });
    const result = await stopOpenCodeTeamRuns(api, "all");
    assert.equal(result.stopped.length, 0);
    assert.equal(result.failed.length, 1);
    assert.deepEqual(interrupts, []);
  } finally { fixture.restore(); }
});

test("OpenCode direct stop fails closed when the current turn has no valid native boundary ID", async () => {
  const fixture = await isolatedProject("harbor-opencode-boundary-missing-");
  try {
    const direct = nativeSession(fixture.project, "missing-boundary-run", "Direct", "crafter");
    const { api, interrupts } = fakeApi({
      directory: fixture.project,
      sessions: [direct], active: { [direct.id]: { type: "running" } },
      messages: { [direct.id]: [{ id: 42, type: "user", text: "No valid ID", time: { created: 1_000 } }] },
    });
    const result = await stopOpenCodeTeamRuns(api, "all");
    assert.equal(result.failed.length, 1);
    assert.deepEqual(interrupts, []);
  } finally { fixture.restore(); }
});

test("OpenCode rejects normalized agent/title ownership spoofs before reading messages", async () => {
  const fixture = await isolatedProject("harbor-opencode-raw-identity-");
  try {
    const badAgent = nativeSession(fixture.project, "bad-agent", "Ordinary", "crafter\u200B");
    const sign = await prepareSignedOpenCodeHarborTitle(join(fixture.root, "home"), fixture.project, "agent", "crafter");
    const badTitle = nativeSession(fixture.project, "bad-title", `${sign("bad-title")}\u200B`, "crafter");
    const { api, messageReads, interrupts } = fakeApi({
      directory: fixture.project,
      sessions: [badAgent, badTitle],
      active: { [badAgent.id]: { type: "running" }, [badTitle.id]: { type: "running" } },
      messages: {
        [badAgent.id]: [{ type: "user", text: "private agent spoof", time: { created: 1_000 } }],
        [badTitle.id]: [{ type: "user", text: "private title spoof", time: { created: 1_000 } }],
      },
    });
    const snapshot = await collectOpenCodeTeamSnapshot(api);
    assert.deepEqual(snapshot.runs, []);
    assert.deepEqual(messageReads, []);
    const result = await stopOpenCodeTeamRuns(api, "all");
    assert.deepEqual(result.stopped, []);
    assert.deepEqual(interrupts, []);
  } finally { fixture.restore(); }
});

test("OpenCode discards signed-child telemetry when title ownership changes after messages", async () => {
  const fixture = await isolatedProject("harbor-opencode-title-drift-after-messages-");
  try {
    const sign = await prepareSignedOpenCodeHarborTitle(join(fixture.root, "home"), fixture.project, "agent", "crafter");
    const child = nativeSession(fixture.project, "title-drift-after-messages", sign("title-drift-after-messages"), "crafter");
    const secret = "signed-child-private-task-after-title-drift";
    const fake = fakeApi({
      directory: fixture.project,
      sessions: [child], active: { [child.id]: { type: "running" } }, legacyStatus: {},
      messages: { [child.id]: [{ id: "title-drift-boundary", type: "user", text: secret }] },
      getSession: () => ({ ...child, title: `${child.title}-changed` }),
    });
    const snapshot = await collectOpenCodeTeamSnapshot(fake.api);
    assert.deepEqual(snapshot.runs, []);
    assert.equal(snapshot.reservations[0].stopBlockReason, "ownership-changed");
    assert.doesNotMatch(JSON.stringify(snapshot), new RegExp(secret, "u"));
    const result = await stopOpenCodeTeamRuns(fake.api, snapshot.reservations[0].id!);
    assert.deepEqual(result.ownershipUnavailable, [snapshot.reservations[0].id]);
    assert.deepEqual(fake.interrupts, []);
  } finally { fixture.restore(); }
});

test("OpenCode bounds hostile numeric telemetry and marks overflowing sums as degraded lower bounds", async () => {
  const fixture = await isolatedProject("harbor-opencode-numeric-bound-");
  try {
    const direct = nativeSession(fixture.project, "numeric-run", "Direct", "crafter");
    const assistant = (id: string, created: number) => ({
      id, type: "assistant", agent: "crafter", model: { providerID: "openai", id: "gpt" },
      tokens: { input: Number.MAX_SAFE_INTEGER, output: 1e308, reasoning: 0, cache: { read: 0, write: 0 } },
      cost: Number.MAX_SAFE_INTEGER, time: { created },
    });
    const { api } = fakeApi({
      directory: fixture.project,
      sessions: [direct], active: { [direct.id]: { type: "running" } },
      messages: { [direct.id]: [assistant("a", 3_000), assistant("b", 2_000), { id: "u", type: "user", text: "Bound", time: { created: 1_000 } }] },
    });
    const snapshot = await collectOpenCodeTeamSnapshot(api);
    assert.equal(snapshot.runs[0].usage.input, Number.MAX_SAFE_INTEGER);
    assert.equal(snapshot.runs[0].usage.output, undefined);
    assert.equal(snapshot.runs[0].usage.cost, Number.MAX_SAFE_INTEGER);
    assert.equal(snapshot.runs[0].telemetryBounded, true);
    assert.match(snapshot.degradedReasons.join("\n"), /numeric safety bounds/u);
    assert.doesNotMatch(JSON.stringify(snapshot), /Infinity|NaN|1e\+308/u);
  } finally { fixture.restore(); }
});

test("OpenCode global foreign activity overflow permits exact shown-run stop but keeps stop-all fail-closed", async () => {
  const fixture = await isolatedProject("harbor-opencode-foreign-scale-");
  try {
    const own = nativeSession(fixture.project, "own-exact-run", "Own", "crafter");
    const foreign = Array.from({ length: 33 }, (_, index) =>
      nativeSession(join(fixture.root, `foreign-${index}`), `foreign-${index}`, "Foreign", "design"));
    const byID = new Map(foreign.map((session) => [session.id, session]));
    const active = Object.fromEntries([own, ...foreign].map(({ id }) => [id, { type: "running" }]));
    const { api, interrupts } = fakeApi({
      directory: fixture.project,
      sessions: [own], active,
      getSession: (id) => id === own.id ? own : byID.get(id),
      messages: { [own.id]: [{ id: "own-boundary", type: "user", text: "Own", time: { created: 1_000 } }] },
    });
    const snapshot = await collectOpenCodeTeamSnapshot(api);
    assert.equal(snapshot.activeAuthoritative, false);
    assert.equal(snapshot.exactStopAvailable, true);
    await assert.rejects(() => stopOpenCodeTeamRuns(api, "all"), /verification is unavailable/u);
    const result = await stopOpenCodeTeamRuns(api, snapshot.runs[0].id);
    assert.equal(result.stopped.length, 1);
    assert.deepEqual(interrupts, [own.id]);
  } finally { fixture.restore(); }
});

test("OpenCode rejects oversized team input before any host RPC or secret echo", async () => {
  const fixture = await isolatedProject("harbor-opencode-input-bound-");
  try {
    const fake = fakeApi({ directory: fixture.project });
    const secret = `secret-${"x".repeat(5_000)}`;
    await runOpenCodeTeamQuery(fake.api, secret);
    assert.equal(fake.listReads, 0);
    assert.equal(fake.activeReads, 0);
    assert.equal(fake.toasts.length, 0);
    assert.match(fake.dialogs.at(-1).title, /query rejected · 0 model tokens/u);
    assert.match(fake.dialogs.at(-1).message, /4 KiB safety limit/u);
    assert.doesNotMatch(fake.dialogs.at(-1).message, /secret-/u);
    assert.ok(fake.dialogs.at(-1).message.split("\n").length <= maximumOpenCodeTeamDialogLines);
    assert.ok(fake.dialogs.at(-1).message.split("\n").every((line) => visibleTextWidth(line) <= 96));
    await assert.rejects(() => stopOpenCodeTeamRuns(fake.api, secret), /256-byte safety limit/u);
    assert.equal(fake.listReads, 0);
  } finally { fixture.restore(); }
});

test("OpenCode deterministic command failures retain the zero-model guarantee", async () => {
  const fixture = await isolatedProject("harbor-opencode-zero-token-errors-");
  try {
    const fake = fakeApi({ directory: fixture.project });
    const join = openCodeDirectCommands(fake.api).find(({ slashName }) => slashName === "harbor-join")!;
    join.run();
    await fake.dialogs.at(-1).onConfirm("{");
    assert.match(fake.dialogs.at(-1).title, /action failed · 0 model tokens/u);

    await runOpenCodeTeamQuery(fake.api, "stop");
    assert.match(fake.dialogs.at(-1).title, /action unavailable · 0 model tokens/u);
    assert.match(fake.dialogs.at(-1).message, /usage inside the \/team prompt: stop <run-id\|all>/u);
    assert.ok(fake.dialogs.at(-1).message.split("\n").length <= maximumOpenCodeTeamDialogLines);
    assert.ok(fake.dialogs.at(-1).message.split("\n").every((line) => visibleTextWidth(line) <= 96));
  } finally { fixture.restore(); }
});

test("OpenCode bounds every prompt input before lifecycle, roster, or catalog work", async () => {
  const fixture = await isolatedProject("harbor-opencode-all-input-bounds-");
  const originalListCatalog = GhResolver.prototype.listCatalog;
  try {
    await runDeterministicCommand("opencode", "join", JSON.stringify({
      name: "keeper", description: "Keep me", prompt: "Work", tools: ["read"],
    }), fixture.project);
    let catalogReads = 0;
    GhResolver.prototype.listCatalog = async () => { catalogReads += 1; return []; };
    const fake = fakeApi({ directory: fixture.project });
    await (openCodeTuiPlugin.tui as any)(fake.api);
    const commands = new Map(fake.registeredLayer.commands.map((command: any) => [command.slashName, command]));
    const cases = [
      ["team", "x".repeat(4_097)],
      ["bench-on", "x".repeat(4_097)],
      ["bench-off", "x".repeat(4_097)],
      ["harbor-join", "x".repeat(30_001)],
      ["harbor-retire", "x".repeat(257)],
      ["contract", "x".repeat(30_001)],
      ["harbor-filter-skills", "x".repeat(4_097)],
    ] as const;
    for (const [slashName, value] of cases) {
      commands.get(slashName).run();
      const prompt = fake.dialogs.at(-1);
      assert.equal(typeof prompt.onConfirm, "function", `${slashName} did not open its bounded prompt`);
      await prompt.onConfirm(value);
      const rejection = fake.dialogs.at(-1);
      assert.match(rejection.message, /safety limit/u, `${slashName} did not render a bounded rejection`);
      assert.ok([...rejection.message].length < 200);
      assert.doesNotMatch(rejection.message, /x{32}/u);
    }
    assert.equal(fake.listReads, 0, "oversized retire/team input reached OpenCode session inventory");
    assert.equal(fake.activeReads, 0, "oversized retire/team input reached OpenCode active inventory");
    assert.equal(catalogReads, 0, "oversized skill filter reached catalog resolution");
    const roster = await runDeterministicCommand("opencode", "bench", "list", fixture.project);
    assert.match(roster, /keeper \| personal \| on/u);
    assert.match(roster, /portfolio-management \| bundled \| bench/u);
  } finally {
    GhResolver.prototype.listCatalog = originalListCatalog;
    fixture.restore();
  }
});

test("OpenCode TUI bridge maps every disposable-child RPC to the v2 SDK shape", async () => {
  const calls: Array<{ name: string; input: any; options: any }> = [];
  const native = { session: {
    create: async (input: any, options: any) => {
      calls.push({ name: "create", input, options });
      return { data: { id: "child-v2" } };
    },
    update: async (input: any, options: any) => {
      calls.push({ name: "update", input, options });
      return { data: { id: input.sessionID, title: input.title } };
    },
    prompt: async (input: any, options: any) => {
      calls.push({ name: "prompt", input, options });
      return { data: {
        info: { role: "assistant", providerID: "local", modelID: "test" },
        parts: [{ type: "text", text: "done" }],
      } };
    },
    delete: async (input: any, options: any) => {
      calls.push({ name: "delete", input, options });
      return { data: true };
    },
  } };
  const bridge = openCodeTuiOrchestratorClient(native as any);
  const signal = new AbortController().signal;
  await bridge.session.create({
    body: { title: "pending" }, query: { directory: "C:/physical-project" }, signal, throwOnError: true,
  } as any);
  await bridge.session.update({
    path: { id: "child-v2" }, query: { directory: "C:/physical-project" }, signal, throwOnError: true,
    body: { title: "signed" },
  } as any);
  const prompted = await bridge.session.prompt({
    path: { id: "child-v2" }, query: { directory: "C:/physical-project" }, signal, throwOnError: true,
    body: {
      agent: "explore", model: { providerID: "local", modelID: "test" }, variant: "high",
      tools: { read: true, bash: false }, parts: [{ type: "text", text: "Review" }],
    },
  } as any);
  await bridge.session.delete({
    path: { id: "child-v2" }, query: { directory: "C:/physical-project" }, signal, throwOnError: true,
  } as any);
  assert.deepEqual(calls.map(({ name }) => name), ["create", "update", "prompt", "delete"]);
  assert.deepEqual(calls.map(({ input }) => input), [
    { directory: "C:/physical-project", title: "pending" },
    { sessionID: "child-v2", directory: "C:/physical-project", title: "signed" },
    {
      sessionID: "child-v2", directory: "C:/physical-project", agent: "explore",
      model: { providerID: "local", modelID: "test" }, variant: "high",
      tools: { read: true, bash: false }, parts: [{ type: "text", text: "Review" }],
    },
    { sessionID: "child-v2", directory: "C:/physical-project" },
  ]);
  assert.ok(calls.every(({ options }) => options.signal === signal && options.throwOnError === true));
  assert.equal((prompted.data?.info as any)?.modelID, "test");
});

test("OpenCode direct contract runs one disposable child and retains exact telemetry before deletion", async () => {
  const fixture = await isolatedProject("harbor-opencode-direct-contract-");
  try {
    const fake = fakeApi({ directory: fixture.project });
    const calls: Array<{ name: string; input: any }> = [];
    fake.api.client.session.create = async (input: any) => {
      calls.push({ name: "create", input });
      return response({ id: "direct-contract-child" });
    };
    fake.api.client.session.update = async (input: any) => {
      calls.push({ name: "update", input });
      return response({ id: input.sessionID, title: input.title });
    };
    fake.api.client.session.prompt = async (input: any) => {
      calls.push({ name: "prompt", input });
      return response({
        info: {
          role: "assistant", providerID: "openai", modelID: "gpt-contract", variant: "high",
          tokens: { total: 18, input: 11, output: 7, reasoning: 3, cache: { read: 0, write: 0 } },
          cost: 0.00005,
        },
        parts: [{
          type: "text",
          text: "Review src/core/lifecycle.ts:1255 and https://example.com/report\u001b]52;c;ZXZpbA==\u0007",
        }],
      });
    };
    fake.api.client.session.delete = async (input: any) => {
      calls.push({ name: "delete", input });
      return response(true);
    };
    const contract = openCodeDirectCommands(fake.api).find(({ slashName }) => slashName === "contract")!;
    contract.run();
    await fake.dialogs.at(-1).onConfirm(JSON.stringify({
      name: "release-auditor", description: "Audit release evidence", prompt: "Return evidence",
      tools: ["read"], skills: [], task: "Review the release",
    }));
    assert.deepEqual(calls.map(({ name }) => name), ["create", "update", "prompt", "delete"]);
    assert.equal(calls[2].input.sessionID, "direct-contract-child");
    assert.equal(calls[2].input.directory, fixture.project);
    assert.equal(calls[2].input.agent, "explore");
    assert.equal(calls[2].input.parts.length, 1);
    assert.match(fake.dialogs.at(-1).message, /src\/core\/lifecycle\.ts:1255/u);
    assert.match(fake.dialogs.at(-1).message, /https:\/\/example\.com\/report/u);
    assert.doesNotMatch(fake.dialogs.at(-1).message, /ZXZpbA|\u001b|\u0007/u);
    assert.match(fake.dialogs.at(-1).message, /Model: provider="openai" · model="gpt-contract" · variant="high" \(observed\)/u);
    assert.match(fake.dialogs.at(-1).message, /input 11 · output 7 · reasoning 3 · cache read 0 · cache write 0 · native total 18/u);
    assert.match(fake.dialogs.at(-1).message, /Cost: \$0\.00005/u);
    assert.doesNotMatch(fake.dialogs.at(-1).message, /component conflict/u);
  } finally { fixture.restore(); }
});

test("OpenCode contract evidence preserves actionable paths and URLs while stripping terminal controls", () => {
  const value = "Fix src/a.ts:9 via https://example.com/a\u001b[31m red\u001b[0m\u009dclipboard\u0007";
  const output = boundedContractEvidence(value)!;
  assert.match(output, /src\/a\.ts:9/u);
  assert.match(output, /https:\/\/example\.com\/a/u);
  assert.match(output, / red/u);
  assert.doesNotMatch(output, /\u001b|\u009d|clipboard|\u0007/u);
});

test("OpenCode contract reserves viewport space for exact tiny cost and sanitized telemetry", async () => {
  const fixture = await isolatedProject("harbor-opencode-contract-viewport-");
  try {
    const fake = fakeApi({ directory: fixture.project });
    fake.api.client.session.create = async () => response({ id: "bounded-contract-child" });
    fake.api.client.session.update = async (input: any) => response({ id: input.sessionID, title: input.title });
    fake.api.client.session.prompt = async () => response({
      info: {
        role: "assistant", providerID: "openai", modelID: "gpt-tiny",
        tokens: { total: 3, input: 1, output: 2 }, cost: 5e-8,
      },
      parts: [{ type: "text", text: Array.from({ length: 100 }, (_, index) => `Evidence ${index} ${"x".repeat(180)}`).join("\n") }],
    });
    fake.api.client.session.delete = async () => response(true);
    const contract = openCodeDirectCommands(fake.api).find(({ slashName }) => slashName === "contract")!;
    contract.run();
    await fake.dialogs.at(-1).onConfirm(JSON.stringify({
      name: "auditor", description: "Audit", prompt: "Return evidence", tools: ["read"], task: "Review",
    }));
    const output = fake.dialogs.at(-1).message;
    assert.match(output, /evidence bounded/u);
    assert.match(output, /Model: provider="openai" · model="gpt-tiny" \(observed\)/u);
    assert.match(output, /Tokens: input 1 · output 2 · native total 3/u);
    assert.match(output, /Cost: \$5e-8/u);
    assert.doesNotMatch(output, /\u001b|\u0007/u);
    assert.ok(output.split("\n").length <= maximumOpenCodeTeamDialogLines);
    assert.ok(output.split("\n").every((line) => visibleTextWidth(line) <= 96));
  } finally { fixture.restore(); }
});

test("OpenCode direct contract labels unavailable host telemetry instead of hiding it", async () => {
  const fixture = await isolatedProject("harbor-opencode-direct-contract-unobserved-");
  try {
    const fake = fakeApi({ directory: fixture.project });
    fake.api.client.session.create = async () => response({ id: "unobserved-contract-child" });
    fake.api.client.session.update = async (input: any) => response({ id: input.sessionID, title: input.title });
    fake.api.client.session.prompt = async () => response({ parts: [{ type: "text", text: "evidence" }] });
    fake.api.client.session.delete = async () => response(true);
    const contract = openCodeDirectCommands(fake.api).find(({ slashName }) => slashName === "contract")!;
    contract.run();
    await fake.dialogs.at(-1).onConfirm(JSON.stringify({
      name: "auditor", description: "Audit", prompt: "Return evidence", tools: ["read"], task: "Review",
    }));
    assert.match(fake.dialogs.at(-1).message, /Model: unobserved/u);
    assert.match(fake.dialogs.at(-1).message, /Tokens: unobserved/u);
    assert.match(fake.dialogs.at(-1).message, /Cost: unobserved/u);
  } finally { fixture.restore(); }
});

test("OpenCode join confirmation and roster distinguish enabled pending reload from loaded invocability", async () => {
  const fixture = await isolatedProject("harbor-opencode-join-public-");
  try {
    const fake = fakeApi({ directory: fixture.project });
    const joinCommand = openCodeDirectCommands(fake.api).find(({ slashName }) => slashName === "harbor-join")!;
    const definition = JSON.stringify({
      name: "private-reviewer",
      description: "Review C:/Users/alice/customer.txt with Bearer abcdefghijklmnop",
      prompt: "private-prompt-never-render-123456789",
      tools: ["read"],
      model: "router/safe",
    });
    joinCommand.run();
    await fake.dialogs.at(-1).onConfirm(definition);
    const output = fake.dialogs.at(-1).message;
    assert.match(output, /private-reviewer joined · personal · enabled · reload required/u);
    assert.match(output, /Role: Review \[path\] with \[redacted\]/u);
    assert.match(output, /Capacity: read/u);
    assert.match(output, /Model: configured router\/safe/u);
    assert.match(output, /After reload: \/private-reviewer <task>/u);
    assert.match(output, /Reload OpenCode before native selection/u);
    assert.doesNotMatch(output, /registration:|active:|customer\.txt|abcdefghijklmnop|private-prompt-never-render|harbor-opencode-join-public/u);
    assert.ok([...output].length < 1_000);

    joinCommand.run();
    await fake.dialogs.at(-1).onConfirm(definition);
    const joinNoOp = fake.dialogs.at(-1).message;
    assert.match(joinNoOp, /○ private-reviewer is already joined and current · no roster files changed\./u);
    assert.match(joinNoOp, /After reload: \/private-reviewer <task>/u);
    assert.match(joinNoOp, /Reload OpenCode before native selection/u);

    const pending = await collectOpenCodeTeamSnapshot(fake.api);
    assert.equal(pending.members.find(({ id }) => id === "private-reviewer")?.availability, "reload-required");
    const pendingView = formatOpenCodeTeamView(pending, "member:private-reviewer");
    assert.match(pendingView, /enabled · reload required/u);
    assert.match(pendingView, /Lead: 1 available · 0 busy · 1 blocked until reload/u);
    assert.doesNotMatch(formatOpenCodeTeamView(pending, "status:ready"), /private-reviewer/u);
    assert.match(formatOpenCodeTeamView(pending, "status:enabled"), /private-reviewer/u);

    const loaded = fakeApi({ directory: fixture.project, loadedAgents: ["private-reviewer"] });
    const ready = await collectOpenCodeTeamSnapshot(loaded.api);
    assert.equal(ready.members.find(({ id }) => id === "private-reviewer")?.availability, "ready");
    assert.match(formatOpenCodeTeamView(ready, "member:private-reviewer"), /ready · invocable/u);

    const replace = openCodeDirectCommands(loaded.api).find(({ slashName }) => slashName === "harbor-join")!;
    replace.run();
    await loaded.dialogs.at(-1).onConfirm(JSON.stringify({
      name: "private-reviewer",
      description: "Replacement definition",
      prompt: "Use the replacement policy only.",
      tools: ["read"],
      model: "router/replacement",
      replace: true,
    }));
    assert.match(loaded.dialogs.at(-1).message,
      /private-reviewer joined · personal · enabled · reload required/u);
    assert.doesNotMatch(loaded.dialogs.at(-1).message, /Run now/u);
    const staleLoadedDefinition = await collectOpenCodeTeamSnapshot(loaded.api);
    assert.equal(staleLoadedDefinition.members.find(({ id }) => id === "private-reviewer")?.availability,
      "reload-required", "a loaded ID was mistaken for the newly replaced definition");

    const benchOff = openCodeDirectCommands(loaded.api).find(({ slashName }) => slashName === "bench-off")!;
    benchOff.run();
    await loaded.dialogs.at(-1).onConfirm("private-reviewer");
    assert.match(loaded.dialogs.at(-1).message, /✓ private-reviewer benched/u);
    benchOff.run();
    await loaded.dialogs.at(-1).onConfirm("private-reviewer");
    const benchNoOp = loaded.dialogs.at(-1).message;
    assert.match(benchNoOp, /○ private-reviewer is already benched · no roster files changed\./u);
    assert.match(benchNoOp, /Discovery: reload required to remove the stale native agent.*invocation is blocked/su);

    await runDeterministicCommand("opencode", "bench", "on design", fixture.project);
    benchOff.run();
    await loaded.dialogs.at(-1).onConfirm("private-reviewer design");
    const mixedBench = loaded.dialogs.at(-1).message;
    assert.match(mixedBench, /○ private-reviewer is already benched · this member was unchanged\./u);
    assert.match(mixedBench, /✓ design benched/u);
    assert.doesNotMatch(mixedBench, /private-reviewer is already benched · no roster files changed/u);
  } finally { fixture.restore(); }
});

test("OpenCode summarizes large bench mutations with exact counts and a full-roster route", async () => {
  const fixture = await isolatedProject("harbor-opencode-bench-summary-");
  try {
    const fake = fakeApi({ directory: fixture.project });
    const benchOn = openCodeDirectCommands(fake.api).find(({ slashName }) => slashName === "bench-on")!;
    benchOn.run();
    await fake.dialogs.at(-1).onConfirm("all");
    const output = fake.dialogs.at(-1).message;
    assert.match(output, /Roster mutation verified · 6 requested · 6 changed · 0 unchanged/u);
    assert.match(output, /Action: bench on/u);
    assert.match(output, /lead blocked until reload/u);
    assert.match(output, /Full roster and capacity: \/team roster 1/u);
    assert.ok(output.split("\n").length <= maximumOpenCodeTeamDialogLines);
    assert.ok(output.split("\n").every((line) => visibleTextWidth(line) <= 96));
  } finally { fixture.restore(); }
});

test("OpenCode lifecycle presentation fails closed without exact structured join/bench/retire truth", () => {
  const joined = JSON.stringify({
    name: "reviewer", description: "Review", prompt: "Review safely.", tools: ["read"],
  });
  assert.throws(
    () => assertOpenCodeLifecycleMutationTruth("join", joined, { text: "joined reviewer" }),
    /without matching structured lifecycle mutation truth/u,
  );
  assert.throws(
    () => assertOpenCodeLifecycleMutationTruth("join", joined, {
      text: "joined reviewer",
      lifecycle: { command: "join", player: "other", status: "changed" },
    }),
    /without matching structured lifecycle mutation truth/u,
  );
  assert.throws(
    () => assertOpenCodeLifecycleMutationTruth("bench", "off design", { text: "design: turned off" }),
    /without matching structured lifecycle mutation truth/u,
  );
  assert.throws(
    () => assertOpenCodeLifecycleMutationTruth("retire", "reviewer", { text: "retired reviewer" }),
    /without matching structured lifecycle mutation truth/u,
  );
  assert.throws(
    () => assertOpenCodeLifecycleMutationTruth("bench", "off design", {
      text: "design: turned off",
      lifecycle: {
        command: "bench",
        status: "already-current",
        rows: [{ id: "design", action: "off", status: "changed" }],
      },
    }),
    /inconsistent aggregate lifecycle mutation truth/u,
  );
  assert.doesNotThrow(() => assertOpenCodeLifecycleMutationTruth("bench", "list", { text: "inventory" }));
  assert.doesNotThrow(() => assertOpenCodeLifecycleMutationTruth("bench", "", { text: "inventory" }));
});

test("OpenCode coalesces superseded team reads and renders only the latest query", async () => {
  const fixture = await isolatedProject("harbor-opencode-read-coalesce-");
  try {
    const fake = fakeApi({ directory: fixture.project, hangList: true });
    await Promise.all(Array.from({ length: 50 }, (_, index) =>
      runOpenCodeTeamQuery(fake.api, `member:${index}`, { rpcDeadlineMs: 20, collectionDeadlineMs: 50 })));
    assert.equal(fake.listReads, 1);
    assert.equal(fake.activeReads, 1);
    assert.equal(fake.toasts.length, 1);
    assert.equal(fake.dialogs.length, 1);
    assert.match(fake.dialogs[0].message, /No team member or active work matches “member:49”/u);
  } finally { fixture.restore(); }
});

test("OpenCode Harbor dialogs preserve xlarge across replacement and restore the prior size on close", async () => {
  const fixture = await isolatedProject("harbor-opencode-dialog-size-");
  try {
    const fake = fakeApi({ directory: fixture.project });
    await runOpenCodeTeamQuery(fake.api, "help");
    await runOpenCodeTeamQuery(fake.api, "help");
    assert.equal(fake.dialogSize, "xlarge");
    const team = openCodeDirectCommands(fake.api).find(({ slashName }) => slashName === "team")!;
    team.run();
    assert.equal(fake.dialogSize, "medium", "a prompt inherited the preceding result's xlarge size");
    fake.dialogs.at(-1).onCancel();
    assert.equal(fake.dialogSize, "medium");
    assert.equal(fake.dialogOpen, false);
  } finally { fixture.restore(); }
});

test("OpenCode keeps newer help visible while a delayed stop emits a durable completion notice", async () => {
  const fixture = await isolatedProject("harbor-opencode-mutation-order-");
  try {
    const direct = nativeSession(fixture.project, "delayed-stop-run", "Direct", "crafter");
    let running = true;
    const fake = fakeApi({
      directory: fixture.project,
      sessions: [direct], activeProvider: () => running ? { [direct.id]: { type: "running" } } : {},
      messages: { [direct.id]: [{ id: "delayed-boundary", type: "user", text: "Stop me", time: { created: 1_000 } }] },
      interruptSession: () => new Promise((resolve) => setTimeout(() => {
        running = false;
        resolve(response({}));
      }, 35)),
    });
    const stopping = runOpenCodeTeamQuery(fake.api, "stop all", { rpcDeadlineMs: 200, collectionDeadlineMs: 500 });
    while (!fake.interrupts.length) await new Promise((resolve) => setTimeout(resolve, 1));
    await runOpenCodeTeamQuery(fake.api, "help");
    await stopping;
    assert.match(fake.dialogs.at(-1).message, /Stop fails closed/u);
    assert.ok(fake.toasts.some(({ title }: any) => /stop completed/u.test(title)));
    assert.equal(running, false);
  } finally { fixture.restore(); }
});

test("OpenCode stop confirmation stays concise and directs the refreshed roster to /team", async () => {
  const fixture = await isolatedProject("harbor-opencode-stop-concise-");
  try {
    const direct = nativeSession(fixture.project, "concise-stop-run", "Direct", "crafter");
    let running = true;
    const fake = fakeApi({
      directory: fixture.project,
      sessions: [direct],
      activeProvider: () => running ? { [direct.id]: { type: "running" } } : {},
      messages: { [direct.id]: [{ id: "concise-boundary", type: "user", text: "Stop", time: { created: 1_000 } }] },
      interruptSession: () => { running = false; return response({}); },
    });
    await runOpenCodeTeamQuery(fake.api, "stop all");
    const message = fake.dialogs.at(-1).message;
    assert.ok(message.split("\n").length <= 8);
    assert.match(message, /Post-stop team refresh completed\. Run \/team/u);
    assert.doesNotMatch(message, /\nROSTER|Agent Harbor OpenCode team/u);
  } finally { fixture.restore(); }
});

test("OpenCode labels an outcome-unknown stop as incomplete instead of successful", async () => {
  const fixture = await isolatedProject("harbor-opencode-stop-unresolved-dialog-");
  try {
    const direct = nativeSession(fixture.project, "unresolved-dialog", "Direct", "crafter");
    const fake = fakeApi({
      directory: fixture.project,
      sessions: [direct], active: { [direct.id]: { type: "running" } }, legacyStatus: {},
      messages: { [direct.id]: [{ id: "unresolved-dialog-boundary", type: "user", text: "Stop" }] },
      interruptSession: () => ({ ...response(null), error: { name: "transport unknown" } }),
    });
    await runOpenCodeTeamQuery(fake.api, "stop all");
    const dialog = fake.dialogs.at(-1);
    assert.match(dialog.title, /stop incomplete/u);
    assert.match(dialog.message, /Stop request still pending.*Do not retry/su);
    assert.doesNotMatch(dialog.title, /stop complete$/u);
  } finally { fixture.restore(); }
});

test("OpenCode reports a committed stop even when its best-effort post-stop refresh throws", async () => {
  const fixture = await isolatedProject("harbor-opencode-stop-refresh-");
  try {
    const direct = nativeSession(fixture.project, "refresh-stop-native", "Direct", "crafter");
    let fake: ReturnType<typeof fakeApi>;
    fake = fakeApi({
      directory: fixture.project,
      sessions: [direct],
      active: { [direct.id]: { type: "running" } },
      messages: { [direct.id]: [{ id: "refresh-boundary", type: "user", text: "Stop", time: { created: 1_000 } }] },
      interruptSession: () => {
        Object.defineProperty(fake.api.state.path, "directory", {
          configurable: true,
          get: () => { throw new Error("C:/Users/alice/private-refresh.txt"); },
        });
        return response({});
      },
    });
    await runOpenCodeTeamQuery(fake.api, "stop all");
    assert.deepEqual(fake.interrupts, [direct.id]);
    const resultDialog = fake.dialogs.at(-1);
    assert.match(resultDialog.title, /stop complete/u);
    assert.match(resultDialog.message, /Stop confirmed: run-[A-Za-z0-9_-]{20}/u);
    assert.match(resultDialog.message, /Post-stop team refresh unavailable/u);
    assert.match(resultDialog.message, /\[path\]/u);
    assert.match(resultDialog.message, /stop result below is still final/u);
    assert.doesNotMatch(resultDialog.message, /alice|private-refresh/u);
  } finally { fixture.restore(); }
});

test("OpenCode lifecycle disposal cancels in-flight rendering, restores owned dialog size, and disposes the layer once", async () => {
  const first = await isolatedProject("harbor-opencode-dispose-alert-");
  try {
    const fake = fakeApi({ directory: first.project });
    await (openCodeTuiPlugin.tui as any)(fake.api);
    await runOpenCodeTeamQuery(fake.api, "help");
    assert.equal(fake.dialogSize, "xlarge");
    await fake.dispose();
    assert.equal(fake.dialogSize, "medium");
    assert.equal(fake.layerDisposeCount, 1);
  } finally { first.restore(); }

  const second = await isolatedProject("harbor-opencode-dispose-inflight-");
  try {
    const fake = fakeApi({ directory: second.project, hangList: true, hangActive: true });
    await (openCodeTuiPlugin.tui as any)(fake.api);
    const team = fake.registeredLayer.commands.find(({ slashName }: any) => slashName === "team");
    team.run();
    const prompt = fake.dialogs.at(-1);
    const running = prompt.onConfirm("");
    fake.abortLifecycle();
    await running;
    const dialogCount = fake.dialogs.length;
    const toastCount = fake.toasts.length;
    await prompt.onConfirm("");
    assert.equal(fake.dialogs.length, dialogCount);
    assert.equal(fake.toasts.length, toastCount);
  } finally { second.restore(); }
});

test("OpenCode lifecycle disposal clears every owned Harbor prompt without touching a replacement", async () => {
  const fixture = await isolatedProject("harbor-opencode-dispose-prompts-");
  try {
    for (const slashName of ["team", "bench-on", "bench-off", "harbor-join", "harbor-retire", "harbor-filter-skills"]) {
      const fake = fakeApi({ directory: fixture.project });
      await (openCodeTuiPlugin.tui as any)(fake.api);
      fake.registeredLayer.commands.find((command: any) => command.slashName === slashName).run();
      assert.equal(fake.dialogOpen, true, `${slashName} did not leave an owned prompt open`);
      assert.equal(typeof fake.dialogs.at(-1).onConfirm, "function");
      await fake.dispose();
      assert.equal(fake.dialogOpen, false, `${slashName} prompt survived extension disposal`);
      assert.equal(fake.dialogSize, "medium");
      assert.equal(fake.layerDisposeCount, 1);
    }

    const fake = fakeApi({ directory: fixture.project });
    await (openCodeTuiPlugin.tui as any)(fake.api);
    fake.registeredLayer.commands.find((command: any) => command.slashName === "team").run();
    // Simulate a host/foreign surface replacing Harbor's prompt. Its replace
    // callback closes Harbor ownership before installing the foreign dialog.
    fake.api.ui.dialog.replace(() => ({ title: "Foreign dialog" }));
    const clearsBeforeDispose = fake.dialogClearCount;
    await fake.dispose();
    assert.equal(fake.dialogClearCount, clearsBeforeDispose, "dispose cleared a dialog no longer owned by Agent Harbor");
    assert.equal(fake.dialogOpen, true);
  } finally { fixture.restore(); }
});

test("OpenCode lifecycle reservations expose starting and cleaning phases and block retire", async () => {
  const fixture = await isolatedProject("harbor-opencode-lifecycle-bridge-");
  const definition = {
    name: "reviewer", description: "Review risk", prompt: "Return findings", tools: ["read"], skills: [],
  };
  await runDeterministicCommand("opencode", "join", JSON.stringify(definition), fixture.project);
  const claim = claimOpenCodeAgentActivity(fixture.project, "reviewer", "delegated", "lifecycle-owner", 1_000);
  let createEntered = false;
  let deleteEntered = false;
  let resolveCreate!: () => void;
  let resolveDelete!: () => void;
  const createGate = new Promise<void>((resolve) => { resolveCreate = resolve; });
  const deleteGate = new Promise<void>((resolve) => { resolveDelete = resolve; });
  const phases: string[] = [];
  // This test deliberately holds create/delete open while it inspects both
  // lifecycle phases. Keep the orchestrator deadline comfortably above the
  // filesystem-heavy parallel suite so load cannot turn the intended gates
  // into an unrelated timeout rejection.
  const orchestrator = new OpenCodeOrchestrator({ session: {
    create: async () => { createEntered = true; await createGate; return { data: { id: "lifecycle-child" } }; },
    update: async ({ path, body }: any) => ({ data: { id: path.id, title: body.title } }),
    prompt: async () => ({ data: { parts: [{ type: "text", text: "verified" }] } }),
    delete: async () => { deleteEntered = true; await deleteGate; return { data: true }; },
  } } as any, fixture.project, undefined, undefined, 5_000, join(fixture.root, "claim-home"));
  const work = orchestrator.runAgent(
    "reviewer", "Review", undefined, { providerID: "openai", modelID: "gpt" }, undefined,
    (phase, childSessionID) => {
      phases.push(phase);
      if (childSessionID) claim.setSessionID(childSessionID);
      claim.setPhase(phase);
    },
  );
  // The test intentionally leaves create pending while inspecting the
  // starting phase. Observe a deadline rejection immediately so an overloaded
  // runner can fail this test without leaking an unhandled rejection into the
  // following fixture; the original promise is still asserted below.
  void work.catch(() => undefined);
  try {
    while (!createEntered) await new Promise((resolve) => setTimeout(resolve, 1));
    const owner = nativeSession(fixture.project, "lifecycle-owner", "Lead owner", "general");
    const fake = fakeApi({
      directory: fixture.project,
      sessions: [owner],
      active: { [owner.id]: { type: "running" } },
      messages: { [owner.id]: [{ id: "lead-boundary", type: "user", text: "Delegate", time: { created: 1_000 } }] },
    });
    const starting = await collectOpenCodeTeamSnapshot(fake.api, { now: () => 2_000 });
    assert.deepEqual(starting.reservations.map(({ agent, phase }) => [agent, phase]), [["reviewer", "starting"]]);
    assert.match(formatOpenCodeTeamView(starting, "member:reviewer"), /reviewer · run ID pending · delegated lifecycle · starting/u);
    assert.equal(starting.reservations[0]?.id, undefined);
    assert.equal(starting.reservations[0]?.stopAvailable, false);
    const pendingStop = await stopOpenCodeTeamRuns(fake.api, "all");
    assert.deepEqual(pendingStop, {
      requested: "all", stopped: [], alreadyIdle: [], failed: [], pendingChildIdentity: ["reviewer"],
    });
    assert.match(formatOpenCodeStopResult(pendingStop), /Pending child identity: reviewer; no stop was attempted/u);
    assert.deepEqual(fake.aborts, [], "delegated starting used the lead session as a stop target");

    const retire = openCodeDirectCommands(fake.api).find(({ slashName }) => slashName === "harbor-retire")!;
    retire.run();
    await fake.dialogs.at(-1).onConfirm("reviewer");
    assert.match(fake.dialogs.at(-1).message, /Cannot retire active member reviewer/u);

    resolveCreate();
    while (!deleteEntered) await new Promise((resolve) => setTimeout(resolve, 1));
    assert.equal(readOpenCodeAgentActivities(fixture.project)[0]?.sessionID, "lifecycle-child");
    assert.equal(readOpenCodeAgentActivities(fixture.project)[0]?.phase, "cleaning");
    const cleaning = await collectOpenCodeTeamSnapshot(fake.api, { now: () => 3_000 });
    assert.match(formatOpenCodeTeamView(cleaning, "member:reviewer"), /reviewer · run run-[A-Za-z0-9_-]{20} · delegated lifecycle · cleaning/u);
    resolveDelete();
    assert.equal(await work, "verified");
    assert.deepEqual(phases, ["starting", "working", "cleaning"]);
  } finally {
    resolveCreate();
    resolveDelete();
    await work.catch(() => undefined);
    claim.release();
    fixture.restore();
  }
});

test("OpenCode retire rechecks authoritative activity immediately before mutation", async () => {
  const fixture = await isolatedProject("harbor-opencode-retire-race-");
  try {
    const definition = {
      name: "reviewer", description: "Review risk", prompt: "Return findings", tools: ["read"], skills: [],
    };
    await runDeterministicCommand("opencode", "join", JSON.stringify(definition), fixture.project);
    const direct = nativeSession(fixture.project, "reviewer-race", "Direct", "reviewer");
    const fake = fakeApi({
      directory: fixture.project,
      sessions: [direct],
      activeSequence: [{}, { [direct.id]: { type: "running" } }],
      messages: { [direct.id]: [{ id: "reviewer-race-boundary", type: "user", text: "Review", time: { created: 1_000 } }] },
    });
    const retire = openCodeDirectCommands(fake.api).find(({ slashName }) => slashName === "harbor-retire")!;
    retire.run();
    await fake.dialogs.at(-1).onConfirm("reviewer");
    assert.equal(fake.activeReads, 2);
    assert.match(fake.dialogs.at(-1).message, /Cannot retire active member reviewer/u);
    assert.match(await runDeterministicCommand("opencode", "bench", "list", fixture.project), /reviewer \| personal \| on/u);
  } finally { fixture.restore(); }
});

test("OpenCode retire fails closed when newly active work cannot be projected", async () => {
  const fixture = await isolatedProject("harbor-opencode-retire-unresolved-active-");
  try {
    await runDeterministicCommand("opencode", "join", JSON.stringify({
      name: "reviewer", description: "Review risk", prompt: "Return findings", tools: ["read"], skills: [],
    }), fixture.project);
    const fake = fakeApi({
      directory: fixture.project,
      sessions: [],
      activeSequence: [{}, { "unresolved-active-session": { type: "running" } }],
      getSession: () => undefined,
    });
    const retire = openCodeDirectCommands(fake.api).find(({ slashName }) => slashName === "harbor-retire")!;
    retire.run();
    await fake.dialogs.at(-1).onConfirm("reviewer");
    assert.equal(fake.activeReads, 2, "retire skipped its immediate authoritative activity recheck");
    assert.match(fake.dialogs.at(-1).message, /Cannot retire while authoritative team activity is unavailable/u);
    assert.match(await runDeterministicCommand("opencode", "bench", "list", fixture.project), /reviewer \| personal \| on/u);
  } finally { fixture.restore(); }
});

test("OpenCode direct retire refuses to hide an active personal direct run", async () => {
  const fixture = await isolatedProject("harbor-opencode-retire-active-");
  try {
    const definition = {
      name: "reviewer", description: "Review risk", prompt: "Return findings", tools: ["read"], skills: [],
    };
    await runDeterministicCommand("opencode", "join", JSON.stringify(definition), fixture.project);
    const direct = nativeSession(fixture.project, "reviewer-active", "Direct", "reviewer");
    const fake = fakeApi({
      directory: fixture.project,
      sessions: [direct], active: { [direct.id]: { type: "running" } },
      messages: { [direct.id]: [{ id: "reviewer-boundary", type: "user", text: "Review", time: { created: 1_000 } }] },
    });
    const retire = openCodeDirectCommands(fake.api).find(({ slashName }) => slashName === "harbor-retire")!;
    retire.run();
    await fake.dialogs.at(-1).onConfirm("reviewer");
    assert.match(fake.dialogs.at(-1).message, /Cannot retire active member reviewer/u);
    assert.match(await runDeterministicCommand("opencode", "bench", "list", fixture.project), /reviewer \| personal \| on/u);
  } finally { fixture.restore(); }
});

test("OpenCode direct retire refuses to hide an active delegated personal child", async () => {
  const fixture = await isolatedProject("harbor-opencode-retire-delegated-");
  try {
    const definition = {
      name: "reviewer", description: "Review risk", prompt: "Return findings", tools: ["read"], skills: [],
    };
    await runDeterministicCommand("opencode", "join", JSON.stringify(definition), fixture.project);
    const sign = await prepareSignedOpenCodeHarborTitle(join(fixture.root, "home"), fixture.project, "agent", "reviewer");
    const child = nativeSession(fixture.project, "reviewer-child", sign("reviewer-child"), "reviewer");
    const fake = fakeApi({
      directory: fixture.project,
      sessions: [child], active: { [child.id]: { type: "running" } },
      messages: { [child.id]: [{ id: "reviewer-child-task", type: "user", text: "Review", time: { created: 1_000 } }] },
    });
    const retire = openCodeDirectCommands(fake.api).find(({ slashName }) => slashName === "harbor-retire")!;
    retire.run();
    await fake.dialogs.at(-1).onConfirm("reviewer");
    assert.match(fake.dialogs.at(-1).message, /Cannot retire active member reviewer; stop its run or wait/u);
    assert.match(await runDeterministicCommand("opencode", "bench", "list", fixture.project), /reviewer \| personal \| on/u);
  } finally { fixture.restore(); }
});

test("OpenCode session-list cursors do not invent truncation without an over-read item", async () => {
  const fixture = await isolatedProject("harbor-opencode-session-cursor-");
  try {
    const only = nativeSession(fixture.project, "only-session", "Ordinary", "build");
    const single = fakeApi({
      directory: fixture.project,
      sessions: [only],
      active: {},
      sessionCursor: { previous: "present-but-empty", next: "also-empty" },
    });
    const one = await collectOpenCodeTeamSnapshot(single.api);
    assert.equal(one.sessionListTruncated, false);
    assert.deepEqual(single.listLimits, [65]);

    const many = fakeApi({
      directory: fixture.project,
      sessions: Array.from({ length: 65 }, (_, index) =>
        nativeSession(fixture.project, `history-${index}`, "Ordinary", "build")),
      active: {},
    });
    const bounded = await collectOpenCodeTeamSnapshot(many.api, { maximumSessions: 64 });
    assert.equal(bounded.sessionListTruncated, true);
    assert.deepEqual(many.listLimits, [65]);
  } finally { fixture.restore(); }
});

test("OpenCode v2 message cursors do not invent lower-bound telemetry without an over-read item", async () => {
  const fixture = await isolatedProject("harbor-opencode-message-cursor-");
  try {
    const session = nativeSession(fixture.project, "message-cursor", "Direct", "crafter");
    const fake = fakeApi({
      directory: fixture.project,
      sessions: [session], active: { [session.id]: { type: "running" } },
      messageCursor: { next: "always-present", previous: "always-present" },
      messages: { [session.id]: [
        { id: "cursor-assistant", type: "assistant", agent: "crafter", time: { created: 2_000 } },
        { id: "cursor-user", type: "user", text: "Complete page", time: { created: 1_000 } },
      ] },
    });
    const snapshot = await collectOpenCodeTeamSnapshot(fake.api);
    assert.equal(snapshot.runs[0].telemetryLowerBound, false);
    assert.equal(snapshot.runs[0].observedAssistantTurnsLowerBound, false);
    assert.deepEqual(fake.messageLimits, [maximumOpenCodeMessagesPerSession + 1]);
  } finally { fixture.restore(); }
});

test("OpenCode v2 message over-read proves a bounded lower bound", async () => {
  const fixture = await isolatedProject("harbor-opencode-message-overread-");
  try {
    const session = nativeSession(fixture.project, "message-overread", "Direct", "crafter");
    const fake = fakeApi({
      directory: fixture.project,
      sessions: [session], active: { [session.id]: { type: "running" } },
      messages: { [session.id]: [
        { id: "overread-assistant", type: "assistant", agent: "crafter", time: { created: 2_000 } },
        { id: "overread-user", type: "user", text: "Older boundary", time: { created: 1_000 } },
      ] },
    });
    const snapshot = await collectOpenCodeTeamSnapshot(fake.api, { maximumMessagesPerSession: 1 });
    assert.equal(snapshot.runs[0].telemetryLowerBound, true);
    assert.equal(snapshot.runs[0].observedAssistantTurnsLowerBound, true);
    assert.deepEqual(fake.messageLimits, [2]);
  } finally { fixture.restore(); }
});

test("OpenCode rejects duplicate v2 message IDs even when one type is not projected", async () => {
  const fixture = await isolatedProject("harbor-opencode-v2-message-duplicate-");
  try {
    const session = nativeSession(fixture.project, "v2-message-duplicate", "Direct", "crafter");
    const fake = fakeApi({
      directory: fixture.project,
      sessions: [session], active: { [session.id]: { type: "running" } },
      messages: { [session.id]: [
        { id: "duplicate-message", type: "user", text: "new", time: { created: 2_000 } },
        { id: "duplicate-message", type: "system", time: { created: 1_000 } },
      ] },
    });
    const snapshot = await collectOpenCodeTeamSnapshot(fake.api, { maximumMessagesPerSession: 1 });
    assert.equal(snapshot.runs[0].turnBoundaryID, undefined);
    const result = await stopOpenCodeTeamRuns(fake.api, "all", { maximumMessagesPerSession: 1 });
    assert.deepEqual(result.stopped, []);
    assert.deepEqual(fake.interrupts, []);
  } finally { fixture.restore(); }
});

test("OpenCode rejects a malformed v2 message even when it is only the over-read item", async () => {
  const fixture = await isolatedProject("harbor-opencode-v2-message-malformed-overread-");
  try {
    const session = nativeSession(fixture.project, "v2-message-malformed-overread", "Direct", "crafter");
    const fake = fakeApi({
      directory: fixture.project,
      sessions: [session], active: { [session.id]: { type: "running" } },
      messages: { [session.id]: [
        { id: "apparently-valid-boundary", type: "user", text: "must not authorize stop", time: { created: 2_000 } },
        {},
      ] },
    });
    const snapshot = await collectOpenCodeTeamSnapshot(fake.api, { maximumMessagesPerSession: 1 });
    assert.equal(snapshot.runs[0].turnBoundaryID, undefined);
    const result = await stopOpenCodeTeamRuns(fake.api, "all", { maximumMessagesPerSession: 1 });
    assert.deepEqual(result.stopped, []);
    assert.deepEqual(fake.interrupts, []);
  } finally { fixture.restore(); }
});

test("OpenCode rejects ascending v2 messages before a replacement turn can be stopped", async () => {
  const fixture = await isolatedProject("harbor-opencode-v2-message-order-");
  try {
    const session = nativeSession(fixture.project, "v2-message-order", "Direct", "crafter");
    const fake = fakeApi({
      directory: fixture.project,
      sessions: [session], active: { [session.id]: { type: "running" } },
      messageProvider: (_id, read) => read === 1 ? [
        { id: "old-user", type: "user", text: "Old turn", time: { created: 1_000 } },
        { id: "old-assistant", type: "assistant", agent: "crafter", time: { created: 2_000 } },
      ] : [
        { id: "old-user", type: "user", text: "Old turn", time: { created: 1_000 } },
        { id: "old-assistant", type: "assistant", agent: "crafter", time: { created: 2_000 } },
        { id: "new-user", type: "user", text: "Replacement turn", time: { created: 3_000 } },
        { id: "new-assistant", type: "assistant", agent: "crafter", time: { created: 4_000 } },
      ],
    });
    const before = await collectOpenCodeTeamSnapshot(fake.api);
    assert.equal(before.runs[0].turnBoundaryID, undefined);
    const result = await stopOpenCodeTeamRuns(fake.api, "all");
    assert.deepEqual(result.stopped, []);
    assert.equal(result.failed.length, 1);
    assert.deepEqual(fake.interrupts, []);
  } finally { fixture.restore(); }
});

test("OpenCode rejects an unstable equal-time v2 message tie including over-read", async () => {
  const fixture = await isolatedProject("harbor-opencode-v2-message-tie-");
  try {
    const session = nativeSession(fixture.project, "v2-message-tie", "Direct", "crafter");
    const fake = fakeApi({
      directory: fixture.project,
      sessions: [session], active: { [session.id]: { type: "running" } },
      messages: { [session.id]: [
        { id: "a-user", type: "user", text: "Apparently current", time: { created: 2_000 } },
        { id: "z-system", type: "system", time: { created: 2_000 } },
      ] },
    });
    const snapshot = await collectOpenCodeTeamSnapshot(fake.api, { maximumMessagesPerSession: 1 });
    assert.equal(snapshot.runs[0].turnBoundaryID, undefined);
    const result = await stopOpenCodeTeamRuns(fake.api, "all", { maximumMessagesPerSession: 1 });
    assert.deepEqual(result.stopped, []);
    assert.deepEqual(fake.interrupts, []);
  } finally { fixture.restore(); }
});

test("OpenCode claim stop handles the real direct shape where SessionV2Info.agent remains build", async () => {
  const fixture = await isolatedProject("harbor-opencode-claim-direct-stop-");
  let claim: ReturnType<typeof claimOpenCodeAgentActivity> | undefined;
  try {
    const session = nativeSession(fixture.project, "real-shape-direct", "OpenCode base session", "build");
    session.directory = fixture.project;
    delete session.location;
    claim = claimOpenCodeAgentActivity(fixture.project, "reviewer", "direct", session.id);
    assert.equal(claim.setPhase("working"), true);
    const fake = fakeApi({
      directory: fixture.project,
      sessions: [session],
      active: {},
      legacyStatus: { [session.id]: { type: "busy" } },
      // OpenCode 1.18.4's V2 message projection is empty while this legacy
      // direct command is active. The exact claim is its turn-generation proof.
      messages: { [session.id]: [] },
      legacyMessages: { [session.id]: [
        legacyUserMessage(session.id, "reviewer", "real-legacy-boundary", "Review the current change"),
        legacyAssistantMessage(session.id, "reviewer", "real-legacy-assistant"),
      ] },
      abortSession: () => {
        assert.equal(claim?.release(), true);
        return response(true);
      },
    });
    const snapshot = await collectOpenCodeTeamSnapshot(fake.api);
    assert.equal(snapshot.runs[0]?.agent, "reviewer", "the exact cross-isolate claim did not correct the lagging base agent");
    assert.equal(snapshot.runs[0]?.task, "Review the current change");
    assert.deepEqual(snapshot.runs[0]?.model, { provider: "local", id: "fake-model" });
    assert.deepEqual(snapshot.runs[0]?.usage, {
      input: 11, output: 7, reasoning: 3, cacheRead: 2, cacheWrite: 1, total: 24, cost: 0.0002,
    });
    assert.doesNotMatch(JSON.stringify(snapshot), /assistant prose must never be retained/u);
    assert.deepEqual(snapshot.reservations, []);
    assert.doesNotMatch(JSON.stringify(snapshot), /real-shape-direct|claimToken|sessionID/u);
    const result = await stopOpenCodeTeamRuns(fake.api, snapshot.runs[0].id);
    assert.deepEqual(result.stopped, [snapshot.runs[0].id]);
    assert.deepEqual(result.failed, []);
    assert.deepEqual(fake.aborts, [session.id]);
    assert.deepEqual(fake.abortInputs, [{ sessionID: session.id, directory: fixture.project }]);
    assert.deepEqual(fake.messageReads, [], "claim-backed legacy work read the empty V2 message projection");
    assert.deepEqual(fake.legacyMessageReads, [session.id, session.id, session.id]);
    assert.deepEqual(readOpenCodeAgentActivities(fixture.project), []);
  } finally {
    claim?.release();
    fixture.restore();
  }
});

test("OpenCode exact stop reads no messages or mutation when the claim inventory becomes unreadable", async () => {
  const fixture = await isolatedProject("harbor-opencode-claim-inventory-failure-");
  let seed: ReturnType<typeof claimOpenCodeAgentActivity> | undefined;
  try {
    const direct = nativeSession(fixture.project, "claim-store-failure", "Direct", "crafter");
    const fake = fakeApi({
      directory: fixture.project,
      sessions: [direct],
      active: { [direct.id]: { type: "running" } },
      messages: { [direct.id]: [{ id: "claim-store-boundary", type: "user", text: "Private task", time: { created: 1_000 } }] },
    });
    const healthy = await collectOpenCodeTeamSnapshot(fake.api);
    assert.equal(fake.messageReads.length, 1);
    seed = claimOpenCodeAgentActivity(fixture.project, "design", "direct", "seed-session");
    assert.equal(seed.release(), true);
    const activityRoot = join(fixture.root, "home", "agent-foundry", "opencode-activity-v1");
    const [digest] = await readdir(activityRoot);
    await writeFile(join(activityRoot, digest, `.agent-harbor-activity-tmp-${"A".repeat(24)}`), "partial");
    await assert.rejects(
      () => stopOpenCodeTeamRuns(fake.api, healthy.runs[0].id),
      /activity-claim verification is unavailable; no session was stopped/u,
    );
    assert.equal(fake.messageReads.length, 1, "an unreadable claim overlay still authorized message content");
    assert.deepEqual(fake.aborts, []);
    assert.deepEqual(fake.interrupts, []);
  } finally {
    seed?.release();
    fixture.restore();
  }
});

test("OpenCode claim stop rejects a replaced owner generation before abort and during confirmation", async () => {
  const fixture = await isolatedProject("harbor-opencode-claim-replaced-");
  let first: ReturnType<typeof claimOpenCodeAgentActivity> | undefined;
  let replacement: ReturnType<typeof claimOpenCodeAgentActivity> | undefined;
  try {
    const session = nativeSession(fixture.project, "replace-direct", "Base", "build");
    first = claimOpenCodeAgentActivity(fixture.project, "reviewer", "direct", session.id);
    assert.equal(first.setPhase("working"), true);
    const beforeAbort = fakeApi({
      directory: fixture.project,
      sessions: [session],
      active: {},
      legacyStatus: { [session.id]: { type: "busy" } },
      messages: { [session.id]: [{ id: "replace-boundary", type: "user", text: "Review", time: { created: 1_000 } }] },
      legacyMessages: { [session.id]: [
        legacyUserMessage(session.id, "reviewer", "replace-boundary", "Review"),
      ] },
      getSession: () => {
        assert.equal(first?.release(), true);
        replacement = claimOpenCodeAgentActivity(fixture.project, "reviewer", "direct", session.id);
        replacement.setPhase("working");
        return session;
      },
    });
    const beforeSnapshot = await collectOpenCodeTeamSnapshot(beforeAbort.api);
    const blocked = await stopOpenCodeTeamRuns(beforeAbort.api, beforeSnapshot.runs.find(({ agent }) => agent === "reviewer")!.id, { collectionDeadlineMs: 120 });
    assert.equal(blocked.stopped.length, 0);
    assert.equal(blocked.failed.length, 1);
    assert.deepEqual(beforeAbort.aborts, []);

    assert.equal(replacement.release(), true);
    first = claimOpenCodeAgentActivity(fixture.project, "reviewer", "direct", session.id);
    first.setPhase("working");
    const afterAbort = fakeApi({
      directory: fixture.project,
      sessions: [session],
      active: {},
      legacyStatus: { [session.id]: { type: "busy" } },
      messages: { [session.id]: [{ id: "replace-boundary-2", type: "user", text: "Review", time: { created: 2_000 } }] },
      legacyMessages: { [session.id]: [
        legacyUserMessage(session.id, "reviewer", "replace-boundary-2", "Review", 2_000),
      ] },
      abortSession: () => {
        assert.equal(first?.release(), true);
        replacement = claimOpenCodeAgentActivity(fixture.project, "reviewer", "direct", session.id);
        replacement.setPhase("working");
        return response(true);
      },
    });
    const afterSnapshot = await collectOpenCodeTeamSnapshot(afterAbort.api);
    const unconfirmed = await stopOpenCodeTeamRuns(afterAbort.api, afterSnapshot.runs.find(({ agent }) => agent === "reviewer")!.id, {
      rpcDeadlineMs: 30,
      collectionDeadlineMs: 100,
    });
    assert.equal(unconfirmed.stopped.length, 0);
    assert.equal(unconfirmed.failed.length, 0);
    assert.equal(unconfirmed.pendingConfirmation?.length, 1,
      "a replacement generation was mistaken for confirmed absence");
    assert.deepEqual(afterAbort.aborts, [session.id]);
  } finally {
    replacement?.release();
    first?.release();
    fixture.restore();
  }
});

test("OpenCode claim stop rejects a heartbeat that expires during the ownership recheck", async () => {
  const fixture = await isolatedProject("harbor-opencode-claim-heartbeat-race-");
  let claim: ReturnType<typeof claimOpenCodeAgentActivity> | undefined;
  try {
    const session = nativeSession(fixture.project, "heartbeat-race", "Base", "build");
    claim = claimOpenCodeAgentActivity(fixture.project, "reviewer", "direct", session.id);
    claim.setPhase("working");
    const activityRoot = join(fixture.root, "home", "agent-foundry", "opencode-activity-v1");
    const [digest] = await readdir(activityRoot);
    const claimFile = join(activityRoot, digest, "reviewer.json");
    const fake = fakeApi({
      directory: fixture.project,
      sessions: [session], active: {},
      legacyStatus: { [session.id]: { type: "busy" } },
      legacyMessages: { [session.id]: [legacyUserMessage(session.id, "reviewer", "heartbeat-boundary", "Review")] },
      getSession: async () => {
        const stale = new Date(Date.now() - 31_000);
        await utimes(claimFile, stale, stale);
        return session;
      },
    });
    const snapshot = await collectOpenCodeTeamSnapshot(fake.api);
    const result = await stopOpenCodeTeamRuns(fake.api, snapshot.runs[0].id);
    assert.deepEqual(result.stopped, []);
    assert.deepEqual(result.failed, [snapshot.runs[0].id]);
    assert.deepEqual(fake.aborts, []);
  } finally {
    claim?.release();
    fixture.restore();
  }
});

test("OpenCode ambiguous same-session claims revoke message fanout before classification", async () => {
  const fixture = await isolatedProject("harbor-opencode-claim-collision-fanout-");
  let first: ReturnType<typeof claimOpenCodeAgentActivity> | undefined;
  try {
    const session = nativeSession(fixture.project, "collision-fanout", "Ordinary", "crafter");
    first = claimOpenCodeAgentActivity(fixture.project, "reviewer", "direct", session.id);
    first.setPhase("working");
    // The public claim API now prevents this state atomically. Preserve the
    // adversarial reader coverage by forging a second, canonical-looking file
    // as a corrupt/foreign writer could, then prove no private message fanout
    // or stop mutation is attempted for the ambiguous native identity.
    const activityRoot = join(fixture.root, "home", "agent-foundry", "opencode-activity-v1");
    const [projectDigest] = await readdir(activityRoot);
    assert.ok(projectDigest);
    const projectClaims = join(activityRoot, projectDigest);
    const forged = JSON.parse(await readFile(join(projectClaims, "reviewer.json"), "utf8"));
    forged.agent = "design";
    forged.claimToken = "B".repeat(24);
    await writeFile(join(projectClaims, "design.json"), JSON.stringify(forged), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    const fake = fakeApi({
      directory: fixture.project,
      sessions: [session],
      active: { [session.id]: { type: "running" } },
      legacyStatus: { [session.id]: { type: "busy" } },
      messages: { [session.id]: [{ id: "collision-v2-boundary", type: "user", text: "private v2 task" }] },
      legacyMessages: { [session.id]: [legacyUserMessage(session.id, "crafter", "collision-legacy-boundary", "private legacy task")] },
    });
    const snapshot = await collectOpenCodeTeamSnapshot(fake.api);
    assert.deepEqual(snapshot.runs, []);
    assert.equal(snapshot.reservations.length, 2);
    assert.ok(snapshot.reservations.every(({ stopBlockReason }) => stopBlockReason === "ambiguous-identity"));
    assert.deepEqual(fake.messageReads, []);
    assert.deepEqual(fake.legacyMessageReads, []);
    const result = await stopOpenCodeTeamRuns(fake.api, "all");
    assert.deepEqual(result.stopped, []);
    assert.deepEqual(fake.aborts, []);
    assert.deepEqual(fake.interrupts, []);
  } finally {
    first?.release();
    fixture.restore();
  }
});

test("OpenCode discards message content when an unclaimed session gains a claim during fanout", async () => {
  const fixture = await isolatedProject("harbor-opencode-claim-during-fanout-");
  let competitor: ReturnType<typeof claimOpenCodeAgentActivity> | undefined;
  try {
    const session = nativeSession(fixture.project, "claim-during-fanout", "Ordinary", "crafter");
    const secret = "fanout-secret-must-not-enter-snapshot";
    const fake = fakeApi({
      directory: fixture.project,
      sessions: [session], active: {},
      legacyStatus: { [session.id]: { type: "busy" } },
      legacyMessageProvider: () => {
        competitor = claimOpenCodeAgentActivity(fixture.project, "crafter", "direct", session.id);
        competitor.setPhase("working");
        return [legacyUserMessage(session.id, "crafter", "fanout-race-boundary", secret)];
      },
    });
    const snapshot = await collectOpenCodeTeamSnapshot(fake.api);
    assert.deepEqual(snapshot.runs, []);
    assert.equal(snapshot.reservations[0].stopBlockReason, "claim-changed");
    assert.doesNotMatch(JSON.stringify(snapshot), new RegExp(secret, "u"));
    assert.match(snapshot.degradedReasons.join("\n"), /claim generations changed during message inspection/u);
    assert.deepEqual(fake.aborts, []);
    assert.deepEqual(fake.interrupts, []);
  } finally {
    competitor?.release();
    fixture.restore();
  }
});

test("OpenCode applies one final claim barrier after every concurrent message read", async () => {
  const fixture = await isolatedProject("harbor-opencode-final-claim-barrier-");
  let lateClaim: ReturnType<typeof claimOpenCodeAgentActivity> | undefined;
  let releaseSecond: ((messages: any[]) => void) | undefined;
  try {
    const first = nativeSession(fixture.project, "barrier-first", "First", "crafter");
    const second = nativeSession(fixture.project, "barrier-second", "Second", "design");
    const firstSecret = "first-result-secret-after-early-validation";
    const fake = fakeApi({
      directory: fixture.project,
      sessions: [first, second],
      active: { [first.id]: { type: "running" }, [second.id]: { type: "running" } },
      messageProvider: (sessionID) => sessionID === first.id
        ? [{ id: "barrier-first-user", type: "user", text: firstSecret, time: { created: 1_000 } }]
        : new Promise<any[]>((resolve) => { releaseSecond = resolve; }),
    });
    const collecting = collectOpenCodeTeamSnapshot(fake.api);
    for (let attempt = 0; attempt < 40 && !releaseSecond; attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 2));
    }
    assert.ok(releaseSecond, "the second message read did not reach its barrier");
    lateClaim = claimOpenCodeAgentActivity(fixture.project, "crafter", "direct", first.id);
    lateClaim.setPhase("working");
    releaseSecond([{ id: "barrier-second-user", type: "user", text: "safe second task", time: { created: 1_000 } }]);
    const snapshot = await collecting;
    assert.doesNotMatch(JSON.stringify(snapshot), new RegExp(firstSecret, "u"));
    assert.equal(snapshot.runs.some(({ id }) => id === snapshot.reservations.find(({ stopBlockReason }) => stopBlockReason === "claim-changed")?.id), false);
    assert.equal(snapshot.reservations.some(({ stopBlockReason }) => stopBlockReason === "claim-changed"), true);
  } finally {
    lateClaim?.release();
    fixture.restore();
  }
});

test("OpenCode ignores a delegated-starting child claim when proving its working lead", async () => {
  const fixture = await isolatedProject("harbor-opencode-lead-with-starting-child-");
  let lead: ReturnType<typeof claimOpenCodeAgentActivity> | undefined;
  let child: ReturnType<typeof claimOpenCodeAgentActivity> | undefined;
  try {
    const session = nativeSession(fixture.project, "lead-with-starting-child", "Base", "build");
    lead = claimOpenCodeAgentActivity(fixture.project, "reviewer", "direct", session.id);
    lead.setPhase("working");
    child = claimOpenCodeAgentActivity(fixture.project, "design", "delegated", session.id);
    const fake = fakeApi({
      directory: fixture.project,
      sessions: [session], active: {},
      legacyStatus: { [session.id]: { type: "busy" } },
      legacyMessages: { [session.id]: [legacyUserMessage(session.id, "reviewer", "lead-boundary", "Lead work")] },
      abortSession: () => {
        assert.equal(lead?.release(), true);
        return response(true);
      },
    });
    const snapshot = await collectOpenCodeTeamSnapshot(fake.api);
    assert.equal(snapshot.runs[0]?.agent, "reviewer");
    assert.equal(snapshot.reservations.find(({ agent }) => agent === "design")?.id, undefined);
    const result = await stopOpenCodeTeamRuns(fake.api, snapshot.runs[0].id);
    assert.deepEqual(result.stopped, [snapshot.runs[0].id]);
    assert.deepEqual(fake.aborts, [session.id]);
  } finally {
    child?.release();
    lead?.release();
    fixture.restore();
  }
});

test("OpenCode claim stop rejects a competing same-session claim created during recheck", async () => {
  const fixture = await isolatedProject("harbor-opencode-claim-collision-race-");
  let claim: ReturnType<typeof claimOpenCodeAgentActivity> | undefined;
  let competitor: ReturnType<typeof claimOpenCodeAgentActivity> | undefined;
  try {
    const session = nativeSession(fixture.project, "collision-race", "Base", "build");
    claim = claimOpenCodeAgentActivity(fixture.project, "reviewer", "direct", session.id);
    claim.setPhase("working");
    const fake = fakeApi({
      directory: fixture.project,
      sessions: [session], active: {},
      legacyStatus: { [session.id]: { type: "busy" } },
      legacyMessages: { [session.id]: [legacyUserMessage(session.id, "reviewer", "collision-boundary", "Review")] },
      getSession: () => {
        competitor = claimOpenCodeAgentActivity(fixture.project, "design", "direct", session.id);
        competitor.setPhase("working");
        return session;
      },
    });
    const snapshot = await collectOpenCodeTeamSnapshot(fake.api);
    const result = await stopOpenCodeTeamRuns(fake.api, snapshot.runs[0].id);
    assert.deepEqual(result.stopped, []);
    assert.deepEqual(result.failed, [snapshot.runs[0].id]);
    assert.deepEqual(fake.aborts, []);
  } finally {
    competitor?.release();
    claim?.release();
    fixture.restore();
  }
});

test("OpenCode delegated claim stop verifies signed child provenance and terminal claim release", async () => {
  const fixture = await isolatedProject("harbor-opencode-claim-child-stop-");
  let claim: ReturnType<typeof claimOpenCodeAgentActivity> | undefined;
  try {
    const sign = await prepareSignedOpenCodeHarborTitle(join(fixture.root, "home"), fixture.project, "agent", "reviewer");
    const child = nativeSession(fixture.project, "claimed-child", sign("claimed-child"), "reviewer");
    claim = claimOpenCodeAgentActivity(fixture.project, "reviewer", "delegated", "lead-owner");
    assert.equal(claim.setSessionID(child.id), true);
    assert.equal(claim.setPhase("working"), true);
    const fake = fakeApi({
      directory: fixture.project,
      sessions: [child],
      active: {},
      legacyStatus: { [child.id]: { type: "busy" } },
      messages: { [child.id]: [{ id: "child-boundary", type: "user", text: "Review", time: { created: 1_000 } }] },
      legacyMessages: { [child.id]: [
        legacyUserMessage(child.id, "reviewer", "child-boundary", "Review"),
      ] },
      abortSession: () => {
        assert.equal(claim?.release(), true);
        return response(true);
      },
    });
    const snapshot = await collectOpenCodeTeamSnapshot(fake.api);
    assert.equal(snapshot.runs[0]?.agent, "reviewer");
    const result = await stopOpenCodeTeamRuns(fake.api, snapshot.runs[0].id);
    assert.deepEqual(result.stopped, [snapshot.runs[0].id]);
    assert.deepEqual(fake.aborts, [child.id]);
  } finally {
    claim?.release();
    fixture.restore();
  }
});

test("OpenCode discovers and stops a legacy contract child without relying on V2 active state", async () => {
  const fixture = await isolatedProject("harbor-opencode-legacy-contract-");
  try {
    const sign = await prepareSignedOpenCodeHarborTitle(
      join(fixture.root, "home"), fixture.project, "contract", "release-audit",
    );
    const child = nativeSession(fixture.project, "legacy-contract-child", sign("legacy-contract-child"), "explore");
    const fake = fakeApi({
      directory: fixture.project,
      sessions: [child],
      active: {},
      legacyStatus: { [child.id]: { type: "busy" } },
      messages: { [child.id]: [] },
      legacyMessages: { [child.id]: [
        legacyUserMessage(child.id, "explore", "contract-boundary", "Contract policy\nTask:\nAudit the release"),
      ] },
    });
    const snapshot = await collectOpenCodeTeamSnapshot(fake.api);
    assert.equal(snapshot.runs.length, 1);
    assert.equal(snapshot.runs[0].agent, "release-audit");
    assert.equal(snapshot.runs[0].invocation, "contract");
    assert.equal(snapshot.runs[0].task, "Audit the release");
    assert.deepEqual(snapshot.reservations, []);
    const result = await stopOpenCodeTeamRuns(fake.api, snapshot.runs[0].id);
    assert.deepEqual(result.stopped, [snapshot.runs[0].id]);
    assert.deepEqual(fake.aborts, [child.id]);
    assert.deepEqual(fake.interrupts, []);
    assert.deepEqual(fake.messageReads, []);
  } finally { fixture.restore(); }
});

test("OpenCode shows an unclaimed dual-engine run as blocked without reading or mutating it", async () => {
  const fixture = await isolatedProject("harbor-opencode-dual-registry-");
  try {
    const direct = nativeSession(fixture.project, "dual-registry", "Direct", "crafter");
    const fake = fakeApi({
      directory: fixture.project,
      sessions: [direct],
      active: { [direct.id]: { type: "running" } },
      legacyStatus: { [direct.id]: { type: "busy" } },
      messages: { [direct.id]: [{ id: "v2-private", type: "user", text: "v2 private", time: { created: 1_000 } }] },
      legacyMessages: { [direct.id]: [legacyUserMessage(direct.id, "crafter", "v1-private", "v1 private")] },
    });
    const snapshot = await collectOpenCodeTeamSnapshot(fake.api);
    assert.deepEqual(snapshot.runs, []);
    assert.equal(snapshot.reservations.length, 1);
    assert.equal(snapshot.reservations[0].stopBlockReason, "dual-engine");
    assert.match(snapshot.reservations[0].id!, /^run-[A-Za-z0-9_-]{20}$/u);
    assert.deepEqual(fake.messageReads, []);
    assert.deepEqual(fake.legacyMessageReads, []);
    assert.match(snapshot.degradedReasons.join("\n"), /both OpenCode run registries/u);
    const result = await stopOpenCodeTeamRuns(fake.api, "all");
    assert.deepEqual(result.stopped, []);
    assert.deepEqual(result.engineAuthorityUnavailable, [snapshot.reservations[0].id]);
    assert.deepEqual(fake.aborts, []);
    assert.deepEqual(fake.interrupts, []);
  } finally { fixture.restore(); }
});

test("OpenCode blocks a claimed dual-engine run before claim-backed legacy stop", async () => {
  const fixture = await isolatedProject("harbor-opencode-claimed-dual-engine-");
  let claim: ReturnType<typeof claimOpenCodeAgentActivity> | undefined;
  try {
    const session = nativeSession(fixture.project, "claimed-dual-engine", "Base", "build");
    claim = claimOpenCodeAgentActivity(fixture.project, "reviewer", "direct", session.id);
    claim.setPhase("working");
    const fake = fakeApi({
      directory: fixture.project,
      sessions: [session],
      active: { [session.id]: { type: "running" } },
      legacyStatus: { [session.id]: { type: "busy" } },
      messages: { [session.id]: [{ id: "claimed-dual-v2", type: "user", text: "private v2 task" }] },
      legacyMessages: { [session.id]: [legacyUserMessage(session.id, "reviewer", "claimed-dual-v1", "private legacy task")] },
    });
    const snapshot = await collectOpenCodeTeamSnapshot(fake.api);
    assert.deepEqual(snapshot.runs, []);
    assert.equal(snapshot.reservations.length, 1);
    assert.equal(snapshot.reservations[0].stopBlockReason, "dual-engine");
    assert.deepEqual(fake.messageReads, []);
    assert.deepEqual(fake.legacyMessageReads, []);
    const result = await stopOpenCodeTeamRuns(fake.api, snapshot.reservations[0].id!);
    assert.deepEqual(result.engineAuthorityUnavailable, [snapshot.reservations[0].id]);
    assert.deepEqual(fake.aborts, []);
    assert.deepEqual(fake.interrupts, []);
  } finally {
    claim?.release();
    fixture.restore();
  }
});

test("OpenCode shows a signed dual-engine contract without exposing its message content", async () => {
  const fixture = await isolatedProject("harbor-opencode-signed-dual-engine-");
  try {
    const sign = await prepareSignedOpenCodeHarborTitle(
      join(fixture.root, "home"), fixture.project, "contract", "dual-auditor",
    );
    const session = nativeSession(fixture.project, "signed-dual-engine", sign("signed-dual-engine"), "explore");
    const fake = fakeApi({
      directory: fixture.project,
      sessions: [session],
      active: { [session.id]: { type: "running" } },
      legacyStatus: { [session.id]: { type: "busy" } },
      messages: { [session.id]: [{ id: "signed-dual-v2", type: "user", text: "v2 secret" }] },
      legacyMessages: { [session.id]: [legacyUserMessage(session.id, "explore", "signed-dual-v1", "legacy secret")] },
    });
    const snapshot = await collectOpenCodeTeamSnapshot(fake.api);
    assert.deepEqual(snapshot.runs, []);
    assert.equal(snapshot.reservations[0].invocation, "contract");
    assert.equal(snapshot.reservations[0].stopBlockReason, "dual-engine");
    assert.doesNotMatch(JSON.stringify(snapshot), /v2 secret|legacy secret/u);
    assert.deepEqual(fake.messageReads, []);
    assert.deepEqual(fake.legacyMessageReads, []);
    const result = await stopOpenCodeTeamRuns(fake.api, snapshot.reservations[0].id!);
    assert.deepEqual(result.engineAuthorityUnavailable, [snapshot.reservations[0].id]);
    assert.deepEqual(fake.aborts, []);
    assert.deepEqual(fake.interrupts, []);
  } finally { fixture.restore(); }
});

test("OpenCode blocks a legacy target whose authority switches to v2 during the final recheck", async () => {
  const fixture = await isolatedProject("harbor-opencode-legacy-to-dual-");
  let claim: ReturnType<typeof claimOpenCodeAgentActivity> | undefined;
  try {
    const session = nativeSession(fixture.project, "legacy-to-dual", "Base", "build");
    claim = claimOpenCodeAgentActivity(fixture.project, "reviewer", "direct", session.id);
    claim.setPhase("working");
    const fake = fakeApi({
      directory: fixture.project,
      sessions: [session],
      activeProvider: (read) => read >= 3 ? { [session.id]: { type: "running" } } : {},
      legacyStatusProvider: (read) => read >= 3 ? {} : { [session.id]: { type: "busy" } },
      legacyMessages: { [session.id]: [legacyUserMessage(session.id, "reviewer", "legacy-to-dual-boundary", "Review")] },
    });
    const snapshot = await collectOpenCodeTeamSnapshot(fake.api);
    const result = await stopOpenCodeTeamRuns(fake.api, snapshot.runs[0].id);
    assert.deepEqual(result.engineAuthorityUnavailable, [snapshot.runs[0].id]);
    assert.deepEqual(result.alreadyIdle, []);
    assert.match(formatOpenCodeStopResult(result), /engine authority changed or is ambiguous.*non-owning engine/su);
    assert.deepEqual(fake.aborts, []);
    assert.deepEqual(fake.interrupts, []);
  } finally {
    claim?.release();
    fixture.restore();
  }
});

test("OpenCode blocks a v2 target whose authority switches to legacy during the final recheck", async () => {
  const fixture = await isolatedProject("harbor-opencode-v2-to-dual-");
  try {
    const session = nativeSession(fixture.project, "v2-to-dual", "Direct", "crafter");
    const fake = fakeApi({
      directory: fixture.project,
      sessions: [session],
      activeProvider: (read) => read >= 3 ? {} : { [session.id]: { type: "running" } },
      legacyStatusProvider: (read) => read >= 3 ? { [session.id]: { type: "busy" } } : {},
      messages: { [session.id]: [{ id: "v2-to-dual-boundary", type: "user", text: "Review" }] },
    });
    const snapshot = await collectOpenCodeTeamSnapshot(fake.api);
    const result = await stopOpenCodeTeamRuns(fake.api, snapshot.runs[0].id);
    assert.deepEqual(result.engineAuthorityUnavailable, [snapshot.runs[0].id]);
    assert.deepEqual(fake.aborts, []);
    assert.deepEqual(fake.interrupts, []);
  } finally { fixture.restore(); }
});

test("OpenCode disables exact v2 stop when legacy cannot prove the same ID absent", async () => {
  const fixture = await isolatedProject("harbor-opencode-v2-only-authority-");
  try {
    const direct = nativeSession(fixture.project, "v2-only-authority", "Direct", "crafter");
    const fake = fakeApi({
      directory: fixture.project,
      sessions: [direct],
      active: { [direct.id]: { type: "running" } },
      hangLegacyStatus: true,
      messages: { [direct.id]: [{ id: "v2-only-boundary", type: "user", text: "Stop v2 work", time: { created: 1_000 } }] },
    });
    const options = { rpcDeadlineMs: 15, collectionDeadlineMs: 80 };
    const snapshot = await collectOpenCodeTeamSnapshot(fake.api, options);
    assert.equal(snapshot.runs.length, 1);
    assert.equal(snapshot.activeAuthoritative, false);
    assert.equal(snapshot.exactStopAvailable, false);
    assert.match(formatOpenCodeTeamView(snapshot), /stop in the \/team prompt is disabled/u);
    await assert.rejects(
      () => stopOpenCodeTeamRuns(fake.api, snapshot.runs[0].id, options),
      /legacy session-status recheck failed; no session was stopped/u,
    );
    assert.deepEqual(fake.interrupts, []);
    assert.deepEqual(fake.aborts, []);
  } finally { fixture.restore(); }
});

test("OpenCode direct starting claims stay visible but issue no premature legacy abort", async () => {
  const fixture = await isolatedProject("harbor-opencode-direct-starting-");
  let claim: ReturnType<typeof claimOpenCodeAgentActivity> | undefined;
  try {
    const session = nativeSession(fixture.project, "starting-direct", "Base", "build");
    claim = claimOpenCodeAgentActivity(fixture.project, "reviewer", "direct", session.id);
    const fake = fakeApi({
      directory: fixture.project,
      sessions: [session],
      active: {},
      legacyStatus: { [session.id]: { type: "busy" } },
      legacyMessages: { [session.id]: [legacyUserMessage(session.id, "reviewer", "starting-boundary", "Review")] },
    });
    const snapshot = await collectOpenCodeTeamSnapshot(fake.api);
    assert.deepEqual(snapshot.runs, []);
    const reservation = snapshot.reservations.find(({ agent }) => agent === "reviewer")!;
    assert.equal(reservation.phase, "starting");
    assert.equal(reservation.stopAvailable, false);
    assert.equal(reservation.stopBlockReason, "lifecycle-transition");
    assert.deepEqual(fake.legacyMessageReads, []);
    const result = await stopOpenCodeTeamRuns(fake.api, reservation.id!);
    assert.deepEqual(result.lifecycleTransition, [reservation.id]);
    assert.deepEqual(fake.aborts, []);
  } finally {
    claim?.release();
    fixture.restore();
  }
});

test("OpenCode working claims wait for an authoritative legacy runner before stop", async () => {
  const fixture = await isolatedProject("harbor-opencode-working-without-runner-");
  let claim: ReturnType<typeof claimOpenCodeAgentActivity> | undefined;
  try {
    const session = nativeSession(fixture.project, "working-without-runner", "Base", "build");
    claim = claimOpenCodeAgentActivity(fixture.project, "reviewer", "direct", session.id);
    claim.setPhase("working");
    const fake = fakeApi({
      directory: fixture.project,
      sessions: [session], active: {}, legacyStatus: {},
      legacyMessages: { [session.id]: [legacyUserMessage(session.id, "reviewer", "unpublished-boundary", "Review")] },
    });
    const snapshot = await collectOpenCodeTeamSnapshot(fake.api);
    assert.deepEqual(snapshot.runs, []);
    assert.equal(snapshot.reservations.length, 1);
    assert.equal(snapshot.reservations[0].stopAvailable, false);
    assert.equal(snapshot.reservations[0].stopBlockReason, "native-run-pending");
    assert.deepEqual(fake.legacyMessageReads, []);
    const result = await stopOpenCodeTeamRuns(fake.api, snapshot.reservations[0].id!);
    assert.deepEqual(result.failed, []);
    assert.deepEqual(result.nativeRunPending, [snapshot.reservations[0].id]);
    assert.deepEqual(fake.aborts, []);
    assert.match(formatOpenCodeStopResult(result), /Native runner not currently visible.*Lifecycle state is still\s+reconciling; no stop was attempted\. Run \/team again after it settles/su);
  } finally {
    claim?.release();
    fixture.restore();
  }
});

test("OpenCode legacy abort ACK remains unconfirmed while provider status is still busy", async () => {
  const fixture = await isolatedProject("harbor-opencode-legacy-still-busy-");
  let claim: ReturnType<typeof claimOpenCodeAgentActivity> | undefined;
  try {
    const session = nativeSession(fixture.project, "still-busy", "Base", "build");
    claim = claimOpenCodeAgentActivity(fixture.project, "reviewer", "direct", session.id);
    claim.setPhase("working");
    const fake = fakeApi({
      directory: fixture.project,
      sessions: [session], active: {},
      legacyStatus: { [session.id]: { type: "busy" } },
      legacyMessages: { [session.id]: [legacyUserMessage(session.id, "reviewer", "busy-boundary", "Review")] },
      stayActiveAfterAbort: true,
      abortSession: () => response(true),
    });
    const snapshot = await collectOpenCodeTeamSnapshot(fake.api);
    const result = await stopOpenCodeTeamRuns(fake.api, snapshot.runs[0].id, {
      rpcDeadlineMs: 20, collectionDeadlineMs: 70,
    });
    assert.deepEqual(result.stopped, []);
    assert.deepEqual(result.failed, []);
    assert.deepEqual(result.pendingConfirmation, [snapshot.runs[0].id]);
    assert.deepEqual(fake.aborts, [session.id]);
    const duplicate = await stopOpenCodeTeamRuns(fake.api, snapshot.runs[0].id, {
      rpcDeadlineMs: 20, collectionDeadlineMs: 70,
    });
    assert.deepEqual(duplicate.pendingConfirmation, [snapshot.runs[0].id]);
    assert.deepEqual(fake.aborts, [session.id], "an ACK without terminal proof was mutated twice");
  } finally {
    claim?.release();
    fixture.restore();
  }
});

test("OpenCode concurrent stop callers issue exactly one host mutation", async () => {
  const fixture = await isolatedProject("harbor-opencode-concurrent-stop-");
  let claim: ReturnType<typeof claimOpenCodeAgentActivity> | undefined;
  let acceptAbort: (() => void) | undefined;
  try {
    const session = nativeSession(fixture.project, "concurrent-stop", "Base", "build");
    claim = claimOpenCodeAgentActivity(fixture.project, "reviewer", "direct", session.id);
    claim.setPhase("working");
    const fake = fakeApi({
      directory: fixture.project,
      sessions: [session], active: {},
      legacyStatus: { [session.id]: { type: "busy" } },
      legacyMessages: { [session.id]: [legacyUserMessage(session.id, "reviewer", "concurrent-boundary", "Review")] },
      abortSession: () => new Promise((resolve) => {
        acceptAbort = () => {
          assert.equal(claim?.release(), true);
          resolve(response(true));
        };
      }),
    });
    const snapshot = await collectOpenCodeTeamSnapshot(fake.api);
    const options = { rpcDeadlineMs: 100, collectionDeadlineMs: 250 };
    const first = stopOpenCodeTeamRuns(fake.api, snapshot.runs[0].id, options);
    const second = stopOpenCodeTeamRuns(fake.api, snapshot.runs[0].id, options);
    for (let attempt = 0; attempt < 40 && fake.aborts.length === 0; attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    assert.deepEqual(fake.aborts, [session.id]);
    assert.ok(acceptAbort, "the accepted mutation was never reached");
    acceptAbort();
    const outcomes = await Promise.all([first, second]);
    assert.equal(outcomes.filter(({ stopped }) => stopped.length === 1).length, 1);
    assert.equal(outcomes.filter(({ pendingConfirmation }) => pendingConfirmation?.length === 1).length, 1);
    assert.deepEqual(fake.aborts, [session.id], "concurrent callers crossed the one-shot mutation guard");
  } finally {
    claim?.release();
    fixture.restore();
  }
});

test("OpenCode keeps a tombstone while an older stop call is still collecting its snapshot", async () => {
  const fixture = await isolatedProject("harbor-opencode-slow-concurrent-stop-");
  try {
    const session = nativeSession(fixture.project, "slow-concurrent-stop", "Direct", "crafter");
    const seed = fakeApi({
      directory: fixture.project,
      sessions: [session], active: { [session.id]: { type: "running" } }, legacyStatus: {},
      messages: { [session.id]: [{ id: "slow-concurrent-boundary", type: "user", text: "Stop" }] },
    });
    const publicID = (await collectOpenCodeTeamSnapshot(seed.api)).runs[0].id;
    const slow = fakeApi({
      directory: fixture.project,
      sessions: [session], active: { [session.id]: { type: "running" } }, legacyStatus: {},
      messages: { [session.id]: [{ id: "slow-concurrent-boundary", type: "user", text: "Stop" }] },
    });
    const fast = fakeApi({
      directory: fixture.project,
      sessions: [session], active: { [session.id]: { type: "running" } }, legacyStatus: {},
      messages: { [session.id]: [{ id: "slow-concurrent-boundary", type: "user", text: "Stop" }] },
    });
    const originalList = slow.api.client.v2.session.list;
    let releaseList: (() => void) | undefined;
    slow.api.client.v2.session.list = (request: unknown, transport: unknown) => new Promise((resolve) => {
      releaseList = () => { void Promise.resolve(originalList(request, transport)).then(resolve); };
    });
    const older = stopOpenCodeTeamRuns(slow.api, publicID, { rpcDeadlineMs: 200, collectionDeadlineMs: 500 });
    for (let attempt = 0; attempt < 40 && !releaseList; attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 2));
    }
    assert.ok(releaseList, "the older stop did not enter its initial snapshot");
    const accepted = await stopOpenCodeTeamRuns(fast.api, publicID, { rpcDeadlineMs: 100, collectionDeadlineMs: 300 });
    assert.deepEqual(accepted.stopped, [publicID]);
    await collectOpenCodeTeamSnapshot(fast.api);
    releaseList();
    const olderResult = await older;
    assert.deepEqual(olderResult.pendingConfirmation, [publicID]);
    assert.deepEqual(slow.interrupts, []);
    assert.deepEqual(fast.interrupts, [session.id]);
  } finally { fixture.restore(); }
});

test("OpenCode legacy terminal status does not confirm stop while the exact claim remains", async () => {
  const fixture = await isolatedProject("harbor-opencode-legacy-claim-remains-");
  let claim: ReturnType<typeof claimOpenCodeAgentActivity> | undefined;
  try {
    const session = nativeSession(fixture.project, "claim-remains", "Base", "build");
    claim = claimOpenCodeAgentActivity(fixture.project, "reviewer", "direct", session.id);
    claim.setPhase("working");
    const fake = fakeApi({
      directory: fixture.project,
      sessions: [session], active: {},
      legacyStatus: { [session.id]: { type: "busy" } },
      legacyMessages: { [session.id]: [legacyUserMessage(session.id, "reviewer", "claim-boundary", "Review")] },
      abortSession: () => response(true),
    });
    const snapshot = await collectOpenCodeTeamSnapshot(fake.api);
    const result = await stopOpenCodeTeamRuns(fake.api, snapshot.runs[0].id, {
      rpcDeadlineMs: 20, collectionDeadlineMs: 70,
    });
    assert.deepEqual(result.stopped, []);
    assert.deepEqual(result.failed, []);
    assert.deepEqual(result.pendingConfirmation, [snapshot.runs[0].id]);
    assert.equal(readOpenCodeAgentActivities(fixture.project)[0]?.claimToken, claim.snapshot.claimToken);
    assert.deepEqual(fake.aborts, [session.id]);
    const duplicate = await stopOpenCodeTeamRuns(fake.api, snapshot.runs[0].id, {
      rpcDeadlineMs: 20, collectionDeadlineMs: 70,
    });
    assert.deepEqual(duplicate.failed, []);
    assert.deepEqual(duplicate.pendingConfirmation, [snapshot.runs[0].id]);
    assert.deepEqual(fake.aborts, [session.id], "a live claim routed a retained tombstone through generic retry logic");
  } finally {
    claim?.release();
    fixture.restore();
  }
});

test("OpenCode never retries a legacy abort whose worker response arrives after the local deadline", async () => {
  const fixture = await isolatedProject("harbor-opencode-late-abort-");
  let claim: ReturnType<typeof claimOpenCodeAgentActivity> | undefined;
  try {
    const session = nativeSession(fixture.project, "late-abort", "Base", "build");
    claim = claimOpenCodeAgentActivity(fixture.project, "reviewer", "direct", session.id);
    claim.setPhase("working");
    const fake = fakeApi({
      directory: fixture.project,
      sessions: [session], active: {},
      legacyStatus: { [session.id]: { type: "busy" } },
      legacyMessages: { [session.id]: [legacyUserMessage(session.id, "reviewer", "late-boundary", "Review")] },
      abortSession: () => new Promise((resolve) => setTimeout(() => {
        assert.equal(claim?.release(), true);
        resolve(response(true));
      }, 100)),
    });
    const snapshot = await collectOpenCodeTeamSnapshot(fake.api);
    const result = await stopOpenCodeTeamRuns(fake.api, snapshot.runs[0].id, {
      rpcDeadlineMs: 10, collectionDeadlineMs: 40,
    });
    assert.deepEqual(result.stopped, []);
    assert.deepEqual(result.failed, []);
    assert.deepEqual(result.pendingConfirmation, [snapshot.runs[0].id]);
    assert.deepEqual(fake.aborts, [session.id]);
    const duplicate = await stopOpenCodeTeamRuns(fake.api, snapshot.runs[0].id, {
      rpcDeadlineMs: 10, collectionDeadlineMs: 40,
    });
    assert.deepEqual(duplicate.pendingConfirmation, [snapshot.runs[0].id]);
    assert.deepEqual(fake.aborts, [session.id], "a second stop duplicated an unresolved worker mutation");
    await new Promise((resolve) => setTimeout(resolve, 130));
    assert.deepEqual(fake.aborts, [session.id], "a timed-out mutation was retried after its late response");
    assert.deepEqual(readOpenCodeAgentActivities(fixture.project), []);
  } finally {
    claim?.release();
    fixture.restore();
  }
});

test("OpenCode retains a timed-out mutation tombstone after the worker rejects late", async () => {
  const fixture = await isolatedProject("harbor-opencode-late-abort-reject-");
  let claim: ReturnType<typeof claimOpenCodeAgentActivity> | undefined;
  try {
    const session = nativeSession(fixture.project, "late-abort-reject", "Base", "build");
    claim = claimOpenCodeAgentActivity(fixture.project, "reviewer", "direct", session.id);
    claim.setPhase("working");
    const fake = fakeApi({
      directory: fixture.project,
      sessions: [session], active: {},
      legacyStatus: { [session.id]: { type: "busy" } },
      legacyMessages: { [session.id]: [legacyUserMessage(session.id, "reviewer", "late-reject-boundary", "Review")] },
      abortSession: () => new Promise((_resolve, reject) => setTimeout(() => reject(new Error("late worker rejection")), 60)),
    });
    const snapshot = await collectOpenCodeTeamSnapshot(fake.api);
    const result = await stopOpenCodeTeamRuns(fake.api, snapshot.runs[0].id, {
      rpcDeadlineMs: 10, collectionDeadlineMs: 40,
    });
    assert.deepEqual(result.failed, []);
    assert.deepEqual(result.pendingConfirmation, [snapshot.runs[0].id]);
    await new Promise((resolve) => setTimeout(resolve, 90));
    const duplicate = await stopOpenCodeTeamRuns(fake.api, snapshot.runs[0].id, {
      rpcDeadlineMs: 10, collectionDeadlineMs: 40,
    });
    assert.deepEqual(duplicate.failed, []);
    assert.deepEqual(duplicate.pendingConfirmation, [snapshot.runs[0].id]);
    assert.deepEqual(fake.aborts, [session.id], "a late rejection erased the outcome-unknown safety barrier");
  } finally {
    claim?.release();
    fixture.restore();
  }
});

test("OpenCode rejects mixed-session legacy text parts before producing a task label", async () => {
  const fixture = await isolatedProject("harbor-opencode-mixed-legacy-part-");
  try {
    const direct = nativeSession(fixture.project, "mixed-part", "Direct", "crafter");
    const secret = "foreign-part-secret-should-never-render";
    const mixed = legacyUserMessage(direct.id, "crafter", "mixed-boundary", secret);
    mixed.parts[0].sessionID = "foreign-session";
    const fake = fakeApi({
      directory: fixture.project,
      sessions: [direct], active: {},
      legacyStatus: { [direct.id]: { type: "busy" } },
      legacyMessages: { [direct.id]: [mixed] },
    });
    const snapshot = await collectOpenCodeTeamSnapshot(fake.api);
    assert.equal(snapshot.runs.length, 1);
    assert.equal(snapshot.runs[0].task, "(task not disclosed)");
    assert.doesNotMatch(JSON.stringify(snapshot), new RegExp(secret, "u"));
    assert.match(snapshot.degradedReasons.join("\n"), /unavailable task or response telemetry/u);
  } finally { fixture.restore(); }
});

test("OpenCode legacy direct stop rejects a changed user-turn boundary before abort", async () => {
  const fixture = await isolatedProject("harbor-opencode-legacy-boundary-drift-");
  try {
    const direct = nativeSession(fixture.project, "legacy-boundary-drift", "Direct", "crafter");
    const fake = fakeApi({
      directory: fixture.project,
      sessions: [direct], active: {},
      legacyStatus: { [direct.id]: { type: "busy" } },
      legacyMessageProvider: (sessionID, read) => [legacyUserMessage(
        sessionID,
        "crafter",
        read < 3 ? "legacy-boundary-a" : "legacy-boundary-b",
        read < 3 ? "First turn" : "Replacement turn",
      )],
    });
    const snapshot = await collectOpenCodeTeamSnapshot(fake.api);
    assert.equal(snapshot.runs[0].task, "First turn");
    const result = await stopOpenCodeTeamRuns(fake.api, snapshot.runs[0].id);
    assert.deepEqual(result.stopped, []);
    assert.deepEqual(result.failed, [snapshot.runs[0].id]);
    assert.deepEqual(fake.aborts, []);
  } finally { fixture.restore(); }
});

test("OpenCode legacy direct stop requires a snapshot user boundary", async () => {
  const fixture = await isolatedProject("harbor-opencode-legacy-boundary-missing-");
  try {
    const direct = nativeSession(fixture.project, "legacy-boundary-missing", "Direct", "crafter");
    const fake = fakeApi({
      directory: fixture.project,
      sessions: [direct], active: {},
      legacyStatus: { [direct.id]: { type: "busy" } },
      legacyMessages: { [direct.id]: [] },
    });
    const snapshot = await collectOpenCodeTeamSnapshot(fake.api);
    assert.equal(snapshot.runs[0].turnBoundaryID, undefined);
    const result = await stopOpenCodeTeamRuns(fake.api, snapshot.runs[0].id);
    assert.deepEqual(result.stopped, []);
    assert.deepEqual(result.failed, [snapshot.runs[0].id]);
    assert.deepEqual(fake.aborts, []);
  } finally { fixture.restore(); }
});

test("OpenCode claim stop reports another-process ownership without a generic timeout or PID disclosure", async () => {
  const fixture = await isolatedProject("harbor-opencode-claim-other-process-");
  let claim: ReturnType<typeof claimOpenCodeAgentActivity> | undefined;
  try {
    claim = claimOpenCodeAgentActivity(fixture.project, "reviewer", "direct", "other-process-session");
    const activityRoot = join(fixture.root, "home", "agent-foundry", "opencode-activity-v1");
    const [digest] = await readdir(activityRoot);
    const claimFile = join(activityRoot, digest, "reviewer.json");
    const stored = JSON.parse(await readFile(claimFile, "utf8"));
    stored.processID = process.pid + 100_000;
    await writeFile(claimFile, JSON.stringify(stored));
    const session = nativeSession(fixture.project, "other-process-session", "Base", "build");
    const fake = fakeApi({
      directory: fixture.project,
      sessions: [session],
      active: {},
      legacyStatus: { [session.id]: { type: "busy" } },
      messages: { [session.id]: [{ id: "other-boundary", type: "user", text: "Review", time: { created: 1_000 } }] },
      legacyMessages: { [session.id]: [
        legacyUserMessage(session.id, "reviewer", "other-boundary", "private other-process task"),
      ] },
    });
    const snapshot = await collectOpenCodeTeamSnapshot(fake.api);
    assert.deepEqual(snapshot.runs, [], "lagging native base-agent row remained independently stoppable");
    const reservation = snapshot.reservations.find(({ agent }) => agent === "reviewer")!;
    assert.equal(reservation.stopAvailable, false);
    assert.deepEqual(fake.legacyMessageReads, [], "another process's claim authorized a private message read");
    const result = await stopOpenCodeTeamRuns(fake.api, "all");
    assert.deepEqual(result.ownedByAnotherProcess, [reservation.id]);
    assert.deepEqual(result.failed, []);
    assert.deepEqual(fake.aborts, []);
    const formatted = formatOpenCodeStopResult(result);
    assert.match(formatted, /Owned by another OpenCode process/u);
    assert.doesNotMatch(formatted, new RegExp(String(stored.processID), "u"));
    assert.doesNotMatch(formatted, /failed or timed out/u);
  } finally {
    claim?.release();
    fixture.restore();
  }
});

test("OpenCode overdue owner heartbeats stay busy and disable misleading claim stop", async () => {
  const fixture = await isolatedProject("harbor-opencode-claim-overdue-");
  let claim: ReturnType<typeof claimOpenCodeAgentActivity> | undefined;
  try {
    const session = nativeSession(fixture.project, "overdue-session", "Base", "build");
    claim = claimOpenCodeAgentActivity(fixture.project, "reviewer", "direct", session.id);
    assert.equal(claim.setPhase("working"), true);
    const activityRoot = join(fixture.root, "home", "agent-foundry", "opencode-activity-v1");
    const [digest] = await readdir(activityRoot);
    const stale = new Date(Date.now() - 31_000);
    await utimes(join(activityRoot, digest, "reviewer.json"), stale, stale);
    assert.equal(readOpenCodeAgentActivities(fixture.project)[0]?.heartbeatOverdue, true);
    const fake = fakeApi({
      directory: fixture.project,
      sessions: [session],
      active: {},
      legacyStatus: { [session.id]: { type: "busy" } },
      messages: { [session.id]: [{ id: "overdue-boundary", type: "user", text: "Review", time: { created: 1_000 } }] },
      legacyMessages: { [session.id]: [
        legacyUserMessage(session.id, "reviewer", "overdue-boundary", "private overdue task"),
      ] },
    });
    const snapshot = await collectOpenCodeTeamSnapshot(fake.api);
    assert.deepEqual(snapshot.runs, []);
    const reservation = snapshot.reservations.find(({ agent }) => agent === "reviewer")!;
    assert.equal(reservation.stopAvailable, false);
    assert.equal(reservation.stopBlockReason, "stale-heartbeat");
    assert.deepEqual(fake.legacyMessageReads, [], "an overdue claim authorized a private message read");
    assert.ok(snapshot.degradedReasons.some((reason) => /overdue heartbeat/u.test(reason)));
    const result = await stopOpenCodeTeamRuns(fake.api, "all");
    assert.deepEqual(result.staleOwnerHeartbeat, [reservation.id]);
    assert.deepEqual(fake.aborts, []);
    const formatted = formatOpenCodeStopResult(result);
    assert.match(formatted, /Owner heartbeat overdue/u);
    assert.doesNotMatch(formatted, /failed or timed out/u);
  } finally {
    claim?.release();
    fixture.restore();
  }
});

test("OpenCode stop formatting reserves the 30-line budget for final refresh guidance", () => {
  const ids = Array.from({ length: 32 }, (_, index) => `run-${String(index).padStart(2, "0")}`);
  const formatted = formatOpenCodeStopResult({
    requested: "all",
    stopped: ids,
    alreadyIdle: ids,
    failed: ids,
    pendingChildIdentity: ids,
    ownedByAnotherProcess: ids,
    claimIdentityUnavailable: ids,
    ownershipUnavailable: ids,
    staleOwnerHeartbeat: ids,
    lifecycleTransition: ids,
    nativeRunPending: ids,
    engineAuthorityUnavailable: ids,
    pendingConfirmation: ids,
  }, "Post-stop team refresh unavailable: host inventory is recovering. Run /team before retrying unresolved work.");
  const lines = formatted.split("\n");
  assert.ok(lines.length <= maximumOpenCodeTeamDialogLines);
  assert.ok(lines.every((line) => visibleTextWidth(line) <= 96));
  assert.match(formatted, /stop details clipped/u);
  assert.match(formatted, /Post-stop team refresh unavailable/u);
  assert.match(formatted, /Run \/team before retrying\s+unresolved work/su);
});

test("OpenCode lifecycle hook failures always delete the disposable child exactly once", async () => {
  for (const failingPhase of ["working", "cleaning"] as const) {
    const fixture = await isolatedProject(`harbor-opencode-hook-${failingPhase}-`);
    try {
      let prompts = 0;
      let deletes = 0;
      const orchestrator = new OpenCodeOrchestrator({ session: {
        create: async () => ({ data: { id: `${failingPhase}-child` } }),
        update: async ({ path, body }: any) => ({ data: { id: path.id, title: body.title } }),
        prompt: async () => { prompts += 1; return { data: { parts: [{ type: "text", text: "done" }] } }; },
        delete: async () => { deletes += 1; return { data: true }; },
      } } as any, fixture.project, undefined, undefined, 100, join(fixture.root, "claim-home"));
      await assert.rejects(
        () => orchestrator.runAgent(
          "reviewer", "Review", undefined, { providerID: "openai", modelID: "gpt" }, undefined,
          (phase) => { if (phase === failingPhase) throw new Error(`${phase} publication failed`); },
        ),
        /publication failed/u,
      );
      assert.equal(deletes, 1, `${failingPhase} hook failure skipped or duplicated child deletion`);
      assert.equal(prompts, failingPhase === "working" ? 0 : 1);
    } finally { fixture.restore(); }
  }
});

test("OpenCode second retire reports an idempotent no-op instead of claiming another mutation", async () => {
  const fixture = await isolatedProject("harbor-opencode-retire-idempotent-");
  try {
    await runDeterministicCommand("opencode", "join", JSON.stringify({
      name: "reviewer", description: "Review", prompt: "Work", tools: ["read"], skills: [],
    }), fixture.project);
    const fake = fakeApi({ directory: fixture.project, loadedAgents: ["reviewer"], active: {} });
    const retire = openCodeDirectCommands(fake.api).find(({ slashName }) => slashName === "harbor-retire")!;
    retire.run();
    await fake.dialogs.at(-1).onConfirm("reviewer");
    assert.match(fake.dialogs.at(-1).message, /reviewer retired here/u);
    retire.run();
    await fake.dialogs.at(-1).onConfirm("reviewer");
    assert.match(fake.dialogs.at(-1).message, /reviewer already retired · no roster files changed/u);
    assert.doesNotMatch(fake.dialogs.at(-1).message, /✓ reviewer retired here/u);
  } finally { fixture.restore(); }
});

test("OpenCode compensating deletion uses an independent bounded signal after the caller aborts", async () => {
  const fixture = await isolatedProject("harbor-opencode-cleanup-signal-");
  try {
    const controller = new AbortController();
    const evidence: any[] = [];
    let deleteSignal: AbortSignal | undefined;
    const client: any = { session: {
      create: async () => ({ data: { id: "abort-child" } }),
      update: async ({ body }: any) => ({ data: { id: "abort-child", title: body.title } }),
      prompt: async () => { controller.abort(); throw new Error("caller aborted during prompt"); },
      delete: ({ signal }: any) => {
        deleteSignal = signal;
        assert.equal(signal.aborted, false, "compensating delete inherited an already-aborted caller signal");
        return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("delete aborted by cleanup deadline")), { once: true }));
      },
    } };
    const orchestrator = new OpenCodeOrchestrator(
      client, fixture.project, undefined, (event) => evidence.push(event), 20, join(fixture.root, "home"),
    );
    await assert.rejects(
      () => orchestrator.runAgent("crafter", "Work", undefined, { providerID: "openai", modelID: "gpt" }, controller.signal),
      /execution and cleanup failed|child cleanup timed out/u,
    );
    assert.equal(deleteSignal?.aborted, true);
    assert.ok(evidence.some(({ phase, outcome }) => phase === "child.cleaned" && outcome === "error"));
  } finally { fixture.restore(); }
});

test("OpenCode normal cleanup retries, records a hazard, and blocks the next child before create", async () => {
  const fixture = await isolatedProject("harbor-opencode-normal-cleanup-hazard-");
  try {
    let creates = 0;
    let prompts = 0;
    let deletes = 0;
    const orchestrator = new OpenCodeOrchestrator({ session: {
      create: async () => ({ data: { id: `normal-cleanup-${++creates}` } }),
      update: async ({ path, body }: any) => ({ data: { id: path.id, title: body.title } }),
      prompt: async () => { prompts += 1; return { data: { parts: [{ type: "text", text: "completed evidence" }] } }; },
      delete: async () => { deletes += 1; throw new Error("host delete unavailable"); },
    } } as any, fixture.project, undefined, undefined, 25, join(fixture.root, "claim-home"));
    await assert.rejects(
      () => orchestrator.runAgent("crafter", "First", undefined, { providerID: "openai", modelID: "gpt" }),
      /child cleanup failed after two bounded attempts/u,
    );
    assert.equal(prompts, 1);
    assert.equal(deletes, 2);
    const { api } = fakeApi({ directory: fixture.project });
    const snapshot = await collectOpenCodeTeamSnapshot(api);
    assert.match(snapshot.degradedReasons.join("\n"), /cleanup is unreconciled/u);
    await assert.rejects(
      () => orchestrator.runAgent("crafter", "Second", undefined, { providerID: "openai", modelID: "gpt" }),
      /cleanup is unreconciled; inspect and delete.*reload OpenCode/u,
    );
    assert.equal(creates, 1, "a cleanup hazard allowed another child create");
  } finally { fixture.restore(); }
});

test("OpenCode retries a failed late-created child cleanup and blocks until the orphan is inspected and the guard reloaded", async () => {
  const fixture = await isolatedProject("harbor-opencode-late-cleanup-hazard-");
  try {
    let creates = 0;
    let deletes = 0;
    const client: any = { session: {
      create: () => new Promise((resolve) => setTimeout(() => {
        creates += 1;
        resolve({ data: { id: "orphaned-late-child" } });
      }, 25)),
      update: async ({ path, body }: any) => ({ data: { id: path.id, title: body.title } }),
      prompt: async () => ({ data: { parts: [] } }),
      delete: async () => { deletes += 1; throw new Error("late delete failed"); },
    } };
    const orchestrator = new OpenCodeOrchestrator(client, fixture.project, undefined, undefined, 10, join(fixture.root, "home"));
    await assert.rejects(
      () => orchestrator.runAgent("crafter", "First", undefined, { providerID: "openai", modelID: "gpt" }),
      /child creation timed out/u,
    );
    await new Promise((resolve) => setTimeout(resolve, 60));
    await assert.rejects(
      () => orchestrator.runAgent("crafter", "Second", undefined, { providerID: "openai", modelID: "gpt" }),
      /cleanup is unreconciled; inspect and delete.*provenance pending.*reload OpenCode.*does not delete the orphan/u,
    );
    assert.equal(creates, 1);
    assert.equal(deletes, 2, "cleanup hazard was recorded without the bounded retry");
    const { api } = fakeApi({ directory: fixture.project });
    const snapshot = await collectOpenCodeTeamSnapshot(api);
    assert.match(snapshot.degradedReasons.join("\n"), /cleanup is unreconciled/u);
    assert.match(snapshot.degradedReasons.join("\n"), /Reload only releases this safety guard; it does not delete the orphan/u);
  } finally { fixture.restore(); }
});

// Keep this last: the intentionally unresolved prompts retain all lifecycle
// reservations until this test process exits.
test("OpenCode reserves disposable-child capacity before create and rejects the thirty-third live lifecycle", async () => {
  const fixture = await isolatedProject("harbor-opencode-lifecycle-cap-");
  try {
    let creates = 0;
    let prompts = 0;
    const client: any = { session: {
      create: async () => ({ data: { id: `live-child-${++creates}` } }),
      update: async ({ path, body }: any) => ({ data: { id: path.id, title: body.title } }),
      prompt: () => { prompts += 1; return new Promise(() => {}); },
      delete: async () => ({ data: true }),
    } };
    const orchestrator = new OpenCodeOrchestrator(client, fixture.project, undefined, undefined, 50, join(fixture.root, "home"));
    for (let index = 0; index < 32; index += 1) {
      void orchestrator.runAgent("crafter", `Work ${index}`, undefined, { providerID: "openai", modelID: "gpt" });
    }
    const deadline = Date.now() + 2_000;
    while (prompts < 32 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 2));
    assert.equal(prompts, 32);
    await assert.rejects(
      () => orchestrator.runAgent("crafter", "Overflow", undefined, { providerID: "openai", modelID: "gpt" }),
      /disposable child capacity reached/u,
    );
    assert.equal(creates, 32, "capacity rejection happened after creating an orphanable child");
  } finally { fixture.restore(); }
});
