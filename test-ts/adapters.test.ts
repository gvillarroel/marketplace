import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentHarborPlugin } from "../src/adapters/opencode.js";
import piExtension from "../src/adapters/pi.js";
import { commandNames } from "../src/core/types.js";
import { bundledPlayers, rolePlayers, trustedSkills } from "../src/core/defaults.js";
import { Roster } from "../src/core/lifecycle.js";
import { harnessSpec } from "../src/core/profiles.js";
import { CopilotOrchestrator } from "../src/orchestrators/copilot.js";
import { OpenCodeOrchestrator } from "../src/orchestrators/opencode.js";
import { PiOrchestrator } from "../src/orchestrators/pi.js";

const definition = { name: "worker", description: "Worker", prompt: "Work", tools: ["read"] as const, task: "Do it" };

test("Copilot orchestrator uses one SDK custom-agent session", async () => {
  const events: string[] = [];
  const client = {
    createSession: async (config: any) => {
      events.push(`create:${config.agent}:${config.customAgents.length}:${config.customAgents[0].tools.join(",")}:${config.workingDirectory === process.cwd()}`);
      return { sessionId: "child", abort: async () => {}, sendAndWait: async ({ prompt }: any) => { events.push(`send:${prompt}`); return { data: { content: "done" } }; } };
    },
    deleteSession: async (id: string) => { events.push(`delete:${id}`); },
    stop: async () => { events.push("stop"); },
  };
  const orchestrator = new CopilotOrchestrator(() => client as any);
  assert.equal(await orchestrator.run(definition as any), "done");
  assert.deepEqual(events, ["create:worker:1:read:true", "send:Do it", "delete:child", "stop"]);
});

test("OpenCode orchestrator uses one child session through its SDK client", async () => {
  const events: string[] = [];
  const client = { session: {
    create: async () => { events.push("create"); return { data: { id: "child" } }; },
    prompt: async ({ path, body }: any) => { events.push(`prompt:${path.id}:${body.agent}:${body.tools.read}:${body.tools.bash}`); return { data: { parts: [{ type: "text", text: "done" }] } }; },
    delete: async ({ path }: any) => { events.push(`delete:${path.id}`); return { data: true }; },
  } };
  const orchestrator = new OpenCodeOrchestrator(client as any, process.cwd());
  assert.equal(await orchestrator.run(definition as any), "done");
  assert.deepEqual(events, ["create", "prompt:child:explore:true:false", "delete:child"]);
});

test("Pi orchestrator uses one in-memory SDK session", async () => {
  const events: string[] = [];
  const session = {
    subscribe: (handler: any) => { session.handler = handler; return () => events.push("unsubscribe"); },
    handler: (_event: any) => {},
    prompt: async (text: string) => { events.push(`prompt:${text.includes("Do it")}`); session.handler({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "done" } }); },
    abort: async () => { events.push("abort"); },
    dispose: () => events.push("dispose"),
  };
  const sdk = {
    SessionManager: { inMemory: (cwd: string) => { events.push(`memory:${cwd === process.cwd()}`); return {}; } },
    createAgentSession: async (options: any) => { events.push(`create:${options.cwd === process.cwd()}:${options.tools.join(",")}`); return { session }; },
  };
  const orchestrator = new PiOrchestrator(process.cwd(), async () => sdk as any);
  assert.equal(await orchestrator.run(definition as any), "done");
  assert.deepEqual(events, ["memory:true", "create:true:read", "prompt:true", "unsubscribe", "dispose"]);
});

test("SDK orchestrators clean up child sessions when prompting fails", async () => {
  const copilotEvents: string[] = [];
  const copilot = new CopilotOrchestrator(() => ({
    createSession: async () => ({ sessionId: "failed", abort: async () => {}, sendAndWait: async () => { throw new Error("prompt failed"); } }),
    deleteSession: async () => { copilotEvents.push("delete"); },
    stop: async () => { copilotEvents.push("stop"); },
  }) as any);
  await assert.rejects(() => copilot.run(definition as any), /prompt failed/);
  assert.deepEqual(copilotEvents, ["delete", "stop"]);

  const openCodeEvents: string[] = [];
  const openCode = new OpenCodeOrchestrator({ session: {
    create: async () => ({ data: { id: "failed" } }),
    prompt: async () => { throw new Error("prompt failed"); },
    delete: async () => { openCodeEvents.push("delete"); return { data: true }; },
  } } as any, process.cwd());
  await assert.rejects(() => openCode.run(definition as any), /prompt failed/);
  assert.deepEqual(openCodeEvents, ["delete"]);

  const piEvents: string[] = [];
  const pi = new PiOrchestrator(process.cwd(), async () => ({
    SessionManager: { inMemory: () => ({}) },
    createAgentSession: async () => ({ session: {
      subscribe: () => () => { piEvents.push("unsubscribe"); },
      prompt: async () => { throw new Error("prompt failed"); },
      abort: async () => {},
      dispose: () => { piEvents.push("dispose"); },
    } }),
  }) as any);
  await assert.rejects(() => pi.run(definition as any), /prompt failed/);
  assert.deepEqual(piEvents, ["unsubscribe", "dispose"]);
});

test("contract skills are validated and materialized before any SDK child is created", async () => {
  let children = 0; let childPrompt = "";
  const client = {
    createSession: async (config: any) => {
      children += 1; childPrompt = config.customAgents[0].prompt;
      return { sessionId: "skill-child", abort: async () => {}, sendAndWait: async () => ({ data: { content: "done" } }) };
    },
    deleteSession: async () => {}, stop: async () => {},
  };
  const github = {
    resolve: async () => ({ commit: "a".repeat(40), blob: "b".repeat(40) }),
    load: async () => ({ commit: "c".repeat(40), body: "Use verified guidance." }),
  };
  const withSkill = { ...definition, tools: ["read", "execute"], skills: [trustedSkills[0]] };
  assert.equal(await new CopilotOrchestrator(() => client as any, process.cwd(), github).run(withSkill as any), "done");
  assert.equal(children, 1);
  assert.match(childPrompt, /Use verified guidance/);
  assert.match(childPrompt, /cannot broaden tools/);

  const rejected = new CopilotOrchestrator(() => {
    children += 1; return client as any;
  }, process.cwd(), { ...github, load: async () => { throw new Error("invalid remote skill"); } });
  await assert.rejects(() => rejected.run(withSkill as any), /invalid remote skill/);
  assert.equal(children, 1, "skill validation must finish before creating a child");
});

test("OpenCode plugin exposes five commands and the deterministic harbor tool", async () => {
  const root = await mkdtemp(join(tmpdir(), "harbor-opencode-adapter-"));
  const previous = process.env.OPENCODE_CONFIG_DIR;
  process.env.OPENCODE_CONFIG_DIR = join(root, "home");
  const initial = join(root, "initial"); const current = join(root, "current");
  const plugin = await AgentHarborPlugin({ client: { session: {} }, directory: initial } as any, {});
  const config: any = {};
  await plugin.config?.(config);
  assert.deepEqual(Object.keys(config.command), [...commandNames]);
  assert.equal(config.agent["team-lead"].tools.harbor, false);
  assert.equal(config.agent["team-lead"].tools.harbor_contract, true);
  assert.equal(config.agent["team-lead"].tools.bash, false);
  assert.equal(config.agent["repo-cartographer"].tools.read, true);
  assert.equal(config.agent["repo-cartographer"].tools.apply_patch, false);
  assert.equal(config.agent.crafter.tools.apply_patch, true);
  assert.equal(config.agent.crafter.tools.agent_harbor_skill, true);
  assert.ok(plugin.tool?.harbor);
  assert.ok(plugin.tool?.harbor_contract);
  assert.ok(plugin.tool?.agent_harbor_skill);
  await assert.rejects(() => plugin.tool!.agent_harbor_skill.execute(
    { reference: JSON.stringify({ ...trustedSkills[0], repo: "someone/else" }) },
    { directory: current, abort: new AbortController().signal } as any,
  ), /untrusted GitHub skill reference/);
  const result = await plugin.tool!.harbor.execute(
    { command: "join", args: JSON.stringify({ name: "native", description: "Native", prompt: "Work", tools: ["read"] }) },
    { directory: current, abort: new AbortController().signal } as any,
  );
  assert.match(String(result), /joined native/);
  assert.match(String(result), new RegExp(current.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  if (previous === undefined) delete process.env.OPENCODE_CONFIG_DIR; else process.env.OPENCODE_CONFIG_DIR = previous;
});

test("Pi extension registers lifecycle and fixed roles through ExtensionAPI", () => {
  const names: string[] = [];
  const tools: string[] = [];
  piExtension({ registerCommand: (name: string) => names.push(name), registerTool: (tool: any) => tools.push(tool.name) } as any);
  assert.deepEqual(names, [...commandNames, ...rolePlayers.keys()]);
  assert.deepEqual(tools, ["harbor_contract"]);
});

test("Pi extension turns an active managed profile into a native SDK-backed command", async () => {
  const root = await mkdtemp(join(tmpdir(), "harbor-pi-player-"));
  const project = join(root, "project");
  const roster = new Roster(harnessSpec("pi", join(root, "home"), project));
  await roster.join({ name: "reviewer", description: "Review", prompt: "Review only", tools: ["read", "search"] });
  await roster.bench("on scout", bundledPlayers);
  const previous = process.cwd(); const commands = new Map<string, any>();
  try {
    process.chdir(project);
    piExtension({ registerCommand: (name: string, options: any) => commands.set(name, options), registerTool: () => {} } as any);
  } finally { process.chdir(previous); }
  assert.ok(commands.has("reviewer"));
  assert.ok(commands.has("scout"));
  const received: Array<{ definition: any; additionalTools: string[] }> = []; const notices: string[] = [];
  const originalRun = PiOrchestrator.prototype.run;
  try {
    PiOrchestrator.prototype.run = async function (definition: any) {
      received.push({ definition, additionalTools: [...(this as any).additionalTools] });
      return "reviewed";
    };
    await commands.get("reviewer").handler("inspect src", { cwd: project, ui: { notify: (message: string) => notices.push(message) } });
    await commands.get("team-lead").handler("route work", { cwd: project, ui: { notify: (message: string) => notices.push(message) } });
  } finally { PiOrchestrator.prototype.run = originalRun; }
  assert.equal(received[0].definition.name, "reviewer");
  assert.deepEqual(received[0].definition.tools, ["read", "search"]);
  assert.equal(received[0].definition.task, "inspect src");
  assert.deepEqual(received[0].additionalTools, []);
  assert.equal(received[1].definition.name, "team-lead");
  assert.deepEqual(received[1].additionalTools, ["harbor_contract"]);
  assert.deepEqual(notices, ["reviewed", "reviewed"]);
});
