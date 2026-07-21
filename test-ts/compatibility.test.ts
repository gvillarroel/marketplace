import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CopilotClient, RuntimeConnection, approveAll } from "@github/copilot-sdk";
import { bundledPlayers, rolePlayers } from "../src/core/defaults.js";
import { commandNames, deterministicCommandNames } from "../src/core/types.js";
import { runCopilotControl } from "../src/adapters/copilot.js";

const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const plugins = join(root, "plugins");
const dist = join(root, "dist");
const commands = new Set<string>(commandNames);

interface Launch { command: string; prefix: string[] }

async function executable(name: string): Promise<Launch | undefined> {
  const suffixes = process.platform === "win32" ? [".exe", ".com"] : [""];
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    for (const suffix of suffixes) {
      const candidate = join(directory, `${name}${suffix}`);
      try {
        await access(candidate, constants.X_OK);
        const resolved = await realpath(candidate);
        if (name === "pi" && resolved.endsWith(".js")) return { command: process.execPath, prefix: [resolved] };
        return { command: candidate, prefix: [] };
      } catch { /* keep looking */ }
    }
    if (process.platform === "win32") {
      const known = name === "opencode"
        ? { command: join(directory, "node_modules", "opencode-ai", "bin", "opencode.exe"), prefix: [] }
        : name === "pi"
          ? { command: process.execPath, prefix: [join(directory, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js")] }
          : undefined;
      if (known) {
        try { await access(known.command === process.execPath ? known.prefix[0] : known.command, constants.X_OK); return known; } catch { /* keep looking */ }
      }
    }
  }
  return undefined;
}

interface Result { code: number | null; stdout: string; stderr: string; timedOut: boolean }

interface AcpInspection { transcript: string; serverRequests: string[] }

async function run(launch: Launch, args: string[], options: { cwd: string; env?: NodeJS.ProcessEnv; timeout?: number; input?: string }): Promise<Result> {
  return new Promise((resolve, reject) => {
    const child = spawn(launch.command, [...launch.prefix, ...args], {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let stdout = ""; let stderr = ""; let timedOut = false;
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    if (options.input !== undefined) child.stdin.end(options.input);
    child.on("error", reject);
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, options.timeout ?? 60_000);
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr, timedOut }); });
  });
}

function succeeded(result: Result): void {
  assert.equal(result.timedOut, false, `command timed out\n${result.stderr}`);
  assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
}

async function inspectCopilotEnvironment(launch: Launch, sandbox: string): Promise<AcpInspection> {
  const child = spawn(launch.command, [...launch.prefix,
    "--experimental", "--no-auto-update", "--no-color",
    "--plugin-dir", join(plugins, "agent-foundry"),
    "--plugin-dir", join(plugins, "repo-cartographer"),
    "--acp", "--stdio",
  ], {
    cwd: root,
    env: {
      ...process.env,
      CI: "1",
      NO_COLOR: "1",
      COPILOT_HOME: join(sandbox, "copilot-home"),
      COPILOT_PLUGIN_DIR_ONLY: "true",
      XDG_CACHE_HOME: join(sandbox, "xdg-cache"),
      XDG_CONFIG_HOME: join(sandbox, "xdg-config"),
    },
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buffer = ""; let stderr = ""; let requestId = 0; let stopping = false;
  const updates: unknown[] = []; const serverRequests: string[] = [];
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  let rejectFailure!: (error: Error) => void;
  const failure = new Promise<never>((_resolve, reject) => { rejectFailure = reject; });
  let closeProcess!: () => void;
  const closed = new Promise<void>((resolve) => { closeProcess = resolve; });

  function fail(error: Error): void {
    rejectFailure(error);
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  }

  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  child.stdout.setEncoding("utf8").on("data", (chunk) => {
    buffer += chunk;
    for (;;) {
      const end = buffer.indexOf("\n");
      if (end < 0) break;
      const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1);
      if (!line) continue;
      let message: any;
      try { message = JSON.parse(line); }
      catch { fail(new Error(`Copilot ACP emitted non-JSON output: ${line}`)); return; }
      if (typeof message.id === "number" && (Object.hasOwn(message, "result") || Object.hasOwn(message, "error"))) {
        const waiter = pending.get(message.id);
        if (!waiter) continue;
        pending.delete(message.id);
        if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
        else waiter.resolve(message.result);
      } else if (message.method === "session/update") {
        updates.push(message.params);
      } else if (message.id !== undefined && typeof message.method === "string") {
        serverRequests.push(message.method);
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} })}\n`);
      }
    }
  });
  child.once("error", (error) => fail(error));
  child.once("close", (code) => {
    closeProcess();
    if (!stopping) fail(new Error(`Copilot ACP exited early with ${code}: ${stderr}`));
  });

  function request(method: string, params: unknown): Promise<unknown> {
    const id = ++requestId;
    const response = new Promise<unknown>((resolve, reject) => pending.set(id, { resolve, reject }));
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return response;
  }

  const timeout = new Promise<never>((_resolve, reject) => {
    setTimeout(() => reject(new Error(`Copilot ACP /env timed out: ${stderr}`)), 30_000).unref();
  });
  try {
    const workflow = (async (): Promise<AcpInspection> => {
      await request("initialize", { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "agent-harbor-test", version: "1" } });
      const session = await request("session/new", { cwd: root, mcpServers: [] }) as { sessionId?: unknown };
      assert.equal(typeof session.sessionId, "string");
      const prompt = await request("session/prompt", { sessionId: session.sessionId, prompt: [{ type: "text", text: "/env" }] });
      return { transcript: JSON.stringify({ updates, prompt }), serverRequests };
    })();
    return await Promise.race([workflow, failure, timeout]);
  } finally {
    stopping = true;
    child.stdin.end();
    child.kill();
    await Promise.race([closed, new Promise<void>((resolve) => setTimeout(resolve, 1_000))]);
  }
}

async function pluginDirectories(): Promise<string[]> {
  const entries = await readdir(plugins, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => join(plugins, entry.name));
}

async function inspectCopilotDirectExtension(launch: Launch, sandbox: string, workingDirectory: string): Promise<{ events: string[]; commands: any[]; agents: any[] }> {
  const client = new CopilotClient({
    connection: RuntimeConnection.forStdio({
      path: launch.command,
      args: [
        ...launch.prefix, "--experimental", "--no-auto-update", "--no-color",
        "--plugin-dir", join(plugins, "agent-foundry"),
        "--plugin-dir", join(plugins, "repo-cartographer"),
      ],
    }),
    workingDirectory,
    baseDirectory: join(sandbox, "sdk-home"),
    logLevel: "error",
    env: { ...process.env, COPILOT_PLUGIN_DIR_ONLY: "true", NO_COLOR: "1" },
  });
  let session: Awaited<ReturnType<CopilotClient["createSession"]>> | undefined;
  const events: string[] = [];
  try {
    await client.start();
    session = await client.createSession({
      workingDirectory,
      enableConfigDiscovery: true,
      requestExtensions: true,
      onPermissionRequest: approveAll,
      enableSessionTelemetry: false,
      infiniteSessions: { enabled: false },
      skipCustomInstructions: true,
    });
    session.on((event) => { events.push(event.type); });
    let listed = await session.rpc.commands.list();
    let direct = listed.commands.find((command) => command.name === "bench" && command.kind === "client");
    for (let attempt = 0; !direct && attempt < 30; attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      listed = await session.rpc.commands.list();
      direct = listed.commands.find((command) => command.name === "bench" && command.kind === "client");
    }
    assert.ok(direct, `Copilot must discover the direct /bench extension command: ${JSON.stringify(listed.commands)}`);
    const expectedCommands = [...rolePlayers.keys(), ...bundledPlayers.keys()].map((id) => `harbor-${id}`);
    assert.ok(expectedCommands.every((name) => listed.commands.some((command) => command.name === name && command.kind === "client")));

    const initial = await session.rpc.agent.list();
    for (const id of rolePlayers.keys()) assert.ok(initial.agents.some((agent) => agent.name === id || agent.id.endsWith(`:${id}`)), id);
    for (const id of bundledPlayers.keys()) assert.ok(!initial.agents.some((agent) => agent.name === id || agent.id === id), `${id} must start on the bench`);
    await assert.rejects(() => session!.rpc.commands.invoke({ name: "harbor-portfolio-management", input: "must not reach a model" }), /not active/i);

    const invoked = await session.rpc.commands.invoke({ name: "bench", input: "on all" });
    assert.equal(invoked.kind, "completed");
    await assert.rejects(() => session!.rpc.commands.invoke({ name: "bench", input: "toggle" }), /usage: \/?bench/);
    const refreshed = await session.rpc.agent.reload();
    for (const id of [...rolePlayers.keys(), ...bundledPlayers.keys()]) {
      const expectedFixed = {
        "team-lead": "agent-foundry:team-lead",
        "repo-cartographer": "repo-cartographer:repo-cartographer",
        crafter: "repo-cartographer:crafter",
      }[id];
      const agent = expectedFixed
        ? refreshed.agents.find((candidate) => candidate.id === expectedFixed)
        : refreshed.agents.find((candidate) => candidate.name === id || candidate.id === id);
      assert.ok(agent, `Copilot must discover ${id}: ${JSON.stringify(refreshed.agents)}`);
      assert.notEqual(agent.userInvocable, false, id);
      const selected = await session.rpc.agent.select({ name: agent.id });
      assert.equal(selected.agent.id, agent.id);
      assert.equal((await session.rpc.agent.getCurrent()).agent?.id, agent.id);
      await session.rpc.agent.deselect();
    }
    assert.ok(!events.includes("assistant.usage"));
    assert.ok(!events.includes("assistant.message"));
    return { events, commands: listed.commands, agents: refreshed.agents };
  } finally {
    if (session) await client.deleteSession(session.sessionId);
    await client.stop();
  }
}

test("distribution declares native TypeScript entrypoints", async () => {
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  assert.equal(manifest.main, "./dist/adapters/opencode.js");
  assert.equal(manifest.exports["./server"], "./dist/adapters/opencode.js");
  assert.equal(manifest.exports["./tui"], "./dist/adapters/opencode-tui.js");
  assert.ok(manifest.files.includes("REQUIREMENTS.md"));
  assert.ok(manifest.files.includes("ARCHITECTURE.md"));
  assert.ok(manifest.files.includes("SIMPLIFICATION-PLAN.md"));
  assert.deepEqual(manifest.pi.extensions, ["./dist/adapters/pi.js"]);
  assert.ok(!("prompts" in manifest.pi));
  assert.equal(manifest.engines.node, ">=22.19.0");
  assert.equal(manifest.dependencies["@github/copilot-sdk"], "1.0.6");
  assert.equal(manifest.dependencies["@opencode-ai/plugin"], "1.17.13");
  assert.equal(manifest.peerDependencies["@earendil-works/pi-coding-agent"], "0.80.10");
  assert.match(manifest.scripts["test:live:lead"], /run-live-lead\.mjs/);
  assert.match(manifest.scripts.test, /run-tests\.mjs/);
  assert.doesNotMatch(manifest.scripts.test, /&&|npm run/);
  assert.doesNotMatch(manifest.scripts["test:live:lead"], /&&|npm run/);
  assert.doesNotMatch(manifest.scripts["test:ts"], /live-team-lead/);
  const liveRunner = await readFile(join(root, "scripts", "run-live-lead.mjs"), "utf8");
  assert.match(liveRunner, /live-team-lead\.test\.ts/);
  assert.match(liveRunner, /report\?\.status !== "passed"/);
  assert.match(liveRunner, /rm\(reportPath, \{ force: true \}\)/);
  assert.match(liveRunner, /delete env\.NODE_TEST_CONTEXT/);
  assert.match(liveRunner, /generatedAt > now \+ 5_000/);
  assert.match(liveRunner, /process\.exit\(1\)/);
  assert.match(liveRunner, /scripts\/build\.mjs/);
  const suiteRunner = await readFile(join(root, "scripts", "run-test-suite.mjs"), "utf8");
  assert.match(suiteRunner, /--test-reporter=tap/);
  assert.match(suiteRunner, /failures !== 0/);
  assert.match(suiteRunner, /delete env\.NODE_TEST_CONTEXT/);
  assert.match(suiteRunner, /process\.exit\(1\)/);
  const testRunner = await readFile(join(root, "scripts", "run-tests.mjs"), "utf8");
  assert.match(testRunner, /scripts\/build\.mjs/);
  assert.match(testRunner, /scripts\/run-test-suite\.mjs/);
  assert.match(testRunner, /process\.exit\(1\)/);
  await Promise.all([
    access(join(dist, "adapters", "opencode.js")),
    access(join(dist, "adapters", "opencode-tui.js")),
    access(join(dist, "adapters", "pi.js")),
    access(join(dist, "core", "commands.js")),
    access(join(plugins, "agent-foundry", "agents", "team-lead.agent.md")),
    access(join(plugins, "repo-cartographer", "agents", "repo-cartographer.agent.md")),
    access(join(plugins, "repo-cartographer", "agents", "crafter.agent.md")),
  ]);
  for (const [path, name] of [
    [join(plugins, "agent-foundry", "agents", "team-lead.agent.md"), "team-lead"],
    [join(plugins, "repo-cartographer", "agents", "repo-cartographer.agent.md"), "repo-cartographer"],
    [join(plugins, "repo-cartographer", "agents", "crafter.agent.md"), "crafter"],
  ]) assert.match(await readFile(path, "utf8"), new RegExp(`^---\\nname: ${name}\\n`));
  const teamLead = await readFile(join(plugins, "agent-foundry", "agents", "team-lead.agent.md"), "utf8");
  assert.match(teamLead, /between one and six bounded synchronous `task` calls/i);
  assert.match(teamLead, /Never target `team-lead`/);
});

test("opt-in Codex live scripts invoke a guarded report-validating runner", async () => {
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const expectedScripts = {
    "test:live:opencode": "node scripts/run-live-codex-leads.mjs opencode",
    "test:live:pi": "node scripts/run-live-codex-leads.mjs pi",
    "test:live:codex": "node scripts/run-live-codex-leads.mjs all",
  } as const;

  for (const [name, command] of Object.entries(expectedScripts)) {
    assert.equal(manifest.scripts[name], command, `${name} must invoke the live runner directly`);
    assert.doesNotMatch(manifest.scripts[name], /&&|npm run/);
  }

  const runner = await readFile(join(root, "scripts", "run-live-codex-leads.mjs"), "utf8");
  assert.match(runner, /delete env\.NODE_TEST_CONTEXT/);
  assert.match(runner, /reports\.values\(\)\]\.map\(\(path\) => rm\(path, \{ force: true \}\)\)/);
  assert.match(runner, /report\?\.schema !== "agent-harbor\/live-codex-team-lead@1"/);
  assert.match(runner, /report\?\.status !== "passed" \|\| report\?\.harness !== harness/);
  assert.match(runner, /generatedAt > now \+ 5_000/);
  assert.match(runner, /requireFresh && generatedAt < startedAt - 1_000/);
  assert.match(runner, /!requireFresh && generatedAt < now - 24 \* 60 \* 60_000/);
  assert.match(runner, /catch \(error\)[\s\S]*process\.exit\(1\)/);
});

test("Copilot plugins expose canonical commands and one plugin-provided MCP server", async () => {
  const directories = await pluginDirectories();
  const skillNames = new Set<string>();
  const manifests: Array<{ name: string; version: string }> = [];
  for (const directory of directories) {
    manifests.push(JSON.parse(await readFile(join(directory, "plugin.json"), "utf8")));
    const skillsDirectory = join(directory, "skills");
    let skills: import("node:fs").Dirent[] = [];
    const localSkills = new Set<string>();
    try { skills = await readdir(skillsDirectory, { withFileTypes: true }); } catch { /* plugin has no skills */ }
    for (const skill of skills) {
      if (skill.isDirectory()) {
        try { await access(join(skillsDirectory, skill.name, "SKILL.md")); skillNames.add(skill.name); localSkills.add(skill.name); } catch { /* not a skill */ }
      }
    }
    if (directory.endsWith(join("plugins", "agent-foundry"))) assert.deepEqual(localSkills, commands);
  }
  assert.ok([...commands].every((name) => skillNames.has(name)));
  assert.deepEqual(new Set(manifests.map((manifest) => manifest.name)), new Set(["agent-foundry", "repo-cartographer"]));
  const marketplace = JSON.parse(await readFile(join(root, ".github", "plugin", "marketplace.json"), "utf8"));
  const marketplaceVersions = new Map<string, string>(marketplace.plugins.map((plugin: any) => [plugin.name, plugin.version]));
  for (const manifest of manifests) assert.equal(marketplaceVersions.get(manifest.name), manifest.version);
  assert.equal(marketplace.metadata.version, "0.12.0");
  await Promise.all([
    access(join(plugins, "agent-foundry", "runtime", "dist", "adapters", "copilot.js")),
    access(join(plugins, "agent-foundry", "runtime", "dist", "adapters", "copilot-mcp.js")),
    access(join(plugins, "agent-foundry", "runtime", "dist", "adapters", "copilot-coordinator.js")),
  ]);
  for (const name of commands) {
    const control = await readFile(join(plugins, "agent-foundry", "skills", name, "SKILL.md"), "utf8");
    assert.match(control, /agent-harbor\(control\)/);
    assert.match(control, /`control` tool from the `agent-harbor` MCP server/);
    assert.doesNotMatch(control, /agent_harbor/);
    assert.doesNotMatch(control, /\bnode\b|runtime\/dist/);
  }
  assert.match(await readFile(join(plugins, "agent-foundry", "skills", "contract", "SKILL.md"), "utf8"), /Call `task` exactly once/);
  const foundryManifest = JSON.parse(await readFile(join(plugins, "agent-foundry", "plugin.json"), "utf8"));
  assert.equal(foundryManifest.mcpServers, ".mcp.json");
  assert.deepEqual(foundryManifest.extensions, { paths: ["extensions/agent-harbor"], exclusive: false });
  const mcpConfiguration = JSON.parse(await readFile(join(plugins, "agent-foundry", ".mcp.json"), "utf8"));
  assert.deepEqual(Object.keys(mcpConfiguration.mcpServers), ["agent-harbor"]);
  const harbor = mcpConfiguration.mcpServers["agent-harbor"];
  assert.equal(harbor.type, "stdio");
  assert.equal(harbor.command, "node");
  assert.deepEqual(harbor.tools, ["control"], "the global MCP server must expose no player skill groups");
  assert.equal(harbor.timeout, 45_000);
  assert.ok(harbor.args.some((argument: string) => argument.includes("copilot-mcp.js")));
  const extension = await readFile(join(plugins, "agent-foundry", "extensions", "agent-harbor", "extension.mjs"), "utf8");
  assert.match(extension, /joinSession/);
  assert.match(extension, /runDeterministicCommand/);
  assert.match(extension, /createCopilotCoordinatorGuard/);
  assert.match(extension, /hooks: coordinator\.hooks/);
  assert.match(extension, /coordinator\.observeEvent/);
  assert.match(extension, /event\.phase !== "target\.resolved"/);
  assert.match(extension, /type: "agent-harbor-guard"/);
  assert.match(extension, /ephemeral: true/);
  assert.match(extension, /await coordinator\.refresh\(\)/);
  for (const name of deterministicCommandNames) assert.match(extension, new RegExp(`\\["${name}"`));
  assert.equal(extension.match(/sendAndWait/g)?.length, 1, "only explicit player commands may send one prompt");
  assert.match(extension, /agent\.select/);
  assert.match(extension, /harbor-\$\{id\}/);
  assert.doesNotMatch(extension, /createSession|\.prompt\(/);
  assert.doesNotMatch(extension, /[\[\"]contract[\]\"]\s*,/);
  assert.match(extension, /catch \(error\)[\s\S]*throw error;/);
  const crafter = await readFile(join(plugins, "repo-cartographer", "agents", "crafter.agent.md"), "utf8");
  assert.match(crafter, /"repo-cartographer-crafter-skills\/skills"/);
  assert.match(crafter, /mcp-servers:\n  repo-cartographer-crafter-skills:/);
  assert.match(crafter, /"--skills-player", "crafter"/);
  assert.match(crafter, /`skills` from the player-scoped `repo-cartographer-crafter-skills` MCP server/);
  assert.doesNotMatch(crafter, /"agent-harbor\/skill"/);
  assert.doesNotMatch(crafter, /agent_harbor_skill/);
});

test("Copilot runtime is generated byte-for-byte from shared core", async () => {
  const pluginDist = join(plugins, "agent-foundry", "runtime", "dist");
  for (const name of (await readdir(join(dist, "core"))).filter((entry) => entry.endsWith(".js"))) {
    assert.deepEqual(await readFile(join(dist, "core", name)), await readFile(join(pluginDist, "core", name)), name);
  }
  assert.deepEqual(await readFile(join(dist, "adapters", "shared.js")), await readFile(join(pluginDist, "adapters", "shared.js")));
  assert.deepEqual(await readFile(join(dist, "adapters", "direct.js")), await readFile(join(pluginDist, "adapters", "direct.js")));
  assert.deepEqual(await readFile(join(dist, "adapters", "copilot.js")), await readFile(join(pluginDist, "adapters", "copilot.js")));
  assert.deepEqual(await readFile(join(dist, "adapters", "copilot-mcp.js")), await readFile(join(pluginDist, "adapters", "copilot-mcp.js")));
  assert.deepEqual(await readFile(join(dist, "adapters", "copilot-coordinator.js")), await readFile(join(pluginDist, "adapters", "copilot-coordinator.js")));
  const cartographerDist = join(plugins, "repo-cartographer", "runtime", "dist");
  for (const name of (await readdir(join(dist, "core"))).filter((entry) => entry.endsWith(".js"))) {
    assert.deepEqual(await readFile(join(dist, "core", name)), await readFile(join(cartographerDist, "core", name)), `repo-cartographer/${name}`);
  }
  for (const name of ["shared.js", "copilot.js", "copilot-mcp.js"]) {
    assert.deepEqual(await readFile(join(dist, "adapters", name)), await readFile(join(cartographerDist, "adapters", name)), `repo-cartographer/${name}`);
  }
});

test("generated native runtime retains gh timeout and MCP cancellation guards", async () => {
  const github = await readFile(join(dist, "core", "github.js"), "utf8");
  const mcp = await readFile(join(dist, "adapters", "copilot-mcp.js"), "utf8");
  assert.match(github, /timeoutMs = 20_000/);
  assert.match(github, /timeout:\s*timeoutMs/);
  assert.match(mcp, /notifications\/cancelled/);
  assert.match(mcp, /activeRequests\.get\(requestId\)\?\.abort\(\)/);
});

test("every distribution has a direct zero-model bench entrypoint", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "harbor-direct-cli-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const launch = { command: process.execPath, prefix: [join(dist, "cli.js")] };
  for (const harness of ["copilot", "opencode", "pi"]) {
    const env = {
      ...process.env,
      COPILOT_HOME: join(sandbox, harness, "copilot-home"),
      OPENCODE_CONFIG_DIR: join(sandbox, harness, "opencode-home"),
      PI_CODING_AGENT_DIR: join(sandbox, harness, "pi-home"),
    };
    const bench = await run(launch, [harness, "bench", "list"], { cwd: sandbox, env, timeout: 30_000 });
    succeeded(bench);
    assert.match(bench.stdout, /portfolio-management \| bundled \| bench/, harness);
  }
});

test("Copilot native control performs deterministic shared contract preflight", async () => {
  const input = JSON.stringify({ name: "worker", description: "Worker", prompt: "Review only", tools: ["read", "search"], task: "Review this change" });
  const payload = JSON.parse(await runCopilotControl("contract", input, root));
  assert.deepEqual(Object.keys(payload), ["agent_type", "description", "prompt"]);
  assert.equal(payload.agent_type, "explore");
  assert.match(payload.prompt, /Requested tool policy: read, search/);
  assert.match(payload.prompt, /Task:\nReview this change/);

  await assert.rejects(() => runCopilotControl("contract", JSON.stringify({ ...JSON.parse(input), replace: true }), root), /does not accept replace/);
});

test("compiled Copilot MCP servers are bounded and scope every player skill group to its own process", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "harbor-copilot-mcp-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const project = join(sandbox, "project"); const home = join(sandbox, "copilot-home");
  await mkdir(project);
  const negotiationInput = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2099-01-01", capabilities: {}, clientInfo: { name: "test", version: "1" } } },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 3, method: "tools/list", params: {} },
  ].map((message) => JSON.stringify(message)).join("\n") + "\n";
  const negotiation = await run({ command: process.execPath, prefix: [] }, [join(dist, "adapters", "copilot-mcp.js")], {
    cwd: project, input: negotiationInput, timeout: 10_000,
  });
  succeeded(negotiation);
  const negotiated = new Map(negotiation.stdout.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)).map((message) => [message.id, message]));
  assert.equal(negotiated.get(1).result.protocolVersion, "2025-11-25");
  assert.equal(negotiated.get(2).error.code, -32002);
  assert.deepEqual(negotiated.get(3).result.tools.map((tool: any) => tool.name), ["control"]);

  const input = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "control", arguments: { command: "destroy", args: "{}" } } },
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "skill", arguments: { reference: "{}" } } },
  ].map((message) => JSON.stringify(message)).join("\n") + "\n";
  const result = await run({ command: process.execPath, prefix: [] }, [join(dist, "adapters", "copilot-mcp.js")], {
    cwd: project,
    env: { ...process.env, COPILOT_HOME: home, PATH: join(sandbox, "no-executables") },
    input,
    timeout: 10_000,
  });
  succeeded(result);
  assert.equal(result.stderr, "");
  const responses = new Map(result.stdout.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)).map((message) => [message.id, message]));
  assert.equal(responses.get(1).result.serverInfo.name, "agent-harbor");
  assert.equal(responses.get(1).result.protocolVersion, "2025-06-18");
  assert.deepEqual(responses.get(2).result.tools.map((tool: any) => tool.name), ["control"]);
  assert.equal(responses.get(3).result.isError, true);
  assert.match(responses.get(3).result.content[0].text, /invalid Agent Harbor control input/);
  assert.equal(responses.get(4).result.isError, true);
  assert.match(responses.get(4).result.content[0].text, /unknown Agent Harbor tool: skill/);
  assert.deepEqual(await readdir(project), []);
  await assert.rejects(() => access(home), /ENOENT/);

  const crafterScoped = await run({ command: process.execPath, prefix: [] }, [
    join(plugins, "repo-cartographer", "runtime", "dist", "adapters", "copilot-mcp.js"),
    "--skills-player", "crafter",
  ], {
    cwd: project,
    input: [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    ].map((message) => JSON.stringify(message)).join("\n") + "\n",
    timeout: 10_000,
  });
  succeeded(crafterScoped);
  const crafterResponses = new Map(crafterScoped.stdout.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)).map((message) => [message.id, message]));
  assert.deepEqual(crafterResponses.get(2).result.tools.map((tool: any) => tool.name), ["skills"]);

  await Promise.all([
    mkdir(join(project, "skills", "mcp-fixture"), { recursive: true }),
    mkdir(join(project, "skills", "decoy"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(project, "skills", "mcp-fixture", "SKILL.md"), "---\nname: mcp-fixture\n---\nUse the nominal fixture only.\n", "utf8"),
    writeFile(join(project, "skills", "decoy", "SKILL.md"), "---\nname: decoy\n---\nNever load this decoy.\n", "utf8"),
  ]);
  const player = JSON.stringify({
    name: "mcp-worker",
    description: "MCP worker",
    prompt: "Read only",
    tools: ["read"],
    skills: [{ kind: "repo", name: "mcp-fixture", path: "skills/mcp-fixture/SKILL.md" }],
  });
  const joinInput = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "control", arguments: { command: "join", args: player } } },
  ].map((message) => JSON.stringify(message)).join("\n") + "\n";
  const joined = await run({ command: process.execPath, prefix: [] }, [join(dist, "adapters", "copilot-mcp.js")], {
    cwd: project,
    env: { ...process.env, COPILOT_HOME: home, PATH: join(sandbox, "no-executables") },
    input: joinInput,
    timeout: 10_000,
  });
  succeeded(joined);
  const joinResponses = new Map(joined.stdout.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)).map((message) => [message.id, message]));
  assert.equal(joinResponses.get(2).result.isError, false);
  assert.match(joinResponses.get(2).result.content[0].text, /joined mcp-worker/);
  const registration = await readFile(join(home, "agent-foundry", "bench", "mcp-worker.agent.md"), "utf8");
  const active = await readFile(join(project, ".github", "agents", "mcp-worker.agent.md"), "utf8");
  assert.match(registration, /agent-foundry:profile id=mcp-worker revision=4/);
  assert.match(registration, /"agent-harbor-skills-mcp-worker\/skills"/);
  assert.match(registration, /"--skills-player","mcp-worker"/);
  assert.match(registration, /mcp-servers:\n  "agent-harbor-skills-mcp-worker":/);
  assert.doesNotMatch(registration, /"agent-harbor\/skill"/);
  assert.equal(active, registration);

  const scopedInput = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "skills", arguments: {} } },
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "skills_crafter", arguments: {} } },
  ].map((message) => JSON.stringify(message)).join("\n") + "\n";
  const scoped = await run({ command: process.execPath, prefix: [] }, [join(dist, "adapters", "copilot-mcp.js"), "--skills-player", "mcp-worker"], {
    cwd: project,
    env: { ...process.env, COPILOT_HOME: home, PATH: join(sandbox, "no-executables") },
    input: scopedInput,
    timeout: 10_000,
  });
  succeeded(scoped);
  const scopedResponses = new Map(scoped.stdout.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)).map((message) => [message.id, message]));
  assert.deepEqual(scopedResponses.get(2).result.tools.map((tool: any) => tool.name), ["skills"]);
  assert.equal(scopedResponses.get(3).result.isError, false);
  assert.match(scopedResponses.get(3).result.content[0].text, /^HARBOR-SKILL mcp-fixture\b/m);
  assert.match(scopedResponses.get(3).result.content[0].text, /Use the nominal fixture only/);
  assert.doesNotMatch(scopedResponses.get(3).result.content[0].text, /decoy/i);
  assert.equal(scopedResponses.get(4).result.isError, true);
  assert.match(scopedResponses.get(4).result.content[0].text, /unknown Agent Harbor tool: skills_crafter/);
});

test("installed CLIs discover the native packages", { concurrency: true }, async (t) => {
  const [copilot, opencode, pi] = await Promise.all([executable("copilot"), executable("opencode"), executable("pi")]);

  await Promise.all([
    t.test("Copilot", { skip: copilot ? false : "Copilot CLI is not installed" }, async () => {
      const result = await run(copilot!, [
        "--plugin-dir", join(plugins, "agent-foundry"),
        "--plugin-dir", join(plugins, "repo-cartographer"),
        "plugin", "list",
      ], { cwd: root, timeout: 30_000 });
      succeeded(result);
      assert.match(result.stdout, /agent-foundry/);
      assert.match(result.stdout, /repo-cartographer/);

      const sandbox = await mkdtemp(join(tmpdir(), "harbor-copilot-acp-"));
      try {
        const inspection = await inspectCopilotEnvironment(copilot!, sandbox);
        assert.match(inspection.transcript, /agent-harbor\s+\(connected,\s*plugin\)/i);
        const project = join(sandbox, "project");
        await mkdir(join(project, "skills", "native"), { recursive: true });
        await writeFile(join(project, "skills", "native", "SKILL.md"), "---\nname: native\n---\nScoped Copilot guidance.\n", "utf8");
        const joined = await run({ command: process.execPath, prefix: [join(dist, "cli.js")] }, [
          "copilot", "join", JSON.stringify({
            name: "native-worker", description: "Native worker", prompt: "Work", tools: ["read"],
            skills: [{ kind: "repo", name: "native", path: "skills/native/SKILL.md" }],
          }),
        ], { cwd: project, env: { ...process.env, COPILOT_HOME: join(sandbox, "copilot-home") }, timeout: 30_000 });
        succeeded(joined);
        const pluginActive = await import(pathToFileURL(join(plugins, "agent-foundry", "runtime", "dist", "core", "active.js")).href);
        assert.ok(pluginActive.listManagedActiveIds("copilot", project).includes("native-worker"),
          "byte-identical packaged runtimes must recognize one another's scoped profile");
        const direct = await inspectCopilotDirectExtension(copilot!, sandbox, project);
        assert.ok(direct.commands.some((command) => command.name === "bench" && command.kind === "client"));
        assert.ok([...rolePlayers.keys(), ...bundledPlayers.keys()].every((id) =>
          direct.agents.some((agent) => agent.name === id || agent.id === id || agent.id.endsWith(`:${id}`))));
        const crafter = direct.agents.find((agent) => agent.id === "repo-cartographer:crafter");
        assert.deepEqual(crafter?.mcpServers?.["repo-cartographer-crafter-skills"]?.tools, ["skills"]);
        const nativeWorker = direct.agents.find((agent) => agent.name === "native-worker" || agent.id === "native-worker");
        assert.ok(nativeWorker, `Copilot must parse the player-scoped MCP profile: ${JSON.stringify(direct.agents)}`);
        assert.ok(nativeWorker.mcpServers?.["agent-harbor-skills-native-worker"]);
      } finally {
        await rm(sandbox, { recursive: true, force: true });
      }
    }),
    t.test("OpenCode", { skip: opencode ? false : "OpenCode CLI is not installed" }, async (child) => {
      const directory = await mkdtemp(join(tmpdir(), "harbor-opencode-native-"));
      child.after(() => rm(directory, { recursive: true, force: true }));
      succeeded(await run(opencode!, ["plugin", `file:${root}`], { cwd: directory, timeout: 60_000 }));
      const openCodePluginConfig = await readFile(join(directory, ".opencode", "opencode.json"), "utf8");
      const openCodeTuiConfig = await readFile(join(directory, ".opencode", "tui.json"), "utf8");
      assert.match(openCodePluginConfig, /marketplace/i);
      assert.match(openCodeTuiConfig, /marketplace/i);
      const tuiSpecs = JSON.parse(openCodeTuiConfig).plugin;
      assert.equal(tuiSpecs.length, 1);
      const installedRoot = fileURLToPath(new URL(tuiSpecs[0]));
      assert.equal(resolve(installedRoot), resolve(root));
      const installedManifest = JSON.parse(await readFile(join(installedRoot, "package.json"), "utf8"));
      const installedTui = await import(pathToFileURL(join(installedRoot, installedManifest.exports["./tui"])).href);
      const layers: any[] = [];
      await installedTui.default.tui({ keymap: { registerLayer: (layer: unknown) => { layers.push(layer); return () => {}; } } } as any, undefined, {} as any);
      assert.deepEqual(layers[0].commands.map((command: any) => command.slashName), [
        "bench-list", "bench-on", "bench-off", "harbor-join", "harbor-retire", "harbor-list-skills", "harbor-filter-skills",
      ]);
      const config = await run(opencode!, ["debug", "config"], { cwd: directory, timeout: 60_000 });
      succeeded(config);
      const initial = JSON.parse(config.stdout);
      assert.ok([...commands].every((name) => name in initial.command));
      assert.ok([...rolePlayers.keys()].every((name) => name in initial.agent));
      assert.ok([...rolePlayers.keys()].every((name) => initial.command[`harbor-${name}`]?.agent === name));
      assert.equal(initial.agent["team-lead"].tools["*"], false);
      assert.equal(initial.agent["team-lead"].tools.harbor_delegate, true);
      assert.ok([...bundledPlayers.keys()].every((name) => !(name in initial.agent)), "bundled players must start on the bench");

      const directLaunch = { command: process.execPath, prefix: [join(dist, "cli.js")] };
      const directEnv = { ...process.env, OPENCODE_CONFIG_DIR: join(directory, "opencode-home") };
      succeeded(await run(directLaunch, ["opencode", "bench", "on", "all"], { cwd: directory, env: directEnv, timeout: 30_000 }));
      const activatedConfig = await run(opencode!, ["debug", "config"], { cwd: directory, timeout: 60_000 });
      succeeded(activatedConfig);
      const discovered = JSON.parse(activatedConfig.stdout);
      for (const id of [...rolePlayers.keys(), ...bundledPlayers.keys()]) {
        assert.ok(id in discovered.agent, `OpenCode must discover ${id}`);
        assert.deepEqual(discovered.command[`harbor-${id}`], {
          template: "$ARGUMENTS",
          description: `Run Agent Harbor player ${id} in the current session`,
          agent: id,
          subtask: false,
        });
      }
      assert.equal(discovered.agent["portfolio-management"].tools.harbor_delegate, false);
      assert.equal(discovered.agent["portfolio-management"].tools["*"], false);
    }),
    t.test("Pi", { skip: pi ? false : "Pi CLI is not installed" }, async (child) => {
      const directory = await mkdtemp(join(tmpdir(), "harbor-pi-native-"));
      child.after(() => rm(directory, { recursive: true, force: true }));
      const env = { ...process.env, PI_CODING_AGENT_DIR: join(directory, "pi-home") };
      if (pi!.prefix[0]?.endsWith(".js")) {
        const sdk = await import(pathToFileURL(join(dirname(pi!.prefix[0]), "index.js")).href);
        assert.equal(typeof sdk.createAgentSession, "function");
        assert.equal(typeof sdk.SessionManager?.inMemory, "function");
        assert.equal(typeof sdk.DefaultResourceLoader, "function");
        const resourceLoader = new sdk.DefaultResourceLoader({
          cwd: directory,
          agentDir: join(directory, "sdk-home"),
          noExtensions: true,
        });
        await resourceLoader.reload();
        const delegateProbe = {
          name: "harbor_delegate_probe",
          label: "Harbor delegate probe",
          description: "Native registration probe only",
          executionMode: "sequential",
          parameters: { type: "object", properties: {}, additionalProperties: false },
          execute: async () => ({ content: [{ type: "text", text: "unused" }] }),
        };
        const { session, extensionsResult } = await sdk.createAgentSession({
          cwd: directory,
          agentDir: join(directory, "sdk-home"),
          sessionManager: sdk.SessionManager.inMemory(directory),
          tools: ["read", delegateProbe.name],
          customTools: [delegateProbe],
          resourceLoader,
        });
        assert.deepEqual(extensionsResult.extensions, []);
        assert.ok(session.getActiveToolNames().includes(delegateProbe.name));
        assert.ok(session.getAllTools().some((candidate: any) => candidate.name === delegateProbe.name));
        session.dispose();
      }
      succeeded(await run(pi!, ["install", root], { cwd: directory, env, timeout: 90_000 }));
      const listed = await run(pi!, ["list"], { cwd: directory, env, timeout: 30_000 });
      succeeded(listed);
      assert.ok(listed.stdout.toLowerCase().includes(root.toLowerCase()));
      const initialRpc = await run(pi!, ["--no-session", "-e", join(dist, "adapters", "pi.js"), "--mode", "rpc"], {
        cwd: directory, env, timeout: 60_000, input: '{"type":"get_commands"}\n',
      });
      succeeded(initialRpc);
      const initialResponse = initialRpc.stdout.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
        .find((item) => item.type === "response" && item.command === "get_commands");
      assert.ok(initialResponse?.success);
      const initialNames = new Set<string>(initialResponse.data.commands.map((command: any) => command.name));
      assert.ok([...commands, ...rolePlayers.keys()].every((name) => initialNames.has(name)));
      assert.ok([...bundledPlayers.keys()].every((name) => !initialNames.has(name)), "bundled Pi players must start on the bench");

      const bench = await run(pi!, ["--no-session", "-e", join(dist, "adapters", "pi.js"), "-p", "/bench on all"], { cwd: directory, env, timeout: 60_000 });
      succeeded(bench);
      const rpc = await run(pi!, ["--no-session", "-e", join(dist, "adapters", "pi.js"), "--mode", "rpc"], {
        cwd: directory, env, timeout: 60_000, input: '{"type":"get_commands"}\n',
      });
      succeeded(rpc);
      const response = rpc.stdout.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
        .find((item) => item.type === "response" && item.command === "get_commands");
      assert.ok(response?.success);
      const names = new Set<string>(response.data.commands.map((command: any) => command.name));
      assert.ok([...commands, ...rolePlayers.keys(), ...bundledPlayers.keys()].every((name) => names.has(name)));
    }),
  ]);
});
