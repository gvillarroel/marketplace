import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { executeCommand } from "../src/core/commands.js";
import { bundledPlayers, trustedSkills } from "../src/core/defaults.js";
import { GhResolver, materializeGithubSkills } from "../src/core/github.js";
import { Roster } from "../src/core/lifecycle.js";
import { validatePlayer } from "../src/core/lifecycle.js";
import { harnessSpec } from "../src/core/profiles.js";
import type { GithubResolver, HarnessName, Orchestrator } from "../src/core/types.js";

for (const harness of ["copilot", "opencode", "pi"] as const) {
  test(`${harness}: all five commands share the executable contract`, async () => {
    const root = await mkdtemp(join(tmpdir(), `harbor-${harness}-`));
    const home = join(root, "home"); const project = join(root, "project");
    const calls: string[] = [];
    const orchestrator: Orchestrator = { harness, run: async (definition) => { calls.push(definition.task); return `${harness}:child`; } };
    const github: GithubResolver = {
      resolve: async () => ({ commit: "a".repeat(40), blob: "b".repeat(40) }),
      load: async () => ({ commit: "a".repeat(40), body: "Guidance" }),
    };
    const context = { roster: new Roster(harnessSpec(harness, home, project)), bundled: bundledPlayers, orchestrator, github, trustedSkills };
    const player = JSON.stringify({ name: "reviewer", description: "Review", prompt: "Review only", tools: ["read", "search"] });

    assert.match(await executeCommand("join", player, context), /joined reviewer/);
    assert.match(await executeCommand("join", player, context), /joined reviewer/, "join must be idempotent");
    assert.match(await executeCommand("bench", "off reviewer", context), /turned off/);
    assert.match(await executeCommand("bench", "on reviewer", context), /turned on/);
    const listing = await executeCommand("bench", "list", context);
    assert.match(listing, /scout \| bundled \| bench/);
    assert.match(listing, /reviewer \| personal \| on/);
    assert.match(await executeCommand("bench", "on scout", context), /turned on/);
    const spec = harnessSpec(harness, home, project);
    const scout = join(project, spec.activeDir, `scout${spec.extension}`);
    const canonicalScout = await readFile(scout, "utf8");
    await writeFile(scout, canonicalScout.replace("Repository discovery", "Outdated repository discovery"), "utf8");
    assert.match(await executeCommand("bench", "list scout", context), /scout \| bundled \| stale/);
    assert.match(await executeCommand("bench", "on scout", context), /turned on/);
    assert.match(await executeCommand("bench", "list scout", context), /scout \| bundled \| on/);
    assert.match(await executeCommand("list-skills", "zx", context), new RegExp(`${"a".repeat(40)}.*${"b".repeat(40)}`));
    assert.deepEqual(calls, [], "deterministic controls must not invoke an orchestrator or model");
    assert.equal(await executeCommand("contract", JSON.stringify({ ...JSON.parse(player), task: "one task" }), context), `${harness}:child`);
    assert.deepEqual(calls, ["one task"], "contract must create exactly one child");

    const active = join(project, spec.activeDir, `reviewer${spec.extension}`);
    const activeProfile = await readFile(active, "utf8");
    assert.match(activeProfile, new RegExp(`revision=3`));
    if (harness === "opencode") {
      assert.match(activeProfile, /  "\*": false/);
      assert.match(activeProfile, /  read: true/);
      assert.match(activeProfile, /  grep: true/);
      assert.match(activeProfile, /  bash: false/);
      assert.match(activeProfile, /  apply_patch: false/);
    }
    assert.match(await executeCommand("retire", "reviewer", context), /retired reviewer/);
  });
}

test("all harnesses reject unknown fields and unmanaged collisions identically", async () => {
  for (const harness of ["copilot", "opencode", "pi"] as HarnessName[]) {
    const root = await mkdtemp(join(tmpdir(), `harbor-invalid-${harness}-`));
    const roster = new Roster(harnessSpec(harness, join(root, "home"), join(root, "project")));
    await assert.rejects(() => roster.join({ name: "x", description: "x", prompt: "x", tools: ["read"], surprise: true }), /unknown key/);
    const spec = harnessSpec(harness, join(root, "home"), join(root, "project"));
    const collision = join(spec.project, spec.activeDir, `mine${spec.extension}`);
    await mkdir(join(spec.project, spec.activeDir), { recursive: true });
    await writeFile(collision, "user content", "utf8");
    await assert.rejects(() => roster.join({ name: "mine", description: "x", prompt: "x", tools: ["read"] }), /unmanaged collision/);
    assert.equal(await readFile(collision, "utf8"), "user content");
  }
});

test("GitHub references are bounded, validated, and require execute", async () => {
  const root = await mkdtemp(join(tmpdir(), "harbor-skills-"));
  const roster = new Roster(harnessSpec("copilot", join(root, "home"), join(root, "project")));
  const skill = { kind: "github", name: "zx-example-author", repo: "gvillarroel/zx-harness", path: "skills/zx-example-author/SKILL.md", track: "refs/heads/main" };
  await assert.rejects(() => roster.join({ name: "maker", description: "x", prompt: "x", tools: ["read"], skills: [skill] }), /require execute/);
  await assert.rejects(() => roster.join({ name: "maker", description: "x", prompt: "x", tools: ["execute"], skills: [{ ...skill, repo: "someone/else" }] }), /untrusted/);
  const { kind: _kind, ...withoutKind } = skill;
  await assert.rejects(() => roster.join({ name: "maker", description: "x", prompt: "x", tools: ["execute"], skills: [withoutKind] }), /invalid GitHub/);
  await assert.rejects(() => roster.join({ name: "maker", description: "x", prompt: "x", tools: ["execute"], skills: [{ ...skill, track: "refs/heads/a//b" }] }), /invalid GitHub/);
  const result = await roster.join({ name: "maker", description: "x", prompt: "x", tools: ["read", "execute"], skills: [skill] });
  assert.match(result, /joined maker/);
  const profile = await readFile(join(root, "project", ".github", "agents", "maker.agent.md"), "utf8");
  assert.match(profile, /Trusted GitHub skills/);
  assert.match(profile, /gvillarroel\/zx-harness/);
  assert.match(profile, /"agent-harbor\/skill"/);
  assert.match(profile, /call the `skill` tool from the `agent-harbor` MCP server exactly once/);
  assert.doesNotMatch(profile, /agent_harbor_skill/);

  const openRoot = await mkdtemp(join(tmpdir(), "harbor-skills-opencode-"));
  const openRoster = new Roster(harnessSpec("opencode", join(openRoot, "home"), join(openRoot, "project")));
  await openRoster.join({ name: "maker", description: "x", prompt: "x", tools: ["read", "execute"], skills: [skill] });
  const openProfile = await readFile(join(openRoot, "project", ".opencode", "agents", "maker.md"), "utf8");
  assert.match(openProfile, /  agent_harbor_skill: true/);
  assert.match(openProfile, /call `agent_harbor_skill` exactly once/);
});

test("GitHub resolver pins one branch and one exact blob with two read-only cancellable gh calls", async () => {
  const calls: Array<{ file: string; args: readonly string[]; signal?: AbortSignal }> = [];
  const outputs = [`${"a".repeat(40)}\n`, `${"b".repeat(40)}\n`];
  const controller = new AbortController();
  const resolver = new GhResolver(async (file, args, signal) => { calls.push({ file, args, signal }); return outputs[calls.length - 1]; });
  assert.deepEqual(await resolver.resolve(trustedSkills[0], controller.signal), { commit: "a".repeat(40), blob: "b".repeat(40) });
  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => call.file === "gh" && call.args.includes("--method") && call.args.includes("GET")));
  assert.ok(calls.every((call) => call.signal === controller.signal));
  assert.match(calls[0].args.join(" "), /git\/ref\/heads\/main/);
  assert.match(calls[1].args.join(" "), new RegExp(`contents/skills/zx-example-author/SKILL\\.md.*ref=${"a".repeat(40)}`));

  let invalidCalls = 0;
  const invalid = new GhResolver(async () => { invalidCalls += 1; return "not-a-sha"; });
  await assert.rejects(() => invalid.resolve(trustedSkills[0]), /invalid commit SHA/);
  assert.equal(invalidCalls, 1);

  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(() => new GhResolver().resolve(trustedSkills[0], aborted.signal), (error: any) => error?.name === "AbortError" && error?.code === "ABORT_ERR");
});

test("default gh runner enforces its process timeout", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harbor-gh-timeout-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const preload = join(root, "hang.cjs");
  await writeFile(preload, "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000);\n", "utf8");
  const previousOptions = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = `--require=${JSON.stringify(preload.replace(/\\/g, "/"))}`;
  const started = Date.now();
  try {
    await assert.rejects(() => new GhResolver(undefined, 25, process.execPath).resolve(trustedSkills[0]), (error: any) => {
      assert.notEqual(error?.code, "ENOENT");
      assert.ok(error?.killed === true || typeof error?.signal === "string" || /timed out|killed/i.test(error?.message ?? ""));
      return true;
    });
  } finally {
    if (previousOptions === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = previousOptions;
  }
  assert.ok(Date.now() - started < 2_000, "gh timeout must terminate promptly");
});

test("GitHub skill bodies are snapshot-loaded, bounded, validated, and materialized only in memory", async () => {
  const captured: string[][] = [];
  const resolver = new GhResolver(async (_file, args) => {
    captured.push([...args]);
    return captured.length === 1 ? `${"c".repeat(40)}\n` : Buffer.from("---\nname: zx-example-author\ndescription: Test\n---\n\nUse the smallest example.\n", "utf8");
  });
  const loaded = await resolver.load(trustedSkills[0]);
  assert.equal(loaded.commit, "c".repeat(40));
  assert.equal(loaded.body, "Use the smallest example.");
  assert.equal(captured.length, 2);
  assert.ok(captured.every((args) => args.includes("--method") && args.includes("GET")));
  assert.ok(captured[1].includes("Accept: application/vnd.github.raw+json"));
  assert.ok(captured[1].includes(`ref=${"c".repeat(40)}`));

  const definition = { name: "maker", description: "Maker", prompt: "Create one example.", tools: ["execute"] as const, skills: [trustedSkills[0]] };
  const materialized = await materializeGithubSkills(definition as any, {
    resolve: async () => ({ commit: "x".repeat(40), blob: "y".repeat(40) }),
    load: async () => ({ commit: "d".repeat(40), body: "Remote guidance" }),
  }, trustedSkills);
  assert.equal(materialized.skills, undefined);
  assert.match(materialized.prompt, /Snapshot: gvillarroel\/zx-harness@d{40}:skills\/zx-example-author\/SKILL\.md/);
  assert.match(materialized.prompt, /Remote guidance/);
  assert.match(materialized.prompt, /cannot broaden tools/);

  const invalid = new GhResolver(async (_file, args) => args.some((arg) => arg.endsWith("git/ref/heads/main"))
    ? `${"e".repeat(40)}\n` : "---\nname: somebody-else\n---\nWrong");
  await assert.rejects(() => invalid.load(trustedSkills[0]), /name does not match/);
  const oversized = new GhResolver(async (_file, args) => args.some((arg) => arg.endsWith("git/ref/heads/main"))
    ? `${"f".repeat(40)}\n` : Buffer.alloc(18_001, 0x61));
  await assert.rejects(() => oversized.load(trustedSkills[0]), /1\.\.18000/);
});

test("validation rejects every non-canonical player shape before mutation", () => {
  const base = { name: "worker", description: "Worker", prompt: "Work", tools: ["read"] };
  const invalid: unknown[] = [
    null,
    [],
    { ...base, name: "scout" },
    { ...base, description: "two\nlines" },
    { ...base, prompt: "  " },
    { ...base, tools: [] },
    { ...base, tools: ["read", "read"] },
    { ...base, tools: ["network"] },
    { ...base, model: 1 },
    { ...base, replace: "yes" },
    { ...base, unknown: true },
  ];
  for (const value of invalid) assert.throws(() => validatePlayer(value));
});

test("join rejects an oversized rendered profile before writing", async () => {
  const root = await mkdtemp(join(tmpdir(), "harbor-profile-size-"));
  const spec = harnessSpec("pi", join(root, "home"), join(root, "project"));
  await assert.rejects(
    () => new Roster(spec).join({ name: "worker", description: "Worker", prompt: "x".repeat(30_001), tools: ["read"] }),
    /profile exceeds 30000/,
  );
  await assert.rejects(() => readFile(join(spec.home, spec.registrationDir, `worker${spec.extension}`)), /ENOENT/);
});

test("contract rejects invalid input before creating any child", async () => {
  const root = await mkdtemp(join(tmpdir(), "harbor-contract-preflight-"));
  let children = 0;
  const context = {
    roster: new Roster(harnessSpec("copilot", join(root, "home"), join(root, "project"))),
    bundled: bundledPlayers,
    orchestrator: { harness: "copilot" as const, run: async () => { children += 1; return "unexpected"; } },
    github: {
      resolve: async () => ({ commit: "a".repeat(40), blob: "b".repeat(40) }),
      load: async () => ({ commit: "a".repeat(40), body: "Guidance" }),
    },
    trustedSkills,
  };
  await assert.rejects(() => executeCommand("contract", "null", context), /expected one JSON object/);
  await assert.rejects(() => executeCommand("contract", JSON.stringify({ name: "worker", description: "x", prompt: "x", tools: ["read"], task: "x", replace: true }), context), /does not accept replace/);
  await assert.rejects(() => executeCommand("contract", JSON.stringify({ name: "worker", description: "x", prompt: "x", tools: ["read"], task: "" }), context), /non-empty task/);
  assert.equal(children, 0);
});

test("ownership metadata must remain complete before cleanup", async () => {
  const alterations = [
    ['name: "worker"', 'name: "other"'],
    ["owner: agent-foundry", "owner: somebody-else"],
    ["roster: personal", "roster: unknown"],
    ['player: "worker"', 'player: "other"'],
    ['revision: "3"', 'revision: "2"'],
    ["agent-foundry:profile id=worker revision=3", "agent-foundry:profile id=worker revision=2"],
  ] as const;
  for (const [expected, replacement] of alterations) {
    const root = await mkdtemp(join(tmpdir(), "harbor-ownership-"));
    const spec = harnessSpec("copilot", join(root, "home"), join(root, "project"));
    const roster = new Roster(spec);
    await roster.join({ name: "worker", description: "x", prompt: "x", tools: ["read"] });
    const registration = join(spec.home, spec.registrationDir, `worker${spec.extension}`);
    await writeFile(registration, (await readFile(registration, "utf8")).replace(expected, replacement), "utf8");
    await assert.rejects(() => roster.retire("worker"), /owned registration not found/);
    assert.match(await readFile(join(spec.project, spec.activeDir, `worker${spec.extension}`), "utf8"), /agent-foundry:profile/);
  }
});

test("leaf symlinks are rejected before reads or writes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harbor-symlink-"));
  const spec = harnessSpec("copilot", join(root, "home"), join(root, "project"));
  const roster = new Roster(spec);
  const outside = join(root, "outside.md");
  const active = join(spec.project, spec.activeDir, `worker${spec.extension}`);
  await mkdir(join(spec.project, spec.activeDir), { recursive: true });
  await writeFile(outside, "outside", "utf8");
  try { await symlink(outside, active, "file"); }
  catch (error: any) {
    if (error?.code === "EPERM") { t.skip("file symlinks require an OS privilege"); return; }
    throw error;
  }
  await assert.rejects(() => roster.join({ name: "worker", description: "x", prompt: "x", tools: ["read"] }), /symlink traversal refused/);
  assert.equal(await readFile(outside, "utf8"), "outside");
});

test("ancestor symlinks and traversal-shaped IDs are rejected before mutation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harbor-ancestor-symlink-"));
  const project = join(root, "project"); const home = join(root, "home"); const outside = join(root, "outside");
  await Promise.all([mkdir(project, { recursive: true }), mkdir(outside, { recursive: true })]);
  const linked = join(project, ".github");
  try { await symlink(outside, linked, process.platform === "win32" ? "junction" : "dir"); }
  catch (error: any) {
    if (error?.code === "EPERM") { t.skip("directory symlinks require an OS privilege"); return; }
    throw error;
  }
  const roster = new Roster(harnessSpec("copilot", home, project));
  await assert.rejects(() => roster.join({ name: "worker", description: "x", prompt: "x", tools: ["read"] }), /symlink traversal refused/);
  await assert.rejects(() => roster.join({ name: "\.\.\/escape", description: "x", prompt: "x", tools: ["read"] }), /invalid or reserved name/);
});

test("ownership rejects duplicate metadata and the wrong roster class", async () => {
  for (const mutation of [
    (content: string) => content.replace("metadata:\n", "metadata:\n  owner: somebody-else\nmetadata:\n"),
    (content: string) => content.replace("  roster: personal", "  roster: sdlc"),
  ]) {
    const root = await mkdtemp(join(tmpdir(), "harbor-ambiguous-owner-"));
    const spec = harnessSpec("copilot", join(root, "home"), join(root, "project")); const roster = new Roster(spec);
    await roster.join({ name: "worker", description: "x", prompt: "x", tools: ["read"] });
    const registration = join(spec.home, spec.registrationDir, `worker${spec.extension}`);
    await writeFile(registration, mutation(await readFile(registration, "utf8")), "utf8");
    await assert.rejects(() => roster.retire("worker"), /owned registration not found/);
  }
});

test("concurrent roster mutations are serialized by one ownership-checked lock", async () => {
  let activeWrites = 0; let maximumWrites = 0;
  class ObservedRoster extends Roster {
    protected override async applyChange(change: { path: string; content?: string }, index: number): Promise<void> {
      activeWrites += 1; maximumWrites = Math.max(maximumWrites, activeWrites);
      try { await new Promise((resolve) => setTimeout(resolve, 10)); await super.applyChange(change, index); }
      finally { activeWrites -= 1; }
    }
  }
  const root = await mkdtemp(join(tmpdir(), "harbor-concurrent-"));
  const spec = harnessSpec("pi", join(root, "home"), join(root, "project"));
  await Promise.all([
    new ObservedRoster(spec).join({ name: "one", description: "one", prompt: "one", tools: ["read"] }),
    new ObservedRoster(spec).join({ name: "two", description: "two", prompt: "two", tools: ["read"] }),
  ]);
  assert.equal(maximumWrites, 1);
});

test("bench preflights a whole batch before mutating any player", async () => {
  const root = await mkdtemp(join(tmpdir(), "harbor-batch-"));
  const spec = harnessSpec("pi", join(root, "home"), join(root, "project"));
  const roster = new Roster(spec);
  const sage = join(spec.project, spec.activeDir, `sage${spec.extension}`);
  await mkdir(join(spec.project, spec.activeDir), { recursive: true });
  await writeFile(sage, "unmanaged", "utf8");
  await assert.rejects(() => roster.bench("on scout sage", bundledPlayers), /unmanaged collision/);
  await assert.rejects(() => readFile(join(spec.project, spec.activeDir, `scout${spec.extension}`), "utf8"), /ENOENT/);
  assert.equal(await readFile(sage, "utf8"), "unmanaged");
});

test("a failed multi-file mutation restores the complete prior state", async () => {
  class FailingRoster extends Roster {
    protected override async applyChange(change: { path: string; content?: string }, index: number): Promise<void> {
      if (index === 1) throw new Error("injected second-write failure");
      await super.applyChange(change, index);
    }
  }
  const root = await mkdtemp(join(tmpdir(), "harbor-rollback-"));
  const spec = harnessSpec("copilot", join(root, "home"), join(root, "project"));
  const registration = join(spec.home, spec.registrationDir, `worker${spec.extension}`);
  const active = join(spec.project, spec.activeDir, `worker${spec.extension}`);
  await new Roster(spec).join({ name: "worker", description: "original", prompt: "original", tools: ["read"] });
  const before = await Promise.all([readFile(registration), readFile(active)]);
  const roster = new FailingRoster(spec);
  await assert.rejects(() => roster.join({ name: "worker", description: "changed", prompt: "changed", tools: ["read"], replace: true }), /second-write failure/);
  assert.deepEqual(await readFile(registration), before[0]);
  assert.deepEqual(await readFile(active), before[1]);
});
