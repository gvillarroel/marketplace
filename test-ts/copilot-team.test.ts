import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  copilotPublicIdentifier,
  copilotTaskLabel,
  CopilotTeamRuntime,
  formatCopilotMissionReport,
  formatCopilotNativeTelemetry,
  maximumCopilotUsageIdentityKeys,
  maximumConcurrentCopilotRoots,
} from "../src/adapters/copilot-team-runtime.js";
import {
  collectCopilotTeamMembers,
  formatCopilotDegradedTeamView,
  formatCopilotTeamView,
  maximumVisibleCopilotRosterMembers,
} from "../src/adapters/copilot-team-view.js";
import { copilotFixedAgentIds } from "../src/adapters/copilot-coordinator.js";
import { bundledPlayers } from "../src/core/defaults.js";
import { Roster } from "../src/core/lifecycle.js";
import { harnessSpec } from "../src/core/profiles.js";
import { visibleTextWidth } from "../src/core/text-layout.js";

test("Copilot runtime redacts tasks, privately deduplicates native usage, and preserves lower bounds", () => {
  let now = 1_000;
  const runtime = new CopilotTeamRuntime(() => now);
  const runId = runtime.begin({
    project: process.cwd(),
    agent: "team-lead",
    kind: "manager",
    task: "Inspect C:\\private\\customer\\records.txt and src/private.ts with token-secret-abcdefghijklmnop at https://internal.example/data then produce a deliberately long outcome label",
    model: "requested-alias",
    reasoningEffort: "low",
  });
  runtime.observer(runId).state("working");
  const first = {
    id: "usage-event-1",
    timestamp: "2026-07-21T00:00:00Z",
    type: "assistant.usage" as const,
    data: {
      apiCallId: "provider-call-1",
      model: "gpt-effective-a",
      reasoningEffort: "high",
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 5,
      cacheWriteTokens: 1,
    },
  };
  assert.equal(runtime.observeUsageEvent(first, runId), true);
  assert.equal(runtime.observeUsageEvent({ ...structuredClone(first), id: "re-emitted-event-id" }, runId), false,
    "one provider call was counted twice after Copilot re-emitted it under a new event ID");
  assert.equal(runtime.observer(runId).event({
    id: "usage-event-2",
    type: "assistant.usage",
    data: {
      apiCallId: "provider-call-2",
      model: "gpt-effective-b",
      reasoningEffort: "max",
      inputTokens: 50,
      outputTokens: 10,
      reasoningTokens: 3,
    },
  }), true);
  now = 4_000;
  runtime.finish(runId, "completed");

  const run = runtime.get(runId)!;
  assert.equal(run.nativeCalls, 2);
  assert.deepEqual(run.usage, { input: 150, output: 30, reasoning: 3, cacheRead: 5, cacheWrite: 1, total: 180 });
  assert.ok(run.usageLowerBounds.includes("reasoning"));
  assert.ok(run.usageLowerBounds.includes("cacheRead"));
  assert.deepEqual(run.observedModels, ["gpt-effective-a", "gpt-effective-b"]);
  assert.deepEqual(run.observedReasoningEfforts, ["high", "max"]);
  assert.equal(run.elapsedMs, 3_000);
  assert.match(run.task, /\[path\]/u);
  assert.match(run.task, /\[redacted\]/u);
  assert.ok([...run.task].length <= 72);
  assert.match(formatCopilotMissionReport(runtime, runId), /cache r\/w ≥5\/≥1/u);
  const serialized = JSON.stringify(run);
  assert.doesNotMatch(serialized, /customer|private\.ts|internal\.example|abcdefghijklmnop|provider-call/u);
  const report = formatCopilotMissionReport(runtime, runId);
  assert.match(report, /reason ≥3/u);
  assert.match(report, /gpt-effective-b \(observed; also gpt-effective-a\)/u);
  assert.ok(report.split("\n").every((line) => visibleTextWidth(line) <= 96));

  const aliases = new CopilotTeamRuntime();
  const aliasRun = aliases.begin({ project: process.cwd(), agent: "alias-test", kind: "contractor", task: "Count" });
  assert.equal(aliases.observeUsageEvent({
    id: "provider-only-event",
    type: "assistant.usage",
    data: { providerCallId: "provider-stable-1", inputTokens: 8, outputTokens: 2 },
  }, aliasRun), true);
  assert.equal(aliases.observeUsageEvent({
    id: "enriched-replay-event",
    type: "assistant.usage",
    data: {
      apiCallId: "api-added-later",
      serviceRequestId: "service-added-later",
      providerCallId: "provider-stable-1",
      inputTokens: 999,
      outputTokens: 999,
    },
  }, aliasRun), false, "an enriched replay escaped provider-call alias dedupe");
  assert.equal(aliases.observeUsageEvent({
    id: "learned-service-replay-event",
    type: "assistant.usage",
    data: { serviceRequestId: "service-added-later", inputTokens: 555, outputTokens: 555 },
  }, aliasRun), false, "a replay alias learned through a matched event was not unioned into the identity set");
  assert.equal(aliases.observeUsageEvent({
    id: "service-event",
    type: "assistant.usage",
    data: { serviceRequestId: "service-stable-2", inputTokens: 4, outputTokens: 1 },
  }, aliasRun), true);
  assert.equal(aliases.observeUsageEvent({
    id: "service-replay-event",
    type: "assistant.usage",
    data: { serviceRequestId: "service-stable-2", inputTokens: 777, outputTokens: 777 },
  }, aliasRun), false, "a service-request replay escaped stable alias dedupe");
  assert.deepEqual(aliases.get(aliasRun)!.usage, { input: 12, output: 3, total: 15 });
  assert.equal(aliases.get(aliasRun)!.nativeCalls, 2);
  assert.doesNotMatch(JSON.stringify(aliases.get(aliasRun)), /provider-stable|service-stable|service-added|api-added/u);

  const partial = runtime.begin({ project: process.cwd(), agent: "partial", kind: "contractor", task: "Measure" });
  runtime.observeUsageEvent({
    id: "partial-usage", type: "assistant.usage", data: { model: "gpt", outputTokens: 7 },
  }, partial);
  assert.deepEqual(runtime.get(partial)!.usage, { output: 7, total: 7 });
  assert.ok(runtime.get(partial)!.usageLowerBounds.includes("total"));
  assert.match(formatCopilotMissionReport(runtime, partial), /total ≥7/u);

  const metadataOnly = runtime.begin({
    project: process.cwd(), agent: "metadata-only", kind: "contractor", task: "Count an opaque native call",
  });
  assert.equal(runtime.observeUsageEvent({
    id: "metadata-only-usage",
    type: "assistant.usage",
    data: { serviceRequestId: "metadata-only-request", model: "gpt-metadata-only" },
  }, metadataOnly), true);
  const metadataSnapshot = runtime.get(metadataOnly)!;
  assert.equal(metadataSnapshot.nativeCalls, 1);
  assert.deepEqual(metadataSnapshot.usage, {});
  assert.deepEqual(new Set(metadataSnapshot.usageLowerBounds),
    new Set(["input", "output", "reasoning", "cacheRead", "cacheWrite", "total"]));
  assert.match(formatCopilotMissionReport(runtime, metadataOnly), /1 native usage event[\s\S]*in — · out —/u);
  assert.doesNotMatch(formatCopilotMissionReport(runtime, metadataOnly), /\b(?:in|out|reason|total) 0\b|cache r\/w 0\/0/u);

  const configured = runtime.begin({
    project: process.cwd(), agent: "configured", kind: "contractor", task: "Use profile model",
    model: "profile-model", modelSource: "configured", reasoningEffort: "none",
  });
  assert.equal(runtime.get(configured)!.modelSource, "configured");
  assert.equal(runtime.get(configured)!.reasoningEffort, "none");

  const aggregateOnly = new CopilotTeamRuntime();
  const aggregateRoot = aggregateOnly.begin({ project: process.cwd(), agent: "lead", kind: "manager", task: "Aggregate" });
  const aggregateChild = aggregateOnly.begin({
    project: process.cwd(), agent: "aggregate-child", kind: "contractor", task: "Aggregate only", parentRunId: aggregateRoot,
  });
  aggregateOnly.childTerminal(aggregateChild, "completed", { totalTokens: 30 });
  aggregateOnly.finishChild(aggregateChild, "completed");
  assert.equal(aggregateOnly.get(aggregateChild)!.nativeCalls, undefined);
  assert.match(formatCopilotMissionReport(aggregateOnly, aggregateRoot), /native aggregate[\s\S]*total 30/u);
});

test("Copilot degraded team view preserves active telemetry and filter-safe last mission history", () => {
  let now = 1_000;
  const runtime = new CopilotTeamRuntime(() => now);
  const project = process.cwd();
  const root = runtime.begin({
    project,
    agent: "contract",
    kind: "utility",
    task: "Inspect C:\\private\\scope.txt with token=FALLBACK-TASK-SECRET",
    model: "profile-model",
    modelSource: "configured",
    reasoningEffort: "none",
  });
  runtime.observeRootModel(root, "provider-model", "high");
  runtime.observeUsageEvent({
    type: "assistant.usage", id: "fallback-root-usage",
    data: { inputTokens: 10, outputTokens: 2, reasoningTokens: 1, cacheReadTokens: 3, cacheWriteTokens: 1 },
  }, root);
  const child = runtime.begin({
    project, agent: "ephemeral-reviewer", kind: "contractor", task: "Review safely", parentRunId: root,
  });
  runtime.attachChild(child, { agentId: "fallback-native-child", model: "child-model" });
  runtime.observeUsageEvent({
    type: "assistant.usage", id: "fallback-child-usage", agentId: "fallback-native-child",
    data: { inputTokens: 20, outputTokens: 4, reasoningTokens: 2, cacheReadTokens: 5, cacheWriteTokens: 1 },
  });
  runtime.childTerminal(child, "completed", { durationMs: 750, totalTokens: 30, totalToolCalls: 2 });
  const active = formatCopilotDegradedTeamView(project, runtime, {
    budgetMs: 700,
    reasons: ["authoritative roster rendering unavailable"],
  });
  assert.match(active, /contract · run copilot-run-1 · utility · working/u);
  assert.match(active, /ephemeral-reviewer · run copilot-run-2[\s\S]*contractor · cleaning/u);
  assert.ok(active.indexOf("● contract") < active.indexOf("↳ ephemeral-reviewer"),
    "degraded activity rendered the child before its root");
  assert.match(active, /provider-model \(observed; also profile-model\)/u);
  assert.match(active, /reasoning effort high \(observed; also none\)/u);
  assert.match(active, /1 native usage event · in 10 · out 2 · reason 1 · cache r\/w 3\/1 · total 12/u);
  assert.match(active, /Native child: duration 00:00\.750 · tool calls 2/u);
  assert.doesNotMatch(active, /private|FALLBACK-TASK-SECRET/u);
  assert.equal((active.match(/bounded snapshot/giu) ?? []).length, 1);
  assert.ok(active.split("\n").every((line) => visibleTextWidth(line) <= 96));

  const historicalReason = formatCopilotDegradedTeamView(project, runtime, { filter: "none" });
  assert.match(historicalReason, /contract · run copilot-run-1/u,
    "a historical reasoning value could not filter active telemetry");
  runtime.finishChild(child, "completed");
  now = 3_000;
  runtime.finish(root, "completed");
  const history = formatCopilotDegradedTeamView(project, runtime, { filter: "none" });
  assert.match(history, /LAST MISSION/u);
  assert.match(history, /Mission total/u);
  assert.doesNotMatch(formatCopilotDegradedTeamView(project, runtime, { filter: "does-not-exist" }), /LAST MISSION/u);
});

test("Copilot usage identity capacity stays bounded and reports omitted telemetry as lower bounds", () => {
  const runtime = new CopilotTeamRuntime();
  const project = process.cwd();
  const root = runtime.begin({ project, agent: "team-lead", kind: "manager", task: "Count bounded usage" });
  for (let index = 0; index < maximumCopilotUsageIdentityKeys; index += 1) {
    assert.equal(runtime.observeUsageEvent({
      type: "assistant.usage", id: `bounded-usage-${index}`,
      data: { inputTokens: 1, outputTokens: 1 },
    }, root), true);
  }
  assert.equal(runtime.observeUsageEvent({
    type: "assistant.usage", id: "bounded-usage-overflow",
    data: { inputTokens: 999, outputTokens: 999 },
  }, root), false);
  const snapshot = runtime.get(root)!;
  assert.equal(snapshot.usageIdentityTruncated, true);
  assert.equal(snapshot.nativeCalls, maximumCopilotUsageIdentityKeys);
  assert.deepEqual(snapshot.usage, {
    input: maximumCopilotUsageIdentityKeys,
    output: maximumCopilotUsageIdentityKeys,
    total: maximumCopilotUsageIdentityKeys * 2,
  });
  assert.deepEqual(new Set(snapshot.usageLowerBounds),
    new Set(["input", "output", "reasoning", "cacheRead", "cacheWrite", "total"]));
  const mutable = (runtime as any).runs.get(root);
  assert.ok(mutable.seenUsageKeys.size <= maximumCopilotUsageIdentityKeys);
  assert.equal(runtime.observeUsageEvent({
    type: "assistant.usage", id: "bounded-usage-0",
    data: { inputTokens: 500, outputTokens: 500 },
  }, root), false, "an early replay incremented counters after saturation");
  assert.equal(runtime.get(root)!.nativeCalls, maximumCopilotUsageIdentityKeys);

  const compact = formatCopilotNativeTelemetry(runtime.get(root)!, false);
  assert.match(compact, /≥4,096 native usage events/u);
  assert.match(compact, /≥8,192 native tokens.*identity capacity reached; later events omitted/u);
  const degraded = formatCopilotDegradedTeamView(project, runtime);
  assert.match(degraded.replace(/\s+/gu, " "),
    /≥4,096 native usage events[\s\S]*in ≥4,096 · out ≥4,096[\s\S]*total ≥8,192/u);
  assert.match(degraded.replace(/\s+/gu, " "), /identity capacity reached; later events omitted/u);
  runtime.finish(root, "completed");
  const mission = formatCopilotMissionReport(runtime, root);
  assert.match(mission, /≥4,096 native usage events[\s\S]*total ≥8,192/u);
  assert.match(mission.replace(/\s+/gu, " "), /identity capacity reached; later events omitted/u);

  const metadataOnly = new CopilotTeamRuntime();
  const metadataRoot = metadataOnly.begin({
    project, agent: "metadata-cap", kind: "contractor", task: "Bound metadata identities",
  });
  for (let index = 0; index < maximumCopilotUsageIdentityKeys; index += 1) {
    metadataOnly.observeUsageEvent({ type: "assistant.usage", id: `metadata-cap-${index}`, data: {} }, metadataRoot);
  }
  metadataOnly.observeUsageEvent({ type: "assistant.usage", id: "metadata-cap-overflow", data: {} }, metadataRoot);
  assert.match(formatCopilotNativeTelemetry(metadataOnly.get(metadataRoot)!),
    /≥4,096 native usage events · token counters unavailable · identity capacity reached; later events omitted/u);
});

test("Copilot degraded team view discloses active-run truncation", () => {
  const runtime = new CopilotTeamRuntime();
  const project = process.cwd();
  for (let index = 0; index < maximumConcurrentCopilotRoots; index += 1) {
    const root = runtime.begin({
      project, agent: `root-${index}`, kind: "contractor", task: "Coordinate bounded work",
    });
    runtime.begin({
      project, agent: `child-${index}`, kind: "contractor", task: "Perform bounded work", parentRunId: root,
    });
  }
  const output = formatCopilotDegradedTeamView(project, runtime);
  assert.match(output, /\+32 matching active runs omitted by this bounded snapshot; filter or retry \/team/u);
  assert.ok(output.indexOf("● root-0") < output.indexOf("↳ child-0"));
});

test("Copilot usage without a stable native identity is truthfully rendered as a lower bound", () => {
  const project = process.cwd();
  const runtime = new CopilotTeamRuntime();
  const root = runtime.begin({ project, agent: "contract", kind: "utility", task: "Count ambiguous usage" });
  const ambiguous = {
    type: "assistant.usage" as const,
    data: { inputTokens: 10, outputTokens: 2 },
  };
  assert.equal(runtime.observeUsageEvent(ambiguous, root), true);
  assert.equal(runtime.observeUsageEvent(structuredClone(ambiguous), root), false,
    "an indistinguishable no-ID replay was counted twice");
  const snapshot = runtime.get(root)!;
  assert.equal(snapshot.usageIdentityAmbiguous, true);
  assert.equal(snapshot.usageIdentityTruncated, false);
  assert.equal(snapshot.nativeCalls, 1);
  assert.deepEqual(snapshot.usage, { input: 10, output: 2, total: 12 });
  assert.deepEqual(new Set(snapshot.usageLowerBounds),
    new Set(["input", "output", "reasoning", "cacheRead", "cacheWrite", "total"]));

  const compact = formatCopilotNativeTelemetry(snapshot, false);
  assert.match(compact, /≥1 native usage event · ≥12 native tokens/u);
  assert.match(compact, /native usage identity unavailable; indistinguishable events deduplicated/u);
  const degraded = formatCopilotDegradedTeamView(project, runtime);
  assert.match(degraded.replace(/\s+/gu, " "),
    /≥1 native usage event[\s\S]*in ≥10 · out ≥2[\s\S]*total ≥12/u);
  assert.match(degraded.replace(/\s+/gu, " "),
    /native usage identity unavailable; indistinguishable events deduplicated/u);

  runtime.finish(root, "completed");
  const mission = formatCopilotMissionReport(runtime, root);
  assert.match(mission, /≥1 native usage event[\s\S]*in ≥10 · out ≥2[\s\S]*total ≥12/u);
  assert.match(mission.replace(/\s+/gu, " "),
    /native usage identity unavailable; indistinguishable events deduplicated/u);

  const terminalRuntime = new CopilotTeamRuntime();
  const terminalRoot = terminalRuntime.begin({ project, agent: "lead", kind: "manager", task: "Coordinate" });
  const child = terminalRuntime.begin({
    project, agent: "worker", kind: "contractor", task: "Count", parentRunId: terminalRoot,
  });
  terminalRuntime.observeUsageEvent(ambiguous, child);
  terminalRuntime.childTerminal(child, "completed", { totalTokens: 30 });
  const childSnapshot = terminalRuntime.get(child)!;
  assert.equal(childSnapshot.usage.total, 30);
  assert.equal(childSnapshot.usageLowerBounds.includes("total"), false,
    "an authoritative terminal total should be exact");
  assert.equal(childSnapshot.usageLowerBounds.includes("input"), true,
    "an aggregate total cannot make ambiguous component counters exact");
  assert.match(formatCopilotNativeTelemetry(childSnapshot),
    /≥1 native usage event · in ≥10 · out ≥2[\s\S]*total 30/u);
});

test("Copilot unverified cross-root usage attribution adds no phantom call or counter", () => {
  const runtime = new CopilotTeamRuntime();
  const root = runtime.begin({
    project: process.cwd(), agent: "team-lead", kind: "manager", task: "Reject ambiguous attribution",
  });
  runtime.markUsageAttributionUnverified(root);
  const snapshot = runtime.get(root)!;
  assert.equal(snapshot.nativeCalls, undefined);
  assert.deepEqual(snapshot.usage, {});
  assert.deepEqual(snapshot.usageLowerBounds, []);
  assert.equal(snapshot.usageAttributionUnverified, true);
  assert.equal(formatCopilotNativeTelemetry(snapshot),
    "native usage attribution unverified; ambiguous counters omitted");
  const mission = formatCopilotMissionReport(runtime, root).replace(/\s+/gu, " ");
  assert.match(mission, /native usage attribution unverified; mission counters incomplete/u);
  assert.doesNotMatch(mission, /≥1 native usage event/u);
});

test("Copilot runtime preserves hierarchy, terminal facts, project isolation, cap32, and double-booking", () => {
  let now = 0;
  const runtime = new CopilotTeamRuntime(() => now, 2);
  const project = process.cwd();
  const root = runtime.begin({ project, agent: "team-lead", kind: "manager", task: "Coordinate" });
  assert.throws(() => runtime.begin({ project, agent: "team-lead", kind: "manager", task: "Again" }), /already working/u);
  const child = runtime.begin({ project, agent: "build", kind: "bundled", task: "Implement", parentRunId: root });
  assert.throws(() => runtime.begin({ project, agent: "build", kind: "bundled", task: "Again", parentRunId: root }), /already working/u,
    "two siblings double-booked one persistent member");
  runtime.attachChild(child, { agentId: "native-child-id", model: "child-model" });
  runtime.observeUsageEvent({
    id: "child-usage",
    type: "assistant.usage",
    agentId: "native-child-id",
    data: {
      model: "child-model",
      inputTokens: 20,
      outputTokens: 4,
      reasoningTokens: 2,
      cacheReadTokens: 3,
      cacheWriteTokens: 1,
    },
  });
  runtime.childTerminal(child, "completed", { model: "child-model", durationMs: 750, totalTokens: 30, totalToolCalls: 2 });
  const aggregatedChild = runtime.get(child)!;
  assert.deepEqual(aggregatedChild.usage, {
    input: 20, output: 4, reasoning: 2, cacheRead: 3, cacheWrite: 1, total: 30,
  });
  assert.deepEqual(new Set(aggregatedChild.usageLowerBounds),
    new Set(["input", "output", "reasoning", "cacheRead", "cacheWrite"]));
  assert.match(formatCopilotMissionReport(runtime, root),
    /1 native usage event[\s\S]*in ≥20 · out ≥4[\s\S]*reason ≥2 · cache r\/w ≥3\/≥1 · total 30/u);
  assert.equal(runtime.get(child)!.state, "cleaning");
  runtime.setState(child, "waiting");
  runtime.setState(child, "working");
  assert.equal(runtime.get(child)!.state, "cleaning", "late host activity resurrected a run during cleanup");
  runtime.finishChild(child, "failed");
  assert.equal(runtime.observeUsageEvent({
    id: "late-child-usage",
    type: "assistant.usage",
    agentId: "native-child-id",
    data: { model: "late-model", inputTokens: 999, outputTokens: 999 },
  }), false, "terminal children must release their native agent correlation");
  runtime.finish(root, "completed");
  assert.equal(runtime.get(child)!.state, "completed");
  assert.equal(runtime.get(child)!.usage.total, 30, "terminal total must replace, not add to, per-call totals");
  assert.equal(runtime.get(child)!.durationMs, 750);
  assert.equal(runtime.get(child)!.totalToolCalls, 2);
  assert.throws(() => runtime.begin({ project, agent: "design", kind: "bundled", task: "Late", parentRunId: root }), /not accepting children/u);
  assert.match(formatCopilotMissionReport(runtime, root), /└─ build/u);
  assert.match(formatCopilotMissionReport(runtime, root), /total 30/u);
  assert.match(formatCopilotMissionReport(runtime, root), /Native child: duration 00:00\.750 · tool calls 2/u);

  const otherProject = join(project, "other");
  const local = runtime.begin({ project, agent: "privacy-reviewer", kind: "personal", task: "Local" });
  const remote = runtime.begin({ project: otherProject, agent: "privacy-reviewer", kind: "personal", task: "Other" });
  assert.ok(runtime.get(local));
  assert.ok(runtime.get(remote));
  assert.equal(runtime.list(otherProject).length, 1);
  runtime.finish(local, "completed");
  runtime.finish(remote, "completed");
  assert.equal(runtime.projectRuns(join(project, "untracked")).length, 0);
  if (process.platform === "win32") assert.ok(runtime.projectRuns(project.toUpperCase()).length > 0);

  const capped = new CopilotTeamRuntime();
  const roots = Array.from({ length: maximumConcurrentCopilotRoots }, (_, index) => capped.begin({
    project, agent: `contractor-${index}`, kind: "contractor", task: "Work",
  }));
  assert.throws(() => capped.begin({ project, agent: "overflow", kind: "contractor", task: "Work" }), /at most 32 concurrent/u);
  capped.finish(roots[0], "completed");
  assert.doesNotThrow(() => capped.begin({ project, agent: "replacement", kind: "contractor", task: "Work" }));
});

test("Copilot team view shows deterministic roster, live hierarchy, filters, and last mission within 96 columns", async () => {
  const rootDirectory = await mkdtemp(join(tmpdir(), "harbor-copilot-team-"));
  const home = join(rootDirectory, "home");
  const project = join(rootDirectory, "project-with-a-deliberately-long-name-界面-😀");
  const previousHome = process.env.COPILOT_HOME;
  process.env.COPILOT_HOME = home;
  try {
    const roster = new Roster(harnessSpec("copilot", home, project));
    await roster.join({
      name: "privacy-reviewer",
      description: "Review privacy boundaries without exposing private evidence",
      prompt: "Review only",
      tools: ["read", "search"],
      model: "gpt-crafter-with-a-very-long-but-valid-configured-model-alias",
    });
    await roster.bench("on build", bundledPlayers);
    const members = await collectCopilotTeamMembers(project);
    assert.ok(members.some(({ id, kind, availability }) => id === "team-lead" && kind === "manager" && availability === "ready"));
    assert.ok(members.some(({ id, kind, availability }) => id === "build" && kind === "bundled" && availability === "ready"));
    assert.ok(members.some(({ id, kind }) => id === "privacy-reviewer" && kind === "personal"));
    assert.equal(members.filter(({ kind }) => kind === "bundled").length, bundledPlayers.size);

    const nativeMembers = await collectCopilotTeamMembers(project, {
      discoveryAvailable: true,
      coordinatorReady: true,
      agents: [
        { id: copilotFixedAgentIds.get("team-lead")!, userInvocable: false },
        {
          id: "privacy-reviewer",
          path: join(project, harnessSpec("copilot", home, project).activeDir, `privacy-reviewer${harnessSpec("copilot", home, project).extension}`),
          userInvocable: true,
        },
      ],
    });
    assert.equal(nativeMembers.find(({ id }) => id === "team-lead")!.availability, "unavailable");
    assert.equal(nativeMembers.find(({ id }) => id === "privacy-reviewer")!.availability, "ready");
    assert.equal(nativeMembers.find(({ id }) => id === "build")!.availability, "unavailable");

    let now = 2_000;
    const runtime = new CopilotTeamRuntime(() => now);
    const root = runtime.begin({
      project, agent: "team-lead", kind: "manager", task: "Coordinate release",
      model: "gpt-host", reasoningEffort: "medium",
    });
    runtime.setState(root, "working");
    const child = runtime.begin({
      project, agent: "privacy-reviewer", kind: "personal", task: "Review C:\\secret\\input.txt", parentRunId: root,
    });
    runtime.attachChild(child, { agentId: "child-private", model: "gpt-child" });

    const view = await formatCopilotTeamView(project, runtime, {
      nextModel: "gpt-host",
      nextReasoning: "medium",
      nextMaxOutputTokens: 32_000,
    });
    assert.match(view, /Agent Harbor Copilot team .*0 model tokens/u);
    assert.match(view, /Enabled specialists: 3 · mission budget: up to 6 sequential delegations/u);
    assert.match(view, /Eligible specialists: crafter, build, privacy-reviewer/u);
    assert.match(view, /Can delegate now: none · child run copilot-run-2 is active/u);
    assert.match(view, /Busy \(double-booking blocked\): privacy-reviewer/u);
    assert.match(view, /SDLC coverage: 1\/6 enabled · 5 benched/u);
    assert.match(view, /team-lead · run copilot-run-1/u);
    assert.match(view, /privacy-reviewer · run copilot-run-2/u);
    assert.match(view, /2 active \(2 working\)/u);
    assert.match(view, /Task: “Review \[path\]”/u);
    assert.match(view, /configured\s+gpt-crafter-with-a-very-long-but-valid-configured-model-alias/u);
    assert.doesNotMatch(view, /secret\\input/u);
    assert.ok(view.split("\n").every((line) => visibleTextWidth(line) <= 96));

    const filtered = await formatCopilotTeamView(project, runtime, { filter: "privacy" });
    assert.match(filtered, /Overall Team/u);
    assert.match(filtered, /privacy-reviewer/u);
    assert.doesNotMatch(filtered, /● crafter ·/u);
    const noMatch = await formatCopilotTeamView(project, runtime, { filter: "does-not-exist" });
    assert.match(noMatch, /Agent Harbor Copilot team · project-with-a-deliberately-long-name/u);
    assert.match(noMatch, /No team member or tracked activity matches/u);
    assert.ok(noMatch.split("\n").every((line) => visibleTextWidth(line) <= 96));
    const gatedNoMatch = await formatCopilotTeamView(project, runtime, {
      filter: "does-not-exist",
      selectionGate: "lifecycle identity is unverified; reload Copilot before delegation",
      native: { agents: [], discoveryAvailable: false, coordinatorReady: false },
    });
    assert.match(gatedNoMatch, /Native agent discovery\/coordinator is not ready/u);
    assert.match(gatedNoMatch, /Selection gate: lifecycle identity is unverified; reload Copilot/u);
    assert.match(gatedNoMatch.replace(/\s+/gu, " "),
      /description, role\/kind, capability, tool, skill, model\/reasoning, status\/state/u);
    assert.ok(gatedNoMatch.split("\n").every((line) => visibleTextWidth(line) <= 96));
    assert.doesNotMatch(filtered, /model max output per response/u,
      "unknown host output limits should be omitted instead of wrapping a lone unknown value");

    const degraded = await formatCopilotTeamView(project, runtime, {
      native: { agents: [], discoveryAvailable: false, coordinatorReady: false },
    });
    assert.match(degraded, /Native agent discovery\/coordinator is not ready/u);
    assert.match(degraded, /Can delegate now: none/u);
    assert.doesNotMatch(degraded, /Can delegate now:.*crafter/u);
    assert.equal((degraded.match(/Repair: reload the Copilot session/gu) ?? []).length, 0,
      "a global discovery failure repeated the same repair on every roster row");

    const cleaningRuntime = new CopilotTeamRuntime(() => now);
    const cleaningRoot = cleaningRuntime.begin({
      project, agent: "team-lead", kind: "manager", task: "Stop safely",
    });
    cleaningRuntime.setState(cleaningRoot, "cleaning");
    assert.throws(() => cleaningRuntime.begin({
      project, agent: "late-worker", kind: "contractor", task: "Must not start", parentRunId: cleaningRoot,
    }), /not accepting children/u);
    assert.throws(() => cleaningRuntime.relabelActiveRoot(cleaningRoot, {
      agent: "contract", kind: "utility", task: "Must not relabel",
    }), /accepting work/u);
    const cleaning = await formatCopilotTeamView(project, cleaningRuntime);
    assert.match(cleaning, /Selection gate: manager run copilot-run-1 is cleaning; wait for its terminal event/u);
    assert.match(cleaning, /Can delegate now: none · manager run copilot-run-1 is cleaning/u);

    runtime.childTerminal(child, "completed", { totalTokens: 12 });
    runtime.finishChild(child, "completed");
    now = 4_000;
    runtime.finish(root, "completed");
    const history = await formatCopilotTeamView(project, runtime);
    assert.match(history, /LAST MISSION/u);
    assert.match(history, /Mission total/u);
    assert.ok(history.split("\n").every((line) => visibleTextWidth(line) <= 96));

    for (let index = 0; index < maximumVisibleCopilotRosterMembers + 4; index += 1) {
      await roster.join({
        name: `member-${String(index).padStart(2, "0")}`,
        description: `Personal teammate ${index}`,
        prompt: "Work deterministically",
        tools: ["read"],
      });
    }
    const crowded = await formatCopilotTeamView(project, runtime);
    assert.match(crowded, /\+\d+ more roster members; use \/team <filter>/u);
    assert.ok((crowded.match(/ · personal · /gu) ?? []).length <= maximumVisibleCopilotRosterMembers);
  } finally {
    if (previousHome === undefined) delete process.env.COPILOT_HOME;
    else process.env.COPILOT_HOME = previousHome;
  }
});

test("Copilot public labels bound Unicode and reject terminal-row injection", () => {
  assert.equal(copilotTaskLabel(" \n\t "), "(task not disclosed)");
  assert.ok([...copilotTaskLabel("😀".repeat(500))].length <= 72);
  for (const [input, forbidden] of [
    ['Inspect "/home/alice/private.txt"', /home|alice|private\.txt/u],
    ["Inspect 'src/private.ts'", /src|private\.ts/u],
    ["Inspect (./secret.env)", /secret\.env/u],
    ["password=Sup3rSecretValue123", /Sup3rSecretValue123/u],
  ] as const) {
    assert.doesNotMatch(copilotTaskLabel(input), forbidden);
  }
  const identifier = copilotPublicIdentifier("gpt\u001b[31m\n● forged-member\u202eoverride");
  assert.doesNotMatch(identifier!, /\u001b|\u202e|\n/u);
  assert.doesNotMatch(identifier!, /^● forged-member/mu);

  const injectedProject = join(process.cwd(), "safe\u001b[31m\n● forged-project");
  const degraded = formatCopilotDegradedTeamView(injectedProject, new CopilotTeamRuntime());
  assert.doesNotMatch(degraded, /\u001b|\u202e/u);
  assert.doesNotMatch(degraded, /^● forged-project/mu);
  assert.ok(degraded.split("\n").every((line) => visibleTextWidth(line) <= 96));
});
