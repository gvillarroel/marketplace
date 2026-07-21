/**
 * Read-only drift gate for the installed Agent Harbor Copilot plugin.
 *
 * Filesystem verification is the default and never changes the installation.
 * A real, model-free SDK smoke is available only through the explicit --smoke
 * flag; it creates and then deletes one Copilot session.
 */
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, readlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
export const DEFAULT_REFERENCE_ROOT = join(projectRoot, "plugins", "agent-foundry");
const pluginName = "agent-foundry";
const marketplaceName = "agent-harbor";
const remediation = [
  "copilot plugin uninstall agent-foundry@agent-harbor",
  "copilot plugin install agent-foundry@agent-harbor",
];

const usage = `Usage: node scripts/verify-installed-copilot.mjs [options]

Options:
  --reference-root <path>       Canonical plugin tree (default: plugins/agent-foundry)
  --installed-root <path>       Installed plugin tree override (useful for fixtures)
  --copilot-home <path>         Copilot home used for discovery and optional smoke
  --working-directory <path>    Working directory for the optional SDK smoke
  --smoke                       Explicitly run a real, model-free Copilot SDK smoke
  --help                        Show this help

Without --smoke the command performs filesystem reads only.`;

function optionValue(argv, index, name) {
  const argument = argv[index];
  const prefix = `${name}=`;
  if (argument.startsWith(prefix)) return { value: argument.slice(prefix.length), consumed: 0 };
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a path`);
  return { value, consumed: 1 };
}

export function parseArguments(argv) {
  const options = {
    referenceRoot: DEFAULT_REFERENCE_ROOT,
    installedRoot: undefined,
    copilotHome: process.env.COPILOT_HOME || join(homedir(), ".copilot"),
    workingDirectory: projectRoot,
    smoke: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--smoke") { options.smoke = true; continue; }
    if (argument === "--help" || argument === "-h") { options.help = true; continue; }
    const name = ["--reference-root", "--installed-root", "--copilot-home", "--working-directory"]
      .find((candidate) => argument === candidate || argument.startsWith(`${candidate}=`));
    if (!name) throw new Error(`unknown option: ${argument}`);
    const { value, consumed } = optionValue(argv, index, name);
    if (!value.trim()) throw new Error(`${name} requires a non-empty path`);
    const key = {
      "--reference-root": "referenceRoot",
      "--installed-root": "installedRoot",
      "--copilot-home": "copilotHome",
      "--working-directory": "workingDirectory",
    }[name];
    options[key] = resolve(value);
    index += consumed;
  }
  options.referenceRoot = resolve(options.referenceRoot);
  options.copilotHome = resolve(options.copilotHome);
  options.workingDirectory = resolve(options.workingDirectory);
  if (options.installedRoot) options.installedRoot = resolve(options.installedRoot);
  return options;
}

async function pathKind(path) {
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink()) return "symlink";
    if (stats.isDirectory()) return "directory";
    if (stats.isFile()) return "file";
    return "other";
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

async function manifestName(root) {
  const path = join(root, "plugin.json");
  if (await pathKind(path) !== "file") return undefined;
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    return typeof parsed?.name === "string" ? parsed.name : undefined;
  } catch {
    return undefined;
  }
}

/** Finds the single Agent Harbor plugin beneath COPILOT_HOME/installed-plugins. */
export async function findInstalledPluginRoot(copilotHome) {
  const installedPlugins = join(resolve(copilotHome), "installed-plugins");
  const conventional = join(installedPlugins, marketplaceName, pluginName);
  if (await pathKind(conventional)) return conventional;
  if (await pathKind(installedPlugins) !== "directory") {
    throw new Error(`Copilot installed-plugins directory was not found: ${installedPlugins}`);
  }

  const candidates = [];
  const pending = [{ path: installedPlugins, depth: 0 }];
  while (pending.length) {
    const current = pending.shift();
    if (current.depth > 4) continue;
    let entries;
    try { entries = await readdir(current.path, { withFileTypes: true }); }
    catch { continue; }
    if (current.depth > 0 && await manifestName(current.path) === pluginName) {
      candidates.push(current.path);
      continue;
    }
    for (const entry of entries) {
      // Dirent#isDirectory is false for symlinks: discovery never follows one.
      if (entry.isDirectory()) pending.push({ path: join(current.path, entry.name), depth: current.depth + 1 });
    }
  }
  if (!candidates.length) throw new Error(`Installed ${pluginName} plugin was not found beneath ${installedPlugins}`);
  if (candidates.length > 1) {
    throw new Error(`Multiple installed ${pluginName} plugins were found: ${candidates.sort().join(", ")}`);
  }
  return candidates[0];
}

function portablePath(path) {
  return path.split(sep).join("/");
}

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

/** Captures files, directories and unsafe nodes without following symlinks. */
export async function snapshotPluginTree(root) {
  const absoluteRoot = resolve(root);
  const entries = new Map();

  async function visit(path, relativePath, includeSelf) {
    const stats = await lstat(path);
    const name = relativePath || ".";
    if (stats.isSymbolicLink()) {
      entries.set(name, { type: "symlink", target: await readlink(path) });
      return;
    }
    if (stats.isFile()) {
      entries.set(name, { type: "file", sha256: await sha256(path), size: stats.size });
      return;
    }
    if (!stats.isDirectory()) {
      entries.set(name, { type: "other" });
      return;
    }
    if (includeSelf) entries.set(name, { type: "directory" });
    const children = await readdir(path);
    children.sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
    for (const child of children) {
      const childPath = join(path, child);
      const childRelative = portablePath(relative(absoluteRoot, childPath));
      await visit(childPath, childRelative, true);
    }
  }

  await visit(absoluteRoot, "", false);
  return { root: absoluteRoot, entries };
}

function issue(kind, path, detail = {}) {
  return { kind, path, ...detail };
}

/** Compares exact names/types and file SHA-256 values. Symlinks always fail. */
export function comparePluginTrees(reference, installed) {
  const issues = [];
  const paths = new Set([...reference.entries.keys(), ...installed.entries.keys()]);
  for (const path of [...paths].sort()) {
    const expected = reference.entries.get(path);
    const actual = installed.entries.get(path);
    if (!expected) {
      issues.push(issue("unexpected", path, { actualType: actual.type }));
      if (actual.type === "symlink") issues.push(issue("unsafe-symlink", path, { side: "installed", target: actual.target }));
      if (actual.type === "other") issues.push(issue("unsupported-type", path, { side: "installed" }));
      continue;
    }
    if (!actual) {
      issues.push(issue("missing", path, { expectedType: expected.type }));
      if (expected.type === "symlink") issues.push(issue("unsafe-symlink", path, { side: "reference", target: expected.target }));
      if (expected.type === "other") issues.push(issue("unsupported-type", path, { side: "reference" }));
      continue;
    }
    if (expected.type === "symlink") issues.push(issue("unsafe-symlink", path, { side: "reference", target: expected.target }));
    if (actual.type === "symlink") issues.push(issue("unsafe-symlink", path, { side: "installed", target: actual.target }));
    if (expected.type === "other") issues.push(issue("unsupported-type", path, { side: "reference" }));
    if (actual.type === "other") issues.push(issue("unsupported-type", path, { side: "installed" }));
    if (expected.type !== actual.type) {
      issues.push(issue("type", path, { expectedType: expected.type, actualType: actual.type }));
    } else if (expected.type === "file" && expected.sha256 !== actual.sha256) {
      issues.push(issue("content", path, {
        expectedSha256: expected.sha256,
        actualSha256: actual.sha256,
      }));
    }
  }
  return issues;
}

function count(snapshot, type) {
  return [...snapshot.entries.values()].filter((entry) => entry.type === type).length;
}

/** Runs the read-only filesystem portion of the gate. */
export async function verifyInstalledPlugin({
  referenceRoot = DEFAULT_REFERENCE_ROOT,
  installedRoot,
  copilotHome = process.env.COPILOT_HOME || join(homedir(), ".copilot"),
} = {}) {
  const canonical = await snapshotPluginTree(referenceRoot);
  const canonicalManifest = canonical.entries.get("plugin.json");
  if (canonicalManifest?.type !== "file" || await manifestName(referenceRoot) !== pluginName) {
    throw new Error(`Canonical plugin.json must name ${pluginName}: ${resolve(referenceRoot)}`);
  }
  const actualRoot = installedRoot ? resolve(installedRoot) : await findInstalledPluginRoot(copilotHome);
  const installed = await snapshotPluginTree(actualRoot);
  const issues = comparePluginTrees(canonical, installed);
  return {
    ok: issues.length === 0,
    referenceRoot: canonical.root,
    installedRoot: installed.root,
    files: count(canonical, "file"),
    directories: count(canonical, "directory"),
    issues,
  };
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function samePath(left, right) {
  const normalized = (value) => resolve(value).replaceAll("\\", "/").replace(/\/$/u, "");
  const [a, b] = [normalized(left), normalized(right)];
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

async function withTimeout(promise, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function canonicalAgentNames(referenceRoot) {
  const agentRoot = join(referenceRoot, "agents");
  if (await pathKind(agentRoot) !== "directory") return [];
  return (await readdir(agentRoot, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".agent.md"))
    .map((entry) => entry.name.slice(0, -".agent.md".length))
    .sort();
}

/**
 * Explicit real smoke. It does not send a prompt: only a deterministic client
 * command is invoked, then usage and assistant events are checked for zero use.
 */
export async function runModelFreeSmoke({ referenceRoot, installedRoot, copilotHome, workingDirectory }) {
  const discovered = await findInstalledPluginRoot(copilotHome);
  if (!samePath(discovered, installedRoot)) {
    throw new Error(`--smoke must target the plugin discovered by Copilot: ${discovered}`);
  }

  const { CopilotClient } = await import("@github/copilot-sdk");
  const client = new CopilotClient({
    workingDirectory,
    logLevel: "error",
    env: { ...process.env, COPILOT_HOME: copilotHome, NO_COLOR: "1" },
  });
  let session;
  let primaryError;
  try {
    await withTimeout(client.start(), 30_000, "Copilot SDK start");
    session = await withTimeout(client.createSession({
      workingDirectory,
      enableConfigDiscovery: true,
      requestExtensions: true,
      onPermissionRequest: () => ({ kind: "denied-no-approval-rule-and-could-not-request-from-user" }),
      enableSessionTelemetry: false,
      infiniteSessions: { enabled: false },
      skipCustomInstructions: true,
    }), 30_000, "Copilot session creation");

    const modelEvents = [];
    session.on((event) => {
      if (event.type === "assistant.usage" || event.type === "assistant.message") modelEvents.push(event.type);
    });
    let commands;
    let clientCommand;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      commands = await session.rpc.commands.list();
      clientCommand = commands.commands.find((command) => command.kind === "client" && command.name === "team")
        ?? commands.commands.find((command) => command.kind === "client" && command.name === "bench");
      if (clientCommand) break;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
    if (!clientCommand) throw new Error("Installed plugin did not register client /team or /bench");

    const expectedAgents = await canonicalAgentNames(referenceRoot);
    const listedAgents = (await session.rpc.agent.reload()).agents;
    const missingAgents = expectedAgents.filter((name) => !listedAgents.some((agent) =>
      agent.name === name || agent.id === name || agent.id.endsWith(`:${name}`)));
    if (missingAgents.length) throw new Error(`Installed plugin did not expose canonical agents: ${missingAgents.join(", ")}`);

    const before = await session.rpc.usage.getMetrics();
    const invoked = await session.rpc.commands.invoke({
      name: clientCommand.name,
      input: clientCommand.name === "bench" ? "list" : "",
    });
    if (invoked.kind !== "completed") throw new Error(`/${clientCommand.name} did not complete deterministically`);
    const after = await session.rpc.usage.getMetrics();
    if (stableJson(before) !== stableJson(after)) throw new Error(`/${clientCommand.name} changed Copilot usage metrics`);
    if (modelEvents.length) throw new Error(`/${clientCommand.name} emitted model events: ${modelEvents.join(", ")}`);
    return { command: clientCommand.name, agents: expectedAgents.length };
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    const cleanupErrors = [];
    if (session) {
      try { await withTimeout(client.deleteSession(session.sessionId), 10_000, "Copilot session deletion"); }
      catch (error) { cleanupErrors.push(error); }
    }
    try { await withTimeout(client.stop(), 10_000, "Copilot SDK stop"); }
    catch (error) {
      cleanupErrors.push(error);
      try { await client.forceStop(); } catch (forceError) { cleanupErrors.push(forceError); }
    }
    if (!primaryError && cleanupErrors.length) throw new AggregateError(cleanupErrors, "Copilot smoke cleanup failed");
  }
}

function describeIssue(item) {
  if (item.kind === "missing") return `missing ${item.expectedType}: ${item.path}`;
  if (item.kind === "unexpected") return `unexpected ${item.actualType}: ${item.path}`;
  if (item.kind === "type") return `type mismatch: ${item.path} (expected ${item.expectedType}, installed ${item.actualType})`;
  if (item.kind === "content") return `SHA-256 mismatch: ${item.path} (${item.expectedSha256} != ${item.actualSha256})`;
  if (item.kind === "unsafe-symlink") return `unsafe symlink in ${item.side}: ${item.path} -> ${item.target}`;
  return `unsupported filesystem type in ${item.side}: ${item.path}`;
}

function printRemediation(write) {
  write("No files were changed. Reinstall explicitly to repair drift:\n");
  for (const command of remediation) write(`  ${command}\n`);
}

export async function main(argv = process.argv.slice(2), io = console) {
  let options;
  try { options = parseArguments(argv); }
  catch (error) {
    io.error(`${error.message}\n\n${usage}`);
    return 2;
  }
  if (options.help) { io.log(usage); return 0; }

  let report;
  try {
    report = await verifyInstalledPlugin(options);
  } catch (error) {
    io.error(`Copilot plugin verification failed: ${error.message}`);
    printRemediation((text) => io.error(text.trimEnd()));
    return 1;
  }
  if (!report.ok) {
    io.error("Installed Copilot plugin drift detected.");
    io.error(`Canonical: ${report.referenceRoot}`);
    io.error(`Installed: ${report.installedRoot}`);
    for (const item of report.issues) io.error(`- ${describeIssue(item)}`);
    printRemediation((text) => io.error(text.trimEnd()));
    return 1;
  }

  io.log(`Installed Copilot plugin matches ${report.files} files and ${report.directories} directories by exact path and SHA-256.`);
  io.log(`Canonical: ${report.referenceRoot}`);
  io.log(`Installed: ${report.installedRoot}`);
  io.log("Symlinks: none");
  if (!options.smoke) {
    io.log("Smoke: not run (pass --smoke explicitly for the model-free SDK check)");
    return 0;
  }
  try {
    const smoke = await runModelFreeSmoke({ ...options, installedRoot: report.installedRoot });
    io.log(`Smoke: /${smoke.command} completed with unchanged usage, no model events, and ${smoke.agents} canonical agents visible.`);
    return 0;
  } catch (error) {
    io.error(`Model-free Copilot smoke failed: ${error.message}`);
    return 1;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) process.exitCode = await main();
