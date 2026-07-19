import assert from "node:assert/strict";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  COMMAND_DEFINITIONS,
  HarborError,
  executeHarborCommand,
} from "../plugins/agent-foundry/runtime/commands.mjs";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const BUNDLED_DIR = resolve(TEST_DIR, "..", "plugins", "agent-foundry", "bench");
const COMMANDS = ["bench", "join", "retire", "contract", "list-skills", "manager"];
const BUNDLED_PLAYERS = ["scout", "sage", "smith", "probe", "guard", "pilot"];

const RUNTIMES = {
  copilot: {
    activeParts: [".github", "agents"],
    suffix: ".agent.md",
    renderPatterns: [
      /tools: \["read","search","edit","execute"\]/,
      /disable-model-invocation: false/,
      /user-invocable: true/,
    ],
  },
  opencode: {
    activeParts: [".opencode", "agents"],
    suffix: ".md",
    renderPatterns: [
      /mode: subagent/,
      /permission:\n  "\*": deny\n  read: allow\n  grep: allow\n  edit: allow\n  bash: allow/,
    ],
  },
  pi: {
    activeParts: [".pi", "prompts"],
    suffix: ".md",
    renderPatterns: [/tools: read,grep,edit,write,bash/, /## Assigned task\n\n\$ARGUMENTS/],
  },
};

function activePath(fixture, id) {
  const spec = RUNTIMES[fixture.runtime];
  return join(fixture.cwd, ...spec.activeParts, `${id}${spec.suffix}`);
}

function registrationPath(fixture, id) {
  return join(fixture.home, "agent-foundry", "bench", `${id}${RUNTIMES[fixture.runtime].suffix}`);
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

async function createFixture(t, runtime = "copilot", overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), `agent-harbor-core-${runtime}-`));
  const cwd = join(root, "project");
  const home = join(root, "home");
  await Promise.all([mkdir(cwd, { recursive: true }), mkdir(home, { recursive: true })]);
  t.after(() => rm(root, { recursive: true, force: true }));

  const contractCalls = [];
  const ghCalls = [];
  const fixture = { root, cwd, home, runtime, contractCalls, ghCalls };
  fixture.options = {
    runtime,
    cwd,
    homeDir: home,
    bundledDir: BUNDLED_DIR,
    env: {},
    async runContract(request) {
      contractCalls.push(request);
      return "child result";
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
    if (expectedCode !== undefined) assert.equal(error.code, expectedCode);
    assert.equal(typeof error.message, "string");
    assert.ok(error.message.length > 0);
    return true;
  });
}

function personalDefinition(name, overrides = {}) {
  return {
    name,
    description: `Description for ${name}`,
    prompt: `Work as ${name}.`,
    tools: ["read", "search", "edit", "execute"],
    skills: [],
    ...overrides,
  };
}

const TRUST_POLICY = {
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

function fakeGh(fixture) {
  const commit = "a".repeat(40);
  const blob = "b".repeat(40);
  return async (args, metadata) => {
    fixture.ghCalls.push({ args: [...args], metadata: { ...metadata } });
    if (metadata.kind === "resolve-ref") return `${commit}\n`;
    if (metadata.kind === "read-tree") {
      return {
        truncated: false,
        skills: [{ path: "skills/example-helper/SKILL.md", blob, size: 321 }],
      };
    }
    throw new Error(`Unexpected gh operation: ${metadata.kind}`);
  };
}

test("the shared core exposes exactly the six public commands", async (t) => {
  assert.deepEqual(COMMAND_DEFINITIONS.map(({ name }) => name), COMMANDS);
  for (const definition of COMMAND_DEFINITIONS) {
    assert.equal(typeof definition.description, "string");
    assert.ok(definition.description.trim().length > 0);
  }

  const fixture = await createFixture(t);
  await expectHarborError(
    executeHarborCommand("unknown-command", "", fixture.options),
    "UNKNOWN_COMMAND",
  );
  const withNativeEnvironment = await executeHarborCommand("bench", "list", {
    ...fixture.options,
    env: process.env,
  });
  assert.equal(withNativeEnvironment.modelCalls, 0);
  assert.equal(fixture.contractCalls.length, 0);
  assert.equal(fixture.ghCalls.length, 0);
});

test("bench lists, activates, idempotently preserves, and deactivates bundled players", async (t) => {
  const fixture = await createFixture(t);
  const scoutPath = activePath(fixture, "scout");

  const listed = await executeHarborCommand("bench", "list", fixture.options);
  assert.equal(listed.ok, true);
  assert.equal(listed.changed, false);
  assert.equal(listed.modelCalls, 0);
  assert.deepEqual(new Set(listed.entries.map(({ id }) => id)), new Set(BUNDLED_PLAYERS));
  assert.ok(listed.entries.every(({ state }) => state === "bench"));
  assert.equal(await exists(scoutPath), false);

  const activated = await executeHarborCommand("bench", "on scout", fixture.options);
  assert.equal(activated.changed, true);
  assert.equal(await exists(scoutPath), true);
  const initialBytes = await readFile(scoutPath);

  const fixedTime = new Date("2020-01-02T03:04:05.000Z");
  await utimes(scoutPath, fixedTime, fixedTime);
  const before = await stat(scoutPath);
  const repeated = await executeHarborCommand("bench", "on SCOUT,scout", fixture.options);
  const after = await stat(scoutPath);
  assert.equal(repeated.changed, false);
  assert.deepEqual(await readFile(scoutPath), initialBytes);
  assert.equal(after.mtimeMs, before.mtimeMs, "an exact activation must not rewrite the file");

  const deactivated = await executeHarborCommand("bench", "off scout", {
    ...fixture.options,
    bundledDir: join(fixture.root, "intentionally-missing-bundles"),
  });
  assert.equal(deactivated.changed, true, "bench off must not need bundled templates");
  assert.equal(await exists(scoutPath), false);

  const repeatedOff = await executeHarborCommand("bench", "off scout", {
    ...fixture.options,
    bundledDir: join(fixture.root, "still-missing-bundles"),
  });
  assert.equal(repeatedOff.changed, false);
  assert.equal(fixture.contractCalls.length, 0);
  assert.equal(fixture.ghCalls.length, 0);
});

test("bench validates an entire batch before writing any member", async (t) => {
  const fixture = await createFixture(t);
  const validTarget = activePath(fixture, "guard");

  await expectHarborError(
    executeHarborCommand("bench", "on guard unknown-player", fixture.options),
    "UNKNOWN_PLAYER",
  );

  assert.equal(await exists(validTarget), false, "a later invalid id must prevent an earlier write");
  assert.equal(fixture.contractCalls.length, 0);
  assert.equal(fixture.ghCalls.length, 0);
});

test("join writes two identical copies, is idempotent, and requires replace for changes", async (t) => {
  const fixture = await createFixture(t);
  const id = "release-reviewer";
  const definition = personalDefinition(id);
  const active = activePath(fixture, id);
  const registration = registrationPath(fixture, id);

  const joined = await executeHarborCommand("join", JSON.stringify(definition), fixture.options);
  assert.equal(joined.ok, true);
  assert.equal(joined.changed, true);
  assert.equal(joined.modelCalls, 0);
  assert.deepEqual(await readFile(active), await readFile(registration));

  const repeated = await executeHarborCommand("join", definition, fixture.options);
  assert.equal(repeated.changed, false);

  const bytesBeforeRejectedChange = await readFile(registration);
  const changed = personalDefinition(id, { prompt: "Use the updated review protocol." });
  await expectHarborError(
    executeHarborCommand("join", changed, fixture.options),
    "REPLACE_REQUIRED",
  );
  assert.deepEqual(await readFile(registration), bytesBeforeRejectedChange);
  assert.deepEqual(await readFile(active), bytesBeforeRejectedChange);

  const replaced = await executeHarborCommand(
    "join",
    { ...changed, replace: true },
    fixture.options,
  );
  assert.equal(replaced.changed, true);
  const replacementBytes = await readFile(registration);
  assert.deepEqual(await readFile(active), replacementBytes);
  assert.match(replacementBytes.toString("utf8"), /updated review protocol/);
  assert.equal(fixture.contractCalls.length, 0);
  assert.equal(fixture.ghCalls.length, 0);
});

test("join never overwrites an unowned collision or leaves a registration behind", async (t) => {
  const fixture = await createFixture(t);
  const id = "collision-reviewer";
  const active = activePath(fixture, id);
  const registration = registrationPath(fixture, id);
  const unowned = "This belongs to the user and is not managed by Agent Foundry.\n";
  await mkdir(dirname(active), { recursive: true });
  await writeFile(active, unowned, "utf8");

  await expectHarborError(
    executeHarborCommand("join", personalDefinition(id), fixture.options),
    "PROFILE_COLLISION",
  );

  assert.equal(await readFile(active, "utf8"), unowned);
  assert.equal(await exists(registration), false);
  assert.equal(fixture.contractCalls.length, 0);
});

test("retire removes only this project's two owned copies", async (t) => {
  const fixture = await createFixture(t);
  const id = "persistent-reviewer";
  const active = activePath(fixture, id);
  const registration = registrationPath(fixture, id);
  await executeHarborCommand("join", personalDefinition(id), fixture.options);

  const otherProjectCopy = join(fixture.root, "other-project", ".github", "agents", `${id}.agent.md`);
  await mkdir(dirname(otherProjectCopy), { recursive: true });
  await writeFile(otherProjectCopy, await readFile(active));

  const retired = await executeHarborCommand("retire", id, fixture.options);
  assert.equal(retired.ok, true);
  assert.equal(retired.changed, true);
  assert.equal(retired.modelCalls, 0);
  assert.equal(await exists(active), false);
  assert.equal(await exists(registration), false);
  assert.equal(await exists(otherProjectCopy), true);
  assert.equal(fixture.contractCalls.length, 0);
  assert.equal(fixture.ghCalls.length, 0);
});

test("contract rejects invalid input before the runner and calls it exactly once when valid", async (t) => {
  const fixture = await createFixture(t);

  await expectHarborError(
    executeHarborCommand(
      "contract",
      {
        name: "one-shot-reviewer",
        description: "Review once",
        prompt: "Review carefully.",
        tools: ["read", "read"],
        task: "Review the change.",
      },
      fixture.options,
    ),
    "DUPLICATE_TOOL",
  );
  assert.equal(fixture.contractCalls.length, 0);

  const result = await executeHarborCommand(
    "contract",
    {
      name: "one-shot-reviewer",
      description: "Review once",
      prompt: "Review carefully.",
      task: "Review the change.",
      tools: ["read", "search"],
      skills: [],
    },
    fixture.options,
  );

  assert.equal(result.ok, true);
  assert.equal(result.changed, false);
  assert.equal(result.modelCalls, 1);
  assert.match(result.message, /child result/);
  assert.equal(fixture.contractCalls.length, 1);
  const [request] = fixture.contractCalls;
  assert.equal(request.definition.name, "one-shot-reviewer");
  assert.equal(request.task, "Review the change.");
  assert.deepEqual([...request.tools], ["read", "search"]);
  assert.match(request.prompt, /Review carefully\./);
  assert.doesNotMatch(request.prompt, /Review the change\./, "the task must not be duplicated into the system prompt");
  assert.equal(await exists(activePath(fixture, "one-shot-reviewer")), false);
  assert.equal(await exists(registrationPath(fixture, "one-shot-reviewer")), false);
  assert.equal(fixture.ghCalls.length, 0);
});

test("contract keeps trusted GitHub resolution child-only and specifies its two exact requests", async (t) => {
  const fixture = await createFixture(t);
  fixture.options.policy = TRUST_POLICY;
  const task = "Apply the helper to this repository.";

  const result = await executeHarborCommand("contract", {
    name: "github-helper",
    description: "Uses one trusted helper",
    prompt: "Follow the trusted reference.",
    task,
    tools: ["read", "search", "execute"],
    skills: [{
      kind: "github",
      name: "example-helper",
      repo: "example/skills",
      path: "skills/example-helper/SKILL.md",
      track: "refs/heads/main",
    }],
  }, fixture.options);

  assert.equal(result.modelCalls, 1);
  assert.equal(fixture.contractCalls.length, 1);
  assert.equal(fixture.ghCalls.length, 0, "the parent must not resolve a remote body");
  const [request] = fixture.contractCalls;
  assert.doesNotMatch(request.prompt, new RegExp(task.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(request.prompt, /git\/ref\/heads\/main/);
  assert.match(request.prompt, /Accept: application\/vnd\.github\.raw\+json/);
  assert.match(request.prompt, /contents\/skills\/example-helper\/SKILL\.md/);
  assert.match(request.prompt, /ref=COMMIT_SHA/);
});

test("list-skills validates one snapshot with exactly two read-only gh calls and no model", async (t) => {
  const fixture = await createFixture(t);
  fixture.options.policy = TRUST_POLICY;
  fixture.options.runGh = fakeGh(fixture);

  const result = await executeHarborCommand("list-skills", "example", fixture.options);

  assert.equal(result.ok, true);
  assert.equal(result.changed, false);
  assert.equal(result.modelCalls, 0);
  assert.equal(result.remoteCalls, 2);
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].id, "example-helper");
  assert.equal(fixture.ghCalls.length, 2);
  assert.deepEqual(fixture.ghCalls.map(({ metadata }) => metadata.kind), ["resolve-ref", "read-tree"]);
  for (const { args } of fixture.ghCalls) {
    assert.equal(args[0], "api");
    assert.ok(args.includes("--method"));
    assert.ok(args.includes("GET"));
  }
  assert.match(fixture.ghCalls[0].args.join(" "), /git\/ref\/heads\/main/);
  assert.match(fixture.ghCalls[1].args.join(" "), new RegExp(`git/trees/${"a".repeat(40)}`));
  assert.equal(fixture.contractCalls.length, 0);
});

test("all four deterministic commands keep the contract runner at zero", async (t) => {
  let forbiddenRunnerCalls = 0;
  const fixture = await createFixture(t, "copilot", {
    async runContract() {
      forbiddenRunnerCalls += 1;
      throw new Error("deterministic commands must never invoke the model runner");
    },
    policy: TRUST_POLICY,
  });
  fixture.options.runGh = fakeGh(fixture);

  const results = [];
  results.push(await executeHarborCommand("bench", "list", fixture.options));
  results.push(await executeHarborCommand("join", personalDefinition("zero-token-player"), fixture.options));
  results.push(await executeHarborCommand("list-skills", "", fixture.options));
  results.push(await executeHarborCommand("retire", "zero-token-player", fixture.options));

  assert.ok(results.every(({ modelCalls }) => modelCalls === 0));
  assert.equal(forbiddenRunnerCalls, 0);
  assert.equal(fixture.ghCalls.length, 2, "only list-skills may perform its two metadata requests");
});

test("Copilot, OpenCode, and Pi use their own paths and rendered frontmatter", async (t) => {
  for (const [runtime, spec] of Object.entries(RUNTIMES)) {
    await t.test(runtime, async (runtimeTest) => {
      const fixture = await createFixture(runtimeTest, runtime);
      const id = `${runtime}-reviewer`;
      const joined = await executeHarborCommand("join", personalDefinition(id), fixture.options);
      const active = join(fixture.cwd, ...spec.activeParts, `${id}${spec.suffix}`);
      const registration = join(fixture.home, "agent-foundry", "bench", `${id}${spec.suffix}`);

      assert.deepEqual(joined.paths, { registration, active });
      assert.equal(await exists(active), true);
      assert.equal(await exists(registration), true);
      const personal = await readFile(active, "utf8");
      assert.equal(personal, await readFile(registration, "utf8"));
      for (const pattern of spec.renderPatterns) assert.match(personal, pattern);
      assert.match(personal, new RegExp(`name: "${id}"`));
      assert.match(personal, new RegExp(`player: "${id}"`));
      assert.match(personal, /roster: personal/);

      const activated = await executeHarborCommand("bench", "on scout", fixture.options);
      const bundledPath = join(fixture.cwd, ...spec.activeParts, `scout${spec.suffix}`);
      assert.equal(activated.items[0].target, bundledPath);
      const bundled = await readFile(bundledPath, "utf8");
      assert.match(bundled, /roster: sdlc/);
      assert.match(bundled, /stage: discover/);
      if (runtime === "opencode") assert.match(bundled, /mode: subagent/);
      if (runtime === "pi") assert.match(bundled, /tools: read,grep/);
      if (runtime === "copilot") assert.match(bundled, /tools: \["read",\s*"search"\]/);

      assert.equal(fixture.contractCalls.length, 0);
      assert.equal(fixture.ghCalls.length, 0);
    });
  }
});

test("an overlapping runtime home and project config directory remains idempotent and retireable", async (t) => {
  for (const [runtime, spec] of Object.entries(RUNTIMES)) {
    await t.test(runtime, async (runtimeTest) => {
      const fixture = await createFixture(runtimeTest, runtime);
      const configRoot = join(fixture.cwd, spec.activeParts[0]);
      const options = { ...fixture.options, homeDir: configRoot };
      const id = `${runtime}-overlap`;
      const active = join(fixture.cwd, ...spec.activeParts, `${id}${spec.suffix}`);
      const registration = join(configRoot, "agent-foundry", "bench", `${id}${spec.suffix}`);

      const joined = await executeHarborCommand("join", personalDefinition(id), options);
      assert.equal(joined.changed, true);
      assert.deepEqual(await readFile(active), await readFile(registration));

      const repeated = await executeHarborCommand("join", personalDefinition(id), options);
      assert.equal(repeated.changed, false);

      const retired = await executeHarborCommand("retire", id, options);
      assert.equal(retired.changed, true);
      assert.equal(await exists(active), false);
      assert.equal(await exists(registration), false);
      assert.equal(fixture.contractCalls.length, 0);
    });
  }
});
