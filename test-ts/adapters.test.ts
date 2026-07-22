import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import test from "node:test";
import {
  copilotFixedAgentIds,
  copilotFixedAgentPath,
  createCopilotCoordinatorGuard,
} from "../src/adapters/copilot-coordinator.js";
import { AgentHarborPlugin } from "../src/adapters/opencode.js";
import openCodeTui, { openCodeDirectCommands } from "../src/adapters/opencode-tui.js";
import { runDeterministicCommand } from "../src/adapters/direct.js";
import { claimSharedAgentActivity, readSharedAgentActivities } from "../src/adapters/opencode-agent-activity.js";
import { commandNames } from "../src/core/types.js";
import {
  harborCustomToolNames,
  harborStaticCustomToolSpecs,
  validateHarborCustomToolArguments,
} from "../src/core/custom-tools.js";
import { bundledPlayers, rolePlayers, scoutPlayer, trustedSkills } from "../src/core/defaults.js";
import { GhResolver } from "../src/core/github.js";
import type { HarborEvidenceEvent } from "../src/core/evidence.js";
import { Roster } from "../src/core/lifecycle.js";
import { harnessSpec, normalizeDelegatedTaskPaths, playerDefinitionDigest } from "../src/core/profiles.js";
import { visibleTextWidth } from "../src/core/text-layout.js";
import { CopilotOrchestrator } from "../src/orchestrators/copilot.js";
import { OpenCodeOrchestrator } from "../src/orchestrators/opencode.js";
import { PiOrchestrator } from "../src/orchestrators/pi.js";
import { loadHarborCycleDataset, type HarborCycle } from "./support/harbor-cycles.js";

const piHostSdkStub = `data:text/javascript,${encodeURIComponent(
  'export const HARBOR_PI_SDK_HOST_TEST_MARKER = "host-sdk-static-import";',
)}`;
registerHooks({
  resolve(specifier, context, nextResolve) {
    return specifier === "@earendil-works/pi-coding-agent"
      ? { shortCircuit: true, url: piHostSdkStub }
      : nextResolve(specifier, context);
  },
});
const {
  default: piExtension,
  requirePiBenchLifecycleOutcome,
  requirePiJoinLifecycleOutcome,
  requirePiRetireLifecycleOutcome,
} = await import("../src/adapters/pi.js");

const definition = { name: "worker", description: "Worker", prompt: "Work", tools: ["read"] as const, task: "Do it" };
const cycleDataset = loadHarborCycleDataset();
const defaultCycle = cycleDataset.cycles.find((cycle) => cycle.id === "default-specialists")!;
const fullCycle = cycleDataset.cycles.find((cycle) => cycle.id === "full-sdlc")!;
const confirmOpenCodeSessionTitle = async ({ path, body }: any) => ({ data: { id: path.id, title: body.title } });

function emptyOpenCodeActivitySession() {
  return {
    status: async () => ({ data: {} }),
    messages: async () => { throw new Error("empty activity inventory must not request messages"); },
  };
}

function emptyPiResourceSdk() {
  return {
    DefaultResourceLoader: class {
      private readonly options: any;
      private result = { skills: [], diagnostics: [] };
      constructor(options: any) { this.options = options; }
      async reload() { this.result = this.options.skillsOverride?.({ skills: [], diagnostics: [] }) ?? this.result; }
      getSkills() { return this.result; }
    },
    getAgentDir: () => "pi-agent-home",
  };
}

const authenticatedPiHostModel = { provider: "test-provider", id: "test-model" };

function authenticatedPiHostState(model: any = authenticatedPiHostModel) {
  return {
    model,
    modelRegistry: {
      find: (provider: string, id: string) => provider === model.provider && id === model.id ? model : undefined,
      getAvailable: () => [model],
      getError: () => undefined,
      hasConfiguredAuth: (candidate: any) => candidate.provider === model.provider && candidate.id === model.id,
    },
  };
}

async function sharedActivityClaimFile(activityHome: string, agent: string): Promise<string> {
  const root = join(activityHome, "agent-foundry", "team-activity-v1");
  const projects = await readdir(root);
  assert.equal(projects.length, 1, "expected one shared activity project directory");
  return join(root, projects[0], `${agent}.json`);
}

function datasetTask(cycle: HarborCycle, index: number, priorEvidence?: string): string {
  const step = cycle.steps[index];
  return step.evidenceFrom
    ? `${step.task}\n\nVerified evidence from ${step.evidenceFrom}:\n${priorEvidence}`
    : step.task;
}

test("delegated tasks replace project-absolute paths with bounded relative paths", () => {
  const project = join(tmpdir(), "Agent Harbor Fixture");
  const forward = project.replace(/\\/gu, "/");
  const normalized = normalizeDelegatedTaskPaths(
    `Read ${join(project, "src", "score.js")} and ${forward}/test/score.test.js; keep C:\\outside\\secret.txt unchanged.`,
    project,
  );
  assert.equal(normalized.includes(project), false);
  assert.equal(normalized.includes(forward), false);
  assert.match(normalized, /\.[/\\]src[/\\]score\.js/u);
  assert.match(normalized, /\.\/test\/score\.test\.js/u);
  assert.match(normalized, /C:\\outside\\secret\.txt/u);
});

test("shared recruiter join contract refuses replacement definitions", () => {
  const definition = JSON.stringify({
    name: "existing-reviewer",
    description: "Must remain unchanged",
    prompt: "Review safely",
    tools: ["read"],
    replace: true,
  });
  assert.throws(
    () => validateHarborCustomToolArguments(harborCustomToolNames.joinPlayer, { definition }),
    /harbor_join_player recruits a new teammate and cannot replace an existing roster member/u,
  );
});

test("Copilot orchestrator uses one SDK custom-agent session", async () => {
  const events: string[] = [];
  const client = {
    createSession: async (config: any) => {
      events.push(`create:${config.agent}:${config.customAgents.length}:${config.customAgents[0].tools.join(",")}:${config.workingDirectory === process.cwd()}`);
      return { sessionId: "child", abort: async () => {}, sendAndWait: async ({ prompt }: any) => { events.push(`send:${prompt}`); return { data: { content: "done" } }; } };
    },
    deleteSession: async (id: string) => { events.push(`delete:${id}`); },
    stop: async () => { events.push("stop"); },
  };
  const orchestrator = new CopilotOrchestrator(() => client as any);
  assert.equal(await orchestrator.run(definition as any), "done");
  assert.deepEqual(events, ["create:worker:1:read:true", "send:Do it", "delete:child", "stop"]);
});

test("Copilot orchestrator reclaims a session created just after its local deadline", async () => {
  const events: string[] = [];
  let resolveCreation!: (session: any) => void;
  const creation = new Promise<any>((resolvePromise) => { resolveCreation = resolvePromise; });
  const client = {
    createSession: () => creation,
    deleteSession: async (id: string) => { events.push(`delete:${id}`); },
    stop: async () => { events.push("stop"); },
  };
  const orchestrator = new CopilotOrchestrator(
    () => client as any,
    process.cwd(),
    new GhResolver(),
    undefined,
    { operationTimeoutMs: 20, cleanupTimeoutMs: 100, abortTimeoutMs: 20 },
  );
  setTimeout(() => resolveCreation({
    sessionId: "late-child",
    abort: async () => { events.push("abort:late-child"); },
    sendAndWait: async () => ({ data: { content: "must not run" } }),
  }), 35);
  await assert.rejects(() => orchestrator.run(definition as any), /session creation exceeded its 20ms deadline/u);
  assert.deepEqual(events, ["abort:late-child", "delete:late-child", "stop"]);
});

test("Copilot orchestrator bounds abort and sequences delete before stop", async () => {
  const events: string[] = [];
  let deleting = false;
  const never = new Promise<never>(() => {});
  const client = {
    createSession: async () => ({
      sessionId: "hung-child",
      abort: () => { events.push("abort"); return never; },
      sendAndWait: () => { events.push("send"); return never; },
    }),
    deleteSession: async () => {
      deleting = true;
      events.push("delete:start");
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 15));
      events.push("delete:end");
      deleting = false;
    },
    stop: async () => {
      assert.equal(deleting, false, "client.stop overlapped deleteSession and could close its transport");
      events.push("stop");
    },
  };
  const orchestrator = new CopilotOrchestrator(
    () => client as any,
    process.cwd(),
    new GhResolver(),
    undefined,
    { operationTimeoutMs: 20, cleanupTimeoutMs: 100, abortTimeoutMs: 20 },
  );
  await assert.rejects(() => orchestrator.run(definition as any), (error: any) => {
    assert.ok(error instanceof AggregateError);
    const detail = [error.message, ...error.errors.map((entry: Error) => entry.message)].join(" | ");
    assert.match(detail, /prompt exceeded its 20ms deadline/u);
    assert.match(detail, /abort exceeded its 20ms deadline/u);
    return true;
  });
  assert.deepEqual(events, ["send", "abort", "delete:start", "delete:end", "stop"]);
});

test("Copilot orchestrator bounds returned evidence on a UTF-8 boundary", async () => {
  const evidence = "😀".repeat(10_000);
  const observed: HarborEvidenceEvent[] = [];
  const client = {
    createSession: async () => ({
      sessionId: "large-evidence",
      abort: async () => {},
      sendAndWait: async () => ({ data: { content: evidence } }),
    }),
    deleteSession: async () => {},
    stop: async () => {},
  };
  const output = await new CopilotOrchestrator(
    () => client as any,
    process.cwd(),
    new GhResolver(),
    (event) => observed.push(event),
  ).run(definition as any);
  assert.ok(Buffer.byteLength(output, "utf8") <= 30_000);
  assert.match(output, /\[HARBOR-EVIDENCE-TRUNCATED original_utf8_bytes=40000 limit=30000\]$/u);
  assert.equal(
    observed.find(({ phase }) => phase === "evidence.returned")?.evidence?.utf8Bytes,
    Buffer.byteLength(output, "utf8"),
  );
});

test("Copilot team-lead hooks enforce exact active sequential delegation across user turns", async () => {
  const root = await mkdtemp(join(tmpdir(), "harbor-copilot-hooks-"));
  const project = join(root, "project");
  const roster = new Roster(harnessSpec("copilot", join(root, "home"), project));
  await roster.bench("on all", bundledPlayers);
  const agents = [
    ...[...copilotFixedAgentIds].map(([logical, id]) => ({
      id, path: copilotFixedAgentPath(logical), userInvocable: true,
    })),
    ...[...bundledPlayers.keys()].map((id) => ({ id, path: join(project, ".github", "agents", `${id}.agent.md`), userInvocable: true })),
  ];
  let current = copilotFixedAgentIds.get("team-lead")!;
  let failCurrent = false; let failReload = false;
  let reloads = 0;
  const evidenceEvents: HarborEvidenceEvent[] = [];
  const coordinator = createCopilotCoordinatorGuard(() => ({ rpc: { agent: {
    getCurrent: async () => {
      if (failCurrent) throw new Error("current unavailable");
      return { agent: agents.find(({ id }) => id === current) };
    },
    reload: async () => { if (failReload) throw new Error("reload unavailable"); reloads += 1; return { agents }; },
  } } }), (event) => evidenceEvents.push(event));
  const hooks = coordinator.hooks;
  const invocation = { sessionId: "parent" };
  const input = (agentType: string, prompt: string, sessionId = "parent") => ({
    sessionId, workingDirectory: project, toolName: "task",
    toolArgs: { agent_type: agentType, description: `stage ${agentType}`, prompt },
  });
  const reset = (prompt: string) => hooks.onUserPromptSubmitted({ sessionId: "parent", workingDirectory: project, prompt }, invocation);
  const finish = (value: ReturnType<typeof input>, evidence: string) => hooks.onPostToolUse({ ...value, toolResult: evidence }, invocation);
  const terminalDispositions: string[] = [];
  const endTurn = (id: string) => {
    const activityId = `${id}-turn`;
    const activity = {
      type: "assistant.turn_start",
      id: activityId,
      data: { sessionId: "parent", turnId: activityId },
    } as const;
    const terminal = {
      type: "session.idle",
      id,
      parentId: activityId,
      data: { sessionId: "parent", aborted: false },
    } as const;
    coordinator.observeEvent(activity);
    coordinator.observeEvent(terminal);
    terminalDispositions.push(
      `${coordinator.hostEventDisposition(activity)}/${coordinator.hostEventDisposition(terminal)}`,
    );
  };
  assert.match((await hooks.onPreToolUse(input("totally-unmanaged", "authoritative first snapshot"), invocation))?.permissionDecisionReason ?? "", /not active/);
  await coordinator.refresh();

  await reset("use the default specialists");
  let priorEvidence: string | undefined;
  for (const [index, step] of defaultCycle.steps.entries()) {
    const id = cycleDataset.roster.fixed.find((player) => player.id === step.agent)!.runtimeIds.copilot;
    const task = datasetTask(defaultCycle, index, priorEvidence);
    assert.equal((await hooks.onPreToolUse(input(id, task), invocation))?.permissionDecision, "allow");
    await finish(input(id, task), `evidence:${step.agent}`);
    priorEvidence = `evidence:${step.agent}`;
  }

  assert.equal(coordinator.lifecycleIdentityUnverified(), false, "default hook-only cycle poisoned lifecycle identity");
  endTurn("default-cycle-idle");
  assert.deepEqual(terminalDispositions, ["claimed/claimed"]);
  assert.equal(coordinator.lifecycleIdentityUnverified(), false, "correlated root terminal poisoned lifecycle identity");
  await reset("run the SDLC stages");
  priorEvidence = undefined;
  for (const [index, step] of fullCycle.steps.entries()) {
    const id = step.agent;
    const call = input(id, datasetTask(fullCycle, index, priorEvidence));
    const decision = await hooks.onPreToolUse(call, invocation);
    assert.equal(
      decision?.permissionDecision,
      "allow",
      `${step.agent}: ${decision?.permissionDecisionReason ?? "no decision reason"}`,
    );
    if (index === 0) {
      coordinator.observeEvent({
        type: "assistant.turn_start",
        id: "sdlc-root-turn",
        data: { sessionId: "parent", turnId: "sdlc-root-turn" },
      });
      coordinator.observeEvent({
        type: "tool.execution_start",
        id: "sdlc-portfolio-management-start",
        parentId: "sdlc-root-turn",
        data: { sessionId: "parent", toolName: "task", toolCallId: "sdlc-portfolio-management-call" },
      });
    }
    if (index === 0) {
      coordinator.observeEvent({
        type: "subagent.started", id: "sdlc-child-start", parentId: "sdlc-portfolio-management-start",
        agentId: "portfolio-management-child",
        data: { sessionId: "parent", agentName: step.agent, toolCallId: "sdlc-portfolio-management-call" },
      });
      coordinator.observeEvent({
        type: "subagent.completed", id: "sdlc-child-complete", parentId: "sdlc-child-start",
        agentId: "portfolio-management-child",
        data: { sessionId: "parent", agentName: step.agent, toolCallId: "sdlc-portfolio-management-call" },
      });
      assert.match((await hooks.onPreToolUse(input(fullCycle.steps[1].agent, "parallel"), invocation))?.permissionDecisionReason ?? "", /sequentially/);
      coordinator.observeEvent({
        id: "sdlc-tool-complete",
        parentId: "sdlc-child-complete",
        type: "tool.execution_complete",
        data: { sessionId: "parent", toolCallId: "sdlc-portfolio-management-call", success: true, result: `evidence:${step.agent}` },
      });
    } else {
      await finish(call, `evidence:${step.agent}`);
    }
    priorEvidence = `evidence:${step.agent}`;
  }
  assert.match((await hooks.onPreToolUse(input(fullCycle.steps[0].agent, "seventh"), invocation))?.permissionDecisionReason ?? "", /at most six/);
  const expectedCycleAgents = [...defaultCycle.steps, ...fullCycle.steps].map((step) => step.agent);
  assert.deepEqual(
    evidenceEvents.map((event) => `${event.agent}:${event.phase}`),
    expectedCycleAgents.flatMap((agent) => [
      "target.resolved", "child.started", "prompt.attempted", "evidence.returned", "child.completed", "child.cleaned",
    ].map((phase) => `${agent}:${phase}`)),
  );
  assert.ok(evidenceEvents.filter((event) => event.phase === "evidence.returned").every((event) => (event.evidence?.utf8Bytes ?? 0) > 0));
  assert.ok(evidenceEvents.some((event) => event.agent === "portfolio-management" && event.invocationId === "sdlc-portfolio-management-call"));
  assert.ok(evidenceEvents.some((event) => event.childId === "portfolio-management-child" && event.phase === "child.started" && event.basis === "observed"));
  assert.ok(evidenceEvents.some((event) => event.agent === "portfolio-management" && event.phase === "child.cleaned" && event.basis === "inferred"));
  assert.deepEqual(
    evidenceEvents.filter((event) => event.phase === "target.resolved").map((event) => event.runtimeAgent),
    [
      ...defaultCycle.steps.map((step) => cycleDataset.roster.fixed.find((player) => player.id === step.agent)!.runtimeIds.copilot),
      ...fullCycle.steps.map((step) => step.agent),
    ],
  );
  const reloadsAfterCycles = reloads;
  assert.ok(reloadsAfterCycles >= expectedCycleAgents.length + 2,
    "team-lead preToolUse did not authoritatively refresh the native registry");

  endTurn("sdlc-cycle-idle");
  await reset("reject invalid delegations");
  const serialized = input("portfolio-management", "serialized host arguments");
  serialized.toolArgs = JSON.stringify(serialized.toolArgs) as any;
  assert.equal((await hooks.onPreToolUse(serialized, invocation))?.permissionDecision, "allow");
  await finish(serialized as any, "serialized evidence");
  assert.match(
    (await hooks.onPreToolUse(input("portfolio-management", "retry after success"), invocation))
      ?.permissionDecisionReason ?? "",
    /already delegated to portfolio-management in this user prompt/u,
  );
  await reset("a new user prompt resets the consumed target set");
  const failedOnce = input("portfolio-management", "admitted child fails");
  assert.equal((await hooks.onPreToolUse(failedOnce, invocation))?.permissionDecision, "allow");
  await hooks.onPostToolUseFailure({ ...failedOnce, error: new Error("child failed") }, invocation);
  assert.match(
    (await hooks.onPreToolUse(input("portfolio-management", "retry after failure"), invocation))
      ?.permissionDecisionReason ?? "",
    /already delegated to portfolio-management in this user prompt/u,
  );
  await reset("the following user prompt may delegate to that target once again");
  const afterPromptReset = input("portfolio-management", "fresh prompt delegation");
  assert.equal((await hooks.onPreToolUse(afterPromptReset, invocation))?.permissionDecision, "allow");
  await finish(afterPromptReset, "fresh prompt evidence");
  endTurn("serialized-cycle-idle");
  await reset("reject malformed serialized delegations");
  assert.match((await hooks.onPreToolUse({ ...input("portfolio-management", "work"), toolArgs: "not-json" }, invocation))?.permissionDecisionReason ?? "", /bounded object/);
  assert.match((await hooks.onPreToolUse({ ...input("portfolio-management", "work"), toolArgs: "[]" }, invocation))?.permissionDecisionReason ?? "", /bounded object/);
  const oversizedObject = input("portfolio-management", "work");
  oversizedObject.toolArgs = { ...oversizedObject.toolArgs, description: "x".repeat(100_001) };
  assert.match((await hooks.onPreToolUse(oversizedObject, invocation))?.permissionDecisionReason ?? "", /bounded object/);
  assert.match((await hooks.onPreToolUse({ ...input("portfolio-management", "work"), toolArgs: JSON.stringify(oversizedObject.toolArgs) }, invocation))?.permissionDecisionReason ?? "", /bounded object/);
  assert.match((await hooks.onPreToolUse(input(copilotFixedAgentIds.get("team-lead")!, "recurse"), invocation))?.permissionDecisionReason ?? "", /recursively/);
  assert.match((await hooks.onPreToolUse(input("portfolio-management", "   "), invocation))?.permissionDecisionReason ?? "", /non-empty/);
  assert.match((await hooks.onPreToolUse(input("portfolio-management", "x".repeat(30_001)), invocation))?.permissionDecisionReason ?? "", /exceeds 30000 bytes/);
  assert.match((await hooks.onPreToolUse(input("portfolio-management", "nested", "child"), invocation))?.permissionDecisionReason ?? "", /nested/);
  await roster.bench("off dispose", bundledPlayers);
  assert.match((await hooks.onPreToolUse(input("dispose", "retire safely"), invocation))?.permissionDecisionReason ?? "", /not active/);

  failCurrent = true;
  await assert.rejects(() => coordinator.refresh(), /current unavailable/);
  assert.match((await hooks.onPreToolUse(input("portfolio-management", "work"), invocation))?.permissionDecisionReason ?? "", /fails closed/);
  failCurrent = false; await coordinator.refresh(); failReload = true;
  await assert.rejects(() => coordinator.refresh(), /reload unavailable/);
  assert.match((await hooks.onPreToolUse(input("portfolio-management", "work"), invocation))?.permissionDecisionReason ?? "", /snapshot is unavailable/);
  failReload = false; await coordinator.refresh();

  current = copilotFixedAgentIds.get("crafter")!;
  await coordinator.refresh();
  assert.equal(await hooks.onPreToolUse(input("portfolio-management", "unrelated agent task"), invocation), undefined);
  current = copilotFixedAgentIds.get("team-lead")!;
  coordinator.observeEvent({
    type: "subagent.selected",
    id: "manual-team-lead-selected",
    data: { sessionId: "parent", agentName: "team-lead" },
  });
  endTurn("invalid-cycle-idle");
  await reset("selection event normalizes the logical lead ID");
  const selectedCall = input("portfolio-management", "selected lead task");
  assert.equal((await hooks.onPreToolUse(selectedCall, invocation))?.permissionDecision, "allow");
  await finish(selectedCall, "selected lead evidence");
  endTurn("selected-cycle-idle");
  coordinator.observeEvent({
    type: "subagent.selected",
    id: "nested-crafter-selected",
    parentId: "nested-task-event",
    agentId: "nested",
    data: {
      sessionId: "parent",
      agentName: "crafter",
      initiator: "sub-agent",
      parentToolCallId: "nested-task",
    },
  });
  await reset("nested selection events cannot replace the root selection");
  const afterNestedSelection = input("portfolio-management", "root lead remains selected");
  const afterNestedDecision = await hooks.onPreToolUse(afterNestedSelection, invocation);
  assert.equal(
    afterNestedDecision?.permissionDecision,
    "allow",
    afterNestedDecision?.permissionDecisionReason,
  );
  await finish(afterNestedSelection, "nested selection ignored");
  current = copilotFixedAgentIds.get("crafter")!;
  coordinator.observeEvent({ type: "subagent.deselected", data: {} });
  assert.equal(await hooks.onPreToolUse(input("portfolio-management", "deselected task"), invocation), undefined);
  assert.ok(reloads > reloadsAfterCycles, "later team-lead preflights did not refresh the registry");

  let markReloadStarted!: () => void;
  const reloadStarted = new Promise<void>((resolve) => { markReloadStarted = resolve; });
  let releaseReload!: () => void;
  const reloadGate = new Promise<void>((resolve) => { releaseReload = resolve; });
  const racingEvidence: HarborEvidenceEvent[] = [];
  let racingCurrent = copilotFixedAgentIds.get("crafter")!;
  const racingCoordinator = createCopilotCoordinatorGuard(() => ({ rpc: { agent: {
    getCurrent: async () => ({ agent: agents.find(({ id }) => id === racingCurrent) }),
    reload: async () => {
      markReloadStarted();
      await reloadGate;
      return { agents };
    },
  } } }), (event) => racingEvidence.push(event));
  const racingRefresh = racingCoordinator.refresh();
  await reloadStarted;
  racingCurrent = copilotFixedAgentIds.get("team-lead")!;
  racingCoordinator.observeEvent({ type: "subagent.selected", data: { agentName: "team-lead" } });
  releaseReload();
  await racingRefresh;
  const racingInvocation = { sessionId: "racing-parent" };
  await racingCoordinator.hooks.onUserPromptSubmitted({
    sessionId: racingInvocation.sessionId, workingDirectory: project, prompt: "concurrent selection",
  }, racingInvocation);
  const racingCall = input("portfolio-management", "selection event wins the refresh race", racingInvocation.sessionId);
  assert.equal((await racingCoordinator.hooks.onPreToolUse(racingCall, racingInvocation))?.permissionDecision, "allow",
    "a newer root selection event must not be overwritten by a stale refresh result");
  assert.equal(racingEvidence.find((event) => event.phase === "target.resolved")?.agent, "portfolio-management");
  await racingCoordinator.hooks.onPostToolUse({ ...racingCall, toolResult: "race evidence" }, racingInvocation);

  let markDeselectReloadStarted!: () => void;
  const deselectReloadStarted = new Promise<void>((resolve) => { markDeselectReloadStarted = resolve; });
  let releaseDeselectReload!: () => void;
  const deselectReloadGate = new Promise<void>((resolve) => { releaseDeselectReload = resolve; });
  let deselectCurrent: string | undefined = copilotFixedAgentIds.get("team-lead")!;
  const deselectCoordinator = createCopilotCoordinatorGuard(() => ({ rpc: { agent: {
    getCurrent: async () => ({ agent: deselectCurrent ? { id: deselectCurrent } : undefined }),
    reload: async () => {
      markDeselectReloadStarted();
      await deselectReloadGate;
      return { agents };
    },
  } } }));
  const deselectRefresh = deselectCoordinator.refresh();
  await deselectReloadStarted;
  deselectCurrent = undefined;
  deselectCoordinator.observeEvent({ type: "subagent.deselected", data: {} });
  releaseDeselectReload();
  await deselectRefresh;
  assert.equal(await deselectCoordinator.hooks.onPreToolUse(
    input("portfolio-management", "newer deselection wins", "deselected-parent"), { sessionId: "deselected-parent" },
  ), undefined, "a newer root deselection must not be overwritten by a stale refresh result");

  let markFailingReloadStarted!: () => void;
  const failingReloadStarted = new Promise<void>((resolve) => { markFailingReloadStarted = resolve; });
  let releaseFailingReload!: () => void;
  const failingReloadGate = new Promise<void>((resolve) => { releaseFailingReload = resolve; });
  let failingReload = true;
  const failureRaceEvidence: HarborEvidenceEvent[] = [];
  const failureRaceCoordinator = createCopilotCoordinatorGuard(() => ({ rpc: { agent: {
    getCurrent: async () => ({ agent: agents.find(({ id }) => id === (failingReload
      ? copilotFixedAgentIds.get("crafter")!
      : copilotFixedAgentIds.get("team-lead")!)) }),
    reload: async () => {
      if (failingReload) {
        markFailingReloadStarted();
        await failingReloadGate;
        throw new Error("delayed reload failure");
      }
      return { agents };
    },
  } } }), (event) => failureRaceEvidence.push(event));
  const failedRefresh = failureRaceCoordinator.refresh();
  await failingReloadStarted;
  failureRaceCoordinator.observeEvent({ type: "subagent.selected", data: { agentName: "team-lead" } });
  releaseFailingReload();
  await assert.rejects(failedRefresh, /delayed reload failure/);
  failingReload = false;
  await failureRaceCoordinator.refresh();
  // The failed refresh retained only an id-only event, so wait for the fresh
  // registry/path proof before claiming a native task correlation.
  failureRaceCoordinator.observeEvent({
    type: "tool.execution_start", data: { toolName: "task", toolCallId: "post-failure-selection-call" },
  });
  const failureRaceInvocation = { sessionId: "failure-race-parent" };
  const failureRaceCall = input("portfolio-management", "selection survives failed refresh", failureRaceInvocation.sessionId);
  assert.equal((await failureRaceCoordinator.hooks.onPreToolUse(failureRaceCall, failureRaceInvocation))?.permissionDecision, "allow");
  const refreshedInvocation = failureRaceEvidence.find((event) => event.phase === "target.resolved")?.invocationId;
  assert.match(refreshedInvocation ?? "", /^[A-Za-z0-9_-]{43}$/,
    "a failed refresh erased a newer selection event");
  assert.notEqual(refreshedInvocation, "post-failure-selection-call",
    "raw host correlation IDs must not be retained in public evidence");
  await failureRaceCoordinator.hooks.onPostToolUse({ ...failureRaceCall, toolResult: "failure race evidence" }, failureRaceInvocation);
});

test("OpenCode orchestrator uses one child session through its SDK client", async () => {
  const events: string[] = [];
  const client = { session: {
    create: async () => { events.push("create"); return { data: { id: "child" } }; },
    update: confirmOpenCodeSessionTitle,
    prompt: async ({ path, body }: any) => { events.push(`prompt:${path.id}:${body.agent}:${body.tools.read}:${body.tools.bash}`); return { data: { parts: [{ type: "text", text: "done" }] } }; },
    delete: async ({ path }: any) => { events.push(`delete:${path.id}`); return { data: true }; },
  } };
  const orchestrator = new OpenCodeOrchestrator(client as any, process.cwd());
  assert.equal(await orchestrator.run(definition as any), "done");
  assert.deepEqual(events, ["create", "prompt:child:explore:true:false", "delete:child"]);
});

test("OpenCode bounds hung child cleanup and preserves a simultaneous execution failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "harbor-opencode-cleanup-bounds-"));
  const neverDeletes = { session: {
    create: async () => ({ data: { id: "hung-cleanup" } }),
    update: confirmOpenCodeSessionTitle,
    prompt: async () => ({ data: { parts: [{ type: "text", text: "done" }] } }),
    delete: async () => new Promise<never>(() => {}),
  } };
  const started = Date.now();
  const hungCleanup = new OpenCodeOrchestrator(neverDeletes as any, join(root, "hung"), undefined, undefined, 25);
  await assert.rejects(() => hungCleanup.run(definition as any), /OpenCode child cleanup failed after two bounded attempts/u);
  assert.ok(Date.now() - started < 500, "hung OpenCode cleanup was not bounded");

  const promptAndCleanupFail = new OpenCodeOrchestrator({ session: {
    create: async () => ({ data: { id: "double-failure" } }),
    update: confirmOpenCodeSessionTitle,
    prompt: async () => { throw new Error("OpenCode prompt failed before hung cleanup"); },
    delete: async () => new Promise<never>(() => {}),
  } } as any, join(root, "double"), undefined, undefined, 25);
  await assert.rejects(() => promptAndCleanupFail.run(definition as any), (error: any) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors[0].message, "OpenCode prompt failed before hung cleanup");
    assert.ok(error.errors[1] instanceof AggregateError);
    assert.equal(error.errors[1].errors.length, 2);
    assert.ok(error.errors[1].errors.every((entry: Error) => /timed out after 25ms/u.test(entry.message)));
    return true;
  });
});

test("Pi orchestrator uses one in-memory SDK session", async () => {
  const events: string[] = [];
  const loaders: any[] = [];
  const agentDir = "pi-agent-home";
  const model = { provider: "openai-codex", id: "gpt-test" };
  const hostAuthPath = join(agentDir, "auth.json");
  let modelRuntimeCreates = 0;
  let createOptions: any;
  const session = {
    subscribe: (handler: any) => { session.handler = handler; return () => events.push("unsubscribe"); },
    handler: (_event: any) => {},
    prompt: async (text: string) => { events.push(`prompt:${text.includes("Do it")}`); session.handler({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "done" } }); },
    abort: async () => { events.push("abort"); },
    dispose: () => events.push("dispose"),
  };
  const sdk = {
    DefaultResourceLoader: class {
      private readonly options: any;
      private result = { skills: [], diagnostics: [] };
      constructor(options: any) { this.options = options; loaders.push(options); }
      async reload() {
        events.push("reload");
        this.result = this.options.skillsOverride({ skills: [], diagnostics: [] });
      }
      getSkills() { return this.result; }
    },
    getAgentDir: () => agentDir,
    ModelRuntime: { create: async () => { modelRuntimeCreates += 1; throw new Error("unexpected runtime"); } },
    SessionManager: { inMemory: (cwd: string) => { events.push(`memory:${cwd === process.cwd()}`); return {}; } },
    createAgentSession: async (options: any) => {
      createOptions = options;
      const derivedAuthPath = options.agentDir === undefined ? undefined : join(options.agentDir, "auth.json");
      if (derivedAuthPath !== hostAuthPath || options.model?.provider !== "openai-codex") {
        throw new Error("No API key found for openai-codex");
      }
      events.push(`create:${options.cwd === process.cwd()}:${options.tools.join(",")}`);
      return { session };
    },
  };
  const orchestrator = new PiOrchestrator(
    process.cwd(), async () => sdk as any, [], undefined, [], undefined, { model, thinkingLevel: "minimal" },
  );
  assert.equal(await orchestrator.run(definition as any), "done");
  assert.deepEqual(events, ["reload", "memory:true", "create:true:read", "prompt:true", "unsubscribe", "dispose"]);
  assert.equal(loaders.length, 1);
  assert.deepEqual({ ...loaders[0], skillsOverride: undefined }, {
    cwd: process.cwd(), agentDir: "pi-agent-home", additionalSkillPaths: [],
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    skillsOverride: undefined,
  });
  assert.equal(typeof loaders[0].skillsOverride, "function");
  assert.equal(createOptions.agentDir, agentDir);
  assert.equal(createOptions.modelRuntime, undefined);
  assert.equal(modelRuntimeCreates, 0, "a builtin provider created an unnecessary isolated model runtime");
  assert.equal(createOptions.model, model);
  assert.equal(createOptions.thinkingLevel, "minimal");
  assert.equal(createOptions.resourceLoader instanceof sdk.DefaultResourceLoader, true);
});

test("Pi orchestrator replays projected providers into a public isolated ModelRuntime before session creation", async () => {
  const root = await mkdtemp(join(tmpdir(), "harbor-pi-provider-replay-"));
  const agentDir = join(root, "pi-home");
  const secret = "runtime-secret-must-stay-in-memory";
  const events: string[] = [];
  const registered = new Map<string, any>();
  let runtimeCreateOptions: any;
  let createOptions: any;
  const runtime = {
    registerProvider: (id: string, config: any) => {
      events.push(`runtime:register:${id}`);
      registered.set(id, config);
    },
    setRuntimeApiKey: async (id: string, key: string) => {
      assert.equal(key, secret);
      events.push(`runtime:key:${id}`);
    },
    refresh: async (options: any) => {
      assert.deepEqual(options, { allowNetwork: false });
      events.push("runtime:refresh");
    },
  };
  const session = {
    subscribe: (handler: any) => { session.handler = handler; return () => events.push("unsubscribe"); },
    handler: (_event: any) => {},
    prompt: async () => {
      events.push("prompt");
      session.handler({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "replayed" } });
    },
    abort: async () => {},
    dispose: () => events.push("dispose"),
  };
  const sdk = {
    DefaultResourceLoader: class {
      private result = { skills: [], diagnostics: [] };
      constructor(private readonly options: any) {}
      async reload() {
        events.push("loader:reload");
        this.result = this.options.skillsOverride(this.result);
      }
      getSkills() { return this.result; }
    },
    getAgentDir: () => agentDir,
    ModelRuntime: {
      create: async (options: any) => {
        runtimeCreateOptions = options;
        events.push("runtime:create");
        return runtime;
      },
    },
    SessionManager: { inMemory: () => ({}) },
    createAgentSession: async (options: any) => {
      createOptions = options;
      events.push("session:create");
      return { session };
    },
  };
  const model = { provider: "runtime-router", id: "runtime-model" };
  const providerProjections = [
    { id: "runtime-router", config: { name: "Runtime router" }, runtimeKey: secret },
    { id: "stored-router", config: { name: "Stored router" } },
  ];
  const orchestrator = new PiOrchestrator(
    root,
    async () => sdk as any,
    [],
    undefined,
    [],
    undefined,
    { model, thinkingLevel: "low", providerProjections },
  );

  const evidence = await orchestrator.run(definition as any);

  assert.equal(evidence, "replayed");
  assert.deepEqual(runtimeCreateOptions, {
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
    allowModelNetwork: false,
  });
  assert.deepEqual(events, [
    "loader:reload",
    "runtime:create",
    "runtime:register:runtime-router",
    "runtime:register:stored-router",
    "runtime:key:runtime-router",
    "runtime:refresh",
    "session:create",
    "prompt",
    "unsubscribe",
    "dispose",
  ]);
  assert.equal(createOptions.modelRuntime, runtime);
  assert.equal(createOptions.model, model);
  assert.deepEqual(registered.get("runtime-router"), { name: "Runtime router" });
  assert.deepEqual(registered.get("stored-router"), { name: "Stored router" });
  assert.doesNotMatch(`${evidence}\n${events.join("\n")}`, new RegExp(secret, "u"));
  await assert.rejects(access(join(agentDir, "auth.json")));
  await assert.rejects(access(join(agentDir, "models.json")));
});

test("Pi orchestrator recovers evidence from the settled child transcript when streaming emits no deltas", async () => {
  const session = {
    messages: [
      { role: "user", content: [{ type: "text", text: "request" }] },
      { role: "assistant", content: [{ type: "thinking", thinking: "private" }, { type: "text", text: "settled evidence" }] },
    ],
    subscribe: () => () => {},
    prompt: async () => {},
    abort: async () => {},
    dispose: () => {},
  };
  const sdk = {
    DefaultResourceLoader: class {
      private readonly options: any;
      constructor(options: any) { this.options = options; }
      async reload() { this.options.skillsOverride({ skills: [], diagnostics: [] }); }
      getSkills() { return { skills: [], diagnostics: [] }; }
    },
    getAgentDir: () => "pi-agent-home",
    SessionManager: { inMemory: () => ({}) },
    createAgentSession: async () => ({ session }),
  };
  assert.equal(await new PiOrchestrator(process.cwd(), async () => sdk as any).run(definition as any), "settled evidence");
});

test("OpenCode and Pi return explicitly truncated child evidence within one shared UTF-8 cap", async () => {
  const hugeEvidence = `start:${"🙂".repeat(10_000)}:end`;
  const openClient = { session: {
    create: async () => ({ data: { id: "bounded-child" } }),
    update: confirmOpenCodeSessionTitle,
    prompt: async () => ({ data: { parts: [{ type: "text", text: hugeEvidence }] } }),
    delete: async () => ({ data: true }),
  } };
  const openEvidence = await new OpenCodeOrchestrator(openClient as any, process.cwd()).run(definition as any);

  const piSession = {
    messages: [{ role: "assistant", content: [{ type: "text", text: hugeEvidence }] }],
    subscribe: () => () => {}, prompt: async () => {}, abort: async () => {}, dispose: () => {},
  };
  const piSdk = {
    DefaultResourceLoader: class {
      private readonly options: any;
      constructor(options: any) { this.options = options; }
      async reload() { this.options.skillsOverride({ skills: [], diagnostics: [] }); }
      getSkills() { return { skills: [], diagnostics: [] }; }
    },
    getAgentDir: () => "pi-agent-home",
    SessionManager: { inMemory: () => ({}) },
    createAgentSession: async () => ({ session: piSession }),
  };
  const piEvidence = await new PiOrchestrator(process.cwd(), async () => piSdk as any).run(definition as any);

  for (const evidence of [openEvidence, piEvidence]) {
    assert.ok(Buffer.byteLength(evidence, "utf8") <= 30_000);
    assert.match(evidence, /\[HARBOR-EVIDENCE-TRUNCATED original_utf8_bytes=40010 limit=30000\]$/u);
    assert.doesNotMatch(evidence, /�/u);
  }
});

test("Pi gives a child exactly its invocation-scoped skill allowlist", async () => {
  const project = await mkdtemp(join(tmpdir(), "harbor-pi-skills-"));
  const repositorySkill = join(project, "skills", "allowed", "SKILL.md");
  await mkdir(dirname(repositorySkill), { recursive: true });
  await writeFile(repositorySkill, [
    "---", "name: allowed-skill", "description: Bounded test skill", "---", "", "Use the bounded fixture.", "",
  ].join("\n"));
  const events: string[] = [];
  let loaderOptions: any;
  let loaded: any = { skills: [], diagnostics: [] };
  let capsuleFile = "";
  const sdk = {
    DefaultResourceLoader: class {
      private readonly options: any;
      constructor(options: any) { this.options = options; loaderOptions = options; capsuleFile = options.additionalSkillPaths[0]; }
      async reload() {
        events.push("reload");
        const base = {
          skills: this.options.additionalSkillPaths.map((filePath: string) => ({
            name: basename(dirname(filePath)), description: "isolated", filePath, baseDir: dirname(filePath),
            sourceInfo: {}, disableModelInvocation: true,
          })),
          diagnostics: [],
        };
        loaded = this.options.skillsOverride(base);
      }
      getSkills() { events.push("getSkills"); return loaded; }
    },
    getAgentDir: () => join(project, "ambient-pi-home"),
    SessionManager: { inMemory: () => ({}) },
    createAgentSession: async () => {
      events.push("create");
      assert.deepEqual(loaded.skills.map((skill: any) => ({ name: skill.name, filePath: skill.filePath, disabled: skill.disableModelInvocation })), [
        { name: "allowed-skill", filePath: capsuleFile, disabled: false },
      ]);
      let handler = (_event: unknown) => {};
      return { session: {
        subscribe: (next: (event: unknown) => void) => { handler = next; return () => events.push("unsubscribe"); },
        prompt: async () => handler({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "isolated" } }),
        abort: async () => {}, dispose: () => events.push("dispose"),
      } };
    },
  };
  const skillDefinition = {
    ...definition,
    skills: [{ kind: "repo", name: "allowed-skill", path: "skills/allowed/SKILL.md" }],
  };
  assert.equal(await new PiOrchestrator(project, async () => sdk as any).run(skillDefinition as any), "isolated");
  assert.deepEqual(events, ["reload", "getSkills", "create", "unsubscribe", "dispose"]);
  assert.equal(loaderOptions.noSkills, true);
  assert.deepEqual(loaderOptions.additionalSkillPaths, [capsuleFile]);
  assert.equal(basename(capsuleFile), "SKILL.md");
  assert.notEqual(resolve(capsuleFile), resolve(repositorySkill));
  await assert.rejects(access(dirname(dirname(capsuleFile))), (error: any) => error?.code === "ENOENT");
});

test("Pi fails closed on ambient, malformed, or post-reload skill discovery and cleans the capsule", async (t) => {
  for (const variant of ["ambient", "diagnostic", "post-reload"] as const) {
    await t.test(variant, async () => {
      const project = await mkdtemp(join(tmpdir(), `harbor-pi-${variant}-`));
      const source = join(project, "skills", "allowed", "SKILL.md");
      await mkdir(dirname(source), { recursive: true });
      await writeFile(source, "---\nname: allowed-skill\ndescription: bounded\n---\n\nDo bounded work.\n");
      let capsuleFile = ""; let children = 0; let result: any = { skills: [], diagnostics: [] };
      const sdk = {
        DefaultResourceLoader: class {
          private readonly options: any;
          constructor(options: any) { this.options = options; capsuleFile = options.additionalSkillPaths[0]; }
          async reload() {
            const expected = {
              name: "allowed-skill", description: "isolated", filePath: capsuleFile, baseDir: dirname(capsuleFile),
              sourceInfo: {}, disableModelInvocation: true,
            };
            const skills = variant === "ambient"
              ? [expected, { ...expected, name: "ambient-skill", filePath: join(project, "ambient", "SKILL.md") }]
              : [expected];
            const diagnostics = variant === "diagnostic"
              ? [{ type: "warning", message: "malformed skill", path: capsuleFile }]
              : [];
            result = this.options.skillsOverride({ skills, diagnostics });
          }
          getSkills() {
            return variant === "post-reload"
              ? { skills: [{ ...result.skills[0], filePath: join(project, "ambient", "SKILL.md") }], diagnostics: [] }
              : result;
          }
        },
        getAgentDir: () => join(project, "ambient-pi-home"),
        SessionManager: { inMemory: () => ({}) },
        createAgentSession: async () => { children += 1; throw new Error("child must not start"); },
      };
      const skillDefinition = {
        ...definition,
        skills: [{ kind: "repo", name: "allowed-skill", path: "skills/allowed/SKILL.md" }],
      };
      await assert.rejects(
        () => new PiOrchestrator(project, async () => sdk as any).run(skillDefinition as any),
        /isolated skill|outside the configured allowlist/,
      );
      assert.equal(children, 0);
      await assert.rejects(access(dirname(dirname(capsuleFile))), (error: any) => error?.code === "ENOENT");
    });
  }
});

test("Pi cancellation during skill reload creates no child and cleans the capsule", async () => {
  const project = await mkdtemp(join(tmpdir(), "harbor-pi-reload-abort-"));
  const source = join(project, "skills", "allowed", "SKILL.md");
  await mkdir(dirname(source), { recursive: true });
  await writeFile(source, "---\nname: allowed-skill\ndescription: bounded\n---\n\nDo bounded work.\n");
  const controller = new AbortController();
  let capsuleFile = ""; let children = 0; let result: any = { skills: [], diagnostics: [] };
  const sdk = {
    DefaultResourceLoader: class {
      private readonly options: any;
      constructor(options: any) { this.options = options; capsuleFile = options.additionalSkillPaths[0]; }
      async reload() {
        result = this.options.skillsOverride({
          skills: [{
            name: "allowed-skill", description: "isolated", filePath: capsuleFile, baseDir: dirname(capsuleFile),
            sourceInfo: {}, disableModelInvocation: true,
          }],
          diagnostics: [],
        });
        controller.abort();
      }
      getSkills() { return result; }
    },
    getAgentDir: () => join(project, "ambient-pi-home"),
    SessionManager: { inMemory: () => ({}) },
    createAgentSession: async () => { children += 1; throw new Error("child must not start"); },
  };
  const skillDefinition = {
    ...definition,
    skills: [{ kind: "repo", name: "allowed-skill", path: "skills/allowed/SKILL.md" }],
  };

  await assert.rejects(
    () => new PiOrchestrator(project, async () => sdk as any).run(skillDefinition as any, controller.signal),
    (error: any) => error?.name === "AbortError",
  );
  assert.equal(children, 0);
  await assert.rejects(access(dirname(dirname(capsuleFile))), (error: any) => error?.code === "ENOENT");
});

test("Pi cleans an isolated skill capsule after loader, child-creation, and session failures", async (t) => {
  for (const variant of ["reload", "create", "session"] as const) {
    await t.test(variant, async () => {
      const project = await mkdtemp(join(tmpdir(), `harbor-pi-cleanup-${variant}-`));
      const source = join(project, "skills", "allowed", "SKILL.md");
      await mkdir(dirname(source), { recursive: true });
      await writeFile(source, "---\nname: allowed-skill\ndescription: bounded\n---\n\nDo bounded work.\n");
      let capsuleFile = ""; let result: any = { skills: [], diagnostics: [] }; let disposed = false;
      const sdk = {
        DefaultResourceLoader: class {
          private readonly options: any;
          constructor(options: any) { this.options = options; capsuleFile = options.additionalSkillPaths[0]; }
          async reload() {
            if (variant === "reload") throw new Error("reload failed");
            result = this.options.skillsOverride({
              skills: [{
                name: "allowed-skill", description: "isolated", filePath: capsuleFile, baseDir: dirname(capsuleFile),
                sourceInfo: {}, disableModelInvocation: true,
              }],
              diagnostics: [],
            });
          }
          getSkills() { return result; }
        },
        getAgentDir: () => join(project, "ambient-pi-home"),
        SessionManager: { inMemory: () => ({}) },
        createAgentSession: async () => {
          if (variant === "create") throw new Error("create failed");
          return { session: {
            subscribe: () => () => {}, prompt: async () => { throw new Error("session failed"); },
            abort: async () => {}, dispose: () => { disposed = true; },
          } };
        },
      };
      const skillDefinition = {
        ...definition,
        skills: [{ kind: "repo", name: "allowed-skill", path: "skills/allowed/SKILL.md" }],
      };
      await assert.rejects(
        () => new PiOrchestrator(project, async () => sdk as any).run(skillDefinition as any),
        new RegExp(`${variant} failed`),
      );
      assert.equal(disposed, variant === "session");
      await assert.rejects(access(dirname(dirname(capsuleFile))), (error: any) => error?.code === "ENOENT");
    });
  }
});

test("SDK orchestrators clean up child sessions when prompting fails", async () => {
  const copilotEvents: string[] = [];
  const copilot = new CopilotOrchestrator(() => ({
    createSession: async () => ({ sessionId: "failed", abort: async () => {}, sendAndWait: async () => { throw new Error("prompt failed"); } }),
    deleteSession: async () => { copilotEvents.push("delete"); },
    stop: async () => { copilotEvents.push("stop"); },
  }) as any);
  await assert.rejects(() => copilot.run(definition as any), /prompt failed/);
  assert.deepEqual(copilotEvents, ["delete", "stop"]);

  const openCodeEvents: string[] = [];
  const openCode = new OpenCodeOrchestrator({ session: {
    create: async () => ({ data: { id: "failed" } }),
    update: confirmOpenCodeSessionTitle,
    prompt: async () => { throw new Error("prompt failed"); },
    delete: async () => { openCodeEvents.push("delete"); return { data: true }; },
  } } as any, process.cwd());
  await assert.rejects(() => openCode.run(definition as any), /prompt failed/);
  assert.deepEqual(openCodeEvents, ["delete"]);

  const piEvents: string[] = [];
  const pi = new PiOrchestrator(process.cwd(), async () => ({
    ...emptyPiResourceSdk(),
    SessionManager: { inMemory: () => ({}) },
    createAgentSession: async () => ({ session: {
      subscribe: () => () => { piEvents.push("unsubscribe"); },
      prompt: async () => { throw new Error("prompt failed"); },
      abort: async () => {},
      dispose: () => { piEvents.push("dispose"); },
    } }),
  }) as any);
  await assert.rejects(() => pi.run(definition as any), /prompt failed/);
  assert.deepEqual(piEvents, ["unsubscribe", "dispose"]);
});

test("SDK orchestrators preserve execution and cleanup failures together", async () => {
  const copilot = new CopilotOrchestrator(() => ({
    createSession: async () => ({ sessionId: "failed", abort: async () => {}, sendAndWait: async () => { throw new Error("copilot prompt failed"); } }),
    deleteSession: async () => { throw new Error("copilot delete failed"); },
    stop: async () => {},
  }) as any);
  await assert.rejects(() => copilot.run(definition as any), (error: any) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors.map((entry: Error) => entry.message), ["copilot prompt failed", "copilot delete failed"]);
    return true;
  });

  const openCodeProject = await mkdtemp(join(tmpdir(), "harbor-opencode-double-failure-"));
  const openCode = new OpenCodeOrchestrator({ session: {
    create: async () => ({ data: { id: "failed" } }),
    update: confirmOpenCodeSessionTitle,
    prompt: async () => { throw new Error("opencode prompt failed"); },
    delete: async () => { throw new Error("opencode delete failed"); },
  } } as any, openCodeProject);
  await assert.rejects(() => openCode.run(definition as any), (error: any) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors[0].message, "opencode prompt failed");
    assert.ok(error.errors[1] instanceof AggregateError);
    assert.deepEqual(error.errors[1].errors.map((entry: Error) => entry.message), [
      "opencode delete failed", "opencode delete failed",
    ]);
    return true;
  });

  const piEvents: string[] = [];
  const pi = new PiOrchestrator(process.cwd(), async () => ({
    ...emptyPiResourceSdk(),
    SessionManager: { inMemory: () => ({}) },
    createAgentSession: async () => ({ session: {
      subscribe: () => () => { piEvents.push("unsubscribe"); throw new Error("pi unsubscribe failed"); },
      prompt: async () => { throw new Error("pi prompt failed"); },
      abort: async () => {},
      dispose: () => { piEvents.push("dispose"); throw new Error("pi dispose failed"); },
    } }),
  }) as any);
  await assert.rejects(() => pi.run(definition as any), (error: any) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors.map((entry: Error) => entry.message), ["pi prompt failed", "pi unsubscribe failed", "pi dispose failed"]);
    return true;
  });
  assert.deepEqual(piEvents, ["unsubscribe", "dispose"]);
});

test("contract skills are validated and materialized before any SDK child is created", async () => {
  let children = 0; let childConfig: any;
  const client = {
    createSession: async (config: any) => {
      children += 1; childConfig = config;
      assert.match(await readFile(join(config.skillDirectories[0], "zx-example-author", "SKILL.md"), "utf8"), /Use verified guidance/);
      return { sessionId: "skill-child", abort: async () => {}, sendAndWait: async () => ({ data: { content: "done" } }) };
    },
    deleteSession: async () => {}, stop: async () => {},
  };
  const github = {
    resolve: async () => ({ commit: "a".repeat(40), blob: "b".repeat(40) }),
    load: async () => ({ commit: "c".repeat(40), body: "Use verified guidance." }),
  };
  const withSkill = { ...definition, tools: ["read"], skills: [trustedSkills[0]] };
  assert.equal(await new CopilotOrchestrator(() => client as any, process.cwd(), github).run(withSkill as any), "done");
  assert.equal(children, 1);
  assert.equal(childConfig.enableConfigDiscovery, false);
  assert.equal(childConfig.enableSkills, true);
  assert.deepEqual(childConfig.customAgents[0].skills, ["zx-example-author"]);
  assert.deepEqual(childConfig.customAgents[0].tools, ["read"]);
  assert.match(childConfig.customAgents[0].prompt, /Only these skills are assigned/);
  assert.doesNotMatch(childConfig.customAgents[0].prompt, /Use verified guidance/);
  await assert.rejects(() => access(childConfig.skillDirectories[0]), /ENOENT/);

  const rejected = new CopilotOrchestrator(() => {
    children += 1; return client as any;
  }, process.cwd(), { ...github, load: async () => { throw new Error("invalid remote skill"); } });
  await assert.rejects(() => rejected.run(withSkill as any), /invalid remote skill/);
  assert.equal(children, 1, "skill validation must finish before creating a child");
});

test("OpenCode plugin exposes direct player aliases and an isolated talent scout", async () => {
  const root = await mkdtemp(join(tmpdir(), "harbor-opencode-adapter-"));
  const previous = process.env.OPENCODE_CONFIG_DIR;
  process.env.OPENCODE_CONFIG_DIR = join(root, "home");
  const initial = join(root, "initial"); const current = join(root, "current");
  const plugin = await AgentHarborPlugin({
    client: {
      session: {
        ...emptyOpenCodeActivitySession(),
        message: async ({ path }: any) => ({ data: {
          info: {
            id: path.messageID,
            role: "user",
            model: { providerID: "openai", modelID: "gpt-5.3-codex-spark" },
          },
          parts: [],
        } }),
      },
    },
    directory: initial,
  } as any, {});
  const config: any = {};
  await plugin.config?.(config);
  for (const name of commandNames) {
    assert.equal(config.command[name], undefined,
      `OpenCode server config must not route deterministic /${name} through a model session`);
  }
  for (const id of rolePlayers.keys()) assert.deepEqual(config.command[id], {
    description: `Run Agent Harbor player ${id} in the current session`,
    template: "$ARGUMENTS",
    agent: id,
    subtask: false,
  });
  assert.equal(config.agent["team-lead"].tools.harbor, false);
  assert.equal(config.agent["team-lead"].tools["*"], false);
  assert.equal(config.agent["team-lead"].tools.harbor_contract, false);
  assert.equal(config.agent["team-lead"].tools.harbor_delegate, true);
  assert.equal(config.agent["team-lead"].tools.harbor_team_roster, true);
  assert.equal(config.agent["team-lead"].tools.bash, false);
  assert.equal(config.agent["team-lead"].permission["*"], "deny");
  assert.equal(config.agent["team-lead"].permission.harbor_delegate, "allow");
  assert.equal(config.agent["team-lead"].permission.harbor_team_roster, "allow");
  assert.equal(config.agent["team-lead"].permission.read, "deny");
  assert.equal(config.agent["team-lead"].steps, 7);
  assert.equal(config.agent.crafter.steps, 4);
  assert.ok(config.agent["team-lead"].prompt.startsWith("Identity: team-lead\n"));
  assert.ok(config.agent["team-lead"].prompt.includes(rolePlayers.get("team-lead")!.prompt));
  assert.match(config.agent["team-lead"].prompt, /complete every required gate/);
  assert.match(config.agent["team-lead"].prompt, /harbor_delegate/);
  const scopedExternalDirectory = config.agent["team-lead"].permission.external_directory;
  assert.equal(scopedExternalDirectory["*"], "deny");
  assert.ok(Object.entries(scopedExternalDirectory).some(([pattern, action]) =>
    action === "allow" && pattern.toLowerCase().startsWith(resolve(initial).toLowerCase())));
  assert.equal(config.agent.crafter.tools.apply_patch, true);
  assert.equal(config.agent.crafter.permission.edit, "allow");
  assert.equal(config.agent.crafter.tools.agent_harbor_skills, true);
  assert.equal(config.agent.crafter.tools.skill, false);
  assert.equal(config.command.scout.agent, "talent-scout");
  assert.equal(config.agent["talent-scout"].tools.harbor_team_roster, true);
  assert.equal(config.agent["talent-scout"].tools.harbor_filter_skills, true);
  assert.equal(config.agent["talent-scout"].tools.harbor_join_player, true);
  assert.equal(config.agent["talent-scout"].tools.read, false);
  assert.equal(config.agent["talent-scout"].permission.task, "deny");
  assert.ok(plugin.tool?.harbor_team_roster);
  assert.ok(plugin.tool?.harbor_filter_skills);
  assert.ok(plugin.tool?.harbor_join_player);
  assert.equal(plugin.tool?.harbor, undefined,
    "OpenCode must not expose an ambient generic lifecycle tool; direct controls own deterministic commands");
  assert.equal(plugin.tool?.harbor_contract, undefined, "OpenCode must not expose an unauthenticated contract preflight tool");
  assert.ok(plugin.tool?.harbor_delegate);
  assert.ok(plugin.tool?.agent_harbor_skills);
  const directPreflight = plugin["command.execute.before"]!;
  await assert.rejects(() => directPreflight(
    { command: "team-lead", sessionID: "session", arguments: "   " }, { parts: [] },
  ), /non-empty/);
  await directPreflight({ command: "team-lead", sessionID: "session", arguments: "coordinate" }, { parts: [] });
  await assert.rejects(() => directPreflight(
    { command: "scout", sessionID: "session", arguments: "same native session" }, { parts: [] },
  ), /only one direct player claim per owning runtime session/u);
  await assert.rejects(() => directPreflight(
    { command: "scout", sessionID: "scout-session", arguments: "   " }, { parts: [] },
  ), /non-empty/);
  await directPreflight({ command: "scout", sessionID: "scout-session", arguments: "zx automation" }, { parts: [] });
  await directPreflight({ command: "bench", sessionID: "session", arguments: "list" }, { parts: [] });
  await mkdir(join(current, "skills", "native"), { recursive: true });
  await writeFile(join(current, "skills", "native", "SKILL.md"), [
    "---", "name: native-guidance", "description: Native guidance", "---", "", "NATIVE-ONLY-GUIDANCE",
  ].join("\n"), "utf8");
  const result = await runDeterministicCommand(
    "opencode",
    "join",
    JSON.stringify({
      name: "native", description: "Native", prompt: "Work", tools: ["read"],
      skills: [{ kind: "repo", name: "native-guidance", path: "skills/native/SKILL.md" }],
    }),
    current,
    new AbortController().signal,
  );
  assert.match(String(result), /joined native/);
  assert.match(String(result), /command: \/native <request>/);
  assert.match(String(result), new RegExp(current.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  const reloadedPlugin = await AgentHarborPlugin({ client: { session: {
    ...emptyOpenCodeActivitySession(),
    message: async ({ path }: any) => ({ data: {
      info: {
        id: path.messageID,
        role: "user",
        model: { providerID: "openai", modelID: "gpt-5.3-codex-spark" },
      },
      parts: [],
    } }),
  } }, directory: current } as any, {});
  const reloadedConfig: any = {};
  await reloadedPlugin.config?.(reloadedConfig);
  const activeTools = reloadedPlugin.tool!;
  assert.deepEqual(reloadedConfig.command.native, {
    description: "Run Agent Harbor player native in the current session",
    template: "$ARGUMENTS",
    agent: "native",
    subtask: false,
  });
  const guidance = await activeTools.agent_harbor_skills.execute(
    {},
    { directory: current, agent: "native", abort: new AbortController().signal } as any,
  );
  assert.match(String(guidance), /HARBOR-SKILL native-guidance/);
  assert.match(String(guidance), /NATIVE-ONLY-GUIDANCE/);
  await assert.rejects(() => activeTools.agent_harbor_skills.execute(
    {},
    { directory: current, agent: "team-lead", abort: new AbortController().signal } as any,
  ), /no configured skills/);
  const originalDescribe = GhResolver.prototype.describe;
  const originalListCatalog = GhResolver.prototype.listCatalog;
  const originalInspectCatalog = GhResolver.prototype.inspectCatalog;
  try {
    GhResolver.prototype.listCatalog = async (source) => [{
      repo: source.repo, path: "skills/zx-example-author/SKILL.md", name: "zx-example-author", track: source.track, commit: "f".repeat(40),
    }];
    GhResolver.prototype.inspectCatalog = async (entry) => ({ name: entry.name, description: "Author zx automation scripts." });
    const scoutExecution = (messageID: string, agent = "talent-scout") => ({
      directory: current,
      agent,
      sessionID: "scout-session",
      messageID,
      abort: new AbortController().signal,
    });
    await assert.rejects(() => activeTools.harbor_filter_skills.execute(
      { query: "zx scripts" }, { directory: current, agent: "team-lead", abort: new AbortController().signal } as any,
    ), /not available to this principal/);
    await assert.rejects(() => activeTools.harbor_team_roster.execute(
      { query: "native" }, { directory: current, agent: "crafter", abort: new AbortController().signal } as any,
    ), /not available to this principal/);

    let enterBlockedFilter!: () => void;
    let releaseBlockedFilter!: () => void;
    const blockedFilterEntered = new Promise<void>((resolve) => { enterBlockedFilter = resolve; });
    const blockedFilterRelease = new Promise<void>((resolve) => { releaseBlockedFilter = resolve; });
    let blockOneDescription = true;
    GhResolver.prototype.describe = async () => {
      if (blockOneDescription) {
        blockOneDescription = false;
        enterBlockedFilter();
        await blockedFilterRelease;
      }
      return { commit: "e".repeat(40), description: "Author zx automation scripts." };
    };
    await activeTools.harbor_team_roster.execute(
      { query: "" }, scoutExecution("scout-concurrent") as any,
    );
    const blockedFilter = activeTools.harbor_filter_skills.execute(
      { query: "zx scripts" }, scoutExecution("scout-concurrent") as any,
    );
    await blockedFilterEntered;
    await assert.rejects(() => activeTools.harbor_filter_skills.execute(
      { query: "automation" }, scoutExecution("scout-concurrent") as any,
    ), /must run sequentially/);
    releaseBlockedFilter();
    await blockedFilter;

    GhResolver.prototype.describe = async () => ({ commit: "e".repeat(40), description: "Author zx automation scripts." });
    await assert.rejects(() => activeTools.harbor_join_player.execute(
      { definition: JSON.stringify({ name: "out-of-order", description: "Out of order", prompt: "Work.", tools: ["read"] }) },
      scoutExecution("scout-order") as any,
    ), /requires one successful complete harbor_team_roster snapshot first/);
    await activeTools.harbor_team_roster.execute({ query: "" }, scoutExecution("scout-order") as any);
    await assert.rejects(() => activeTools.harbor_join_player.execute(
      { definition: JSON.stringify({ name: "still-out-of-order", description: "Out of order", prompt: "Work.", tools: ["read"] }) },
      scoutExecution("scout-order") as any,
    ), /requires a successful harbor_filter_skills call first/);

    await activeTools.harbor_team_roster.execute({ query: "" }, scoutExecution("scout-filter-limit") as any);
    for (let index = 0; index < 3; index += 1) {
      await activeTools.harbor_filter_skills.execute(
        { query: `zx scripts ${index}` }, scoutExecution("scout-filter-limit") as any,
      );
    }
    await assert.rejects(() => activeTools.harbor_filter_skills.execute(
      { query: "fourth filter" }, scoutExecution("scout-filter-limit") as any,
    ), /per-run limit \(3\)/);

    const roster = await activeTools.harbor_team_roster.execute(
      { query: "native" }, scoutExecution("scout-main") as any,
    );
    assert.match(String(roster), /"id":"native".*"availability":"ready"/u);
    assert.doesNotMatch(String(roster), /\.opencode|agent-harbor\/bench/iu);
    await assert.rejects(() => activeTools.harbor_team_roster.execute(
      { query: "again" }, scoutExecution("scout-main") as any,
    ), /exactly once/u);
    const matches = await activeTools.harbor_filter_skills.execute(
      { query: "zx scripts" }, scoutExecution("scout-main") as any,
    );
    assert.match(String(matches), /zx-example-author/);
    await assert.rejects(() => activeTools.harbor_join_player.execute(
      { definition: "{}" }, { directory: current, agent: "crafter", abort: new AbortController().signal } as any,
    ), /not available to this principal/);
    const scouted = await activeTools.harbor_join_player.execute(
      { definition: JSON.stringify({ name: "open-scouted", description: "Scouted", prompt: "Work narrowly.", tools: ["read"] }) },
      scoutExecution("scout-main") as any,
    );
    assert.match(String(scouted), /open-scouted joined/);
    assert.match(String(scouted), /Role: Scouted/u);
    assert.match(String(scouted), /Capacity: read/u);
    assert.match(String(scouted), /Model: inherits the OpenCode host/u);
    assert.match(String(scouted), /Reload OpenCode before native selection/u);
    assert.doesNotMatch(String(scouted), /registration:|active:|\\home\\|\/home\//u);
    await assert.rejects(() => activeTools.harbor_join_player.execute(
      { definition: JSON.stringify({ name: "open-scouted-again", description: "Scouted again", prompt: "Work narrowly.", tools: ["read"] }) },
      scoutExecution("scout-main") as any,
    ), /talent-scout turn is terminal: join completed/);
    await assert.rejects(() => activeTools.harbor_filter_skills.execute(
      { query: "after join" }, scoutExecution("scout-main") as any,
    ), /talent-scout turn is terminal: join completed/);
  } finally {
    GhResolver.prototype.describe = originalDescribe;
    GhResolver.prototype.listCatalog = originalListCatalog;
    GhResolver.prototype.inspectCatalog = originalInspectCatalog;
  }
  if (previous === undefined) delete process.env.OPENCODE_CONFIG_DIR; else process.env.OPENCODE_CONFIG_DIR = previous;
});

test("OpenCode removes an owned stale profile from host discovery instead of inheriting expanded tools", async () => {
  const root = await mkdtemp(join(tmpdir(), "harbor-opencode-stale-profile-"));
  const project = join(root, "project"); const home = join(root, "home");
  const previous = process.env.OPENCODE_CONFIG_DIR;
  process.env.OPENCODE_CONFIG_DIR = home;
  try {
    const spec = harnessSpec("opencode", home, project);
    await new Roster(spec).join({ name: "worker", description: "Worker", prompt: "Work", tools: ["read"] });
    const active = join(project, spec.activeDir, `worker${spec.extension}`);
    await writeFile(active, (await readFile(active, "utf8")).replace("  skill: false", "  skill: true"), "utf8");
    const plugin = await AgentHarborPlugin({ client: { session: {} }, directory: project } as any, {});
    const config: any = { agent: { worker: { tools: { skill: true } } } };
    await plugin.config?.(config);
    assert.equal(Object.hasOwn(config.agent, "worker"), false);
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_CONFIG_DIR; else process.env.OPENCODE_CONFIG_DIR = previous;
  }
});

test("OpenCode incomplete startup drops owned host residue, preserves foreign commands, and emits a path-free repair warning", async () => {
  const root = await mkdtemp(join(tmpdir(), "harbor-opencode-incomplete-startup-"));
  const project = join(root, "project"); const home = join(root, "home");
  const previous = process.env.OPENCODE_CONFIG_DIR;
  process.env.OPENCODE_CONFIG_DIR = home;
  try {
    const spec = harnessSpec("opencode", home, project);
    const active = join(project, spec.activeDir);
    await new Roster(spec).join({
      name: "reload-worker", description: "Reload worker", prompt: "Work narrowly.", tools: ["read"],
    });
    const logs: any[] = [];
    const plugin = await AgentHarborPlugin({
      client: {
        session: {},
        app: { log: async (entry: any) => { logs.push(entry); return { data: true }; } },
      },
      directory: project,
    } as any, {});
    const foreignBuild = { description: "User-owned build command", template: "keep $ARGUMENTS" };
    const foreignAgent = { description: "Unrelated host agent", tools: { bash: true } };
    const config: any = {
      command: { build: foreignBuild },
      agent: { "foreign-worker": foreignAgent },
    };
    await plugin.config?.(config);
    assert.equal(config.agent["reload-worker"].metadata.owner, "agent-foundry");
    assert.equal(config.command["reload-worker"].agent, "reload-worker");
    const reloadProfile = join(active, `reload-worker${spec.extension}`);
    await writeFile(reloadProfile,
      (await readFile(reloadProfile, "utf8")).replace("  skill: false", "  skill: true"), "utf8");
    config.agent["stale-worker"] = {
      metadata: { owner: "agent-foundry", roster: "personal", player: "stale-worker", revision: "5" },
      tools: { bash: true, edit: true },
    };
    await Promise.all(Array.from({ length: 513 }, (_, index) =>
      writeFile(join(active, `noise-${index.toString().padStart(3, "0")}.txt`), "foreign", "utf8")));
    await plugin.config?.(config);
    assert.equal(Object.hasOwn(config.agent, "reload-worker"), false,
      "partial reload retained the plugin's prior owned agent configuration");
    assert.equal(Object.hasOwn(config.command, "reload-worker"), false,
      "partial reload retained the plugin's prior direct alias");
    assert.equal(Object.hasOwn(config.agent, "stale-worker"), false,
      "partial startup retained a preloaded owned agent with expanded tools");
    assert.equal(config.agent["foreign-worker"], foreignAgent, "partial cleanup removed a foreign host agent");
    assert.equal(config.command.build, foreignBuild, "inactive Agent Harbor alias replaced a foreign /build command");
    await plugin["command.execute.before"]?.(
      { command: "build", sessionID: "foreign-build", arguments: "" }, { parts: [] },
    );
    assert.equal(logs.length, 1);
    assert.equal(logs[0].body.level, "warn");
    assert.match(logs[0].body.message, /directory-entry-limit/u);
    assert.match(logs[0].body.message, /Repair:/u);
    assert.equal(logs[0].body.message.includes(project), false, "startup warning exposed an absolute project path");
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_CONFIG_DIR; else process.env.OPENCODE_CONFIG_DIR = previous;
  }
});

test("OpenCode direct aliases reject a replaced definition until host discovery reloads", async () => {
  const root = await mkdtemp(join(tmpdir(), "harbor-opencode-direct-reload-"));
  const project = join(root, "project");
  const roster = new Roster(harnessSpec("opencode", join(root, "home"), project));
  await roster.join({ name: "reviewer", description: "Original", prompt: "Use original policy.", tools: ["read"] });
  const first = await AgentHarborPlugin({
    client: { session: emptyOpenCodeActivitySession() },
    directory: project,
  } as any, {});
  const firstConfig: any = {};
  await first.config?.(firstConfig);
  assert.equal(typeof firstConfig.agent.reviewer.metadata.definitionDigest, "string");
  await first["command.execute.before"]?.(
    { command: "reviewer", sessionID: "before-replace", arguments: "review" }, { parts: [] },
  );
  await first.event?.({ event: { type: "session.idle", properties: { sessionID: "before-replace" } } } as any);

  await roster.join({
    name: "reviewer", description: "Replacement", prompt: "Use replacement policy.",
    tools: ["read", "search"], replace: true,
  });
  await assert.rejects(() => first["command.execute.before"]?.(
    { command: "reviewer", sessionID: "stale-loaded-definition", arguments: "review" }, { parts: [] },
  ), /requires an OpenCode reload because its loaded Agent Harbor definition changed/u);

  const reloaded = await AgentHarborPlugin({
    client: { session: emptyOpenCodeActivitySession() },
    directory: project,
  } as any, {});
  const reloadedConfig: any = {};
  await reloaded.config?.(reloadedConfig);
  assert.notEqual(reloadedConfig.agent.reviewer.metadata.definitionDigest,
    firstConfig.agent.reviewer.metadata.definitionDigest);
  await reloaded["command.execute.before"]?.(
    { command: "reviewer", sessionID: "after-reload", arguments: "review" }, { parts: [] },
  );
});

test("OpenCode team lead dispatches exact active agents sequentially without a router", async () => {
  const root = await mkdtemp(join(tmpdir(), "harbor-opencode-delegate-"));
  const project = join(root, "project");
  const roster = new Roster(harnessSpec("opencode", join(root, "home"), project));
  await roster.bench("on all", bundledPlayers);
  const creates: any[] = []; const prompts: any[] = []; const deletes: string[] = [];
  const defaultModel = { providerID: "openai", modelID: "gpt-5.3-codex-spark", variant: "low" };
  const sdlcModel = { providerID: "openai", modelID: "gpt-5.6-luna", variant: "high" };
  let blockPortfolioManagement = false; let enterPortfolioManagement!: () => void; let releasePortfolioManagement!: () => void;
  const portfolioManagementEntered = new Promise<void>((resolve) => { enterPortfolioManagement = resolve; });
  const portfolioManagementReleased = new Promise<void>((resolve) => { releasePortfolioManagement = resolve; });
  const client = { session: {
    ...emptyOpenCodeActivitySession(),
    update: confirmOpenCodeSessionTitle,
    create: async ({ body }: any) => {
      const id = `child-${creates.length + 1}`;
      creates.push({ id, body });
      return { data: { id } };
    },
    prompt: async ({ path, body }: any) => {
      prompts.push({ id: path.id, body });
      if (blockPortfolioManagement && body.agent === "portfolio-management") {
        enterPortfolioManagement(); await portfolioManagementReleased; blockPortfolioManagement = false;
      }
      return { data: { parts: [{ type: "text", text: `evidence:${body.agent}` }] } };
    },
    message: async ({ path }: any) => {
      if (path.messageID.startsWith("user-")) return { data: {
        info: {
          id: path.messageID,
          role: "user",
          model: path.messageID === "user-default" ? defaultModel : sdlcModel,
        },
        parts: [],
      } };
      return { data: {
        info: {
          id: path.messageID,
          role: "assistant",
          parentID: path.messageID.startsWith("default-") ? "user-default" : "user-sdlc",
          providerID: "must-not-propagate",
          modelID: "must-not-propagate",
        },
        parts: [],
      } };
    },
    delete: async ({ path }: any) => { deletes.push(path.id); return { data: true }; },
  } };
  const plugin = await AgentHarborPlugin({ client, directory: project } as any, {});
  const config: any = {};
  await plugin.config?.(config);
  for (const id of [...rolePlayers.keys(), ...bundledPlayers.keys()]) {
    assert.equal(config.command[id].agent, id);
    assert.equal(config.command[id].subtask, false);
    assert.equal(config.command[id].template, "$ARGUMENTS");
  }
  const directPreflight = plugin["command.execute.before"]!;
  await directPreflight({ command: "portfolio-management", sessionID: "direct-preflight", arguments: "prioritize" }, { parts: [] });
  await plugin.event?.({ event: { type: "session.idle", properties: { sessionID: "direct-preflight" } } } as any);
  await assert.rejects(() => directPreflight(
    { command: "portfolio-management", sessionID: "parent", arguments: "   " }, { parts: [] },
  ), /non-empty/);

  const execution: any = {
    agent: "team-lead", directory: project, worktree: project,
    sessionID: "parent", messageID: "default-1", abort: new AbortController().signal,
    metadata: () => {}, ask: async () => {},
  };
  const delegate = plugin.tool!.harbor_delegate;
  assert.equal((delegate.args.agent as any).options, undefined);
  assert.match(delegate.description, /ownership-validated and loaded by the current OpenCode configuration/);
  let evidence: string | undefined;
  for (const [index, step] of defaultCycle.steps.entries()) {
    evidence = String(await delegate.execute(
      { agent: step.agent, task: datasetTask(defaultCycle, index, evidence) },
      { ...execution, messageID: `default-${index + 1}` },
    ));
    assert.equal(evidence, `evidence:${step.agent}`);
  }
  assert.deepEqual(prompts.map((entry) => entry.body.agent), defaultCycle.steps.map((step) => step.agent));
  assert.deepEqual(prompts.map((entry) => entry.body.model), defaultCycle.steps.map(() => ({ providerID: defaultModel.providerID, modelID: defaultModel.modelID })));
  assert.deepEqual(prompts.map((entry) => entry.body.variant), defaultCycle.steps.map(() => defaultModel.variant));

  await roster.join({ name: "new-player", description: "New player", prompt: "Handle newly assigned work.", tools: ["read"] });
  const beforePendingReload = creates.length;
  await assert.rejects(() => delegate.execute(
    { agent: "new-player", task: "handle work joined during this session" },
    { ...execution, messageID: "default-new-player" },
  ), /enabled but not loaded.*reload OpenCode/u);
  assert.equal(creates.length, beforePendingReload, "pending-reload members must create zero children");

  const beforeInvalid = creates.length;
  const sdlcExecution = { ...execution, messageID: "sdlc-invalid" };
  await assert.rejects(() => delegate.execute({ agent: "portfolio-management", task: "work" }, { ...sdlcExecution, agent: "crafter" }), /not available to this principal/);
  await assert.rejects(() => delegate.execute({ agent: "team-lead", task: "recurse" }, sdlcExecution), /recursive/);
  await assert.rejects(() => delegate.execute({ agent: "unknown", task: "work" }, sdlcExecution), /not found/);
  await assert.rejects(() => delegate.execute({ agent: "manage", task: "   " }, sdlcExecution), /non-empty/);
  await roster.bench("off dispose", bundledPlayers);
  await assert.rejects(() => delegate.execute({ agent: "dispose", task: "retire safely" }, sdlcExecution), /not found/);
  await assert.rejects(() => directPreflight(
    { command: "dispose", sessionID: "parent", arguments: "retire safely" }, { parts: [] },
  ), /\/dispose is no longer active in Agent Harbor; reload OpenCode to remove this stale alias/u);
  assert.equal(creates.length, beforeInvalid, "invalid or inactive targets must create zero children");
  await roster.bench("on dispose", bundledPlayers);

  blockPortfolioManagement = true;
  const firstStage = delegate.execute(
    { agent: fullCycle.steps[0].agent, task: datasetTask(fullCycle, 0) }, { ...sdlcExecution, messageID: "sdlc-1" },
  );
  await portfolioManagementEntered;
  await assert.rejects(() => delegate.execute(
    { agent: fullCycle.steps[1].agent, task: "parallel stage" }, { ...sdlcExecution, messageID: "sdlc-parallel" },
  ), /sequentially/);
  releasePortfolioManagement();
  evidence = String(await firstStage);
  await assert.rejects(() => delegate.execute(
    { agent: fullCycle.steps[0].agent, task: "duplicate stage" }, { ...sdlcExecution, messageID: "sdlc-duplicate" },
  ), /already delegated/);
  for (const [index, step] of fullCycle.steps.slice(1).entries()) {
    evidence = String(await delegate.execute(
      { agent: step.agent, task: datasetTask(fullCycle, index + 1, evidence) },
      { ...sdlcExecution, messageID: `sdlc-${index + 2}` },
    ));
  }
  await assert.rejects(() => delegate.execute(
    { agent: fullCycle.steps[0].agent, task: "seventh stage" }, { ...sdlcExecution, messageID: "sdlc-7" },
  ), /at most six/);
  assert.equal(creates.length, defaultCycle.steps.length + fullCycle.steps.length);
  assert.deepEqual(prompts.map((entry) => entry.body.agent), [
    ...defaultCycle.steps.map((step) => step.agent), ...fullCycle.steps.map((step) => step.agent),
  ]);
  assert.deepEqual(
    prompts.map((entry) => entry.body.model),
    [...defaultCycle.steps.map(() => ({ providerID: defaultModel.providerID, modelID: defaultModel.modelID })),
      ...fullCycle.steps.map(() => ({ providerID: sdlcModel.providerID, modelID: sdlcModel.modelID }))],
  );
  assert.deepEqual(
    prompts.map((entry) => entry.body.variant),
    [...defaultCycle.steps.map(() => defaultModel.variant), ...fullCycle.steps.map(() => sdlcModel.variant)],
  );
  assert.match(prompts.at(-1).body.parts[0].text, new RegExp(`evidence:${fullCycle.steps.at(-2)!.agent}`));
  assert.ok(creates.every((entry) => entry.body.parentID === undefined));
  assert.deepEqual(deletes, creates.map((entry) => entry.id));
});

test("OpenCode shares truthful reservations across direct aliases and team-lead delegation", async () => {
  const root = await mkdtemp(join(tmpdir(), "harbor-opencode-shared-reservation-"));
  const project = join(root, "project");
  let enterPrompt!: () => void; let releasePrompt!: () => void;
  const promptEntered = new Promise<void>((resolve) => { enterPrompt = resolve; });
  const promptReleased = new Promise<void>((resolve) => { releasePrompt = resolve; });
  const client = { session: {
    ...emptyOpenCodeActivitySession(),
    update: confirmOpenCodeSessionTitle,
    message: async ({ path }: any) => path.messageID.startsWith("user-")
      ? { data: { info: {
        id: path.messageID, role: "user",
        model: { providerID: "openai", modelID: "gpt-5.3-codex-spark" },
      }, parts: [] } }
      : { data: { info: {
        id: path.messageID, role: "assistant",
        parentID: path.messageID.includes("-2") ? "user-2" : "user-1",
      }, parts: [] } },
    create: async () => ({ data: { id: "reserved-child" } }),
    prompt: async () => { enterPrompt(); await promptReleased; return { data: { parts: [{ type: "text", text: "done" }] } }; },
    delete: async () => ({ data: true }),
  } };
  const plugin = await AgentHarborPlugin({ client, directory: project } as any, {});
  await plugin.config?.({} as any);
  const direct = plugin["command.execute.before"]!;
  const delegate = plugin.tool!.harbor_delegate;
  const roster = plugin.tool!.harbor_team_roster;
  const execution = (messageID: string) => ({
    agent: "team-lead", directory: project, worktree: project,
    sessionID: "lead-session", messageID, abort: new AbortController().signal,
    metadata: () => {}, ask: async () => {},
  });

  await direct({ command: "crafter", sessionID: "direct-a", arguments: "implement" }, { parts: [] });
  assert.match(String(await roster.execute({ query: "crafter" }, execution("lead-roster-1") as any)),
    /"id":"crafter","availability":"busy"/u);
  await assert.rejects(() => delegate.execute(
    { agent: "crafter", task: "must not overlap" }, execution("lead-delegate-1") as any,
  ), /busy in another direct or delegated/u);
  await assert.rejects(() => direct(
    { command: "crafter", sessionID: "direct-b", arguments: "also overlap" }, { parts: [] },
  ), /busy in another direct or delegated run/u);

  await plugin.event?.({ event: { type: "session.idle", properties: { sessionID: "direct-a" } } } as any);
  await direct({ command: "crafter", sessionID: "direct-b", arguments: "released" }, { parts: [] });
  await plugin.event?.({ event: { type: "session.error", properties: { sessionID: "direct-b" } } } as any);

  const delegated = delegate.execute(
    { agent: "crafter", task: "hold the shared reservation" }, execution("lead-delegate-1") as any,
  );
  await promptEntered;
  await assert.rejects(() => direct(
    { command: "crafter", sessionID: "direct-c", arguments: "blocked by delegate" }, { parts: [] },
  ), /busy in another direct or delegated run/u);
  assert.match(String(await roster.execute({ query: "crafter" }, execution("lead-roster-2") as any)),
    /"id":"crafter","availability":"busy"/u);
  releasePrompt();
  assert.equal(await delegated, "done");

  await direct({ command: "crafter", sessionID: "direct-c", arguments: "after delegate" }, { parts: [] });
  await plugin.event?.({ event: { type: "session.status", properties: { sessionID: "direct-c", status: { type: "idle" } } } } as any);
  await direct({ command: "crafter", sessionID: "direct-d", arguments: "after terminal release" }, { parts: [] });
});

test("OpenCode TUI exposes direct controls that bypass sessions and models", async () => {
  const root = await mkdtemp(join(tmpdir(), "harbor-opencode-tui-"));
  const previous = process.env.OPENCODE_CONFIG_DIR;
  process.env.OPENCODE_CONFIG_DIR = join(root, "home");
  const project = join(root, "project");
  const toasts: any[] = []; const layers: any[] = []; const prompts: any[] = [];
  const originalListCatalog = GhResolver.prototype.listCatalog;
  const dialog = {
    replace: (render: () => unknown) => { prompts.push(render()); },
    clear: () => {}, setSize: () => {}, size: "medium", depth: 0, open: false,
  };
  const api: any = {
    route: { current: { name: "home" } },
    state: {
      path: { directory: project }, config: { agent: {} }, provider: [],
      session: { get: () => undefined, messages: () => [], status: () => undefined },
      part: () => [],
    },
    client: {
      session: { status: async () => ({ data: {} }) },
      v2: { session: {
        list: async () => ({ data: { data: [], cursor: {} } }),
        active: async () => ({ data: { data: {} } }),
      } },
    },
    ui: {
      toast: (value: unknown) => toasts.push(value), dialog,
      DialogPrompt: (props: unknown) => props,
      DialogAlert: (props: unknown) => props,
    },
    lifecycle: { signal: new AbortController().signal, onDispose: () => () => {} },
    keymap: { registerLayer: (layer: unknown) => { layers.push(layer); return () => {}; } },
  };
  try {
    GhResolver.prototype.listCatalog = async (source) => [{ repo: source.repo, path: source.path ?? "skills/zx-example-author/SKILL.md", name: source.name ?? "zx-example-author" }];
    const commands = openCodeDirectCommands(api);
    assert.deepEqual(commands.map((command) => command.slashName), [
      "team", "bench-list", "bench-on", "bench-off", "harbor-join", "harbor-retire", "contract", "harbor-list-skills", "harbor-filter-skills",
    ]);
    assert.ok(commands.every((command) => command.namespace === "palette"));
    await commands.find((command) => command.name.endsWith("bench-list"))!.run();
    assert.match(prompts.at(-1).title, /0 model tokens/);
    assert.match(prompts.at(-1).message, /portfolio-management · bundled · bench/);

    commands.find((command) => command.name.endsWith("bench-on"))!.run();
    await prompts.at(-1).onConfirm("portfolio-management");
    assert.match(prompts.at(-1).message, /portfolio-management enabled · reload required/u);
    const portfolioManagement = bundledPlayers.get("portfolio-management")!;
    api.state.config.agent["portfolio-management"] = {
      metadata: {
        owner: "agent-foundry",
        roster: "sdlc",
        player: "portfolio-management",
        revision: "5",
        definitionDigest: playerDefinitionDigest(portfolioManagement),
      },
    };
    commands.find((command) => command.name.endsWith("bench-off"))!.run();
    await prompts.at(-1).onConfirm("portfolio-management");
    assert.match(prompts.at(-1).message, /portfolio-management benched · reload required to remove stale discovery/u);
    assert.match(prompts.at(-1).message, /Invocation is blocked now/u);
    commands.find((command) => command.name.endsWith("bench-on"))!.run();
    await prompts.at(-1).onConfirm("portfolio-management");
    assert.match(prompts.at(-1).message, /portfolio-management enabled · ready · invocable/u);
    commands.find((command) => command.name.endsWith("bench-off"))!.run();
    await prompts.at(-1).onConfirm("portfolio-management");

    const nativeDefinition = { name: "native", description: "Native", prompt: "Work", tools: ["read"] };
    commands.find((command) => command.name.endsWith("join"))!.run();
    await prompts.at(-1).onConfirm(JSON.stringify(nativeDefinition));
    assert.match(prompts.at(-1).message, /native joined · personal · enabled · reload required/u);
    api.state.config.agent.native = {
      metadata: {
        owner: "agent-foundry",
        roster: "personal",
        player: "native",
        revision: "5",
        definitionDigest: playerDefinitionDigest(nativeDefinition),
      },
    };
    commands.find((command) => command.name.endsWith("join"))!.run();
    await prompts.at(-1).onConfirm(JSON.stringify(nativeDefinition));
    assert.match(prompts.at(-1).message, /○ native is already joined and current · no roster files changed\./u);
    assert.match(prompts.at(-1).message, /Run now: \/native <task>/u);
    commands.find((command) => command.name.endsWith("retire"))!.run();
    await prompts.at(-1).onConfirm("native");
    assert.match(prompts.at(-1).message, /native retired here · other projects intentionally untouched/u);
    assert.match(prompts.at(-1).message, /reload required to remove its stale native agent and \/native alias/u);

    await commands.find((command) => command.name.endsWith("skills-list"))!.run();
    assert.match(prompts.at(-1).message, /REPOSITORY.*PATH.*SKILL/su);
    assert.match(prompts.at(-1).message, /skills\/zx-example-author\/SKILL\.md/u);
    assert.doesNotMatch(prompts.at(-1).message, /\[path\]/u);
    assert.doesNotMatch(prompts.at(-1).message, /\x1b\[/u);
    commands.find((command) => command.name.endsWith("skills-filter"))!.run();
    await prompts.at(-1).onConfirm("zx");
    assert.match(prompts.at(-1).message, /zx-example-author/);
    assert.equal(toasts.length, 1);
    assert.match(toasts[0].title, /0 model tokens/u);
    assert.match(toasts[0].message, /Reading a bounded OpenCode team snapshot/u);
    assert.ok(prompts.filter((entry) => entry?.message).every((entry) => /0 model tokens/.test(entry.title)));
    assert.ok(prompts.flatMap((entry) => typeof entry?.message === "string" ? entry.message.split("\n") : [])
      .every((line) => visibleTextWidth(line) <= 96), "an OpenCode direct-control result exceeded 96 cells");

    await openCodeTui.tui(api, undefined, {} as any);
    assert.equal(layers.length, 1);
    assert.equal(layers[0].commands.length, 9);
    assert.ok(!("server" in openCodeTui));
  } finally {
    GhResolver.prototype.listCatalog = originalListCatalog;
    if (previous === undefined) delete process.env.OPENCODE_CONFIG_DIR; else process.env.OPENCODE_CONFIG_DIR = previous;
  }
});

test("Pi extension registers lifecycle and fixed roles through ExtensionAPI", () => {
  const names: string[] = [];
  const tools: any[] = [];
  piExtension({
    registerCommand: (name: string) => names.push(name),
    registerTool: (tool: any) => tools.push(tool),
    getThinkingLevel: () => "minimal",
  } as any);
  const baseline = ["team", ...commandNames, ...rolePlayers.keys(), "scout"];
  assert.deepEqual(names.slice(0, baseline.length), baseline);
  assert.equal(new Set(names).size, names.length,
    "startup discovery registered a command identity more than once");
  assert.deepEqual(tools, [], "Pi must not expose a model-callable global contract tool");
});

test("Pi /scout inspects one roster snapshot before filtering and one deterministic join", async () => {
  const root = await mkdtemp(join(tmpdir(), "harbor-pi-scout-"));
  const previousHome = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "home");
  const project = join(root, "project");
  const commands = new Map<string, any>(); const notices: string[] = [];
  piExtension({
    registerCommand: (name: string, options: any) => commands.set(name, options),
    registerTool: () => {},
    getThinkingLevel: () => "minimal",
  } as any);
  const originalRun = PiOrchestrator.prototype.run;
  const originalDescribe = GhResolver.prototype.describe;
  const originalListCatalog = GhResolver.prototype.listCatalog;
  const originalInspectCatalog = GhResolver.prototype.inspectCatalog;
  let captured: any;
  let exercisedWhileRootWasLive = false;
  try {
    PiOrchestrator.prototype.run = async function (definition: any) {
      captured = { definition, customTools: [...(this as any).customTools], additionalTools: [...(this as any).additionalTools] };
      await assert.rejects(() => captured.customTools[1].execute(
        "filter-before-roster", { query: "zx scripts" }, new AbortController().signal, undefined, { cwd: project },
      ), /requires one successful complete harbor_team_roster/u);
      const roster = await captured.customTools[0].execute(
        "roster", { query: "" }, new AbortController().signal, undefined, { cwd: project },
      );
      assert.match(roster.content[0].text, /"id":"crafter".*"availability":"ready"/u);
      assert.doesNotMatch(roster.content[0].text, /"id":"team-lead"/u,
        "the scout roster must count only reusable/recruitable capacity, not its manager");
      await assert.rejects(() => captured.customTools[0].execute(
        "roster-again", { query: "" }, new AbortController().signal, undefined, { cwd: project },
      ), /exactly once/u);
      await assert.rejects(() => captured.customTools[2].execute(
        "join-before-filter", { definition: JSON.stringify({ name: "early", description: "Early", prompt: "Work", tools: ["read"] }) },
        new AbortController().signal, undefined, { cwd: project },
      ), /requires a successful harbor_filter_skills/u);
      const filtered = await captured.customTools[1].execute(
        "filter", { query: "zx scripts" }, new AbortController().signal, undefined, { cwd: project },
      );
      assert.match(filtered.content[0].text, /zx-example-author/);
      await captured.customTools[1].execute("filter-2", { query: "zx" }, new AbortController().signal, undefined, { cwd: project });
      await captured.customTools[1].execute("filter-3", { query: "automation" }, new AbortController().signal, undefined, { cwd: project });
      await assert.rejects(() => captured.customTools[1].execute(
        "filter-4", { query: "more" }, new AbortController().signal, undefined, { cwd: project },
      ), /harbor_filter_skills reached its per-run limit \(3\)/u);
      const joined = await captured.customTools[2].execute(
        "join", { definition: JSON.stringify({
          name: "zx-automator", description: "Writes zx automation", prompt: "Write bounded zx automation scripts.",
          tools: ["read", "edit", "execute"], skills: [trustedSkills[0]],
        }) }, new AbortController().signal, undefined, { cwd: project },
      );
      assert.match(joined.content[0].text, /zx-automator joined/u);
      assert.doesNotMatch(joined.content[0].text, /registration:|active:|\\home\\|\/home\//u);
      await assert.rejects(() => captured.customTools[2].execute(
        "join-again", { definition: JSON.stringify({ name: "second", description: "Second", prompt: "Work", tools: ["read"] }) },
        new AbortController().signal, undefined, { cwd: project },
      ), /talent-scout turn is terminal: join completed/u);
      exercisedWhileRootWasLive = true;
      return "scout-complete";
    };
    GhResolver.prototype.describe = async () => ({
      commit: "d".repeat(40), description: "Author zx automation scripts.",
    });
    GhResolver.prototype.listCatalog = async (source) => [{
      repo: source.repo, path: "skills/zx-example-author/SKILL.md", name: "zx-example-author", track: source.track, commit: "e".repeat(40),
    }];
    GhResolver.prototype.inspectCatalog = async (entry) => ({ name: entry.name, description: "Author zx automation scripts." });
    await commands.get("scout").handler("alguien que escriba scripts en zx", {
      cwd: project, ...authenticatedPiHostState(), ui: { notify: (message: string) => notices.push(message) },
    });
    assert.equal(captured.definition.name, scoutPlayer.name);
    assert.deepEqual(captured.additionalTools, ["harbor_team_roster", "harbor_filter_skills", "harbor_join_player"]);
    assert.deepEqual(captured.customTools.map((entry: any) => entry.name), captured.additionalTools);
    assert.equal(exercisedWhileRootWasLive, true);
    await assert.rejects(() => captured.customTools[0].execute(
      "late-roster", { query: "" }, new AbortController().signal, undefined, { cwd: project },
    ), /root is terminal or cleaning; late custom-tool calls are blocked/u);
    assert.match(await readFile(join(project, ".pi", "agents", "zx-automator.md"), "utf8"), /zx-example-author/);
    assert.match(notices.at(-1)!, /^scout-complete\nRoster commit preserved: zx-automator is joined and active in this project\.\nTEAM RUN · native Pi telemetry · bounded summary/u);
  } finally {
    PiOrchestrator.prototype.run = originalRun;
    GhResolver.prototype.describe = originalDescribe;
    GhResolver.prototype.listCatalog = originalListCatalog;
    GhResolver.prototype.inspectCatalog = originalInspectCatalog;
    if (previousHome === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousHome;
  }
});

test("Pi scout and delegate tool failures expose only bounded public errors", async () => {
  const root = await mkdtemp(join(tmpdir(), "harbor-pi-public-tool-error-"));
  const project = join(root, "project");
  const commands = new Map<string, any>();
  const notices: string[] = [];
  let observedToolError: any;
  piExtension({
    registerCommand: (name: string, options: any) => commands.set(name, options),
    registerTool: () => {},
    getThinkingLevel: () => "minimal",
  } as any);
  const originalRun = PiOrchestrator.prototype.run;
  const originalListCatalog = GhResolver.prototype.listCatalog;
  try {
    GhResolver.prototype.listCatalog = async () => {
      throw new Error("GitHub failed at C:/Users/alice/private.txt with Bearer abcdefghijklmnop");
    };
    PiOrchestrator.prototype.run = async function () {
      const roster = (this as any).customTools.find((tool: any) => tool.name === "harbor_team_roster");
      const filter = (this as any).customTools.find((tool: any) => tool.name === "harbor_filter_skills");
      await roster.execute("private-roster", { query: "" }, undefined, undefined, { cwd: project });
      try {
        await filter.execute("private-filter", { query: "security" }, undefined, undefined, { cwd: project });
      } catch (error) {
        observedToolError = error;
        throw error;
      }
      return "unexpected";
    };
    await commands.get("scout").handler("find security capacity", {
      cwd: project,
      ...authenticatedPiHostState(),
      ui: { notify: (message: string) => notices.push(message) },
    });

    assert.match(observedToolError?.message ?? "", /GitHub failed at \[path\] with \[redacted\]/u);
    assert.equal(observedToolError?.cause, undefined);
    assert.doesNotMatch(JSON.stringify({
      name: observedToolError?.name,
      message: observedToolError?.message,
      cause: observedToolError?.cause,
    }), /alice|private\.txt|abcdefghijklmnop/u);
    assert.doesNotMatch(notices.join("\n"), /alice|private\.txt|abcdefghijklmnop/u);
  } finally {
    PiOrchestrator.prototype.run = originalRun;
    GhResolver.prototype.listCatalog = originalListCatalog;
  }
});

test("Pi /scout preserves and reconciles a committed join after failure or cancellation", async () => {
  const root = await mkdtemp(join(tmpdir(), "harbor-pi-scout-post-commit-"));
  const previousHome = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "home");
  const project = join(root, "project");
  const commands = new Map<string, any>();
  const notices: Array<{ message: string; level?: string }> = [];
  piExtension({
    registerCommand: (name: string, options: any) => commands.set(name, options),
    registerTool: () => {},
    getThinkingLevel: () => "minimal",
  } as any);
  const originalRun = PiOrchestrator.prototype.run;
  const originalDescribe = GhResolver.prototype.describe;
  const originalListCatalog = GhResolver.prototype.listCatalog;
  const originalInspectCatalog = GhResolver.prototype.inspectCatalog;
  let attempt = 0;
  try {
    GhResolver.prototype.describe = async () => ({
      commit: "d".repeat(40), description: "Author bounded failure-handling skills.",
    });
    GhResolver.prototype.listCatalog = async (source) => [{
      repo: source.repo,
      path: "skills/zx-example-author/SKILL.md",
      name: "zx-example-author",
      track: source.track,
      commit: "e".repeat(40),
    }];
    GhResolver.prototype.inspectCatalog = async (entry) => ({
      name: entry.name, description: "Author bounded failure-handling skills.",
    });
    PiOrchestrator.prototype.run = async function () {
      const id = attempt++ === 0 ? "joined-before-failure" : "joined-before-cancel";
      const rosterTool = (this as any).customTools.find((tool: any) => tool.name === "harbor_team_roster");
      const filterTool = (this as any).customTools.find((tool: any) => tool.name === "harbor_filter_skills");
      const joinTool = (this as any).customTools.find((tool: any) => tool.name === "harbor_join_player");
      await rosterTool.execute("roster", { query: "failure" }, new AbortController().signal, undefined, { cwd: project });
      await filterTool.execute("filter", { query: "failure handling" }, new AbortController().signal, undefined, { cwd: project });
      await joinTool.execute("join", { definition: JSON.stringify({
        name: id, description: `Committed ${id}`, prompt: "Work narrowly.", tools: ["read"],
      }) }, new AbortController().signal, undefined, { cwd: project });
      if (id === "joined-before-failure") throw new Error("provider failed after join commit");
      throw new DOMException("provider cancelled after join commit", "AbortError");
    };

    await commands.get("scout").handler("find a failure specialist", {
      cwd: project, ...authenticatedPiHostState(), ui: { notify: (message: string, level?: string) => notices.push({ message, level }) },
    });
    assert.ok(commands.has("joined-before-failure"), "committed alias was not reconciled after failure");
    assert.equal(notices.at(-1)!.level, "error");
    assert.match(notices.at(-1)!.message, /Roster commit preserved: joined-before-failure is joined and active/u);
    assert.match(notices.at(-1)!.message, /recruiter child ended after that commit/u);

    await commands.get("scout").handler("find a cancellable specialist", {
      cwd: project, ...authenticatedPiHostState(), ui: { notify: (message: string, level?: string) => notices.push({ message, level }) },
    });
    assert.ok(commands.has("joined-before-cancel"), "committed alias was not reconciled after cancellation");
    assert.equal(notices.at(-1)!.level, "warning");
    assert.match(notices.at(-1)!.message, /Cancelled\.[\s\S]*Roster commit preserved: joined-before-cancel is joined and active/u);
    await access(join(project, ".pi", "agents", "joined-before-failure.md"));
    await access(join(project, ".pi", "agents", "joined-before-cancel.md"));
  } finally {
    PiOrchestrator.prototype.run = originalRun;
    GhResolver.prototype.describe = originalDescribe;
    GhResolver.prototype.listCatalog = originalListCatalog;
    GhResolver.prototype.inspectCatalog = originalInspectCatalog;
    if (previousHome === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousHome;
  }
});

test("Pi /scout reconciles and reports a join that commits after the cancelled UI has settled", async () => {
  const root = await mkdtemp(join(tmpdir(), "harbor-pi-scout-late-commit-"));
  const previousHome = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "home");
  const project = join(root, "project");
  const commands = new Map<string, any>();
  const notices: Array<{ message: string; level?: string }> = [];
  let shutdown!: () => Promise<void>;
  piExtension({
    registerCommand: (name: string, options: any) => commands.set(name, options),
    registerTool: () => {},
    getThinkingLevel: () => "minimal",
    on: (event: string, handler: () => Promise<void>) => { if (event === "session_shutdown") shutdown = handler; },
  } as any);
  const originalRun = PiOrchestrator.prototype.run;
  const originalJoinResult = Roster.prototype.joinResult;
  const originalDescribe = GhResolver.prototype.describe;
  const originalListCatalog = GhResolver.prototype.listCatalog;
  const originalInspectCatalog = GhResolver.prototype.inspectCatalog;
  let enterJoin!: () => void; let releaseJoin!: () => void;
  const joinEntered = new Promise<void>((resolve) => { enterJoin = resolve; });
  const joinReleased = new Promise<void>((resolve) => { releaseJoin = resolve; });
  try {
    GhResolver.prototype.describe = async () => ({ commit: "d".repeat(40), description: "Late commit skill." });
    GhResolver.prototype.listCatalog = async (source) => [{
      repo: source.repo, path: "skills/late/SKILL.md", name: "late-skill", track: source.track, commit: "e".repeat(40),
    }];
    GhResolver.prototype.inspectCatalog = async (entry) => ({ name: entry.name, description: "Late commit skill." });
    Roster.prototype.joinResult = async function (input: unknown) {
      enterJoin();
      await joinReleased;
      return originalJoinResult.call(this, input);
    };
    PiOrchestrator.prototype.run = async function () {
      const rosterTool = (this as any).customTools.find((tool: any) => tool.name === "harbor_team_roster");
      const filterTool = (this as any).customTools.find((tool: any) => tool.name === "harbor_filter_skills");
      const joinTool = (this as any).customTools.find((tool: any) => tool.name === "harbor_join_player");
      await rosterTool.execute("roster", { query: "late" }, new AbortController().signal, undefined, { cwd: project });
      await filterTool.execute("filter", { query: "late" }, new AbortController().signal, undefined, { cwd: project });
      await joinTool.execute("join", { definition: JSON.stringify({
        name: "late-commit", description: "Late commit", prompt: "Work narrowly.", tools: ["read"],
      }) }, new AbortController().signal, undefined, { cwd: project });
      return "late scout completed";
    };
    const controller = new AbortController();
    const handler = commands.get("scout").handler("find a late specialist", {
      cwd: project, ...authenticatedPiHostState(), signal: controller.signal,
      ui: { notify: (message: string, level?: string) => notices.push({ message, level }) },
    });
    await joinEntered;
    controller.abort(new DOMException("cancel while join is in flight", "AbortError"));
    await handler;
    assert.equal(notices.length, 1);
    assert.equal(notices[0].level, "warning");
    assert.match(notices[0].message, /^Cancellation requested; provider cleanup is still settling\./u);
    assert.equal(commands.has("late-commit"), false, "alias existed before the delayed transaction committed");

    releaseJoin();
    await shutdown();
    assert.ok(commands.has("late-commit"), "late committed alias was not reconciled from the settlement callback");
    assert.equal(notices.length, 2, "late commit did not produce a distinct corrective notice");
    assert.equal(notices[1].level, "warning");
    assert.match(notices[1].message, /Roster commit preserved: late-commit is joined and active/u);
    assert.match(notices[1].message, /reconciled the alias after commit/u);
    await access(join(project, ".pi", "agents", "late-commit.md"));
  } finally {
    PiOrchestrator.prototype.run = originalRun;
    Roster.prototype.joinResult = originalJoinResult;
    GhResolver.prototype.describe = originalDescribe;
    GhResolver.prototype.listCatalog = originalListCatalog;
    GhResolver.prototype.inspectCatalog = originalInspectCatalog;
    if (previousHome === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousHome;
  }
});

test("Pi direct /contract inherits the host SDK model and thinking level without a global tool", async () => {
  const root = await mkdtemp(join(tmpdir(), "harbor-pi-contract-model-"));
  const commands = new Map<string, any>();
  const tools = new Map<string, any>();
  const notices: string[] = [];
  const hostModel = { provider: "openai-codex", id: "gpt-5.3-codex-spark" };
  const configuredModel = { provider: "router", id: "special", marker: "resolved" };
  piExtension({
    registerCommand: (name: string, options: any) => commands.set(name, options),
    registerTool: (tool: any) => tools.set(tool.name, tool),
    getThinkingLevel: () => "minimal",
  } as any);

  const observed: any[] = [];
  const originalRun = PiOrchestrator.prototype.run;
  try {
    PiOrchestrator.prototype.run = async function (contract: any) {
      const sdk = await (this as any).loadSdk();
      observed.push({
        contract,
        sessionOptions: { ...(this as any).sessionOptions },
        hostMarker: sdk.HARBOR_PI_SDK_HOST_TEST_MARKER,
      });
      return "contract-evidence";
    };
    const contract = JSON.stringify(definition);
    const context = {
      cwd: root,
      model: hostModel,
      modelRegistry: { find: (provider: string, id: string) => provider === "router" && id === "special" ? configuredModel : undefined },
      ui: { notify: (message: string) => notices.push(message) },
    };
    await commands.get("contract").handler(contract, context);
    assert.equal(tools.size, 0);
    await commands.get("contract").handler(JSON.stringify({ ...definition, model: "router/special" }), context);
  } finally {
    PiOrchestrator.prototype.run = originalRun;
  }

  assert.match(notices.at(-1)!, /^contract-evidence\nTEAM RUN · native Pi telemetry · bounded summary/u);
  assert.equal(observed.length, 2);
  assert.ok(observed.every((entry) => entry.hostMarker === "host-sdk-static-import"));
  assert.equal(observed[0].sessionOptions.model, hostModel);
  assert.equal(observed[1].sessionOptions.model, configuredModel);
  assert.ok(observed.every((entry) => entry.sessionOptions.thinkingLevel === "minimal"));
});

test("Pi model-backed commands fail before run creation without a usable authenticated inherited model", async () => {
  const root = await mkdtemp(join(tmpdir(), "harbor-pi-model-preflight-"));
  const previousHome = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "home");
  const project = join(root, "project");
  const commands = new Map<string, any>();
  const notices: Array<{ message: string; level?: string }> = [];
  piExtension({
    registerCommand: (name: string, options: any) => commands.set(name, options),
    registerTool: () => {},
    getThinkingLevel: () => "minimal",
  } as any);
  const sentinel = {
    provider: "unknown", id: "unknown", api: "unknown", contextWindow: 0, maxTokens: 0,
  };
  const selected = { provider: "authenticated-provider", id: "selected-model" };
  const notify = (message: string, level?: string) => notices.push({ message, level });
  const context = (model: any, modelRegistry: any) => ({
    cwd: project, model, modelRegistry, ui: { notify },
  });
  const registry = (
    available: any[],
    options: { error?: string; authenticated?: boolean; configured?: any } = {},
  ) => ({
    getAvailable: () => available,
    getError: () => options.error,
    find: (provider: string, id: string) => {
      const configured = options.configured;
      return configured?.provider === provider && configured?.id === id ? configured : undefined;
    },
    hasConfiguredAuth: () => options.authenticated ?? false,
  });
  const contract = (model?: string) => JSON.stringify({
    name: "preflight-contract", description: "Preflight contract", prompt: "Return evidence.",
    tools: ["read"], task: "Check model preflight", ...(model ? { model } : {}),
  });
  const originalRun = PiOrchestrator.prototype.run;
  const started: Array<{ name: string; model: any }> = [];
  try {
    PiOrchestrator.prototype.run = async function (definition: any) {
      started.push({ name: definition.name, model: (this as any).sessionOptions.model });
      return `evidence:${definition.name}`;
    };

    for (const [command, args] of [
      ["crafter", "craft without a model"],
      ["scout", "find capacity without a model"],
      ["contract", contract()],
    ] as const) {
      await commands.get(command).handler(args, context(sentinel, registry([], { authenticated: false })));
      assert.match(notices.at(-1)!.message, /Pi reports no usable authenticated model/u);
      assert.match(notices.at(-1)!.message, /\/login[\s\S]*\/model/u);
      assert.match(notices.at(-1)!.message, /Preflight stopped · no model was called · 0 model tokens/u);
      assert.doesNotMatch(notices.at(-1)!.message, /TEAM RUN/u);
    }
    await commands.get("team-lead").handler("lead without a selected model", context(
      undefined,
      registry([], { authenticated: false }),
    ));
    assert.match(notices.at(-1)!.message, /Pi reports no usable authenticated model/u);
    assert.equal(started.length, 0);

    await commands.get("crafter").handler("select before running", context(
      sentinel,
      registry([selected], { authenticated: true }),
    ));
    assert.match(notices.at(-1)!.message, /Pi has 1 usable model, but none is selected/u);
    assert.match(notices.at(-1)!.message, /Use \/model/u);
    assert.equal(started.length, 0);

    await commands.get("crafter").handler("registry is unhealthy", context(
      sentinel,
      registry([], { error: "availability refresh failed", authenticated: false }),
    ));
    assert.match(notices.at(-1)!.message, /model availability is unobserved/u);
    assert.equal(started.length, 0);

    await commands.get("crafter").handler("stale authentication", context(
      selected,
      registry([selected], { authenticated: false }),
    ));
    assert.match(notices.at(-1)!.message, /selected Pi model has no configured authentication/u);
    assert.match(notices.at(-1)!.message, /\/login authenticated-provider/u);
    assert.equal(started.length, 0);

    await commands.get("team").handler("", context(undefined, registry([], { authenticated: false })));
    assert.match(notices.at(-1)!.message,
      /No active persistent work; disposable contractors are visible only in their owning Pi process/u);
    assert.doesNotMatch(notices.at(-1)!.message, /LAST MISSION|TEAM RUN/u);

    const authenticated = context(selected, registry([selected], { authenticated: true }));
    await commands.get("crafter").handler("authenticated direct work", authenticated);
    await commands.get("scout").handler("authenticated scout work", authenticated);
    await commands.get("contract").handler(contract(), authenticated);
    assert.deepEqual(started.map(({ name }) => name), ["crafter", "talent-scout", "preflight-contract"]);
    assert.ok(started.every(({ model }) => model === selected));

    const configured = { provider: "private-router", id: "contract-model" };
    await commands.get("contract").handler(contract("private-router/contract-model"), context(
      sentinel,
      registry([], { authenticated: true, configured }),
    ));
    assert.equal(started.at(-1)!.name, "preflight-contract");
    assert.equal(started.at(-1)!.model, configured,
      "an explicit authenticated contract model was incorrectly blocked by the inherited-model preflight");
  } finally {
    PiOrchestrator.prototype.run = originalRun;
    if (previousHome === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousHome;
  }
});

test("Pi captures only command-required public provider projections before creating a run", async () => {
  const root = await mkdtemp(join(tmpdir(), "harbor-pi-provider-capture-"));
  const home = join(root, "home");
  const project = join(root, "project");
  const previousHome = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = home;
  const roster = new Roster(harnessSpec("pi", home, project));
  await roster.join({
    name: "alpha-worker", description: "Alpha route", prompt: "Work", tools: ["read"], model: "alpha/model-a",
  });
  await roster.join({
    name: "beta-worker", description: "Beta route", prompt: "Work", tools: ["read"], model: "beta/model-b",
  });
  const commands = new Map<string, any>();
  const notices: Array<{ message: string; level?: string }> = [];
  const previousCwd = process.cwd();
  try {
    process.chdir(project);
    piExtension({
      registerCommand: (name: string, options: any) => commands.set(name, options),
      registerTool: () => {},
      getThinkingLevel: () => "minimal",
    } as any);
  } finally { process.chdir(previousCwd); }

  const selected = { provider: "selected-custom", id: "main" };
  const secret = "runtime-key-never-persist-or-log";
  const configs = new Map<string, any>([
    ["selected-custom", { name: "Selected custom provider", api: "openai-completions" }],
    ["alpha", { name: "Alpha provider", api: "openai-completions" }],
    ["beta", { name: "Beta provider", api: "openai-completions" }],
    ["unused", { name: "Unused provider", api: "openai-completions" }],
  ]);
  const configLookups: string[] = [];
  const statusLookups: string[] = [];
  const runtimeKeyLookups: string[] = [];
  let runtimeKeyFailure = true;
  const context = {
    cwd: project,
    model: selected,
    modelRegistry: {
      find: (provider: string, id: string) => provider === selected.provider && id === selected.id
        ? selected
        : undefined,
      getAvailable: () => [selected],
      getError: () => undefined,
      hasConfiguredAuth: (candidate: any) => candidate === selected,
      getRegisteredProviderConfig: (id: string) => {
        configLookups.push(id);
        return configs.get(id);
      },
      getProviderAuthStatus: (id: string) => {
        statusLookups.push(id);
        return { configured: true, source: id === "selected-custom" ? "runtime" : "stored" };
      },
      getApiKeyForProvider: async (id: string) => {
        runtimeKeyLookups.push(id);
        if (runtimeKeyFailure) throw new Error(`private provider failure containing ${secret}`);
        return id === "selected-custom" ? secret : undefined;
      },
    },
    ui: { notify: (message: string, level?: string) => notices.push({ message, level }) },
  } as any;
  const captures: Array<{ definition: any; sessionOptions: any }> = [];
  const originalRun = PiOrchestrator.prototype.run;
  try {
    PiOrchestrator.prototype.run = async function (runDefinition: any) {
      captures.push({
        definition: runDefinition,
        sessionOptions: (this as any).sessionOptions,
      });
      return `evidence:${runDefinition.name}`;
    };

    await commands.get("crafter").handler("must fail during provider capture", context);
    assert.equal(captures.length, 0, "runtime-only key failure created a child run");
    assert.match(notices.at(-1)!.message, /could not transfer runtime-only authentication for provider selected-custom/u);
    assert.match(notices.at(-1)!.message, /Preflight stopped · no model was called · 0 model tokens/u);
    assert.doesNotMatch(notices.at(-1)!.message, new RegExp(secret, "u"));
    await commands.get("team").handler("", context);
    assert.match(notices.at(-1)!.message,
      /No active persistent work; disposable contractors are visible only in their owning Pi process/u);
    assert.doesNotMatch(notices.at(-1)!.message, /LAST MISSION|TEAM RUN/u);

    runtimeKeyFailure = false;
    await commands.get("crafter").handler("direct work", context);
    const firstCapture = captures[0];
    configs.get("selected-custom").name = "Mutated after capture";
    await commands.get("scout").handler("find a teammate", context);
    await commands.get("contract").handler(JSON.stringify({
      name: "provider-contract", description: "Provider capture", prompt: "Return evidence.",
      tools: ["read"], task: "contract work",
    }), context);
    await commands.get("team-lead").handler("coordinate configured teammates", context);

    assert.deepEqual(captures.map(({ definition: item }) => item.name), [
      "crafter", "talent-scout", "provider-contract", "team-lead",
    ]);
    for (const capture of captures.slice(0, 3)) {
      assert.deepEqual(capture.sessionOptions.providerProjections.map(({ id }: any) => id), ["selected-custom"]);
      assert.equal(capture.sessionOptions.providerProjections[0].runtimeKey, secret);
    }
    assert.equal(firstCapture.sessionOptions.providerProjections[0].config.name, "Selected custom provider",
      "provider configuration was not snapshotted at command time");
    const leadProjections = captures[3].sessionOptions.providerProjections;
    assert.equal(leadProjections[0].id, "selected-custom");
    assert.deepEqual(new Set(leadProjections.slice(1).map(({ id }: any) => id)), new Set(["alpha", "beta"]));
    assert.equal(leadProjections.find(({ id }: any) => id === "alpha").runtimeKey, undefined);
    assert.equal(leadProjections.find(({ id }: any) => id === "beta").runtimeKey, undefined);
    assert.equal(configLookups.includes("unused"), false);
    assert.equal(statusLookups.includes("unused"), false);
    assert.deepEqual(new Set(runtimeKeyLookups), new Set(["selected-custom"]));
    assert.ok(notices.every(({ message }) => !message.includes(secret)), "runtime key leaked into Pi notices");
    await assert.rejects(access(join(home, "auth.json")));
    await assert.rejects(access(join(home, "models.json")));
  } finally {
    PiOrchestrator.prototype.run = originalRun;
    if (previousHome === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousHome;
  }
});

test("Pi revalidates admission after retire wins the provider-auth preflight gap", async () => {
  const root = await mkdtemp(join(tmpdir(), "harbor-pi-admission-race-"));
  const home = join(root, "home");
  const project = join(root, "project");
  const previousHome = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = home;
  const roster = new Roster(harnessSpec("pi", home, project));
  await roster.join({
    name: "race-reviewer",
    description: "Review lifecycle admission races",
    prompt: "Review safely",
    tools: ["read"],
  });
  const commands = new Map<string, any>();
  const notices: Array<{ message: string; level?: string }> = [];
  const previousCwd = process.cwd();
  try {
    process.chdir(project);
    piExtension({
      registerCommand: (name: string, options: any) => commands.set(name, options),
      registerTool: () => {},
      getThinkingLevel: () => "minimal",
    } as any);
  } finally { process.chdir(previousCwd); }

  let authEnteredResolve!: () => void;
  let releaseAuth!: () => void;
  const authEntered = new Promise<void>((resolve) => { authEnteredResolve = resolve; });
  const authRelease = new Promise<void>((resolve) => { releaseAuth = resolve; });
  const selected = { provider: "runtime-provider", id: "runtime-model" };
  const context = {
    cwd: project,
    model: selected,
    modelRegistry: {
      find: (provider: string, id: string) => provider === selected.provider && id === selected.id
        ? selected
        : undefined,
      getAvailable: () => [selected],
      getError: () => undefined,
      hasConfiguredAuth: () => true,
      getRegisteredProviderConfig: () => ({ name: "Runtime provider", api: "openai-completions" }),
      getProviderAuthStatus: () => ({ configured: true, source: "runtime" }),
      getApiKeyForProvider: async () => {
        authEnteredResolve();
        await authRelease;
        return "runtime-secret";
      },
    },
    ui: { notify: (message: string, level?: string) => notices.push({ message, level }) },
  } as any;
  const originalRun = PiOrchestrator.prototype.run;
  let starts = 0;
  try {
    PiOrchestrator.prototype.run = async () => {
      starts += 1;
      return "must not run";
    };
    const pending = commands.get("race-reviewer").handler("must not use stale admission", context);
    await authEntered;
    await commands.get("retire").handler("race-reviewer", context);
    assert.match(notices.at(-1)!.message, /race-reviewer unregistered and deactivated here/u);
    await assert.rejects(access(join(project, ".pi", "agents", "race-reviewer.md")));
    releaseAuth();
    await pending;

    assert.equal(starts, 0, "retired Pi player crossed runtime.begin and started a model child");
    assert.match(notices.at(-1)!.message,
      /active managed player changed during preflight: race-reviewer; inspect \/team and retry/u);
    assert.match(notices.at(-1)!.message, /Preflight stopped · no model was called · 0 model tokens/u);
    assert.doesNotMatch(notices.map(({ message }) => message).join("\n"), /runtime-secret/u);
  } finally {
    PiOrchestrator.prototype.run = originalRun;
    releaseAuth?.();
    if (previousHome === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousHome;
  }
});

test("Pi reserves a team-lead snapshot against concurrent bench off", async () => {
  const root = await mkdtemp(join(tmpdir(), "harbor-pi-lead-bench-race-"));
  const home = join(root, "home");
  const project = join(root, "project");
  const previousHome = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = home;
  const roster = new Roster(harnessSpec("pi", home, project));
  await roster.bench("on build", bundledPlayers);
  const commands = new Map<string, any>();
  const notices: Array<{ message: string; level?: string }> = [];
  const previousCwd = process.cwd();
  try {
    process.chdir(project);
    piExtension({
      registerCommand: (name: string, options: any) => commands.set(name, options),
      registerTool: () => {},
      getThinkingLevel: () => "minimal",
    } as any);
  } finally { process.chdir(previousCwd); }
  const context = {
    cwd: project,
    ...authenticatedPiHostState(),
    ui: {
      notify: (message: string, level?: string) => notices.push({ message, level }),
      setStatus: () => {},
      setWidget: () => {},
    },
  } as any;
  let runEnteredResolve!: () => void;
  let releaseRun!: () => void;
  const runEntered = new Promise<void>((resolve) => { runEnteredResolve = resolve; });
  const runRelease = new Promise<void>((resolve) => { releaseRun = resolve; });
  const originalRun = PiOrchestrator.prototype.run;
  try {
    PiOrchestrator.prototype.run = async function () {
      (this as any).runObserver.sessionStarted();
      runEnteredResolve();
      await runRelease;
      return "lead completed";
    };
    const pending = commands.get("team-lead").handler("coordinate the active build specialist", context);
    await runEntered;
    await commands.get("bench").handler("off build", context);

    assert.match(notices.at(-1)!.message,
      /cannot bench off build while team-lead owns its active roster snapshot in pi-run-1/u);
    assert.match(notices.at(-1)!.message,
      /use \/team stop pi-run-1, then wait for cleanup to settle/u);
    await access(join(project, ".pi", "agents", "build.md"));

    releaseRun();
    await pending;
    await commands.get("bench").handler("off build", context);
    assert.match(notices.at(-1)!.message, /build moved to the bench in this project/u);
    await assert.rejects(access(join(project, ".pi", "agents", "build.md")));
  } finally {
    PiOrchestrator.prototype.run = originalRun;
    releaseRun?.();
    if (previousHome === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousHome;
  }
});

test("Pi configured personal models fail closed before a child and resolve when authenticated", async () => {
  const root = await mkdtemp(join(tmpdir(), "harbor-pi-personal-model-preflight-"));
  const home = join(root, "home");
  const project = join(root, "project");
  const previousHome = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = home;
  const roster = new Roster(harnessSpec("pi", home, project));
  for (const [name, model] of [
    ["model-malformed", "router"],
    ["model-missing", "router/missing"],
    ["model-unauth", "router/no-auth"],
    ["model-ready", "router/ready"],
  ] as const) {
    await roster.join({ name, description: name, prompt: "Work", tools: ["read"], model });
  }
  const commands = new Map<string, any>();
  const notices: Array<{ message: string; level?: string }> = [];
  const previousCwd = process.cwd();
  try {
    process.chdir(project);
    piExtension({
      registerCommand: (name: string, options: any) => commands.set(name, options),
      registerTool: () => {},
      getThinkingLevel: () => "low",
    } as any);
  } finally { process.chdir(previousCwd); }
  const readyModel = { provider: "router", id: "ready" };
  const unauthModel = { provider: "router", id: "no-auth" };
  const context = {
    cwd: project,
    model: undefined,
    modelRegistry: {
      find: (provider: string, id: string) => provider !== "router" ? undefined
        : id === "ready" ? readyModel : id === "no-auth" ? unauthModel : undefined,
      hasConfiguredAuth: (model: any) => model !== unauthModel,
    },
    ui: { notify: (message: string, level?: string) => notices.push({ message, level }) },
  } as any;
  const originalRun = PiOrchestrator.prototype.run;
  const started: any[] = [];
  try {
    PiOrchestrator.prototype.run = async function (definition: any) {
      started.push({ definition, model: (this as any).sessionOptions.model });
      return "configured model evidence";
    };
    await commands.get("model-malformed").handler("work", context);
    assert.match(notices.at(-1)!.message, /must use provider\/model syntax/u);
    assert.match(notices.at(-1)!.message, /Preflight stopped · no model was called · 0 model tokens/u);
    await commands.get("model-missing").handler("work", context);
    assert.match(notices.at(-1)!.message, /configured Pi model is unavailable/u);
    await commands.get("model-unauth").handler("work", context);
    assert.match(notices.at(-1)!.message, /configured Pi model has no available authentication/u);
    assert.equal(started.length, 0);
    assert.ok(notices.slice(-3).every(({ message }) => !message.includes("TEAM RUN")));

    await commands.get("model-ready").handler("work", context);
    assert.equal(started.length, 1);
    assert.equal(started[0].definition.name, "model-ready");
    assert.equal(started[0].model, readyModel);
    assert.match(notices.at(-1)!.message, /configured model evidence[\s\S]*TEAM RUN/u);
  } finally {
    PiOrchestrator.prototype.run = originalRun;
    if (previousHome === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousHome;
  }
});

test("Pi deterministic command handlers never enter the SDK orchestrator", async () => {
  const root = await mkdtemp(join(tmpdir(), "harbor-pi-direct-"));
  const previousHome = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "home");
  const project = join(root, "project");
  const commands = new Map<string, any>(); const notices: string[] = [];
  let registrationCalls = 0;
  const originalRun = PiOrchestrator.prototype.run;
  const originalListCatalog = GhResolver.prototype.listCatalog;
  try {
    PiOrchestrator.prototype.run = async () => { throw new Error("model orchestrator was invoked"); };
    GhResolver.prototype.listCatalog = async (source) => [{ repo: source.repo, path: source.path ?? "skills/zx-example-author/SKILL.md", name: source.name ?? "zx-example-author" }];
    piExtension({
      registerCommand: (name: string, options: any) => { registrationCalls += 1; commands.set(name, options); },
      registerTool: () => {},
      getThinkingLevel: () => { throw new Error("deterministic commands requested model state"); },
    } as any);
    const context = { cwd: project, ui: { notify: (value: string) => notices.push(value) } };
    await commands.get("bench").handler("list", context);
    assert.match(notices.at(-1)!, /portfolio-management · bundled · bench/);
    assert.match(notices.at(-1)!, /0 model tokens/);
    await commands.get("join").handler(JSON.stringify({ name: "native", description: "Native", prompt: "Work", tools: ["read"] }), {
      ...context,
    });
    assert.match(notices.at(-1)!, /native joined · personal · ready/u);
    assert.ok(commands.has("native"), "join must register /native in the current Pi session");
    const registrationsBeforeJoinNoOp = registrationCalls;
    await commands.get("join").handler(JSON.stringify({ name: "native", description: "Native", prompt: "Work", tools: ["read"] }), context);
    assert.match(notices.at(-1)!, /○ native is already joined and current · no roster files changed\./u);
    assert.equal(registrationCalls, registrationsBeforeJoinNoOp + 1,
      "a verified join no-op did not reconcile the active alias after possible external drift");
    await commands.get("bench").handler("off native", context);
    assert.match(notices.at(-1)!, /✓ native moved to the bench in this project\./u);
    const registrationsBeforeBenchNoOp = registrationCalls;
    await commands.get("bench").handler("off native", context);
    assert.match(notices.at(-1)!, /○ native is already benched · this member was unchanged\.[\s\S]*No roster files changed\./u);
    assert.match(notices.at(-1)!,
      /If this session still lists a benched alias, run \/reload to remove it from completion/u);
    assert.equal(registrationCalls, registrationsBeforeBenchNoOp, "a Pi bench no-op refreshed active commands");
    await commands.get("bench").handler("on design", context);
    await commands.get("bench").handler("on design,build", context);
    const mixedBench = notices.at(-1)!;
    assert.match(mixedBench, /○ design is already enabled · this member was unchanged\./u);
    assert.match(mixedBench, /✓ build enabled in this project\./u);
    assert.doesNotMatch(mixedBench, /No roster files changed\./u);
    const registrationsBeforeAllBenchNoOp = registrationCalls;
    await commands.get("bench").handler("on design,build", context);
    const allBenchNoOp = notices.at(-1)!;
    assert.equal((allBenchNoOp.match(/this member was unchanged\./gu) ?? []).length, 2);
    assert.equal((allBenchNoOp.match(/No roster files changed\./gu) ?? []).length, 1);
    assert.equal(registrationCalls, registrationsBeforeAllBenchNoOp + 2,
      "a verified bench no-op did not reconcile both active aliases after possible external drift");
    await commands.get("retire").handler("native", context);
    assert.match(notices.at(-1)!, /native unregistered and deactivated here/u);
    await commands.get("retire").handler("native", context);
    assert.match(notices.at(-1)!, /native was already retired here · no roster files changed/u);
    assert.match(notices.at(-1)!, /^Agent Harbor \/retire · 0 model tokens\n○ native/u);
    await commands.get("list-skills").handler("zx", context);
    assert.match(notices.at(-1)!, /REPOSITORY.*PATH.*SKILL/);
    assert.match(notices.at(-1)!, /\x1b\[/);

    await mkdir(join(project, ".agent-harbor"), { recursive: true });
    await writeFile(join(project, ".agent-harbor", "skill-sources.json"), "{broken", "utf8");
    await commands.get("bench").handler("list", context);
    assert.match(notices.at(-1)!, /portfolio-management · bundled · bench/u);
    await commands.get("team").handler("", context);
    assert.match(notices.at(-1)!, /team-lead · manager · ready/u);
    await commands.get("join").handler(JSON.stringify({ name: "catalog-independent", description: "Independent", prompt: "Work", tools: ["read"] }), context);
    assert.match(notices.at(-1)!, /catalog-independent joined/u);
    await commands.get("retire").handler("catalog-independent", context);
    assert.match(notices.at(-1)!, /catalog-independent unregistered/u);
    await commands.get("list-skills").handler("zx", context);
    assert.match(notices.at(-1)!, /invalid JSON in skill catalog config/u);
    assert.ok(notices.every((value) => !value.includes("model orchestrator was invoked")));
  } finally {
    PiOrchestrator.prototype.run = originalRun;
    GhResolver.prototype.listCatalog = originalListCatalog;
    if (previousHome === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousHome;
  }
});

test("Pi rejects missing or mismatched lifecycle truth before presenting join and bench mutations", () => {
  const joinArgs = JSON.stringify({ name: "truthful", description: "Truthful", prompt: "Work", tools: ["read"] });
  assert.throws(() => requirePiJoinLifecycleOutcome(joinArgs, undefined), /lifecycle outcome.*unverified/u);
  assert.throws(() => requirePiJoinLifecycleOutcome(joinArgs, {
    command: "join", player: "different", status: "changed",
  }), /mismatched lifecycle outcome/u);
  assert.throws(() => requirePiBenchLifecycleOutcome("on design,build", undefined),
    /lifecycle outcome.*unverified/u);
  assert.throws(() => requirePiBenchLifecycleOutcome("on design,build", {
    command: "bench",
    status: "changed",
    rows: [
      { id: "build", action: "on", status: "changed" },
      { id: "design", action: "on", status: "already-current" },
    ],
  }), /mismatched lifecycle outcome/u);
  assert.throws(() => requirePiBenchLifecycleOutcome("off design", {
    command: "bench",
    status: "already-current",
    rows: [{ id: "design", action: "off", status: "changed" }],
  }), /mismatched lifecycle outcome/u);
  assert.throws(() => requirePiRetireLifecycleOutcome("truthful", undefined),
    /lifecycle outcome.*unverified/u);
  assert.throws(() => requirePiRetireLifecycleOutcome("truthful", {
    command: "retire", player: "different", status: "changed",
  }), /mismatched lifecycle outcome/u);
});

test("Pi /team and enriched /bench are searchable zero-model controls with completions and human errors", async () => {
  const root = await mkdtemp(join(tmpdir(), "harbor-pi-team-control-"));
  const previousHome = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "home");
  const project = join(root, "project");
  const commands = new Map<string, any>();
  const notices: Array<{ message: string; level?: string }> = [];
  const originalRun = PiOrchestrator.prototype.run;
  try {
    PiOrchestrator.prototype.run = async () => { throw new Error("model boundary crossed"); };
    piExtension({
      registerCommand: (name: string, options: any) => commands.set(name, options),
      registerTool: () => {},
      getThinkingLevel: () => { throw new Error("deterministic control requested model settings"); },
    } as any);
    const context = { cwd: project, ui: { notify: (message: string, level?: string) => notices.push({ message, level }) } } as any;
    await commands.get("team").handler("", context);
    assert.match(notices.at(-1)!.message, /Agent Harbor team .*0 model tokens/u);
    assert.match(notices.at(-1)!.message, /team-lead · manager · ready/u);
    assert.match(notices.at(-1)!.message, /talent-scout \(\/scout\) · utility · ready/u);
    assert.match(notices.at(-1)!.message,
      /No active persistent work; disposable contractors are visible only in their owning Pi process/u);
    const offlineSentinel = {
      ...context,
      model: { provider: "unknown", id: "unknown", maxTokens: 0 },
    } as any;
    await commands.get("team").handler("", offlineSentinel);
    const offlineTeam = notices.at(-1)!.message.replace(/\s+/gu, " ");
    assert.match(offlineTeam,
      /Next child: no active model; availability unobserved \(use \/model or \/login\).*max output unknown/u);
    assert.match(offlineTeam,
      /Delegable now: none \(model availability unobserved; use \/model or \/login\)/u);
    assert.doesNotMatch(notices.at(-1)!.message, /unknown\/unknown \(inherited\)|max output per response 0 tokens/u);
    await commands.get("team").handler("", {
      ...context,
      model: { provider: "unknown", id: "default", maxTokens: 0 },
      modelRegistry: { getAvailable: () => [], getError: () => undefined },
    } as any);
    const noModelTeam = notices.at(-1)!.message.replace(/\s+/gu, " ");
    assert.match(noModelTeam,
      /Next child: unavailable \(Pi reports no usable models; use \/login\).*max output unknown/u);
    assert.doesNotMatch(noModelTeam, /unknown\/default \(unobserved\)|max output per response 0 tokens/u);
    await commands.get("team").handler("", {
      ...context,
      model: undefined,
      modelRegistry: { getAvailable: () => [], getError: () => undefined },
    } as any);
    const emptyRegistryTeam = notices.at(-1)!.message.replace(/\s+/gu, " ");
    assert.match(emptyRegistryTeam,
      /Next child: unavailable \(Pi reports no usable models; use \/login\).*max output unknown/u);
    assert.match(emptyRegistryTeam, /Delegable now: none \(model unavailable\)/u);
    await commands.get("team").handler("", {
      ...context,
      model: undefined,
      modelRegistry: {
        getAvailable: () => [{ provider: "available-provider", id: "available-model" }],
        getError: () => undefined,
      },
    } as any);
    const unselectedTeam = notices.at(-1)!.message.replace(/\s+/gu, " ");
    assert.match(unselectedTeam,
      /Next child: not selected \(1 available; use \/model\).*max output unknown/u);
    assert.doesNotMatch(unselectedTeam, /Pi reports no usable models/u);
    assert.match(unselectedTeam, /Delegable now: none \(select a model with \/model\)/u);
    assert.doesNotMatch(unselectedTeam, /Delegable now: crafter/u);
    await commands.get("team").handler("", {
      ...context,
      model: undefined,
      modelRegistry: { getAvailable: () => [], getError: () => "availability refresh failed" },
    } as any);
    const unhealthyRegistryTeam = notices.at(-1)!.message.replace(/\s+/gu, " ");
    assert.match(unhealthyRegistryTeam,
      /Next child: no active model; availability unobserved \(use \/model or \/login\).*max output unknown/u);
    assert.match(unhealthyRegistryTeam,
      /Delegable now: none \(model availability unobserved; use \/model or \/login\)/u);
    assert.doesNotMatch(unhealthyRegistryTeam, /Pi reports no usable models/u);
    await commands.get("team").handler("", {
      ...context,
      model: { provider: "unknown", id: "unknown", api: "unknown", maxTokens: 0, contextWindow: 0 },
      modelRegistry: { getAvailable: () => [], getError: () => undefined },
    } as any);
    const canonicalSentinelTeam = notices.at(-1)!.message.replace(/\s+/gu, " ");
    assert.match(canonicalSentinelTeam,
      /Next child: unavailable \(Pi reports no usable models; use \/login\).*Delegable now: none \(model unavailable\)/u);
    await commands.get("team").handler("", {
      ...context,
      model: { provider: "unknown", id: "default", maxTokens: 0 },
      modelRegistry: {
        getAvailable: () => [{ provider: "available-provider", id: "available-model" }],
        getError: () => undefined,
      },
    } as any);
    const sentinelWithAvailableModel = notices.at(-1)!.message.replace(/\s+/gu, " ");
    assert.match(sentinelWithAvailableModel, /Next child: not selected \(1 available; use \/model\)/u);
    assert.match(sentinelWithAvailableModel, /Delegable now: none \(select a model with \/model\)/u);
    assert.doesNotMatch(sentinelWithAvailableModel, /model unavailable|Delegable now: crafter/u);
    await commands.get("team").handler("", {
      ...context,
      model: { provider: "openai", id: "gpt-valid", maxTokens: -1 },
    } as any);
    assert.match(notices.at(-1)!.message.replace(/\s+/gu, " "),
      /Next child: openai\/gpt-valid \(inherited\).*max output unknown/u);
    assert.match(notices.at(-1)!.message, /Delegable now: crafter/u);
    assert.doesNotMatch(notices.at(-1)!.message, /max output per response -1 tokens/u);
    await commands.get("bench").handler("list construction", context);
    assert.match(notices.at(-1)!.message, /build · bundled · bench/u);
    assert.doesNotMatch(notices.at(-1)!.message, /portfolio-management · bundled/u);
    await commands.get("team").handler("does-not-exist", context);
    assert.match(notices.at(-1)!.message, /No team member or tracked activity matches/u);
    await commands.get("join").handler("{broken", context);
    assert.match(notices.at(-1)!.message, /Invalid JSON for \/join/u);
    assert.match(notices.at(-1)!.message, /0 model tokens/u);
    await commands.get("join").handler(JSON.stringify({
      name: "forged-model", description: "Safe", prompt: "Work", tools: ["read"],
      model: "router/x\n● forged-member · working",
    }), context);
    assert.match(notices.at(-1)!.message, /invalid model/u);
    await commands.get("join").handler(JSON.stringify({
      name: "forged-description", description: "Safe\u001b[31m\n● forged-member · working", prompt: "Work", tools: ["read"],
    }), context);
    assert.match(notices.at(-1)!.message, /invalid description/u);
    await commands.get("team").handler("", context);
    assert.doesNotMatch(notices.at(-1)!.message, /forged-member/u);
    const teamItems = await commands.get("team").getArgumentCompletions("craft");
    assert.deepEqual(teamItems.map((item: any) => item.value), ["crafter"]);
    const benchItems = await commands.get("bench").getArgumentCompletions("on build");
    assert.deepEqual(benchItems.map((item: any) => item.value), ["on build"]);
    assert.match(commands.get("team").description, /0 model tokens.*\/team \[filter\|stop <run-id\|all>\]/u);
    assert.match(commands.get("bench").description, /0 model tokens.*\/bench/u);
    assert.match(commands.get("join").description, /persist, and activate one personal teammate/u);
    assert.match(commands.get("retire").description, /Unregister one personal teammate/u);
    assert.match(commands.get("list-skills").description, /Search the trusted skill catalog/u);
    assert.match(commands.get("list-skills").description, /--page N/u);
    await commands.get("team").handler("help", context);
    const helpPage1 = notices.at(-1)!.message;
    assert.match(helpPage1, /\/team roster-page:1[\s\S]*\/team activity-page:1[\s\S]*\/team history-page:1/u);
    assert.match(helpPage1, /Exact run telemetry: \/team run:<id>/u);
    assert.match(helpPage1, /States: ready\/idle, starting, working, cleaning, bench, stale, conflict/u);
    await commands.get("team").handler("help page:2", context);
    const helpPage2 = notices.at(-1)!.message;
    assert.match(helpPage2, /Fields: member:, kind:, description:, capability:, tool:, skill:, status:, model:/u);
    assert.match(helpPage2, /thinking:, task:, run:, owner:, pid:, heartbeat:/u);
    assert.match(helpPage2, /Every structured field requires a value; unknown prefixes are rejected/u);
    assert.match(helpPage2, /\/team stop <run-id\|all>[\s\S]*\/bench list page:1[\s\S]*\/retire <personal-id>/u);
    await commands.get("team").handler("help page:3", context);
    const helpPage3 = notices.at(-1)!.message;
    assert.match(helpPage3, /Direct teammate: \/<id> <task> · Cost: 1 lead \+ up to 6 sequential specialist children/u);
    assert.match(helpPage3, /^\/contract \{"name":"a","description":"Audit","prompt":"Audit","tools":\["read"\],"task":"Review"\}$/mu);
    assert.match(helpPage3, /^\/join \{"name":"reviewer","description":"Review","prompt":"Review","tools":\["read"\]\}$/mu);
    assert.match(helpPage3, /Observed tokens\/cost are provider facts; unreported values stay unobserved/u);
    assert.match(helpPage3, /A new team-lead needs two free shared slots/u);
    for (const page of [helpPage1, helpPage2, helpPage3]) {
      assert.ok(page.split("\n").length <= 30);
      assert.ok(page.split("\n").every((line) => visibleTextWidth(line) <= 96));
    }
    await commands.get("bench").handler("on design", context);
    assert.equal((notices.at(-1)!.message.match(/0 model tokens/gu) ?? []).length, 1);
    assert.match(commands.get("design").description, /Solution design/u);
    await commands.get("bench").handler("off design", context);
    assert.equal((notices.at(-1)!.message.match(/0 model tokens/gu) ?? []).length, 1);
    assert.match(notices.at(-1)!.message, /run \/reload/u);
    await commands.get("design").handler("stale invocation", context);
    assert.match(notices.at(-1)!.message, /Preflight stopped · no model was called · 0 model tokens/u);
    assert.match(notices.at(-1)!.message, /Usage: \/design <task>/u);
    assert.match(notices.at(-1)!.message, /Cost: 1 model child when active/u);
    assert.doesNotMatch(notices.at(-1)!.message, /Cost: 0 model tokens/u);
    const rpcContext = { ...context, mode: "rpc" };
    const noticeCountBeforeRpcFailure = notices.length;
    await assert.rejects(() => commands.get("design").handler("stale RPC invocation", rpcContext), /run \/team.*\/reload/isu);
    assert.equal(notices.length, noticeCountBeforeRpcFailure, "RPC duplicated the structured failure through notify");
    await commands.get("contract").handler("{broken", context);
    assert.equal((notices.at(-1)!.message.match(/Preflight stopped · no model was called · 0 model tokens/gu) ?? []).length, 1);
    await commands.get("scout").handler("", context);
    assert.equal((notices.at(-1)!.message.match(/Preflight stopped · no model was called · 0 model tokens/gu) ?? []).length, 1);
    await commands.get("crafter").handler("", context);
    assert.equal((notices.at(-1)!.message.match(/Preflight stopped · no model was called · 0 model tokens/gu) ?? []).length, 1);
    await commands.get("bench").handler("help", context);
    assert.match(notices.at(-1)!.message, /all means the six bundled SDLC specialists only; personal members are unchanged/u);
    await commands.get("retire").handler("", context);
    assert.match(notices.at(-1)!.message, /Usage: \/retire <personal-id>/u);
    assert.equal((notices.at(-1)!.message.match(/0 model tokens/gu) ?? []).length, 1);
    const joinedInput = JSON.stringify({
      name: "concise", description: "Concise reviewer", prompt: "Review", tools: ["read"],
      skills: [trustedSkills[0]], model: "router/special",
    });
    await commands.get("join").handler(joinedInput, context);
    assert.match(notices.at(-1)!.message, /concise joined · personal · ready/u);
    assert.match(notices.at(-1)!.message, /Capacity: read, skill:zx-example-author/u);
    assert.match(notices.at(-1)!.message, /Model: configured router\/special/u);
    assert.doesNotMatch(notices.at(-1)!.message, /registration:|active:|\\home\\|\/home\//u);
    const joinedCompletion = await commands.get("team").getArgumentCompletions("concise");
    assert.deepEqual(joinedCompletion.map((item: any) => item.value), ["concise"], "join did not invalidate the completion cache");
    await commands.get("join").handler(JSON.stringify({
      name: "concise", description: "Updated concise reviewer", prompt: "Review", tools: ["read"], replace: true,
    }), context);
    assert.match(commands.get("concise").description, /Updated concise reviewer/u);
    await commands.get("join").handler(JSON.stringify({
      name: "private-metadata",
      description: "Review C:/Users/alice/secret.txt with Bearer abcdefghijklmnop",
      prompt: "Review",
      tools: ["read"],
    }), context);
    assert.match(notices.at(-1)!.message, /Role: Review \[path\] with \[redacted\]/u);
    assert.doesNotMatch(notices.at(-1)!.message, /alice|secret\.txt|abcdefghijklmnop/u);
    await commands.get("team").handler("private-metadata", context);
    assert.match(notices.at(-1)!.message, /Review \[path\] with \[redacted\]/u);
    assert.doesNotMatch(notices.at(-1)!.message, /alice|secret\.txt|abcdefghijklmnop/u);

    for (const [command, input, expected] of [
      ["team", "x".repeat(4_097), /\/team arguments exceeds 4096 bytes/u],
      ["bench", "x".repeat(4_097), /\/bench arguments exceeds 4096 bytes/u],
      ["join", "x".repeat(100_001), /\/join arguments exceeds 100000 bytes/u],
      ["contract", "x".repeat(100_001), /\/contract definition exceeds 100000 bytes/u],
      ["crafter", "x".repeat(30_001), /\/crafter task exceeds 30000 bytes/u],
      ["scout", "x".repeat(30_001), /\/scout task exceeds 30000 bytes/u],
    ] as const) {
      await commands.get(command).handler(input, context);
      assert.match(notices.at(-1)!.message, expected);
      assert.doesNotMatch(notices.at(-1)!.message, /x{100}/u);
    }
    assert.equal(await commands.get("team").getArgumentCompletions("x".repeat(4_097)), null);
    assert.ok(notices.every(({ message }) => !message.includes("model boundary crossed")));
  } finally {
    PiOrchestrator.prototype.run = originalRun;
    if (previousHome === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousHome;
  }
});

test("Pi exposes a live safe team run, native usage/cost, propagated signal, and one shared status/widget", async () => {
  const root = await mkdtemp(join(tmpdir(), "harbor-pi-live-status-"));
  const project = join(root, "project");
  const commands = new Map<string, any>();
  const notices: string[] = [];
  const statuses: Array<{ key: string; value?: string }> = [];
  const widgets: Array<{ key: string; value?: string[] }> = [];
  const controller = new AbortController();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let receivedSignal: AbortSignal | undefined;
  piExtension({
    registerCommand: (name: string, options: any) => commands.set(name, options),
    registerTool: () => {},
    getThinkingLevel: () => "low",
  } as any);
  const originalRun = PiOrchestrator.prototype.run;
  try {
    PiOrchestrator.prototype.run = async function (_definition: any, signal?: AbortSignal) {
      receivedSignal = signal;
      const observer = (this as any).runObserver;
      observer.sessionStarted({ model: { provider: "effective", id: "model" }, thinking: "low" });
      observer.messageEnd({
        role: "assistant", responseId: "live-1", provider: "effective", model: "model",
        usage: {
          input: 10, output: 4, reasoning: 2, cacheRead: 3, cacheWrite: 1, totalTokens: 18,
          cost: { input: 0.00001, output: 0.00002, cacheRead: 0.000003, cacheWrite: 0.000004, total: 0.000037 },
        },
      });
      await gate;
      observer.state("cleaning");
      return "verified evidence";
    };
    const ui = {
      notify: (message: string) => notices.push(message),
      setStatus: (key: string, value?: string) => statuses.push({ key, value }),
      setWidget: (key: string, value?: string[]) => widgets.push({ key, value }),
    };
    const invocation = commands.get("crafter").handler("Review C:\\private\\customer.txt without exposing it", {
      cwd: project, model: { provider: "requested", id: "alias" }, signal: controller.signal, ui,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await commands.get("team").handler("crafter", { cwd: project, ui: { notify: (message: string) => notices.push(message) } });
    const live = notices.at(-1)!;
    assert.match(live, /crafter · fixed · working/u);
    assert.match(live, /Task: “Review \[path\] without exposing it”/u);
    assert.match(live, /Usage: in 10 · out 4 · reason 2 · cache r\/w 3\/1 · total 18/u);
    assert.match(live, /effective\/model \(observed\) · thinking setting low · model turns 1/u);
    assert.match(live,
      /Provider cost in \$0\.00001 · out \$0\.00002 · cache r\/w \$0\.000003\/\$0\.000004 · total \$0\.000037/u);
    assert.doesNotMatch(live, /private|customer\.txt/u);
    await commands.get("team").handler("", { cwd: project, model: { provider: "requested", id: "alias" }, ui: { notify: (message: string) => notices.push(message) } });
    const compact = notices.at(-1)!;
    assert.match(compact, /crafter · working[\s\S]*\/team run:pi-run-1[\s\S]*t1\/18tok\/\$0\.000037/u);
    assert.notEqual(receivedSignal, controller.signal, "root control should compose its own stop signal with the caller signal");
    assert.equal(receivedSignal?.aborted, false);
    release();
    await invocation;
    assert.match(notices.at(-1)!, /^verified evidence\nTEAM RUN/u);
    assert.match(notices.at(-1)!, /in 10 · out 4 · reason 2 · cache r\/w 3\/1 · total 18/u);
    assert.match(notices.at(-1)!, /cost in \$0\.00001 · out \$0\.00002 · cache r\/w \$0\.000003\/\$0\.000004 ·[\s\S]*total \$0\.000037/u);
    assert.ok(statuses.some(({ value }) => value?.includes("working")));
    assert.ok(statuses.some(({ value }) => value?.includes("cost $0.000037")));
    assert.ok(statuses.some(({ value }) => value?.includes("cleaning")));
    assert.deepEqual([...new Set(statuses.filter(({ value }) => value !== undefined).map(({ key }) => key))],
      ["agent-harbor:team"], "Pi created more than one live status key");
    assert.deepEqual([...new Set(widgets.filter(({ value }) => value !== undefined).map(({ key }) => key))],
      ["agent-harbor:team"], "Pi created more than one live widget key");
    assert.equal(statuses.at(-1)!.value, undefined);
    assert.equal(widgets.at(-1)!.value, undefined);
    assert.ok(widgets.some(({ value }) => value?.some((line) => line.includes("$0.000037 observed cost"))));
    assert.ok(widgets.some(({ value }) => value?.some((line) =>
      line.includes("Model: effective/model (observed) · thinking low"))));
    assert.doesNotMatch(JSON.stringify(widgets), /private|customer\.txt/u);
    assert.ok(statuses.flatMap(({ value }) => value?.split("\n") ?? []).every((line) => visibleTextWidth(line) <= 78));
    assert.ok(widgets.flatMap(({ value }) => value ?? []).every((line) => visibleTextWidth(line) <= 78));
    assert.ok(notices.flatMap((value) => value.split("\n")).every((line) => visibleTextWidth(line) <= 96));
  } finally { PiOrchestrator.prototype.run = originalRun; }
});

test("Pi aborts before model continuation when the admitted shared claim is deleted before working", async () => {
  const root = await mkdtemp(join(tmpdir(), "harbor-pi-phase-loss-"));
  const project = join(root, "project");
  const activityHome = join(root, "activity-home");
  await mkdir(project, { recursive: true });
  const priorPiHome = process.env.PI_CODING_AGENT_DIR;
  const priorActivityHome = process.env.AGENT_HARBOR_ACTIVITY_HOME;
  process.env.PI_CODING_AGENT_DIR = join(root, "pi-home");
  process.env.AGENT_HARBOR_ACTIVITY_HOME = activityHome;
  const commands = new Map<string, any>();
  const notices: string[] = [];
  piExtension({
    registerCommand: (name: string, options: any) => commands.set(name, options),
    registerTool: () => {},
    getThinkingLevel: () => "minimal",
  } as any);
  const originalRun = PiOrchestrator.prototype.run;
  let continuedAfterWorking = false;
  try {
    PiOrchestrator.prototype.run = async function (_definition: any, signal?: AbortSignal) {
      await unlink(await sharedActivityClaimFile(activityHome, "crafter"));
      (this as any).runObserver.sessionStarted();
      continuedAfterWorking = !signal?.aborted;
      signal?.throwIfAborted();
      return "must not continue";
    };
    await commands.get("crafter").handler("verify pre-send ownership", {
      cwd: project,
      ...authenticatedPiHostState(),
      ui: { notify: (message: string) => notices.push(message) },
    });
    assert.equal(continuedAfterWorking, false);
    assert.match(notices.at(-1) ?? "", /lost crafter's exact project-shared activity ownership before working/u);
    assert.deepEqual(readSharedAgentActivities(project), []);
  } finally {
    PiOrchestrator.prototype.run = originalRun;
    if (priorPiHome === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = priorPiHome;
    if (priorActivityHome === undefined) delete process.env.AGENT_HARBOR_ACTIVITY_HOME;
    else process.env.AGENT_HARBOR_ACTIVITY_HOME = priorActivityHome;
  }
});

test("Pi heartbeat aborts live work after exact shared ownership is replaced", async () => {
  const root = await mkdtemp(join(tmpdir(), "harbor-pi-heartbeat-loss-"));
  const project = join(root, "project");
  const activityHome = join(root, "activity-home");
  await mkdir(project, { recursive: true });
  const priorPiHome = process.env.PI_CODING_AGENT_DIR;
  const priorActivityHome = process.env.AGENT_HARBOR_ACTIVITY_HOME;
  process.env.PI_CODING_AGENT_DIR = join(root, "pi-home");
  process.env.AGENT_HARBOR_ACTIVITY_HOME = activityHome;
  const commands = new Map<string, any>();
  const notices: string[] = [];
  piExtension({
    registerCommand: (name: string, options: any) => commands.set(name, options),
    registerTool: () => {},
    getThinkingLevel: () => "minimal",
  } as any);
  const originalRun = PiOrchestrator.prototype.run;
  let competitorAdmitted = false;
  try {
    PiOrchestrator.prototype.run = async function (_definition: any, signal?: AbortSignal) {
      (this as any).runObserver.sessionStarted();
      assert.equal(readSharedAgentActivities(project)[0]?.phase, "working");
      await unlink(await sharedActivityClaimFile(activityHome, "crafter"));
      const competitor = claimSharedAgentActivity(
        project,
        "crafter",
        "direct",
        `copilot:${process.pid}:heartbeat-competitor`,
        "copilot",
      );
      competitorAdmitted = true;
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("timed out waiting for Pi heartbeat ownership loss")), 5_000);
          const aborted = (): void => { clearTimeout(timer); resolve(); };
          if (signal?.aborted) aborted();
          else signal?.addEventListener("abort", aborted, { once: true });
        });
      } finally {
        assert.equal(competitor.release(), true);
      }
      signal?.throwIfAborted();
      return "must not continue";
    };
    await commands.get("crafter").handler("verify heartbeat ownership", {
      cwd: project,
      ...authenticatedPiHostState(),
      ui: { notify: (message: string) => notices.push(message) },
    });
    assert.equal(competitorAdmitted, true);
    assert.match(notices.at(-1) ?? "", /lost crafter's exact project-shared activity ownership while its heartbeat was active/u);
    assert.deepEqual(readSharedAgentActivities(project), []);
  } finally {
    PiOrchestrator.prototype.run = originalRun;
    if (priorPiHome === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = priorPiHome;
    if (priorActivityHome === undefined) delete process.env.AGENT_HARBOR_ACTIVITY_HOME;
    else process.env.AGENT_HARBOR_ACTIVITY_HOME = priorActivityHome;
  }
});

test("Pi shared stop guidance preserves the exact owner runtime and PID", async () => {
  const root = await mkdtemp(join(tmpdir(), "harbor-pi-shared-stop-owner-"));
  const project = join(root, "project");
  const activityHome = join(root, "activity-home");
  await mkdir(project, { recursive: true });
  const priorPiHome = process.env.PI_CODING_AGENT_DIR;
  const priorActivityHome = process.env.AGENT_HARBOR_ACTIVITY_HOME;
  process.env.PI_CODING_AGENT_DIR = join(root, "pi-home");
  process.env.AGENT_HARBOR_ACTIVITY_HOME = activityHome;
  const commands = new Map<string, any>();
  const notices: string[] = [];
  let claim: ReturnType<typeof claimSharedAgentActivity> | undefined;
  try {
    piExtension({
      registerCommand: (name: string, options: any) => commands.set(name, options),
      registerTool: () => {},
      getThinkingLevel: () => "minimal",
    } as any);
    claim = claimSharedAgentActivity(project, "crafter", "direct", "private-copilot-run", "copilot");
    assert.equal(claim.setPhase("working"), true);
    await commands.get("team").handler("stop shared-crafter", {
      cwd: project,
      ...authenticatedPiHostState(),
      ui: { notify: (message: string) => notices.push(message) },
    });
    const output = notices.at(-1) ?? "";
    assert.match(output, /Agent Harbor stop · 0 model tokens/u);
    assert.match(output, new RegExp(`shared-crafter[\\s\\S]*owner copilot PID ${process.pid}`, "u"));
    assert.match(output, /Action: in each listed owning process run \/team stop all/u);
    assert.deepEqual(readSharedAgentActivities(project).map(({ agent, phase }) => ({ agent, phase })), [{
      agent: "crafter",
      phase: "working",
    }]);
  } finally {
    claim?.release();
    if (priorPiHome === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = priorPiHome;
    if (priorActivityHome === undefined) delete process.env.AGENT_HARBOR_ACTIVITY_HOME;
    else process.env.AGENT_HARBOR_ACTIVITY_HOME = priorActivityHome;
  }
});

test("Pi groups crowded shared stop routing without losing owner processes", async () => {
  const root = await mkdtemp(join(tmpdir(), "harbor-pi-bounded-shared-stop-"));
  const project = join(root, "project");
  const piHome = join(root, "pi-home");
  const activityHome = join(root, "activity-home");
  await mkdir(project, { recursive: true });
  const priorPiHome = process.env.PI_CODING_AGENT_DIR;
  const priorActivityHome = process.env.AGENT_HARBOR_ACTIVITY_HOME;
  process.env.PI_CODING_AGENT_DIR = piHome;
  process.env.AGENT_HARBOR_ACTIVITY_HOME = activityHome;
  const commands = new Map<string, any>();
  const notices: Array<{ message: string; level?: string }> = [];
  const claims: Array<ReturnType<typeof claimSharedAgentActivity> | undefined> = [];
  let legacyPath: string | undefined;
  const bounded = (output: string): void => {
    assert.ok(output.split("\n").length <= 30, `Pi /team output exceeded 30 lines:\n${output}`);
    assert.ok(output.split("\n").every((line) => visibleTextWidth(line) <= 96),
      `Pi /team output exceeded 96 columns:\n${output}`);
  };
  try {
    new Roster(harnessSpec("pi", piHome, project));
    piExtension({
      registerCommand: (name: string, options: any) => commands.set(name, options),
      registerTool: () => {},
      getThinkingLevel: () => "minimal",
    } as any);
    for (let index = 0; index < 32; index += 1) {
      const agent = `remote-owner-${index.toString().padStart(2, "0")}`;
      const claim = claimSharedAgentActivity(
        project,
        agent,
        "direct",
        `private-session-${index.toString().padStart(2, "0")}`,
        index % 2 ? "copilot" : "pi",
      );
      assert.equal(claim.setPhase("working"), true);
      claims.push(claim);
      const routePath = await sharedActivityClaimFile(activityHome, agent);
      const routed = JSON.parse(await readFile(routePath, "utf8")) as Record<string, unknown>;
      routed.processID = 10_000 + index;
      await writeFile(routePath, JSON.stringify(routed), { encoding: "utf8", mode: 0o600 });
    }
    legacyPath = await sharedActivityClaimFile(activityHome, "remote-owner-00");
    const legacy = JSON.parse(await readFile(legacyPath, "utf8")) as Record<string, unknown>;
    claims[0] = undefined;
    legacy.version = 1;
    delete legacy.ownerRuntime;
    await writeFile(legacyPath, JSON.stringify(legacy), { encoding: "utf8", mode: 0o600 });

    const context = {
      cwd: project,
      ...authenticatedPiHostState(),
      ui: { notify: (message: string, level?: string) => notices.push({ message, level }) },
    } as any;
    await commands.get("team").handler("stop all", context);
    const stop = notices.at(-1)!.message;
    bounded(stop);
    assert.match(stop, /Stop authority is in another process for 32 project-shared persistent run\(s\) across 32 owner\s+process route\(s\)/u);
    assert.match(stop,
      /owner runtime unverified \(legacy claim\) · PID 10000 ×1/u);
    assert.match(stop, /owner copilot PID 10001 ×1/u);
    assert.match(stop, /owner pi PID 10002 ×1/u);
    assert.match(stop, /owner copilot PID 10031 ×1/u,
      "the last distinct owner process route was omitted from the bounded output");
    const routedRuns = [...stop.matchAll(/×(\d+)/gu)]
      .reduce((total, match) => total + Number(match[1]), 0);
    assert.equal(routedRuns, 32, "grouped owner routes did not account for every external run");
    assert.doesNotMatch(stop, /owner routes? omitted/u,
      "stop all still discarded owner processes after grouping claims by route");
    assert.match(stop, /Filter external work with \/team owner:<runtime> or \/team pid:<pid>/u);
    assert.match(stop, /Action: in each listed owning process run \/team stop all/u);
    for (const claim of claims) {
      if (!claim) continue;
      assert.doesNotMatch(stop, new RegExp(claim.snapshot.claimToken, "u"));
      assert.doesNotMatch(stop, new RegExp(claim.snapshot.sessionID, "u"));
    }

    for (const filter of ["owner:copilot", "owner:pi", "pid:10031"]) {
      await commands.get("team").handler(filter, context);
      const filtered = notices.at(-1)!.message;
      bounded(filtered);
      assert.match(filtered, /shared-remote-owner-/u, `${filter} did not recover an external owner`);
    }

    const ownerCompletions = await commands.get("team").getArgumentCompletions("owner:");
    assert.ok(ownerCompletions.some(({ value }: { value: string }) => value === "owner:copilot"));
    assert.ok(ownerCompletions.some(({ value }: { value: string }) => value === "owner:pi"));
    const pidCompletions = await commands.get("team").getArgumentCompletions("pid:");
    assert.ok(pidCompletions.some(({ value }: { value: string }) => value === "pid:10031"));

    for (const selector of ["x".repeat(257), "é".repeat(129), "x".repeat(5_000)]) {
      await commands.get("team").handler(`stop ${selector}`, context);
      const error = notices.at(-1)!;
      assert.equal(error.level, "error");
      assert.match(error.message, /\/team stop selector exceeds 256 bytes/u);
      bounded(error.message);
    }
    await commands.get("team").handler(`stop ${"z".repeat(256)}`, context);
    assert.equal(notices.at(-1)!.level, "error");
    assert.match(notices.at(-1)!.message, /no active Harbor root matches/u);
    bounded(notices.at(-1)!.message);
  } finally {
    for (const claim of claims) claim?.release();
    if (legacyPath) await unlink(legacyPath).catch(() => {});
    if (priorPiHome === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = priorPiHome;
    if (priorActivityHome === undefined) delete process.env.AGENT_HARBOR_ACTIVITY_HOME;
    else process.env.AGENT_HARBOR_ACTIVITY_HOME = priorActivityHome;
  }
});

test("Pi keeps discovery warnings and hostile /team failures inside one 30x96 viewport", async () => {
  const root = await mkdtemp(join(tmpdir(), "harbor-pi-bounded-team-errors-"));
  const healthyHome = join(root, "healthy-home");
  const project = join(root, "project");
  const priorPiHome = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = healthyHome;
  const commands = new Map<string, any>();
  const notices: Array<{ message: string; level?: string }> = [];
  const bounded = (output: string): void => {
    assert.ok(output.split("\n").length <= 30, `Pi /team output exceeded 30 lines:\n${output}`);
    assert.ok(output.split("\n").every((line) => visibleTextWidth(line) <= 96),
      `Pi /team output exceeded 96 columns:\n${output}`);
  };
  try {
    piExtension({
      registerCommand: (name: string, options: any) => commands.set(name, options),
      registerTool: () => {},
      getThinkingLevel: () => "minimal",
    } as any);
    new Roster(harnessSpec("pi", healthyHome, project));
    const context = {
      cwd: project,
      ...authenticatedPiHostState(),
      ui: { notify: (message: string, level?: string) => notices.push({ message, level }) },
    } as any;

    const activeDirectory = join(project, ".pi", "agents");
    await mkdir(activeDirectory, { recursive: true });
    const junk = Array.from({ length: 201 }, (_, index) =>
      join(activeDirectory, `junk-${index.toString().padStart(3, "0")}.md`));
    await Promise.all(junk.map((path) => writeFile(path, "unmanaged", "utf8")));
    await commands.get("join").handler(JSON.stringify({
      name: "warning-reviewer",
      description: "Preserve a bounded warning",
      prompt: "Review only",
      tools: ["read"],
    }), context);
    assert.match(notices.at(-1)!.message,
      /Pi command metadata refresh failed after the roster change was committed/u);
    await Promise.all(junk.map((path) => unlink(path)));

    await commands.get("team").handler("", context);
    assert.match(notices.at(-1)!.message,
      /Warning: Pi command metadata refresh failed after the roster change was committed/u);
    bounded(notices.at(-1)!.message);
    await commands.get("team").handler("help", context);
    assert.match(notices.at(-1)!.message,
      /Warning: Pi command metadata refresh failed after the roster change was committed/u);
    bounded(notices.at(-1)!.message);

    const hostile = { ...context };
    Object.defineProperty(hostile, "model", {
      get: () => { throw new Error(`C:\\private\\customer\\secret.txt\n${"界".repeat(2_000)}`); },
    });
    await commands.get("team").handler("member:crafter", hostile);
    const failure = notices.at(-1)!;
    assert.equal(failure.level, "error");
    assert.doesNotMatch(failure.message, /private|customer|secret\.txt/u);
    bounded(failure.message);
  } finally {
    if (priorPiHome === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = priorPiHome;
  }
});

test("Pi Alt+H cancels an idle slash child without a caller signal and clears live UI", async () => {
  const commands = new Map<string, any>();
  const shortcuts = new Map<string, any>();
  const shutdownHandlers: any[] = [];
  const notices: Array<{ message: string; level?: string }> = [];
  const statuses: Array<string | undefined> = [];
  const widgets: Array<string[] | undefined> = [];
  piExtension({
    registerCommand: (name: string, options: any) => commands.set(name, options),
    registerTool: () => {},
    registerShortcut: (key: string, options: any) => shortcuts.set(key, options),
    on: (event: string, handler: any) => { if (event === "session_shutdown") shutdownHandlers.push(handler); },
    getThinkingLevel: () => "minimal",
  } as any);
  const originalRun = PiOrchestrator.prototype.run;
  let childSignal: AbortSignal | undefined;
  try {
    PiOrchestrator.prototype.run = async function (_definition: any, signal?: AbortSignal) {
      childSignal = signal;
      (this as any).runObserver.sessionStarted();
      return new Promise<string>((_resolve, reject) => signal!.addEventListener("abort", () => {
        (this as any).runObserver.state("cancelled");
        reject(new DOMException("cancelled", "AbortError"));
      }, { once: true }));
    };
    const invocation = commands.get("crafter").handler("cancel me", {
      cwd: process.cwd(), ...authenticatedPiHostState(), signal: undefined,
      ui: {
        notify: (message: string, level?: string) => notices.push({ message, level }),
        setStatus: (_key: string, value?: string) => statuses.push(value),
        setWidget: (_key: string, value?: string[]) => widgets.push(value),
      },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(childSignal?.aborted, false);
    shortcuts.get("alt+h").handler({
      cwd: process.cwd(), ui: { notify: (message: string, level?: string) => notices.push({ message, level }) },
    });
    await invocation;
    assert.equal(childSignal?.aborted, true);
    assert.match(notices[0].message, /^Agent Harbor stop · 0 model tokens/u);
    assert.equal(notices[0].level, "warning");
    assert.match(notices.at(-1)!.message, /Cancelled.*TEAM RUN .*crafter · cancelled .*\/team run:pi-run-1/su);
    assert.equal(notices.at(-1)!.level, "warning");
    assert.equal(statuses.at(-1), undefined);
    assert.equal(widgets.at(-1), undefined);
    assert.equal(shutdownHandlers.length, 1);
  } finally { PiOrchestrator.prototype.run = originalRun; }
});

test("Pi stop keeps abort-ignoring work cleaning until real settlement and blocks reuse", async () => {
  const root = await mkdtemp(join(tmpdir(), "harbor-pi-ignore-abort-"));
  const project = join(root, "project");
  const previousHome = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "home");
  const commands = new Map<string, any>();
  const notices: Array<{ message: string; level?: string }> = [];
  const statuses: Array<string | undefined> = [];
  const widgets: Array<string[] | undefined> = [];
  piExtension({
    registerCommand: (name: string, options: any) => commands.set(name, options),
    registerTool: () => {},
    getThinkingLevel: () => "minimal",
  } as any);
  const originalRun = PiOrchestrator.prototype.run;
  let starts = 0;
  let ignoredSignal: AbortSignal | undefined;
  const releases: Array<() => void> = [];
  try {
    PiOrchestrator.prototype.run = async function (_definition: any, signal?: AbortSignal) {
      starts += 1;
      ignoredSignal = signal;
      (this as any).runObserver.sessionStarted();
      return new Promise<string>((resolve) => releases.push(() => resolve("late provider settlement")));
    };
    const context = {
      cwd: project, ...authenticatedPiHostState(), signal: undefined,
      ui: {
        notify: (message: string, level?: string) => notices.push({ message, level }),
        setStatus: (_key: string, value?: string) => statuses.push(value),
        setWidget: (_key: string, value?: string[]) => widgets.push(value),
      },
    } as any;
    const awaitBounded = async (promise: Promise<unknown>): Promise<void> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          promise,
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error("Pi command remained hung after stop")), 1_000);
            timer.unref?.();
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    };

    const first = commands.get("crafter").handler("ignore the first abort", context);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await commands.get("team").handler("stop all", context);
    await awaitBounded(first);
    assert.equal(ignoredSignal?.aborted, true);
    assert.match(notices.at(-1)!.message,
      /Cancellation requested; provider cleanup is still settling[\s\S]*crafter · cleaning .*\/team run:pi-run-1/u);
    assert.ok(statuses.some((value) => value?.includes("cleaning")), "stop never exposed the bounded cleanup transition");
    assert.match(statuses.at(-1)!, /crafter cleaning/u);
    assert.ok(widgets.at(-1)?.some((line) => line.includes("crafter · cleaning") && line.includes("/team run:pi-run-1")));
    await commands.get("team").handler("", context);
    assert.match(notices.at(-1)!.message,
      /1 active[\s\S]*crafter · cleaning[\s\S]*\/team run:pi-run-1[\s\S]*crafter · fixed · cleaning/u);

    await commands.get("crafter").handler("capacity must stay blocked", context);
    assert.equal(starts, 1, "cleaning abort-ignoring work released specialist capacity early");
    assert.match(notices.at(-1)!.message, /already working in pi-run-1/u);
    await commands.get("team").handler("stop all", context);
    assert.match(notices.at(-1)!.message, /Already stopping 1 root run\(s\): pi-run-1.*waiting for provider cleanup/isu);

    releases[0]();
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    assert.equal(statuses.at(-1), undefined);
    assert.equal(widgets.at(-1), undefined);
    const firstLateSettlements = notices.filter(({ message }) =>
      /Provider cleanup settled · pi-run-1 is cancelled/u.test(message));
    assert.equal(firstLateSettlements.length, 1, "late provider settlement was not reported exactly once");
    assert.equal(firstLateSettlements[0].level, "warning");
    await commands.get("team").handler("", context);
    assert.match(notices.at(-1)!.message,
      /0 active[\s\S]*LAST MISSION[\s\S]*crafter · cancelled[\s\S]*\/team run:pi-run-1/u);

    const second = commands.get("crafter").handler("capacity is reusable after settlement", context);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(starts, 2, "settled cancellation did not release specialist capacity");
    await commands.get("team").handler("stop all", context);
    await awaitBounded(second);
    releases[1]();
    await new Promise<void>((resolve) => setImmediate(resolve));

    const alreadyCancelled = new AbortController();
    alreadyCancelled.abort(new DOMException("cancelled before invocation", "AbortError"));
    await commands.get("crafter").handler("must not create a child", { ...context, signal: alreadyCancelled.signal });
    assert.equal(starts, 2, "a pre-aborted command entered the Pi orchestrator");

    const personalDefinition = JSON.stringify({
      name: "steady-reviewer", description: "Review safely", prompt: "Review only", tools: ["read"],
    });
    await commands.get("join").handler(personalDefinition, context);
    const personal = commands.get("steady-reviewer").handler("stay active during retire", context);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await commands.get("retire").handler("steady-reviewer", context);
    const personalRunId = /working in (pi-run-\d+)/u.exec(notices.at(-1)!.message)?.[1];
    assert.ok(personalRunId);
    assert.match(notices.at(-1)!.message,
      new RegExp(`cannot retire steady-reviewer while it is working in ${personalRunId}`, "u"));
    assert.match(notices.at(-1)!.message,
      new RegExp(`use /team stop ${personalRunId}, then wait for cleanup to settle`, "u"));
    await access(join(project, ".pi", "agents", "steady-reviewer.md"));
    await commands.get("team").handler(`stop ${personalRunId}`, context);
    await awaitBounded(personal);
    releases[2]();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await commands.get("retire").handler("steady-reviewer", context);
    assert.match(notices.at(-1)!.message, /steady-reviewer unregistered and deactivated here/u);
    await assert.rejects(access(join(project, ".pi", "agents", "steady-reviewer.md")));

    // A disposable contractor may intentionally share a descriptive name; it
    // does not own the persistent roster entry and therefore cannot block its retirement.
    await commands.get("join").handler(personalDefinition, context);
    const contractor = commands.get("contract").handler(JSON.stringify({
      name: "steady-reviewer", description: "Disposable review", prompt: "Review once",
      tools: ["read"], task: "hold contractor open",
    }), context);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await commands.get("retire").handler("steady-reviewer", context);
    assert.match(notices.at(-1)!.message, /steady-reviewer unregistered and deactivated here/u);
    await commands.get("team").handler("stop all", context);
    await awaitBounded(contractor);
    releases[3]();
    await new Promise<void>((resolve) => setImmediate(resolve));
  } finally {
    PiOrchestrator.prototype.run = originalRun;
    if (previousHome === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousHome;
  }
});

test("Pi stop all cancels abortable roots even when another root is already cleaning", async () => {
  const root = await mkdtemp(join(tmpdir(), "harbor-pi-mixed-stop-"));
  const project = join(root, "project");
  const previousHome = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "home");
  const commands = new Map<string, any>();
  const notices: Array<{ message: string; level?: string }> = [];
  piExtension({
    registerCommand: (name: string, options: any) => commands.set(name, options),
    registerTool: () => {},
    getThinkingLevel: () => "minimal",
  } as any);
  const originalRun = PiOrchestrator.prototype.run;
  const signals: AbortSignal[] = [];
  const releases: Array<() => void> = [];
  try {
    PiOrchestrator.prototype.run = async function (_definition: any, signal?: AbortSignal) {
      signals.push(signal!);
      (this as any).runObserver.sessionStarted();
      return new Promise<string>((resolve) => releases.push(() => resolve("provider settled")));
    };
    const context = {
      cwd: project, ...authenticatedPiHostState(), signal: undefined,
      ui: {
        notify: (message: string, level?: string) => notices.push({ message, level }),
        setStatus: () => {}, setWidget: () => {},
      },
    } as any;
    const crafter = commands.get("crafter").handler("first root", context);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await commands.get("team").handler("stop pi-run-1", context);
    await crafter;
    assert.equal(signals[0]?.aborted, true);

    const lead = commands.get("team-lead").handler("second root", context);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(signals[1]?.aborted, false);
    await commands.get("team").handler("stop all", context);
    const mixedStop = notices.at(-1)!.message;
    assert.match(mixedStop, /Stopping 1 Agent Harbor root run\(s\): pi-run-2/u);
    assert.match(mixedStop, /Already stopping 1 root run\(s\): pi-run-1/u);
    await lead;
    assert.equal(signals[1]?.aborted, true, "mixed stop skipped the still-abortable root");
    releases.forEach((release) => release());
    await new Promise<void>((resolve) => setImmediate(resolve));
  } finally {
    PiOrchestrator.prototype.run = originalRun;
    if (previousHome === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousHome;
  }
});

test("Pi extension invokes every fixed and activated agent and equips the team lead for named delegation", async () => {
  const root = await mkdtemp(join(tmpdir(), "harbor-pi-player-"));
  const project = join(root, "project");
  const roster = new Roster(harnessSpec("pi", join(root, "home"), project));
  await roster.join({ name: "reviewer", description: "Review", prompt: "Review only", tools: ["read", "search"] });
  await roster.join({ name: "verbose-reviewer", description: "x".repeat(500), prompt: "Review only", tools: ["read"] });
  await roster.bench("on all", bundledPlayers);
  const previous = process.cwd(); const commands = new Map<string, any>();
  const hostModel = { provider: "openai-codex", id: "gpt-5.3-codex-spark" };
  try {
    process.chdir(project);
    piExtension({
      registerCommand: (name: string, options: any) => commands.set(name, options),
      registerTool: () => {},
      getThinkingLevel: () => "minimal",
    } as any);
  } finally { process.chdir(previous); }
  assert.ok(commands.has("reviewer"));
  assert.ok([...rolePlayers.keys(), ...bundledPlayers.keys()].every((name) => commands.has(name)));
  const received: Array<{
    definition: any;
    additionalTools: string[];
    customTools: any[];
    sessionOptions: any;
    hostMarker: unknown;
    rosterResult?: any;
  }> = []; const notices: string[] = [];
  const originalRun = PiOrchestrator.prototype.run;
  try {
    PiOrchestrator.prototype.run = async function (definition: any) {
      const sdk = await (this as any).loadSdk();
      const entry: (typeof received)[number] = {
        definition,
        additionalTools: [...(this as any).additionalTools],
        customTools: [...(this as any).customTools],
        sessionOptions: { ...(this as any).sessionOptions },
        hostMarker: sdk.HARBOR_PI_SDK_HOST_TEST_MARKER,
      };
      received.push(entry);
      if (definition.name === "team-lead") {
        entry.rosterResult = await entry.customTools[1].execute(
          "roster-build", { query: "construction" }, undefined, undefined, { cwd: project },
        );
      }
      return `completed:${definition.name}`;
    };
    await commands.get("reviewer").handler("inspect src", { cwd: project, model: hostModel, ui: { notify: (message: string) => notices.push(message) } });
    for (const name of [...rolePlayers.keys(), ...bundledPlayers.keys()]) {
      await commands.get(name).handler(`task:${name}`, { cwd: project, model: hostModel, ui: { notify: (message: string) => notices.push(message) } });
    }
  } finally { PiOrchestrator.prototype.run = originalRun; }
  assert.equal(received[0].definition.name, "reviewer");
  assert.deepEqual(received[0].definition.tools, ["read", "search"]);
  assert.equal(received[0].definition.task, "inspect src");
  assert.deepEqual(received[0].additionalTools, []);
  assert.deepEqual(received.slice(1).map((entry) => entry.definition.name), [...rolePlayers.keys(), ...bundledPlayers.keys()]);
  const lead = received.find((entry) => entry.definition.name === "team-lead")!;
  assert.deepEqual(lead.additionalTools, ["harbor_delegate", "harbor_team_roster"]);
  assert.deepEqual(lead.customTools.map((tool) => tool.name), ["harbor_delegate", "harbor_team_roster"]);
  assert.equal(lead.customTools[0].executionMode, "sequential");
  assert.ok([...lead.customTools[0].description].length < 2_500, "lead roster preview was not compact enough");
  assert.doesNotMatch(lead.customTools[0].description, /x{500}/u, "personal description was not truncated");
  assert.match(lead.customTools[0].description, /harbor_team_roster with query "" for the full invocation snapshot/u);
  const rosterResult = lead.rosterResult;
  assert.match(rosterResult.content[0].text, /"id":"build".*"tools":\["read","edit"\].*"skills":\[\]/u);
  assert.equal(rosterResult.details.childCreated, false);
  for (const entry of received.filter((item) => item.definition.name !== "team-lead")) {
    assert.deepEqual(entry.additionalTools, []);
    assert.deepEqual(entry.customTools, []);
  }
  assert.ok(received.every((entry) => entry.hostMarker === "host-sdk-static-import"));
  assert.ok(received.every((entry) => entry.sessionOptions.model === hostModel));
  assert.ok(received.every((entry) => entry.sessionOptions.thinkingLevel === "minimal"));
  assert.deepEqual(
    notices.map((notice) => notice.split("\n", 1)[0]),
    ["completed:reviewer", ...[...rolePlayers.keys(), ...bundledPlayers.keys()].map((name) => `completed:${name}`)],
  );
  assert.ok(notices.every((notice) => notice.includes("TEAM RUN · native Pi telemetry · bounded summary")));
});

test("Pi team lead delegates sequentially to different enabled agents with bounds and preflight", async () => {
  const root = await mkdtemp(join(tmpdir(), "harbor-pi-delegate-"));
  const project = join(root, "project");
  const roster = new Roster(harnessSpec("pi", join(root, "home"), project));
  const previousActivityHome = process.env.AGENT_HARBOR_ACTIVITY_HOME;
  process.env.AGENT_HARBOR_ACTIVITY_HOME = join(root, "activity-home");
  await roster.bench("on all", bundledPlayers);
  const previous = process.cwd(); const commands = new Map<string, any>();
  const hostModel = { provider: "openai-codex", id: "gpt-5.3-codex-spark" };
  try {
    process.chdir(project);
    piExtension({
      registerCommand: (name: string, options: any) => commands.set(name, options),
      registerTool: () => {},
      getThinkingLevel: () => "minimal",
    } as any);
  } finally { process.chdir(previous); }

  const calls: any[] = []; const delegates: any[] = []; const notices: string[] = []; const runtimes: any[] = [];
  const context = { cwd: project, model: hostModel };
  let leadInvocation = 0;
  const originalRun = PiOrchestrator.prototype.run;
  try {
    PiOrchestrator.prototype.run = async function (definition: any) {
      calls.push(definition);
      assert.ok(readSharedAgentActivities(project).some(({ agent }) => agent === definition.name),
        `${definition.name} did not own a project-shared claim before its Pi model child ran`);
      const sdk = await (this as any).loadSdk();
      runtimes.push({ sessionOptions: { ...(this as any).sessionOptions }, hostMarker: sdk.HARBOR_PI_SDK_HOST_TEST_MARKER });
      if (definition.name === "team-lead") {
        const delegate = (this as any).customTools[0];
        delegates.push(delegate);
        assert.equal(delegate.executionMode, "sequential");
        assert.deepEqual(
          new Set(delegate.parameters.properties.agent.enum),
          new Set(["crafter", ...bundledPlayers.keys()]),
          "Pi delegate schema did not enumerate the exact enabled snapshot",
        );
        assert.equal(delegate.parameters.properties.agent.pattern,
          (harborStaticCustomToolSpecs[harborCustomToolNames.delegate].parameters as any).properties.agent.pattern);
        assert.equal(
          (harborStaticCustomToolSpecs[harborCustomToolNames.delegate].parameters as any).properties.agent.enum,
          undefined,
          "invocation-specific enum mutated the shared static schema",
        );
        if (leadInvocation === 0) {
          let priorEvidence: string | undefined;
          for (const [index, step] of defaultCycle.steps.entries()) {
            const result: any = await delegate.execute(
              `default-${index + 1}`,
              { agent: step.agent, task: datasetTask(defaultCycle, index, priorEvidence) },
              new AbortController().signal, undefined, context,
            );
            priorEvidence = result.content[0].text;
            assert.equal(priorEvidence, `evidence:${step.agent}`);
          }
        } else {
          let priorEvidence: string | undefined;
          for (const [index, step] of fullCycle.steps.slice(0, 2).entries()) {
            const result: any = await delegate.execute(
              `call-${index + 1}`,
              { agent: step.agent, task: datasetTask(fullCycle, index, priorEvidence) },
              new AbortController().signal, undefined, context,
            );
            priorEvidence = result.content[0].text;
            assert.equal(priorEvidence, `evidence:${step.agent}`);
          }
          await assert.rejects(() => delegate.execute(
            "call-duplicate",
            { agent: fullCycle.steps[0].agent, task: "duplicate stage" },
            new AbortController().signal, undefined, context,
          ), /already delegated/);
          assert.deepEqual(
            calls.slice(0, 2 + defaultCycle.steps.length + 2).map((call) => call.name),
            ["team-lead", ...defaultCycle.steps.map((step) => step.agent), "team-lead", ...fullCycle.steps.slice(0, 2).map((step) => step.agent)],
          );
          assert.match(calls.at(-1).task, new RegExp(`evidence:${fullCycle.steps[0].agent}`));

          const beforeInvalid = calls.length;
          await assert.rejects(() => delegate.execute("bad", { agent: "team-lead", task: "recurse" }, new AbortController().signal, undefined, context), /recursive/);
          await assert.rejects(() => delegate.execute("bad", { agent: "unknown", task: "work" }, new AbortController().signal, undefined, context), /not in this team-lead roster snapshot/);
          await assert.rejects(() => delegate.execute("bad", { agent: "manage", task: "   " }, new AbortController().signal, undefined, context), /non-empty/);
          assert.equal(calls.length, beforeInvalid, "invalid delegation must not create a child");

          for (const [index, step] of fullCycle.steps.slice(2).entries()) {
            const result: any = await delegate.execute(
              `call-${step.agent}`,
              { agent: step.agent, task: datasetTask(fullCycle, index + 2, priorEvidence) },
              new AbortController().signal, undefined, context,
            );
            priorEvidence = result.content[0].text;
          }
          await assert.rejects(() => delegate.execute(
            "call-7", { agent: fullCycle.steps[0].agent, task: "too many" },
            new AbortController().signal, undefined, context,
          ), /limit reached/);
        }
        leadInvocation += 1;
      }
      return `evidence:${definition.name}`;
    };
    await commands.get("team-lead").handler("use the fixed specialists", { cwd: project, model: hostModel, ui: { notify: (message: string) => notices.push(message) } });
    await commands.get("team-lead").handler("complete one SDLC mission", { cwd: project, model: hostModel, ui: { notify: (message: string) => notices.push(message) } });
    assert.deepEqual(
      calls.map((call) => call.name),
      ["team-lead", ...defaultCycle.steps.map((step) => step.agent), "team-lead", ...fullCycle.steps.map((step) => step.agent)],
    );
    assert.ok(runtimes.every((runtime) => runtime.hostMarker === "host-sdk-static-import"));
    assert.ok(runtimes.every((runtime) => runtime.sessionOptions.model === hostModel));
    assert.ok(runtimes.every((runtime) => runtime.sessionOptions.thinkingLevel === "minimal"));
  } finally {
    PiOrchestrator.prototype.run = originalRun;
    assert.deepEqual(readSharedAgentActivities(project), [], "Pi persistent claims survived terminal settlement");
    if (previousActivityHome === undefined) delete process.env.AGENT_HARBOR_ACTIVITY_HOME;
    else process.env.AGENT_HARBOR_ACTIVITY_HOME = previousActivityHome;
  }
  assert.deepEqual(notices.map((notice) => notice.split("\n", 1)[0]), ["evidence:team-lead", "evidence:team-lead"]);
  assert.ok(notices.every((notice) => notice.includes("Mission usage:")));
});

test("Pi team lead resolves each specialist's configured model with auth before consuming delegation", async () => {
  const root = await mkdtemp(join(tmpdir(), "harbor-pi-delegate-model-"));
  const home = join(root, "home");
  const project = join(root, "project");
  const previousHome = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = home;
  const roster = new Roster(harnessSpec("pi", home, project));
  await roster.join({
    name: "model-worker", description: "Uses a dedicated route", prompt: "Work only on the delegated task.",
    tools: ["read"], model: "router/special",
  });
  const previous = process.cwd();
  const commands = new Map<string, any>();
  try {
    process.chdir(project);
    piExtension({
      registerCommand: (name: string, options: any) => commands.set(name, options),
      registerTool: () => {},
      getThinkingLevel: () => "minimal",
    } as any);
  } finally { process.chdir(previous); }

  const hostModel = { provider: "host", id: "default" };
  const configuredModel = { provider: "router", id: "special" };
  const notices: string[] = [];
  const children: Array<{ definition: any; model: any }> = [];
  let delegate: any;
  let authenticatedResult: any;
  const unavailable = {
    cwd: project, model: hostModel,
    modelRegistry: { find: () => undefined, hasConfiguredAuth: () => true },
  };
  const unauthenticated = {
    cwd: project, model: hostModel,
    modelRegistry: { find: () => configuredModel, hasConfiguredAuth: () => false },
  };
  const authenticated = {
    cwd: project, model: hostModel,
    modelRegistry: { find: () => configuredModel, hasConfiguredAuth: () => true },
  };
  const originalRun = PiOrchestrator.prototype.run;
  try {
    PiOrchestrator.prototype.run = async function (definition: any) {
      (this as any).runObserver.sessionStarted({ model: (this as any).sessionOptions.model });
      if (definition.name === "team-lead") {
        delegate = (this as any).customTools[0];
        await assert.rejects(() => delegate.execute(
          "unavailable", { agent: "model-worker", task: "first attempt" },
          new AbortController().signal, undefined, unavailable,
        ), /configured Pi model is unavailable: router\/special/u);
        assert.equal(children.length, 0, "unavailable model created a specialist child");

        await assert.rejects(() => delegate.execute(
          "unauthenticated", { agent: "model-worker", task: "second attempt" },
          new AbortController().signal, undefined, unauthenticated,
        ), /configured Pi model has no available authentication: router\/special/u);
        assert.equal(children.length, 0, "unauthenticated model created a specialist child");

        authenticatedResult = await delegate.execute(
          "authenticated", { agent: "model-worker", task: "third attempt" },
          new AbortController().signal, undefined, authenticated,
        );
        await assert.rejects(
          () => delegate.execute(
            "private-provider", { agent: "crafter", task: "trigger private provider failure" },
            new AbortController().signal, undefined, authenticated,
          ),
          (error: any) => {
            assert.match(error.message, /provider failed at \[path\] with \[redacted\]/u);
            assert.doesNotMatch(`${error.name}\n${error.message}\n${String(error.cause)}`,
              /alice|private\.txt|abcdefghijklmnop/u);
            assert.equal(error.cause, undefined);
            return true;
          },
        );
      } else {
        if (definition.task === "trigger private provider failure") {
          throw new Error("provider failed at C:/Users/alice/private.txt with Bearer abcdefghijklmnop");
        }
        children.push({ definition, model: (this as any).sessionOptions.model });
      }
      return `evidence:${definition.name}`;
    };
    await commands.get("team-lead").handler("delegate by configured route", {
      cwd: project, model: hostModel, ui: { notify: (message: string) => notices.push(message) },
    });
    assert.ok(delegate);
    assert.equal(authenticatedResult.content[0].text, "evidence:model-worker");
    assert.equal(children.length, 1, "failed preflights consumed the one-agent delegation slot");
    assert.equal(children[0].model, configuredModel);
    await commands.get("team").handler("member:model-worker", {
      cwd: project, ui: { notify: (message: string) => notices.push(message) },
    });
    assert.match(notices.at(-1)!, /RETAINED HISTORY · MATCHING MEMBERS/u);
    assert.match(notices.at(-1)!, /model-worker · run pi-run-2[\s\S]*router\/special \(configured\)/u);
  } finally {
    PiOrchestrator.prototype.run = originalRun;
    if (previousHome === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousHome;
  }
});

test("Pi team lead rejects more than 32 enabled specialists before creating a ghost run", async () => {
  const root = await mkdtemp(join(tmpdir(), "harbor-pi-lead-cap-"));
  const home = join(root, "home");
  const project = join(root, "project");
  const previousHome = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = home;
  const roster = new Roster(harnessSpec("pi", home, project));
  try {
    for (let index = 0; index < 50; index += 1) {
      await roster.join({ name: `member-${index}`, description: `Member ${index}`, prompt: "Work", tools: ["read"] });
    }
    await roster.bench("on all", bundledPlayers);
    const commands = new Map<string, any>();
    const notices: Array<{ message: string; level?: string }> = [];
    piExtension({
      registerCommand: (name: string, options: any) => commands.set(name, options),
      registerTool: () => {},
      getThinkingLevel: () => "low",
    } as any);
    const context = { cwd: project, ...authenticatedPiHostState(), ui: { notify: (message: string, level?: string) => notices.push({ message, level }) } } as any;
    await commands.get("team-lead").handler("coordinate", context);
    assert.match(notices.at(-1)!.message, /at most 32 enabled specialists; found 57/u);
    assert.match(notices.at(-1)!.message, /Preflight stopped · no model was called · 0 model tokens/u);
    assert.doesNotMatch(notices.at(-1)!.message, /TEAM RUN/u);
    await commands.get("team").handler("", context);
    assert.match(notices.at(-1)!.message, /Enabled specialist roster limit exceeded: 57\/32/u);
    assert.match(notices.at(-1)!.message, /Reduce enabled roster:/u);
    assert.match(notices.at(-1)!.message,
      /No active persistent work; disposable contractors are visible only in their owning Pi process/u);
    const teamCompletions = await commands.get("team").getArgumentCompletions("");
    assert.equal(teamCompletions.length, 50, "Pi team completions exceeded or missed their fixed cap");
    const statusCompletions = await commands.get("team").getArgumentCompletions("status:");
    assert.deepEqual(statusCompletions.map(({ value }: { value: string }) => value),
      ["status:bench", "status:idle", "status:ready", "status:working"]);
    const kindCompletions = await commands.get("team").getArgumentCompletions("kind:p");
    assert.equal(kindCompletions[0]?.value, "kind:personal");
    assert.equal((await commands.get("team").getArgumentCompletions("model:"))[0]?.value, "model:");
    assert.equal((await commands.get("team").getArgumentCompletions("task:"))[0]?.value, "task:");
    const benchCompletions = await commands.get("bench").getArgumentCompletions("");
    assert.equal(benchCompletions.length, 50, "Pi bench completions exceeded or missed their fixed cap");
  } finally {
    if (previousHome === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousHome;
  }
});

test("Pi blocks a new team-lead at 31 shared claims before model work and reports the headroom", async () => {
  const root = await mkdtemp(join(tmpdir(), "harbor-pi-lead-shared-headroom-"));
  const home = join(root, "home");
  const project = join(root, "project");
  const activityHome = join(root, "activity-home");
  const previousPiHome = process.env.PI_CODING_AGENT_DIR;
  const previousActivityHome = process.env.AGENT_HARBOR_ACTIVITY_HOME;
  process.env.PI_CODING_AGENT_DIR = home;
  process.env.AGENT_HARBOR_ACTIVITY_HOME = activityHome;
  const claims: ReturnType<typeof claimSharedAgentActivity>[] = [];
  const originalRun = PiOrchestrator.prototype.run;
  let modelCalls = 0;
  try {
    new Roster(harnessSpec("pi", home, project));
    for (let index = 0; index < 31; index += 1) {
      claims.push(claimSharedAgentActivity(
        project, `busy-${String(index).padStart(2, "0")}`, "direct", `copilot-${index}`, "copilot",
      ));
    }
    const commands = new Map<string, any>();
    const notices: Array<{ message: string; level?: string }> = [];
    piExtension({
      registerCommand: (name: string, options: any) => commands.set(name, options),
      registerTool: () => {},
      getThinkingLevel: () => "low",
    } as any);
    PiOrchestrator.prototype.run = async function () { modelCalls += 1; return "unexpected"; };
    const context = {
      cwd: project, ...authenticatedPiHostState(),
      ui: { notify: (message: string, level?: string) => notices.push({ message, level }) },
    } as any;
    await commands.get("team-lead").handler("coordinate", context);
    assert.equal(modelCalls, 0);
    assert.match(notices.at(-1)!.message, /team-lead needs two project-shared slots.*31\/32/u);
    assert.match(notices.at(-1)!.message, /0 model tokens/u);
    await commands.get("team").handler("", context);
    assert.match(notices.at(-1)!.message, /Delegable now: none \(team-lead start needs two project-shared slots; capacity is 31\/32\)/u);
    assert.doesNotMatch(notices.at(-1)!.message, /Delegable now: crafter/u);
  } finally {
    PiOrchestrator.prototype.run = originalRun;
    for (const claim of claims.reverse()) assert.equal(claim.release(), true);
    if (previousPiHome === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousPiHome;
    if (previousActivityHome === undefined) delete process.env.AGENT_HARBOR_ACTIVITY_HOME;
    else process.env.AGENT_HARBOR_ACTIVITY_HOME = previousActivityHome;
  }
});

test("Pi validates the exact 16 KiB model-facing roster snapshot before starting lead or scout", async () => {
  const root = await mkdtemp(join(tmpdir(), "harbor-pi-roster-bytes-"));
  const home = join(root, "home");
  const project = join(root, "project");
  const activityHome = join(root, "activity-home");
  const previousPiHome = process.env.PI_CODING_AGENT_DIR;
  const previousActivityHome = process.env.AGENT_HARBOR_ACTIVITY_HOME;
  process.env.PI_CODING_AGENT_DIR = home;
  process.env.AGENT_HARBOR_ACTIVITY_HOME = activityHome;
  const originalRun = PiOrchestrator.prototype.run;
  let modelCalls = 0;
  try {
    const roster = new Roster(harnessSpec("pi", home, project));
    for (let index = 0; index < 31; index += 1) {
      await roster.join({
        name: `verbose-${String(index).padStart(2, "0")}`,
        description: `Role ${index} ${"🙂".repeat(220)}`,
        prompt: "Work only on the assigned task.",
        tools: ["read", "search", "edit", "execute"],
        skills: Array.from({ length: 3 }, (_, skillIndex) => ({
          kind: "repo" as const,
          name: `skill-${String(skillIndex).padStart(2, "0")}-${"s".repeat(36)}`,
          path: `skills/skill-${String(skillIndex).padStart(2, "0")}/SKILL.md`,
        })),
        model: `router/${"m".repeat(110 - String(index).length)}${index}`,
      });
    }
    const commands = new Map<string, any>();
    const notices: Array<{ message: string; level?: string }> = [];
    piExtension({
      registerCommand: (name: string, options: any) => commands.set(name, options),
      registerTool: () => {},
      getThinkingLevel: () => "low",
    } as any);
    PiOrchestrator.prototype.run = async function () { modelCalls += 1; return "unexpected"; };
    const context = {
      cwd: project, ...authenticatedPiHostState(),
      ui: { notify: (message: string, level?: string) => notices.push({ message, level }) },
    } as any;
    for (const command of ["team-lead", "scout"]) {
      await commands.get(command).handler("inspect roster", context);
      assert.match(notices.at(-1)!.message, /Complete roster unavailable within the 16384-byte model-facing limit/u);
      assert.match(notices.at(-1)!.message, /0 model tokens/u);
    }
    assert.equal(modelCalls, 0);
    assert.deepEqual(readSharedAgentActivities(project), []);
  } finally {
    PiOrchestrator.prototype.run = originalRun;
    if (previousPiHome === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousPiHome;
    if (previousActivityHome === undefined) delete process.env.AGENT_HARBOR_ACTIVITY_HOME;
    else process.env.AGENT_HARBOR_ACTIVITY_HOME = previousActivityHome;
  }
});

test("Pi team-lead preparation failure creates no ghost root", async () => {
  const root = await mkdtemp(join(tmpdir(), "harbor-pi-lead-preparation-failure-"));
  const project = join(root, "project");
  const active = join(project, ".pi", "agents");
  await mkdir(active, { recursive: true });
  await Promise.all(Array.from({ length: 201 }, (_, index) =>
    writeFile(join(active, `noise-${index.toString().padStart(3, "0")}.md`), "unmanaged", "utf8")));
  const commands = new Map<string, any>();
  const notices: Array<{ message: string; level?: string }> = [];
  let modelCalls = 0;
  const originalRun = PiOrchestrator.prototype.run;
  try {
    PiOrchestrator.prototype.run = async () => { modelCalls += 1; return "must not run"; };
    piExtension({
      registerCommand: (name: string, options: any) => commands.set(name, options),
      registerTool: () => {},
      getThinkingLevel: () => "low",
    } as any);
    const context = { cwd: project, ...authenticatedPiHostState(), ui: { notify: (message: string, level?: string) => notices.push({ message, level }) } } as any;
    await commands.get("team-lead").handler("coordinate", context);
    assert.match(notices.at(-1)!.message, /too many active profiles: 201/u);
    assert.match(notices.at(-1)!.message, /Preflight stopped · no model was called · 0 model tokens/u);
    assert.doesNotMatch(notices.at(-1)!.message, /TEAM RUN/u);
    assert.equal(modelCalls, 0);
    await commands.get("team").handler("", context);
    assert.match(notices.at(-1)!.message,
      /No active persistent work; disposable contractors are visible only in their owning Pi process/u);
  } finally { PiOrchestrator.prototype.run = originalRun; }
});

test("Pi blocks direct double-booking, caps concurrent roots at 32, and stops accepted work", async () => {
  const root = await mkdtemp(join(tmpdir(), "harbor-pi-concurrent-roots-"));
  const project = join(root, "project");
  const commands = new Map<string, any>();
  const notices: Array<{ message: string; level?: string }> = [];
  const liveStatuses: Array<{ key: string; value?: string }> = [];
  const liveWidgets: Array<{ key: string; value?: string[] }> = [];
  piExtension({
    registerCommand: (name: string, options: any) => commands.set(name, options),
    registerTool: () => {},
    getThinkingLevel: () => "minimal",
  } as any);
  const originalRun = PiOrchestrator.prototype.run;
  try {
    PiOrchestrator.prototype.run = async function (_definition: any, signal?: AbortSignal) {
      (this as any).runObserver.sessionStarted();
      return new Promise<string>((_resolve, reject) => signal!.addEventListener("abort", () => {
        (this as any).runObserver.state("cancelled");
        reject(new DOMException("stopped", "AbortError"));
      }, { once: true }));
    };
    const context = {
      cwd: project, ...authenticatedPiHostState(), signal: undefined,
      ui: {
        notify: (message: string, level?: string) => notices.push({ message, level }),
        setStatus: (key: string, value?: string) => liveStatuses.push({ key, value }),
        setWidget: (key: string, value?: string[]) => liveWidgets.push({ key, value }),
      },
    } as any;
    const firstCrafter = commands.get("crafter").handler("first direct run", context);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await commands.get("crafter").handler("must not double-book", context);
    assert.match(notices.at(-1)!.message, /crafter is already working in pi-run-1/u);
    assert.match(notices.at(-1)!.message, /Preflight stopped · no model was called · 0 model tokens/u);
    await commands.get("team").handler("", context);
    const live = notices.at(-1)!.message;
    assert.match(live, /Team: .*1 active \(1 working\)/u);
    assert.match(live, /crafter · working[\s\S]*\/team run:pi-run-1/u);
    await commands.get("team").handler("stop all", context);
    await firstCrafter;

    const contract = (index: number) => JSON.stringify({
      name: `contractor-${index.toString().padStart(2, "0")}`,
      description: `Contractor ${index}`,
      prompt: "Work until stopped.",
      tools: ["read"],
      task: `Concurrent contract ${index}`,
    });
    const invocations = Array.from({ length: 32 }, (_, index) =>
      commands.get("contract").handler(contract(index), context));
    await new Promise<void>((resolve) => setImmediate(resolve));
    await commands.get("team").handler("", context);
    assert.match(notices.at(-1)!.message, /Team: .*32 active \(32 working\)/u);
    assert.equal((notices.at(-1)!.message.match(/^● contractor-\d+ · working/gmu) ?? []).length, 4);
    assert.match(notices.at(-1)!.message, /\+28 active runs omitted; enumerate with \/team activity-page:1/u);
    assert.deepEqual([...new Set(liveStatuses.filter(({ value }) => value !== undefined).map(({ key }) => key))],
      ["agent-harbor:team"]);
    assert.deepEqual([...new Set(liveWidgets.filter(({ value }) => value !== undefined).map(({ key }) => key))],
      ["agent-harbor:team"]);
    const latestProjectWidget = liveWidgets.findLast(({ value }) => value !== undefined)!.value!;
    assert.ok(latestProjectWidget.length <= 9);
    assert.match(latestProjectWidget.join("\n"), /contractor-31 · working[\s\S]*\/team run:pi-run-33/u);
    assert.match(latestProjectWidget.at(-1)!, /Alt\+H/u);
    await commands.get("team").handler("run:pi-run-33", context);
    assert.match(notices.at(-1)!.message,
      /contractor-31 · run pi-run-33[\s\S]*Task: “Concurrent contract 31”/u);

    const otherContext = { ...context, cwd: join(root, "other-project") };
    const otherInvocation = commands.get("contract").handler(contract(99), otherContext);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await commands.get("team").handler("", otherContext);
    assert.match(notices.at(-1)!.message, /Team: .*1 active \(1 working\)/u,
      "32 roots in one project blocked an independent project");

    await commands.get("contract").handler(contract(32), context);
    assert.match(notices.at(-1)!.message, /at most 32 concurrent root runs per project/u);
    assert.match(notices.at(-1)!.message, /Preflight stopped · no model was called · 0 model tokens/u);
    assert.doesNotMatch(notices.at(-1)!.message, /TEAM RUN/u);
    const stopCompletions = await commands.get("team").getArgumentCompletions("stop");
    assert.equal(stopCompletions.filter((item: any) => item.value.startsWith("stop pi-run-")).length, 32);
    await commands.get("team").handler("stop all", context);
    assert.match(notices.at(-1)!.message,
      /^Agent Harbor stop · 0 model tokens\nStopping 32 Agent Harbor root run\(s\):/u);
    const settled = await Promise.allSettled(invocations);
    assert.ok(settled.every(({ status }) => status === "fulfilled"));
    await commands.get("team").handler("stop all", otherContext);
    await otherInvocation;
    await commands.get("team").handler("", context);
    assert.match(notices.at(-1)!.message, /0 active/u);
    await commands.get("team").handler("stop all", context);
    assert.equal(notices.at(-1)!.level, "info");
    assert.match(notices.at(-1)!.message,
      /No project-shared persistent-player work is visible; disposable contractor work is\s+process-local/u);
    await commands.get("team").handler("stop pi-run-999999", context);
    assert.equal(notices.at(-1)!.level, "error");
    assert.match(notices.at(-1)!.message, /no active Harbor root matches pi-run-999999/u);
  } finally { PiOrchestrator.prototype.run = originalRun; }
});
