import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { runDeterministicCommandResult } from "../src/adapters/direct.js";
import {
  claimOpenCodeAgentActivity,
  claimValidatedOpenCodeAgentActivity,
  readOpenCodeAgentActivities,
  readOpenCodeAgentActivitiesIncludingStale,
  runOpenCodeRosterMutationGate,
  withOpenCodeRosterMutationGate,
} from "../src/adapters/opencode-agent-activity.js";

async function fixture(prefix: string): Promise<{
  readonly root: string;
  readonly home: string;
  readonly project: string;
  restore(): void;
}> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const home = join(root, "home");
  const project = join(root, "project");
  await mkdir(project, { recursive: true });
  const prior = process.env.OPENCODE_CONFIG_DIR;
  process.env.OPENCODE_CONFIG_DIR = home;
  return {
    root,
    home,
    project,
    restore() {
      if (prior === undefined) delete process.env.OPENCODE_CONFIG_DIR;
      else process.env.OPENCODE_CONFIG_DIR = prior;
      rmSync(root, { recursive: true, force: true });
    },
  };
}

async function activityProjectDirectory(home: string): Promise<string> {
  const activity = join(home, "agent-foundry", "opencode-activity-v1");
  const entries = await readdir(activity, { withFileTypes: true });
  const projects = entries.filter((entry) => entry.isDirectory());
  assert.equal(projects.length, 1);
  return join(activity, projects[0].name);
}

async function workerClaim(
  project: string,
  home: string,
  agent: string,
  holdMs: number,
  sessionID = `session-${agent}`,
): Promise<string> {
  const moduleURL = pathToFileURL(join(process.cwd(), "src", "adapters", "opencode-agent-activity.ts")).href;
  const source = `
    const { claimOpenCodeAgentActivity } = await import(${JSON.stringify(moduleURL)});
    try {
      claimOpenCodeAgentActivity(${JSON.stringify(project)}, ${JSON.stringify(agent)}, "direct", ${JSON.stringify(sessionID)});
      process.stdout.write("ok\\n");
      await new Promise((resolve) => setTimeout(resolve, ${holdMs}));
    } catch { process.stdout.write("blocked\\n"); }
  `;
  return new Promise((resolveWorker, rejectWorker) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", source], {
      cwd: process.cwd(),
      env: { ...process.env, OPENCODE_CONFIG_DIR: home },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (value) => { stdout += value; });
    child.stderr.setEncoding("utf8").on("data", (value) => { stderr += value; });
    child.once("error", rejectWorker);
    child.once("close", (code, signal) => {
      if (code !== 0 || signal) rejectWorker(new Error(`claim worker failed: ${stderr}`));
      else resolveWorker(stdout.trim());
    });
  });
}

test("OpenCode activity publication is complete, single-linked, exclusive, and direct reconciliation is recoverable", async () => {
  const current = await fixture("harbor-opencode-activity-atomic-");
  try {
    const claim = claimOpenCodeAgentActivity(current.project, "reviewer", "direct", "direct-session");
    assert.equal(claim.snapshot.ownerRuntime, "opencode");
    const directory = await activityProjectDirectory(current.home);
    assert.deepEqual(await readdir(directory), ["reviewer.json"]);
    const file = join(directory, "reviewer.json");
    const stat = await lstat(file, { bigint: true });
    assert.equal(stat.nlink, 1n, "staging hardlink survived successful publication");
    const bytes = await readFile(file);
    assert.ok(bytes.length > 0 && bytes.length <= 2_048);
    assert.doesNotThrow(() => JSON.parse(bytes.toString("utf8")));
    assert.throws(
      () => claimOpenCodeAgentActivity(current.project, "reviewer", "direct", "other-session"),
      /busy in another direct or delegated run/u,
    );
    assert.equal(claim.setSessionID("retargeted-direct-session"), false);
    assert.equal(claim.setPhase("working"), true);
    assert.equal(claim.setPhase("starting"), false);
    assert.equal(claim.setPhase("cleaning"), true);
    assert.equal(readOpenCodeAgentActivities(current.project)[0]?.phase, "cleaning");
    assert.equal(claim.setPhase("working"), true);
    assert.equal(readOpenCodeAgentActivities(current.project)[0]?.phase, "working");
    assert.equal(claim.release(), true);
    assert.deepEqual(await readdir(directory), []);
  } finally { current.restore(); }
});

test("OpenCode production claims share one physical project across different config homes", async () => {
  const root = await mkdtemp(join(tmpdir(), "harbor-opencode-stable-user-state-"));
  try {
    const project = join(root, "project");
    const userHome = join(root, "user-home");
    const firstConfig = join(root, "config-a");
    const secondConfig = join(root, "config-b");
    await mkdir(project, { recursive: true });
    await mkdir(userHome, { recursive: true });
    const moduleURL = pathToFileURL(join(process.cwd(), "src", "adapters", "opencode-agent-activity.ts")).href;
    const source = `
      const { claimOpenCodeAgentActivity } = await import(${JSON.stringify(moduleURL)});
      const first = claimOpenCodeAgentActivity(${JSON.stringify(project)}, "reviewer", "direct", "session-a");
      process.env.OPENCODE_CONFIG_DIR = ${JSON.stringify(secondConfig)};
      let shared = false;
      try { claimOpenCodeAgentActivity(${JSON.stringify(project)}, "reviewer", "direct", "session-b"); }
      catch (error) { shared = /busy in another direct or delegated run/u.test(String(error)); }
      first.release();
      process.stdout.write(shared ? "shared" : "split");
    `;
    const env = {
      ...process.env,
      HOME: userHome,
      USERPROFILE: userHome,
      OPENCODE_CONFIG_DIR: firstConfig,
    };
    delete env.NODE_TEST_CONTEXT;
    const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", source], {
      cwd: process.cwd(), env, encoding: "utf8", windowsHide: true,
    });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout, "shared");
    assert.ok((await readdir(join(userHome, ".agent-harbor", "agent-foundry", "opencode-activity-v1"))).length >= 1);
    await assert.rejects(() => readdir(join(firstConfig, "agent-foundry")), /ENOENT/u);
    await assert.rejects(() => readdir(join(secondConfig, "agent-foundry")), /ENOENT/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("OpenCode delegated activity freezes child identity and lifecycle phase after work begins", async () => {
  const current = await fixture("harbor-opencode-activity-transitions-");
  try {
    const claim = claimOpenCodeAgentActivity(current.project, "reviewer", "delegated", "lead-session");
    assert.equal(claim.setSessionID("child-session"), true);
    assert.equal(claim.setPhase("working"), true);
    assert.equal(claim.setSessionID("different-child"), false);
    assert.equal(claim.setPhase("starting"), false);
    assert.equal(claim.snapshot.sessionID, "child-session");
    assert.equal(claim.snapshot.phase, "working");
    assert.equal(claim.setPhase("cleaning"), true);
    assert.equal(claim.setPhase("working"), false);
    assert.equal(claim.release(), true);
  } finally { current.restore(); }
});

test("OpenCode stale claims remain busy while their owner PID is alive", async () => {
  const current = await fixture("harbor-opencode-activity-stale-live-");
  const claims: ReturnType<typeof claimOpenCodeAgentActivity>[] = [];
  try {
    claims.push(claimOpenCodeAgentActivity(current.project, "stale-owner", "direct", "stale-session"));
    const directory = await activityProjectDirectory(current.home);
    const stale = new Date(Date.now() - 31_000);
    await utimes(join(directory, "stale-owner.json"), stale, stale);
    for (let index = 0; index < 31; index += 1) {
      const agent = `member${String(index).padStart(2, "0")}`;
      claims.push(claimOpenCodeAgentActivity(current.project, agent, "direct", `session-${agent}`));
    }
    assert.ok(readOpenCodeAgentActivities(current.project).some(({ agent }) => agent === "stale-owner"));
    assert.throws(
      () => claimOpenCodeAgentActivity(current.project, "overflow", "direct", "overflow-session"),
      /at most 32 active runs/u,
    );
  } finally {
    for (const claim of claims) claim.release();
    current.restore();
  }
});

test("OpenCode private recovery inventory never slices away an exact stale generation", async () => {
  const current = await fixture("harbor-opencode-activity-private-bound-");
  let claim: ReturnType<typeof claimOpenCodeAgentActivity> | undefined;
  try {
    claim = claimOpenCodeAgentActivity(current.project, "reviewer", "direct", "session");
    const directory = await activityProjectDirectory(current.home);
    const template = JSON.parse(await readFile(join(directory, "reviewer.json"), "utf8"));
    for (let index = 0; index < 32; index += 1) {
      const agent = `member${String(index).padStart(2, "0")}`;
      await writeFile(join(directory, `${agent}.json`), JSON.stringify({ ...template, agent }), { mode: 0o600 });
    }
    const recovery = readOpenCodeAgentActivitiesIncludingStale(current.project);
    assert.equal(recovery.length, 33);
    assert.ok(recovery.some(({ agent }) => agent === "member31"));
    assert.throws(() => readOpenCodeAgentActivities(current.project), /active-claim safety limit/u);
  } finally {
    claim?.release();
    current.restore();
  }
});

test("OpenCode activity loses ownership on same-inode token replacement and never mutates or deletes it", async () => {
  const current = await fixture("harbor-opencode-activity-rewrite-");
  try {
    const claim = claimOpenCodeAgentActivity(current.project, "reviewer", "delegated", "lead-session");
    let ownershipLossNotifications = 0;
    claim.onOwnershipLost(() => { ownershipLossNotifications += 1; });
    const directory = await activityProjectDirectory(current.home);
    const file = join(directory, "reviewer.json");
    const stored = JSON.parse(await readFile(file, "utf8"));
    stored.claimToken = "A".repeat(24);
    await writeFile(file, JSON.stringify(stored), { mode: 0o600 });
    if (process.platform !== "win32") await chmod(file, 0o600);
    const before = await lstat(file, { bigint: true });
    assert.equal(claim.setSessionID("child-session"), false);
    assert.equal(claim.setPhase("working"), false);
    assert.equal(claim.snapshot.sessionID, "lead-session", "failed readback changed the local owner snapshot");
    assert.equal(claim.snapshot.phase, "starting", "failed readback changed the local lifecycle phase");
    await new Promise((resolve) => setTimeout(resolve, 2_150));
    assert.equal(ownershipLossNotifications, 1, "exact ownership loss was not signalled exactly once");
    const after = await lstat(file, { bigint: true });
    assert.equal(after.mtimeNs, before.mtimeNs, "old owner heartbeated a replacement token");
    assert.equal(claim.release(), false, "old owner deleted a replacement generation");
    assert.equal(JSON.parse(await readFile(file, "utf8")).claimToken, "A".repeat(24));
    await rm(file);
    assert.equal(claim.release(), true, "release could not confirm absence on retry");
    assert.equal(ownershipLossNotifications, 1, "release repeated the one-shot ownership-loss signal");
  } finally { current.restore(); }
});

test("OpenCode activity fails closed on partial, corrupt, temporary, and multi-link claim inventory", async () => {
  const current = await fixture("harbor-opencode-activity-corrupt-");
  let claim: ReturnType<typeof claimOpenCodeAgentActivity> | undefined;
  try {
    claim = claimOpenCodeAgentActivity(current.project, "reviewer", "direct", "session");
    const directory = await activityProjectDirectory(current.home);
    const file = join(directory, "reviewer.json");
    const validClaim = await readFile(file, "utf8");
    const temporary = join(directory, `.agent-harbor-activity-tmp-${"B".repeat(24)}`);
    await link(file, temporary);
    assert.throws(() => readOpenCodeAgentActivities(current.project), /publication recovery is required/u);
    await rm(temporary);
    assert.equal(readOpenCodeAgentActivities(current.project).length, 1);
    assert.equal(claim.release(), true);
    claim = undefined;

    await writeFile(file, "{", { mode: 0o600 });
    assert.throws(() => readOpenCodeAgentActivities(current.project), /invalid Agent Harbor shared activity claim|JSON|property name/u);
    assert.throws(() => claimOpenCodeAgentActivity(current.project, "reviewer", "direct", "new"));
    await rm(file);
    await writeFile(file, validClaim.replace('{"version":2', '{"version":2,"version":2'), { mode: 0o600 });
    assert.throws(() => readOpenCodeAgentActivities(current.project), /invalid Agent Harbor shared activity claim/u);
    await rm(file);
    await writeFile(temporary, "", { mode: 0o600 });
    assert.throws(() => readOpenCodeAgentActivities(current.project), /publication recovery is required/u);
  } finally {
    claim?.release();
    current.restore();
  }
});

test("OpenCode activity reads legacy version-1 claims without inventing an owner runtime", async () => {
  const current = await fixture("harbor-opencode-activity-legacy-claim-");
  let claim: ReturnType<typeof claimOpenCodeAgentActivity> | undefined;
  try {
    claim = claimOpenCodeAgentActivity(current.project, "reviewer", "direct", "session");
    const directory = await activityProjectDirectory(current.home);
    const file = join(directory, "reviewer.json");
    const currentStored = JSON.parse(await readFile(file, "utf8"));
    const { ownerRuntime: _ownerRuntime, ...legacyStored } = currentStored;
    await writeFile(file, JSON.stringify({ ...legacyStored, version: 1 }), { mode: 0o600 });
    if (process.platform !== "win32") await chmod(file, 0o600);

    const [legacy] = readOpenCodeAgentActivities(current.project);
    assert.equal(legacy?.agent, "reviewer");
    assert.equal(legacy?.ownerRuntime, undefined);
    assert.throws(
      () => claimOpenCodeAgentActivity(current.project, "reviewer", "direct", "replacement"),
      /busy in another direct or delegated run/u,
    );

    await writeFile(file, JSON.stringify({ ...currentStored, ownerRuntime: "pi" }), { mode: 0o600 });
    assert.throws(
      () => readOpenCodeAgentActivities(current.project),
      /invalid Agent Harbor activity owner runtime for this namespace/u,
      "the OpenCode namespace accepted a Pi owner-runtime claim",
    );

    await rm(file);
    assert.equal(claim.release(), true);
    claim = undefined;
  } finally {
    claim?.release();
    current.restore();
  }
});

test("OpenCode activity recovers a full 64-claim dead inventory and a dead capacity lock under exact ownership", async () => {
  const current = await fixture("harbor-opencode-activity-dead-inventory-");
  let survivor: ReturnType<typeof claimOpenCodeAgentActivity> | undefined;
  try {
    const moduleURL = pathToFileURL(join(process.cwd(), "src", "adapters", "opencode-agent-activity.ts")).href;
    const source = `
      const { claimOpenCodeAgentActivity } = await import(${JSON.stringify(moduleURL)});
      claimOpenCodeAgentActivity(${JSON.stringify(current.project)}, "dead00", "direct", "dead-owner-session");
      process.stdout.write(String(process.pid));
    `;
    const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", source], {
      cwd: process.cwd(),
      env: { ...process.env, OPENCODE_CONFIG_DIR: current.home },
      encoding: "utf8",
      windowsHide: true,
      timeout: 10_000,
    });
    assert.equal(child.status, 0, child.stderr);
    assert.match(child.stdout, /^\d+$/u);

    const directory = await activityProjectDirectory(current.home);
    const template = JSON.parse(await readFile(join(directory, "dead00.json"), "utf8"));
    assert.equal(template.processID, Number(child.stdout));
    const stale = new Date(Date.now() - 31_000);
    await Promise.all(Array.from({ length: 64 }, async (_, index) => {
      const agent = `dead${String(index).padStart(2, "0")}`;
      const file = join(directory, `${agent}.json`);
      await writeFile(file, JSON.stringify({
        ...template,
        agent,
        claimToken: `dead${String(index).padStart(20, "0")}`,
      }), { mode: 0o600 });
      await utimes(file, stale, stale);
    }));
    assert.equal((await readdir(directory)).length, 64);

    survivor = claimOpenCodeAgentActivity(current.project, "survivor", "direct", "survivor-session");
    assert.deepEqual(readOpenCodeAgentActivities(current.project).map(({ agent }) => agent), ["survivor"]);
    assert.deepEqual(await readdir(directory), ["survivor.json"]);
    assert.equal(survivor.release(), true);
    survivor = undefined;

    const deadLock = join(directory, ".agent-harbor-capacity.lock");
    await writeFile(deadLock, JSON.stringify({
      version: 1,
      owner: "agent-harbor",
      project: template.project,
      processID: template.processID,
      startedAt: template.startedAt,
      claimToken: "L".repeat(24),
    }), { mode: 0o600 });
    await utimes(deadLock, stale, stale);
    assert.deepEqual(readOpenCodeAgentActivities(current.project), []);
    assert.deepEqual(await readdir(directory), [], "dead capacity lock was not recovered by an ordinary activity read");
  } finally {
    survivor?.release();
    current.restore();
  }
});

test("OpenCode activity bounds inventory incrementally at the sixty-fifth entry", async () => {
  const current = await fixture("harbor-opencode-activity-overflow-");
  let claim: ReturnType<typeof claimOpenCodeAgentActivity> | undefined;
  try {
    claim = claimOpenCodeAgentActivity(current.project, "reviewer", "direct", "session");
    const directory = await activityProjectDirectory(current.home);
    const template = JSON.parse(await readFile(join(directory, "reviewer.json"), "utf8"));
    for (let index = 0; index < 64; index += 1) {
      const agent = `member${String(index).padStart(2, "0")}`;
      await writeFile(join(directory, `${agent}.json`), JSON.stringify({ ...template, agent }), { mode: 0o600 });
    }
    assert.throws(
      () => readOpenCodeAgentActivities(current.project),
      /inventory exceeds its directory-entry safety limit/u,
    );
  } finally {
    claim?.release();
    current.restore();
  }
});

test("OpenCode activity parent and leaf swaps preserve foreign replacements", async (t) => {
  const current = await fixture("harbor-opencode-activity-swap-");
  let claim: ReturnType<typeof claimOpenCodeAgentActivity> | undefined;
  try {
    claim = claimOpenCodeAgentActivity(current.project, "reviewer", "direct", "session");
    const directory = await activityProjectDirectory(current.home);
    const moved = `${directory}-moved`;
    try { await rename(directory, moved); }
    catch (error: any) {
      if (process.platform === "win32" && ["EPERM", "EACCES", "EBUSY"].includes(error?.code)) {
        assert.equal(claim.release(), true, "a blocked parent swap also blocked ordinary cleanup");
        claim = undefined;
        t.skip("Windows blocked the adversarial parent rename while the claim handle was open");
        return;
      }
      throw error;
    }
    await mkdir(directory, { mode: 0o700 });
    const sentinel = join(directory, "reviewer.json");
    await writeFile(sentinel, "FOREIGN-SENTINEL", { mode: 0o600 });
    assert.equal(claim.release(), false);
    assert.equal(await readFile(sentinel, "utf8"), "FOREIGN-SENTINEL");
    claim = undefined;

    const outside = join(current.root, "outside.json");
    await writeFile(outside, "OUTSIDE", { mode: 0o600 });
    await rm(sentinel);
    try { await symlink(outside, sentinel, "file"); }
    catch (error: any) {
      if (["EPERM", "EACCES"].includes(error?.code)) {
        t.diagnostic("leaf symlink creation is unavailable on this Windows host");
        return;
      }
      throw error;
    }
    assert.throws(() => readOpenCodeAgentActivities(current.project), /unsafe OpenCode activity (?:claim|inventory entry)/u);
    assert.equal(await readFile(outside, "utf8"), "OUTSIDE");
  } finally {
    claim?.release();
    current.restore();
  }
});

test("OpenCode activity rejects a symlinked configuration home", async (t) => {
  const current = await fixture("harbor-opencode-activity-home-link-");
  try {
    const target = join(current.root, "real-home");
    await mkdir(target, { mode: 0o700 });
    try { await symlink(target, current.home, process.platform === "win32" ? "junction" : "dir"); }
    catch (error: any) {
      if (["EPERM", "EACCES"].includes(error?.code)) {
        t.skip("directory symlink creation is unavailable on this host");
        return;
      }
      throw error;
    }
    assert.throws(
      () => claimOpenCodeAgentActivity(current.project, "reviewer", "direct", "session"),
      /unsafe OpenCode configuration home|unsafe OpenCode activity directory/u,
    );
  } finally { current.restore(); }
});

test("OpenCode activity reclaims a crashed owner only after TTL and definite PID exit", async () => {
  const current = await fixture("harbor-opencode-activity-crash-");
  try {
    const moduleURL = pathToFileURL(join(process.cwd(), "src", "adapters", "opencode-agent-activity.ts")).href;
    const source = `
      const { claimOpenCodeAgentActivity } = await import(${JSON.stringify(moduleURL)});
      claimOpenCodeAgentActivity(${JSON.stringify(current.project)}, "reviewer", "direct", "crashed-session");
      process.stdout.write(String(process.pid));
    `;
    const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", source], {
      cwd: process.cwd(),
      env: { ...process.env, OPENCODE_CONFIG_DIR: current.home },
      encoding: "utf8",
      windowsHide: true,
      timeout: 10_000,
    });
    assert.equal(child.status, 0, child.stderr);
    assert.match(child.stdout, /^\d+$/u);
    const old = readOpenCodeAgentActivities(current.project)[0];
    assert.throws(
      () => claimOpenCodeAgentActivity(current.project, "reviewer", "direct", "replacement"),
      /busy in another direct or delegated run/u,
    );
    const directory = await activityProjectDirectory(current.home);
    const stale = new Date(Date.now() - 31_000);
    await utimes(join(directory, "reviewer.json"), stale, stale);
    const replacement = claimOpenCodeAgentActivity(current.project, "reviewer", "direct", "replacement");
    assert.notEqual(replacement.snapshot.claimToken, old.claimToken);
    assert.equal(replacement.release(), true);
  } finally { current.restore(); }
});

test("OpenCode activity capacity is transactional across competing OS processes", async () => {
  const current = await fixture("harbor-opencode-activity-capacity-");
  const claims: ReturnType<typeof claimOpenCodeAgentActivity>[] = [];
  try {
    for (let index = 0; index < 31; index += 1) {
      const agent = `member${String(index).padStart(2, "0")}`;
      claims.push(claimOpenCodeAgentActivity(current.project, agent, "direct", `session-${agent}`));
    }
    const outcomes = await Promise.all([
      workerClaim(current.project, current.home, "contender-a", 650),
      workerClaim(current.project, current.home, "contender-b", 650),
    ]);
    assert.deepEqual(outcomes.sort(), ["blocked", "ok"], "31 + two contenders exceeded the exact project cap of 32");
  } finally {
    for (const claim of claims) claim.release();
    current.restore();
  }
});

test("OpenCode activity permits only one direct claim per native session across OS processes", async () => {
  const current = await fixture("harbor-opencode-activity-direct-session-");
  try {
    const outcomes = await Promise.all([
      workerClaim(current.project, current.home, "reviewer", 650, "shared-native-session"),
      workerClaim(current.project, current.home, "build", 650, "shared-native-session"),
    ]);
    assert.deepEqual(outcomes.sort(), ["blocked", "ok"]);
    const claims = readOpenCodeAgentActivities(current.project);
    assert.equal(claims.filter(({ kind, sessionID }) =>
      kind === "direct" && sessionID === "shared-native-session").length, 1);
  } finally { current.restore(); }
});

test("OpenCode mutation/admission gate serializes both orders and protects manager snapshots", async () => {
  const current = await fixture("harbor-opencode-activity-roster-gate-");
  const claims: ReturnType<typeof claimOpenCodeAgentActivity>[] = [];
  try {
    for (const [agent, kind] of [["design", "direct"], ["build", "delegated"]] as const) {
      let definition = "before";
      await withOpenCodeRosterMutationGate(current.project, [agent], `replace ${agent}`, async () => {
        definition = "after";
      });
      assert.throws(
        () => claimValidatedOpenCodeAgentActivity(
          current.project,
          agent,
          kind,
          `${kind}-stale-session`,
          () => {
            if (definition !== "before") throw new Error(`${agent} definition changed before admission`);
          },
        ),
        /definition changed before admission/u,
      );
      assert.equal(readOpenCodeAgentActivities(current.project).some((row) => row.agent === agent), false);

      definition = "current";
      const claim = claimValidatedOpenCodeAgentActivity(
        current.project,
        agent,
        kind,
        `${kind}-winning-session`,
        () => assert.equal(definition, "current"),
      );
      claims.push(claim);
      await assert.rejects(
        () => withOpenCodeRosterMutationGate(current.project, [agent], `retire ${agent}`, async () => {
          definition = "mutated";
        }),
        new RegExp(`cannot retire ${agent} while ${agent} is starting`, "u"),
      );
      assert.equal(definition, "current", "blocked mutation executed after admission won");
      assert.equal(claim.release(), true);
      claims.pop();
    }

    for (const manager of ["team-lead", "talent-scout"] as const) {
      const claim = claimOpenCodeAgentActivity(current.project, manager, "direct", `${manager}-session`);
      claims.push(claim);
      await assert.rejects(
        () => withOpenCodeRosterMutationGate(current.project, ["reviewer"], "retire reviewer", async () => {}),
        new RegExp(`${manager} owns an active roster snapshot`, "u"),
      );
      if (manager === "talent-scout") {
        let ownMutationRan = false;
        await runOpenCodeRosterMutationGate(
          "join",
          JSON.stringify({ name: "reviewer", replace: true }),
          current.project,
          async () => { ownMutationRan = true; },
          claim.snapshot.claimToken,
        );
        assert.equal(ownMutationRan, true, "the scout's exact generation could not complete its own validated replacement");
      }
      assert.equal(claim.release(), true);
      claims.pop();
    }
  } finally {
    for (const claim of claims) claim.release();
    current.restore();
  }
});

test("OpenCode deterministic backend blocks destructive activity races and preserves structured no-op truth", async () => {
  const current = await fixture("harbor-opencode-activity-direct-gate-");
  let claim: ReturnType<typeof claimOpenCodeAgentActivity> | undefined;
  try {
    const execute = (command: "bench", args: string) => runOpenCodeRosterMutationGate(
      command,
      args,
      current.project,
      () => runDeterministicCommandResult("opencode", command, args, current.project),
    );
    await execute("bench", "on design");
    claim = claimOpenCodeAgentActivity(current.project, "design", "direct", "design-session");
    await assert.rejects(
      () => execute("bench", "off design"),
      /cannot turn off design while design is starting/u,
    );
    assert.equal(claim.release(), true);
    claim = undefined;

    const changed = await execute("bench", "off design");
    assert.equal(changed.lifecycle?.command, "bench");
    assert.equal(changed.lifecycle?.status, "changed");
    const noOp = await execute("bench", "off design");
    assert.equal(noOp.lifecycle?.command, "bench");
    assert.equal(noOp.lifecycle?.status, "already-current");
    assert.match(noOp.text, /No roster files changed\./u);
  } finally {
    claim?.release();
    current.restore();
  }
});
