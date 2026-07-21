import assert from "node:assert/strict";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { access, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import test from "node:test";
import { listManagedActiveIds, requireInvocablePlayer } from "../src/core/active.js";
import { executeCommand } from "../src/core/commands.js";
import {
  assertHarborCustomToolAccess,
  dispatchHarborCustomTool,
  formatHarborTeamRosterSnapshot,
  harborCustomToolNames,
  harborCustomToolPolicy,
  harborCustomToolsForPlayer,
  HarborInvocationLedger,
  harborPlayerFromSkillToolName,
  harborPlayerSkillToolName,
  harborPlayerSkillToolSpec,
  HarborScoutTurnGuard,
  harborStaticCustomToolSpecs,
  validateHarborCustomToolArguments,
} from "../src/core/custom-tools.js";
import { boundHarborEvidence, HarborEvidenceAccumulator } from "../src/core/evidence.js";
import { formatSkillCatalog, loadSkillCatalogSources, skillCatalogConfigPath } from "../src/core/catalog.js";
import { bundledPlayers, scoutPlayer, skillCatalogSources, trustedSkillRepositories, trustedSkills } from "../src/core/defaults.js";
import { GhResolver, InvalidSkillDocumentError, validateGithubSkill, validateGithubSkillCatalogSource } from "../src/core/github.js";
import { isOwnedProfile, Roster, validatePlayer } from "../src/core/lifecycle.js";
import { harnessSpec } from "../src/core/profiles.js";
import { visibleTextWidth, wrapPlainText } from "../src/core/text-layout.js";
import { createSkillCapsule, loadConfiguredSkills, validateRepositorySkill } from "../src/core/skills.js";
import { filterTrustedSkills, formatScoutSkillMatches } from "../src/core/scout.js";
import type { GithubResolver, GithubSkill, HarnessName, Orchestrator, TrustedGithubSkills } from "../src/core/types.js";

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
    assert.match(activeProfile, new RegExp(`revision=5`));
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

test("join returns only after lifecycle worker handles permit immediate workspace cleanup", async () => {
  const root = await mkdtemp(join(tmpdir(), "harbor-worker-close-"));
  const roster = new Roster(harnessSpec("copilot", join(root, "home"), join(root, "project")));
  await roster.join({
    name: "cleanup-player",
    description: "Exercises immediate workspace cleanup",
    prompt: "Work narrowly.",
    tools: ["read"],
  });

  let immediateCleanupError: unknown;
  try {
    await rm(root, { recursive: true, force: true, maxRetries: 0 });
  } catch (error) {
    immediateCleanupError = error;
  } finally {
    if (immediateCleanupError) {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  }
  if (immediateCleanupError) throw immediateCleanupError;
  await assert.rejects(access(root), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
});

test("unsupported ownership metadata is treated as an unmanaged collision", async () => {
  for (const harness of ["copilot", "opencode", "pi"] as const) {
    const root = await mkdtemp(join(tmpdir(), `harbor-non-current-personal-${harness}-`));
    const spec = harnessSpec(harness, join(root, "home"), join(root, "project"));
    const roster = new Roster(spec);
    const player = { name: "worker", description: "Worker", prompt: "Work", tools: ["read"] as const };
    await roster.join(player);
    const registration = join(spec.home, spec.registrationDir, `worker${spec.extension}`);
    const active = join(spec.project, spec.activeDir, `worker${spec.extension}`);
    const nonCurrent = (await readFile(registration, "utf8"))
      .replace('revision: "5"', 'revision: "unsupported"')
      .replace("revision=5", "revision=unsupported");
    await Promise.all([writeFile(registration, nonCurrent, "utf8"), writeFile(active, nonCurrent, "utf8")]);

    assert.match(await roster.bench("list worker", bundledPlayers), /worker \| personal \| conflict/);
    assert.ok(!listManagedActiveIds(harness, spec.project).includes("worker"));
    await assert.rejects(() => roster.bench("off worker", bundledPlayers), /unmanaged collision/);
    await assert.rejects(() => roster.join({ ...player, replace: true }), /unmanaged collision/);
  }
});

test("exact revision-4 ownership remains repairable but is never invocable", async (t) => {
  for (const harness of ["copilot", "opencode", "pi"] as const) {
    const root = await mkdtemp(join(tmpdir(), `harbor-legacy-r4-${harness}-`));
    t.after(() => rm(root, { recursive: true, force: true }));
    const spec = harnessSpec(harness, join(root, "home"), join(root, "project"));
    const roster = new Roster(spec);
    const player = { name: "worker", description: "Worker", prompt: "Work", tools: ["read"] as const };
    await roster.join(player);
    const registration = join(spec.home, spec.registrationDir, `worker${spec.extension}`);
    const active = join(spec.project, spec.activeDir, `worker${spec.extension}`);
    const legacy = (await readFile(registration, "utf8"))
      .replace('revision: "5"', 'revision: "4"')
      .replace("revision=5", "revision=4");
    await Promise.all([writeFile(registration, legacy, "utf8"), writeFile(active, legacy, "utf8")]);

    assert.equal(isOwnedProfile(legacy, "worker", "personal"), true);
    assert.ok(!listManagedActiveIds(harness, spec.project).includes("worker"));
    assert.match(await roster.bench("list worker", bundledPlayers), /worker \| personal \| stale/);
    await assert.rejects(() => roster.join(player), /replace:true required/);
    assert.match(await roster.join({ ...player, replace: true }), /joined worker/);
    const repaired = await readFile(registration, "utf8");
    assert.match(repaired, /revision=5/);
    assert.equal(repaired, await readFile(active, "utf8"));
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
      ? canonical.replace('tools: ["read"]', 'tools: ["read","harbor_skill_somebody-else"]')
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

test("active profile discovery bounds both directory entries and matching candidates", async (t) => {
  const irrelevantRoot = await mkdtemp(join(tmpdir(), "harbor-active-entry-cap-"));
  const candidateRoot = await mkdtemp(join(tmpdir(), "harbor-active-candidate-cap-"));
  t.after(() => Promise.all([
    rm(irrelevantRoot, { recursive: true, force: true }),
    rm(candidateRoot, { recursive: true, force: true }),
  ]));
  const irrelevantSpec = harnessSpec("copilot", join(irrelevantRoot, "home"), join(irrelevantRoot, "project"));
  const candidateSpec = harnessSpec("copilot", join(candidateRoot, "home"), join(candidateRoot, "project"));
  const irrelevantDirectory = join(irrelevantSpec.project, irrelevantSpec.activeDir);
  const candidateDirectory = join(candidateSpec.project, candidateSpec.activeDir);
  await Promise.all([mkdir(irrelevantDirectory, { recursive: true }), mkdir(candidateDirectory, { recursive: true })]);
  await Promise.all(Array.from({ length: 513 }, (_, index) =>
    writeFile(join(irrelevantDirectory, `noise-${index.toString().padStart(3, "0")}.txt`), "noise", "utf8")));
  await Promise.all(Array.from({ length: 201 }, (_, index) =>
    writeFile(join(candidateDirectory, `candidate-${index.toString().padStart(3, "0")}${candidateSpec.extension}`), "unmanaged", "utf8")));

  assert.throws(
    () => listManagedActiveIds("copilot", irrelevantSpec.project),
    /too many active profile directory entries: 513/u,
  );
  assert.throws(
    () => listManagedActiveIds("copilot", candidateSpec.project),
    /too many active profiles: 201/u,
  );
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
  const repositoryTrusted = { ...skill, name: "another-skill", repo: "gvillarroel/knowledge", path: "skills/another-skill/SKILL.md" };
  assert.doesNotThrow(() => validatePlayer({ name: "repository-maker", description: "x", prompt: "x", tools: ["read"], skills: [repositoryTrusted] }));
  assert.throws(() => validatePlayer({ name: "wrong-branch", description: "x", prompt: "x", tools: ["read"], skills: [{ ...repositoryTrusted, track: "refs/heads/release" }] }), /untrusted/);
  const { kind: _kind, ...withoutKind } = skill;
  await assert.rejects(() => roster.join({ name: "maker", description: "x", prompt: "x", tools: ["read"], skills: [withoutKind] }), /invalid GitHub/);
  await assert.rejects(() => roster.join({ name: "maker", description: "x", prompt: "x", tools: ["read"], skills: [{ ...skill, track: "refs/heads/a//b" }] }), /invalid GitHub/);
  const result = await roster.join({ name: "maker", description: "x", prompt: "x", tools: ["read"], skills: [skill] });
  assert.match(result, /joined maker/);
  const profile = await readFile(join(root, "project", ".github", "agents", "maker.agent.md"), "utf8");
  assert.match(profile, /Configured skill allowlist/);
  assert.match(profile, /"harbor_skill_maker"/);
  assert.match(profile, /call the extension tool `harbor_skill_maker` exactly once/);
  assert.doesNotMatch(profile, /mcp-servers|copilot-mcp|--skills-player/iu);

  const openRoot = await mkdtemp(join(tmpdir(), "harbor-skills-opencode-"));
  const openRoster = new Roster(harnessSpec("opencode", join(openRoot, "home"), join(openRoot, "project")));
  await openRoster.join({ name: "maker", description: "x", prompt: "x", tools: ["read"], skills: [skill] });
  const openProfile = await readFile(join(openRoot, "project", ".opencode", "agents", "maker.md"), "utf8");
  assert.match(openProfile, /  agent_harbor_skills: true/);
  assert.match(openProfile, /call `agent_harbor_skills` exactly once/);
  assert.doesNotMatch(openProfile, /  agent_harbor_skill:/);
  assert.doesNotMatch(openProfile, /call `agent_harbor_skill` exactly once/);
});

test("shared custom-tool contracts bind skill loaders to players and fail closed", async () => {
  assert.equal(harborCustomToolNames.contractPreflight, "harbor_contract");
  assert.equal(harborPlayerSkillToolName("maker"), "harbor_skill_maker");
  assert.equal(harborPlayerFromSkillToolName("harbor_skill_maker"), "maker");
  assert.equal(harborPlayerFromSkillToolName("harbor_skill_MAKER"), undefined);
  assert.equal(harborPlayerSkillToolSpec({ name: "maker" }).parameters.additionalProperties, false);
  assert.deepEqual(
    harborCustomToolsForPlayer({ name: "maker", skills: [trustedSkills[0]] }),
    ["harbor_skill_maker"],
  );
  assert.deepEqual(
    harborCustomToolsForPlayer({ name: "talent-scout" }),
    [harborCustomToolNames.teamRoster, harborCustomToolNames.filterSkills, harborCustomToolNames.joinPlayer],
  );
  assert.deepEqual(
    harborCustomToolsForPlayer({ name: "team-lead" }),
    [harborCustomToolNames.delegate, harborCustomToolNames.teamRoster],
  );
  assert.equal(harborCustomToolPolicy("harbor_skill_maker")?.principal, "bound-player");
  assert.equal(harborCustomToolPolicy(harborCustomToolNames.teamRoster)?.principal,
    "team-lead-or-talent-scout");
  assert.equal(harborStaticCustomToolSpecs.harbor_contract.parameters.additionalProperties, false);

  assert.deepEqual(
    validateHarborCustomToolArguments("harbor_skill_maker", {}),
    { kind: "player-skills", player: "maker" },
  );
  assert.deepEqual(
    validateHarborCustomToolArguments(harborCustomToolNames.contractPreflight, { definition: '{"task":"review"}' }),
    { kind: "contract-preflight", definition: '{"task":"review"}' },
  );
  assert.throws(
    () => validateHarborCustomToolArguments("harbor_skill_maker", { player: "somebody-else" }),
    /closed schema/,
  );
  assert.throws(
    () => validateHarborCustomToolArguments(harborCustomToolNames.delegate, { agent: "team-lead", task: "recurse" }),
    /recursive delegation/,
  );
  assert.doesNotThrow(() => assertHarborCustomToolAccess("harbor_skill_maker", { agent: "maker" }));
  assert.throws(
    () => assertHarborCustomToolAccess("harbor_skill_maker", { agent: "somebody-else" }),
    /not available/,
  );
  assert.throws(
    () => assertHarborCustomToolAccess(harborCustomToolNames.contractPreflight, { agent: "maker" }),
    /not available/,
  );
  assert.doesNotThrow(() => assertHarborCustomToolAccess(
    harborCustomToolNames.teamRoster, { agent: "talent-scout" },
  ));
  assert.doesNotThrow(() => assertHarborCustomToolAccess(
    harborCustomToolNames.teamRoster, { agent: "team-lead" },
  ));
  assert.throws(() => assertHarborCustomToolAccess(
    harborCustomToolNames.teamRoster, { agent: "maker" },
  ), /not available/);

  const result = await dispatchHarborCustomTool(
    harborCustomToolNames.filterSkills,
    { query: "typescript" },
    { project: process.cwd(), agent: "talent-scout" },
    {
      contractPreflight: () => "wrong",
      playerSkills: () => "wrong",
      filterSkills: (call) => `filter:${call.query}`,
      joinPlayer: () => "wrong",
      delegate: () => "wrong",
      teamRoster: () => "wrong",
    },
  );
  assert.equal(result, "filter:typescript");
});

test("custom-tool validators reject multi-megabyte strings before parse, trim, or dispatch", () => {
  const huge = "x".repeat(2_000_000);
  let effects = 0;
  const effect = () => { effects += 1; return "unexpected"; };
  const handlers = {
    contractPreflight: effect,
    playerSkills: effect,
    filterSkills: effect,
    joinPlayer: effect,
    delegate: effect,
    teamRoster: effect,
  };
  const started = performance.now();

  assert.throws(() => dispatchHarborCustomTool(
    harborCustomToolNames.joinPlayer,
    { definition: huge },
    { project: process.cwd(), agent: "talent-scout" },
    handlers,
  ), /player definition.*at most 30000 bytes/u);
  assert.throws(() => dispatchHarborCustomTool(
    harborCustomToolNames.delegate,
    { agent: "crafter", task: huge },
    { project: process.cwd(), agent: "team-lead" },
    handlers,
  ), /delegation task.*at most 30000 bytes/u);
  assert.throws(() => dispatchHarborCustomTool(
    harborCustomToolNames.filterSkills,
    { query: huge },
    { project: process.cwd(), agent: "talent-scout" },
    handlers,
  ), /skill filter query.*1-500 characters/u);
  assert.throws(() => dispatchHarborCustomTool(
    harborCustomToolNames.teamRoster,
    { query: huge },
    { project: process.cwd(), agent: "team-lead" },
    handlers,
  ), /team roster query.*80 characters/u);

  assert.equal(effects, 0);
  assert.ok(performance.now() - started < 1_000, "oversized custom-tool validation was not pre-bounded");
});

test("model-facing team rosters are complete, token-ranked across fields, path-redacted, and bounded", () => {
  const entries = Array.from({ length: 32 }, (_, index) => ({
    id: `member-${index.toString().padStart(2, "0")}`,
    role: index === 31 ? "ZX automation specialist" : `Specialist ${index}`,
    tools: ["read", "edit", "search", "execute", "ignored-fifth-tool"],
    skills: Array.from({ length: 14 }, (__, skill) => `skill-${index}-${skill}`),
    ...(index === 31 ? { configuredModel: "router/special" } : {}),
    availability: index === 31 ? "busy" as const : "ready" as const,
  }));
  const snapshot = formatHarborTeamRosterSnapshot(entries, "zx automation");
  assert.equal(snapshot.complete, true);
  assert.equal(snapshot.total, 32);
  assert.ok(Buffer.byteLength(snapshot.text, "utf8") <= 16_384);
  assert.ok(snapshot.text.indexOf('"id":"member-31"') < snapshot.text.indexOf('"id":"member-00"'));
  for (const entry of entries) assert.match(snapshot.text, new RegExp(`"id":"${entry.id}"`, "u"));
  assert.match(snapshot.text, /"id":"member-31","availability":"busy".*"model":"configured router\/special"/u);
  assert.match(snapshot.text, /"id":"member-00".*"model":"inherits host"/u);
  assert.doesNotMatch(snapshot.text, /ignored-fifth-tool|skill-31-13/u);

  const crossField = formatHarborTeamRosterSnapshot([
    {
      id: "cross-field",
      role: "TypeScript specialist for C:\\private\\repo, C:/forward/private, /home/alice/repo, src/private/config.json, and relative\\secret",
      tools: ["read"],
      skills: ["automation"],
      configuredModel: "openrouter/openai/gpt-5.4",
      availability: "ready",
    },
    { id: "role-phrase", role: "TypeScript read advisor", tools: [], availability: "ready" },
    { id: "unrelated", role: "Kubernetes operator", tools: ["execute"], availability: "ready" },
  ], "typescript and read");
  assert.equal(crossField.complete, true);
  assert.ok(crossField.text.indexOf('"id":"cross-field"') < crossField.text.indexOf('"id":"role-phrase"'),
    "exact cross-field capacity should outrank a weaker phrase match");
  assert.match(crossField.text, /"id":"cross-field".*"model":"configured openrouter\/openai\/gpt-5\.4","queryMatch":true/u);
  assert.match(crossField.text, /"id":"unrelated".*"queryMatch":false/u);
  assert.match(crossField.text, /\[path\]/u);
  assert.doesNotMatch(crossField.text, /C:\\private|C:\/forward|\/home\/alice|src\/private\/config\.json|relative\\secret/u);
  assert.match(crossField.text, /Model selection policy: reuse one sufficient ready member/u);
  assert.match(scoutPlayer.prompt, /If one ready teammate is sufficient, report its direct command and stop without filtering or joining/u);

  const unicodeQuery = formatHarborTeamRosterSnapshot([
    { id: "unicode-reviewer", role: "安全审查 specialist", tools: ["read"], availability: "ready" },
    { id: "other-reviewer", role: "General reviewer", tools: ["read"], availability: "ready" },
  ], "审查 read");
  assert.match(unicodeQuery.text, /"id":"unicode-reviewer".*"queryMatch":true/u);
  assert.match(unicodeQuery.text, /"id":"other-reviewer".*"queryMatch":false/u);

  const overCapacity = formatHarborTeamRosterSnapshot([
    ...entries,
    { id: "member-32", role: "Extra", tools: ["read"], availability: "ready" as const },
  ]);
  assert.equal(overCapacity.complete, false);
  assert.equal(overCapacity.total, 33);
  assert.match(overCapacity.text, /No partial roster was disclosed and recruitment is blocked/u);
  assert.doesNotMatch(overCapacity.text, /"id":"member-/u);

  const privateMetadata = formatHarborTeamRosterSnapshot([{
    id: "private-metadata",
    role: `Review C:/Users/alice/secret.txt with Bearer abcdefghijklmnop ${"x".repeat(2_000_000)}private-suffix`,
    tools: ["read"],
    configuredModel: "openrouter/openai/gpt-5.4",
    availability: "ready",
  }]);
  assert.match(privateMetadata.text, /Review \[path\] with \[redacted\]/u);
  assert.match(privateMetadata.text, /configured openrouter\/openai\/gpt-5\.4/u);
  assert.doesNotMatch(privateMetadata.text, /alice|secret\.txt|abcdefghijklmnop|private-suffix|x{100}/u);
});

test("the shared scout guard enforces structural sequencing but leaves semantic sufficiency to recruiter policy", () => {
  const incomplete = new HarborScoutTurnGuard();
  const incompleteRoster = incomplete.begin(harborCustomToolNames.teamRoster);
  incomplete.succeed(incompleteRoster, { rosterComplete: false });
  assert.throws(
    () => incomplete.begin(harborCustomToolNames.filterSkills),
    /requires one successful complete harbor_team_roster snapshot/u,
  );
  assert.throws(() => incomplete.begin(harborCustomToolNames.teamRoster), /exactly once/u);

  // The guard deliberately receives no roster rows or capability judgment. A
  // complete snapshot unlocks the structurally valid filter/join sequence; the
  // model-facing anti-duplicate instruction above owns semantic sufficiency.
  const capabilityBlind = new HarborScoutTurnGuard();
  const capabilityRoster = capabilityBlind.begin(harborCustomToolNames.teamRoster);
  capabilityBlind.succeed(capabilityRoster, { rosterComplete: true });
  const capabilityFilter = capabilityBlind.begin(harborCustomToolNames.filterSkills);
  capabilityBlind.succeed(capabilityFilter);
  const capabilityJoin = capabilityBlind.begin(harborCustomToolNames.joinPlayer);
  assert.equal(capabilityJoin.name, harborCustomToolNames.joinPlayer);
  capabilityBlind.succeed(capabilityJoin);
  assert.equal(capabilityBlind.terminal, true);

  const guard = new HarborScoutTurnGuard();
  assert.throws(
    () => guard.begin(harborCustomToolNames.joinPlayer),
    /requires one successful complete harbor_team_roster snapshot/u,
  );
  const roster = guard.begin(harborCustomToolNames.teamRoster);
  assert.throws(() => guard.begin(harborCustomToolNames.filterSkills), /must run sequentially/u);
  guard.succeed(roster, { rosterComplete: true });
  assert.throws(
    () => guard.begin(harborCustomToolNames.joinPlayer),
    /requires a successful harbor_filter_skills call first/u,
  );
  for (let call = 0; call < 3; call += 1) {
    const filter = guard.begin(harborCustomToolNames.filterSkills);
    guard.succeed(filter);
  }
  assert.throws(() => guard.begin(harborCustomToolNames.filterSkills), /per-run limit \(3\)/u);
  const joinCall = guard.begin(harborCustomToolNames.joinPlayer);
  guard.succeed(joinCall);
  assert.equal(guard.terminal, true);
  assert.throws(() => guard.begin(harborCustomToolNames.joinPlayer), /terminal: join completed/u);

  const aborted = new HarborScoutTurnGuard();
  const controller = new AbortController();
  controller.abort(new DOMException("host cancelled", "AbortError"));
  assert.throws(() => aborted.begin(harborCustomToolNames.teamRoster, controller.signal), { name: "AbortError" });
  assert.equal(aborted.terminal, true);
  assert.throws(() => aborted.begin(harborCustomToolNames.teamRoster), /terminal: aborted/u);

  const privateFailure = new HarborScoutTurnGuard();
  privateFailure.terminate("failed at C:/Users/alice/secret.txt with Bearer abcdefghijklmnop");
  assert.throws(
    () => privateFailure.begin(harborCustomToolNames.teamRoster),
    (error: any) => /terminal: failed at \[path\] with \[redacted\]/u.test(error.message)
      && !/alice|secret\.txt|abcdefghijklmnop/u.test(error.message),
  );
});

test("fixed-memory invocation ledgers reject oversized identities, active saturation, and replay after eviction", () => {
  interface State { terminal: boolean }
  const lifecycle = {
    create: (): State => ({ terminal: false }),
    terminal: (state: State) => state.terminal,
    terminate: (state: State) => { state.terminal = true; },
  };
  const ledger = new HarborInvocationLedger(lifecycle, 2);
  assert.throws(() => ledger.acquire(["scope"], ["x".repeat(4_097)]), /identity is invalid or oversized/u);
  const first = ledger.acquire(["session"], ["session", "turn-1"]);
  assert.equal(first.id.includes("session"), false, "raw host IDs leaked through the ledger key");
  ledger.terminate(first.id);
  ledger.acquire(["session"], ["session", "turn-2"]);
  ledger.acquire(["session"], ["session", "turn-3"]);
  assert.throws(
    () => ledger.acquire(["session"], ["session", "turn-1"]),
    /terminal or replayed/u,
    "eviction reopened a spent invocation budget",
  );

  const saturated = new HarborInvocationLedger(lifecycle, 1);
  saturated.acquire(["scope-a"], ["active-a"]);
  assert.throws(() => saturated.acquire(["scope-b"], ["active-b"]), /full of active turns/u);
  saturated.terminateScope(["scope-a"]);
  saturated.acquire(["scope-b"], ["active-b"]);
  assert.throws(() => saturated.acquire(["scope-a"], ["active-a"]), /terminal or replayed/u);

  const scoped = new HarborInvocationLedger(lifecycle, 2);
  const scopeA = scoped.acquire(["scope-a"], ["same-host-invocation"]);
  const scopeB = scoped.acquire(["scope-b"], ["same-host-invocation"]);
  assert.notEqual(scopeA.id, scopeB.id);
  assert.notEqual(scopeA.value, scopeB.value, "one host invocation identity aliased state across scopes");
});

test("settled and streaming child evidence share an explicit UTF-8 byte cap", () => {
  const source = `header:${"🙂".repeat(400)}:tail`;
  const bounded = boundHarborEvidence(source, 512);
  assert.equal(bounded.truncated, true);
  assert.equal(bounded.utf8Bytes, Buffer.byteLength(source, "utf8"));
  assert.ok(Buffer.byteLength(bounded.text, "utf8") <= 512);
  assert.match(bounded.text, /\[HARBOR-EVIDENCE-TRUNCATED original_utf8_bytes=1612 limit=512\]$/u);
  assert.doesNotMatch(bounded.text, /�/u);

  const accumulator = new HarborEvidenceAccumulator(512);
  accumulator.append("header:");
  accumulator.append("🙂".repeat(400));
  accumulator.append(":tail");
  const streamed = accumulator.result();
  assert.equal(streamed.truncated, true);
  assert.equal(streamed.utf8Bytes, bounded.utf8Bytes);
  assert.ok(Buffer.byteLength(streamed.text, "utf8") <= 512);
  assert.match(streamed.text, /\[HARBOR-EVIDENCE-TRUNCATED original_utf8_bytes=1612 limit=512\]$/u);
  assert.doesNotMatch(streamed.text, /�/u);

  const huge = `prefix:${"🙂".repeat(500_000)}:unretained-tail`;
  const started = performance.now();
  const hugeBounded = boundHarborEvidence(huge, 512);
  assert.equal(hugeBounded.truncated, true);
  assert.equal(hugeBounded.utf8Bytes, Buffer.byteLength(huge, "utf8"));
  assert.ok(Buffer.byteLength(hugeBounded.text, "utf8") <= 512);
  assert.doesNotMatch(hugeBounded.text, /unretained-tail|�/u);
  assert.ok(performance.now() - started < 1_000, "huge evidence prefixing was not allocation-bounded");
  assert.throws(() => boundHarborEvidence("x", 1_000_001), /between 256 and 1000000/u);
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

test("repository skill loading binds one opened file identity across path replacement", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harbor-repository-skill-race-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, "project");
  const directory = join(project, "skills", "raced");
  const target = join(directory, "SKILL.md");
  const original = join(directory, "opened-SKILL.md");
  const replacement = join(directory, "replacement-SKILL.md");
  await mkdir(directory, { recursive: true });
  await Promise.all([
    writeFile(target, "---\nname: raced\n---\nOpened guidance.\n", "utf8"),
    writeFile(replacement, "---\nname: raced\n---\nReplacement guidance.\n", "utf8"),
  ]);
  const controller = new AbortController();
  const originalThrowIfAborted = controller.signal.throwIfAborted.bind(controller.signal);
  let cancellationChecks = 0;
  Object.defineProperty(controller.signal, "throwIfAborted", {
    configurable: true,
    value: () => {
      cancellationChecks += 1;
      // The tenth check occurs after the target has been opened and before
      // its first path/handle identity comparison.
      if (cancellationChecks === 10) {
        renameSync(target, original);
        renameSync(replacement, target);
      }
      originalThrowIfAborted();
    },
  });
  const resolver: GithubResolver = {
    resolve: async () => { throw new Error("unexpected GitHub resolve"); },
    load: async () => { throw new Error("unexpected GitHub load"); },
  };

  await assert.rejects(() => loadConfiguredSkills({
    name: "maker", description: "x", prompt: "x", tools: ["read"],
    skills: [{ kind: "repo", name: "raced", path: "skills/raced/SKILL.md" }],
  }, project, resolver, trustedSkills, controller.signal), /changed while being opened/u);
  assert.ok(cancellationChecks >= 10);
});

test("repository skills reject oversized files before parsing and honor cancellation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harbor-repository-skill-bounds-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, "project");
  const directory = join(project, "skills", "oversized");
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "SKILL.md"),
    `---\nname: oversized\n---\n${"x".repeat(18_001)}`,
    "utf8",
  );
  const reference = { kind: "repo" as const, name: "oversized", path: "skills/oversized/SKILL.md" };
  const resolver: GithubResolver = {
    resolve: async () => { throw new Error("unexpected GitHub resolve"); },
    load: async () => { throw new Error("unexpected GitHub load"); },
  };
  const definition = { name: "maker", description: "x", prompt: "x", tools: ["read"] as const, skills: [reference] };
  await assert.rejects(
    () => loadConfiguredSkills(definition, project, resolver, trustedSkills),
    /repository skill body must be 1\.\.18000 UTF-8 bytes/u,
  );

  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(
    () => loadConfiguredSkills(definition, project, resolver, trustedSkills, aborted.signal),
    (error: any) => error?.name === "AbortError",
  );
});

test("configured skill combined limit stops progressively and cancellation stops the next source", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harbor-progressive-skill-limit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, "project");
  for (const name of ["first", "second"]) {
    const directory = join(project, "skills", name);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "SKILL.md"), `---\nname: ${name}\n---\n${name[0].repeat(15_500)}`, "utf8");
  }
  let remoteCalls = 0;
  const resolver: GithubResolver = {
    resolve: async () => { throw new Error("unexpected GitHub resolve"); },
    load: async () => {
      remoteCalls += 1;
      return { commit: "a".repeat(40), body: "remote guidance" };
    },
  };
  await assert.rejects(() => loadConfiguredSkills({
    name: "maker", description: "x", prompt: "x", tools: ["read"],
    skills: [
      { kind: "repo", name: "first", path: "skills/first/SKILL.md" },
      { kind: "repo", name: "second", path: "skills/second/SKILL.md" },
      trustedSkills[0],
    ],
  }, project, resolver, trustedSkills), /configured skill guidance exceeds 30000 UTF-8 bytes/u);
  assert.equal(remoteCalls, 0, "a source after the progressive combined limit was still loaded");

  const controller = new AbortController();
  const cancellableResolver: GithubResolver = {
    resolve: async () => { throw new Error("unexpected GitHub resolve"); },
    load: async () => {
      remoteCalls += 1;
      controller.abort();
      return { commit: "b".repeat(40), body: "cancel now" };
    },
  };
  await assert.rejects(() => loadConfiguredSkills({
    name: "maker", description: "x", prompt: "x", tools: ["read"],
    skills: [trustedSkills[0], { kind: "repo", name: "first", path: "skills/first/SKILL.md" }],
  }, project, cancellableResolver, trustedSkills, controller.signal), (error: any) => error?.name === "AbortError");
  assert.equal(remoteCalls, 1, "cancellation did not stop before the next configured source");
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
  assert.ok(observed.filter((args) => args.some((arg) => arg.includes("/git/trees/"))).every((args) => args.some((arg) => arg.includes('endswith("/SKILL.md")'))));
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
  assert.match(output, /Author small zx scripts[\s\S]*for automation\./u);
  assert.ok(output.split("\n").every((line) => visibleTextWidth(line) <= 96));
  assert.doesNotMatch(output, /a{40}|b{40}|instruction body/u);
  assert.equal((await executeCommand("list-skills", "--descriptions kubernetes", context)).split("\n").length, 4);
  await assert.rejects(() => executeCommand("list-skills", "--unknown", context), /usage/);
});

test("description view filters catalogs larger than 64 before its bounded metadata lookup", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harbor-large-catalog-description-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const described: string[] = [];
  let modelCalls = 0;
  const source = { kind: "github", scope: "repository", repo: "owner/large-catalog", track: "refs/heads/main" } as const;
  const entries = Array.from({ length: 70 }, (_, index) => ({
    name: `skill-${index.toString().padStart(3, "0")}`,
    repo: source.repo,
    path: `skills/skill-${index.toString().padStart(3, "0")}/SKILL.md`,
    track: source.track,
  }));
  const github: GithubResolver = {
    resolve: async () => ({ commit: "a".repeat(40), blob: "b".repeat(40) }),
    load: async () => { throw new Error("skill bodies must not be loaded for catalog descriptions"); },
    listCatalog: async () => entries,
    describeCatalog: async (entry) => {
      described.push(entry.name);
      return `Public description for ${entry.name}.`;
    },
  };
  const context = {
    roster: new Roster(harnessSpec("pi", join(root, "home"), join(root, "project"))),
    bundled: bundledPlayers,
    orchestrator: {
      harness: "pi",
      run: async () => { modelCalls += 1; throw new Error("model must not be called"); },
    } as Orchestrator,
    github,
    trustedSkills,
    catalogSources: [source],
  };

  const output = await executeCommand("list-skills", "--descriptions skill-069", context);
  assert.match(output, /skill-069[\s\S]*Public description for[\s\S]*skill-069\./u);
  assert.doesNotMatch(output, /skill-000/u);
  assert.ok(output.split("\n").every((line) => visibleTextWidth(line) <= 96));
  assert.deepEqual(described, ["skill-069"]);
  assert.equal(modelCalls, 0);

  await assert.rejects(
    () => executeCommand("list-skills", "--descriptions skill-", context),
    /matches 70 skills.*at most 64.*skill name, repository, or path/u,
  );
  assert.deepEqual(described, ["skill-069"], "over-broad filters must fail before description requests");
  assert.equal(modelCalls, 0);
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
  const exactOnly: TrustedGithubSkills = [trustedSkills[0]];
  const matches = await filterTrustedSkills("scripts zx automatizar", exactOnly, resolver);
  assert.deepEqual(matches.map((match) => match.name), ["zx-example-author"]);
  assert.deepEqual(loaded, ["gvillarroel/zx-harness/skills/zx-example-author/SKILL.md"]);
  const serialized = formatScoutSkillMatches(matches);
  assert.match(serialized, /"description":"Author small zx examples/);
  assert.doesNotMatch(serialized, /c{40}|instruction/);
  assert.deepEqual(await filterTrustedSkills("kubernetes", exactOnly, resolver), []);
  await assert.rejects(() => filterTrustedSkills("", exactOnly, resolver), /1\.\.500/);
});

test("talent scout discovers exact skill references across trusted repositories", async () => {
  const listed: string[] = [];
  const described: string[] = [];
  const repositories = trustedSkillRepositories.slice(0, 2);
  const trust: TrustedGithubSkills = Object.assign([] as GithubSkill[], { repositories });
  const resolver: GithubResolver = {
    resolve: async () => { throw new Error("resolve is not used"); },
    load: async () => { throw new Error("instruction bodies must remain private"); },
    listCatalog: async (source) => {
      listed.push(source.repo);
      const name = source.repo.endsWith("/knowledge") ? "semantic-search" : "contract";
      return [{ name, repo: source.repo, path: `skills/${name}/SKILL.md`, track: source.track, commit: "a".repeat(40) }];
    },
    describe: async (skill) => {
      described.push(`${skill.repo}/${skill.path}`);
      return { commit: "b".repeat(40), description: skill.name === "semantic-search" ? "Search semantic knowledge." : "Create one contractor." };
    },
    inspectCatalog: async (entry) => {
      if (entry.name === "contract") throw new InvalidSkillDocumentError("oversized fixture skill");
      return { name: entry.name, description: "Search semantic knowledge." };
    },
  };

  const matches = await filterTrustedSkills("semantic knowledge", trust, resolver);
  assert.deepEqual(matches.map(({ name, repo }) => [name, repo]), [["semantic-search", "gvillarroel/knowledge"]]);
  assert.deepEqual(listed, repositories.map(({ repo }) => repo));
  assert.deepEqual(described, []);
});

test("talent scout narrows large catalogs before bounded-concurrency metadata requests", async () => {
  const repository = trustedSkillRepositories[0];
  const repositories = Array.from({ length: 8 }, (_, index) => ({
    ...repository,
    repo: `owner/catalog-${index}`,
  }));
  const trust: TrustedGithubSkills = Object.assign([] as GithubSkill[], { repositories });
  const entries = Array.from({ length: 80 }, (_, index) => {
    const selected = index >= 72;
    const name = `${selected ? "target" : "skill"}-${index.toString().padStart(3, "0")}`;
    return {
      name,
      repo: repositories[0].repo,
      path: `skills/${name}/SKILL.md`,
      track: repository.track,
      commit: "a".repeat(40),
    };
  });
  const inspected: string[] = [];
  let active = 0;
  let maximumActive = 0;
  let activeListings = 0;
  let maximumActiveListings = 0;
  const resolver: GithubResolver = {
    resolve: async () => { throw new Error("resolve is not used"); },
    load: async () => { throw new Error("instruction bodies must remain private"); },
    describe: async () => { throw new Error("catalog candidates must use inspectCatalog"); },
    listCatalog: async (source) => {
      activeListings += 1;
      maximumActiveListings = Math.max(maximumActiveListings, activeListings);
      await new Promise<void>((resolve) => setImmediate(resolve));
      activeListings -= 1;
      return source.repo === repositories[0].repo ? entries : [];
    },
    inspectCatalog: async (entry) => {
      inspected.push(entry.name);
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise<void>((resolve) => setImmediate(resolve));
      active -= 1;
      return { name: entry.name, description: `Target automation metadata for ${entry.name}.` };
    },
  };

  const matches = await filterTrustedSkills("target automation", trust, resolver);
  assert.deepEqual(matches.map(({ name }) => name), entries.slice(72).map(({ name }) => name));
  assert.deepEqual([...inspected].sort(), entries.slice(72).map(({ name }) => name));
  assert.equal(maximumActiveListings, 4, "catalog enumeration concurrency exceeded the scout ceiling");
  assert.equal(maximumActive, 4, "metadata request concurrency exceeded the scout ceiling");

  inspected.length = 0;
  await assert.rejects(
    () => filterTrustedSkills("skill-", trust, resolver),
    /still matches 72 trusted skills.*narrow the query to at most 64 candidates by skill name, repository, or path/u,
  );
  assert.deepEqual(inspected, [], "an over-broad coordinate query reached metadata lookup");

  await assert.rejects(
    () => filterTrustedSkills("description-only capability", trust, resolver),
    /cannot safely inspect descriptions across 80 trusted skills.*narrow the query to at most 64 candidates/u,
  );
  assert.deepEqual(inspected, [], "a description-only broad query reached metadata lookup");
});

test("project skill catalog config replaces defaults with a closed schema", async (t) => {
  const project = await mkdtemp(join(tmpdir(), "harbor-catalog-config-"));
  t.after(() => rm(project, { recursive: true, force: true }));
  assert.deepEqual(await loadSkillCatalogSources(project, skillCatalogSources), skillCatalogSources);
  assert.deepEqual(skillCatalogSources, trustedSkillRepositories);
  assert.deepEqual(skillCatalogSources.map(({ repo }) => repo), [
    "gvillarroel/knowledge",
    "gvillarroel/marketplace",
    "gvillarroel/pi-menton",
    "gvillarroel/sdlc",
    "gvillarroel/skills",
    "gvillarroel/slidev-manim",
    "gvillarroel/zx-harness",
  ]);
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
  assert.ok(output.split("\n").every((line) => visibleTextWidth(line) <= 96));
});

test("catalog wrapping respects wide terminal cells when Pi wraps the formatted table again", () => {
  const table = formatSkillCatalog([{
    repo: "组织/仓库",
    path: `skills/${"界".repeat(80)}/SKILL.md`,
    name: "🙂".repeat(30),
  }], "plain");
  const output = wrapPlainText(`Agent Harbor /list-skills · 0 model tokens\n${table}`);
  const fixtureColumns = (line: string): number => [...line].reduce((sum, point) => {
    if (/\p{Mark}/u.test(point)) return sum;
    if (/\p{Extended_Pictographic}/u.test(point)) return sum + 2;
    const code = point.codePointAt(0)!;
    return sum + (code >= 0x2e80 && code <= 0x9fff ? 2 : 1);
  }, 0);
  assert.ok(output.split("\n").every((line) => fixtureColumns(line) <= 96), output);
  assert.match(output, /组织\/仓库/u);
  assert.match(output, /界{10,}/u);
  assert.match(output, /🙂{10,}/u);
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
    { ...base, name: "reload" },
    { ...base, name: "model" },
    { ...base, name: "player" },
    { ...base, description: "two\nlines" },
    { ...base, description: "unsafe\u001b[31m" },
    { ...base, description: "unsafe\u0085next" },
    { ...base, description: "unsafe\u202eforged" },
    { ...base, description: "x".repeat(501) },
    { ...base, prompt: "  " },
    { ...base, prompt: "x".repeat(18_001) },
    { ...base, tools: [] },
    { ...base, tools: ["read", "read"] },
    { ...base, tools: ["network"] },
    { ...base, model: 1 },
    { ...base, model: "   " },
    { ...base, model: "router/x\n● forged-member · working" },
    { ...base, model: "router/x\u001b[31m" },
    { ...base, model: "router/x\u2066forged" },
    { ...base, model: "x".repeat(201) },
    { ...base, replace: "yes" },
    { ...base, skills: ["zx-example-author"] },
    { ...base, unknown: true },
  ];
  for (const value of invalid) assert.throws(() => validatePlayer(value));
  assert.deepEqual(
    validatePlayer({ ...base, description: " Worker ", prompt: " Work ", model: " model-alias " }),
    { ...base, description: "Worker", prompt: "Work", model: "model-alias" },
  );
  assert.equal(validatePlayer({ ...base, prompt: "First line\nSecond line" }).prompt, "First line\nSecond line");
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

test("join rejects an oversized prompt before writing", async () => {
  const root = await mkdtemp(join(tmpdir(), "harbor-profile-size-"));
  const spec = harnessSpec("pi", join(root, "home"), join(root, "project"));
  await assert.rejects(
    () => new Roster(spec).join({ name: "worker", description: "Worker", prompt: "x".repeat(30_001), tools: ["read"] }),
    /invalid prompt/,
  );
  await assert.rejects(() => readFile(join(spec.home, spec.registrationDir, `worker${spec.extension}`)), /ENOENT/);
  await assert.rejects(
    () => new Roster(spec).join({ name: "unicode-worker", description: "Worker", prompt: "é".repeat(17_000), tools: ["read"] }),
    /profile exceeds 30000 bytes/,
  );
});

test("personal roster limits are explicit and replacement does not consume another slot", async () => {
  const root = await mkdtemp(join(tmpdir(), "harbor-roster-limit-"));
  const spec = harnessSpec("pi", join(root, "home"), join(root, "project"));
  const registrationRoot = join(spec.home, spec.registrationDir);
  await mkdir(registrationRoot, { recursive: true });
  await Promise.all(Array.from({ length: 200 }, (_, index) =>
    writeFile(join(registrationRoot, `slot-${index}${spec.extension}`), "unmanaged", "utf8")));
  await assert.rejects(
    () => new Roster(spec).join({ name: "new-member", description: "New", prompt: "Work", tools: ["read"] }),
    /roster limit reached \(200\)/u,
  );
  await writeFile(join(registrationRoot, `overflow${spec.extension}`), "unmanaged", "utf8");
  await assert.rejects(() => new Roster(spec).bench("list", bundledPlayers), /201 registrations/u);

  const replaceRoot = await mkdtemp(join(tmpdir(), "harbor-roster-replace-"));
  const replaceSpec = harnessSpec("pi", join(replaceRoot, "home"), join(replaceRoot, "project"));
  const roster = new Roster(replaceSpec);
  await roster.join({ name: "member", description: "Old", prompt: "Work", tools: ["read"] });
  const replaceRegistrationRoot = join(replaceSpec.home, replaceSpec.registrationDir);
  await Promise.all(Array.from({ length: 199 }, (_, index) =>
    writeFile(join(replaceRegistrationRoot, `occupied-${index}${replaceSpec.extension}`), "unmanaged", "utf8")));
  assert.match(await roster.join({ name: "member", description: "New", prompt: "Work", tools: ["read"], replace: true }), /joined member/u);
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
    ['revision: "5"', 'revision: "2"'],
    ["agent-foundry:profile id=worker revision=5", "agent-foundry:profile id=worker revision=2"],
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

test("retire cleans a verified legacy personal profile whose name is now reserved", async () => {
  const root = await mkdtemp(join(tmpdir(), "harbor-retire-reserved-"));
  const spec = harnessSpec("pi", join(root, "home"), join(root, "project"));
  const roster = new Roster(spec);
  const legacy = { name: "reload", description: "Legacy", prompt: "Legacy", tools: ["read"] as const };
  const content = spec.renderPlayer(legacy, "personal");
  const registration = join(spec.home, spec.registrationDir, `reload${spec.extension}`);
  const active = join(spec.project, spec.activeDir, `reload${spec.extension}`);
  await Promise.all([mkdir(join(spec.home, spec.registrationDir), { recursive: true }), mkdir(join(spec.project, spec.activeDir), { recursive: true })]);
  await Promise.all([writeFile(registration, content, "utf8"), writeFile(active, content, "utf8")]);
  await assert.rejects(() => roster.join(legacy), /invalid or reserved name/);
  assert.match(await roster.retire("reload"), /retired reload/u);
  await Promise.all([assert.rejects(() => readFile(registration), /ENOENT/u), assert.rejects(() => readFile(active), /ENOENT/u)]);
});

test("retire is idempotent only when registration and active copies are both absent", async (t) => {
  const base = join(process.cwd(), "work");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, "harbor-retire-idempotent-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const spec = harnessSpec("pi", join(root, "home"), join(root, "project"));
  const result = await new Roster(spec).retire("worker");
  assert.match(result, /already absent/u);
  await Promise.all([
    assert.rejects(() => access(join(spec.home, spec.registrationDir, `worker${spec.extension}`)), /ENOENT/u),
    assert.rejects(() => access(join(spec.project, spec.activeDir, `worker${spec.extension}`)), /ENOENT/u),
  ]);
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

const parentRenameBlockCodes = new Set(["EACCES", "EBUSY", "EPERM"]);

test("lifecycle selects a safe Node runtime when process.execPath is a packaged host", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harbor-packaged-host-runtime-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const spec = harnessSpec("copilot", join(root, "home"), join(root, "project"));
  const projectBin = join(spec.project, "untrusted-bin");
  const missingPreload = join(spec.project, "must-not-be-preloaded.cjs");
  class PackagedHostRoster extends Roster {
    protected override lifecycleHostExecutable(): string {
      return join(spec.project, "copilot.exe");
    }

    protected override lifecycleHostEnvironment(): NodeJS.ProcessEnv {
      const environment: NodeJS.ProcessEnv = {
        ...process.env,
        // Empty, relative, and project-owned entries precede one valid absolute
        // Node directory. Selection must skip the first four without asking a
        // shell or resolving them against the project.
        PATH: ["", ".", "relative-bin", projectBin, dirname(process.execPath)].join(delimiter),
        // Either variable would break or alter the eval worker if inherited.
        NODE_OPTIONS: `--require=${missingPreload}`,
        NODE_PATH: projectBin,
      };
      delete environment.npm_node_execpath;
      delete environment.NODE_HOME;
      delete environment.NVM_BIN;
      delete environment.NVM_SYMLINK;
      delete environment.FNM_MULTISHELL_PATH;
      delete environment.VOLTA_HOME;
      delete environment.ASDF_DATA_DIR;
      delete environment.MISE_DATA_DIR;
      return environment;
    }
  }

  const result = await new PackagedHostRoster(spec).join({
    name: "worker", description: "Worker", prompt: "Work", tools: ["read"],
  });

  assert.match(result, /joined worker/u);
  const registration = join(spec.home, spec.registrationDir, `worker${spec.extension}`);
  const active = join(spec.project, spec.activeDir, `worker${spec.extension}`);
  assert.deepEqual(await readFile(registration), await readFile(active));
  await assert.rejects(() => access(missingPreload), /ENOENT/u);
});

async function exchangeBoundParent(
  parent: string,
  displaced: string,
  includeForeignLock = false,
): Promise<"swapped" | "blocked"> {
  try { await rename(parent, displaced); }
  catch (error: any) {
    if (parentRenameBlockCodes.has(error?.code)) return "blocked";
    throw error;
  }
  await mkdir(parent);
  await writeFile(join(parent, "foreign.sentinel"), "foreign-parent", "utf8");
  if (includeForeignLock) await writeFile(join(parent, ".roster.lock"), "foreign-parent-lock", "utf8");
  return "swapped";
}

test("directory-bound creation and lock release survive a parent-path exchange", async (t) => {
  const base = join(process.cwd(), "work");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, "harbor-parent-create-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const spec = harnessSpec("pi", join(root, "home"), join(root, "project"));
  const registration = join(spec.home, spec.registrationDir, `worker${spec.extension}`);
  const parent = join(spec.home, spec.registrationDir);
  const displaced = `${parent}.displaced-by-test`;
  const state: { value: "pending" | "swapped" | "blocked" } = { value: "pending" };
  class ParentCreateRaceRoster extends Roster {
    protected override async applyChange(change: { path: string; content?: string }, index: number): Promise<void> {
      if (index === 0) {
        state.value = await exchangeBoundParent(parent, displaced, true);
        if (state.value === "blocked") throw new Error("parent directory rename was blocked safely");
      }
      await super.applyChange(change, index);
    }
  }
  await assert.rejects(
    () => new ParentCreateRaceRoster(spec).join({ name: "worker", description: "x", prompt: "x", tools: ["read"] }),
    /lifecycle directory identity changed|parent directory rename was blocked safely/u,
  );
  assert.notEqual(state.value, "pending");
  if (process.platform !== "win32") assert.equal(state.value, "swapped");
  if (state.value === "swapped") {
    assert.equal(await readFile(join(parent, "foreign.sentinel"), "utf8"), "foreign-parent");
    assert.equal(await readFile(join(parent, ".roster.lock"), "utf8"), "foreign-parent-lock");
    await Promise.all([
      assert.rejects(() => access(registration), /ENOENT/u),
      assert.rejects(() => access(join(displaced, ".roster.lock")), /ENOENT/u),
    ]);
  } else {
    await Promise.all([
      assert.rejects(() => access(registration), /ENOENT/u),
      assert.rejects(() => access(join(parent, ".roster.lock")), /ENOENT/u),
    ]);
  }
});

test("directory-bound replacement and deletion preserve the original parent inode", async (t) => {
  const base = join(process.cwd(), "work");
  await mkdir(base, { recursive: true });
  for (const operation of ["replace", "delete"] as const) {
    const root = await mkdtemp(join(base, `harbor-parent-${operation}-`));
    t.after(() => rm(root, { recursive: true, force: true }));
    const spec = harnessSpec("copilot", join(root, "home"), join(root, "project"));
    const registration = join(spec.home, spec.registrationDir, `worker${spec.extension}`);
    const active = join(spec.project, spec.activeDir, `worker${spec.extension}`);
    const parent = join(spec.home, spec.registrationDir);
    const displaced = `${parent}.displaced-by-test`;
    await new Roster(spec).join({ name: "worker", description: "before", prompt: "before", tools: ["read"] });
    const [registrationBefore, activeBefore] = await Promise.all([readFile(registration), readFile(active)]);
    const state: { value: "pending" | "swapped" | "blocked" } = { value: "pending" };
    class ParentMutationRaceRoster extends Roster {
      protected override async applyChange(change: { path: string; content?: string }, index: number): Promise<void> {
        if (index === 0) {
          state.value = await exchangeBoundParent(parent, displaced);
          if (state.value === "blocked") throw new Error("parent directory rename was blocked safely");
        }
        await super.applyChange(change, index);
      }
    }
    const roster = new ParentMutationRaceRoster(spec);
    await assert.rejects(
      () => operation === "replace"
        ? roster.join({ name: "worker", description: "after", prompt: "after", tools: ["read"], replace: true })
        : roster.retire("worker"),
      /lifecycle directory identity changed|parent directory rename was blocked safely/u,
    );
    assert.notEqual(state.value, "pending");
    if (process.platform !== "win32") assert.equal(state.value, "swapped");
    if (state.value === "swapped") {
      assert.equal(await readFile(join(parent, "foreign.sentinel"), "utf8"), "foreign-parent");
      await assert.rejects(() => access(registration), /ENOENT/u);
      assert.deepEqual(await readFile(join(displaced, `worker${spec.extension}`)), registrationBefore);
    } else {
      assert.deepEqual(await readFile(registration), registrationBefore);
    }
    assert.deepEqual(await readFile(active), activeBefore);
  }
});

test("rollback stays on the bound parent after its canonical path is exchanged", async (t) => {
  const base = join(process.cwd(), "work");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, "harbor-parent-rollback-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const spec = harnessSpec("opencode", join(root, "home"), join(root, "project"));
  const registration = join(spec.home, spec.registrationDir, `worker${spec.extension}`);
  const active = join(spec.project, spec.activeDir, `worker${spec.extension}`);
  const parent = join(spec.home, spec.registrationDir);
  const displaced = `${parent}.displaced-by-test`;
  await new Roster(spec).join({ name: "worker", description: "before", prompt: "before", tools: ["read"] });
  const [registrationBefore, activeBefore] = await Promise.all([readFile(registration), readFile(active)]);
  const state: { value: "pending" | "swapped" | "blocked" } = { value: "pending" };
  class ParentRollbackRaceRoster extends Roster {
    protected override async applyChange(change: { path: string; content?: string }, index: number): Promise<void> {
      if (index === 1) throw new Error("injected failure after parent exchange");
      await super.applyChange(change, index);
      state.value = await exchangeBoundParent(parent, displaced, true);
      if (state.value === "blocked") throw new Error("parent directory rename was blocked safely");
    }
  }
  await assert.rejects(
    () => new ParentRollbackRaceRoster(spec).join({
      name: "worker", description: "after", prompt: "after", tools: ["read"], replace: true,
    }),
    /injected failure after parent exchange|parent directory rename was blocked safely/u,
  );
  assert.notEqual(state.value, "pending");
  if (process.platform !== "win32") assert.equal(state.value, "swapped");
  if (state.value === "swapped") {
    assert.equal(await readFile(join(parent, "foreign.sentinel"), "utf8"), "foreign-parent");
    assert.equal(await readFile(join(parent, ".roster.lock"), "utf8"), "foreign-parent-lock");
    await assert.rejects(() => access(registration), /ENOENT/u);
    assert.deepEqual(await readFile(join(displaced, `worker${spec.extension}`)), registrationBefore);
    await assert.rejects(() => access(join(displaced, ".roster.lock")), /ENOENT/u);
  } else {
    assert.deepEqual(await readFile(registration), registrationBefore);
    await assert.rejects(() => access(join(parent, ".roster.lock")), /ENOENT/u);
  }
  assert.deepEqual(await readFile(active), activeBefore);
});

test("stale-lock cleanup cannot cross a parent-path exchange", async (t) => {
  const base = join(process.cwd(), "work");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, "harbor-parent-stale-lock-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const spec = harnessSpec("pi", join(root, "home"), join(root, "project"));
  const parent = join(spec.home, spec.registrationDir);
  const displaced = `${parent}.displaced-by-test`;
  const lock = join(parent, ".roster.lock");
  const stalePid = 2_000_000_001;
  await mkdir(parent, { recursive: true });
  await writeFile(lock, JSON.stringify({ owner: "agent-harbor", pid: stalePid, token: "stale" }), "utf8");
  const originalKill = process.kill;
  const state: { value: "pending" | "swapped" | "blocked" } = { value: "pending" };
  let result: string | undefined;
  let failure: unknown;
  (process as any).kill = (pid: number, signal?: NodeJS.Signals | number) => {
    if (pid === stalePid && signal === 0 && state.value === "pending") {
      try {
        renameSync(parent, displaced);
        mkdirSync(parent);
        writeFileSync(join(parent, "foreign.sentinel"), "foreign-parent", "utf8");
        writeFileSync(lock, "foreign-parent-lock", "utf8");
        state.value = "swapped";
      } catch (error: any) {
        if (parentRenameBlockCodes.has(error?.code)) state.value = "blocked";
        else throw error;
      }
      const missing: any = new Error("stale worker is absent");
      missing.code = "ESRCH";
      throw missing;
    }
    return originalKill(pid, signal as any);
  };
  try {
    result = await new Roster(spec).join({ name: "worker", description: "x", prompt: "x", tools: ["read"] });
  } catch (error) {
    failure = error;
  } finally {
    (process as any).kill = originalKill;
  }
  assert.notEqual(state.value, "pending");
  if (process.platform !== "win32") assert.equal(state.value, "swapped");
  if (state.value === "swapped") {
    assert.ok(failure instanceof Error);
    assert.match(failure.message, /lifecycle directory identity changed/u);
    assert.equal(await readFile(lock, "utf8"), "foreign-parent-lock");
    await assert.rejects(() => access(join(displaced, ".roster.lock")), /ENOENT/u);
  } else {
    assert.equal(failure, undefined);
    assert.match(result ?? "", /joined worker/u);
    await assert.rejects(() => access(lock), /ENOENT/u);
  }
});

test("roster commit refuses files created or swapped after ownership preflight", async () => {
  class CreateRaceRoster extends Roster {
    protected override async applyChange(change: { path: string; content?: string }, index: number): Promise<void> {
      if (index === 0) await writeFile(change.path, "foreign-created-after-preflight", "utf8");
      await super.applyChange(change, index);
    }
  }
  const createRoot = await mkdtemp(join(tmpdir(), "harbor-create-race-"));
  const createSpec = harnessSpec("copilot", join(createRoot, "home"), join(createRoot, "project"));
  const createRegistration = join(createSpec.home, createSpec.registrationDir, `worker${createSpec.extension}`);
  await assert.rejects(
    () => new CreateRaceRoster(createSpec).join({ name: "worker", description: "x", prompt: "x", tools: ["read"] }),
    /changed after ownership preflight/u,
  );
  assert.equal(await readFile(createRegistration, "utf8"), "foreign-created-after-preflight");

  const swapRoot = await mkdtemp(join(tmpdir(), "harbor-swap-race-"));
  const swapSpec = harnessSpec("pi", join(swapRoot, "home"), join(swapRoot, "project"));
  const swapRegistration = join(swapSpec.home, swapSpec.registrationDir, `worker${swapSpec.extension}`);
  const displaced = `${swapRegistration}.displaced-by-test`;
  await new Roster(swapSpec).join({ name: "worker", description: "before", prompt: "before", tools: ["read"] });
  const original = await readFile(swapRegistration);
  class SwapRaceRoster extends Roster {
    protected override async applyChange(change: { path: string; content?: string }, index: number): Promise<void> {
      if (index === 0) {
        await rename(change.path, displaced);
        await writeFile(change.path, "foreign-swapped-after-preflight", "utf8");
      }
      await super.applyChange(change, index);
    }
  }
  await assert.rejects(
    () => new SwapRaceRoster(swapSpec).join({
      name: "worker", description: "after", prompt: "after", tools: ["read"], replace: true,
    }),
    /changed after ownership preflight/u,
  );
  assert.equal(await readFile(swapRegistration, "utf8"), "foreign-swapped-after-preflight");
  assert.deepEqual(await readFile(displaced), original);
});

test("retire and rollback preserve concurrent foreign replacements", async () => {
  const deleteRoot = await mkdtemp(join(tmpdir(), "harbor-delete-race-"));
  const deleteSpec = harnessSpec("opencode", join(deleteRoot, "home"), join(deleteRoot, "project"));
  const deleteRegistration = join(deleteSpec.home, deleteSpec.registrationDir, `worker${deleteSpec.extension}`);
  const deleteDisplaced = `${deleteRegistration}.displaced-by-test`;
  await new Roster(deleteSpec).join({ name: "worker", description: "before", prompt: "before", tools: ["read"] });
  class DeleteRaceRoster extends Roster {
    protected override async applyChange(change: { path: string; content?: string }, index: number): Promise<void> {
      if (index === 0) {
        await rename(change.path, deleteDisplaced);
        await writeFile(change.path, "foreign-before-delete", "utf8");
      }
      await super.applyChange(change, index);
    }
  }
  await assert.rejects(() => new DeleteRaceRoster(deleteSpec).retire("worker"), /changed after ownership preflight/u);
  assert.equal(await readFile(deleteRegistration, "utf8"), "foreign-before-delete");
  assert.match(await readFile(deleteDisplaced, "utf8"), /agent-foundry:profile/u);

  const rollbackRoot = await mkdtemp(join(tmpdir(), "harbor-rollback-race-"));
  const rollbackSpec = harnessSpec("copilot", join(rollbackRoot, "home"), join(rollbackRoot, "project"));
  const rollbackRegistration = join(rollbackSpec.home, rollbackSpec.registrationDir, `worker${rollbackSpec.extension}`);
  await new Roster(rollbackSpec).join({ name: "worker", description: "before", prompt: "before", tools: ["read"] });
  class RollbackRaceRoster extends Roster {
    protected override async applyChange(change: { path: string; content?: string }, index: number): Promise<void> {
      if (index === 1) {
        await rm(rollbackRegistration, { force: true });
        await writeFile(rollbackRegistration, "foreign-before-rollback", "utf8");
        throw new Error("injected failure after concurrent replacement");
      }
      await super.applyChange(change, index);
    }
  }
  await assert.rejects(
    () => new RollbackRaceRoster(rollbackSpec).join({
      name: "worker", description: "after", prompt: "after", tools: ["read"], replace: true,
    }),
    (error: any) => error instanceof AggregateError && /rollback was incomplete/u.test(error.message),
  );
  assert.equal(await readFile(rollbackRegistration, "utf8"), "foreign-before-rollback");
});

test("roster lock release never removes a concurrent foreign replacement", async () => {
  const root = await mkdtemp(join(tmpdir(), "harbor-lock-release-race-"));
  const spec = harnessSpec("pi", join(root, "home"), join(root, "project"));
  const lock = join(spec.home, spec.registrationDir, ".roster.lock");
  const displaced = `${lock}.displaced-by-test`;
  class LockRaceRoster extends Roster {
    protected override async applyChange(change: { path: string; content?: string }, index: number): Promise<void> {
      if (index === 0) {
        await rename(lock, displaced);
        await writeFile(lock, "foreign-lock", "utf8");
      }
      await super.applyChange(change, index);
    }
  }
  await assert.rejects(
    () => new LockRaceRoster(spec).join({ name: "worker", description: "x", prompt: "x", tools: ["read"] }),
    /roster lock ownership changed before cleanup/u,
  );
  assert.equal(await readFile(lock, "utf8"), "foreign-lock");
  const ownedRecord = JSON.parse(await readFile(displaced, "utf8"));
  assert.equal(ownedRecord.owner, "agent-harbor");
  assert.ok(Number.isSafeInteger(ownedRecord.pid) && ownedRecord.pid > 0);
  assert.notEqual(ownedRecord.pid, process.pid);
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
