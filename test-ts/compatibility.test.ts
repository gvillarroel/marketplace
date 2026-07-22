import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CopilotClient, RuntimeConnection, approveAll } from "@github/copilot-sdk";
import { harborCustomToolNames, harborPlayerSkillToolName } from "../src/core/custom-tools.js";
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
interface RpcResult extends Result { events: any[] }

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

async function runInteractiveRpc(
  launch: Launch,
  args: string[],
  options: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
    timeout?: number;
    requests: readonly Record<string, unknown>[];
    done(events: readonly any[]): boolean;
  },
): Promise<RpcResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(launch.command, [...launch.prefix, ...args], {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = ""; let stderr = ""; let pending = ""; let timedOut = false; let ending = false;
    const events: any[] = [];
    let requestIndex = 0;
    const sendNext = () => {
      if (requestIndex >= options.requests.length) return;
      if (requestIndex > 0) {
        const priorId = options.requests[requestIndex - 1].id;
        if (!events.some((item) => item.type === "response" && item.id === priorId)) return;
      }
      child.stdin.write(`${JSON.stringify(options.requests[requestIndex])}\n`);
      requestIndex += 1;
    };
    const maybeEnd = () => {
      if (!ending && options.done(events)) { ending = true; child.stdin.end(); }
    };
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
      pending += chunk;
      const lines = pending.split(/\r?\n/u);
      pending = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try { events.push(JSON.parse(line)); } catch { /* Caller will fail on missing expected events. */ }
      }
      sendNext();
      maybeEnd();
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.stdin.on("error", () => { /* Ignore EPIPE after a completed RPC scenario. */ });
    child.on("error", reject);
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, options.timeout ?? 60_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut, events });
    });
    sendNext();
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
      ],
    }),
    workingDirectory,
    baseDirectory: join(sandbox, "sdk-home"),
    logLevel: "error",
    env: { ...process.env, COPILOT_PLUGIN_DIR_ONLY: "true", NO_COLOR: "1" },
  });
  let session: Awaited<ReturnType<CopilotClient["createSession"]>> | undefined;
  const events: string[] = [];
  const extensionMessages: string[] = [];
  const usage = { calls: 0, input: 0, output: 0, reasoning: 0 };
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
    session.on((event) => {
      events.push(event.type);
      if (typeof event.data?.message === "string") extensionMessages.push(event.data.message);
      if (event.type !== "assistant.usage") return;
      usage.calls += 1;
      usage.input += event.data.inputTokens ?? 0;
      usage.output += event.data.outputTokens ?? 0;
      usage.reasoning += event.data.reasoningTokens ?? 0;
    });
    let listed = await session.rpc.commands.list();
    let direct = listed.commands.find((command) => command.name === "bench" && command.kind === "client");
    for (let attempt = 0; !direct && attempt < 30; attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      listed = await session.rpc.commands.list();
      direct = listed.commands.find((command) => command.name === "bench" && command.kind === "client");
    }
    assert.ok(direct, `Copilot must discover the direct /bench extension command: ${JSON.stringify(listed.commands)}`);
    const expectedCommands = [...rolePlayers.keys(), ...bundledPlayers.keys()];
    assert.ok(expectedCommands.every((name) => listed.commands.some((command) => command.name === name && command.kind === "client")));
    assert.ok(listed.commands.some((command) => command.name === "scout" && command.kind === "client"));
    assert.ok(listed.commands.some((command) => command.name === "team" && command.kind === "client"));
    assert.ok(listed.commands.some((command) => command.name === "player" && command.kind === "client"));

    const beforeTeam = { ...usage };
    const beforeMetrics = await session.rpc.usage.getMetrics();
    const firstTeamMessage = extensionMessages.length;
    const team = await session.rpc.commands.invoke({ name: "team", input: "" });
    assert.equal(team.kind, "completed");
    const firstTeamOutput = extensionMessages.slice(firstTeamMessage).findLast((message) => message.includes("Agent Harbor Copilot team"));
    assert.ok(firstTeamOutput, "first /team emitted no enriched view");
    assert.match(firstTeamOutput, /Team: 3 ready · 0 active · 6 benched · 0 unhealthy/u);
    assert.doesNotMatch(firstTeamOutput, /discovery\/coordinator is not ready|reload the Copilot session/u);

    const teamDesignMessage = extensionMessages.length;
    assert.equal((await session.rpc.commands.invoke({ name: "team", input: "design" })).kind, "completed");
    const teamDesignOutput = extensionMessages.slice(teamDesignMessage).findLast((message) => message.includes("Agent Harbor Copilot team"));
    assert.match(teamDesignOutput ?? "", /design · bundled · bench/u);

    const benchDesignMessage = extensionMessages.length;
    assert.equal((await session.rpc.commands.invoke({ name: "bench", input: "list design" })).kind, "completed");
    const benchDesignOutput = extensionMessages.slice(benchDesignMessage).findLast((message) => message.includes("Agent Harbor Copilot bench"));
    assert.match(benchDesignOutput ?? "", /design · bundled · bench/u);
    assert.match(benchDesignOutput ?? "", /Capacity:/u);
    assert.doesNotMatch(benchDesignOutput ?? "", /^design \| bundled \| bench$/mu);
    assert.ok((benchDesignOutput ?? "").split("\n").every((line) => line.length <= 96));

    const personalId = "sdk-ux-reviewer";
    const definition = JSON.stringify({
      name: personalId,
      description: "Review user-facing behavior",
      prompt: "Review safely",
      tools: ["read", "search"],
    });
    const joinMessage = extensionMessages.length;
    assert.equal((await session.rpc.commands.invoke({ name: "join", input: definition })).kind, "completed");
    const joinOutput = extensionMessages.slice(joinMessage).findLast((message) => message.includes("Agent Harbor /join"));
    assert.match(joinOutput ?? "", /joined · personal · registered/u);
    assert.match(joinOutput ?? "", new RegExp(`Availability: verify with /team member:${personalId}`, "u"));
    assert.match(joinOutput ?? "", new RegExp(`When ready: /player ${personalId} <task>`, "u"));
    assert.match(joinOutput ?? "", new RegExp(`After restarting Copilot: /${personalId} <task>`, "u"));
    assert.doesNotMatch(joinOutput ?? "", /registration:|active:/u);
    assert.equal((joinOutput ?? "").includes(sandbox), false);
    assert.equal((joinOutput ?? "").includes(workingDirectory), false);
    assert.equal((await session.rpc.commands.invoke({ name: "retire", input: personalId })).kind, "completed");
    await assert.rejects(
      () => session!.rpc.commands.invoke({ name: "player", input: `${personalId} inspect again` }),
      /missing or retired.*re-run \/join.*inspect \/team sdk-ux-reviewer/is,
    );
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 50));
    assert.deepEqual(usage, beforeTeam, "/team must not create or consume a model call");
    assert.deepEqual(await session.rpc.usage.getMetrics(), beforeMetrics, "/team must leave native usage metrics unchanged");
    await assert.rejects(() => session!.rpc.commands.invoke({ name: "player", input: "" }), /usage: \/player <id> <task>/i);
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 50));
    assert.deepEqual(usage, beforeTeam, "invalid /player preflight must not create or consume a model call");
    assert.deepEqual(await session.rpc.usage.getMetrics(), beforeMetrics, "invalid /player must leave native usage metrics unchanged");

    const initial = await session.rpc.agent.list();
    for (const id of rolePlayers.keys()) assert.ok(initial.agents.some((agent) => agent.name === id || agent.id.endsWith(`:${id}`)), id);
    assert.ok(initial.agents.some((agent) => agent.id === "agent-foundry:talent-scout"), "talent-scout");
    for (const id of bundledPlayers.keys()) assert.ok(!initial.agents.some((agent) => agent.name === id || agent.id === id), `${id} must start on the bench`);
    await assert.rejects(
      () => session!.rpc.commands.invoke({ name: "portfolio-management", input: "must not reach a model" }),
      /benched|not active/i,
    );

    const invoked = await session.rpc.commands.invoke({ name: "bench", input: "on all" });
    assert.equal(invoked.kind, "completed");
    await assert.rejects(() => session!.rpc.commands.invoke({ name: "bench", input: "toggle" }), /usage: \/?bench/);
    const refreshed = await session.rpc.agent.reload();
    for (const id of [...rolePlayers.keys(), ...bundledPlayers.keys()]) {
      const expectedFixed = {
        "team-lead": "agent-foundry:team-lead",
        crafter: "agent-foundry:crafter",
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
  assert.ok(manifest.files.includes("docs/"));
  assert.deepEqual(manifest.pi.extensions, ["./dist/adapters/pi.js"]);
  assert.ok(!("prompts" in manifest.pi));
  assert.equal(manifest.engines.node, ">=22.19.0");
  assert.equal(manifest.dependencies["@github/copilot-sdk"], "1.0.6");
  assert.equal(manifest.dependencies["@opencode-ai/plugin"], "1.18.3");
  assert.equal(
    manifest.peerDependencies["@earendil-works/pi-coding-agent"],
    "0.80.10 || 0.81.1",
  );
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
    access(join(plugins, "agent-foundry", "agents", "crafter.agent.md")),
  ]);
  for (const [path, name] of [
    [join(plugins, "agent-foundry", "agents", "team-lead.agent.md"), "team-lead"],
    [join(plugins, "agent-foundry", "agents", "crafter.agent.md"), "crafter"],
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

test("Copilot plugins expose canonical commands and extension-owned custom tools without MCP", async () => {
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
    if (directory.endsWith(join("plugins", "agent-foundry"))) assert.deepEqual(localSkills, new Set(["contract"]));
  }
  assert.deepEqual(skillNames, new Set(["contract"]));
  assert.deepEqual(new Set(manifests.map((manifest) => manifest.name)), new Set(["agent-foundry"]));
  const marketplace = JSON.parse(await readFile(join(root, ".github", "plugin", "marketplace.json"), "utf8"));
  const marketplaceVersions = new Map<string, string>(marketplace.plugins.map((plugin: any) => [plugin.name, plugin.version]));
  for (const manifest of manifests) assert.equal(marketplaceVersions.get(manifest.name), manifest.version);
  assert.equal(marketplace.metadata.version, "0.12.1");
  assert.equal(
    await readFile(join(plugins, "agent-foundry", "LICENSE"), "utf8"),
    await readFile(join(root, "LICENSE"), "utf8"),
  );
  await Promise.all([
    access(join(plugins, "agent-foundry", "runtime", "dist", "adapters", "copilot.js")),
    access(join(plugins, "agent-foundry", "runtime", "dist", "adapters", "copilot-coordinator.js")),
    access(join(plugins, "agent-foundry", "runtime", "dist", "adapters", "copilot-team-runtime.js")),
    access(join(plugins, "agent-foundry", "runtime", "dist", "adapters", "copilot-team-view.js")),
  ]);
  const contract = await readFile(join(plugins, "agent-foundry", "skills", "contract", "SKILL.md"), "utf8");
  assert.match(contract, /^allowed-tools: \["harbor_contract"\]$/mu);
  assert.match(contract, /extension tool `harbor_contract` exactly once/);
  assert.match(contract, /Call `task` exactly once/);
  for (const name of deterministicCommandNames) {
    await assert.rejects(() => access(join(plugins, "agent-foundry", "skills", name, "SKILL.md")), /ENOENT/);
  }
  const foundryManifest = JSON.parse(await readFile(join(plugins, "agent-foundry", "plugin.json"), "utf8"));
  assert.equal(Object.hasOwn(foundryManifest, "mcpServers"), false);
  assert.deepEqual(foundryManifest.extensions, { paths: ["extensions/agent-harbor"], exclusive: false });
  await assert.rejects(() => access(join(plugins, "agent-foundry", ".mcp.json")), /ENOENT/);
  const extension = await readFile(join(plugins, "agent-foundry", "extensions", "agent-harbor", "extension.mjs"), "utf8");
  assert.match(extension, /joinSession/);
  assert.match(extension, /runDeterministicCommand/);
  assert.match(extension, /name === "list-skills"/);
  assert.match(extension, /\? "copilot" : "plain"/);
  assert.match(extension, /Agent Harbor · skill catalog · 0 model tokens/);
  assert.match(extension, /createCopilotCoordinatorGuard/);
  assert.match(extension, /\.\.\.coordinator\.hooks/);
  assert.match(extension, /coordinator\.observeEvent/);
  assert.match(extension, /event\.phase !== "target\.resolved"/);
  assert.match(extension, /type: "agent-harbor-guard"/);
  assert.match(extension, /ephemeral: true/);
  assert.match(extension, /boundedHostCall\("Copilot coordinator (?:refresh|startup refresh)", \(\) => coordinator\.refreshAuthoritative\(\)\)/);
  for (const name of deterministicCommandNames) assert.match(extension, new RegExp(`\\["${name}"`));
  assert.equal(extension.match(/session\.send\(/g)?.length, 1, "only explicit player commands may send one prompt");
  assert.doesNotMatch(extension, /sendAndWait/);
  assert.match(extension, /name: "team"/);
  assert.match(extension, /name: "player"/);
  assert.match(extension, /CopilotTeamRuntime/);
  assert.match(extension, /formatCopilotTeamView/);
  assert.match(extension, /agent\.select/);
  assert.match(extension, /name: agent\.id/);
  assert.doesNotMatch(extension, /createSession|\.prompt\(/);
  const controlsBlock = extension.match(/const controls = \[([\s\S]*?)\n\];/u)?.[1] ?? "";
  assert.doesNotMatch(controlsBlock, /\["contract"/u,
    "contract must remain a user-invoked skill backed by a native custom tool, not a deterministic command alias");
  assert.match(extension, /runCopilotControl\("contract", call\.definition/u);
  assert.match(extension, /catch \(error\)[\s\S]*throw error;/);
  const crafter = await readFile(join(plugins, "agent-foundry", "agents", "crafter.agent.md"), "utf8");
  assert.match(crafter, /^tools: \["read", "search", "edit", "execute", "harbor_skill_crafter"\]$/mu);
  assert.match(crafter, /extension tool `harbor_skill_crafter` exactly once/);
  assert.doesNotMatch(crafter, /mcp|server|--skills-player/iu);
  const scout = await readFile(join(plugins, "agent-foundry", "agents", "talent-scout.agent.md"), "utf8");
  assert.match(scout, /"harbor_filter_skills"/);
  assert.match(scout, /"harbor_join_player"/);
  assert.match(scout, /"harbor_team_roster"/);
  assert.match(scout, /^tools: \["harbor_team_roster", "harbor_filter_skills", "harbor_join_player"\]$/mu);
  assert.doesNotMatch(scout, /^tools: .*\b(?:read|search|edit|execute|task)\b/mu);
  assert.doesNotMatch(scout, /mcp|server|--scout/iu);
});

test("Copilot runtimes contain exact physical byte copies of their shared build inputs", async () => {
  const coreFiles = (await readdir(join(dist, "core"))).filter((name) => name.endsWith(".js")).sort();
  const bundledFiles = ["build.md", "consume.md", "design.md", "dispose.md", "manage.md", "portfolio-management.md"];
  const roleFiles = ["crafter.md", "team-lead.md"];
  const runtimes = [{
    name: "agent-foundry",
    adapters: [
      "copilot-coordinator.js",
      "copilot-team-runtime.js",
      "copilot-team-view.js",
      "copilot.js",
      "direct.js",
      "opencode-agent-activity.js",
      "shared.js",
    ],
  }] as const;

  for (const runtime of runtimes) {
    const runtimeDist = join(plugins, runtime.name, "runtime", "dist");
    const coreRoot = join(runtimeDist, "core");
    const adapterRoot = join(runtimeDist, "adapters");
    assert.deepEqual((await readdir(runtimeDist)).sort(), ["adapters", "core"]);
    assert.deepEqual((await readdir(coreRoot)).sort(), [...coreFiles, "bundled", "roles"].sort(), `${runtime.name} must contain generated core JavaScript and player Markdown`);
    assert.deepEqual((await readdir(join(coreRoot, "bundled"))).sort(), bundledFiles);
    assert.deepEqual((await readdir(join(coreRoot, "roles"))).sort(), roleFiles);
    assert.deepEqual((await readdir(adapterRoot)).sort(), [...runtime.adapters].sort(), `${runtime.name} adapter inventory`);

    for (const directory of [runtimeDist, coreRoot, adapterRoot, join(coreRoot, "bundled"), join(coreRoot, "roles")]) {
      const stat = await lstat(directory);
      assert.ok(stat.isDirectory(), `${directory} must be a directory`);
      assert.equal(stat.isSymbolicLink(), false, `${directory} must be a physical directory`);
    }
    for (const [directory, source, names] of [
      [coreRoot, join(dist, "core"), coreFiles],
      [join(coreRoot, "bundled"), join(dist, "core", "bundled"), bundledFiles],
      [join(coreRoot, "roles"), join(dist, "core", "roles"), roleFiles],
      [adapterRoot, join(dist, "adapters"), runtime.adapters],
    ] as const) {
      for (const name of names) {
        const target = join(directory, name);
        const stat = await lstat(target);
        assert.ok(stat.isFile(), `${target} must be a regular file`);
        assert.equal(stat.isSymbolicLink(), false, `${target} must be a physical copy`);
        assert.deepEqual(await readFile(target), await readFile(join(source, name)), `${runtime.name}/${name}`);
      }
    }
  }

  for (const [directory, names] of [["bundled", bundledFiles], ["roles", roleFiles]] as const) {
    for (const name of names) {
      assert.deepEqual(
        await readFile(join(dist, "core", directory, name)),
        await readFile(join(root, "src", "core", directory, name)),
        `dist/core/${directory}/${name}`,
      );
    }
  }
});

test("active profile discovery validates the same bytes read once for each candidate", async () => {
  const source = await readFile(join(root, "src", "core", "active.ts"), "utf8");
  const section = (start: string, end: string): string => {
    const from = source.indexOf(start);
    const to = source.indexOf(end, from + start.length);
    assert.notEqual(from, -1, start);
    assert.notEqual(to, -1, end);
    return source.slice(from, to);
  };
  const validation = section("function validatedDefinition", "function scanActiveProfiles");
  const scan = section("function scanActiveProfiles", "export function listOwnedActiveIds");
  const managed = section("export function listManagedActiveIds", "export function listInvocablePlayerIds");
  const invocable = section("export function listInvocablePlayerIds", "export function loadManagedActivePlayer");

  assert.equal(scan.match(/\breadOwnedActiveProfile\(/g)?.length, 1, "the candidate loop has one profile read site");
  assert.match(
    scan,
    /for \(const entry of candidates\)[\s\S]*let content: string \| undefined;[\s\S]*content = readOwnedActiveProfile\(harness, projectRoot, id\);/,
  );
  assert.match(scan, /managedProfiles\.push\(\{ id, definition: validatedDefinition\(content, id, harness, projectRoot\) \}\)/);
  assert.match(validation, /decodePlayer\(content, id\)/);
  assert.match(validation, /isCanonicalPlayerProfile\(content, harness, definition,/);
  for (const projection of [managed, invocable]) {
    assert.equal(projection.match(/\bscanActiveProfiles\(/g)?.length, 1, "each projection performs one scan");
    assert.doesNotMatch(projection, /\breadOwnedActiveProfile\(|\breadFileSync\(|\bvalidatedDefinition\(/,
      "managed and invocable projections must not re-read or re-validate candidates");
  }
});

test("generated native runtime retains gh timeout and closed custom-tool contracts", async () => {
  const github = await readFile(join(dist, "core", "github.js"), "utf8");
  const customTools = await readFile(join(dist, "core", "custom-tools.js"), "utf8");
  assert.match(github, /timeoutMs = 20_000/);
  assert.match(github, /timeout:\s*timeoutMs/);
  assert.match(customTools, /harbor_contract/);
  assert.match(customTools, /additionalProperties: false/);
  assert.match(customTools, /harbor_skill_/);
  await assert.rejects(() => access(join(dist, "adapters", "copilot-mcp.js")), /ENOENT/);
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

test("portable CLI usage separates deterministic commands from Copilot-only contract", async () => {
  const launch = { command: process.execPath, prefix: [join(dist, "cli.js")] };
  const usage = await run(launch, [], { cwd: root, timeout: 30_000 });
  assert.equal(usage.code, 2);
  assert.match(usage.stderr,
    /agent-harbor <copilot\|opencode\|pi> <bench\|join\|retire\|list-skills> \[arguments\]/u);
  assert.match(usage.stderr, /agent-harbor copilot contract <json>/u);
  assert.doesNotMatch(usage.stderr,
    /<copilot\|opencode\|pi> <[^>]*contract/u);

  const inherited = await run(launch, ["opencode", "contract", "{}"], { cwd: root, timeout: 30_000 });
  assert.equal(inherited.code, 1);
  assert.match(inherited.stderr, /\/contract must run inside opencode/u);
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

test("compiled Copilot profiles bind custom skill tools without transport servers", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "harbor-copilot-custom-tools-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const project = join(sandbox, "project"); const home = join(sandbox, "copilot-home");
  await mkdir(join(project, "skills", "fixture"), { recursive: true });
  await writeFile(
    join(project, "skills", "fixture", "SKILL.md"),
    "---\nname: fixture\n---\nUse the nominal fixture only.\n",
    "utf8",
  );
  const player = JSON.stringify({
    name: "custom-worker",
    description: "Custom tool worker",
    prompt: "Read only",
    tools: ["read"],
    skills: [{ kind: "repo", name: "fixture", path: "skills/fixture/SKILL.md" }],
  });
  const joined = await run({ command: process.execPath, prefix: [join(dist, "cli.js")] }, ["copilot", "join", player], {
    cwd: project,
    env: { ...process.env, COPILOT_HOME: home },
    timeout: 30_000,
  });
  succeeded(joined);
  const registration = await readFile(join(home, "agent-foundry", "bench", "custom-worker.agent.md"), "utf8");
  const active = await readFile(join(project, ".github", "agents", "custom-worker.agent.md"), "utf8");
  assert.match(registration, /agent-foundry:profile id=custom-worker revision=5/);
  assert.match(registration, /"harbor_skill_custom-worker"/);
  assert.match(registration, /extension tool `harbor_skill_custom-worker` exactly once/);
  assert.doesNotMatch(registration, /mcp|server|--skills-player/iu);
  assert.equal(active, registration);
  assert.equal(harborPlayerSkillToolName("custom-worker"), "harbor_skill_custom-worker");
  assert.equal(harborCustomToolNames.contractPreflight, "harbor_contract");
});

test("installed CLIs discover the native packages", { concurrency: true }, async (t) => {
  const [copilot, opencode, pi] = await Promise.all([executable("copilot"), executable("opencode"), executable("pi")]);

  await Promise.all([
    t.test("Copilot", { skip: copilot ? false : "Copilot CLI is not installed" }, async () => {
      const result = await run(copilot!, [
        "--plugin-dir", join(plugins, "agent-foundry"),
        "plugin", "list",
      ], { cwd: root, timeout: 30_000 });
      succeeded(result);
      assert.match(result.stdout, /agent-foundry/);

      const sandbox = await mkdtemp(join(tmpdir(), "harbor-copilot-acp-"));
      try {
        const inspection = await inspectCopilotEnvironment(copilot!, sandbox);
        assert.match(inspection.transcript, /agent-foundry/iu);
        assert.match(inspection.transcript, /contract \(Plugin\)/u);
        assert.doesNotMatch(inspection.transcript, /agent-harbor\s+\(connected/iu,
          "Agent Harbor must not add an MCP server to the Copilot environment");
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
        assert.ok(direct.commands.some((command) => command.name === "native-worker" && command.kind === "client"),
          "a joined personal player must be registered as /native-worker");
        assert.ok([...rolePlayers.keys(), ...bundledPlayers.keys()].every((id) =>
          direct.agents.some((agent) => agent.name === id || agent.id === id || agent.id.endsWith(`:${id}`))));
        const crafter = direct.agents.find((agent) => agent.id === "agent-foundry:crafter");
        assert.ok(crafter?.tools?.includes("harbor_skill_crafter"));
        assert.equal(crafter?.mcpServers === undefined || Object.keys(crafter.mcpServers).length === 0, true);
        const nativeWorker = direct.agents.find((agent) => agent.name === "native-worker" || agent.id === "native-worker");
        assert.ok(nativeWorker, `Copilot must parse the player-bound custom-tool profile: ${JSON.stringify(direct.agents)}`);
        assert.ok(nativeWorker.tools?.includes("harbor_skill_native-worker"));
        assert.equal(nativeWorker.mcpServers === undefined || Object.keys(nativeWorker.mcpServers).length === 0, true);
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
        "team", "bench-list", "bench-on", "bench-off", "harbor-join", "harbor-retire", "contract", "harbor-list-skills", "harbor-filter-skills",
      ]);
      const config = await run(opencode!, ["debug", "config"], { cwd: directory, timeout: 60_000 });
      succeeded(config);
      const initial = JSON.parse(config.stdout);
      assert.ok([...commands].every((name) => !(name in initial.command)),
        "deterministic and contract controls belong to the native TUI layer, never a model-routed server command");
      assert.ok([...rolePlayers.keys()].every((name) => name in initial.agent));
      assert.ok([...rolePlayers.keys()].every((name) => initial.command[name]?.agent === name));
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
        assert.deepEqual(discovered.command[id], {
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
      const env = {
        ...process.env,
        PI_CODING_AGENT_DIR: join(directory, "pi-home"),
        AGENT_HARBOR_ACTIVITY_HOME: join(directory, "activity"),
        // This installed-runtime probe is deliberately model-free. Pi 0.81.1
        // otherwise starts a background catalog refresh in RPC mode, then calls
        // process.exit() on stdin EOF; Node on Windows can assert while the
        // refresh's fetch handle is closing (nodejs/node#56645). Offline mode is
        // Pi's supported switch for deterministic startup without that network
        // work, while preserving the same extension/RPC shutdown path.
        PI_OFFLINE: "1",
      };
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
          label: "Harbor delegate check",
          description: "Native registration check only",
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
      const initialRpc = await runInteractiveRpc(pi!, ["--no-session", "-e", join(dist, "adapters", "pi.js"), "--mode", "rpc"], {
        cwd: directory,
        env,
        timeout: 60_000,
        requests: [
          { id: "commands", type: "get_commands" },
          { id: "team", type: "prompt", message: "/team" },
        ],
        done: (events) => events.some((item) => item.id === "team" && item.type === "response")
          && events.some((item) => item.type === "extension_ui_request" && item.method === "notify"),
      });
      succeeded(initialRpc);
      const initialEvents = initialRpc.events;
      const initialResponse = initialEvents
        .find((item) => item.type === "response" && item.command === "get_commands");
      assert.ok(initialResponse?.success);
      const initialNames = new Set<string>(initialResponse.data.commands.map((command: any) => command.name));
      assert.ok([...commands, ...rolePlayers.keys()].every((name) => initialNames.has(name)));
      assert.ok(initialNames.has("team"));
      assert.ok([...bundledPlayers.keys()].every((name) => !initialNames.has(name)), "bundled Pi players must start on the bench");
      const teamNotice = initialEvents.find((item) => item.type === "extension_ui_request" && item.method === "notify");
      assert.equal(teamNotice?.notifyType, "info");
      assert.match(teamNotice?.message ?? "", /Agent Harbor team .*0 model tokens/u);
      assert.match(teamNotice?.message ?? "", /team-lead · manager · ready/u);
      assert.match(teamNotice?.message ?? "", /talent-scout \(\/scout\) · utility · ready/u);
      assert.ok(initialEvents.some((item) => item.id === "team" && item.type === "response" && item.success));

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

      const staleRpc = await runInteractiveRpc(pi!, ["--no-session", "-e", join(dist, "adapters", "pi.js"), "--mode", "rpc"], {
        cwd: directory,
        env,
        timeout: 60_000,
        requests: [
          { id: "off", type: "prompt", message: "/bench off design" },
          { id: "stale", type: "prompt", message: "/design must not reach a model" },
        ],
        done: (events) => events.some((item) => item.id === "stale" && item.type === "response"),
      });
      succeeded(staleRpc);
      assert.ok(staleRpc.events.some((item) => item.id === "off" && item.type === "response" && item.success));
      const staleResponse = staleRpc.events.find((item) => item.id === "stale" && item.type === "response");
      assert.equal(staleResponse?.success, true, "Pi reports handled extension commands as successful prompt responses");
      const staleNotice = staleRpc.events.find((item) => item.type === "extension_ui_request" && item.method === "notify" && item.notifyType === "error");
      assert.equal(staleNotice, undefined, "RPC duplicated its structured failure through notify");
      const staleError = staleRpc.events.find((item) => item.type === "extension_error" && item.event === "command");
      assert.match(JSON.stringify(staleError), /Preflight stopped · no model was called · 0 model tokens/u);
      assert.match(JSON.stringify(staleError), /Usage: \/design <task>.*Cost: 1 model child when active/su);
      assert.equal(staleRpc.events.filter((item) => item.type === "extension_error" && item.event === "command").length, 1);
      assert.equal(staleRpc.events.some((item) => item.type === "message_end" && item.message?.role === "assistant"), false);
    }),
  ]);
});
