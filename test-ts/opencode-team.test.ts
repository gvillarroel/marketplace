import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  collectOpenCodeTeamSnapshot,
  openCodePublicLabel,
  openCodeTaskLabel,
  stopOpenCodeTeamRuns,
} from "../src/adapters/opencode-team-runtime.js";
import {
  formatOpenCodeTeamHelp,
  formatOpenCodeTeamView,
  maximumOpenCodeTeamDialogLines,
} from "../src/adapters/opencode-team-view.js";
import { claimOpenCodeAgentActivity, readOpenCodeAgentActivities } from "../src/adapters/opencode-agent-activity.js";
import openCodeTuiPlugin, { openCodeDirectCommands, runOpenCodeTeamQuery } from "../src/adapters/opencode-tui.js";
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

function fakeApi(input: {
  directory: string;
  sessions?: any[];
  active?: Record<string, unknown>;
  activeSequence?: Record<string, unknown>[];
  activeProvider?: (read: number) => Record<string, unknown>;
  messages?: Record<string, any[]>;
  messageProvider?: (sessionID: string, read: number) => any[];
  current?: string;
  stateStatus?: "busy" | "retry" | "idle";
  hangList?: boolean;
  hangActive?: boolean;
  getSession?: (sessionID: string, call: number) => any;
  interruptSession?: (sessionID: string, call: number) => any | Promise<any>;
  interruptDelayMs?: number;
  stateInfos?: any[];
  stateParts?: (messageID: string) => any[];
  configModel?: string;
  providers?: any[];
  loadedAgents?: readonly string[];
}) {
  const interrupts: string[] = [];
  const dialogs: any[] = [];
  const toasts: any[] = [];
  const messageReads: string[] = [];
  const dialogSizes: string[] = [];
  let activeReads = 0;
  let listReads = 0;
  let getReads = 0;
  let interruptReads = 0;
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
      v2: {
        session: {
          list: () => {
            listReads += 1;
            return input.hangList ? new Promise(() => {}) : Promise.resolve(response({ data: input.sessions ?? [], cursor: {} }));
          },
          active: () => {
            activeReads += 1;
            const value = input.activeProvider?.(activeReads)
              ?? input.activeSequence?.[Math.min(activeReads - 1, input.activeSequence.length - 1)]
              ?? input.active ?? {};
            return input.hangActive ? new Promise(() => {}) : Promise.resolve(response({ data: value }));
          },
          get: async ({ sessionID }: { sessionID: string }) => {
            getReads += 1;
            return response({ data: await input.getSession?.(sessionID, getReads) ?? byID.get(sessionID) });
          },
          messages: ({ sessionID }: { sessionID: string }) => {
            messageReads.push(sessionID);
            const source = input.messageProvider?.(sessionID, messageReads.length) ?? input.messages?.[sessionID] ?? [];
            const values = source.map((message, index) =>
              message.id ? message : { ...message, id: `${sessionID}-message-${index}` });
            return Promise.resolve(response({ data: values, cursor: {} }));
          },
          interrupt: ({ sessionID }: { sessionID: string }) => {
            interrupts.push(sessionID);
            interruptReads += 1;
            if (input.interruptSession) return Promise.resolve(input.interruptSession(sessionID, interruptReads));
            return input.interruptDelayMs
              ? new Promise((resolve) => setTimeout(() => resolve(response(undefined)), input.interruptDelayMs))
              : Promise.resolve(response(undefined));
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
    api, interrupts, dialogs, toasts, messageReads, dialogSizes, dispose,
    abortLifecycle: () => lifecycleController.abort(),
    get listReads() { return listReads; },
    get activeReads() { return activeReads; },
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
      input: 21, output: 5, reasoning: 2, cacheRead: 3, cacheWrite: 0, cost: 0.012,
    });
    assert.deepEqual(snapshot.runs[1].usage, {
      input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0,
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
    assert.match(flatLead, /input 21 · output 5 · reasoning 2 · cache read 3 · cache write 0 · cost \$0\.0120/u);
    assert.match(flatChild, /child session total observed.*input 0.*cost \$0\.000000/u);
    assert.match(leadView, /\[path\].*\[redacted\].*\[url\]/u);
    assert.doesNotMatch(JSON.stringify(snapshot), /customer|abcdefghijklmnop|internal\.example|assistant-private-evidence|foreign-private-task/u);
    assert.doesNotMatch(`${leadView}\n${childView}`, /foreign-session|foreign-private-task/u);
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

test("OpenCode 45-row team views keep the factory roster complete and bound broad activity", async () => {
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
    assert.match(overview, /use \/team member:<id> for details/u);
    assert.match(overview, /Roster actions: \/bench-on · \/bench-off · \/harbor-join · \/harbor-retire/u);

    const personal = Array.from({ length: 8 }, (_, index) => ({
      id: `worker-${index.toString().padStart(2, "0")}`,
      kind: "personal" as const,
      availability: "ready" as const,
      description: `Worker ${index}`,
      capacity: "read",
      tools: ["read"],
      skills: [],
    }));
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
    }));
    const crowded = { ...snapshot, members: [...snapshot.members, ...personal], runs };
    const broad = formatOpenCodeTeamView(crowded, "status:working");
    assert.ok(broad.split("\n").length <= maximumOpenCodeTeamDialogLines);
    assert.match(broad, /ACTIVITY · COMPACT/u);
    assert.match(broad, /active entries hidden; narrow with \/team run:<id>.*member:<id>/u);
    assert.match(broad, /Details: \/team member:<id> · \/team run:<run-id>/u);
    assert.doesNotMatch(broad, /Task 7/u, "a broad multi-run filter leaked rich rows past its compact budget");
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
    assert.match(view, /SDLC direct 0\/6/u);
    assert.ok(view.split("\n").length <= maximumOpenCodeTeamDialogLines);
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
      input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0,
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
    assert.deepEqual(run.usage, { input: 7, output: 2, reasoning: 1, cacheRead: 0, cacheWrite: 0, cost: 0.01 });
    assert.deepEqual(run.model, { provider: "openai", id: "current" });
    const view = formatOpenCodeTeamView(snapshot, "member:crafter").replace(/\s+/gu, " ");
    assert.match(view, /current turn observed .* input 7 .* cost \$0\.0100/u);
    assert.doesNotMatch(view, /10,000|\$42|foreign\/old/u);
  } finally { fixture.restore(); }
});

test("OpenCode team stop never interrupts an active foreign session and rechecks Harbor ownership", async () => {
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

test("OpenCode stop treats unknown recheck state as unknown, never idle, and interrupts nothing", async () => {
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
    await assert.rejects(() => stopOpenCodeTeamRuns(api, "all"), /unknown status telemetry; no session was interrupted/u);
    assert.deepEqual(interrupts, []);
  } finally { fixture.restore(); }
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

test("OpenCode performs each ownership GET immediately before that target's interrupt", async () => {
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
      interruptSession: (id) => { events.push(`interrupt:${id}`); return response(undefined); },
    });
    const result = await stopOpenCodeTeamRuns(api, "all", { maximumConcurrency: 2, rpcDeadlineMs: 200 });
    assert.equal(result.stopped.length, 2);
    assert.ok(events.indexOf(`interrupt:${first.id}`) < events.indexOf(`get-end:${second.id}`), events.join(", "));
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
        : response(undefined),
    });
    const snapshot = await collectOpenCodeTeamSnapshot(api);
    const ids = new Map(snapshot.runs.map((run) => [run.agent, run.id]));
    assert.notEqual(ids.get("crafter"), ids.get("design"));
    assert.ok([...ids.values()].every((id) => /^run-[A-Za-z0-9_-]{20}$/u.test(id)));
    const result = await stopOpenCodeTeamRuns(api, "all");
    assert.deepEqual(result.stopped, [ids.get("crafter")]);
    assert.deepEqual(result.failed, [ids.get("design")]);
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

test("OpenCode stop reports every interrupt omitted by its total deadline", async () => {
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
      interruptDelayMs: 25,
    });
    const result = await stopOpenCodeTeamRuns(api, "all", {
      rpcDeadlineMs: 100,
      collectionDeadlineMs: 60,
      maximumConcurrency: 4,
    });
    assert.equal(result.stopped.length + result.failed.length, 32, "deadline-omitted targets vanished from the outcome");
    assert.ok(result.failed.length > 0, "slow bounded fanout unexpectedly confirmed every target");
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
      /verification is unavailable; no session was interrupted/u,
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
    const help = formatOpenCodeTeamHelp();
    assert.match(help, /0 model tokens/u);
    assert.match(help, /ready · invocable teammate can run with \/<id> <task> in the current session/u);
    assert.match(help, /Enabled · reload required means native selection and \/<id> are stale/u);
    assert.match(help, /model: "provider\/model" and replace:\s+true/u);
    assert.match(help, /not a hard\s+token cap/u);
    assert.match(help, /at most six teammates sequentially/u);
    assert.match(help, /Privacy:/u);
    assert.doesNotMatch(help, /view clipped/u);
    assert.ok(help.split("\n").length <= maximumOpenCodeTeamDialogLines);
    assert.ok(help.split("\n").every((line) => visibleTextWidth(line) <= 96));

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
    assert.match(view, /Host default model: openai\/gpt-5\.4 · context 200,000 · max output 32,000/u);
    assert.match(view, /variant high \(observed\)/u);
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

test("OpenCode bounds hostile numeric telemetry and marks overflowing sums as degraded lower bounds", async () => {
  const fixture = await isolatedProject("harbor-opencode-numeric-bound-");
  try {
    const direct = nativeSession(fixture.project, "numeric-run", "Direct", "crafter");
    const assistant = (id: string) => ({
      id, type: "assistant", agent: "crafter", model: { providerID: "openai", id: "gpt" },
      tokens: { input: Number.MAX_SAFE_INTEGER, output: 1e308, reasoning: 0, cache: { read: 0, write: 0 } },
      cost: Number.MAX_SAFE_INTEGER, time: { created: 2_000 },
    });
    const { api } = fakeApi({
      directory: fixture.project,
      sessions: [direct], active: { [direct.id]: { type: "running" } },
      messages: { [direct.id]: [assistant("a"), assistant("b"), { id: "u", type: "user", text: "Bound", time: { created: 1_000 } }] },
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
    assert.match(fake.dialogs.at(-1).message, /4 KiB safety limit/u);
    assert.doesNotMatch(fake.dialogs.at(-1).message, /secret-/u);
    await assert.rejects(() => stopOpenCodeTeamRuns(fake.api, secret), /256-byte safety limit/u);
    assert.equal(fake.listReads, 0);
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

test("OpenCode join confirmation and roster distinguish enabled pending reload from loaded invocability", async () => {
  const fixture = await isolatedProject("harbor-opencode-join-public-");
  try {
    const fake = fakeApi({ directory: fixture.project });
    const joinCommand = openCodeDirectCommands(fake.api).find(({ slashName }) => slashName === "harbor-join")!;
    joinCommand.run();
    await fake.dialogs.at(-1).onConfirm(JSON.stringify({
      name: "private-reviewer",
      description: "Review C:/Users/alice/customer.txt with Bearer abcdefghijklmnop",
      prompt: "private-prompt-never-render-123456789",
      tools: ["read"],
      model: "router/safe",
    }));
    const output = fake.dialogs.at(-1).message;
    assert.match(output, /private-reviewer joined · personal · enabled · reload required/u);
    assert.match(output, /Role: Review \[path\] with \[redacted\]/u);
    assert.match(output, /Capacity: read/u);
    assert.match(output, /Model: configured router\/safe/u);
    assert.match(output, /After reload: \/private-reviewer <task>/u);
    assert.match(output, /Reload OpenCode before native selection/u);
    assert.doesNotMatch(output, /registration:|active:|customer\.txt|abcdefghijklmnop|private-prompt-never-render|harbor-opencode-join-public/u);
    assert.ok([...output].length < 1_000);

    const pending = await collectOpenCodeTeamSnapshot(fake.api);
    assert.equal(pending.members.find(({ id }) => id === "private-reviewer")?.availability, "reload-required");
    const pendingView = formatOpenCodeTeamView(pending, "member:private-reviewer");
    assert.match(pendingView, /enabled · reload required/u);
    assert.match(pendingView, /Lead: 2 available.*1 via live preflight until reload/su);
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
  } finally { fixture.restore(); }
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
        resolve(response(undefined));
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
      interruptSession: () => { running = false; return response(undefined); },
    });
    await runOpenCodeTeamQuery(fake.api, "stop all");
    const message = fake.dialogs.at(-1).message;
    assert.ok(message.split("\n").length <= 8);
    assert.match(message, /Post-stop team refresh completed\. Run \/team/u);
    assert.doesNotMatch(message, /\nROSTER|Agent Harbor OpenCode team/u);
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
        return response(undefined);
      },
    });
    await runOpenCodeTeamQuery(fake.api, "stop all");
    assert.deepEqual(fake.interrupts, [direct.id]);
    const resultDialog = fake.dialogs.at(-1);
    assert.match(resultDialog.title, /stop complete/u);
    assert.match(resultDialog.message, /Interrupted: run-[A-Za-z0-9_-]{20}/u);
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
  const claim = claimOpenCodeAgentActivity(fixture.project, "reviewer", "delegated", 1_000);
  let createEntered = false;
  let deleteEntered = false;
  let resolveCreate!: () => void;
  let resolveDelete!: () => void;
  const createGate = new Promise<void>((resolve) => { resolveCreate = resolve; });
  const deleteGate = new Promise<void>((resolve) => { resolveDelete = resolve; });
  const phases: string[] = [];
  const orchestrator = new OpenCodeOrchestrator({ session: {
    create: async () => { createEntered = true; await createGate; return { data: { id: "lifecycle-child" } }; },
    update: async ({ path, body }: any) => ({ data: { id: path.id, title: body.title } }),
    prompt: async () => ({ data: { parts: [{ type: "text", text: "verified" }] } }),
    delete: async () => { deleteEntered = true; await deleteGate; return { data: true }; },
  } } as any, fixture.project, undefined, undefined, 200, join(fixture.root, "claim-home"));
  const work = orchestrator.runAgent(
    "reviewer", "Review", undefined, { providerID: "openai", modelID: "gpt" }, undefined,
    (phase) => { phases.push(phase); claim.setPhase(phase); },
  );
  try {
    while (!createEntered) await new Promise((resolve) => setTimeout(resolve, 1));
    const fake = fakeApi({ directory: fixture.project });
    const starting = await collectOpenCodeTeamSnapshot(fake.api, { now: () => 2_000 });
    assert.deepEqual(starting.reservations.map(({ agent, phase }) => [agent, phase]), [["reviewer", "starting"]]);
    assert.match(formatOpenCodeTeamView(starting, "member:reviewer"), /reviewer · delegated lifecycle · starting/u);

    const retire = openCodeDirectCommands(fake.api).find(({ slashName }) => slashName === "harbor-retire")!;
    retire.run();
    await fake.dialogs.at(-1).onConfirm("reviewer");
    assert.match(fake.dialogs.at(-1).message, /Cannot retire active member reviewer/u);

    resolveCreate();
    while (!deleteEntered) await new Promise((resolve) => setTimeout(resolve, 1));
    assert.equal(readOpenCodeAgentActivities(fixture.project)[0]?.phase, "cleaning");
    const cleaning = await collectOpenCodeTeamSnapshot(fake.api, { now: () => 3_000 });
    assert.match(formatOpenCodeTeamView(cleaning, "member:reviewer"), /reviewer · delegated lifecycle · cleaning/u);
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
