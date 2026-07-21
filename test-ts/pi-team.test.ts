import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { bundledPlayers } from "../src/core/defaults.js";
import { Roster } from "../src/core/lifecycle.js";
import { harnessSpec } from "../src/core/profiles.js";
import { visibleTextWidth, wrapPlainLine } from "../src/core/text-layout.js";
import {
  formatPiLiveWidget,
  formatPiLiveStatus,
  formatPiMissionReport,
  PiTeamRuntime,
  piTaskLabel,
  settlePiRootPromises,
} from "../src/adapters/pi-team-runtime.js";
import { formatPiTeamView } from "../src/adapters/pi-team-view.js";
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

test("PiTeamRuntime treats Pi all-zero usage sentinels as unknown", () => {
  const runtime = new PiTeamRuntime();
  const sentinel = runtime.begin({ project: process.cwd(), agent: "sentinel", kind: "contractor", task: "Observe" });
  runtime.observeMessageEnd(sentinel, {
    role: "assistant", responseId: "zero", provider: "router", model: "auto",
    usage: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
  });
  assert.deepEqual(runtime.get(sentinel)!.usage, {});

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
    await roster.join({ name: "privacy-reviewer", description: "Review privacy boundaries", prompt: "Review only", tools: ["read", "search"], model: "router/special" });
    const runtime = new PiTeamRuntime();
    const runId = runtime.begin({ project, agent: "privacy-reviewer", kind: "personal", task: "Review C:\\secret\\input.txt" });
    runtime.observer(runId).sessionStarted({ model: { provider: "openai-codex", id: "gpt-test" }, thinking: "low" });
    const view = await formatPiTeamView(project, runtime);
    assert.match(view, /0 model tokens/u);
    assert.match(view, /team-lead · manager/u);
    assert.match(view, /crafter · fixed/u);
    assert.match(view, /talent-scout \(\/scout\) · utility/u);
    assert.match(view, /portfolio-management · bundled · bench/u);
    assert.match(view, /privacy-reviewer · personal · working/u);
    assert.match(view, /LEAD ACCESS\nLead capacity: 2\/32\nDelegable now: crafter\nBusy \(double-booking blocked\): privacy-reviewer/u);
    assert.match(view, /SDLC coverage: 0\/6 active · 6 benched/u);
    assert.match(view, /Activate SDLC: \/bench on portfolio-management design build manage consume dispose/u);
    assert.match(view, /Task: “Review \[path\]”/u);
    assert.doesNotMatch(view, /secret\\input/u);
    assert.match(view, /Commands: \/team \[filter\]/u);
    assert.equal((view.match(/ · bundled · bench/gu) ?? []).length, bundledPlayers.size);
    const filtered = await formatPiTeamView(project, runtime, { filter: "construction" });
    assert.match(filtered, /Overall Team: .*1 working/u);
    assert.match(filtered, /No active work matches this filter/u);
    assert.doesNotMatch(filtered, /No one is working right now/u);
    const noMatch = await formatPiTeamView(project, runtime, { filter: "nonexistent-capability" });
    assert.match(noMatch, /No team member or tracked activity matches/u);
    assert.match(noMatch, /search by member ID, role, tool, skill, model, thinking, state, task\s+label, or run ID/u);
    const configuredModel = await formatPiTeamView(project, runtime, { filter: "router/special" });
    assert.match(configuredModel, /privacy-reviewer · personal · working/u);
    assert.match(configuredModel, /configured router\/special/u);
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
    runtime.setState(runId, "completed");
    const history = await formatPiTeamView(project, runtime);
    assert.equal((history.match(/^LAST MISSION$/gmu) ?? []).length, 1);
    assert.doesNotMatch(history, /^TEAM RUN/gmu, "the history view duplicated the final-report heading");
    assert.match(history, /● privacy-reviewer · run pi-run-1 · personal · completed[\s\S]*Task: “Review \[path\]”[\s\S]*openai-codex\/gpt-test \(observed\) · thinking setting low[\s\S]*total 10/u);
    assert.match(history, /└─ build · run pi-run-2 · parent pi-run-1 · bundled · completed[\s\S]*Task: “Implement \[path\] without exposing it”[\s\S]*anthropic\/worker-test \(observed\) · thinking setting high[\s\S]*total 23/u);
    assert.match(history, /Mission total .*total 33/u);
    const childHistory = await formatPiTeamView(project, runtime, { filter: "worker-test" });
    assert.match(childHistory, /LAST MISSION · MATCHING MEMBERS/u);
    assert.match(childHistory, /build · run pi-run-2 · parent pi-run-1 · bundled · completed/u);
    assert.doesNotMatch(childHistory, /privacy-reviewer · personal · completed/u);
    assert.doesNotMatch(childHistory, /Mission total/u);
    const unrelatedHistory = await formatPiTeamView(project, runtime, { filter: "crafter" });
    assert.doesNotMatch(unrelatedHistory, /Review \[path\]|worker-test|Mission total/u);
    await roster.bench("on all", bundledPlayers);
    const activated = await formatPiTeamView(project, runtime);
    assert.match(activated, /SDLC coverage: 6\/6 active · 0 benched/u);
    assert.doesNotMatch(activated, /Coverage is limited/u);
    assert.match(activated, /Delegable now: crafter, portfolio-management, design, build, manage, consume, dispose,\s+privacy-reviewer/u);
    for (const output of [view, filtered, noMatch, configuredModel, history, childHistory, activated]) {
      assert.ok(output.split("\n").every((line) => visibleTextWidth(line) <= 96), "Pi team output exceeded 96 visible columns");
    }
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
    assert.match(view, /! design · bundled · stale[\s\S]*Repair: \/bench on design; then \/reload\./u);
    assert.match(view, /! active-stale · personal · stale[\s\S]*Repair: \/bench on active-stale; then \/reload\./u);
    assert.match(view, /! registration-stale · personal · stale[\s\S]*Repair: re-run \/join with the full[\s\S]*definition and "replace":true; then \/reload\./u);
    assert.doesNotMatch(view.match(/! design[\s\S]*?(?=\n!|\n●|\n○|$)/u)?.[0] ?? "", /\/join/u);
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
