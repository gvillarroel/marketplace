import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  discoverStartupActiveProfiles,
  listManagedActiveIds,
  requireInvocablePlayer,
  type ActiveStartupProfileDiscovery,
} from "../src/core/active.js";
import { Roster } from "../src/core/lifecycle.js";
import { harnessSpec } from "../src/core/profiles.js";
import { readSafeBoundedProfile } from "../src/core/safe-profile.js";

function assertPublicBoundedDiagnostics(result: ActiveStartupProfileDiscovery, project: string): void {
  assert.equal(new Set(result.diagnostics.map(({ code }) => code)).size, result.diagnostics.length);
  assert.ok(result.diagnostics.length <= 5);
  for (const diagnostic of result.diagnostics) {
    assert.ok(diagnostic.message.length > 0 && diagnostic.message.length <= 180);
    assert.ok(diagnostic.repair.length > 0 && diagnostic.repair.length <= 180);
    assert.doesNotMatch(diagnostic.message, new RegExp(project.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "u"));
    assert.doesNotMatch(diagnostic.repair, new RegExp(project.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "u"));
  }
}

test("startup discovery skips a foreign profile symlink but keeps canonical managed IDs", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harbor-startup-symlink-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const spec = harnessSpec("copilot", join(root, "home"), join(root, "project"));
  const roster = new Roster(spec);
  await roster.join({ name: "worker", description: "Worker", prompt: "Work", tools: ["read"] });
  const managed = join(spec.project, spec.activeDir, `worker${spec.extension}`);
  const linked = join(spec.project, spec.activeDir, `foreign${spec.extension}`);
  try {
    await symlink(managed, linked, "file");
  } catch (error: any) {
    if (error?.code === "EPERM") { t.skip("file symlinks require an OS privilege"); return; }
    throw error;
  }

  const startup = discoverStartupActiveProfiles("copilot", spec.project);
  assert.deepEqual(startup.ids, ["worker"]);
  assert.equal(startup.complete, false);
  assert.deepEqual(startup.diagnostics.map(({ code }) => code), ["foreign-profile-symlink"]);
  assertPublicBoundedDiagnostics(startup, spec.project);
  assert.throws(() => listManagedActiveIds("copilot", spec.project), /symlink traversal refused/u);
  assert.throws(() => requireInvocablePlayer("copilot", spec.project, "foreign"), /symlink traversal refused/u);
});

test("startup discovery diagnoses an unsafe active-directory symlink without traversing it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harbor-startup-root-symlink-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const spec = harnessSpec("copilot", join(root, "home"), join(root, "project"));
  const activeParent = join(spec.project, ".github");
  const outside = join(root, "foreign-agents");
  await Promise.all([mkdir(activeParent, { recursive: true }), mkdir(outside, { recursive: true })]);
  await writeFile(join(outside, `foreign${spec.extension}`), "unmanaged", "utf8");
  try {
    await symlink(outside, join(spec.project, spec.activeDir), process.platform === "win32" ? "junction" : "dir");
  } catch (error: any) {
    if (error?.code === "EPERM") { t.skip("directory symlinks require an OS privilege"); return; }
    throw error;
  }

  const startup = discoverStartupActiveProfiles("copilot", spec.project);
  assert.deepEqual(startup.ids, []);
  assert.equal(startup.complete, false);
  assert.deepEqual(startup.diagnostics.map(({ code }) => code), ["unsafe-active-directory"]);
  assertPublicBoundedDiagnostics(startup, spec.project);
  assert.throws(() => listManagedActiveIds("copilot", spec.project), /symlink traversal refused/u);
});

test("startup discovery stops streaming at directory and candidate caps with repair diagnostics", async (t) => {
  const entryRoot = await mkdtemp(join(tmpdir(), "harbor-startup-entry-cap-"));
  const candidateRoot = await mkdtemp(join(tmpdir(), "harbor-startup-candidate-cap-"));
  t.after(() => Promise.all([
    rm(entryRoot, { recursive: true, force: true }),
    rm(candidateRoot, { recursive: true, force: true }),
  ]));
  const entrySpec = harnessSpec("copilot", join(entryRoot, "home"), join(entryRoot, "project"));
  const candidateSpec = harnessSpec("copilot", join(candidateRoot, "home"), join(candidateRoot, "project"));
  const entryDirectory = join(entrySpec.project, entrySpec.activeDir);
  const candidateDirectory = join(candidateSpec.project, candidateSpec.activeDir);
  await Promise.all([mkdir(entryDirectory, { recursive: true }), mkdir(candidateDirectory, { recursive: true })]);
  await Promise.all(Array.from({ length: 513 }, (_, index) =>
    writeFile(join(entryDirectory, `noise-${index.toString().padStart(3, "0")}.txt`), "noise", "utf8")));
  await Promise.all(Array.from({ length: 201 }, (_, index) =>
    writeFile(join(candidateDirectory, `candidate-${index.toString().padStart(3, "0")}${candidateSpec.extension}`), "unmanaged", "utf8")));

  const entryStartup = discoverStartupActiveProfiles("copilot", entrySpec.project);
  assert.deepEqual(entryStartup.ids, []);
  assert.equal(entryStartup.complete, false);
  assert.deepEqual(entryStartup.diagnostics.map(({ code }) => code), ["directory-entry-limit"]);
  assertPublicBoundedDiagnostics(entryStartup, entrySpec.project);

  const candidateStartup = discoverStartupActiveProfiles("copilot", candidateSpec.project);
  assert.deepEqual(candidateStartup.ids, []);
  assert.equal(candidateStartup.complete, false);
  assert.deepEqual(candidateStartup.diagnostics.map(({ code }) => code), ["profile-candidate-limit"]);
  assertPublicBoundedDiagnostics(candidateStartup, candidateSpec.project);

  assert.throws(
    () => listManagedActiveIds("copilot", entrySpec.project),
    /too many active profile directory entries: 513/u,
  );
  assert.throws(
    () => listManagedActiveIds("copilot", candidateSpec.project),
    /too many active profiles: 201/u,
  );
});

test("startup IDs never include unmanaged or stale ownership lookalikes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harbor-startup-canonical-only-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const spec = harnessSpec("copilot", join(root, "home"), join(root, "project"));
  const roster = new Roster(spec);
  await roster.join({ name: "canonical", description: "Canonical", prompt: "Work", tools: ["read"] });
  await roster.join({ name: "stale", description: "Stale", prompt: "Work", tools: ["read"] });
  const stale = join(spec.project, spec.activeDir, `stale${spec.extension}`);
  await writeFile(stale, (await readFile(stale, "utf8")).replace('tools: ["read"]', 'tools: ["read","bash"]'), "utf8");
  await writeFile(join(spec.project, spec.activeDir, `foreign${spec.extension}`), "---\nname: foreign\n---\nnot owned", "utf8");

  const startup = discoverStartupActiveProfiles("copilot", spec.project);
  assert.deepEqual(startup.ids, ["canonical"]);
  assert.equal(startup.complete, true);
  assert.deepEqual(startup.diagnostics, []);
  assert.throws(() => requireInvocablePlayer("copilot", spec.project, "stale"), /stale/u);
  assert.throws(() => requireInvocablePlayer("copilot", spec.project, "foreign"), /not found/u);
});

test("shared profile reads reject links, oversized files, and non-regular targets", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harbor-safe-profile-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const normal = join(root, "normal.profile");
  const oversized = join(root, "oversized.profile");
  const directory = join(root, "directory.profile");
  const linked = join(root, "linked.profile");
  await Promise.all([
    writeFile(normal, "managed", "utf8"),
    writeFile(oversized, "x".repeat(30_001), "utf8"),
    mkdir(directory),
  ]);
  assert.equal(await readSafeBoundedProfile(root, normal), "managed");
  assert.equal(await readSafeBoundedProfile(root, oversized), undefined);
  assert.equal(await readSafeBoundedProfile(root, directory), undefined);
  try {
    await symlink(normal, linked, "file");
  } catch (error: any) {
    if (error?.code === "EPERM") { t.skip("file symlinks require an OS privilege"); return; }
    throw error;
  }
  await assert.rejects(() => readSafeBoundedProfile(root, linked), /symlink traversal refused/u);
});
