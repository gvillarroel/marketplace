import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { copilotFixedAgentIds } from "../src/adapters/copilot-coordinator.js";
import { listInvocablePlayerIds, requireInvocablePlayer } from "../src/core/active.js";
import { bundledPlayers, rolePlayers } from "../src/core/defaults.js";
import { emitHarborEvidence, fingerprintHarborEvidence, type HarborEvidenceEvent } from "../src/core/evidence.js";
import { Roster } from "../src/core/lifecycle.js";
import { harnessSpec } from "../src/core/profiles.js";
import type { HarnessName } from "../src/core/types.js";
import { CopilotOrchestrator } from "../src/orchestrators/copilot.js";
import { OpenCodeOrchestrator } from "../src/orchestrators/opencode.js";
import { PiOrchestrator } from "../src/orchestrators/pi.js";
import { loadHarborCycleDataset, type HarborCycle, type HarborHarness } from "./support/harbor-cycles.js";
import { assertHarborEvidenceMetadataOnly, HarborEvidenceCollector } from "./support/harbor-evidence.js";
import { foldMarkdownWrappedText } from "./support/live-handoff.js";
import { classifyLiveToolTarget } from "./support/live-tool-targets.mjs";

const dataset = loadHarborCycleDataset();
const defaultCycle = dataset.cycles.find((cycle) => cycle.id === "default-specialists")!;
const fullCycle = dataset.cycles.find((cycle) => cycle.id === "full-sdlc")!;
const offlineGithub = {
  resolve: async () => ({ commit: "a".repeat(40), blob: "b".repeat(40) }),
  load: async () => ({ commit: "a".repeat(40), body: "Use the bounded offline fixture only." }),
};
const openCodeModel = { providerID: "openai", modelID: "gpt-5.3-codex-spark", variant: "low" } as const;

test("live handoff comparison removes Markdown quote and fence wrappers", () => {
  const response = "Evidence from the completed gate.\nHARBOR_HANDOFF:portfolio-management:AH-hidden";
  const nestedQuoteAndFence = [
    "> ```text",
    "> Evidence from the completed gate.",
    "> HARBOR_HANDOFF:portfolio-management:AH-hidden",
    "> ```",
  ].join("\n");
  const tildeFence = `~~~markdown\n${response}\n~~~`;
  assert.equal(foldMarkdownWrappedText(nestedQuoteAndFence), foldMarkdownWrappedText(response));
  assert.equal(foldMarkdownWrappedText(tildeFence), foldMarkdownWrappedText(response));
});

test("live tool observers classify bounded targets without retaining raw paths", () => {
  const fixtureRoot = join(tmpdir(), "agent-harbor-tool-target-fixture");
  assert.equal(classifyLiveToolTarget("read", { filePath: "ACCEPTANCE.md" }), "ACCEPTANCE.md");
  assert.equal(classifyLiveToolTarget("read", { path: ".\\src\\score.js" }), "src/score.js");
  assert.equal(classifyLiveToolTarget("grep", { pattern: "clampScore", path: "test/score.test.js" }), "test/score.test.js");
  assert.equal(classifyLiveToolTarget("glob", { path: "src", pattern: "score.js" }), "src/score.js");
  assert.equal(classifyLiveToolTarget("find", { path: ".", pattern: "test/score.test.js" }), "test/score.test.js");
  assert.equal(classifyLiveToolTarget("apply_patch", {
    patchText: "*** Begin Patch\n*** Update File: src/score.js\n@@\n-old\n+new\n*** End Patch",
  }), "src/score.js");
  assert.equal(classifyLiveToolTarget("write", { path: "package.json", content: "private" }), "other");
  assert.equal(classifyLiveToolTarget("read", {}), "none");
  assert.equal(classifyLiveToolTarget("read", { paths: ["ACCEPTANCE.md", "src/score.js"] }), "multiple");
  assert.equal(classifyLiveToolTarget("read", { path: "C:\\fixture\\ACCEPTANCE.md" }), "other");
  assert.equal(classifyLiveToolTarget("read", { path: join(fixtureRoot, "ACCEPTANCE.md") }, fixtureRoot), "ACCEPTANCE.md");
  assert.equal(classifyLiveToolTarget("read", { path: join(fixtureRoot, "..", "outside.md") }, fixtureRoot), "other");
});

function stageTask(cycle: HarborCycle, index: number, priorEvidence: string | undefined): string {
  const step = cycle.steps[index];
  if (!step.evidenceFrom) {
    assert.equal(priorEvidence, undefined);
    return step.task;
  }
  assert.ok(priorEvidence, `${step.agent} requires evidence from ${step.evidenceFrom}`);
  return `${step.task}\n\nVerified evidence from ${step.evidenceFrom}:\n${priorEvidence}`;
}

function runtimeId(harness: HarborHarness, agent: string): string {
  const player = [...dataset.roster.fixed, ...dataset.roster.bundled].find((candidate) => candidate.id === agent);
  assert.ok(player, `dataset player missing: ${agent}`);
  return player.runtimeIds[harness];
}

test("the Harbor cycle dataset is literal, closed, and independent from runtime catalogs", async () => {
  assert.deepEqual(dataset.roster.fixed.map((player) => player.id), [...rolePlayers.keys()]);
  assert.deepEqual(dataset.roster.bundled.map((player) => player.id), [...bundledPlayers.keys()]);
  assert.deepEqual(
    dataset.roster.fixed.map((player) => player.runtimeIds.copilot),
    [...copilotFixedAgentIds.values()],
  );
  assert.deepEqual(fullCycle.steps.map((step) => step.agent), ["portfolio-management", "design", "build", "manage", "consume", "dispose"]);
  assert.ok(dataset.cycles.every((cycle) => cycle.coordinator === "team-lead"));

  const root = await mkdtemp(join(tmpdir(), "harbor-cycle-invalid-"));
  const invalid = join(root, "cycles.json");
  await writeFile(invalid, JSON.stringify({ ...dataset, unexpected: true }), "utf8");
  assert.throws(() => loadHarborCycleDataset(invalid), /expected exactly keys/);
});

async function prepareCycle(harness: HarnessName, cycle: HarborCycle) {
  const root = await mkdtemp(join(tmpdir(), `harbor-${harness}-cycle-`));
  const project = join(root, "project");
  const roster = new Roster(harnessSpec(harness, join(root, "home"), project));
  assert.deepEqual(new Set(listInvocablePlayerIds(harness, project)), new Set(dataset.roster.fixed.map((player) => player.id)));
  if (cycle.activate.length) await roster.bench(`on ${cycle.activate.join(" ")}`, bundledPlayers);
  const expected = [...dataset.roster.fixed.map((player) => player.id), ...cycle.activate];
  assert.deepEqual(new Set(listInvocablePlayerIds(harness, project)), new Set(expected));
  for (const step of cycle.steps) requireInvocablePlayer(harness, project, step.agent);
  return { project, roster };
}

async function runCopilotCycle(cycle: HarborCycle): Promise<void> {
  const harness = "copilot" as const;
  const { project, roster } = await prepareCycle(harness, cycle);
  const collector = new HarborEvidenceCollector(harness, cycle.id);
  const childAgents = new Map<string, string>();
  let childSequence = 0;
  const orchestrator = new CopilotOrchestrator(() => ({
    createSession: async (config: any) => {
      const agent = config.agent as string;
      assert.equal(agent, config.customAgents[0].name);
      assert.equal(agent, runtimeId(harness, agent));
      const childId = `copilot-${++childSequence}`;
      childAgents.set(childId, agent);
      collector.witness({ phase: "child.started", agent, runtimeAgent: agent, childId });
      return {
        sessionId: childId,
        abort: async () => {},
        sendAndWait: async ({ prompt }: any) => {
          collector.witness({ phase: "prompt.sent", agent, runtimeAgent: agent, childId, fingerprint: fingerprintHarborEvidence(prompt) });
          const evidence = `evidence:${cycle.id}:${agent}`;
          collector.witness({ phase: "evidence.returned", agent, runtimeAgent: agent, childId, fingerprint: fingerprintHarborEvidence(evidence) });
          return { data: { content: evidence } };
        },
      };
    },
    deleteSession: async (childId: string) => {
      const agent = childAgents.get(childId);
      assert.ok(agent);
      collector.witness({ phase: "child.cleaned", agent, runtimeAgent: agent, childId });
    },
    stop: async () => {},
  }) as any, project, offlineGithub, collector.hook);

  const executions = [];
  let priorEvidence: string | undefined;
  for (const [index, step] of cycle.steps.entries()) {
    requireInvocablePlayer(harness, project, step.agent);
    const task = stageTask(cycle, index, priorEvidence);
    const player = rolePlayers.get(step.agent) ?? bundledPlayers.get(step.agent);
    assert.ok(player);
    priorEvidence = await orchestrator.run({ ...player, task });
    executions.push({ agent: step.agent, task, evidence: priorEvidence });
  }
  collector.assertSuccessfulCycle(dataset, cycle, executions);
  if (cycle.activate.length) await roster.bench(`off ${cycle.activate.join(" ")}`, bundledPlayers);
  assert.deepEqual(new Set(listInvocablePlayerIds(harness, project)), new Set(dataset.roster.fixed.map((player) => player.id)));
}

async function runOpenCodeCycle(cycle: HarborCycle): Promise<void> {
  const harness = "opencode" as const;
  const { project, roster } = await prepareCycle(harness, cycle);
  const collector = new HarborEvidenceCollector(harness, cycle.id);
  const childAgents = new Map<string, string>();
  const client = { session: {
    create: async ({ body }: any) => {
      const agent = /^Harbor agent: (.+)$/.exec(body.title)?.[1];
      assert.ok(agent);
      const childId = `opencode-${childAgents.size + 1}`;
      childAgents.set(childId, agent);
      collector.witness({ phase: "child.started", agent, runtimeAgent: agent, childId });
      return { data: { id: childId } };
    },
    prompt: async ({ path, body }: any) => {
      const agent = childAgents.get(path.id);
      assert.ok(agent);
      assert.equal(body.agent, runtimeId(harness, agent));
      assert.deepEqual(body.model, { providerID: openCodeModel.providerID, modelID: openCodeModel.modelID });
      assert.equal(body.variant, openCodeModel.variant);
      const task = body.parts[0].text as string;
      collector.witness({ phase: "prompt.sent", agent, runtimeAgent: body.agent, childId: path.id, fingerprint: fingerprintHarborEvidence(task) });
      const evidence = `evidence:${cycle.id}:${agent}`;
      collector.witness({ phase: "evidence.returned", agent, runtimeAgent: body.agent, childId: path.id, fingerprint: fingerprintHarborEvidence(evidence) });
      return { data: { parts: [{ type: "text", text: evidence }] } };
    },
    delete: async ({ path }: any) => {
      const agent = childAgents.get(path.id);
      assert.ok(agent);
      collector.witness({ phase: "child.cleaned", agent, runtimeAgent: agent, childId: path.id });
      return { data: true };
    },
  } };
  const orchestrator = new OpenCodeOrchestrator(client as any, project, offlineGithub, collector.hook);

  const executions = [];
  let priorEvidence: string | undefined;
  for (const [index, step] of cycle.steps.entries()) {
    requireInvocablePlayer(harness, project, step.agent);
    const task = stageTask(cycle, index, priorEvidence);
    priorEvidence = await orchestrator.runAgent(step.agent, task, "team-lead-parent", openCodeModel);
    executions.push({ agent: step.agent, task, evidence: priorEvidence });
  }
  collector.assertSuccessfulCycle(dataset, cycle, executions);
  if (cycle.activate.length) await roster.bench(`off ${cycle.activate.join(" ")}`, bundledPlayers);
  assert.deepEqual(new Set(listInvocablePlayerIds(harness, project)), new Set(dataset.roster.fixed.map((player) => player.id)));
}

async function runPiCycle(cycle: HarborCycle): Promise<void> {
  const harness = "pi" as const;
  const { project, roster } = await prepareCycle(harness, cycle);
  const collector = new HarborEvidenceCollector(harness, cycle.id);
  let childSequence = 0;
  const sdk = {
    SessionManager: { inMemory: () => ({}) },
    createAgentSession: async () => {
      const childId = `pi-${++childSequence}`;
      let handler = (_event: unknown) => {};
      let agent = "";
      return { session: {
        sessionId: childId,
        subscribe: (next: (event: unknown) => void) => { handler = next; return () => {}; },
        prompt: async (prompt: string) => {
          agent = /^Identity: ([^\n]+)$/m.exec(prompt)?.[1] ?? "";
          assert.ok(agent);
          assert.equal(agent, runtimeId(harness, agent));
          collector.witness({ phase: "child.started", agent, runtimeAgent: agent, childId });
          const task = /^Task:\n([\s\S]*)$/m.exec(prompt)?.[1] ?? "";
          collector.witness({ phase: "prompt.sent", agent, runtimeAgent: agent, childId, fingerprint: fingerprintHarborEvidence(task) });
          const evidence = `evidence:${cycle.id}:${agent}`;
          collector.witness({ phase: "evidence.returned", agent, runtimeAgent: agent, childId, fingerprint: fingerprintHarborEvidence(evidence) });
          handler({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: evidence } });
        },
        abort: async () => {},
        dispose: () => { collector.witness({ phase: "child.cleaned", agent, runtimeAgent: agent, childId }); },
      } };
    },
  };
  const orchestrator = new PiOrchestrator(project, async () => sdk as any, [], offlineGithub, [], collector.hook);

  const executions = [];
  let priorEvidence: string | undefined;
  for (const [index, step] of cycle.steps.entries()) {
    requireInvocablePlayer(harness, project, step.agent);
    const task = stageTask(cycle, index, priorEvidence);
    const player = rolePlayers.get(step.agent) ?? bundledPlayers.get(step.agent);
    assert.ok(player);
    priorEvidence = await orchestrator.run({ ...player, task });
    executions.push({ agent: step.agent, task, evidence: priorEvidence });
  }
  collector.assertSuccessfulCycle(dataset, cycle, executions);
  if (cycle.activate.length) await roster.bench(`off ${cycle.activate.join(" ")}`, bundledPlayers);
  assert.deepEqual(new Set(listInvocablePlayerIds(harness, project)), new Set(dataset.roster.fixed.map((player) => player.id)));
}

test("the full Harbor dataset cycle activates, dispatches, hands off evidence, and cleans every SDK child", async () => {
  await Promise.all([runCopilotCycle(fullCycle), runOpenCodeCycle(fullCycle), runPiCycle(fullCycle)]);
});

test("the default Harbor cycle dispatches both startup specialists with evidence and cleanup", async () => {
  await Promise.all([runOpenCodeCycle(defaultCycle), runPiCycle(defaultCycle)]);
});

test("evidence hooks retain only hashes and byte lengths", () => {
  const secretTask = "task-that-must-not-enter-the-trace";
  const secretEvidence = "evidence-that-must-not-enter-the-trace";
  const secretError = "error-that-must-not-enter-the-trace";
  const events: HarborEvidenceEvent[] = [];
  emitHarborEvidence((event) => events.push(event), {
    phase: "target.resolved", harness: "pi", agent: "portfolio-management", outcome: "ok",
    task: fingerprintHarborEvidence(secretTask),
  });
  emitHarborEvidence((event) => events.push(event), {
    phase: "evidence.returned", harness: "pi", agent: "portfolio-management", outcome: "ok",
    evidence: fingerprintHarborEvidence(secretEvidence),
  });
  emitHarborEvidence((event) => events.push(event), {
    phase: "child.failed", harness: "pi", agent: "portfolio-management", outcome: "error",
    error: fingerprintHarborEvidence(secretError),
  });
  assertHarborEvidenceMetadataOnly(events, [secretTask, secretEvidence, secretError]);
  assert.equal(events[0].task?.sha256.length, 64);
  assert.equal(events[1].evidence?.utf8Bytes, Buffer.byteLength(secretEvidence, "utf8"));
});

test("a failing async evidence collector cannot alter child execution or cleanup", async () => {
  const calls: string[] = [];
  const client = { session: {
    create: async () => { calls.push("create"); return { data: { id: "child" } }; },
    prompt: async () => { calls.push("prompt"); return { data: { parts: [{ type: "text", text: "evidence" }] } }; },
    delete: async () => { calls.push("delete"); return { data: true }; },
  } };
  const orchestrator = new OpenCodeOrchestrator(client as any, process.cwd(), offlineGithub, async () => {
    throw new Error("collector unavailable");
  });
  assert.equal(await orchestrator.runAgent("portfolio-management", "bounded task", "parent", openCodeModel), "evidence");
  assert.deepEqual(calls, ["create", "prompt", "delete"]);
});

test("creation, prompt, and cleanup failures produce bounded truthful evidence traces", async () => {
  const definition = { ...bundledPlayers.get("portfolio-management")!, task: "private bounded task" };

  const copilotFactoryEvents: HarborEvidenceEvent[] = [];
  const copilotFactory = new CopilotOrchestrator(
    () => { throw new Error("private copilot factory failure"); },
    process.cwd(), offlineGithub, (event) => copilotFactoryEvents.push(event),
  );
  await assert.rejects(() => copilotFactory.run(definition), /private copilot factory failure/);
  assert.deepEqual(copilotFactoryEvents.map((event) => event.phase), ["target.resolved", "child.failed"]);

  const copilotEvents: HarborEvidenceEvent[] = [];
  let copilotStopped = false;
  const copilot = new CopilotOrchestrator(() => ({
    createSession: async () => { throw new Error("private copilot create failure"); },
    stop: async () => { copilotStopped = true; },
  }) as any, process.cwd(), offlineGithub, (event) => copilotEvents.push(event));
  await assert.rejects(() => copilot.run(definition), /private copilot create failure/);
  assert.equal(copilotStopped, true);
  assert.deepEqual(copilotEvents.map((event) => event.phase), ["target.resolved", "child.failed"]);

  const openCodeCreateEvents: HarborEvidenceEvent[] = [];
  const openCodeCreate = new OpenCodeOrchestrator({ session: {
    create: async () => { throw new Error("private opencode create failure"); },
  } } as any, process.cwd(), offlineGithub, (event) => openCodeCreateEvents.push(event));
  await assert.rejects(() => openCodeCreate.runAgent("portfolio-management", definition.task, "parent", openCodeModel), /private opencode create failure/);
  assert.deepEqual(openCodeCreateEvents.map((event) => event.phase), ["target.resolved", "child.failed"]);

  const piCreateEvents: HarborEvidenceEvent[] = [];
  const piCreate = new PiOrchestrator(
    process.cwd(), async () => { throw new Error("private pi create failure"); }, [], offlineGithub, [],
    (event) => piCreateEvents.push(event),
  );
  await assert.rejects(() => piCreate.run(definition), /private pi create failure/);
  assert.deepEqual(piCreateEvents.map((event) => event.phase), ["target.resolved", "child.failed"]);

  const combinedFailureEvents: HarborEvidenceEvent[] = [];
  const combinedFailure = new OpenCodeOrchestrator({ session: {
    create: async () => ({ data: { id: "failed-child" } }),
    prompt: async () => { throw new Error("private prompt failure"); },
    delete: async () => { throw new Error("private cleanup failure"); },
  } } as any, process.cwd(), offlineGithub, (event) => combinedFailureEvents.push(event));
  await assert.rejects(() => combinedFailure.runAgent("portfolio-management", definition.task, "parent", openCodeModel), AggregateError);
  assert.deepEqual(
    combinedFailureEvents.map((event) => `${event.phase}:${event.outcome}`),
    [
      "target.resolved:ok", "child.started:ok", "prompt.attempted:ok",
      "child.failed:error", "child.cleaned:error",
    ],
  );

  const emptyEvidenceEvents: HarborEvidenceEvent[] = [];
  const emptyEvidence = new OpenCodeOrchestrator({ session: {
    create: async () => ({ data: { id: "empty-child" } }),
    prompt: async () => ({ data: { parts: [] } }),
    delete: async () => ({ data: true }),
  } } as any, process.cwd(), offlineGithub, (event) => emptyEvidenceEvents.push(event));
  await assert.rejects(() => emptyEvidence.runAgent("portfolio-management", definition.task, "parent", openCodeModel), /empty evidence/);
  assert.deepEqual(
    emptyEvidenceEvents.map((event) => `${event.phase}:${event.outcome}`),
    [
      "target.resolved:ok", "child.started:ok", "prompt.attempted:ok",
      "child.failed:error", "child.cleaned:ok",
    ],
  );
  assertHarborEvidenceMetadataOnly(
    [
      ...copilotFactoryEvents, ...copilotEvents, ...openCodeCreateEvents, ...piCreateEvents,
      ...combinedFailureEvents, ...emptyEvidenceEvents,
    ],
    [
      definition.task,
      "private copilot factory failure", "private copilot create failure",
      "private opencode create failure", "private pi create failure",
      "private prompt failure", "private cleanup failure",
    ],
  );
});
