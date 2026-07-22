import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
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
  formatCostAmount,
  formatPiMissionReport,
  formatPiRunDetails,
  formatPiProjectLiveStatus,
  formatPiProjectLiveWidget,
  maximumPiObservedMessages,
  PiTeamRuntime,
  piTaskLabel,
  settlePiRootPromises,
} from "../src/adapters/pi-team-runtime.js";
import {
  collectPiTeamMembers,
  formatPiTeamView,
  maximumPiTeamOverviewLines,
  maximumVisiblePiOverviewRosterMembers,
  maximumVisiblePiRosterMembers,
} from "../src/adapters/pi-team-view.js";
import { claimSharedAgentActivity } from "../src/adapters/opencode-agent-activity.js";
import { PiOrchestrator } from "../src/orchestrators/pi.js";

const definition = { name: "worker", description: "Worker", prompt: "Work", tools: ["read"] as const, task: "Do it" };

test("Pi cost rendering preserves the exact finite JavaScript value", () => {
  assert.equal(formatCostAmount(4e-7), "$4e-7");
  assert.equal(formatCostAmount(1.2345678901234567), "$1.2345678901234567");
  assert.equal(formatCostAmount(0), "$0");
});

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
    usage: {
      input: 100, output: 20, cacheRead: 5, cacheWrite: 1, totalTokens: 126,
      cost: { input: 0.0001, output: 0.00002, cacheRead: 0.000005, cacheWrite: 0.000001, total: 0.000126 },
    },
  };
  observer.messageEnd(first);
  observer.messageEnd(first);
  observer.messageEnd(structuredClone(first));
  observer.messageEnd({
    ...first,
    timestamp: 2,
    stopReason: "stop",
    content: [{ type: "text", text: "done" }],
    usage: {
      input: 50, output: 10, reasoning: 3, cacheRead: 2, cacheWrite: 0, totalTokens: 62,
      cost: { input: 0.00005, output: 0.00001, cacheRead: 0.000002, cacheWrite: 0, total: 0.000062 },
    },
  });
  now = 4_000;
  observer.state("completed");

  const run = runtime.get(runId)!;
  assert.equal(run.nativeMessages, 2, "same message_end object or clone was counted more than once");
  assert.deepEqual(run.usage, { input: 150, output: 30, reasoning: 3, cacheRead: 7, cacheWrite: 1, total: 188 });
  assert.deepEqual(run.usageLowerBounds, ["reasoning"], "known usage after an unknown turn must remain a lower bound");
  assert.ok(Math.abs(run.cost.input! - 0.00015) < 1e-15);
  assert.ok(Math.abs(run.cost.output! - 0.00003) < 1e-15);
  assert.ok(Math.abs(run.cost.cacheRead! - 0.000007) < 1e-15);
  assert.ok(Math.abs(run.cost.cacheWrite! - 0.000001) < 1e-15);
  assert.ok(Math.abs(run.cost.total! - 0.000188) < 1e-15);
  assert.deepEqual(run.costLowerBounds, []);
  assert.deepEqual(run.model, { provider: "openai-codex", id: "gpt-effective" });
  assert.equal(run.modelSource, "observed");
  assert.equal(run.elapsedMs, 3_000);
  assert.match(run.task, /\[path\]/u);
  assert.match(run.task, /\[redacted\]/u);
  assert.ok([...run.task].length <= 72);
  const serialized = JSON.stringify(run);
  assert.doesNotMatch(serialized, /private chain of thought|customer|private\.ts|internal\.example|abcdefghijklmnop/u);
});

test("Pi project live UI is one bounded newest-first surface with an always-visible stop control", () => {
  const runtime = new PiTeamRuntime();
  const project = process.cwd();
  const root = runtime.begin({
    project,
    agent: "team-lead-with-a-deliberately-long-public-name",
    kind: "manager",
    task: "Coordinate a deliberately long but public project task",
  });
  runtime.observer(root).sessionStarted({ model: { provider: "router", id: "lead-model" }, thinking: "low" });
  for (let index = 1; index <= 6; index += 1) {
    const child = runtime.begin({
      project,
      agent: `worker-${index}`,
      kind: "bundled",
      task: `Perform work package ${index} with a deliberately long bounded label`,
      parentRunId: root,
    });
    runtime.observer(child).sessionStarted({
      model: { provider: "provider", id: `model-${index}` }, thinking: "high",
    });
    runtime.observeMessageEnd(child, {
      role: "assistant",
      responseId: `response-${index}`,
      provider: "provider",
      model: `model-${index}`,
      usage: {
        input: index, output: index, reasoning: 0, cacheRead: 0, cacheWrite: 0, totalTokens: index * 2,
        cost: { input: index / 1_000_000, output: index / 1_000_000, cacheRead: 0, cacheWrite: 0, total: index / 500_000 },
      },
    });
    if (index < 6) runtime.setState(child, "completed");
  }

  const widget = formatPiProjectLiveWidget(runtime, project);
  assert.ok(widget.length <= 9, `project widget exceeded the Pi host cap: ${widget.length}`);
  assert.ok(widget.every((line) => visibleTextWidth(line) <= 78));
  assert.match(widget.join("\n"), /worker-6 · working · 00:00 · exact \/team run:pi-run-7/u);
  assert.match(widget.join("\n"), /team-lead-with-a-delibe… \[abbr\][\s\S]*\/team run:pi-run-1/u);
  assert.match(widget.join("\n"), /Model: provider\/model-6 \(observed\) · thinking high/u);
  assert.match(widget.join("\n"), /Usage: 12 tok · \$0\.000012 observed cost/u);
  assert.match(widget.join("\n"), /Task: “Perform work package 6/u);
  assert.match(widget.at(-1)!, /Alt\+H/u);
  assert.doesNotMatch(widget.join("\n"), /worker-1/u, "terminal history displaced current work");
  const status = formatPiProjectLiveStatus(runtime, project);
  assert.equal(status.split("\n").length, 1);
  assert.ok(visibleTextWidth(status) <= 78);
  assert.match(status, /^Harbor · worker-6 working · 2 active · 12 tok · cost \$0\.000012 · 00:00$/u);
  assert.doesNotMatch(status, /· …$/u);

  let extremeNow = 0;
  const extremeRuntime = new PiTeamRuntime(() => extremeNow);
  const extreme = extremeRuntime.begin({
    project,
    agent: "a-deliberately-long-status-agent-name",
    kind: "contractor",
    task: "Prove elapsed remains visible",
  });
  const extremeObserver = extremeRuntime.observer(extreme);
  extremeObserver.sessionStarted();
  extremeObserver.messageEnd({
    role: "assistant",
    responseId: "extreme-status",
    provider: "provider",
    model: "model",
    usage: {
      input: Number.MAX_SAFE_INTEGER,
      output: 0,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: Number.MAX_SAFE_INTEGER,
      cost: { input: Number.MAX_VALUE, output: 0, cacheRead: 0, cacheWrite: 0, total: Number.MAX_VALUE },
    },
  });
  extremeNow = 65_000;
  const extremeStatus = formatPiProjectLiveStatus(extremeRuntime, project);
  assert.ok(visibleTextWidth(extremeStatus) <= 78);
  assert.match(extremeStatus, /01:05$/u, "bounded status discarded elapsed time");
  assert.doesNotMatch(extremeStatus, /· …/u, "bounded status left an orphan separator before ellipsis");
});

test("Pi project widget preserves thinking and marks only actual abbreviations", () => {
  const runtime = new PiTeamRuntime();
  const project = process.cwd();
  const run = runtime.begin({
    project,
    agent: "literal-ellipsis…",
    kind: "contractor",
    task: "literal task ellipsis…",
    thinking: "high",
  });
  runtime.observer(run).sessionStarted({
    model: {
      provider: `provider-${"p".repeat(70)}`,
      id: `model-${"m".repeat(70)}`,
    },
    thinking: "high",
  });

  const widget = formatPiProjectLiveWidget(runtime, project);
  const output = widget.join("\n");
  assert.ok(widget.every((line) => visibleTextWidth(line) <= 78));
  assert.match(output, /Model: .*\[abbr\].*thinking high/u,
    "a long model displaced the effective thinking value");
  assert.match(output, /literal-ellipsis… · working/u);
  assert.doesNotMatch(output, /literal-ellipsis… \[abbr\]/u,
    "a literal terminal ellipsis was falsely labeled as an abbreviation");
  assert.match(output, /Task: “literal task ellipsis…”/u);
  assert.doesNotMatch(output, /literal task ellipsis… \[abbr\]/u);
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
  assert.match(report, /● team-lead · cleanup-error .*\/team run:pi-run-1/u);
  assert.match(report, /↳ build · completed .*\/team run:pi-run-2/u);
  assert.match(report, /Mission usage: .*total 40/u);
  assert.ok(report.split("\n").length <= 30);
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
    usage: {
      input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  });
  assert.deepEqual(runtime.get(explicit)!.usage,
    { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
  assert.deepEqual(runtime.get(explicit)!.usageLowerBounds, []);
  assert.deepEqual(runtime.get(explicit)!.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
  assert.deepEqual(runtime.get(explicit)!.costLowerBounds, []);

  const omitted = runtime.begin({ project: process.cwd(), agent: "omitted", kind: "contractor", task: "Observe" });
  runtime.observeMessageEnd(omitted, {
    role: "assistant", responseId: "omitted", provider: "router", model: "auto",
  });
  assert.deepEqual(runtime.get(omitted)!.usage, {});
  assert.deepEqual(new Set(runtime.get(omitted)!.usageLowerBounds),
    new Set(["input", "output", "reasoning", "cacheRead", "cacheWrite", "total"]));
  assert.deepEqual(runtime.get(omitted)!.cost, {});
  assert.deepEqual(new Set(runtime.get(omitted)!.costLowerBounds),
    new Set(["input", "output", "cacheRead", "cacheWrite", "total"]));

  const inconsistent = runtime.begin({ project: process.cwd(), agent: "partial", kind: "contractor", task: "Observe" });
  runtime.observeMessageEnd(inconsistent, {
    role: "assistant", responseId: "partial", provider: "router", model: "auto",
    usage: {
      input: 5, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0.000005, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  });
  assert.deepEqual(runtime.get(inconsistent)!.usage, { input: 5, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 });
  assert.deepEqual(runtime.get(inconsistent)!.cost, { input: 0.000005, output: 0, cacheRead: 0, cacheWrite: 0 });

  const totalOnly = runtime.begin({ project: process.cwd(), agent: "total", kind: "contractor", task: "Observe" });
  runtime.observeMessageEnd(totalOnly, {
    role: "assistant", responseId: "total", provider: "router", model: "auto",
    usage: {
      input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 7,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.000007 },
    },
  });
  assert.deepEqual(runtime.get(totalOnly)!.usage, { reasoning: 0, total: 7 });
  assert.deepEqual(runtime.get(totalOnly)!.cost, { total: 0.000007 });
});

test("PiTeamRuntime keeps reasoning separate from native total consistency checks", () => {
  const runtime = new PiTeamRuntime();
  const coherent = runtime.begin({ project: process.cwd(), agent: "reasoner", kind: "contractor", task: "Reason" });
  runtime.observeMessageEnd(coherent, {
    role: "assistant", responseId: "reasoning-separate", provider: "router", model: "auto",
    usage: {
      input: 0, output: 0, reasoning: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    },
  });
  assert.deepEqual(runtime.get(coherent)!.usage,
    { input: 0, output: 0, reasoning: 5, cacheRead: 0, cacheWrite: 0, total: 0 });
  assert.deepEqual(runtime.get(coherent)!.usageLowerBounds, []);

  const totalAuthoritative = runtime.begin({
    project: process.cwd(), agent: "reasoner-total", kind: "contractor", task: "Reason",
  });
  runtime.observeMessageEnd(totalAuthoritative, {
    role: "assistant", responseId: "reasoning-positive-total", provider: "router", model: "auto",
    usage: {
      input: 0, output: 0, reasoning: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 5,
    },
  });
  assert.deepEqual(runtime.get(totalAuthoritative)!.usage, { reasoning: 5, total: 5 });
  assert.deepEqual(new Set(runtime.get(totalAuthoritative)!.usageLowerBounds),
    new Set(["input", "output", "cacheRead", "cacheWrite"]));
});

test("PiTeamRuntime renders provider cost sums without IEEE-754 display artifacts", () => {
  const runtime = new PiTeamRuntime();
  const providerComputedTotal = 0.000022 + 0.000028;
  assert.notEqual(providerComputedTotal.toString(), "0.00005",
    "the regression fixture must retain Pi's incoming binary tail");
  const runId = runtime.begin({
    project: process.cwd(), agent: "cost-reader", kind: "contractor", task: "Observe exact cost",
  });
  runtime.observeMessageEnd(runId, {
    role: "assistant", responseId: "decimal-cost", provider: "router", model: "auto",
    usage: {
      input: 11, output: 7, reasoning: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 18,
      cost: { input: 0.000022, output: 0.000028, cacheRead: 0, cacheWrite: 0, total: providerComputedTotal },
    },
  });
  runtime.setState(runId, "completed");

  const snapshot = runtime.get(runId)!;
  assert.equal(snapshot.cost.total, 0.00005);
  assert.equal(runtime.missionCost(runId).total, 0.00005);
  assert.match(formatPiMissionReport(runtime, runId), /total \$0\.00005/u);
  assert.match(formatPiMissionReport(runtime, runId), /model router\/auto \(observed\) · thinking unknown/u);
  assert.doesNotMatch(formatPiMissionReport(runtime, runId), /499999999999/u);
});

test("PiTeamRuntime marks partial native usage and cost total contradictions as lower bounds", () => {
  const runtime = new PiTeamRuntime();
  const componentsWin = runtime.begin({
    project: process.cwd(), agent: "components-win", kind: "contractor", task: "Observe",
  });
  runtime.observeMessageEnd(componentsWin, {
    role: "assistant", responseId: "components-win", provider: "router", model: "auto",
    usage: {
      input: 5, output: 1, reasoning: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 5,
      cost: { input: 0.5, output: 0.25, cacheRead: 0, cacheWrite: 0, total: 0.6 },
    },
  });
  assert.deepEqual(runtime.get(componentsWin)!.usage,
    { input: 5, output: 1, reasoning: 1, cacheRead: 0, cacheWrite: 0 });
  assert.deepEqual(runtime.get(componentsWin)!.usageLowerBounds, ["total"]);
  assert.deepEqual(runtime.get(componentsWin)!.cost,
    { input: 0.5, output: 0.25, cacheRead: 0, cacheWrite: 0 });
  assert.deepEqual(runtime.get(componentsWin)!.costLowerBounds, ["total"]);

  const totalsWin = runtime.begin({
    project: process.cwd(), agent: "totals-win", kind: "contractor", task: "Observe",
  });
  runtime.observeMessageEnd(totalsWin, {
    role: "assistant", responseId: "totals-win", provider: "router", model: "auto",
    usage: {
      input: 5, output: 1, reasoning: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 7,
      cost: { input: 0.5, output: 0.25, cacheRead: 0, cacheWrite: 0, total: 1 },
    },
  });
  assert.deepEqual(runtime.get(totalsWin)!.usage, { reasoning: 1, total: 7 });
  assert.deepEqual(new Set(runtime.get(totalsWin)!.usageLowerBounds),
    new Set(["input", "output", "cacheRead", "cacheWrite"]));
  assert.deepEqual(runtime.get(totalsWin)!.cost, { total: 1 });
  assert.deepEqual(new Set(runtime.get(totalsWin)!.costLowerBounds),
    new Set(["input", "output", "cacheRead", "cacheWrite"]));
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
  assert.match(formatPiMissionReport(runtime, runId), new RegExp(`turns ≥${maximumPiObservedMessages}`, "u"));
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
    usage: {
      input: 900, output: 171, reasoning: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 1_071,
      cost: { input: 0.0009, output: 0.000171, cacheRead: 0, cacheWrite: 0, total: 0.001071 },
    },
  });
  runtime.observeMessageEnd(runId, {
    role: "assistant", responseId: "cancelled-without-usage", provider: "p", model: "m",
  });
  runtime.setState(runId, "cancelled");
  const run = runtime.get(runId)!;
  assert.equal(run.usage.total, 1_071);
  assert.ok(run.usageLowerBounds.includes("total"));
  assert.equal(run.cost.total, 0.001071);
  assert.ok(run.costLowerBounds.includes("total"));
  assert.match(formatPiMissionReport(runtime, runId), /total ≥1,071/u);
  assert.match(formatPiMissionReport(runtime, runId), /total ≥\$0\.001071/u);
  assert.match(formatPiLiveStatus(runtime, runId), /≥1,071 tok/u);
  assert.match(formatPiLiveWidget(runtime, runId).join("\n"), /≥1,071 native tokens/u);
  assert.match(formatPiLiveWidget(runtime, runId).join("\n"), /≥\$0\.001071 observed cost/u);
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
  const report = formatPiMissionReport(runtime, runId);
  assert.match(report, /model mixed observed: openrouter\/model-a.*\[abbr\]/u);
  assert.match(report, /Mission usage: .*total 6/u);
  assert.match(report, new RegExp(`/team run:${runId}`, "u"));
  assert.match(formatPiRunDetails([run]).join("\n"), /mixed observed: openrouter\/model-a, openrouter\/model-b/u);
});

test("Pi terminal mission report stays readable at the team-lead child and metadata limits", () => {
  const runtime = new PiTeamRuntime();
  const root = runtime.begin({ project: process.cwd(), agent: "team-lead", kind: "manager", task: "Coordinate" });
  const runIds = [root];
  for (let index = 0; index < 6; index += 1) {
    runIds.push(runtime.begin({
      project: process.cwd(), agent: `specialist-${index}`, kind: "bundled", task: `Gate ${index}`, parentRunId: root,
    }));
  }
  for (const [runIndex, runId] of runIds.entries()) {
    for (let modelIndex = 0; modelIndex < 8; modelIndex += 1) {
      runtime.observeMessageEnd(runId, {
        role: "assistant",
        responseId: `${runIndex}-${modelIndex}`,
        provider: `provider-${modelIndex}-${"p".repeat(70)}`,
        model: `model-${modelIndex}-${"m".repeat(70)}`,
        usage: {
          input: 1, output: 1, reasoning: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
          cost: { input: 4e-7, output: 4e-7, cacheRead: 0, cacheWrite: 0, total: 8e-7 },
        },
      });
    }
    runtime.finishIfOpen(runId, "completed");
  }
  const report = formatPiMissionReport(runtime, root);
  assert.ok(report.split("\n").length <= 30, `mission report used ${report.split("\n").length} lines`);
  assert.ok(report.split("\n").every((line) => visibleTextWidth(line) <= 96));
  for (const runId of runIds) assert.match(report, new RegExp(`/team run:${runId}\\b`, "u"));
  assert.match(report, /Mission usage: .*total 112/u);
  assert.match(report, /Mission cost: .*total \$0\.0000448/u);
  assert.equal((report.match(/cost total \$0\.0000064/gu) ?? []).length, 7);
  assert.match(report, /\[abbr\]/u);
  assert.match(report, /Details: copy any \/team run:<id>/u);
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
    assert.match(baseOverview, /LEAD ACCESS[\s\S]*ACTIVITY[\s\S]*ROSTER[\s\S]*Details: \/team member:<id>[\s\S]*Actions:/u);
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
    const benchView = await formatPiTeamView(project, runtime, { title: "bench" });
    const rosterPage1 = await formatPiTeamView(project, runtime, { filter: "roster-page:1" });
    const rosterPage2 = await formatPiTeamView(project, runtime, { filter: "roster-page:2" });
    const rosterPages = `${rosterPage1}\n${rosterPage2}`;
    for (const id of [...baseIds, "privacy-reviewer"]) {
      assert.match(rosterPages, new RegExp(`/team member:${id}`, "u"), `roster pages omitted ${id}`);
    }
    assert.match(rosterPages, /ROSTER INDEX · page 1\/2 · showing 1-8 of 10/u);
    assert.match(rosterPages, /ROSTER INDEX · page 2\/2 · showing 9-10 of 10/u);
    const benchRosterPage = await formatPiTeamView(project, runtime, { filter: "page:2", title: "bench" });
    assert.match(benchRosterPage, /Pages: previous \/bench list page:1/u);
    assert.match(benchView,
      /^● privacy-reviewer · personal · working · model: configured router\/special$/mu);
    assert.match(benchView,
      /^  Tools: read, search · Skills: none · Role: Review privacy boundaries$/mu);
    assert.match(benchView, /^  Tools: read, search, edit, execute · Skills: zx-example-author/mu);
    assert.ok(benchView.split("\n").length <= maximumPiTeamOverviewLines,
      `Pi bench view exceeded ${maximumPiTeamOverviewLines} lines`);
    assert.ok(benchView.split("\n").every((line) => visibleTextWidth(line) <= 96),
      "Pi bench view exceeded 96 visible columns");
    assert.match(view, /0 model tokens/u);
    assert.match(view, /team-lead · manager/u);
    assert.match(view, /crafter · fixed/u);
    assert.match(view, /talent-scout \(\/scout\) · utility/u);
    assert.match(view, /portfolio-management · bundled · bench/u);
    assert.match(view, /privacy-reviewer · personal · working/u);
    assert.match(view, /privacy-reviewer · working 00:00 · task “Review \[path\]”/u,
      "compact activity omitted what the visible teammate is doing");
    assert.match(view, /\/team run:pi-run-1 · model .*\[abbr\] \(inherited\) · thinking low · t0\/—tok\/—/u,
      "compact activity invented token or cost telemetry before a response");
    assert.match(view, /LEAD ACCESS\nEnabled specialists: 2\/32 roster limit\nLocal root capacity: 1\/32 active · 1 persistent · 0 contractors\nProject-shared capacity: 0\/32 claims · roots \+ delegated children; contractors excluded\nDelegable now: crafter\nBusy \(double-booking blocked\): privacy-reviewer/u);
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
    assert.match(view, /Details: \/team member:<id> · \/team run:<id> · \/team help[\s\S]*Actions: \/<id> · \/contract · \/scout/u);
    assert.equal((view.match(/ · bundled · bench/gu) ?? []).length, bundledPlayers.size);
    const filtered = await formatPiTeamView(project, runtime, { filter: "construction" });
    assert.match(filtered, /Overall Team: .*1 active \(1 working\)/u);
    assert.match(filtered, /No active work matches this filter/u);
    assert.doesNotMatch(filtered, /No one is working right now/u);
    const noMatch = await formatPiTeamView(project, runtime, { filter: "nonexistent-capability" });
    assert.match(noMatch, /No team member or tracked activity matches/u);
    assert.match(noMatch, /Search by member ID, role, tool, skill, model, thinking, state, task label, run ID, owner\s+runtime, or owner PID/u);
    assert.match(noMatch, /Complete indexes: \/team roster-page:1 · \/team activity-page:1 · \/team history-page:1/u);
    const configuredModel = await formatPiTeamView(project, runtime, { filter: "router/special" });
    assert.match(configuredModel, /privacy-reviewer · personal · working/u);
    assert.match(configuredModel, /configured router\/special/u);
    const toolFilter = await formatPiTeamView(project, runtime, { filter: "tool:read" });
    assert.match(toolFilter, /^● crafter · fixed · ready$/mu);
    assert.match(toolFilter, /^● privacy-reviewer · personal · working$/mu);
    assert.doesNotMatch(toolFilter, /^● team-lead · manager/mu);
    const toolDoesNotSearchSkills = await formatPiTeamView(project, runtime, { filter: "tool:zx-example" });
    assert.doesNotMatch(toolDoesNotSearchSkills, /^● crafter · fixed/mu);
    const skillDoesNotSearchTools = await formatPiTeamView(project, runtime, { filter: "skill:read" });
    assert.doesNotMatch(skillDoesNotSearchTools, /^● crafter · fixed/mu);
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
    const skillCapabilityFilter = await formatPiTeamView(project, runtime, { filter: "capability:zx-example" });
    assert.match(skillCapabilityFilter, /^● crafter · fixed · ready$/mu);
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
    assert.doesNotMatch(runFilter, /^ROSTER$|No roster member matches this filter/mu);
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
      usage: {
        input: 6, output: 4, reasoning: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 10,
        cost: { input: 0.000006, output: 0.000004, cacheRead: 0, cacheWrite: 0, total: 0.00001 },
      },
    });
    const activeDetail = await formatPiTeamView(project, runtime, { filter: `run:${runId}` });
    assert.match(activeDetail,
      /Usage: in 6 · out 4 · reason 1 · cache r\/w 0\/0 · total 10/u);
    assert.match(activeDetail,
      /Provider cost in \$0\.000006 · out \$0\.000004 · cache r\/w \$0\/\$0 · total \$0\.00001/u);
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
    assert.match(history, /privacy-reviewer · completed[\s\S]*\/team\s+run:pi-run-1[\s\S]*Mission: 2 tracked runs · total 33 native tokens/u);
    assert.doesNotMatch(history, /Task: “Review \[path\]”|Task: “Implement \[path\]/u);
    const rootHistory = await formatPiTeamView(project, runtime, { filter: "run:pi-run-1" });
    assert.match(rootHistory, /RETAINED HISTORY · EXACT RUN/u);
    assert.doesNotMatch(rootHistory, /RETAINED HISTORY · MATCHING MEMBERS/u);
    assert.match(rootHistory, /● privacy-reviewer · run pi-run-1 · personal · completed/u);
    assert.match(rootHistory, /Usage: in 6 · out 4 · reason 1 · cache r\/w 0\/0 · total 10/u);
    assert.match(rootHistory, /Task: “Review \[path\]”/u);
    assert.match(rootHistory, /openai-codex\/gpt-test \(observed\) · thinking setting low/u);
    assert.doesNotMatch(rootHistory, /^ROSTER$|No roster member matches this filter/mu);
    const childHistory = await formatPiTeamView(project, runtime, { filter: "worker-test" });
    assert.match(childHistory, /RETAINED HISTORY · MATCHING MEMBERS/u);
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
      baseOverview, starting, view, benchView, memberDetail, filtered, noMatch, configuredModel, toolFilter,
      toolDoesNotSearchSkills, skillDoesNotSearchTools, readyFilter, workingFilter,
      stateFilter, benchFilter, capabilityFilter, skillCapabilityFilter, skillFilter, observedModelFilter, thinkingFilter,
      taskFilter, runFilter, lowerBoundView, activeDetail, cleaning, history, rootHistory, childHistory, activated,
      noModelOverview, noModelFiltered, selectionOverview, selectionFiltered,
      unobservedOverview, unobservedFiltered,
      rosterPage1, rosterPage2, benchRosterPage,
    ]) {
      assert.ok(output.split("\n").every((line) => visibleTextWidth(line) <= 96), "Pi team output exceeded 96 visible columns");
    }
  } finally {
    if (previousHome === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousHome;
  }
});

test("Pi compact activity marks abbreviations and exact run detail exposes component telemetry", async () => {
  const root = await mkdtemp(join(tmpdir(), "harbor-pi-exact-run-detail-"));
  const home = join(root, "home");
  const project = join(root, "project");
  const previousHome = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = home;
  try {
    new Roster(harnessSpec("pi", home, project));
    const runtime = new PiTeamRuntime();
    const agent = "contractor-with-an-extraordinarily-long-public-agent-name";
    const provider = "provider-with-a-long-public-routing-name";
    const model = "model-with-a-long-public-effective-identity";
    const runId = runtime.begin({ project, agent, kind: "contractor", task: "Inspect exact telemetry", thinking: "high" });
    runtime.observer(runId).sessionStarted({ model: { provider, id: model }, thinking: "high" });
    runtime.observeMessageEnd(runId, {
      role: "assistant", responseId: "exact-detail", provider, model,
      usage: {
        input: 11, output: 7, reasoning: 3, cacheRead: 5, cacheWrite: 2, totalTokens: 25,
        cost: {
          input: 0.000011, output: 0.000007, cacheRead: 0.000005,
          cacheWrite: 0.000002, total: 0.000025,
        },
      },
    });
    for (let index = 2; index <= 10; index += 1) {
      runtime.begin({ project, agent: `other-${index}`, kind: "contractor", task: `Other ${index}` });
    }

    const activityPage1 = await formatPiTeamView(project, runtime, { filter: "activity-page:1" });
    const activityPage2 = await formatPiTeamView(project, runtime, { filter: "activity-page:2" });
    const activityPages = `${activityPage1}\n${activityPage2}`;
    for (let index = 1; index <= 10; index += 1) {
      assert.match(activityPages, new RegExp(`/team run:pi-run-${index}\\b`, "u"),
        `activity pages omitted pi-run-${index}`);
    }
    assert.match(activityPage1, /ACTIVE RUN INDEX · page 1\/2 · showing 1-6 of 10/u);
    assert.match(activityPage2, /ACTIVE RUN INDEX · page 2\/2 · showing 7-10 of 10/u);

    const overview = await formatPiTeamView(project, runtime);
    assert.match(overview,
      /contractor-with-a… \[abbr\][\s\S]*\/team run:pi-run-1 · model .*\[abbr\] \(observed\) · thinking high/u);
    assert.ok(overview.includes(`/team run:${runId}`), "the compact exact route was split across lines");
    assert.ok(overview.split("\n").length <= maximumPiTeamOverviewLines);
    assert.ok(overview.split("\n").every((line) => visibleTextWidth(line) <= 96));

    for (let index = 2; index <= 8; index += 1) {
      runtime.observeMessageEnd(runId, {
        role: "assistant",
        responseId: `model-${index}`,
        provider: `provider-${index}-${"p".repeat(68)}`,
        model: `model-${index}-${"m".repeat(71)}`,
        usage: {
          input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      });
    }

    const detail = await formatPiTeamView(project, runtime, { filter: `run:${runId}` });
    const flattened = detail.replace(/\s+/gu, " ");
    assert.match(flattened, new RegExp(`mixed observed: ${provider}/${model}`, "u"));
    assert.match(flattened, /Usage: in 11 · out 7 · reason 3 · cache r\/w 5\/2 · total 25/u);
    assert.match(flattened,
      /Provider cost in \$0\.000011 · out \$0\.000007 · cache r\/w \$0\.000005\/\$0\.000002 · total \$0\.000025/u);
    assert.doesNotMatch(detail, /run pi-run-10\b/u,
      "an exact run:pi-run-1 filter also selected pi-run-10");
    assert.ok(detail.split("\n").length <= maximumPiTeamOverviewLines);
    assert.ok(detail.split("\n").every((line) => visibleTextWidth(line) <= 96));

    const starting = await formatPiTeamView(project, runtime, { filter: "status:starting" });
    assert.match(starting, /\+5 matching active runs omitted; enumerate with \/team activity-page:1\./u,
      "the bounded activity filter lost its exact semantic omission count");
    assert.ok(starting.split("\n").length <= maximumPiTeamOverviewLines);
    assert.ok(starting.split("\n").every((line) => visibleTextWidth(line) <= 96));
    for (const page of [activityPage1, activityPage2]) {
      assert.ok(page.split("\n").length <= maximumPiTeamOverviewLines);
      assert.ok(page.split("\n").every((line) => visibleTextWidth(line) <= 96));
    }
  } finally {
    if (previousHome === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousHome;
  }
});

test("Pi pages enumerate retained missions while other work is active and reject invalid structured queries", async () => {
  const root = await mkdtemp(join(tmpdir(), "harbor-pi-pages-"));
  const home = join(root, "home");
  const project = join(root, "project");
  const previousHome = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = home;
  try {
    new Roster(harnessSpec("pi", home, project));
    const runtime = new PiTeamRuntime();
    const terminalIds: string[] = [];
    for (let index = 0; index < 9; index += 1) {
      const id = runtime.begin({ project, agent: `history-${index}`, kind: "contractor", task: `History ${index}` });
      runtime.setState(id, index === 0 ? "failed" : "completed");
      terminalIds.push(id);
    }
    const active = runtime.begin({ project, agent: "still-working", kind: "contractor", task: "Stay active" });
    runtime.observer(active).sessionStarted();

    const exactOld = await formatPiTeamView(project, runtime, { filter: `run:${terminalIds[0]}` });
    assert.match(exactOld, /RETAINED HISTORY · EXACT RUN/u);
    assert.match(exactOld, new RegExp(`/team run:${terminalIds[0]}\\b`, "u"));
    assert.doesNotMatch(exactOld, new RegExp(`/team run:${terminalIds.at(-1)}\\b`, "u"));

    const historyPage1 = await formatPiTeamView(project, runtime, { filter: "history-page:1" });
    const historyPage2 = await formatPiTeamView(project, runtime, { filter: "history-page:2" });
    const historyPages = `${historyPage1}\n${historyPage2}`;
    for (const id of terminalIds) {
      assert.match(historyPages, new RegExp(`/team run:${id}\\b`, "u"), `history pages omitted ${id}`);
    }
    assert.doesNotMatch(historyPages, new RegExp(`/team run:${active}\\b`, "u"));
    assert.match(historyPage1, /MISSION HISTORY INDEX · page 1\/2 · showing 1-6 of 9/u);
    assert.match(historyPage2, /MISSION HISTORY INDEX · page 2\/2 · showing 7-9 of 9/u);

    const idle = await formatPiTeamView(project, runtime, { filter: "status:idle" });
    assert.match(idle, /^● crafter · fixed · ready$/mu);
    for (const invalid of ["member:", "sttaus:working", "history-page:0", "history-page:3"]) {
      await assert.rejects(() => formatPiTeamView(project, runtime, { filter: invalid }),
        /requires a value|unsupported \/team field|positive page number|out of range/u);
    }
    for (const output of [exactOld, historyPage1, historyPage2, idle]) {
      assert.ok(output.split("\n").length <= maximumPiTeamOverviewLines);
      assert.ok(output.split("\n").every((line) => visibleTextWidth(line) <= 96));
    }
  } finally {
    if (previousHome === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousHome;
  }
});

test("Pi team view separates local roots from shared claims and routes external ownership", async () => {
  const root = await mkdtemp(join(tmpdir(), "harbor-pi-shared-capacity-"));
  const home = join(root, "pi-home");
  const project = join(root, "project");
  const activityHome = join(root, "activity-home");
  const previousHome = process.env.PI_CODING_AGENT_DIR;
  const previousActivityHome = process.env.AGENT_HARBOR_ACTIVITY_HOME;
  process.env.PI_CODING_AGENT_DIR = home;
  process.env.AGENT_HARBOR_ACTIVITY_HOME = activityHome;
  let localClaim: ReturnType<typeof claimSharedAgentActivity> | undefined;
  let externalClaim: ReturnType<typeof claimSharedAgentActivity> | undefined;
  try {
    new Roster(harnessSpec("pi", home, project));
    const runtime = new PiTeamRuntime();
    const managerRun = runtime.begin({
      project, agent: "team-lead", kind: "manager", task: "Coordinate local work",
    });
    runtime.observer(managerRun).sessionStarted();
    const contractorRun = runtime.begin({
      project, agent: "contract", kind: "contractor", task: "Inspect local scope",
    });
    runtime.observer(contractorRun).sessionStarted();

    localClaim = claimSharedAgentActivity(project, "team-lead", "direct", "private-local-native-run", "pi");
    assert.equal(localClaim.setPhase("working"), true);
    const externalAgent = "external-delegated-reviewer-with-long-id";
    const externalRunID = `shared-${externalAgent}`;
    const privateExternalRunID = "private-copilot-native-run-never-render";
    externalClaim = claimSharedAgentActivity(
      project, externalAgent, "delegated", privateExternalRunID, "copilot",
    );
    assert.equal(externalClaim.setPhase("working"), true);

    const overview = await formatPiTeamView(project, runtime);
    assert.match(overview,
      /Local root capacity: 2\/32 active · 1 persistent · 1 contractor/u);
    assert.match(overview,
      /Project-shared capacity: 2\/32 claims · roots \+ delegated children; contractors excluded/u);
    const workingOverview = await formatPiTeamView(project, runtime, { filter: "status:working" });
    assert.match(workingOverview, new RegExp(`working \\d{2}:\\d{2}[\\s\\S]*?/team run:${externalRunID}`, "u"),
      "the compact external row omitted elapsed time");

    const external = await formatPiTeamView(project, runtime, { filter: `run:${externalRunID}` });
    const flattened = external.replace(/\s+/gu, " ");
    assert.match(external, new RegExp(`run ${externalRunID}`, "u"),
      "the external run alias was truncated and could not be copied back into a run filter");
    assert.match(flattened, new RegExp(`owner copilot PID ${process.pid}; stop there`, "u"));
    assert.match(flattened, /Task\/model\/thinking\/usage: undisclosed/u);
    assert.doesNotMatch(external, new RegExp(privateExternalRunID, "u"));
    assert.doesNotMatch(external, new RegExp(externalClaim.snapshot.claimToken, "u"));
    assert.ok(external.split("\n").every((line) => visibleTextWidth(line) <= 96));
    for (const ownerFilter of ["owner:copilot", `pid:${process.pid}`]) {
      const ownerView = await formatPiTeamView(project, runtime, { filter: ownerFilter });
      assert.match(ownerView, new RegExp(externalRunID, "u"), `${ownerFilter} did not recover the external owner`);
    }
    const ownerMiss = await formatPiTeamView(project, runtime, { filter: "owner:missing" });
    assert.match(ownerMiss, /owner\s+runtime, or owner PID/u,
      "owner-filter no-match guidance omitted the recovery dimensions");

    for (const telemetryFilter of [
      "model:unknown",
      "thinking:unknown",
      "task:not disclosed",
      "task:undisclosed",
    ]) {
      const telemetryMiss = await formatPiTeamView(project, runtime, { filter: telemetryFilter });
      assert.doesNotMatch(
        telemetryMiss,
        new RegExp(externalRunID, "u"),
        `external undisclosed telemetry falsely matched ${telemetryFilter}`,
      );
      assert.match(telemetryMiss,
        /1 active project-shared run was not evaluated for (?:model|thinking|task): the owning process does not disclose\s+that telemetry/u);
      if (/No team member or tracked activity matches/u.test(telemetryMiss)) {
        assert.match(telemetryMiss, /No team member or tracked activity matches .* in disclosed fields/u);
      }
    }

    const [projectStore] = await readdir(join(activityHome, "agent-foundry", "team-activity-v1"));
    assert.ok(projectStore, "shared activity project store was not created");
    const externalClaimPath = join(
      activityHome, "agent-foundry", "team-activity-v1", projectStore, `${externalAgent}.json`,
    );
    const legacy = JSON.parse(await readFile(externalClaimPath, "utf8")) as Record<string, unknown>;
    assert.equal(externalClaim.release(), true);
    externalClaim = undefined;
    legacy.version = 1;
    delete legacy.ownerRuntime;
    await writeFile(externalClaimPath, JSON.stringify(legacy), "utf8");
    const legacyView = await formatPiTeamView(project, runtime, { filter: `run:${externalRunID}` });
    assert.match(legacyView.replace(/\s+/gu, " "),
      new RegExp(`owner runtime unverified \\(legacy claim\\) · PID ${process.pid}; stop in that owning Pi/Copilot process`, "u"));
    assert.doesNotMatch(legacyView, /runtime\/PID unverified/u,
      "legacy v1 hid its verified PID together with its unverified runtime");
    assert.match(await formatPiTeamView(project, runtime, { filter: `pid:${process.pid}` }),
      new RegExp(externalRunID, "u"));

    const storeSecret = "STORE_SECRET_7c5f118c_never_render";
    const privateStorePath = "C:\\Users\\alice\\private-customer\\activity.json";
    await writeFile(externalClaimPath, JSON.stringify({ storeSecret, privateStorePath }), "utf8");
    const corruptView = await formatPiTeamView(project, runtime);
    const flattenedCorrupt = corruptView.replace(/\s+/gu, " ");
    assert.match(flattenedCorrupt, /Activity store diagnostic: .*invalid .*activity claim/iu);
    assert.match(flattenedCorrupt,
      /Repair \(0 model tokens\): inspect AGENT_HARBOR_ACTIVITY_HOME—or default Agent Harbor activity store—for permissions\/content; restart owning processes; retry \/team\./u);
    assert.doesNotMatch(corruptView, new RegExp(storeSecret, "u"));
    assert.doesNotMatch(corruptView, /alice|private-customer|activity\.json/u);
    assert.doesNotMatch(corruptView,
      new RegExp(root.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"),
      "the public store diagnostic disclosed its filesystem path");
    assert.ok(corruptView.split("\n").length <= maximumPiTeamOverviewLines,
      `the actionable corrupt-store view exceeded the overview viewport:\n${corruptView}`);
    assert.ok(corruptView.split("\n").every((line) => visibleTextWidth(line) <= 96));
  } finally {
    externalClaim?.release();
    localClaim?.release();
    if (previousHome === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousHome;
    if (previousActivityHome === undefined) delete process.env.AGENT_HARBOR_ACTIVITY_HOME;
    else process.env.AGENT_HARBOR_ACTIVITY_HOME = previousActivityHome;
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
    assert.match(view, /\+31 personal members omitted; use \/team roster-page:1/u);
    assert.ok(view.split("\n").length <= maximumPiTeamOverviewLines,
      `crowded Pi overview exceeded ${maximumPiTeamOverviewLines} wrapped lines`);
    assert.doesNotMatch(view, /^● scale-member-31 /mu, "an omitted tail member unexpectedly escaped the roster cap");

    const filtered = await formatPiTeamView(project, new PiTeamRuntime(), { filter: "member:scale-member-31" });
    assert.match(filtered, /scale-member-31 · personal · ready/u);
    assert.match(filtered, /Capacity: read · model: inherits the Pi host when run/u);
    assert.doesNotMatch(filtered, /more roster members/u);
    const broadFiltered = await formatPiTeamView(project, new PiTeamRuntime(), { filter: "status:ready" });
    assert.ok(broadFiltered.split("\n").length <= maximumPiTeamOverviewLines,
      `broad Pi filter exceeded ${maximumPiTeamOverviewLines} wrapped lines`);
    assert.match(broadFiltered, /\+\d+ more roster members/u,
      "the bounded broad filter lost its exact roster omission count");
    assert.match(broadFiltered, /wrapped view lines omitted by the 30-line budget/u);
    const readyCount = (await collectPiTeamMembers(project))
      .filter(({ availability }) => availability === "ready").length;
    const benchBroad = await formatPiTeamView(project, new PiTeamRuntime(), {
      title: "bench",
      filter: "status:ready",
    });
    const shownBenchReady = (benchBroad.match(/^[●○!] .* · (?:manager|fixed|utility|bundled|personal) · ready · model:/gmu) ?? []).length;
    const omittedBenchReady = Number(/^\+(\d+) roster members? omitted;/mu.exec(benchBroad)?.[1] ?? "0");
    assert.ok(omittedBenchReady > 0, "crowded /bench did not expose a semantic roster omission count");
    assert.equal(shownBenchReady + omittedBenchReady, readyCount,
      "crowded /bench roster omission count did not account for every ready member");
    assert.ok(benchBroad.split("\n").length <= maximumPiTeamOverviewLines);
    assert.ok([view, filtered, broadFiltered, benchBroad]
      .every((output) => output.split("\n").every((line) => visibleTextWidth(line) <= 96)));
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
    assert.doesNotMatch(design.match(/! design[\s\S]*?(?=\n\nActions:|$)/u)?.[0] ?? "", /\/join/u);
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
