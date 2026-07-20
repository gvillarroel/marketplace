import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, chmod, copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { trustedSkills } from "../src/core/defaults.js";
import { commandNames } from "../src/core/types.js";
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
    "--no-auto-update", "--no-color",
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

test("distribution declares native TypeScript entrypoints", async () => {
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  assert.equal(manifest.main, "./dist/adapters/opencode.js");
  assert.deepEqual(manifest.pi.extensions, ["./dist/adapters/pi.js"]);
  assert.ok(!("prompts" in manifest.pi));
  assert.equal(manifest.engines.node, ">=22.19.0");
  assert.equal(manifest.dependencies["@github/copilot-sdk"], "1.0.6");
  assert.equal(manifest.dependencies["@opencode-ai/plugin"], "1.17.13");
  assert.equal(manifest.peerDependencies["@earendil-works/pi-coding-agent"], "0.80.10");
  await Promise.all([
    access(join(dist, "adapters", "opencode.js")),
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
  assert.equal(marketplace.metadata.version, "0.11.0");
  await Promise.all([
    access(join(plugins, "agent-foundry", "runtime", "dist", "adapters", "copilot.js")),
    access(join(plugins, "agent-foundry", "runtime", "dist", "adapters", "copilot-mcp.js")),
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
  assert.ok(!("extensions" in foundryManifest));
  const mcpConfiguration = JSON.parse(await readFile(join(plugins, "agent-foundry", ".mcp.json"), "utf8"));
  assert.deepEqual(Object.keys(mcpConfiguration.mcpServers), ["agent-harbor"]);
  const harbor = mcpConfiguration.mcpServers["agent-harbor"];
  assert.equal(harbor.type, "stdio");
  assert.equal(harbor.command, "node");
  assert.deepEqual(harbor.tools, ["control", "skill"]);
  assert.equal(harbor.timeout, 45_000);
  assert.ok(harbor.args.some((argument: string) => argument.includes("copilot-mcp.js")));
  await assert.rejects(() => access(join(plugins, "agent-foundry", "extensions")), /ENOENT/);
  const crafter = await readFile(join(plugins, "repo-cartographer", "agents", "crafter.agent.md"), "utf8");
  assert.match(crafter, /"agent-harbor\/skill"/);
  assert.match(crafter, /`skill` tool from the `agent-harbor` MCP server/);
  assert.doesNotMatch(crafter, /agent_harbor_skill/);
});

test("Copilot runtime is generated byte-for-byte from shared core", async () => {
  const pluginDist = join(plugins, "agent-foundry", "runtime", "dist");
  for (const name of (await readdir(join(dist, "core"))).filter((entry) => entry.endsWith(".js"))) {
    assert.deepEqual(await readFile(join(dist, "core", name)), await readFile(join(pluginDist, "core", name)), name);
  }
  assert.deepEqual(await readFile(join(dist, "adapters", "shared.js")), await readFile(join(pluginDist, "adapters", "shared.js")));
  assert.deepEqual(await readFile(join(dist, "adapters", "copilot.js")), await readFile(join(pluginDist, "adapters", "copilot.js")));
  assert.deepEqual(await readFile(join(dist, "adapters", "copilot-mcp.js")), await readFile(join(pluginDist, "adapters", "copilot-mcp.js")));
});

test("generated native runtime retains gh timeout and MCP cancellation guards", async () => {
  const github = await readFile(join(dist, "core", "github.js"), "utf8");
  const mcp = await readFile(join(dist, "adapters", "copilot-mcp.js"), "utf8");
  assert.match(github, /timeoutMs = 20_000/);
  assert.match(github, /timeout:\s*timeoutMs/);
  assert.match(mcp, /notifications\/cancelled/);
  assert.match(mcp, /activeRequests\.get\(requestId\)\?\.abort\(\)/);
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

test("compiled Copilot MCP server is bounded, fails closed, and inherits its invocation paths", async (t) => {
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
  assert.deepEqual(negotiated.get(3).result.tools.map((tool: any) => tool.name), ["control", "skill"]);

  const cancelProject = join(sandbox, "cancel-project"); const cancelBin = join(sandbox, "cancel-bin");
  const fakeGh = join(cancelBin, process.platform === "win32" ? "gh.exe" : "gh");
  await Promise.all([mkdir(cancelProject), mkdir(cancelBin)]);
  if (process.platform === "win32") await copyFile(process.env.ComSpec!, fakeGh);
  else { await writeFile(fakeGh, "#!/bin/sh\nwhile :; do sleep 60; done\n", "utf8"); await chmod(fakeGh, 0o700); }
  const cancelInput = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "skill", arguments: { reference: JSON.stringify(trustedSkills[0]) } } },
    { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 2, reason: "test cancellation" } },
  ].map((message) => JSON.stringify(message)).join("\n") + "\n";
  const cancelStarted = Date.now();
  const cancelled = await run({ command: process.execPath, prefix: [] }, [join(dist, "adapters", "copilot-mcp.js")], {
    cwd: cancelProject,
    env: { ...process.env, PATH: cancelBin },
    input: cancelInput,
    timeout: 10_000,
  });
  succeeded(cancelled);
  const cancelResponses = new Map(cancelled.stdout.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)).map((message) => [message.id, message]));
  assert.equal(cancelResponses.get(2).result.isError, true);
  assert.match(cancelResponses.get(2).result.content[0].text, /external-skill-bootstrap: blocked.*aborted/i);
  assert.ok(Date.now() - cancelStarted < 2_000, "MCP cancellation must terminate the active gh process promptly");

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
  assert.deepEqual(responses.get(2).result.tools.map((tool: any) => tool.name), ["control", "skill"]);
  assert.equal(responses.get(3).result.isError, true);
  assert.match(responses.get(3).result.content[0].text, /invalid Agent Harbor control input/);
  assert.equal(responses.get(4).result.isError, true);
  assert.match(responses.get(4).result.content[0].text, /^external-skill-bootstrap: blocked\b/);
  assert.deepEqual(await readdir(project), []);
  await assert.rejects(() => access(home), /ENOENT/);

  const player = JSON.stringify({ name: "mcp-worker", description: "MCP worker", prompt: "Read only", tools: ["read"] });
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
  assert.match(registration, /agent-foundry:profile id=mcp-worker revision=3/);
  assert.equal(active, registration);
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
        assert.match(inspection.transcript, /No extensions loaded/i);
      } finally {
        await rm(sandbox, { recursive: true, force: true });
      }
    }),
    t.test("OpenCode", { skip: opencode ? false : "OpenCode CLI is not installed" }, async (child) => {
      const directory = await mkdtemp(join(tmpdir(), "harbor-opencode-native-"));
      child.after(() => rm(directory, { recursive: true, force: true }));
      succeeded(await run(opencode!, ["plugin", `file:${root}`], { cwd: directory, timeout: 60_000 }));
      const config = await run(opencode!, ["debug", "config"], { cwd: directory, timeout: 60_000 });
      succeeded(config);
      const discovered = JSON.parse(config.stdout);
      assert.ok([...commands].every((name) => name in discovered.command));
      assert.ok(["team-lead", "repo-cartographer", "crafter"].every((name) => name in discovered.agent));
    }),
    t.test("Pi", { skip: pi ? false : "Pi CLI is not installed" }, async (child) => {
      const directory = await mkdtemp(join(tmpdir(), "harbor-pi-native-"));
      child.after(() => rm(directory, { recursive: true, force: true }));
      const env = { ...process.env, PI_CODING_AGENT_DIR: join(directory, "pi-home") };
      if (pi!.prefix[0]?.endsWith(".js")) {
        const sdk = await import(pathToFileURL(join(dirname(pi!.prefix[0]), "index.js")).href);
        assert.equal(typeof sdk.createAgentSession, "function");
        assert.equal(typeof sdk.SessionManager?.inMemory, "function");
        const { session } = await sdk.createAgentSession({
          cwd: directory,
          agentDir: join(directory, "sdk-home"),
          sessionManager: sdk.SessionManager.inMemory(directory),
          tools: ["read"],
        });
        session.dispose();
      }
      succeeded(await run(pi!, ["install", root], { cwd: directory, env, timeout: 90_000 }));
      const listed = await run(pi!, ["list"], { cwd: directory, env, timeout: 30_000 });
      succeeded(listed);
      assert.ok(listed.stdout.toLowerCase().includes(root.toLowerCase()));
      const bench = await run(pi!, ["--no-session", "-e", join(dist, "adapters", "pi.js"), "-p", "/bench"], { cwd: directory, env, timeout: 60_000 });
      succeeded(bench);
      const rpc = await run(pi!, ["--no-session", "-e", join(dist, "adapters", "pi.js"), "--mode", "rpc"], {
        cwd: directory, env, timeout: 60_000, input: '{"type":"get_commands"}\n',
      });
      succeeded(rpc);
      const response = rpc.stdout.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
        .find((item) => item.type === "response" && item.command === "get_commands");
      assert.ok(response?.success);
      const names = new Set<string>(response.data.commands.map((command: any) => command.name));
      assert.ok([...commands, "team-lead", "repo-cartographer", "crafter"].every((name) => names.has(name)));
    }),
  ]);
});
