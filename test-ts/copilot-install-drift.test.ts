import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  comparePluginTrees,
  findInstalledPluginRoot,
  parseArguments,
  snapshotPluginTree,
  verifyInstalledPlugin,
} from "../scripts/verify-installed-copilot.mjs";

const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const script = join(root, "scripts", "verify-installed-copilot.mjs");

async function makePlugin(path: string, files: Record<string, string> = {}) {
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "plugin.json"), JSON.stringify({ name: "agent-foundry", version: "0.12.0" }, null, 2), "utf8");
  for (const [name, body] of Object.entries(files)) {
    await mkdir(dirname(join(path, name)), { recursive: true });
    await writeFile(join(path, name), body, "utf8");
  }
  await mkdir(join(path, "bench"), { recursive: true });
}

async function temporary(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "harbor-copilot-drift-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function run(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: root,
      env: { ...process.env },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolveRun({ code, stdout, stderr }));
  });
}

test("exact installed Copilot plugin trees pass path, directory and SHA-256 verification", async (t) => {
  const sandbox = await temporary(t);
  const canonical = join(sandbox, "canonical");
  const installed = join(sandbox, "installed");
  await makePlugin(canonical, {
    "agents/team-lead.agent.md": "---\nname: team-lead\n---\nLead.\n",
    "runtime/dist/core/a.js": "export const a = 1;\n",
  });
  await cp(canonical, installed, { recursive: true });

  const report = await verifyInstalledPlugin({ referenceRoot: canonical, installedRoot: installed });
  assert.equal(report.ok, true);
  assert.equal(report.issues.length, 0);
  assert.equal(report.files, 3);
  assert.ok(report.directories >= 4, "empty directories must be part of the exact tree");
});

test("same plugin version with a mixed old/new tree fails missing, unexpected and SHA checks", async (t) => {
  const sandbox = await temporary(t);
  const canonical = join(sandbox, "canonical");
  const installed = join(sandbox, "installed");
  await makePlugin(canonical, {
    "agents/crafter.agent.md": "new crafter\n",
    "runtime/dist/core/lifecycle.js": "export const generation = 'new';\n",
  });
  await makePlugin(installed, {
    "runtime/dist/core/lifecycle.js": "export const generation = 'old';\n",
    "skills/bench/SKILL.md": "obsolete wrapper\n",
  });

  assert.equal(JSON.parse(await readFile(join(canonical, "plugin.json"), "utf8")).version, "0.12.0");
  assert.equal(JSON.parse(await readFile(join(installed, "plugin.json"), "utf8")).version, "0.12.0");
  const report = await verifyInstalledPlugin({ referenceRoot: canonical, installedRoot: installed });
  assert.equal(report.ok, false);
  assert.ok(report.issues.some((entry) => entry.kind === "missing" && entry.path === "agents/crafter.agent.md"));
  assert.ok(report.issues.some((entry) => entry.kind === "unexpected" && entry.path === "skills/bench/SKILL.md"));
  assert.ok(report.issues.some((entry) => entry.kind === "content" && entry.path === "runtime/dist/core/lifecycle.js"));
});

test("symlinks are reported as unsafe and their targets are never traversed", async (t) => {
  const sandbox = await temporary(t);
  const canonical = join(sandbox, "canonical");
  const installed = join(sandbox, "installed");
  const outside = join(sandbox, "outside");
  await makePlugin(canonical, { "runtime/linked/inside.js": "canonical\n" });
  await cp(canonical, installed, { recursive: true });
  await rm(join(installed, "runtime", "linked"), { recursive: true, force: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, "secret.js"), "must not be read\n", "utf8");
  try {
    await symlink(outside, join(installed, "runtime", "linked"), process.platform === "win32" ? "junction" : "dir");
  } catch (error: any) {
    if (error?.code === "EPERM" || error?.code === "EACCES") return t.skip("symlink creation is not permitted on this host");
    throw error;
  }

  const referenceTree = await snapshotPluginTree(canonical);
  const installedTree = await snapshotPluginTree(installed);
  const issues = comparePluginTrees(referenceTree, installedTree);
  assert.ok(issues.some((entry) => entry.kind === "unsafe-symlink" && entry.path === "runtime/linked"));
  assert.equal([...installedTree.entries.keys()].some((path) => path.includes("secret.js")), false,
    "the external target must not be visited");
});

test("discovery resolves agent-foundry beneath COPILOT_HOME and never requires an override", async (t) => {
  const sandbox = await temporary(t);
  const home = join(sandbox, "copilot-home");
  const installed = join(home, "installed-plugins", "agent-harbor", "agent-foundry");
  await makePlugin(installed, { "agents/team-lead.agent.md": "lead\n" });
  assert.equal(await findInstalledPluginRoot(home), installed);
});

test("the CLI defaults to read-only verification and runs smoke only with an explicit flag", async (t) => {
  const sandbox = await temporary(t);
  const canonical = join(sandbox, "canonical");
  const installed = join(sandbox, "installed");
  await makePlugin(canonical, { "runtime/a.js": "same\n" });
  await cp(canonical, installed, { recursive: true });

  assert.equal(parseArguments([]).smoke, false);
  assert.equal(parseArguments(["--smoke"]).smoke, true);
  const result = await run(["--reference-root", canonical, "--installed-root", installed]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Smoke: not run/);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /SDK start|session creation/i);
});

test("the CLI fails closed with explicit remediation and does not repair drift", async (t) => {
  const sandbox = await temporary(t);
  const canonical = join(sandbox, "canonical");
  const installed = join(sandbox, "installed");
  await makePlugin(canonical, { "runtime/a.js": "canonical\n" });
  await makePlugin(installed, { "runtime/a.js": "stale\n" });

  const result = await run(["--reference-root", canonical, "--installed-root", installed]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /drift detected/i);
  assert.match(result.stderr, /SHA-256 mismatch: runtime\/a\.js/);
  assert.match(result.stderr, /No files were changed/);
  assert.match(result.stderr, /copilot plugin uninstall agent-foundry@agent-harbor/);
  assert.match(result.stderr, /copilot plugin install agent-foundry@agent-harbor/);
  assert.equal(await readFile(join(installed, "runtime", "a.js"), "utf8"), "stale\n");
});

test("filesystem snapshots reject a symlink used as the plugin root", async (t) => {
  const sandbox = await temporary(t);
  const canonical = join(sandbox, "canonical");
  const installedTarget = join(sandbox, "installed-target");
  const installedLink = join(sandbox, "installed-link");
  await makePlugin(canonical, { "runtime/a.js": "same\n" });
  await cp(canonical, installedTarget, { recursive: true });
  try {
    await symlink(installedTarget, installedLink, process.platform === "win32" ? "junction" : "dir");
  } catch (error: any) {
    if (error?.code === "EPERM" || error?.code === "EACCES") return t.skip("symlink creation is not permitted on this host");
    throw error;
  }
  const report = await verifyInstalledPlugin({ referenceRoot: canonical, installedRoot: installedLink });
  assert.equal(report.ok, false);
  assert.ok(report.issues.some((entry) => entry.kind === "unsafe-symlink" && entry.path === "."));
});

test("fixture paths remain resolved without following a plugin-root symlink", async (t) => {
  const sandbox = await temporary(t);
  const parsed = parseArguments(["--reference-root", join(sandbox, "a"), "--installed-root", join(sandbox, "b")]);
  assert.equal(parsed.referenceRoot, resolve(sandbox, "a"));
  assert.equal(parsed.installedRoot, resolve(sandbox, "b"));
});
