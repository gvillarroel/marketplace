import assert from "node:assert/strict";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  HarborError,
  createTrustedAgentController,
  executeHarborCommand,
} from "../plugins/agent-foundry/runtime/commands.mjs";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const BUNDLED_DIR = resolve(TEST_DIR, "..", "plugins", "agent-foundry", "bench");
const BUNDLED_PLAYERS = ["scout", "sage", "smith", "probe", "guard", "pilot"];
const COMMIT = "a".repeat(40);
const BLOB = "b".repeat(40);

function activePath(fixture, id) {
  return join(fixture.cwd, ".github", "agents", `${id}.agent.md`);
}

async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return false;
    throw error;
  }
}

async function createFixture(t, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), "agent-harbor-manager-"));
  const cwd = join(root, "project");
  const home = join(root, "home");
  await Promise.all([mkdir(cwd, { recursive: true }), mkdir(home, { recursive: true })]);
  t.after(() => rm(root, { recursive: true, force: true }));

  const managerCalls = [];
  const contractCalls = [];
  const ghCalls = [];
  const fixture = { root, cwd, home, managerCalls, contractCalls, ghCalls };
  fixture.options = {
    runtime: "copilot",
    cwd,
    homeDir: home,
    bundledDir: BUNDLED_DIR,
    env: {},
    async runManager(request) {
      managerCalls.push(request);
      return "manager result";
    },
    async runContract(request) {
      contractCalls.push(request);
      return "contract result";
    },
    async runGh(args, metadata) {
      ghCalls.push({ args: [...args], metadata: { ...metadata } });
      throw new Error("Unexpected GitHub request in an isolated test");
    },
    ...overrides,
  };
  return fixture;
}

async function expectHarborError(promise, expectedCode) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof HarborError, `expected HarborError, received ${error?.constructor?.name}`);
    assert.equal(error.code, expectedCode);
    assert.equal(typeof error.message, "string");
    assert.ok(error.message.length > 0);
    return true;
  });
}

function personalDefinition(name = "artisan") {
  return {
    name,
    description: `Personal player ${name}`,
    prompt: `Work carefully as ${name}.`,
    tools: ["read", "search", "edit", "execute"],
    skills: [],
  };
}

function contractDefinition(skills) {
  return {
    name: "temporary-specialist",
    description: "A disposable specialist for a bounded task",
    prompt: "Complete only the supplied bounded task.",
    task: "Inspect the fixture and return evidence.",
    tools: ["read", "execute"],
    skills,
  };
}

function githubSkill(overrides = {}) {
  return {
    kind: "github",
    name: "example-helper",
    repo: "example/skills",
    path: "skills/example-helper/SKILL.md",
    track: "refs/heads/main",
    ...overrides,
  };
}

const EXACT_POLICY = {
  trustedSources: [
    {
      repo: "example/skills",
      track: "refs/heads/main",
      scope: {
        kind: "skills",
        paths: ["skills/example-helper/SKILL.md"],
      },
    },
  ],
};

function catalogGh(fixture) {
  return async (args, metadata) => {
    fixture.ghCalls.push({ args: [...args], metadata: { ...metadata } });
    if (metadata.kind === "resolve-ref") return `${COMMIT}\n`;
    if (metadata.kind === "read-tree") {
      return {
        truncated: false,
        skills: [
          { path: "skills/example-helper/SKILL.md", blob: BLOB, size: 321 },
          { path: "skills/not-trusted/SKILL.md", blob: "c".repeat(40), size: 99 },
        ],
      };
    }
    throw new Error(`Unexpected gh operation: ${metadata.kind}`);
  };
}

test("bench dynamic status/on/off are idempotent and make zero model calls", async (t) => {
  const fixture = await createFixture(t);
  const settingsPath = join(fixture.cwd, ".agent-harbor", "bench.json");

  const initial = await executeHarborCommand("bench", "dynamic status", fixture.options);
  assert.equal(initial.enabled, false);
  assert.equal(initial.changed, false);
  assert.equal(initial.modelCalls, 0);
  assert.equal(await exists(settingsPath), false, "status must remain read-only");

  const enabled = await executeHarborCommand("bench", "dynamic on", fixture.options);
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.changed, true);
  assert.equal(enabled.modelCalls, 0);
  const enabledBytes = await readFile(settingsPath);
  const fixedTime = new Date("2020-01-02T03:04:05.000Z");
  await utimes(settingsPath, fixedTime, fixedTime);
  const enabledStat = await stat(settingsPath);

  const enabledAgain = await executeHarborCommand("bench", { action: "dynamic", state: "on" }, fixture.options);
  assert.equal(enabledAgain.enabled, true);
  assert.equal(enabledAgain.changed, false);
  assert.equal(enabledAgain.modelCalls, 0);
  assert.deepEqual(await readFile(settingsPath), enabledBytes);
  assert.equal((await stat(settingsPath)).mtimeMs, enabledStat.mtimeMs, "idempotent on must not rewrite settings");

  const disabled = await executeHarborCommand("bench", "dynamic off", fixture.options);
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.changed, true);
  assert.equal(disabled.modelCalls, 0);
  const disabledBytes = await readFile(settingsPath);

  const disabledAgain = await executeHarborCommand("bench", "dynamic off", fixture.options);
  assert.equal(disabledAgain.enabled, false);
  assert.equal(disabledAgain.changed, false);
  assert.equal(disabledAgain.modelCalls, 0);
  assert.deepEqual(await readFile(settingsPath), disabledBytes);
  assert.equal(fixture.managerCalls.length, 0);
  assert.equal(fixture.contractCalls.length, 0);
  assert.equal(fixture.ghCalls.length, 0);
});

test("the first manager call activates exactly six SDLC profiles once", async (t) => {
  const fixture = await createFixture(t);

  const first = await executeHarborCommand("manager", { task: "Ship the requested change." }, fixture.options);
  assert.equal(first.modelCalls, 1);
  assert.equal(first.changed, true);
  assert.equal(first.initializedDefaults, true);
  assert.equal(fixture.managerCalls.length, 1, "one valid manager command must invoke its runner once");
  const request = fixture.managerCalls[0];
  assert.deepEqual(request.activeAgentIds, BUNDLED_PLAYERS);
  assert.deepEqual(request.roster.map(({ id }) => id), BUNDLED_PLAYERS);
  assert.deepEqual(request.roster.map(({ stage }) => stage), ["discover", "design", "build", "verify", "review", "deliver"]);
  assert.ok(request.roster.every(({ origin, roster }) => origin === "bundled" && roster === "sdlc"));
  assert.ok(Object.isFrozen(request.roster));
  assert.ok(Object.isFrozen(request.activeAgentIds));
  assert.ok(request.roster.every(Object.isFrozen));

  const snapshots = new Map();
  for (const id of BUNDLED_PLAYERS) {
    const path = activePath(fixture, id);
    assert.equal(await exists(path), true);
    const fixedTime = new Date(`2020-01-0${BUNDLED_PLAYERS.indexOf(id) + 1}T03:04:05.000Z`);
    await utimes(path, fixedTime, fixedTime);
    snapshots.set(id, { bytes: await readFile(path), mtimeMs: (await stat(path)).mtimeMs });
  }

  const second = await executeHarborCommand("manager", "Verify the completed change.", fixture.options);
  assert.equal(second.modelCalls, 1);
  assert.equal(second.changed, false);
  assert.equal(second.initializedDefaults, false);
  assert.equal(fixture.managerCalls.length, 2, "each manager command gets exactly one orchestration call");
  assert.deepEqual(fixture.managerCalls[1].activeAgentIds, BUNDLED_PLAYERS);
  for (const id of BUNDLED_PLAYERS) {
    const snapshot = snapshots.get(id);
    assert.deepEqual(await readFile(activePath(fixture, id)), snapshot.bytes);
    assert.equal((await stat(activePath(fixture, id))).mtimeMs, snapshot.mtimeMs, "defaults must not be rewritten");
  }
});

test("explicitly benching every player is never undone by manager", async (t) => {
  const fixture = await createFixture(t);
  await executeHarborCommand("manager", "Initialize and coordinate.", fixture.options);
  assert.equal(fixture.managerCalls.length, 1);

  const benched = await executeHarborCommand("bench", "off all", fixture.options);
  assert.equal(benched.modelCalls, 0);
  assert.equal(benched.changed, true);
  assert.ok((await Promise.all(BUNDLED_PLAYERS.map((id) => exists(activePath(fixture, id))))).every((present) => !present));

  await expectHarborError(
    executeHarborCommand("manager", "Do not silently restore the defaults.", fixture.options),
    "NO_ACTIVE_PLAYERS",
  );
  assert.equal(fixture.managerCalls.length, 1, "no-active preflight must not call the runner");
  assert.ok((await Promise.all(BUNDLED_PLAYERS.map((id) => exists(activePath(fixture, id))))).every((present) => !present));
});

test("manager preflight rejects invalid, stale, and unowned-only rosters without a model call", async (t) => {
  const invalid = await createFixture(t);
  await expectHarborError(executeHarborCommand("manager", "   ", invalid.options), "INVALID_INPUT");
  await expectHarborError(
    executeHarborCommand("manager", { task: "Valid task", unexpected: true }, invalid.options),
    "UNKNOWN_FIELD",
  );
  assert.equal(invalid.managerCalls.length, 0);

  const stale = await createFixture(t);
  await executeHarborCommand("bench", "on scout", stale.options);
  await writeFile(activePath(stale, "scout"), `${await readFile(activePath(stale, "scout"), "utf8")}\nlocally stale\n`);
  await expectHarborError(executeHarborCommand("manager", "Use only exact profiles.", stale.options), "NO_ACTIVE_PLAYERS");
  assert.equal(stale.managerCalls.length, 0, "a stale-only roster must not call the runner");

  const unowned = await createFixture(t);
  await executeHarborCommand("bench", "on scout", unowned.options);
  await executeHarborCommand("bench", "off scout", unowned.options);
  await mkdir(dirname(activePath(unowned, "intruder")), { recursive: true });
  await writeFile(activePath(unowned, "intruder"), "---\nname: intruder\n---\nUnowned profile.\n");
  await expectHarborError(executeHarborCommand("manager", "Reject implicit agents.", unowned.options), "NO_ACTIVE_PLAYERS");
  assert.equal(unowned.managerCalls.length, 0, "an unowned-only roster must not call the runner");
});

test("manager ignores an active profile replaced by a filesystem link", async (t) => {
  const fixture = await createFixture(t);
  await executeHarborCommand("bench", "on scout", fixture.options);
  const path = activePath(fixture, "scout");
  await rm(path);
  try {
    await symlink(join(BUNDLED_DIR, "scout.agent.md"), path, "file");
  } catch (error) {
    if (["EACCES", "EPERM", "ENOTSUP"].includes(error?.code)) {
      t.skip(`filesystem links are unavailable in this environment: ${error.code}`);
      return;
    }
    throw error;
  }

  await expectHarborError(
    executeHarborCommand("manager", "Reject the linked profile.", fixture.options),
    "NO_ACTIVE_PLAYERS",
  );
  assert.equal(fixture.managerCalls.length, 0, "a linked-only roster must not call the manager runner");
});

test("manager passes only exact active profiles and accepts an exact personal registration", async (t) => {
  const fixture = await createFixture(t);
  await executeHarborCommand("join", personalDefinition(), fixture.options);
  await executeHarborCommand("bench", "on scout", fixture.options);
  await writeFile(activePath(fixture, "scout"), `${await readFile(activePath(fixture, "scout"), "utf8")}\nstale\n`);
  await mkdir(dirname(activePath(fixture, "intruder")), { recursive: true });
  await writeFile(activePath(fixture, "intruder"), "---\nname: intruder\n---\nUnowned profile.\n");

  const result = await executeHarborCommand("manager", "Delegate to the exact personal player.", fixture.options);
  assert.equal(result.modelCalls, 1);
  assert.equal(fixture.managerCalls.length, 1);
  const request = fixture.managerCalls[0];
  assert.deepEqual(request.activeAgentIds, ["artisan"]);
  assert.equal(request.roster.length, 1);
  assert.equal(request.roster[0].id, "artisan");
  assert.equal(request.roster[0].origin, "personal");
  assert.equal(request.roster[0].roster, "personal");
  assert.deepEqual(request.roster[0].tools, ["read", "search", "edit", "execute"]);
  assert.match(request.roster[0].prompt, /Work carefully as artisan\./);
});

test("manager exposes guarded dynamic capabilities only while dynamic agents are enabled", async (t) => {
  const fixture = await createFixture(t);
  await executeHarborCommand("bench", "on scout", fixture.options);

  const staticResult = await executeHarborCommand("manager", "Use the static roster.", fixture.options);
  assert.equal(staticResult.dynamicAgents, false);
  assert.equal(fixture.managerCalls.length, 1);
  assert.equal(Object.hasOwn(fixture.managerCalls[0], "controller"), false);

  const toggle = await executeHarborCommand("bench", "dynamic on", fixture.options);
  assert.equal(toggle.modelCalls, 0);
  const dynamicResult = await executeHarborCommand("manager", "Fill a demonstrated capability gap.", fixture.options);
  assert.equal(dynamicResult.dynamicAgents, true);
  assert.equal(fixture.managerCalls.length, 2);
  const request = fixture.managerCalls[1];
  assert.equal(request.dynamicAgents, true);
  assert.ok(request.controller);
  assert.deepEqual(Object.keys(request.controller.handlers).sort(), ["harbor_contract", "harbor_list_skills"]);
  assert.equal(Object.hasOwn(request.controller, "join"), false, "manager cannot persist dynamic players");

  await executeHarborCommand("bench", "dynamic off", fixture.options);
  await executeHarborCommand("manager", "Return to the static roster.", fixture.options);
  assert.equal(Object.hasOwn(fixture.managerCalls[2], "controller"), false);
  assert.equal(fixture.contractCalls.length, 0);
  assert.equal(fixture.ghCalls.length, 0);
});

test("trusted agent controller pins only the latest listed GitHub snapshot", async (t) => {
  const fixture = await createFixture(t);
  const controller = createTrustedAgentController({
    ...fixture.options,
    policy: EXACT_POLICY,
    runGh: catalogGh(fixture),
  });

  await expectHarborError(
    controller.contract(contractDefinition([{ kind: "installed", name: "some-skill" }])),
    "DYNAMIC_SKILL_FORBIDDEN",
  );
  await expectHarborError(
    controller.contract(contractDefinition([{ kind: "local", path: "skills/local/SKILL.md" }])),
    "DYNAMIC_SKILL_FORBIDDEN",
  );
  await expectHarborError(controller.contract(contractDefinition([githubSkill()])), "CATALOG_REQUIRED");
  assert.equal(fixture.contractCalls.length, 0);
  assert.equal(fixture.ghCalls.length, 0);

  const listed = await controller.listSkills("");
  assert.equal(listed.modelCalls, 0);
  assert.equal(listed.remoteCalls, 2);
  assert.equal(listed.entries.length, 1);
  assert.equal(controller.snapshot().length, 1);
  const entry = listed.entries[0];
  assert.deepEqual(
    { id: entry.id, repository: entry.repository, path: entry.path, track: entry.track, commit: entry.commit, blob: entry.blob, size: entry.size },
    {
      id: "example-helper",
      repository: "example/skills",
      path: "skills/example-helper/SKILL.md",
      track: "refs/heads/main",
      commit: COMMIT,
      blob: BLOB,
      size: 321,
    },
  );

  await expectHarborError(
    controller.contract(contractDefinition([githubSkill({ name: "unlisted-helper" })])),
    "SKILL_NOT_LISTED",
  );
  assert.equal(fixture.contractCalls.length, 0);

  const accepted = await controller.contract(contractDefinition([githubSkill()]));
  assert.equal(accepted.modelCalls, 1);
  assert.equal(fixture.contractCalls.length, 1, "accepted selection uses exactly one injected disposable runner call");
  assert.deepEqual(fixture.contractCalls[0].definition.skills, [
    {
      kind: "github",
      name: "example-helper",
      repo: "example/skills",
      path: "skills/example-helper/SKILL.md",
      track: "refs/heads/main",
      commit: COMMIT,
      blob: BLOB,
      size: 321,
    },
  ]);
  assert.equal(fixture.ghCalls.length, 2, "contract reuses the exact catalog snapshot without another metadata request");
});

test("list-skills applies repository, folder, and exact-path trust scopes", async (t) => {
  const fixture = await createFixture(t);
  const policy = {
    trustedSources: [
      { repo: "alpha/whole", track: "refs/heads/main", scope: { kind: "repo" } },
      { repo: "beta/folders", track: "refs/heads/main", scope: { kind: "folder", path: "approved" } },
      {
        repo: "gamma/exact",
        track: "refs/heads/main",
        scope: { kind: "skills", paths: ["exact/chosen/SKILL.md"] },
      },
    ],
  };
  const trees = {
    "alpha/whole": [
      { path: "SKILL.md", blob: "1".repeat(40), size: 10 },
      { path: "skills/everything/SKILL.md", blob: "2".repeat(40), size: 20 },
    ],
    "beta/folders": [
      { path: "approved/one/SKILL.md", blob: "3".repeat(40), size: 30 },
      { path: "approved/deep/two/SKILL.md", blob: "4".repeat(40), size: 40 },
      { path: "outside/three/SKILL.md", blob: "5".repeat(40), size: 50 },
    ],
    "gamma/exact": [
      { path: "exact/chosen/SKILL.md", blob: "6".repeat(40), size: 60 },
      { path: "exact/other/SKILL.md", blob: "7".repeat(40), size: 70 },
    ],
  };
  const runGh = async (args, metadata) => {
    fixture.ghCalls.push({ args: [...args], metadata: { ...metadata } });
    if (metadata.kind === "resolve-ref") return `${COMMIT}\n`;
    if (metadata.kind === "read-tree") return { truncated: false, skills: trees[metadata.repo] };
    throw new Error(`Unexpected gh operation: ${metadata.kind}`);
  };

  const result = await executeHarborCommand("list-skills", "", { ...fixture.options, policy, runGh });
  assert.equal(result.modelCalls, 0);
  assert.equal(result.remoteCalls, 6);
  assert.equal(result.snapshots, 3);
  assert.equal(result.total, 5);
  assert.deepEqual(
    new Set(result.entries.map(({ repository, path }) => `${repository}:${path}`)),
    new Set([
      "alpha/whole:SKILL.md",
      "alpha/whole:skills/everything/SKILL.md",
      "beta/folders:approved/one/SKILL.md",
      "beta/folders:approved/deep/two/SKILL.md",
      "gamma/exact:exact/chosen/SKILL.md",
    ]),
  );
  assert.deepEqual(
    new Set(result.entries.filter(({ repository }) => repository === "alpha/whole").map(({ trustedBy }) => trustedBy)),
    new Set(["repo"]),
  );
  assert.deepEqual(
    new Set(result.entries.filter(({ repository }) => repository === "beta/folders").map(({ trustedBy }) => trustedBy)),
    new Set(["folder:approved"]),
  );
  assert.equal(result.entries.find(({ repository }) => repository === "gamma/exact").trustedBy, "exact-path");
  assert.equal(fixture.ghCalls.length, 6, "each repository/ref snapshot uses exactly resolve-ref plus read-tree");
  assert.equal(fixture.managerCalls.length, 0);
  assert.equal(fixture.contractCalls.length, 0);
});
