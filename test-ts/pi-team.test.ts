import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { bundledPlayers, rolePlayers, scoutPlayer } from "../src/core/defaults.js";
import { Roster } from "../src/core/lifecycle.js";
import { harnessSpec } from "../src/core/profiles.js";
import { visibleTextWidth, wrapPlainLine } from "../src/core/text-layout.js";
import {
  formatPiLiveWidget,
  formatPiLiveStatus,
  formatPiMissionReport,
  maximumPiObservedMessages,
  PiTeamRuntime,
  piTaskLabel,
  settlePiRootPromises,
} from "../src/adapters/pi-team-runtime.js";
import {
  formatPiTeamView,
  maximumPiTeamOverviewLines,
  maximumVisiblePiOverviewRosterMembers,
  maximumVisiblePiRosterMembers,
} from "../src/adapters/pi-team-view.js";
import { PiOrchestrator } from "../src/orchestrators/pi.js";

const definition = { name: "worker", description: "Worker", prompt: "Work", tools: ["read"] as const, task: "Do it" };

test("terminal wrapping uses real columns and never splits graphemes or ANSI controls", () => {
  const wide = "界".repeat(60);
  assert.equal(visibleTextWidth(wide), 120);
  assert.deepEqual(wrapPlainLine(wide), ["界".repeat(48), `  ${"界".repeat(12)}`]);

  const emoji = "🙂".repeat(60);
  assert.equal(visibleTextWidth(emoji), 120);
  assert.deepEqual(wrapPlainLine(emoji), ["🙂".repeat(48), `  ${"🙂".repeat(12)}`]);

  const combining = "e\u0301".repeat(100);
  assert.equal(visibleTextWidth(combining), 100);
  assert.deepEqual(wrapPlainLine(combining), ["e\u0301".repeat(96), `  ${"e\u0301".repeat(4)}`]);

  const colored = `${"a".repeat(94)}\x1b[31mbbb\x1b[0m`;
  assert.equal(visibleTextWidth(colored), 97);
  assert.deepEqual(wrapPlainLine(colored), [
    `${"a".repeat(94)}\x1b[31mbb`,
    "  b\x1b[0m",
  ]);
  assert.ok(wrapPlainLine(colored).every((line) => !line.endsWith("\x1b[")), "an ANSI CSI sequence was split");

  const hyperlink = `${"a".repeat(95)}\x1b]8;;https://example.test\x07X\x1b]8;;\x07Y`;
  assert.equal(visibleTextWidth(hyperlink), 97);
  assert.deepEqual(wrapPlainLine(hyperlink), [
    `${"a".repeat(95)}\x1b]8;;https://example.test\x07X`,
    "  \x1b]8;;\x07Y",
  ]);
  assert.equal(visibleTextWidth("\x1b(0qq\x1b(B"), 2, "a three-byte terminal escape was counted as text");

  assert.deepEqual(
    wrapPlainLine(`${" ".repeat(96)}X`),
    [`${" ".repeat(94)}X`],
    "oversized indentation must be bounded and make progress",
  );
  const truncatedCsi = `${"a".repeat(95)}\x1b[31`;
  assert.equal(visibleTextWidth(truncatedCsi), 97);
  assert.deepEqual(wrapPlainLine(truncatedCsi), [`${"a".repeat(95)}3`, "  1"]);
  assert.doesNotMatch(wrapPlainLine(truncatedCsi).join("\n"), /\x1b/u);

  const truncatedOsc = `${"a".repeat(95)}\x1b]8;;https://x${"界".repeat(10)}`;
  const sanitizedOsc = wrapPlainLine(truncatedOsc);
  assert.ok(sanitizedOsc.every((line) => visibleTextWidth(line) <= 96));
  assert.doesNotMatch(sanitizedOsc.join("\n"), /\x1b/u);
  assert.match(sanitizedOsc.join("\n"), /界{5}/u, "payload after an incomplete OSC introducer was hidden");
});

test("PiTeamRuntime keeps bounded safe tasks and deduplicates native usage without inventing unknown fields", () => {
  let now = 1_000;
  const runtime = new PiTeamRuntime(() => now);
  const runId = runtime.begin({
    project: process.cwd(),
    agent: "team-lead",
    kind: "manager",
    task: "Inspect C:\\private\\customer\\records.txt and src/private.ts using token-secret-abcdefghijklmnop and https://internal.example/data then report a deliberately very long outcome label",
    model: { provider: "requested", id: "alias" },
    thinking: "low",
  });
  assert.deepEqual(runtime.get(runId)!.model, { provider: "requested", id: "alias" });
  assert.equal(runtime.get(runId)!.modelSource, "inherited");
  const observer = runtime.observer(runId);
  observer.sessionStarted();
  assert.match(formatPiLiveWidget(runtime, runId).join("\n"), /requested\/alias \(inherited\) · thinking setting low/u);
  const first = {
    role: "assistant",
    provider: "openai-codex",
    model: "requested-router-alias",
    responseModel: "gpt-effective",
    stopReason: "toolUse",
    content: [{ type: "thinking", thinking: "private chain of thought" }, { type: "text", text: "evidence" }],
    usage: { input: 100, output: 20, cacheRead: 5, cacheWrite: 1, totalTokens: 126 },
  };
  observer.messageEnd(first);
  observer.messageEnd(first);
  observer.messageEnd(structuredClone(first));
  observer.messageEnd({
    ...first,
    timestamp: 2,
    stopReason: "stop",
    content: [{ type: "text", text: "done" }],
    usage: { input: 50, output: 10, reasoning: 3, cacheRead: 2, cacheWrite: 0, totalTokens: 62 },
  });
  now = 4_000;
  observer.state("completed");

  const run = runtime.get(runId)!;
  assert.equal(run.nativeMessages, 2, "same message_end object or clone was counted more than once");
  assert.deepEqual(run.usage, { input: 150, output: 30, reasoning: 3, cacheRead: 7, cacheWrite: 1, total: 188 });
  assert.deepEqual(run.usageLowerBounds, ["reasoning"], "known usage after an unknown turn must remain a lower bound");
  assert.deepEqual(run.model, { provider: "openai-codex", id: "gpt-effective" });
  assert.equal(run.modelSource, "observed");
  assert.equal(run.elapsedMs, 3_000);
  assert.match(run.task, /\[path\]/u);
  assert.match(run.task, /\[redacted\]/u);
  assert.ok([...run.task].length <= 72);
  const serialized = JSON.stringify(run);
  assert.doesNotMatch(serialized, /private chain of thought|customer|private\.ts|internal\.example|abcdefghijklmnop/u);
});

test("PiTeamRuntime preserves configured model provenance until Pi observes a response model", () => {
  const runtime = new PiTeamRuntime();
  const runId = runtime.begin({
    project: process.cwd(),
    agent: "configured-worker",
    kind: "personal",
    task: "Use the configured route",
    model: { provider: "router", id: "special" },
    modelSource: "configured",
  });
  const observer = runtime.observer(runId);
  observer.sessionStarted({ model: { provider: "router", id: "special" } });
  assert.equal(runtime.get(runId)!.modelSource, "configured");
  assert.match(formatPiLiveWidget(runtime, runId).join("\n"), /router\/special \(configured\)/u);
  observer.messageEnd({
    role: "assistant", responseId: "configured-response", provider: "router", model: "special",
    usage: { input: 2, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 3 },
  });
  assert.equal(runtime.get(runId)!.modelSource, "observed");
});

test("PiTeamRuntime distinguishes equal-shape response-less messages while deduplicating transcript clones", () => {
  const runtime = new PiTeamRuntime();
  const runId = runtime.begin({ project: process.cwd(), agent: "worker", kind: "contractor", task: "Observe" });
  const aa = {
    role: "assistant",
    timestamp: 1_234,
    provider: "router",
    model: "same-model",
    stopReason: "stop",
    content: [{ type: "text", text: "aa" }],
    usage: { input: 7, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 8 },
  };
  const bb = structuredClone(aa);
  bb.content[0].text = "bb";

  assert.equal(runtime.observeMessageEnd(runId, aa), true);
  assert.equal(runtime.observeMessageEnd(runId, structuredClone(aa)), false, "an event/transcript clone was counted twice");
  assert.equal(runtime.observeMessageEnd(runId, bb), true, "same-shape distinct text collided with the first message");
  assert.equal(runtime.observeMessageEnd(runId, structuredClone(bb)), false, "the second transcript clone was counted twice");

  const run = runtime.get(runId)!;
  assert.equal(run.nativeMessages, 2);
  assert.deepEqual(run.usage, { input: 14, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 16 });
  assert.doesNotMatch(JSON.stringify(run), /aa|bb/u, "message content escaped into the public runtime snapshot");
});

test("PiTeamRuntime preserves hierarchy, strict mission totals, project isolation, and cleanup failure", () => {
  let now = 0;
  const runtime = new PiTeamRuntime(() => now);
  const root = runtime.begin({ project: process.cwd(), agent: "team-lead", kind: "manager", task: "Coordinate" });
  const child = runtime.begin({ project: process.cwd(), agent: "build", kind: "bundled", task: "Implement", parentRunId: root });
  runtime.observer(root).sessionStarted({ model: { provider: "p", id: "lead" }, thinking: "minimal" });
  runtime.observer(child).sessionStarted({ model: { provider: "p", id: "worker" }, thinking: "high" });
  runtime.observeMessageEnd(root, {
    role: "assistant", responseId: "lead-1", provider: "p", model: "lead",
    usage: { input: 10, output: 2, reasoning: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 12 },
  });
  assert.match(formatPiLiveStatus(runtime, root), /≥12 tok/u);
  runtime.observeMessageEnd(child, {
    role: "assistant", responseId: "child-1", provider: "p", model: "worker",
    usage: { input: 20, output: 4, reasoning: 2, cacheRead: 3, cacheWrite: 1, totalTokens: 28 },
  });
  now = 2_000;
  runtime.setState(root, "completed");
  runtime.setState(root, "cleanup-error");
  runtime.setState(child, "completed");
  assert.equal(runtime.get(root)!.state, "cleanup-error", "cleanup-error did not prevail over a premature completed state");
  assert.deepEqual(runtime.missionUsage(root), {
    input: 30, output: 6, reasoning: 3, cacheRead: 3, cacheWrite: 1, total: 40,
  });
  const report = formatPiMissionReport(runtime, root);
  assert.match(report, /team-lead · run pi-run-1 · manager · cleanup-error/u);
  assert.match(report, /Task: “Coordinate”/u);
  assert.match(report, /└─ build · run pi-run-2 · parent pi-run-1 · bundled · completed/u);
  assert.match(report, /Task: “Implement”/u);
  assert.match(report, /Mission total .*total 40/u);
  const widget = formatPiLiveWidget(runtime, root).join("\n");
  assert.match(widget, /team-lead · run pi-run-1 · cleanup-error · p\/lead \(observed\) · thinking setting minimal/u);
  assert.match(widget, /└─ build · run pi-run-2 · completed · p\/worker \(observed\) · thinking setting high/u);
  assert.match(widget, /Task: “Coordinate” · model turns 1 · 12 native tokens/u);
  assert.match(widget, /run pi-run-1/u);
  assert.match(widget, /Alt\+H: stop active Agent Harbor work/u);
  assert.equal(runtime.activeProjectRuns(join(process.cwd(), "other")).length, 0);
  if (process.platform === "win32") assert.equal(runtime.projectRuns(process.cwd().toUpperCase()).length, 2);
});

test("PiTeamRuntime never prunes active roots and retains only bounded terminal history", () => {
  let now = 0;
  const runtime = new PiTeamRuntime(() => now, 1);
  const first = runtime.begin({ project: process.cwd(), agent: "first", kind: "contractor", task: "First" });
  now = 1;
  const second = runtime.begin({ project: process.cwd(), agent: "second", kind: "contractor", task: "Second" });
  assert.ok(runtime.get(first));
  assert.ok(runtime.get(second));
  runtime.finishIfOpen(first, "completed");
  assert.ok(runtime.get(first), "the only terminal root should remain while another root is active");
  runtime.finishIfOpen(second, "completed");
  assert.equal(runtime.get(first), undefined, "the oldest terminal history was not pruned");
  assert.equal(runtime.get(second)?.state, "completed");
});

test("PiTeamRuntime rejects cross-project children", () => {
  const runtime = new PiTeamRuntime();
  const root = runtime.begin({ project: process.cwd(), agent: "lead", kind: "manager", task: "Coordinate" });
  assert.throws(() => runtime.begin({
    project: join(process.cwd(), "foreign-project"),
    agent: "worker",
    kind: "contractor",
    task: "Must remain local",
    parentRunId: root,
  }), /parent's project/u);
  assert.equal(runtime.mission(root).length, 1);
});

test("PiTeamRuntime terminal retention preserves the latest mission per recent project", () => {
  const runtime = new PiTeamRuntime(Date.now, 2);
  const projectA = join(process.cwd(), "retention-a");
  const projectB = join(process.cwd(), "retention-b");
  const a = runtime.begin({ project: projectA, agent: "a", kind: "contractor", task: "A" });
  runtime.finishIfOpen(a, "completed");
  const b1 = runtime.begin({ project: projectB, agent: "b1", kind: "contractor", task: "B1" });
  runtime.finishIfOpen(b1, "completed");
  const b2 = runtime.begin({ project: projectB, agent: "b2", kind: "contractor", task: "B2" });
  runtime.finishIfOpen(b2, "completed");
  assert.ok(runtime.get(a), "a noisy second project evicted the only retained mission for project A");
  assert.equal(runtime.get(b1), undefined);
  assert.ok(runtime.get(b2));
  assert.equal(runtime.projectRuns(projectA).length + runtime.projectRuns(projectB).length, 2);
});

test("PiTeamRuntime uses numeric creation order when timestamps tie", () => {
  const runtime = new PiTeamRuntime(() => 1, 2);
  const roots = Array.from({ length: 12 }, (_, index) => runtime.begin({
    project: process.cwd(), agent: `worker-${index + 1}`, kind: "contractor", task: `Task ${index + 1}`,
  }));
  assert.equal(runtime.latestRoot(process.cwd())?.id, roots.at(-1));
  for (const root of roots) runtime.finishIfOpen(root, "completed");
  assert.deepEqual(runtime.projectRuns(process.cwd()).filter((run) => !run.parentRunId).map(({ id }) => id), roots.slice(-2).reverse());
});

test("PiTeamRuntime does not prune a terminal root while one of its children is active", () => {
  let now = 0;
  const runtime = new PiTeamRuntime(() => now, 1);
  const root = runtime.begin({ project: process.cwd(), agent: "lead", kind: "manager", task: "Lead" });
  const child = runtime.begin({ project: process.cwd(), agent: "worker", kind: "personal", task: "Work", parentRunId: root });
  runtime.finishIfOpen(root, "completed");
  now = 1;
  const newer = runtime.begin({ project: process.cwd(), agent: "newer", kind: "contractor", task: "New" });
  runtime.finishIfOpen(newer, "completed");
  assert.ok(runtime.get(root));
  assert.ok(runtime.get(child));
  runtime.finishIfOpen(child, "completed");
  assert.equal(runtime.get(root), undefined);
  assert.equal(runtime.get(child), undefined);
  assert.ok(runtime.get(newer));
});

test("PiTeamRuntime distinguishes explicit zero usage from omitted native usage", () => {
  const runtime = new PiTeamRuntime();
  const explicit = runtime.begin({ project: process.cwd(), agent: "explicit", kind: "contractor", task: "Observe" });
  runtime.observeMessageEnd(explicit, {
    role: "assistant", responseId: "zero", provider: "router", model: "auto",
    usage: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
  });
  assert.deepEqual(runtime.get(explicit)!.usage,
    { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
  assert.deepEqual(runtime.get(explicit)!.usageLowerBounds, []);

  const omitted = runtime.begin({ project: process.cwd(), agent: "omitted", kind: "contractor", task: "Observe" });
  runtime.observeMessageEnd(omitted, {
    role: "assistant", responseId: "omitted", provider: "router", model: "auto",
  });
  assert.deepEqual(runtime.get(omitted)!.usage, {});
  assert.deepEqual(new Set(runtime.get(omitted)!.usageLowerBounds),
    new Set(["input", "output", "reasoning", "cacheRead", "cacheWrite", "total"]));

  const inconsistent = runtime.begin({ project: process.cwd(), agent: "partial", kind: "contractor", task: "Observe" });
  runtime.observeMessageEnd(inconsistent, {
    role: "assistant", responseId: "partial", provider: "router", model: "auto",
    usage: { input: 5, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
  });
  assert.deepEqual(runtime.get(inconsistent)!.usage, { input: 5, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 });

  const totalOnly = runtime.begin({ project: process.cwd(), agent: "total", kind: "contractor", task: "Observe" });
  runtime.observeMessageEnd(totalOnly, {
    role: "assistant", responseId: "total", provider: "router", model: "auto",
    usage: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 7 },
  });
  assert.deepEqual(runtime.get(totalOnly)!.usage, { reasoning: 0, total: 7 });
});

test("Pi message fingerprints and retained identity memory stay bounded", () => {
  const runtime = new PiTeamRuntime();
  const runId = runtime.begin({ project: process.cwd(), agent: "worker", kind: "contractor", task: "Observe safely" });
  const cyclic: any = {
    role: "assistant",
    timestamp: 1,
    provider: "p",
    model: "m",
    usage: { input: 1, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 1 },
  };
  cyclic.content = cyclic;
  assert.doesNotThrow(() => runtime.observeMessageEnd(runId, cyclic));

  let deep: any = { text: `${"x".repeat(2_000_000)}private-suffix-must-not-be-retained` };
  for (let index = 0; index < 10_000; index += 1) deep = { child: deep };
  assert.doesNotThrow(() => runtime.observeMessageEnd(runId, {
    role: "assistant",
    timestamp: 2,
    provider: "p",
    model: "m",
    content: deep,
    usage: { input: 1, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 1 },
  }));
  assert.equal(runtime.get(runId)!.nativeMessagesLowerBound, true);

  for (let index = runtime.get(runId)!.nativeMessages; index <= maximumPiObservedMessages; index += 1) {
    runtime.observeMessageEnd(runId, {
      role: "assistant",
      responseId: `bounded-${index}`,
      provider: "p",
      model: "m",
      usage: { input: 1, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 1 },
    });
  }
  const snapshot = runtime.get(runId)!;
  assert.equal(snapshot.nativeMessages, maximumPiObservedMessages);
  assert.equal(snapshot.nativeMessagesLowerBound, true);
  assert.ok(snapshot.usageLowerBounds.includes("total"));
  assert.match(formatPiMissionReport(runtime, runId), new RegExp(`model turns ≥${maximumPiObservedMessages}`, "u"));
  assert.doesNotMatch(JSON.stringify(snapshot), /private-suffix|x{100}/u);

  runtime.finishIfOpen(runId, "completed");
  assert.equal(runtime.observeMessageEnd(runId, {
    role: "assistant", responseId: "after-terminal", usage: { input: 999, output: 1, totalTokens: 1_000 },
  }), false);
  assert.equal(runtime.get(runId)!.nativeMessages, maximumPiObservedMessages);
});

test("PiTeamRuntime preserves known usage as a lower bound after a usage-less cancelled turn", () => {
  const runtime = new PiTeamRuntime();
  const runId = runtime.begin({ project: process.cwd(), agent: "worker", kind: "contractor", task: "Measure" });
  runtime.observeMessageEnd(runId, {
    role: "assistant", responseId: "known", provider: "p", model: "m",
    usage: { input: 900, output: 171, reasoning: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 1_071 },
  });
  runtime.observeMessageEnd(runId, {
    role: "assistant", responseId: "cancelled-without-usage", provider: "p", model: "m",
  });
  runtime.setState(runId, "cancelled");
  const run = runtime.get(runId)!;
  assert.equal(run.usage.total, 1_071);
  assert.ok(run.usageLowerBounds.includes("total"));
  assert.match(formatPiMissionReport(runtime, runId), /total ≥1,071/u);
  assert.match(formatPiLiveStatus(runtime, runId), /≥1,071 tok/u);
  assert.match(formatPiLiveWidget(runtime, runId).join("\n"), /≥1,071 native tokens/u);
  assert.ok(formatPiLiveWidget(runtime, runId).every((line) => visibleTextWidth(line) <= 96));
});

test("Pi token counters saturate safely and mission totals disclose overflow uncertainty", () => {
  const runtime = new PiTeamRuntime();
  const root = runtime.begin({ project: process.cwd(), agent: "lead", kind: "manager", task: "Count safely" });
  const child = runtime.begin({
    project: process.cwd(), agent: "worker", kind: "contractor", task: "Count one", parentRunId: root,
  });
  runtime.observeMessageEnd(root, {
    role: "assistant", responseId: "maximum-safe", provider: "p", model: "m",
    usage: {
      input: Number.MAX_SAFE_INTEGER,
      output: 0,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: Number.MAX_SAFE_INTEGER,
    },
  });
  runtime.observeMessageEnd(child, {
    role: "assistant", responseId: "one-more", provider: "p", model: "m",
    usage: { input: 1, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 1 },
  });
  const invalid = runtime.begin({ project: process.cwd(), agent: "invalid", kind: "contractor", task: "Reject huge" });
  runtime.observeMessageEnd(invalid, {
    role: "assistant", responseId: "invalid-counts", provider: "p", model: "m",
    usage: {
      input: 1e308,
      output: Number.POSITIVE_INFINITY,
      reasoning: Number.NaN,
      cacheRead: 1.5,
      cacheWrite: -1,
      totalTokens: 1e308,
    },
  });

  assert.equal(runtime.missionUsage(root).input, Number.MAX_SAFE_INTEGER);
  assert.equal(runtime.missionUsage(root).total, Number.MAX_SAFE_INTEGER);
  assert.ok(runtime.missionUsageLowerBounds(root).includes("input"));
  assert.ok(runtime.missionUsageLowerBounds(root).includes("total"));
  assert.deepEqual(runtime.get(invalid)!.usage, {});
  assert.deepEqual(new Set(runtime.get(invalid)!.usageLowerBounds),
    new Set(["input", "output", "reasoning", "cacheRead", "cacheWrite", "total"]));
  const report = formatPiMissionReport(runtime, root);
  assert.doesNotMatch(`${JSON.stringify(runtime.get(invalid))}\n${report}`, /Infinity|NaN|∞/u);
  assert.match(report, /total\s+≥9,007,199,254,740,991/u);
});

test("Pi observed model metadata cannot inject terminal controls or roster rows", () => {
  const runtime = new PiTeamRuntime();
  const runId = runtime.begin({
    project: process.cwd(), agent: "worker", kind: "contractor", task: "Observe",
    model: { provider: "router\u001b[31m\n● forged-member", id: "model\u202eoverride" },
  });
  const report = formatPiMissionReport(runtime, runId);
  assert.doesNotMatch(report, /\u001b|\u202e/u);
  assert.doesNotMatch(report, /^● forged-member/gmu);
  assert.ok(report.split("\n").every((line) => visibleTextWidth(line) <= 96));
});

test("PiTeamRuntime labels aggregate usage across multiple observed response models", () => {
  const runtime = new PiTeamRuntime();
  const runId = runtime.begin({ project: process.cwd(), agent: "router", kind: "contractor", task: "Route" });
  for (const [responseId, responseModel] of [["one", "model-a"], ["two", "model-b"]] as const) {
    runtime.observeMessageEnd(runId, {
      role: "assistant", responseId, provider: "openrouter", model: "auto", responseModel,
      usage: { input: 2, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 3 },
    });
  }
  const run = runtime.get(runId)!;
  assert.equal(run.observedModels.length, 2);
  assert.match(formatPiMissionReport(runtime, runId), /mixed observed: openrouter\/model-a, openrouter\/model-b[\s\S]*total 6/u);
});

test("Pi shutdown settlement is bounded when a provider never resolves", async () => {
  const started = performance.now();
  assert.equal(await settlePiRootPromises([new Promise(() => {})], 10), false);
  assert.ok(performance.now() - started < 500, "bounded shutdown wait hung");
  assert.equal(await settlePiRootPromises([Promise.resolve()], 10), true);
});

test("Pi team view includes fixed, bundled, personal, utility, activity, help, and actionable no-match output", async () => {
  const root = await mkdtemp(join(tmpdir(), "harbor-pi-team-view-"));
  const home = join(root, "home");
  const project = join(root, "project");
  const previousHome = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = home;
  try {
    const roster = new Roster(harnessSpec("pi", home, project));
    const baseOverview = await formatPiTeamView(project, new PiTeamRuntime());
    const baseIds = [...rolePlayers.keys(), scoutPlayer.name, ...bundledPlayers.keys()];
    for (const id of baseIds) {
      assert.match(baseOverview, new RegExp(`^[●○!] ${id.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\b`, "mu"));
    }
    assert.equal(baseIds.length, 9);
    assert.ok(baseOverview.split("\n").length <= 30,
      `Pi overview exceeded the 30-line viewport budget: ${baseOverview.split("\n").length}`);
    assert.match(baseOverview, /LEAD ACCESS[\s\S]*ACTIVITY[\s\S]*ROSTER[\s\S]*Details: \/team member:<id>[\s\S]*Commands:/u);
    assert.doesNotMatch(baseOverview, /Capacity:|Repair:/u,
      "unfiltered overview expanded rich member details into the initial viewport");
    await roster.join({ name: "privacy-reviewer", description: "Review privacy boundaries", prompt: "Review only", tools: ["read", "search"], model: "router/special" });
    const runtime = new PiTeamRuntime();
    const runId = runtime.begin({ project, agent: "privacy-reviewer", kind: "personal", task: "Review C:\\secret\\input.txt" });
    const starting = await formatPiTeamView(project, runtime);
    assert.match(starting, /Team: .*1 active \(1 starting\)/u);
    assert.match(starting, /privacy-reviewer · personal · starting/u);
    assert.doesNotMatch(starting, /Team: .*1 working/u);
    assert.match(formatPiLiveStatus(runtime, runId), /1 active \(1 starting\).*privacy-reviewer starting/u);
    runtime.observer(runId).sessionStarted({ model: { provider: "openai-codex", id: "gpt-test" }, thinking: "low" });
    const view = await formatPiTeamView(project, runtime);
    assert.match(view, /0 model tokens/u);
    assert.match(view, /team-lead · manager/u);
    assert.match(view, /crafter · fixed/u);
    assert.match(view, /talent-scout \(\/scout\) · utility/u);
    assert.match(view, /portfolio-management · bundled · bench/u);
    assert.match(view, /privacy-reviewer · personal · working/u);
    assert.match(view, /LEAD ACCESS\nLead capacity: 2\/32\nDelegable now: crafter\nBusy \(double-booking blocked\): privacy-reviewer/u);
    assert.match(view, /SDLC coverage: 0\/6 enabled · 6 benched/u);
    assert.match(view, /Enable SDLC: \/bench on portfolio-management design build manage consume dispose/u);
    const memberDetail = await formatPiTeamView(project, runtime, { filter: "member:privacy-reviewer" });
    assert.match(memberDetail, /Task: “Review \[path\]”/u);
    assert.match(memberDetail, /Capacity: read, search · model: configured router\/special/u);
    const noModelOverview = await formatPiTeamView(project, runtime, { nextModelUnavailable: true });
    assert.match(noModelOverview,
      /Next (?:default )?child: unavailable \(Pi reports no usable models; use \/login\)/u);
    assert.match(noModelOverview, /LEAD ACCESS[\s\S]*Delegable now: none \(model unavailable\)/u);
    assert.doesNotMatch(noModelOverview, /Delegable now: crafter/u);
    const noModelFiltered = await formatPiTeamView(project, runtime, {
      filter: "member:privacy-reviewer",
      nextModelUnavailable: true,
    });
    assert.match(noModelFiltered,
      /LEAD ACCESS · OVERALL[\s\S]*Delegable now: none \(model unavailable\)/u);
    assert.doesNotMatch(noModelFiltered, /Delegable now: crafter/u);
    const selectionOverview = await formatPiTeamView(project, runtime, { nextModelAvailableCount: 2 });
    assert.match(selectionOverview, /Next (?:default )?child: not selected \(2 available; use \/model\)/u);
    assert.match(selectionOverview, /Delegable now: none \(select a model with \/model\)/u);
    assert.doesNotMatch(selectionOverview, /Delegable now: crafter/u);
    const selectionFiltered = await formatPiTeamView(project, runtime, {
      filter: "member:privacy-reviewer",
      nextModelAvailableCount: 2,
    });
    assert.match(selectionFiltered, /Next default child: not selected \(2 available; use \/model\)/u);
    assert.match(selectionFiltered, /Delegable now: none \(select a model with \/model\)/u);
    const unobservedOverview = await formatPiTeamView(project, runtime, {
      nextModelAvailabilityUnobserved: true,
    });
    assert.match(unobservedOverview,
      /Next (?:default )?child: no active model; availability unobserved \(use \/model or \/login\)/u);
    assert.match(unobservedOverview,
      /Delegable now: none \(model availability unobserved; use \/model or \/login\)/u);
    const unobservedFiltered = await formatPiTeamView(project, runtime, {
      filter: "member:privacy-reviewer",
      nextModelAvailabilityUnobserved: true,
    });
    assert.match(unobservedFiltered,
      /Next default child: no active model; availability unobserved \(use \/model or \/login\)/u);
    assert.match(unobservedFiltered,
      /Delegable now: none \(model availability unobserved; use \/model or \/login\)/u);
    assert.doesNotMatch(view, /secret\\input/u);
    assert.match(view, /Commands: \/team \[filter\][\s\S]*\/<id> <task>[\s\S]*\/contract\s+<json>/u);
    assert.equal((view.match(/ · bundled · bench/gu) ?? []).length, bundledPlayers.size);
    const filtered = await formatPiTeamView(project, runtime, { filter: "construction" });
    assert.match(filtered, /Overall Team: .*1 active \(1 working\)/u);
    assert.match(filtered, /No active work matches this filter/u);
    assert.doesNotMatch(filtered, /No one is working right now/u);
    const noMatch = await formatPiTeamView(project, runtime, { filter: "nonexistent-capability" });
    assert.match(noMatch, /No team member or tracked activity matches/u);
    assert.match(noMatch, /search by member ID, role, tool, skill, model, thinking, state, task\s+label, or run ID/u);
    const configuredModel = await formatPiTeamView(project, runtime, { filter: "router/special" });
    assert.match(configuredModel, /privacy-reviewer · personal · working/u);
    assert.match(configuredModel, /configured router\/special/u);
    const toolFilter = await formatPiTeamView(project, runtime, { filter: "tool:read" });
    assert.match(toolFilter, /^● crafter · fixed · ready$/mu);
    assert.match(toolFilter, /^● privacy-reviewer · personal · working$/mu);
    assert.doesNotMatch(toolFilter, /^● team-lead · manager/mu);
    const readyFilter = await formatPiTeamView(project, runtime, { filter: "status:ready" });
    assert.match(readyFilter, /^● crafter · fixed · ready$/mu);
    assert.doesNotMatch(readyFilter, /^● privacy-reviewer · personal/mu);
    const workingFilter = await formatPiTeamView(project, runtime, { filter: "status:working" });
    assert.match(workingFilter, /^● privacy-reviewer · run pi-run-1.* · working ·/mu);
    assert.match(workingFilter, /^● privacy-reviewer · personal · working$/mu);
    assert.doesNotMatch(workingFilter, /^● crafter · fixed/mu);
    const stateFilter = await formatPiTeamView(project, runtime, { filter: "state:working" });
    assert.match(stateFilter, /^● privacy-reviewer · personal · working$/mu);
    const benchFilter = await formatPiTeamView(project, runtime, { filter: "status:bench" });
    assert.match(benchFilter, /^○ portfolio-management · bundled · bench$/mu);
    const capabilityFilter = await formatPiTeamView(project, runtime, { filter: "capability:recruit" });
    assert.match(capabilityFilter, /^● talent-scout \(\/scout\) · utility · ready$/mu);
    const skillFilter = await formatPiTeamView(project, runtime, { filter: "skill:zx-example" });
    assert.match(skillFilter, /^● crafter · fixed · ready$/mu);
    const observedModelFilter = await formatPiTeamView(project, runtime, { filter: "model:gpt-test" });
    assert.match(observedModelFilter, /^● privacy-reviewer · run pi-run-1/mu);
    const thinkingFilter = await formatPiTeamView(project, runtime, { filter: "thinking:low" });
    assert.match(thinkingFilter, /^● privacy-reviewer · run pi-run-1/mu);
    const taskFilter = await formatPiTeamView(project, runtime, { filter: "task:review" });
    assert.match(taskFilter, /^● privacy-reviewer · run pi-run-1/mu);
    const runFilter = await formatPiTeamView(project, runtime, { filter: "run:pi-run-1" });
    assert.match(runFilter, /^● privacy-reviewer · run pi-run-1/mu);
    for (const memberFilter of ["member:privacy", "id:privacy", "kind:personal"]) {
      assert.match(await formatPiTeamView(project, runtime, { filter: memberFilter }),
        /^● privacy-reviewer · personal · working$/mu);
    }
    assert.match(await formatPiTeamView(project, runtime, { filter: "role:manager" }),
      /^● team-lead · manager · ready$/mu);
    assert.match(await formatPiTeamView(project, runtime, { filter: "description:privacy boundaries" }),
      /^● privacy-reviewer · personal · working$/mu);
    assert.match(await formatPiTeamView(project, runtime, { filter: "run:privacy" }),
      /No team member or tracked activity matches/u,
      "run filters must not search the agent field");
    const lowerBoundRuntime = new PiTeamRuntime();
    const lowerBoundRun = lowerBoundRuntime.begin({
      project, agent: "privacy-reviewer", kind: "personal", task: "Bound model turns",
    });
    for (let index = 0; index <= maximumPiObservedMessages; index += 1) {
      lowerBoundRuntime.observeMessageEnd(lowerBoundRun, {
        role: "assistant", responseId: `bounded-view-${index}`, provider: "p", model: "m",
      });
    }
    const lowerBoundView = await formatPiTeamView(project, lowerBoundRuntime, { filter: `run:${lowerBoundRun}` });
    assert.match(lowerBoundView,
      new RegExp(`model turns ≥${maximumPiObservedMessages}`, "u"),
      "live ACTIVITY understated a saturated native message count");
    runtime.observeMessageEnd(runId, {
      role: "assistant", responseId: "review-1", provider: "openai-codex", model: "gpt-test",
      usage: { input: 6, output: 4, reasoning: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 10 },
    });
    const childId = runtime.begin({
      project,
      agent: "build",
      kind: "bundled",
      task: "Implement src/private.ts without exposing it",
      parentRunId: runId,
    });
    runtime.observer(childId).sessionStarted({ model: { provider: "anthropic", id: "worker-test" }, thinking: "high" });
    runtime.observeMessageEnd(childId, {
      role: "assistant", responseId: "build-1", provider: "anthropic", model: "worker-test",
      usage: { input: 15, output: 8, reasoning: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 23 },
    });
    runtime.setState(childId, "completed");
    runtime.setState(runId, "cleaning");
    const cleaning = await formatPiTeamView(project, runtime);
    assert.match(cleaning, /Team: .*1 active \(1 cleaning\)/u);
    assert.match(cleaning, /privacy-reviewer · personal · cleaning/u);
    assert.doesNotMatch(cleaning, /Team: .*1 working/u);
    assert.match(formatPiLiveStatus(runtime, runId), /1 active \(1 cleaning\).*privacy-reviewer cleaning/u);
    runtime.setState(runId, "completed");
    const history = await formatPiTeamView(project, runtime);
    assert.equal((history.match(/^LAST MISSION$/gmu) ?? []).length, 1);
    assert.doesNotMatch(history, /^TEAM RUN/gmu, "the history view duplicated the final-report heading");
    assert.match(history, /privacy-reviewer · pi-run-1 · completed[\s\S]*Mission: 2 tracked runs · total 33 native tokens/u);
    assert.doesNotMatch(history, /Task: “Review \[path\]”|Task: “Implement \[path\]/u);
    const rootHistory = await formatPiTeamView(project, runtime, { filter: "run:pi-run-1" });
    assert.match(rootHistory, /● privacy-reviewer · run pi-run-1 · personal · completed[\s\S]*Task: “Review \[path\]”[\s\S]*openai-codex\/gpt-test \(observed\) · thinking setting low[\s\S]*total 10/u);
    const childHistory = await formatPiTeamView(project, runtime, { filter: "worker-test" });
    assert.match(childHistory, /LAST MISSION · MATCHING MEMBERS/u);
    assert.match(childHistory, /build · run pi-run-2 · parent pi-run-1 · bundled · completed/u);
    assert.doesNotMatch(childHistory, /privacy-reviewer · personal · completed/u);
    assert.doesNotMatch(childHistory, /Mission total/u);
    const unrelatedHistory = await formatPiTeamView(project, runtime, { filter: "crafter" });
    assert.doesNotMatch(unrelatedHistory, /Review \[path\]|worker-test|Mission total/u);
    await roster.bench("on all", bundledPlayers);
    const activated = await formatPiTeamView(project, runtime);
    assert.match(activated, /SDLC coverage: 6\/6 enabled · 0 benched/u);
    assert.doesNotMatch(activated, /Coverage is limited/u);
    assert.match(activated, /Delegable now: crafter, portfolio-management, design, build, manage, consume, dispose,\s+privacy-reviewer/u);
    for (const output of [
      baseOverview, starting, view, memberDetail, filtered, noMatch, configuredModel, toolFilter, readyFilter, workingFilter,
      stateFilter, benchFilter, capabilityFilter, skillFilter, observedModelFilter, thinkingFilter,
      taskFilter, runFilter, lowerBoundView, cleaning, history, rootHistory, childHistory, activated,
      noModelOverview, noModelFiltered, selectionOverview, selectionFiltered,
      unobservedOverview, unobservedFiltered,
    ]) {
      assert.ok(output.split("\n").every((line) => visibleTextWidth(line) <= 96), "Pi team output exceeded 96 visible columns");
    }
  } finally {
    if (previousHome === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousHome;
  }
});

test("Pi team view bounds a large roster and keeps omitted members discoverable by filter", async () => {
  const root = await mkdtemp(join(tmpdir(), "harbor-pi-large-team-view-"));
  const home = join(root, "home");
  const project = join(root, "project");
  const previousHome = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = home;
  try {
    const roster = new Roster(harnessSpec("pi", home, project));
    const personalCount = maximumVisiblePiRosterMembers;
    for (let index = 0; index < personalCount; index += 1) {
      const suffix = index.toString().padStart(2, "0");
      await roster.join({
        name: `scale-member-${suffix}`,
        description: `Scale member ${suffix}`,
        prompt: "Work only in the requested scope.",
        tools: ["read"],
      });
    }

    const view = await formatPiTeamView(project, new PiTeamRuntime());
    const baseIds = [...rolePlayers.keys(), scoutPlayer.name, ...bundledPlayers.keys()];
    for (const id of baseIds) assert.match(view, new RegExp(`^[●○!] ${id}\\b`, "mu"));
    const shownPersonal = (view.match(/^[●○!] scale-member-\d+ · personal · ready$/gmu) ?? []).length;
    assert.ok(shownPersonal <= maximumVisiblePiOverviewRosterMembers - baseIds.length);
    assert.match(view, new RegExp(`\\+${personalCount - shownPersonal} personal members omitted`, "u"));
    assert.match(view, /use \/team kind:personal or \/team member:<id>/u);
    assert.ok(view.split("\n").length <= maximumPiTeamOverviewLines,
      `crowded Pi overview exceeded ${maximumPiTeamOverviewLines} wrapped lines`);
    assert.doesNotMatch(view, /^● scale-member-31 /mu, "an omitted tail member unexpectedly escaped the roster cap");

    const filtered = await formatPiTeamView(project, new PiTeamRuntime(), { filter: "member:scale-member-31" });
    assert.match(filtered, /scale-member-31 · personal · ready/u);
    assert.match(filtered, /Capacity: read · model: inherits the Pi host when run/u);
    assert.doesNotMatch(filtered, /more roster members/u);
    assert.ok([view, filtered].every((output) => output.split("\n").every((line) => visibleTextWidth(line) <= 96)));
  } finally {
    if (previousHome === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousHome;
  }
});

test("Pi team view gives class-specific stale repair commands", async () => {
  const root = await mkdtemp(join(tmpdir(), "harbor-pi-stale-repair-"));
  const home = join(root, "home");
  const project = join(root, "project");
  const previousHome = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = home;
  try {
    const spec = harnessSpec("pi", home, project);
    const roster = new Roster(spec);
    await roster.bench("on design", bundledPlayers);
    const designPath = join(project, spec.activeDir, `design${spec.extension}`);
    await writeFile(designPath, (await readFile(designPath, "utf8")).replace("Solution design", "Altered design"), "utf8");

    await roster.join({ name: "active-stale", description: "Active stale", prompt: "Work", tools: ["read"] });
    const activePath = join(project, spec.activeDir, `active-stale${spec.extension}`);
    await writeFile(activePath, (await readFile(activePath, "utf8")).replace("\nWork\n", "\nChanged\n"), "utf8");

    await roster.join({ name: "registration-stale", description: "Registration stale", prompt: "Work", tools: ["read"] });
    const registrationPath = join(home, spec.registrationDir, `registration-stale${spec.extension}`);
    const invalidDefinition = Buffer.from(JSON.stringify({ name: "registration-stale" }), "utf8").toString("base64url");
    await writeFile(registrationPath, (await readFile(registrationPath, "utf8"))
      .replace(/<!-- agent-foundry:definition [A-Za-z0-9_-]+ -->/u, `<!-- agent-foundry:definition ${invalidDefinition} -->`), "utf8");

    const view = await formatPiTeamView(project, new PiTeamRuntime());
    assert.match(view, /! design · bundled · stale/u);
    assert.match(view, /! active-stale · personal · stale/u);
    assert.match(view, /! registration-stale · personal · stale/u);
    assert.doesNotMatch(view, /Repair:/u);
    const design = await formatPiTeamView(project, new PiTeamRuntime(), { filter: "member:design" });
    const active = await formatPiTeamView(project, new PiTeamRuntime(), { filter: "member:active-stale" });
    const registration = await formatPiTeamView(project, new PiTeamRuntime(), { filter: "member:registration-stale" });
    assert.match(design, /! design · bundled · stale[\s\S]*Repair: \/bench on design; then \/reload\./u);
    assert.match(active, /! active-stale · personal · stale[\s\S]*Repair: \/bench on active-stale; then \/reload\./u);
    assert.match(registration, /! registration-stale · personal · stale[\s\S]*Repair: re-run \/join with the full[\s\S]*definition and "replace":true; then \/reload\./u);
    assert.doesNotMatch(design.match(/! design[\s\S]*?(?=\n\nCommands:|$)/u)?.[0] ?? "", /\/join/u);
  } finally {
    if (previousHome === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousHome;
  }
});

test("Pi orchestrator reports effective model, native message_end usage, cleanup, and cancellation states", async () => {
  const events: string[] = [];
  const runtime = new PiTeamRuntime();
  const runId = runtime.begin({ project: process.cwd(), agent: "worker", kind: "contractor", task: "Do it" });
  const session = {
    messages: [],
    subscribe: (handler: (event: unknown) => void) => { (session as any).handler = handler; return () => events.push("unsubscribe"); },
    prompt: async () => {
      (session as any).handler({
        type: "message_end",
        message: {
          role: "assistant", responseId: "turn-1", provider: "effective-provider", model: "effective-model",
          usage: { input: 11, output: 7, reasoning: 3, cacheRead: 2, cacheWrite: 1, totalTokens: 21 },
        },
      });
      (session as any).handler({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "done" } });
    },
    abort: async () => { events.push("abort"); },
    dispose: () => { events.push("dispose"); },
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
  const model = { provider: "requested-provider", id: "requested-model" };
  const orchestrator = new PiOrchestrator(
    process.cwd(), async () => sdk as any, [], undefined, [], undefined,
    { model, thinkingLevel: "minimal" }, runtime.observer(runId),
  );
  assert.equal(await orchestrator.run(definition as any), "done");
  assert.deepEqual(events, ["unsubscribe", "dispose"]);
  assert.equal(runtime.get(runId)!.state, "completed");
  assert.deepEqual(runtime.get(runId)!.model, { provider: "effective-provider", id: "effective-model" });
  assert.equal(runtime.get(runId)!.modelSource, "observed");
  assert.deepEqual(runtime.get(runId)!.usage, {
    input: 11, output: 7, reasoning: 3, cacheRead: 2, cacheWrite: 1, total: 21,
  });

  const cleanupRuntime = new PiTeamRuntime();
  const cleanupRun = cleanupRuntime.begin({ project: process.cwd(), agent: "worker", kind: "contractor", task: "Do it" });
  session.dispose = () => { throw new Error("dispose failed"); };
  const cleanupOrchestrator = new PiOrchestrator(
    process.cwd(), async () => sdk as any, [], undefined, [], undefined, {}, cleanupRuntime.observer(cleanupRun),
  );
  await assert.rejects(() => cleanupOrchestrator.run(definition as any), /dispose failed/u);
  assert.equal(cleanupRuntime.get(cleanupRun)!.state, "cleanup-error");
});

test("Pi cancellation escapes an abort-ignoring prompt and bounds a hung native abort cleanup", async () => {
  const events: string[] = [];
  const runtime = new PiTeamRuntime();
  const runId = runtime.begin({ project: process.cwd(), agent: "worker", kind: "contractor", task: "Hang" });
  let promptStarted!: () => void;
  const started = new Promise<void>((resolve) => { promptStarted = resolve; });
  const session = {
    messages: [],
    subscribe: () => () => events.push("unsubscribe"),
    prompt: () => {
      promptStarted();
      return new Promise<void>(() => {});
    },
    abort: () => {
      events.push("abort");
      return new Promise<void>(() => {});
    },
    dispose: () => { events.push("dispose"); },
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
  const controller = new AbortController();
  const orchestrator = new PiOrchestrator(
    process.cwd(), async () => sdk as any, [], undefined, [], undefined, {}, runtime.observer(runId),
  );
  const invocation = orchestrator.run(definition as any, controller.signal);
  await started;
  const cancelledAt = performance.now();
  controller.abort(new DOMException("Stopped by test", "AbortError"));
  let failure: unknown;
  try { await invocation; } catch (error) { failure = error; }
  assert.ok(failure instanceof AggregateError);
  assert.match(failure.errors.map((error) => String(error)).join("\n"), /Pi child abort timed out/u);
  assert.ok(performance.now() - cancelledAt < 2_000, "hung native abort cleanup was not bounded");
  assert.deepEqual(events, ["abort", "unsubscribe", "dispose"]);
  assert.equal(runtime.get(runId)!.state, "cleanup-error");
});

test("Pi transcript fallback recovers native usage/model once when message_end is absent", async () => {
  const runtime = new PiTeamRuntime();
  const runId = runtime.begin({ project: process.cwd(), agent: "worker", kind: "contractor", task: "Fallback" });
  const session = {
    messages: [{
      role: "assistant",
      content: [{ type: "thinking", thinking: "private" }, { type: "text", text: "fallback evidence" }],
      responseId: "fallback-1",
      provider: "fallback-provider",
      model: "fallback-model",
      usage: { input: 9, output: 5, reasoning: 2, cacheRead: 1, cacheWrite: 0, totalTokens: 15 },
    }],
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
  const orchestrator = new PiOrchestrator(
    process.cwd(), async () => sdk as any, [], undefined, [], undefined, {}, runtime.observer(runId),
  );
  assert.equal(await orchestrator.run(definition as any), "fallback evidence");
  assert.equal(runtime.get(runId)!.nativeMessages, 1);
  assert.deepEqual(runtime.get(runId)!.model, { provider: "fallback-provider", id: "fallback-model" });
  assert.equal(runtime.get(runId)!.modelSource, "observed");
  assert.deepEqual(runtime.get(runId)!.usage, {
    input: 9, output: 5, reasoning: 2, cacheRead: 1, cacheWrite: 0, total: 15,
  });
});

test("Pi transcript fallback accounts for a failed prompt before disposal", async () => {
  const runtime = new PiTeamRuntime();
  const runId = runtime.begin({ project: process.cwd(), agent: "worker", kind: "contractor", task: "Fail" });
  const session = {
    messages: [] as any[],
    subscribe: () => () => {},
    prompt: async () => {
      session.messages.push({
        role: "assistant", responseId: "failed-1", provider: "router", model: "auto", responseModel: "actual",
        content: [{ type: "text", text: "partial" }],
        usage: { input: 8, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 10 },
      });
      throw new Error("provider failed after response");
    },
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
  const orchestrator = new PiOrchestrator(
    process.cwd(), async () => sdk as any, [], undefined, [], undefined, {}, runtime.observer(runId),
  );
  await assert.rejects(() => orchestrator.run(definition as any), /provider failed/u);
  assert.deepEqual(runtime.get(runId)!.usage, {
    input: 8, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 10,
  });
  assert.deepEqual(runtime.get(runId)!.model, { provider: "router", id: "actual" });
});

test("Pi returns only settled final assistant evidence instead of concatenated intermediate deltas", async () => {
  const session = {
    messages: [] as any[],
    subscribe: (handler: (event: any) => void) => { (session as any).handler = handler; return () => {}; },
    prompt: async () => {
      (session as any).handler({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "I will inspect." } });
      (session as any).handler({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Final streamed." } });
      session.messages.push(
        { role: "assistant", content: [{ type: "text", text: "I will inspect." }] },
        { role: "assistant", content: [{ type: "text", text: "Authoritative final evidence." }] },
      );
    },
    abort: async () => {}, dispose: () => {},
  };
  const sdk = {
    DefaultResourceLoader: class {
      private readonly options: any;
      constructor(options: any) { this.options = options; }
      async reload() { this.options.skillsOverride({ skills: [], diagnostics: [] }); }
      getSkills() { return { skills: [], diagnostics: [] }; }
    },
    getAgentDir: () => "pi-agent-home", SessionManager: { inMemory: () => ({}) },
    createAgentSession: async () => ({ session }),
  };
  const orchestrator = new PiOrchestrator(process.cwd(), async () => sdk as any);
  assert.equal(await orchestrator.run(definition as any), "Authoritative final evidence.");
});

test("piTaskLabel never retains a full blank or oversized prompt", () => {
  assert.equal(piTaskLabel(" \n\t "), "(task not disclosed)");
  assert.ok([...piTaskLabel("x".repeat(500))].length <= 72);
  for (const [input, forbidden] of [
    ["Audit \\\\corp-server\\finance\\payroll.xlsx", /corp-server|payroll/u],
    ["Use Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature", /eyJhbGci|payload|signature/u],
    ["Check password=Sup3rSecretValue123", /Sup3rSecretValue123/u],
    ["Inspect /tmp", /\/tmp/u],
    ['Inspect "/home/alice/private.txt"', /home|alice|private\.txt/u],
    ["Inspect 'src/private.ts'", /src|private\.ts/u],
    ["Inspect (./secret.env)", /secret\.env/u],
    ["Inspect src/.env", /src|\.env/u],
  ] as const) {
    const label = piTaskLabel(input);
    assert.doesNotMatch(label, forbidden);
    assert.match(label, /\[(?:path|redacted)\]/u);
  }
  assert.equal(piTaskLabel("Coordinate CI/CD and input/output reviews"), "Coordinate CI/CD and input/output reviews");
});
