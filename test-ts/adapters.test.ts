import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import test from "node:test";
import { copilotFixedAgentIds, createCopilotCoordinatorGuard } from "../src/adapters/copilot-coordinator.js";
import { AgentHarborPlugin } from "../src/adapters/opencode.js";
import openCodeTui, { openCodeDirectCommands } from "../src/adapters/opencode-tui.js";
import { commandNames } from "../src/core/types.js";
import { bundledPlayers, rolePlayers, scoutPlayer, trustedSkills } from "../src/core/defaults.js";
import { GhResolver } from "../src/core/github.js";
import type { HarborEvidenceEvent } from "../src/core/evidence.js";
import { Roster } from "../src/core/lifecycle.js";
import { harnessSpec, normalizeDelegatedTaskPaths } from "../src/core/profiles.js";
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
const { default: piExtension } = await import("../src/adapters/pi.js");

const definition = { name: "worker", description: "Worker", prompt: "Work", tools: ["read"] as const, task: "Do it" };
const cycleDataset = loadHarborCycleDataset();
const defaultCycle = cycleDataset.cycles.find((cycle) => cycle.id === "default-specialists")!;
const fullCycle = cycleDataset.cycles.find((cycle) => cycle.id === "full-sdlc")!;

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

test("Copilot team-lead hooks enforce exact active sequential delegation across user turns", async () => {
  const root = await mkdtemp(join(tmpdir(), "harbor-copilot-hooks-"));
  const project = join(root, "project");
  const roster = new Roster(harnessSpec("copilot", join(root, "home"), project));
  await roster.bench("on all", bundledPlayers);
  const agents = [
    ...[...copilotFixedAgentIds.values()].map((id) => ({ id, userInvocable: true })),
    ...[...bundledPlayers.keys()].map((id) => ({ id, path: join(project, ".github", "agents", `${id}.agent.md`), userInvocable: true })),
  ];
  let current = copilotFixedAgentIds.get("team-lead")!;
  let failCurrent = false; let failReload = false;
  let reloads = 0;
  const evidenceEvents: HarborEvidenceEvent[] = [];
  const coordinator = createCopilotCoordinatorGuard(() => ({ rpc: { agent: {
    getCurrent: async () => { if (failCurrent) throw new Error("current unavailable"); return { agent: { id: current } }; },
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
  assert.match((await hooks.onPreToolUse(input("portfolio-management", "before snapshot"), invocation))?.permissionDecisionReason ?? "", /snapshot is unavailable/);
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

  await reset("run the SDLC stages");
  priorEvidence = undefined;
  for (const [index, step] of fullCycle.steps.entries()) {
    const id = step.agent;
    const call = input(id, datasetTask(fullCycle, index, priorEvidence));
    if (index === 0) {
      coordinator.observeEvent({ type: "tool.execution_start", data: { toolName: "task", toolCallId: "sdlc-portfolio-management-call" } });
    }
    assert.equal((await hooks.onPreToolUse(call, invocation))?.permissionDecision, "allow");
    if (index === 0) {
      coordinator.observeEvent({
        type: "subagent.started", agentId: "wrong-child",
        data: { agentName: step.agent, toolCallId: "different-call" },
      });
      coordinator.observeEvent({
        type: "subagent.started", agentId: "portfolio-management-child",
        data: { agentName: step.agent, toolCallId: "sdlc-portfolio-management-call" },
      });
      coordinator.observeEvent({
        type: "subagent.completed", agentId: "portfolio-management-child",
        data: { agentName: step.agent, toolCallId: "sdlc-portfolio-management-call" },
      });
      coordinator.observeEvent({ type: "tool.execution_complete", agentId: "nested-child", data: { toolDescription: { name: "task" } } });
      assert.match((await hooks.onPreToolUse(input(fullCycle.steps[1].agent, "parallel"), invocation))?.permissionDecisionReason ?? "", /sequentially/);
      coordinator.observeEvent({
        type: "tool.execution_complete",
        data: { toolCallId: "sdlc-portfolio-management-call", success: true, result: `evidence:${step.agent}` },
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
  assert.ok(!evidenceEvents.some((event) => event.childId === "wrong-child"));
  assert.ok(evidenceEvents.some((event) => event.childId === "portfolio-management-child" && event.phase === "child.started" && event.basis === "observed"));
  assert.ok(evidenceEvents.some((event) => event.agent === "portfolio-management" && event.phase === "child.cleaned" && event.basis === "inferred"));
  assert.deepEqual(
    evidenceEvents.filter((event) => event.phase === "target.resolved").map((event) => event.runtimeAgent),
    [
      ...defaultCycle.steps.map((step) => cycleDataset.roster.fixed.find((player) => player.id === step.agent)!.runtimeIds.copilot),
      ...fullCycle.steps.map((step) => step.agent),
    ],
  );
  assert.equal(reloads, 1, "preToolUse must use the verified snapshot without reentrant host RPC");

  await reset("reject invalid delegations");
  const serialized = input("portfolio-management", "serialized host arguments");
  serialized.toolArgs = JSON.stringify(serialized.toolArgs) as any;
  assert.equal((await hooks.onPreToolUse(serialized, invocation))?.permissionDecision, "allow");
  await finish(serialized as any, "serialized evidence");
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
  assert.match((await hooks.onPreToolUse(input("portfolio-management", "work"), invocation))?.permissionDecisionReason ?? "", /snapshot is unavailable/);
  failCurrent = false; await coordinator.refresh(); failReload = true;
  await assert.rejects(() => coordinator.refresh(), /reload unavailable/);
  assert.match((await hooks.onPreToolUse(input("portfolio-management", "work"), invocation))?.permissionDecisionReason ?? "", /snapshot is unavailable/);
  failReload = false; await coordinator.refresh();

  current = copilotFixedAgentIds.get("crafter")!;
  await coordinator.refresh();
  assert.equal(await hooks.onPreToolUse(input("portfolio-management", "unrelated agent task"), invocation), undefined);
  coordinator.observeEvent({ type: "subagent.selected", data: { agentName: "team-lead" } });
  await reset("selection event normalizes the logical lead ID");
  const selectedCall = input("portfolio-management", "selected lead task");
  assert.equal((await hooks.onPreToolUse(selectedCall, invocation))?.permissionDecision, "allow");
  await finish(selectedCall, "selected lead evidence");
  coordinator.observeEvent({ type: "subagent.selected", agentId: "nested", data: { agentName: "crafter" } });
  await reset("nested selection events cannot replace the root selection");
  const afterNestedSelection = input("portfolio-management", "root lead remains selected");
  assert.equal((await hooks.onPreToolUse(afterNestedSelection, invocation))?.permissionDecision, "allow");
  await finish(afterNestedSelection, "nested selection ignored");
  coordinator.observeEvent({ type: "subagent.deselected", data: {} });
  assert.equal(await hooks.onPreToolUse(input("portfolio-management", "deselected task"), invocation), undefined);
  assert.equal(reloads, 4, "snapshot refreshes are explicit and bounded");

  let markReloadStarted!: () => void;
  const reloadStarted = new Promise<void>((resolve) => { markReloadStarted = resolve; });
  let releaseReload!: () => void;
  const reloadGate = new Promise<void>((resolve) => { releaseReload = resolve; });
  const racingEvidence: HarborEvidenceEvent[] = [];
  const racingCoordinator = createCopilotCoordinatorGuard(() => ({ rpc: { agent: {
    getCurrent: async () => ({ agent: { id: copilotFixedAgentIds.get("crafter")! } }),
    reload: async () => {
      markReloadStarted();
      await reloadGate;
      return { agents };
    },
  } } }), (event) => racingEvidence.push(event));
  const racingRefresh = racingCoordinator.refresh();
  await reloadStarted;
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
  const deselectCoordinator = createCopilotCoordinatorGuard(() => ({ rpc: { agent: {
    getCurrent: async () => ({ agent: { id: copilotFixedAgentIds.get("team-lead")! } }),
    reload: async () => {
      markDeselectReloadStarted();
      await deselectReloadGate;
      return { agents };
    },
  } } }));
  const deselectRefresh = deselectCoordinator.refresh();
  await deselectReloadStarted;
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
    getCurrent: async () => ({ agent: { id: failingReload
      ? copilotFixedAgentIds.get("crafter")!
      : copilotFixedAgentIds.get("team-lead")! } }),
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
  failureRaceCoordinator.observeEvent({
    type: "tool.execution_start", data: { toolName: "task", toolCallId: "post-failure-selection-call" },
  });
  failingReload = false;
  await failureRaceCoordinator.refresh();
  const failureRaceInvocation = { sessionId: "failure-race-parent" };
  const failureRaceCall = input("portfolio-management", "selection survives failed refresh", failureRaceInvocation.sessionId);
  assert.equal((await failureRaceCoordinator.hooks.onPreToolUse(failureRaceCall, failureRaceInvocation))?.permissionDecision, "allow");
  assert.equal(failureRaceEvidence.find((event) => event.phase === "target.resolved")?.invocationId,
    "post-failure-selection-call", "a failed refresh erased a newer selection event");
  await failureRaceCoordinator.hooks.onPostToolUse({ ...failureRaceCall, toolResult: "failure race evidence" }, failureRaceInvocation);
});

test("OpenCode orchestrator uses one child session through its SDK client", async () => {
  const events: string[] = [];
  const client = { session: {
    create: async () => { events.push("create"); return { data: { id: "child" } }; },
    prompt: async ({ path, body }: any) => { events.push(`prompt:${path.id}:${body.agent}:${body.tools.read}:${body.tools.bash}`); return { data: { parts: [{ type: "text", text: "done" }] } }; },
    delete: async ({ path }: any) => { events.push(`delete:${path.id}`); return { data: true }; },
  } };
  const orchestrator = new OpenCodeOrchestrator(client as any, process.cwd());
  assert.equal(await orchestrator.run(definition as any), "done");
  assert.deepEqual(events, ["create", "prompt:child:explore:true:false", "delete:child"]);
});

test("Pi orchestrator uses one in-memory SDK session", async () => {
  const events: string[] = [];
  const loaders: any[] = [];
  const model = { provider: "openai-codex", id: "gpt-5.3-codex-spark" };
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
    getAgentDir: () => "pi-agent-home",
    SessionManager: { inMemory: (cwd: string) => { events.push(`memory:${cwd === process.cwd()}`); return {}; } },
    createAgentSession: async (options: any) => {
      createOptions = options;
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
  assert.equal(createOptions.model, model);
  assert.equal(createOptions.thinkingLevel, "minimal");
  assert.equal(createOptions.resourceLoader instanceof sdk.DefaultResourceLoader, true);
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

  const openCode = new OpenCodeOrchestrator({ session: {
    create: async () => ({ data: { id: "failed" } }),
    prompt: async () => { throw new Error("opencode prompt failed"); },
    delete: async () => { throw new Error("opencode delete failed"); },
  } } as any, process.cwd());
  await assert.rejects(() => openCode.run(definition as any), (error: any) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors.map((entry: Error) => entry.message), ["opencode prompt failed", "opencode delete failed"]);
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

test("OpenCode plugin exposes lifecycle commands and an isolated talent scout", async () => {
  const root = await mkdtemp(join(tmpdir(), "harbor-opencode-adapter-"));
  const previous = process.env.OPENCODE_CONFIG_DIR;
  process.env.OPENCODE_CONFIG_DIR = join(root, "home");
  const initial = join(root, "initial"); const current = join(root, "current");
  const plugin = await AgentHarborPlugin({ client: { session: {} }, directory: initial } as any, {});
  const config: any = {};
  await plugin.config?.(config);
  assert.deepEqual(Object.keys(config.command).slice(0, commandNames.length), [...commandNames]);
  for (const id of rolePlayers.keys()) assert.deepEqual(config.command[`harbor-${id}`], {
    description: `Run Agent Harbor player ${id} in the current session`,
    template: "$ARGUMENTS",
    agent: id,
    subtask: false,
  });
  assert.equal(config.agent["team-lead"].tools.harbor, false);
  assert.equal(config.agent["team-lead"].tools["*"], false);
  assert.equal(config.agent["team-lead"].tools.harbor_contract, false);
  assert.equal(config.agent["team-lead"].tools.harbor_delegate, true);
  assert.equal(config.agent["team-lead"].tools.bash, false);
  assert.equal(config.agent["team-lead"].permission["*"], "deny");
  assert.equal(config.agent["team-lead"].permission.harbor_delegate, "allow");
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
  assert.equal(config.agent["talent-scout"].tools.harbor_filter_skills, true);
  assert.equal(config.agent["talent-scout"].tools.harbor_join_player, true);
  assert.equal(config.agent["talent-scout"].tools.read, false);
  assert.equal(config.agent["talent-scout"].permission.task, "deny");
  assert.ok(plugin.tool?.harbor_filter_skills);
  assert.ok(plugin.tool?.harbor_join_player);
  assert.ok(plugin.tool?.harbor);
  assert.ok(plugin.tool?.harbor_contract);
  assert.ok(plugin.tool?.harbor_delegate);
  assert.ok(plugin.tool?.agent_harbor_skills);
  const directPreflight = plugin["command.execute.before"]!;
  await assert.rejects(() => directPreflight(
    { command: "harbor-team-lead", sessionID: "session", arguments: "   " }, { parts: [] },
  ), /non-empty/);
  await directPreflight({ command: "harbor-team-lead", sessionID: "session", arguments: "coordinate" }, { parts: [] });
  await assert.rejects(() => directPreflight(
    { command: "scout", sessionID: "session", arguments: "   " }, { parts: [] },
  ), /non-empty/);
  await directPreflight({ command: "scout", sessionID: "session", arguments: "zx automation" }, { parts: [] });
  await directPreflight({ command: "bench", sessionID: "session", arguments: "list" }, { parts: [] });
  await mkdir(join(current, "skills", "native"), { recursive: true });
  await writeFile(join(current, "skills", "native", "SKILL.md"), [
    "---", "name: native-guidance", "description: Native guidance", "---", "", "NATIVE-ONLY-GUIDANCE",
  ].join("\n"), "utf8");
  const result = await plugin.tool!.harbor.execute(
    { command: "join", args: JSON.stringify({
      name: "native", description: "Native", prompt: "Work", tools: ["read"],
      skills: [{ kind: "repo", name: "native-guidance", path: "skills/native/SKILL.md" }],
    }) },
    { directory: current, abort: new AbortController().signal } as any,
  );
  assert.match(String(result), /joined native/);
  assert.match(String(result), new RegExp(current.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  const guidance = await plugin.tool!.agent_harbor_skills.execute(
    {},
    { directory: current, agent: "native", abort: new AbortController().signal } as any,
  );
  assert.match(String(guidance), /HARBOR-SKILL native-guidance/);
  assert.match(String(guidance), /NATIVE-ONLY-GUIDANCE/);
  await assert.rejects(() => plugin.tool!.agent_harbor_skills.execute(
    {},
    { directory: current, agent: "team-lead", abort: new AbortController().signal } as any,
  ), /no configured skills/);
  const originalDescribe = GhResolver.prototype.describe;
  try {
    GhResolver.prototype.describe = async () => ({ commit: "e".repeat(40), description: "Author zx automation scripts." });
    await assert.rejects(() => plugin.tool!.harbor_filter_skills.execute(
      { query: "zx scripts" }, { directory: current, agent: "team-lead", abort: new AbortController().signal } as any,
    ), /only to talent-scout/);
    const matches = await plugin.tool!.harbor_filter_skills.execute(
      { query: "zx scripts" }, { directory: current, agent: "talent-scout", abort: new AbortController().signal } as any,
    );
    assert.match(String(matches), /zx-example-author/);
    await assert.rejects(() => plugin.tool!.harbor_join_player.execute(
      { definition: "{}" }, { directory: current, agent: "crafter", abort: new AbortController().signal } as any,
    ), /only to talent-scout/);
    const scouted = await plugin.tool!.harbor_join_player.execute(
      { definition: JSON.stringify({ name: "open-scouted", description: "Scouted", prompt: "Work narrowly.", tools: ["read"] }) },
      { directory: current, agent: "talent-scout", abort: new AbortController().signal } as any,
    );
    assert.match(String(scouted), /joined open-scouted/);
  } finally { GhResolver.prototype.describe = originalDescribe; }
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
    assert.equal(config.command[`harbor-${id}`].agent, id);
    assert.equal(config.command[`harbor-${id}`].subtask, false);
    assert.equal(config.command[`harbor-${id}`].template, "$ARGUMENTS");
  }
  const directPreflight = plugin["command.execute.before"]!;
  await directPreflight({ command: "harbor-portfolio-management", sessionID: "parent", arguments: "prioritize" }, { parts: [] });
  await assert.rejects(() => directPreflight(
    { command: "harbor-portfolio-management", sessionID: "parent", arguments: "   " }, { parts: [] },
  ), /non-empty/);

  const execution: any = {
    agent: "team-lead", directory: project, worktree: project,
    sessionID: "parent", messageID: "default-1", abort: new AbortController().signal,
    metadata: () => {}, ask: async () => {},
  };
  const delegate = plugin.tool!.harbor_delegate;
  assert.deepEqual(
    new Set((delegate.args.agent as any).options),
    new Set([...rolePlayers.keys(), ...bundledPlayers.keys()].filter((id) => id !== "team-lead")),
  );
  for (const id of [...rolePlayers.keys(), ...bundledPlayers.keys()].filter((name) => name !== "team-lead")) {
    assert.match(delegate.description, new RegExp(`${id}:`));
  }
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

  const beforeInvalid = creates.length;
  const sdlcExecution = { ...execution, messageID: "sdlc-invalid" };
  await assert.rejects(() => delegate.execute({ agent: "portfolio-management", task: "work" }, { ...sdlcExecution, agent: "crafter" }), /only to team-lead/);
  await assert.rejects(() => delegate.execute({ agent: "team-lead", task: "recurse" }, sdlcExecution), /recursively/);
  await assert.rejects(() => delegate.execute({ agent: "unknown", task: "work" }, sdlcExecution), /not found/);
  await assert.rejects(() => delegate.execute({ agent: "manage", task: "   " }, sdlcExecution), /non-empty/);
  await roster.bench("off dispose", bundledPlayers);
  await assert.rejects(() => delegate.execute({ agent: "dispose", task: "retire safely" }, sdlcExecution), /not found/);
  await assert.rejects(() => directPreflight(
    { command: "harbor-dispose", sessionID: "parent", arguments: "retire safely" }, { parts: [] },
  ), /not found/);
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
  assert.deepEqual(prompts.map((entry) => entry.body.agent), [...defaultCycle.steps, ...fullCycle.steps].map((step) => step.agent));
  assert.deepEqual(
    prompts.map((entry) => entry.body.model),
    [...defaultCycle.steps.map(() => ({ providerID: defaultModel.providerID, modelID: defaultModel.modelID })), ...fullCycle.steps.map(() => ({ providerID: sdlcModel.providerID, modelID: sdlcModel.modelID }))],
  );
  assert.deepEqual(
    prompts.map((entry) => entry.body.variant),
    [...defaultCycle.steps.map(() => defaultModel.variant), ...fullCycle.steps.map(() => sdlcModel.variant)],
  );
  assert.match(prompts.at(-1).body.parts[0].text, new RegExp(`evidence:${fullCycle.steps.at(-2)!.agent}`));
  assert.ok(creates.every((entry) => entry.body.parentID === undefined));
  assert.deepEqual(deletes, creates.map((entry) => entry.id));
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
    state: { path: { directory: project } },
    ui: {
      toast: (value: unknown) => toasts.push(value), dialog,
      DialogPrompt: (props: unknown) => props,
    },
    keymap: { registerLayer: (layer: unknown) => { layers.push(layer); return () => {}; } },
  };
  try {
    GhResolver.prototype.listCatalog = async (source) => [{ repo: source.repo, path: source.path ?? "skills/zx-example-author/SKILL.md", name: source.name ?? "zx-example-author" }];
    const commands = openCodeDirectCommands(api);
    assert.deepEqual(commands.map((command) => command.slashName), [
      "bench-list", "bench-on", "bench-off", "harbor-join", "harbor-retire", "harbor-list-skills", "harbor-filter-skills",
    ]);
    assert.ok(commands.every((command) => command.namespace === "palette"));
    await commands.find((command) => command.name.endsWith("bench-list"))!.run();
    assert.match(toasts.at(-1).title, /0 model tokens/);
    assert.match(toasts.at(-1).message, /portfolio-management \| bundled \| bench/);

    commands.find((command) => command.name.endsWith("bench-on"))!.run();
    await prompts.at(-1).onConfirm("portfolio-management");
    assert.match(toasts.at(-1).message, /turned on/);
    commands.find((command) => command.name.endsWith("bench-off"))!.run();
    await prompts.at(-1).onConfirm("portfolio-management");
    assert.match(toasts.at(-1).message, /turned off/);

    commands.find((command) => command.name.endsWith("join"))!.run();
    await prompts.at(-1).onConfirm(JSON.stringify({ name: "native", description: "Native", prompt: "Work", tools: ["read"] }));
    assert.match(toasts.at(-1).message, /joined native/);
    commands.find((command) => command.name.endsWith("retire"))!.run();
    await prompts.at(-1).onConfirm("native");
    assert.match(toasts.at(-1).message, /retired native/);

    await commands.find((command) => command.name.endsWith("skills-list"))!.run();
    assert.match(toasts.at(-1).message, /REPOSITORY.*PATH.*SKILL/);
    assert.match(toasts.at(-1).message, /\x1b\[/);
    commands.find((command) => command.name.endsWith("skills-filter"))!.run();
    await prompts.at(-1).onConfirm("zx");
    assert.match(toasts.at(-1).message, /zx-example-author/);
    assert.ok(toasts.every((toast) => /0 model tokens/.test(toast.title)));

    await openCodeTui.tui(api, undefined, {} as any);
    assert.equal(layers.length, 1);
    assert.equal(layers[0].commands.length, 7);
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
  assert.deepEqual(names, [...commandNames, ...rolePlayers.keys(), "scout"]);
  assert.deepEqual(tools.map((tool) => tool.name), ["harbor_contract"]);
  assert.equal(tools[0].executionMode, "sequential");
});

test("Pi /scout receives only filtering and one deterministic join tool", async () => {
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
  let captured: any;
  try {
    PiOrchestrator.prototype.run = async function (definition: any) {
      captured = { definition, customTools: [...(this as any).customTools], additionalTools: [...(this as any).additionalTools] };
      return "scout-complete";
    };
    GhResolver.prototype.describe = async () => ({
      commit: "d".repeat(40), description: "Author zx automation scripts.",
    });
    await commands.get("scout").handler("alguien que escriba scripts en zx", {
      cwd: project, model: undefined, ui: { notify: (message: string) => notices.push(message) },
    });
    assert.equal(captured.definition.name, scoutPlayer.name);
    assert.deepEqual(captured.additionalTools, ["harbor_filter_skills", "harbor_join_player"]);
    assert.deepEqual(captured.customTools.map((entry: any) => entry.name), captured.additionalTools);
    const filtered = await captured.customTools[0].execute(
      "filter", { query: "zx scripts" }, new AbortController().signal, undefined, { cwd: project },
    );
    assert.match(filtered.content[0].text, /zx-example-author/);
    const joined = await captured.customTools[1].execute(
      "join", { definition: JSON.stringify({
        name: "zx-automator", description: "Writes zx automation", prompt: "Write bounded zx automation scripts.",
        tools: ["read", "edit", "execute"], skills: [trustedSkills[0]],
      }) }, new AbortController().signal, undefined, { cwd: project },
    );
    assert.match(joined.content[0].text, /joined zx-automator/);
    assert.match(await readFile(join(project, ".pi", "agents", "zx-automator.md"), "utf8"), /zx-example-author/);
    assert.equal(notices.at(-1), "scout-complete");
  } finally {
    PiOrchestrator.prototype.run = originalRun;
    GhResolver.prototype.describe = originalDescribe;
    if (previousHome === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousHome;
  }
});

test("Pi contract entrypoints inherit the host SDK model and thinking level", async () => {
  const root = await mkdtemp(join(tmpdir(), "harbor-pi-contract-model-"));
  const commands = new Map<string, any>();
  const tools = new Map<string, any>();
  const notices: string[] = [];
  const hostModel = { provider: "openai-codex", id: "gpt-5.3-codex-spark" };
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
    const context = { cwd: root, model: hostModel, ui: { notify: (message: string) => notices.push(message) } };
    await commands.get("contract").handler(contract, context);
    const toolResult = await tools.get("harbor_contract").execute(
      "contract-tool", { definition: contract }, new AbortController().signal, undefined, context,
    );
    assert.equal(toolResult.content[0].text, "contract-evidence");
  } finally {
    PiOrchestrator.prototype.run = originalRun;
  }

  assert.equal(notices.at(-1), "contract-evidence");
  assert.equal(observed.length, 2);
  assert.ok(observed.every((entry) => entry.hostMarker === "host-sdk-static-import"));
  assert.ok(observed.every((entry) => entry.sessionOptions.model === hostModel));
  assert.ok(observed.every((entry) => entry.sessionOptions.thinkingLevel === "minimal"));
});

test("Pi deterministic command handlers never enter the SDK orchestrator", async () => {
  const root = await mkdtemp(join(tmpdir(), "harbor-pi-direct-"));
  const previousHome = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "home");
  const commands = new Map<string, any>(); const notices: string[] = [];
  const originalRun = PiOrchestrator.prototype.run;
  const originalListCatalog = GhResolver.prototype.listCatalog;
  try {
    PiOrchestrator.prototype.run = async () => { throw new Error("model orchestrator was invoked"); };
    GhResolver.prototype.listCatalog = async (source) => [{ repo: source.repo, path: source.path ?? "skills/zx-example-author/SKILL.md", name: source.name ?? "zx-example-author" }];
    piExtension({
      registerCommand: (name: string, options: any) => commands.set(name, options),
      registerTool: () => {},
      getThinkingLevel: () => { throw new Error("deterministic commands requested model state"); },
    } as any);
    await commands.get("bench").handler("list", { cwd: join(root, "project"), ui: { notify: (value: string) => notices.push(value) } });
    assert.match(notices.at(-1)!, /portfolio-management \| bundled \| bench/);
    await commands.get("join").handler(JSON.stringify({ name: "native", description: "Native", prompt: "Work", tools: ["read"] }), {
      cwd: join(root, "project"), ui: { notify: (value: string) => notices.push(value) },
    });
    assert.match(notices.at(-1)!, /joined native/);
    await commands.get("retire").handler("native", { cwd: join(root, "project"), ui: { notify: (value: string) => notices.push(value) } });
    assert.match(notices.at(-1)!, /retired native/);
    await commands.get("list-skills").handler("zx", { cwd: join(root, "project"), ui: { notify: (value: string) => notices.push(value) } });
    assert.match(notices.at(-1)!, /REPOSITORY.*PATH.*SKILL/);
    assert.match(notices.at(-1)!, /\x1b\[/);
    assert.ok(notices.every((value) => !value.includes("model orchestrator was invoked")));
  } finally {
    PiOrchestrator.prototype.run = originalRun;
    GhResolver.prototype.listCatalog = originalListCatalog;
    if (previousHome === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousHome;
  }
});

test("Pi extension invokes every fixed and activated agent and equips the team lead for named delegation", async () => {
  const root = await mkdtemp(join(tmpdir(), "harbor-pi-player-"));
  const project = join(root, "project");
  const roster = new Roster(harnessSpec("pi", join(root, "home"), project));
  await roster.join({ name: "reviewer", description: "Review", prompt: "Review only", tools: ["read", "search"] });
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
  }> = []; const notices: string[] = [];
  const originalRun = PiOrchestrator.prototype.run;
  try {
    PiOrchestrator.prototype.run = async function (definition: any) {
      const sdk = await (this as any).loadSdk();
      received.push({
        definition,
        additionalTools: [...(this as any).additionalTools],
        customTools: [...(this as any).customTools],
        sessionOptions: { ...(this as any).sessionOptions },
        hostMarker: sdk.HARBOR_PI_SDK_HOST_TEST_MARKER,
      });
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
  assert.deepEqual(lead.additionalTools, ["harbor_delegate"]);
  assert.deepEqual(lead.customTools.map((tool) => tool.name), ["harbor_delegate"]);
  assert.equal(lead.customTools[0].executionMode, "sequential");
  for (const entry of received.filter((item) => item.definition.name !== "team-lead")) {
    assert.deepEqual(entry.additionalTools, []);
    assert.deepEqual(entry.customTools, []);
  }
  assert.ok(received.every((entry) => entry.hostMarker === "host-sdk-static-import"));
  assert.ok(received.every((entry) => entry.sessionOptions.model === hostModel));
  assert.ok(received.every((entry) => entry.sessionOptions.thinkingLevel === "minimal"));
  assert.deepEqual(notices, ["completed:reviewer", ...[...rolePlayers.keys(), ...bundledPlayers.keys()].map((name) => `completed:${name}`)]);
});

test("Pi team lead delegates sequentially to different active agents with bounds and preflight", async () => {
  const root = await mkdtemp(join(tmpdir(), "harbor-pi-delegate-"));
  const project = join(root, "project");
  const roster = new Roster(harnessSpec("pi", join(root, "home"), project));
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
  const originalRun = PiOrchestrator.prototype.run;
  try {
    PiOrchestrator.prototype.run = async function (definition: any) {
      calls.push(definition);
      const sdk = await (this as any).loadSdk();
      runtimes.push({ sessionOptions: { ...(this as any).sessionOptions }, hostMarker: sdk.HARBOR_PI_SDK_HOST_TEST_MARKER });
      if (definition.name === "team-lead") delegates.push((this as any).customTools[0]);
      return `evidence:${definition.name}`;
    };
    await commands.get("team-lead").handler("use the fixed specialists", { cwd: project, model: hostModel, ui: { notify: (message: string) => notices.push(message) } });
    const context = { cwd: project, model: hostModel };
    assert.equal(delegates[0].executionMode, "sequential");
    assert.deepEqual(
      new Set(delegates[0].parameters.properties.agent.enum),
      new Set([...rolePlayers.keys(), ...bundledPlayers.keys()].filter((id) => id !== "team-lead")),
    );
    let priorEvidence: string | undefined;
    for (const [index, step] of defaultCycle.steps.entries()) {
      const result: any = await delegates[0].execute(
        `default-${index + 1}`,
        { agent: step.agent, task: datasetTask(defaultCycle, index, priorEvidence) },
        new AbortController().signal, undefined, context,
      );
      priorEvidence = result.content[0].text;
      assert.equal(priorEvidence, `evidence:${step.agent}`);
    }

    await commands.get("team-lead").handler("complete one SDLC mission", { cwd: project, model: hostModel, ui: { notify: (message: string) => notices.push(message) } });
    const delegate = delegates[1];
    assert.equal(delegate.executionMode, "sequential");
    priorEvidence = undefined;
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
    await assert.rejects(() => delegate.execute("bad", { agent: "unknown", task: "work" }, new AbortController().signal, undefined, context), /ENOENT|not found/);
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
    await assert.rejects(() => delegate.execute("call-7", { agent: fullCycle.steps[0].agent, task: "too many" }, new AbortController().signal, undefined, context), /limit reached/);
    assert.deepEqual(
      calls.map((call) => call.name),
      ["team-lead", ...defaultCycle.steps.map((step) => step.agent), "team-lead", ...fullCycle.steps.map((step) => step.agent)],
    );
    assert.ok(runtimes.every((runtime) => runtime.hostMarker === "host-sdk-static-import"));
    assert.ok(runtimes.every((runtime) => runtime.sessionOptions.model === hostModel));
    assert.ok(runtimes.every((runtime) => runtime.sessionOptions.thinkingLevel === "minimal"));
  } finally { PiOrchestrator.prototype.run = originalRun; }
  assert.deepEqual(notices, ["evidence:team-lead", "evidence:team-lead"]);
});
