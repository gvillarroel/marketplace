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
  maximumCopilotTeamOverviewLines,
  maximumVisibleCopilotOverviewRosterMembers,
} from "../src/adapters/copilot-team-view.js";
import { copilotFixedAgentIds } from "../src/adapters/copilot-coordinator.js";
import { bundledPlayers, rolePlayers, scoutPlayer } from "../src/core/defaults.js";
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

test("Copilot reused native agent identities fail closed instead of remapping active children", () => {
  const runtime = new CopilotTeamRuntime();
  const root = runtime.begin({ project: process.cwd(), agent: "lead", kind: "manager", task: "Coordinate" });
  const first = runtime.begin({
    project: process.cwd(), agent: "first", kind: "contractor", task: "First", parentRunId: root,
  });
  const second = runtime.begin({
    project: process.cwd(), agent: "second", kind: "contractor", task: "Second", parentRunId: root,
  });
  runtime.attachChild(first, { agentId: "reused-native-agent" });
  runtime.attachChild(second, { agentId: "reused-native-agent" });

  assert.equal(runtime.get(first)!.usageAttributionUnverified, true);
  assert.equal(runtime.get(second)!.usageAttributionUnverified, true);
  assert.equal(runtime.observeUsageEvent({
    type: "assistant.usage",
    id: "ambiguous-usage",
    agentId: "reused-native-agent",
    data: { inputTokens: 99, outputTokens: 1 },
  }), false);
  assert.deepEqual(runtime.get(first)!.usage, {});
  assert.deepEqual(runtime.get(second)!.usage, {});
});

test("Copilot malformed and huge native usage envelopes are bounded and never throw", () => {
  const runtime = new CopilotTeamRuntime();
  const root = runtime.begin({ project: process.cwd(), agent: "lead", kind: "manager", task: "Observe" });
  const huge = `${"x".repeat(2_000_000)}private-suffix-must-not-survive`;
  assert.doesNotThrow(() => assert.equal(runtime.observeUsageEvent({
    type: "assistant.usage",
    id: huge,
    timestamp: huge,
    data: {
      apiCallId: huge,
      model: huge,
      inputTokens: 1,
      outputTokens: 0,
      cost: Number.MAX_VALUE,
      copilotUsage: { totalNanoAiu: 1 },
    },
  }, root), true));
  assert.doesNotMatch(JSON.stringify(runtime.get(root)), /private-suffix|x{500}/u);

  assert.equal(runtime.observeUsageEvent({
    type: "assistant.usage",
    agentId: huge,
    data: { inputTokens: 999, outputTokens: 1 },
  }, root), false);
  assert.equal(runtime.get(root)!.usageAttributionUnverified, true);

  const bigintEnvelope: any = {
    type: "assistant.usage",
    id: 1n,
    data: { inputTokens: 1n, outputTokens: 0n, cost: 2n },
  };
  assert.doesNotThrow(() => runtime.observeUsageEvent(bigintEnvelope, root));
  const throwingData: any = {};
  Object.defineProperty(throwingData, "inputTokens", { enumerable: true, get: () => { throw new Error("host getter failed"); } });
  assert.doesNotThrow(() => assert.equal(runtime.observeUsageEvent({
    type: "assistant.usage", id: "throwing", data: throwingData,
  } as any, root), false));
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

test("Copilot terminal totals win incompatible per-call breakdowns", () => {
  const runtime = new CopilotTeamRuntime();
  const run = runtime.begin({ project: process.cwd(), agent: "worker", kind: "contractor", task: "Count" });
  runtime.observeUsageEvent({
    type: "assistant.usage",
    id: "conflicting-call",
    data: { inputTokens: 14, outputTokens: 6 },
  }, run);
  runtime.childTerminal(run, "completed", { totalTokens: 15 });
  const snapshot = runtime.get(run)!;
  assert.deepEqual(snapshot.usage, { total: 15 });
  assert.deepEqual(snapshot.usageLowerBounds, []);
  assert.equal(snapshot.usageAggregateConflict, true);
  assert.equal(runtime.observeUsageEvent({
    type: "assistant.usage",
    id: "late-incompatible-call",
    data: { inputTokens: 999, outputTokens: 999 },
  }, run), false);
  const report = formatCopilotMissionReport(runtime, run).replace(/\s+/gu, " ");
  assert.match(report, /total 15/u);
  assert.match(report, /terminal total conflicted with per-call counters; token breakdown omitted/u);
  assert.doesNotMatch(report, /in 14|out 6/u);
});

test("Copilot billing telemetry is native, deduplicated, lower-bounded, and mission-scoped", () => {
  const runtime = new CopilotTeamRuntime();
  const root = runtime.begin({ project: process.cwd(), agent: "lead", kind: "manager", task: "Coordinate" });
  const first = {
    type: "assistant.usage" as const,
    id: "billing-first",
    data: {
      providerCallId: "provider-billing-1",
      inputTokens: 10,
      outputTokens: 2,
      cost: 1.25,
      copilotUsage: { totalNanoAiu: 100 },
    },
  };
  assert.equal(runtime.observeUsageEvent(first, root), true);
  assert.equal(runtime.observeUsageEvent({
    ...structuredClone(first),
    id: "billing-first-replay",
    data: { ...first.data, cost: 999, copilotUsage: { totalNanoAiu: 999 } },
  }, root), false);
  assert.equal(runtime.observeUsageEvent({
    type: "assistant.usage",
    id: "billing-missing-fields",
    data: { inputTokens: 3, outputTokens: 1 },
  }, root), true);
  const child = runtime.begin({
    project: process.cwd(), agent: "worker", kind: "contractor", task: "Work", parentRunId: root,
  });
  runtime.observeUsageEvent({
    type: "assistant.usage",
    id: "billing-child",
    data: { inputTokens: 4, outputTokens: 2, cost: 0.5, copilotUsage: { totalNanoAiu: 25 } },
  }, child);

  assert.deepEqual(runtime.get(root)!.billing, { modelMultiplier: 1.25, totalNanoAiu: 100 });
  assert.deepEqual(new Set(runtime.get(root)!.billingLowerBounds), new Set(["modelMultiplier", "totalNanoAiu"]));
  assert.deepEqual(runtime.get(child)!.billing, { modelMultiplier: 0.5, totalNanoAiu: 25 });
  assert.deepEqual(runtime.missionBilling(root), { modelMultiplier: 1.75, totalNanoAiu: 125 });
  assert.deepEqual(new Set(runtime.missionBillingLowerBounds(root)), new Set(["modelMultiplier", "totalNanoAiu"]));
  const report = formatCopilotMissionReport(runtime, root).replace(/\s+/gu, " ");
  assert.match(report, /model-multiplier cost ≥1\.25 · nano AIU ≥100/u);
  assert.match(report, /model-multiplier cost 0\.5 · nano AIU 25/u);
  assert.match(report, /Mission total .*model-multiplier cost ≥1\.75 · nano AIU ≥125/u);
  assert.doesNotMatch(report, /USD|dollars?|currency/iu);
});

test("Copilot counters saturate safely and mark hostile or overflowing native values as uncertain", () => {
  const runtime = new CopilotTeamRuntime();
  const run = runtime.begin({ project: process.cwd(), agent: "worker", kind: "contractor", task: "Count safely" });
  for (const [id, inputTokens] of [["huge-1", Number.MAX_SAFE_INTEGER], ["huge-2", 1]] as const) {
    assert.equal(runtime.observeUsageEvent({
      type: "assistant.usage",
      id,
      data: {
        inputTokens,
        outputTokens: 0,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        cost: Number.MAX_VALUE,
        copilotUsage: { totalNanoAiu: inputTokens },
      },
    }, run), true);
  }
  assert.equal(runtime.observeUsageEvent({
    type: "assistant.usage",
    id: "invalid-native-numbers",
    data: {
      inputTokens: 1e308,
      outputTokens: Number.POSITIVE_INFINITY,
      reasoningTokens: Number.NaN,
      cost: Number.POSITIVE_INFINITY,
      copilotUsage: { totalNanoAiu: 1.5 },
    },
  }, run), true);

  const snapshot = runtime.get(run)!;
  assert.equal(snapshot.usage.input, Number.MAX_SAFE_INTEGER);
  assert.equal(snapshot.usage.total, Number.MAX_SAFE_INTEGER);
  assert.equal(snapshot.billing.modelMultiplier, Number.MAX_VALUE);
  assert.equal(snapshot.billing.totalNanoAiu, Number.MAX_SAFE_INTEGER);
  assert.ok(snapshot.usageLowerBounds.includes("input"));
  assert.ok(snapshot.usageLowerBounds.includes("total"));
  assert.ok(snapshot.billingLowerBounds.includes("modelMultiplier"));
  assert.ok(snapshot.billingLowerBounds.includes("totalNanoAiu"));
  const report = formatCopilotMissionReport(runtime, run);
  assert.doesNotMatch(`${JSON.stringify(snapshot)}\n${report}`, /Infinity|NaN|∞/u);
  assert.match(report, /model-multiplier cost\s+≥1\.797693e\+308/u);
  assert.match(report, /nano AIU ≥/u);
});

test("Copilot terminal retention preserves the latest mission per recent project", () => {
  const runtime = new CopilotTeamRuntime(Date.now, 2);
  const projectA = join(process.cwd(), "retention-a");
  const projectB = join(process.cwd(), "retention-b");
  const a = runtime.begin({ project: projectA, agent: "a", kind: "contractor", task: "A" });
  runtime.finish(a, "completed");
  const b1 = runtime.begin({ project: projectB, agent: "b1", kind: "contractor", task: "B1" });
  runtime.finish(b1, "completed");
  const b2 = runtime.begin({ project: projectB, agent: "b2", kind: "contractor", task: "B2" });
  runtime.finish(b2, "completed");
  assert.ok(runtime.get(a), "a noisy second project evicted the only retained mission for project A");
  assert.equal(runtime.get(b1), undefined);
  assert.ok(runtime.get(b2));
  assert.equal(runtime.projectRuns(projectA).length + runtime.projectRuns(projectB).length, 2);
});

test("Copilot team view shows deterministic roster, live hierarchy, filters, and last mission within 96 columns", async () => {
  const rootDirectory = await mkdtemp(join(tmpdir(), "harbor-copilot-team-"));
  const home = join(rootDirectory, "home");
  const project = join(rootDirectory, "project-with-a-deliberately-long-name-界面-😀");
  const previousHome = process.env.COPILOT_HOME;
  process.env.COPILOT_HOME = home;
  try {
    const roster = new Roster(harnessSpec("copilot", home, project));
    const baseOverview = await formatCopilotTeamView(project, new CopilotTeamRuntime(), {
      nextModel: "gpt-host",
      nextReasoning: "medium",
    });
    const baseIds = [...rolePlayers.keys(), scoutPlayer.name, ...bundledPlayers.keys()];
    for (const id of baseIds) assert.match(baseOverview, new RegExp(`^[●○!] ${id}(?: \\(\\/scout\\))? ·`, "mu"));
    assert.equal((baseOverview.match(/^[●○!] .* · (?:manager|fixed|utility|bundled) · /gmu) ?? []).length, baseIds.length);
    assert.match(baseOverview, /^Team:/mu);
    assert.match(baseOverview, /^Host default: gpt-host \(inherited\) · reasoning medium$/mu);
    assert.match(baseOverview, /^LEAD ACCESS$/mu);
    assert.match(baseOverview, /^ACTIVITY$/mu);
    assert.match(baseOverview, /^Commands:/mu);
    assert.doesNotMatch(baseOverview, /Capacity:|Repair:/u);
    assert.ok(baseOverview.split("\n").length <= 30, baseOverview);
    assert.ok(baseOverview.split("\n").every((line) => visibleTextWidth(line) <= 96));
    const noModelOverview = await formatCopilotTeamView(project, new CopilotTeamRuntime(), {
      nextModelUnreported: true,
    });
    assert.match(noModelOverview, /Host default: no model reported \(unobserved\)/u);
    assert.doesNotMatch(noModelOverview, /unknown\/default/u);

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
    runtime.observeUsageEvent({
      type: "assistant.usage",
      id: "root-usage",
      data: { inputTokens: 3, outputTokens: 2 },
    }, root);
    runtime.markUsageAttributionUnverified(child);

    const view = await formatCopilotTeamView(project, runtime, {
      nextModel: "gpt-host",
      nextReasoning: "medium",
      nextMaxOutputTokens: 32_000,
    });
    assert.match(view, /Agent Harbor Copilot team .*0 model tokens/u);
    assert.match(view, /Enabled specialists: 3 · 6 sequential delegations · Can delegate now: none/u);
    assert.match(view, /Selection gate: child run copilot-run-2 is active/u);
    assert.match(view, /Busy \(double-booking blocked\): privacy-reviewer/u);
    assert.match(view, /SDLC coverage: 1\/6 enabled · 5 benched/u);
    assert.match(view, /team-lead · copilot-run-1 · working/u);
    assert.match(view, /privacy-reviewer · copilot-run-2 · working/u);
    assert.match(view, /gpt-host \(inherited\) · calls 1 · tok 5/u);
    assert.match(view, /gpt-child \(observed\) · tok — \(unverified\)/u);
    assert.match(view, /2 active \(2 working\)/u);
    assert.doesNotMatch(view, /Task:|Capacity:|configured\s+gpt-crafter/u);
    assert.match(view, /Details: \/team member:<id> · activity\/history: \/team run:<id>/u);
    assert.doesNotMatch(view, /secret\\input/u);
    assert.ok(view.split("\n").length <= 30, view);
    assert.ok(view.split("\n").every((line) => visibleTextWidth(line) <= 96));

    const filtered = await formatCopilotTeamView(project, runtime, { filter: "privacy" });
    assert.match(filtered, /Overall Team/u);
    assert.match(filtered, /privacy-reviewer/u);
    assert.doesNotMatch(filtered, /● crafter ·/u);
    assert.match(filtered, /Enabled specialists: 3 · mission budget: up to 6 sequential delegations/u);
    assert.match(filtered, /Eligible specialists: crafter, build, privacy-reviewer/u);
    assert.match(filtered, /Can delegate now: none · child run copilot-run-2 is active/u);
    assert.match(filtered, /Task: “Review \[path\]”/u);
    assert.match(filtered, /configured\s+gpt-crafter-with-a-very-long-but-valid-configured-model-alias/u);

    const textFilter = await formatCopilotTeamView(project, runtime, { filter: "read" });
    assert.match(textFilter, /^● crafter · fixed · ready$/mu);
    assert.match(textFilter, /^● privacy-reviewer · personal · working$/mu);
    assert.doesNotMatch(textFilter, /^● team-lead · manager · ready$/mu,
      "text read must not partially match categorical ready");
    const readyFilter = await formatCopilotTeamView(project, runtime, { filter: "ready" });
    assert.match(readyFilter, /^● team-lead · manager · working$/mu);
    assert.match(readyFilter, /^● privacy-reviewer · personal · working$/mu);
    const workingFilter = await formatCopilotTeamView(project, runtime, { filter: "working" });
    assert.match(workingFilter, /^● team-lead · run copilot-run-1.* · working ·/mu);
    assert.match(workingFilter, /^↳ privacy-reviewer · run copilot-run-2.* · working ·/mu);
    assert.match(workingFilter, /No roster member matches this filter/u);
    assert.match(await formatCopilotTeamView(project, runtime, { filter: "person" }),
      /No team member or tracked activity matches/u,
      "partial categorical values must not match");
    assert.match(await formatCopilotTeamView(project, runtime, { filter: "personal" }),
      /^● privacy-reviewer · personal · working$/mu);

    const toolFilter = await formatCopilotTeamView(project, runtime, { filter: "tool:read" });
    assert.match(toolFilter, /^● privacy-reviewer · personal · working$/mu);
    assert.match(await formatCopilotTeamView(project, runtime, { filter: "tool:privacy" }),
      /No team member or tracked activity matches/u,
      "tool filters must not search member IDs or descriptions");
    assert.match(await formatCopilotTeamView(project, runtime, { filter: "capability:recruit" }),
      /^● talent-scout \(\/scout\) · utility · ready$/mu);
    assert.match(await formatCopilotTeamView(project, runtime, { filter: "skill:zx-example" }),
      /^● crafter · fixed · ready$/mu);
    const statusReady = await formatCopilotTeamView(project, runtime, { filter: "status:ready" });
    assert.match(statusReady, /^● crafter · fixed · ready$/mu);
    assert.doesNotMatch(statusReady, /^● team-lead · manager/mu);
    assert.doesNotMatch(statusReady, /^● privacy-reviewer · personal/mu);
    const stateWorking = await formatCopilotTeamView(project, runtime, { filter: "state:working" });
    assert.match(stateWorking, /^● team-lead · copilot-run-1 · working ·/mu);
    assert.match(stateWorking, /^● team-lead · manager · working$/mu);
    assert.match(stateWorking, /^● privacy-reviewer · personal · working$/mu);
    assert.doesNotMatch(stateWorking, /^● crafter · fixed/mu);
    assert.match(await formatCopilotTeamView(project, runtime, { filter: "status:work" }),
      /No team member or tracked activity matches/u,
      "status and state filters require exact categorical values");
    assert.match(await formatCopilotTeamView(project, runtime, { filter: "model:gpt-child" }),
      /^↳ privacy-reviewer · run copilot-run-2/mu);
    assert.match(await formatCopilotTeamView(project, runtime, { filter: "reasoning:medium" }),
      /^● team-lead · run copilot-run-1/mu);
    assert.match(await formatCopilotTeamView(project, runtime, { filter: "task:coordinate" }),
      /^● team-lead · run copilot-run-1/mu);
    assert.match(await formatCopilotTeamView(project, runtime, { filter: "run:copilot-run-2" }),
      /^↳ privacy-reviewer · run copilot-run-2/mu);
    assert.match(await formatCopilotTeamView(project, runtime, { filter: "member:privacy" }),
      /^● privacy-reviewer · personal · working$/mu);
    assert.match(await formatCopilotTeamView(project, runtime, { filter: "id:privacy" }),
      /^● privacy-reviewer · personal · working$/mu);
    assert.match(await formatCopilotTeamView(project, runtime, { filter: "kind:personal" }),
      /^● privacy-reviewer · personal · working$/mu);
    assert.match(await formatCopilotTeamView(project, runtime, { filter: "role:manager" }),
      /^● team-lead · manager · working$/mu);
    assert.match(await formatCopilotTeamView(project, runtime, { filter: "description:privacy boundaries" }),
      /^● privacy-reviewer · personal · working$/mu);
    assert.match(await formatCopilotTeamView(project, runtime, { filter: "run:privacy" }),
      /No team member or tracked activity matches/u,
      "run filters must not search the agent field");

    const flattenedOverviewFooter = view.replace(/\s+/gu, " ");
    assert.match(flattenedOverviewFooter, /Commands: \/<id> <task> · \/team help\|<filter>\|stop <run\|all>/u);
    assert.match(flattenedOverviewFooter, /\/bench · \/join · \/retire · \/scout · \/contract · \/list-skills/u);
    const flattenedDetailFooter = filtered.replace(/\s+/gu, " ");
    assert.match(flattenedDetailFooter, /Commands: \/team \[filter\] · \/team help\|--help/u);
    assert.match(flattenedDetailFooter, /\/list-skills \[--descriptions\|-d\] \[filter\]/u);
    assert.match(flattenedDetailFooter, /\/bench list \[filter\] · \/bench on\|off <id\.\.\.>/u);
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
    assert.match(cleaning, /Can delegate now: none/u);

    runtime.childTerminal(child, "completed", { totalTokens: 12 });
    runtime.finishChild(child, "completed");
    now = 4_000;
    runtime.finish(root, "completed");
    const history = await formatCopilotTeamView(project, runtime);
    assert.match(history, /LAST MISSION/u);
    assert.match(history.replace(/\s+/gu, " "), /Mission: 2 tracked runs · total ≥17 native tokens · attribution unverified · details: \/team run:copilot-run-1/u);
    assert.ok(history.split("\n").every((line) => visibleTextWidth(line) <= 96));

    for (let index = 0; index < maximumVisibleCopilotOverviewRosterMembers + 4; index += 1) {
      await roster.join({
        name: `member-${String(index).padStart(2, "0")}`,
        description: `Personal teammate ${index}`,
        prompt: "Work deterministically",
        tools: ["read"],
      });
    }
    const crowded = await formatCopilotTeamView(project, runtime);
    for (const id of baseIds) assert.match(crowded, new RegExp(`^[●○!] ${id}\\b`, "mu"));
    const shownPersonal = (crowded.match(/^[●○!] member-\d+ · personal · ready$/gmu) ?? []).length;
    assert.ok(shownPersonal <= maximumVisibleCopilotOverviewRosterMembers - baseIds.length);
    const totalPersonal = maximumVisibleCopilotOverviewRosterMembers + 4 + 1;
    assert.match(crowded, new RegExp(`\\+${totalPersonal - shownPersonal} personal members omitted`, "u"));
    assert.match(crowded, /use \/team kind:personal or \/team member:<id>/u);
    assert.ok(crowded.split("\n").length <= maximumCopilotTeamOverviewLines,
      `crowded Copilot overview exceeded ${maximumCopilotTeamOverviewLines} wrapped lines`);
    const crowdedDetail = await formatCopilotTeamView(project, runtime, { filter: "member:member-15" });
    assert.match(crowdedDetail, /^● member-15 · personal · ready$/mu);
    assert.match(crowdedDetail, /Capacity: read · model: inherits the Copilot host when run/u);
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
