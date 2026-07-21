import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { listInvocablePlayerIds, listManagedActiveIds, requireInvocablePlayer } from "../src/core/active.js";
import { executeCommand } from "../src/core/commands.js";
import { formatSkillCatalog, loadSkillCatalogSources, skillCatalogConfigPath } from "../src/core/catalog.js";
import { bundledPlayers, legacyBundledPlayerIds, skillCatalogSources, trustedSkills } from "../src/core/defaults.js";
import { GhResolver, validateGithubSkill, validateGithubSkillCatalogSource } from "../src/core/github.js";
import { Roster } from "../src/core/lifecycle.js";
import { validatePlayer } from "../src/core/lifecycle.js";
import { harnessSpec } from "../src/core/profiles.js";
import { createSkillCapsule, loadConfiguredSkills, validateRepositorySkill } from "../src/core/skills.js";
import { filterTrustedSkills, formatScoutSkillMatches } from "../src/core/scout.js";
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
    assert.match(listing, /portfolio-management \| bundled \| bench/);
    assert.match(listing, /reviewer \| personal \| on/);
    assert.match(await executeCommand("bench", "on portfolio-management", context), /turned on/);
    const spec = harnessSpec(harness, home, project);
    const portfolioManagement = join(project, spec.activeDir, `portfolio-management${spec.extension}`);
    const canonicalPortfolioManagement = await readFile(portfolioManagement, "utf8");
    await writeFile(
      portfolioManagement,
      canonicalPortfolioManagement.replace(/^description: .+$/mu, 'description: "Outdated portfolio framing"'),
      "utf8",
    );
    assert.match(await executeCommand("bench", "list portfolio-management", context), /portfolio-management \| bundled \| stale/);
    assert.match(await executeCommand("bench", "on portfolio-management", context), /turned on/);
    assert.match(await executeCommand("bench", "list portfolio-management", context), /portfolio-management \| bundled \| on/);
    const skills = await executeCommand("list-skills", "zx", context);
    assert.match(skills, /^REPOSITORY\s+PATH\s+SKILL/mu);
    assert.match(skills, /gvillarroel\/zx-harness\s+skills\/zx-example-author\/SKILL\.md\s+zx-example-author/);
    assert.doesNotMatch(skills, new RegExp(`${"a".repeat(40)}|${"b".repeat(40)}`));
    assert.deepEqual(calls, [], "deterministic controls must not invoke an orchestrator or model");
    assert.equal(await executeCommand("contract", JSON.stringify({ ...JSON.parse(player), task: "one task" }), context), `${harness}:child`);
    assert.deepEqual(calls, ["one task"], "contract must create exactly one child");

    const active = join(project, spec.activeDir, `reviewer${spec.extension}`);
    const activeProfile = await readFile(active, "utf8");
    assert.match(activeProfile, new RegExp(`revision=4`));
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

test("bench tokenizes commas and spaces, deduplicates IDs, and preserves first-seen output order", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harbor-bench-tokenization-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const roster = new Roster(harnessSpec("pi", join(root, "home"), join(root, "project")));
  assert.equal(
    await roster.bench("on design, portfolio-management, design", bundledPlayers),
    "design: turned on\nportfolio-management: turned on",
  );
});

test("revision 3 personal profiles remain removable but cannot be reactivated without a revision 4 rejoin", async () => {
  for (const harness of ["copilot", "opencode", "pi"] as const) {
    const root = await mkdtemp(join(tmpdir(), `harbor-stale-personal-${harness}-`));
    const spec = harnessSpec(harness, join(root, "home"), join(root, "project"));
    const roster = new Roster(spec);
    const player = { name: "worker", description: "Worker", prompt: "Work", tools: ["read"] as const };
    await roster.join(player);
    const registration = join(spec.home, spec.registrationDir, `worker${spec.extension}`);
    const active = join(spec.project, spec.activeDir, `worker${spec.extension}`);
    const revision3 = (await readFile(registration, "utf8"))
      .replace('revision: "4"', 'revision: "3"')
      .replace("revision=4", "revision=3");
    await Promise.all([writeFile(registration, revision3, "utf8"), writeFile(active, revision3, "utf8")]);

    assert.match(await roster.bench("list worker", bundledPlayers), /worker \| personal \| stale/);
    assert.ok(!listManagedActiveIds(harness, spec.project).includes("worker"));
    await assert.rejects(() => roster.bench("on worker", bundledPlayers), /stale personal profile.*replace:true/);

    await roster.join({ ...player, replace: true });
    assert.match(await roster.bench("list worker", bundledPlayers), /worker \| personal \| on/);
    assert.ok(listManagedActiveIds(harness, spec.project).includes("worker"));
  }
});

test("bench off preserves an owned active profile when its personal registration is missing or corrupt", async (t) => {
  for (const registrationState of ["missing", "corrupt"] as const) {
    const root = await mkdtemp(join(tmpdir(), `harbor-bench-registration-${registrationState}-`));
    t.after(() => rm(root, { recursive: true, force: true }));
    const spec = harnessSpec("pi", join(root, "home"), join(root, "project"));
    const roster = new Roster(spec);
    await roster.join({ name: "worker", description: "Worker", prompt: "Work", tools: ["read"] });
    const registration = join(spec.home, spec.registrationDir, `worker${spec.extension}`);
    const active = join(spec.project, spec.activeDir, `worker${spec.extension}`);
    const activeBefore = await readFile(active);
    if (registrationState === "missing") await rm(registration);
    else await writeFile(registration, "corrupt registration\n", "utf8");

    await assert.rejects(() => roster.bench("off worker", bundledPlayers), /personal registration missing: worker/);
    assert.deepEqual(await readFile(active), activeBefore);
  }
});

test("managed dispatch rejects owned profiles whose executable frontmatter differs from the encoded definition", async () => {
  for (const harness of ["copilot", "opencode", "pi"] as const) {
    const root = await mkdtemp(join(tmpdir(), `harbor-stale-executable-${harness}-`));
    const spec = harnessSpec(harness, join(root, "home"), join(root, "project"));
    const roster = new Roster(spec);
    await roster.join({ name: "worker", description: "Worker", prompt: "Work", tools: ["read"] });
    const active = join(spec.project, spec.activeDir, `worker${spec.extension}`);
    const canonical = await readFile(active, "utf8");
    const mutated = harness === "copilot"
      ? canonical.replace('tools: ["read"]', 'tools: ["read","agent-harbor/skills_crafter"]')
      : harness === "opencode"
        ? canonical.replace("  skill: false", "  skill: true")
        : canonical.replace("tools: read", "tools: read,bash");
    assert.notEqual(mutated, canonical);
    await writeFile(active, mutated, "utf8");

    assert.ok(!listManagedActiveIds(harness, spec.project).includes("worker"));
    assert.throws(() => requireInvocablePlayer(harness, spec.project, "worker"), /stale/);
    assert.match(await roster.bench("list worker", bundledPlayers), /worker \| personal \| stale/);
  }
});

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

test("configured GitHub references are bounded, trusted, and require read", async () => {
  const root = await mkdtemp(join(tmpdir(), "harbor-skills-"));
  const roster = new Roster(harnessSpec("copilot", join(root, "home"), join(root, "project")));
  const skill = { kind: "github", name: "zx-example-author", repo: "gvillarroel/zx-harness", path: "skills/zx-example-author/SKILL.md", track: "refs/heads/main" };
  await assert.rejects(() => roster.join({ name: "maker", description: "x", prompt: "x", tools: ["execute"], skills: [skill] }), /require read/);
  await assert.rejects(() => roster.join({ name: "maker", description: "x", prompt: "x", tools: ["read"], skills: [{ ...skill, repo: "someone/else" }] }), /untrusted/);
  const { kind: _kind, ...withoutKind } = skill;
  await assert.rejects(() => roster.join({ name: "maker", description: "x", prompt: "x", tools: ["read"], skills: [withoutKind] }), /invalid GitHub/);
  await assert.rejects(() => roster.join({ name: "maker", description: "x", prompt: "x", tools: ["read"], skills: [{ ...skill, track: "refs/heads/a//b" }] }), /invalid GitHub/);
  const result = await roster.join({ name: "maker", description: "x", prompt: "x", tools: ["read"], skills: [skill] });
  assert.match(result, /joined maker/);
  const profile = await readFile(join(root, "project", ".github", "agents", "maker.agent.md"), "utf8");
  assert.match(profile, /Configured skill allowlist/);
  assert.match(profile, /"agent-harbor-skills-maker\/skills"/);
  assert.match(profile, /mcp-servers:\n  "agent-harbor-skills-maker":/);
  assert.match(profile, /"--skills-player","maker"/);
  assert.match(profile, /call the `skills` tool from the player-scoped `agent-harbor-skills-maker` MCP server exactly once/);
  assert.doesNotMatch(profile, /"agent-harbor\/skill"/);

  const openRoot = await mkdtemp(join(tmpdir(), "harbor-skills-opencode-"));
  const openRoster = new Roster(harnessSpec("opencode", join(openRoot, "home"), join(openRoot, "project")));
  await openRoster.join({ name: "maker", description: "x", prompt: "x", tools: ["read"], skills: [skill] });
  const openProfile = await readFile(join(openRoot, "project", ".opencode", "agents", "maker.md"), "utf8");
  assert.match(openProfile, /  agent_harbor_skills: true/);
  assert.match(openProfile, /call `agent_harbor_skills` exactly once/);
  assert.doesNotMatch(openProfile, /  agent_harbor_skill:/);
  assert.doesNotMatch(openProfile, /call `agent_harbor_skill` exactly once/);
});

test("repository skill references reject traversal, absolute paths, mismatched names, and cross-source duplicate names", async () => {
  const root = await mkdtemp(join(tmpdir(), "harbor-repository-skills-"));
  const project = join(root, "project");
  const exact = join(project, "skills", "exact", "SKILL.md");
  await mkdir(join(project, "skills", "exact"), { recursive: true });
  await writeFile(exact, "---\nname: exact\ndescription: Exact fixture\n---\n\nUse exact guidance only.\n", "utf8");
  const repositorySkill = { kind: "repo" as const, name: "exact", path: "skills/exact/SKILL.md" };
  const resolver: GithubResolver = {
    resolve: async () => { throw new Error("GitHub must not be called for repository skills"); },
    load: async () => { throw new Error("GitHub must not be called for repository skills"); },
  };

  const loaded = await loadConfiguredSkills({ name: "maker", description: "x", prompt: "x", tools: ["read"], skills: [repositorySkill] }, project, resolver, trustedSkills);
  assert.equal(loaded.length, 1);
  assert.deepEqual(loaded[0].reference, repositorySkill);
  assert.equal(loaded[0].body, "Use exact guidance only.");

  const base = { name: "maker", description: "x", prompt: "x", tools: ["read"] };
  assert.throws(() => validatePlayer({ ...base, skills: [{ ...repositorySkill, path: "../outside/SKILL.md" }] }), /invalid repository/);
  assert.throws(() => validatePlayer({ ...base, skills: [{ ...repositorySkill, path: "/outside/SKILL.md" }] }), /invalid repository/);
  await writeFile(exact, "---\nname: somebody-else\n---\nWrong guidance.\n", "utf8");
  await assert.rejects(() => loadConfiguredSkills({ ...base, skills: [repositorySkill] }, project, resolver, trustedSkills), /name does not match/);
  assert.throws(() => validatePlayer({
    ...base,
    skills: [{ kind: "repo", name: trustedSkills[0].name, path: "skills/exact/SKILL.md" }, trustedSkills[0]],
  }), /duplicate configured skill name/);
});

test("repository skill loading refuses symlink traversal", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harbor-repository-skill-link-"));
  const project = join(root, "project");
  const outside = join(root, "outside-SKILL.md");
  const linked = join(project, "skills", "linked", "SKILL.md");
  await Promise.all([
    mkdir(join(project, "skills", "linked"), { recursive: true }),
    writeFile(outside, "---\nname: linked\n---\nOutside guidance.\n", "utf8"),
  ]);
  try { await symlink(outside, linked, "file"); }
  catch (error: any) {
    if (error?.code === "EPERM") { t.skip("file symlinks require an OS privilege"); return; }
    throw error;
  }
  const resolver: GithubResolver = {
    resolve: async () => { throw new Error("unexpected GitHub resolve"); },
    load: async () => { throw new Error("unexpected GitHub load"); },
  };
  await assert.rejects(() => loadConfiguredSkills({
    name: "maker", description: "x", prompt: "x", tools: ["read"],
    skills: [{ kind: "repo", name: "linked", path: "skills/linked/SKILL.md" }],
  }, project, resolver, trustedSkills), /symlink traversal refused/);
});

test("skill capsules contain only the configured file and clean up their invocation root", async () => {
  const root = await mkdtemp(join(tmpdir(), "harbor-skill-capsule-contract-"));
  const project = join(root, "project");
  await Promise.all([
    mkdir(join(project, "skills", "allowed"), { recursive: true }),
    mkdir(join(project, "skills", "decoy"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(project, "skills", "allowed", "SKILL.md"), "---\nname: allowed\n---\nAllowed capsule guidance.\n", "utf8"),
    writeFile(join(project, "skills", "decoy", "SKILL.md"), "---\nname: decoy\n---\nDecoy guidance must stay out.\n", "utf8"),
  ]);
  const resolver: GithubResolver = {
    resolve: async () => { throw new Error("unexpected GitHub resolve"); },
    load: async () => { throw new Error("unexpected GitHub load"); },
  };
  const definition = {
    name: "maker", description: "x", prompt: "x", tools: ["read"] as const,
    skills: [{ kind: "repo" as const, name: "allowed", path: "skills/allowed/SKILL.md" }],
  };
  const loaded = await loadConfiguredSkills(definition, project, resolver, trustedSkills);
  assert.deepEqual(loaded.map((skill) => skill.reference.name), ["allowed"]);
  assert.doesNotMatch(loaded[0].body, /Decoy/);

  const capsule = await createSkillCapsule(definition, project, resolver, trustedSkills);
  assert.ok(capsule.root);
  assert.deepEqual(await readdir(capsule.root!), ["allowed"]);
  assert.equal(capsule.skills.length, 1);
  const document = await readFile(capsule.skills[0].filePath, "utf8");
  assert.match(document, /^---\nname: "allowed"/);
  assert.match(document, /Allowed capsule guidance/);
  assert.doesNotMatch(document, /Decoy/);
  await capsule.cleanup();
  await capsule.cleanup();
  await assert.rejects(() => access(capsule.root!), /ENOENT/);
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

test("skill catalog enumerates repository, folder, and exact-skill scopes without loading bodies", async () => {
  const tree = [
    `docs/guide.md\t${"1".repeat(40)}`,
    `skills/alpha/SKILL.md\t${"2".repeat(40)}`,
    `skills/nested/beta/SKILL.md\t${"3".repeat(40)}`,
    `other/gamma/SKILL.md\t${"4".repeat(40)}`,
  ].join("\n");
  const calls: readonly string[][] = [];
  const observed: string[][] = calls as string[][];
  const resolver = new GhResolver(async (_file, args) => {
    observed.push([...args]);
    if (args.some((arg) => arg.includes("/git/ref/"))) return `${"a".repeat(40)}\n`;
    if (args.some((arg) => arg.includes("/contents/"))) return `${"2".repeat(40)}\n`;
    return tree;
  });
  const base = { kind: "github", repo: "owner/repo", track: "refs/heads/main" } as const;
  assert.deepEqual((await resolver.listCatalog({ ...base, scope: "repository" })).map((entry) => entry.name), ["alpha", "beta", "gamma"]);
  assert.deepEqual((await resolver.listCatalog({ ...base, scope: "folder", path: "skills" })).map((entry) => entry.name), ["alpha", "beta"]);
  assert.deepEqual(await resolver.listCatalog({ ...base, scope: "skill", path: "skills/alpha/SKILL.md", name: "chosen-name" }), [{
    repo: "owner/repo", path: "skills/alpha/SKILL.md", name: "chosen-name", track: "refs/heads/main", commit: "a".repeat(40),
  }]);
  assert.equal(observed.length, 6);
  assert.equal(observed.filter((args) => args.some((arg) => arg.includes("/git/trees/"))).length, 2);
  assert.equal(observed.filter((args) => args.some((arg) => arg.includes("/contents/"))).length, 1);
  assert.ok(observed.every((args) => !args.some((arg) => arg.includes("Accept: application/vnd.github.raw"))), "catalog listing must not download skill bodies");
});

test("description view is explicit, searchable, and still omits skill bodies and commits", async () => {
  const root = await mkdtemp(join(tmpdir(), "harbor-catalog-description-"));
  const github: GithubResolver = {
    resolve: async () => ({ commit: "a".repeat(40), blob: "b".repeat(40) }),
    load: async () => { throw new Error("skill bodies must not be loaded for catalog descriptions"); },
    listCatalog: async (source) => [{
      name: "zx-example-author", repo: source.repo, path: source.path!, track: source.track, commit: "a".repeat(40),
    }],
    describeCatalog: async () => "Author small zx scripts for automation.",
  };
  const context = {
    roster: new Roster(harnessSpec("copilot", join(root, "home"), join(root, "project"))),
    bundled: bundledPlayers,
    orchestrator: { harness: "copilot", run: async () => "unused" } as Orchestrator,
    github, trustedSkills, catalogStyle: "copilot" as const,
  };
  const output = (await executeCommand("list-skills", "--descriptions automation", context)).replace(/\x1b\[[0-9;]*m/gu, "");
  assert.match(output, /REPOSITORY.*PATH.*SKILL.*DESCRIPTION/u);
  assert.match(output, /Author small zx scripts for automation\./u);
  assert.doesNotMatch(output, /a{40}|b{40}|instruction body/u);
  assert.equal((await executeCommand("list-skills", "--descriptions kubernetes", context)).split("\n").length, 4);
  await assert.rejects(() => executeCommand("list-skills", "--unknown", context), /usage/);
});

test("talent scout filters only exact trusted skills by bounded public descriptions", async () => {
  const loaded: string[] = [];
  const resolver: GithubResolver = {
    resolve: async () => { throw new Error("resolve is not used"); },
    load: async () => { throw new Error("instruction bodies must remain private"); },
    describe: async (skill) => {
      loaded.push(`${skill.repo}/${skill.path}`);
      return { commit: "c".repeat(40), description: "Author small zx examples and automation scripts." };
    },
  };
  const matches = await filterTrustedSkills("scripts zx automatizar", trustedSkills, resolver);
  assert.deepEqual(matches.map((match) => match.name), ["zx-example-author"]);
  assert.deepEqual(loaded, ["gvillarroel/zx-harness/skills/zx-example-author/SKILL.md"]);
  const serialized = formatScoutSkillMatches(matches);
  assert.match(serialized, /"description":"Author small zx examples/);
  assert.doesNotMatch(serialized, /c{40}|instruction/);
  assert.deepEqual(await filterTrustedSkills("kubernetes", trustedSkills, resolver), []);
  await assert.rejects(() => filterTrustedSkills("", trustedSkills, resolver), /1\.\.500/);
});

test("project skill catalog config replaces defaults with a closed schema", async (t) => {
  const project = await mkdtemp(join(tmpdir(), "harbor-catalog-config-"));
  t.after(() => rm(project, { recursive: true, force: true }));
  assert.deepEqual(await loadSkillCatalogSources(project, skillCatalogSources), skillCatalogSources);
  const config = skillCatalogConfigPath(project);
  await mkdir(join(project, ".agent-harbor"), { recursive: true });
  const sources = [
    { kind: "github", scope: "repository", repo: "owner/all", track: "refs/heads/main" },
    { kind: "github", scope: "folder", repo: "owner/some", path: "skills", track: "refs/heads/release" },
    { kind: "github", scope: "skill", repo: "owner/one", path: "one/SKILL.md", name: "one", track: "refs/heads/main" },
  ];
  await writeFile(config, JSON.stringify({ version: 1, sources }), "utf8");
  assert.deepEqual(await loadSkillCatalogSources(project, skillCatalogSources), sources);
  assert.throws(() => validateGithubSkillCatalogSource({ ...sources[0], path: "skills" }), /cannot define path/);
  await writeFile(config, JSON.stringify({ version: 1, sources, extra: true }), "utf8");
  await assert.rejects(() => loadSkillCatalogSources(project, skillCatalogSources), /requires exactly version 1 and sources/);
});

test("Copilot skill catalog uses a bordered three-column terminal view", () => {
  const output = formatSkillCatalog([{
    repo: "owner/repo", path: "skills/example/SKILL.md", name: "example",
  }], "copilot");
  const plain = output.replace(/\x1b\[[0-9;]*m/gu, "");
  assert.match(plain, /^╭─+┬─+┬─+╮$/mu);
  assert.match(plain, /│ REPOSITORY\s+│ PATH\s+│ SKILL\s+│/u);
  assert.match(plain, /│ owner\/repo\s+│ skills\/example\/SKILL\.md\s+│ example\s+│/u);
  assert.match(plain, /^╰─+┴─+┴─+╯$/mu);
  assert.doesNotMatch(plain, /COMMIT|BLOB|TRACK/u);
});

test("GitHub skill loading stops after one invalid branch SHA without fetching content", async () => {
  const calls: Array<{ file: string; args: readonly string[]; signal?: AbortSignal; timeoutMs?: number }> = [];
  const controller = new AbortController();
  const resolver = new GhResolver(async (file, args, signal, timeoutMs) => {
    calls.push({ file, args, signal, timeoutMs });
    return "not-a-sha";
  }, 1_234, "custom-gh");

  await assert.rejects(() => resolver.load(trustedSkills[0], controller.signal), /invalid commit SHA/);
  assert.equal(calls.length, 1);
  assert.equal(calls.filter(({ args }) => args.some((arg) => arg.includes("/contents/"))).length, 0);
  assert.equal(calls[0].file, "custom-gh");
  assert.equal(calls[0].timeoutMs, 1_234);
  assert.equal(calls[0].signal, controller.signal);
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

test("GitHub skill bodies are snapshot-loaded, bounded, and validated", async () => {
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
    { ...base, name: "portfolio-management" },
    { ...base, name: "scout" },
    { ...base, name: "talent-scout" },
    { ...base, name: "sage" },
    { ...base, name: "smith" },
    { ...base, name: "probe" },
    { ...base, name: "guard" },
    { ...base, name: "pilot" },
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

test("player and skill validators share the canonical identifier boundaries", () => {
  const validators: readonly { label: string; validate: (name: unknown) => { name: string } }[] = [
    { label: "player", validate: (name) => validatePlayer({ name, description: "x", prompt: "x", tools: ["read"] }) },
    { label: "repository skill", validate: (name) => validateRepositorySkill({ kind: "repo", name, path: "skills/example/SKILL.md" }) },
    { label: "GitHub skill", validate: (name) => validateGithubSkill({ kind: "github", name, repo: "owner/repo", path: "skills/example/SKILL.md", track: "refs/heads/main" }) },
  ];
  for (const name of ["a", "a".repeat(48)]) {
    for (const validator of validators) assert.equal(validator.validate(name).name, name, `${validator.label}: ${name.length}`);
  }
  for (const name of ["a".repeat(49), "A", "a_b", "-a", 1]) {
    for (const validator of validators) assert.throws(() => validator.validate(name), /invalid/, validator.label);
  }
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
    ['revision: "4"', 'revision: "2"'],
    ["agent-foundry:profile id=worker revision=4", "agent-foundry:profile id=worker revision=2"],
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

test("activating the current roster transactionally removes owned legacy SDLC profiles from discovery", async () => {
  for (const harness of ["copilot", "opencode", "pi"] as const satisfies readonly HarnessName[]) {
    const root = await mkdtemp(join(tmpdir(), `harbor-legacy-upgrade-${harness}-`));
    const spec = harnessSpec(harness, join(root, "home"), join(root, "project"));
    const roster = new Roster(spec);
    const activeRoot = join(spec.project, spec.activeDir);
    await mkdir(activeRoot, { recursive: true });
    for (const id of legacyBundledPlayerIds) {
      await writeFile(join(activeRoot, `${id}${spec.extension}`), spec.renderPlayer({
        name: id,
        description: `Legacy bundled player ${id}`,
        prompt: `Legacy ${id} instructions`,
        tools: ["read", "search"],
      }, "sdlc"), "utf8");
    }

    assert.match(await roster.bench("list scout", bundledPlayers), /scout \| legacy \| retired-active/);
    const result = await roster.bench("on all", bundledPlayers);
    for (const id of legacyBundledPlayerIds) {
      assert.match(result, new RegExp(`${id}: retired legacy profile removed`));
      await assert.rejects(() => readFile(join(activeRoot, `${id}${spec.extension}`), "utf8"), /ENOENT/);
      assert.ok(!listManagedActiveIds(harness, spec.project).includes(id));
      assert.ok(!listInvocablePlayerIds(harness, spec.project).includes(id));
      assert.throws(() => requireInvocablePlayer(harness, spec.project, id), /not found/);
    }
    assert.deepEqual(listManagedActiveIds(harness, spec.project), [...bundledPlayers.keys()].sort());
  }
});

test("an unmanaged legacy collision is never removed during current-roster activation", async () => {
  for (const harness of ["copilot", "opencode", "pi"] as const satisfies readonly HarnessName[]) {
    const root = await mkdtemp(join(tmpdir(), `harbor-legacy-collision-${harness}-`));
    const spec = harnessSpec(harness, join(root, "home"), join(root, "project"));
    const roster = new Roster(spec);
    const activeRoot = join(spec.project, spec.activeDir);
    const collision = join(activeRoot, `scout${spec.extension}`);
    const untouched = Buffer.from("user-owned legacy filename\n", "utf8");
    await mkdir(activeRoot, { recursive: true });
    await writeFile(collision, untouched);

    assert.match(await roster.bench("list scout", bundledPlayers), /scout \| legacy \| conflict/);
    await assert.rejects(() => roster.bench("on all", bundledPlayers), /unmanaged legacy collision: scout/);
    assert.deepEqual(await readFile(collision), untouched);
    assert.deepEqual(listManagedActiveIds(harness, spec.project), []);
    await assert.rejects(
      () => readFile(join(activeRoot, `portfolio-management${spec.extension}`), "utf8"),
      /ENOENT/,
      "legacy collision preflight must prevent partial activation",
    );
  }
});

test("legacy SDLC profiles support explicit owned cleanup but can never be reactivated", async () => {
  for (const harness of ["copilot", "opencode", "pi"] as const satisfies readonly HarnessName[]) {
    const root = await mkdtemp(join(tmpdir(), `harbor-legacy-explicit-${harness}-`));
    const spec = harnessSpec(harness, join(root, "home"), join(root, "project"));
    const roster = new Roster(spec);
    const activeRoot = join(spec.project, spec.activeDir);
    await mkdir(activeRoot, { recursive: true });
    for (const id of legacyBundledPlayerIds) {
      await writeFile(join(activeRoot, `${id}${spec.extension}`), spec.renderPlayer({
        name: id,
        description: `Legacy bundled player ${id}`,
        prompt: `Legacy ${id} instructions`,
        tools: ["read"],
      }, "sdlc"), "utf8");
    }

    await assert.rejects(() => roster.bench("on scout", bundledPlayers), /retired bundled player: scout/);
    const result = await roster.bench(`off ${legacyBundledPlayerIds.join(" ")}`, bundledPlayers);
    for (const id of legacyBundledPlayerIds) {
      assert.match(result, new RegExp(`${id}: turned off`));
      await assert.rejects(() => readFile(join(activeRoot, `${id}${spec.extension}`), "utf8"), /ENOENT/);
    }
  }
});

test("a failed current-roster activation restores legacy profiles deleted earlier in the same transaction", async () => {
  class FailingMigrationRoster extends Roster {
    protected override async applyChange(change: { path: string; content?: string }, index: number): Promise<void> {
      if (index === 2) throw new Error("injected mixed-migration failure");
      await super.applyChange(change, index);
    }
  }
  const root = await mkdtemp(join(tmpdir(), "harbor-legacy-rollback-"));
  const spec = harnessSpec("copilot", join(root, "home"), join(root, "project"));
  const activeRoot = join(spec.project, spec.activeDir);
  await mkdir(activeRoot, { recursive: true });
  const legacyBefore = new Map<string, Buffer>();
  for (const id of legacyBundledPlayerIds.slice(0, 2)) {
    const content = spec.renderPlayer({
      name: id,
      description: `Legacy bundled player ${id}`,
      prompt: `Legacy ${id} instructions`,
      tools: ["read"],
    }, "sdlc");
    const path = join(activeRoot, `${id}${spec.extension}`);
    await writeFile(path, content, "utf8");
    legacyBefore.set(id, await readFile(path));
  }

  await assert.rejects(
    () => new FailingMigrationRoster(spec).bench("on portfolio-management", bundledPlayers),
    /mixed-migration failure/,
  );
  for (const [id, before] of legacyBefore) {
    assert.deepEqual(await readFile(join(activeRoot, `${id}${spec.extension}`)), before);
  }
  await assert.rejects(
    () => readFile(join(activeRoot, `portfolio-management${spec.extension}`), "utf8"),
    /ENOENT/,
  );
});

test("bench preflights a whole batch before mutating any player", async () => {
  const root = await mkdtemp(join(tmpdir(), "harbor-batch-"));
  const spec = harnessSpec("pi", join(root, "home"), join(root, "project"));
  const roster = new Roster(spec);
  const design = join(spec.project, spec.activeDir, `design${spec.extension}`);
  await mkdir(join(spec.project, spec.activeDir), { recursive: true });
  await writeFile(design, "unmanaged", "utf8");
  await assert.rejects(() => roster.bench("on portfolio-management design", bundledPlayers), /unmanaged collision/);
  await assert.rejects(() => readFile(join(spec.project, spec.activeDir, `portfolio-management${spec.extension}`), "utf8"), /ENOENT/);
  assert.equal(await readFile(design, "utf8"), "unmanaged");
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
