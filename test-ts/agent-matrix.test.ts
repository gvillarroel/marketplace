import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentHarborPlugin } from "../src/adapters/opencode.js";
import { listInvocablePlayerIds, listManagedActiveIds, loadPiActivePlayer, requireInvocablePlayer } from "../src/core/active.js";
import { bundledPlayers, rolePlayers } from "../src/core/defaults.js";
import { harnessProfileLayout } from "../src/core/harnesses.js";
import { Roster } from "../src/core/lifecycle.js";
import { harnessSpec, nativeTools, openCodeToolPolicy } from "../src/core/profiles.js";
import type { HarnessName, Orchestrator } from "../src/core/types.js";
import { CopilotOrchestrator } from "../src/orchestrators/copilot.js";
import { OpenCodeOrchestrator } from "../src/orchestrators/opencode.js";
import { PiOrchestrator } from "../src/orchestrators/pi.js";
import { loadHarborCycleDataset } from "./support/harbor-cycles.js";

const cycleDataset = loadHarborCycleDataset();
const fullCycle = cycleDataset.cycles.find((cycle) => cycle.id === "full-sdlc")!;
const fixedIds = cycleDataset.roster.fixed.map((player) => player.id);
const sdlcIds = cycleDataset.roster.bundled.map((player) => player.id);
const openCodeModel = { providerID: "openai", modelID: "gpt-5.3-codex-spark", variant: "low" } as const;
const expectedProfileLayouts = {
  copilot: { activeDir: ".github/agents", extension: ".agent.md" },
  opencode: { activeDir: ".opencode/agents", extension: ".md" },
  pi: { activeDir: ".pi/agents", extension: ".md" },
} as const satisfies Record<HarnessName, { activeDir: string; extension: string }>;

async function runMission(orchestrator: Orchestrator): Promise<string> {
  let evidence = "";
  for (const step of fullCycle.steps) {
    const task = step.evidenceFrom
      ? `${step.task}\n\nVerified evidence from ${step.evidenceFrom}:\n${evidence}`
      : step.task;
    evidence = await orchestrator.run({ ...bundledPlayers.get(step.agent)!, task });
  }
  return evidence;
}

test("the factory roster has exactly three active roles and six opt-in SDLC players", () => {
  assert.deepEqual([...rolePlayers.keys()], fixedIds);
  assert.deepEqual([...bundledPlayers.keys()], sdlcIds);
  assert.deepEqual(
    Object.fromEntries([...bundledPlayers].map(([id, player]) => [id, player.tools])),
    {
      "portfolio-management": ["read", "search"],
      design: [],
      build: ["read", "edit"],
      manage: ["read", "execute"],
      consume: ["read"],
      dispose: [],
    },
  );
  assert.match(rolePlayers.get("team-lead")!.prompt, /at most six times/);
  for (const player of [...rolePlayers.values(), ...bundledPlayers.values()]) {
    assert.equal(player.name.length > 0, true);
    assert.equal(player.description.length > 0, true);
    assert.equal(player.prompt.trim().length > 0, true);
  }
});

test("each harness keeps its literal active-profile layout and join writes exactly there", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harbor-layout-matrix-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const harness of ["copilot", "opencode", "pi"] as const satisfies readonly HarnessName[]) {
    const expected = expectedProfileLayouts[harness];
    const home = join(root, harness, "home");
    const project = join(root, harness, "project");
    const spec = harnessSpec(harness, home, project);
    assert.deepEqual(harnessProfileLayout(harness), expected);
    assert.deepEqual({ activeDir: spec.activeDir, extension: spec.extension }, expected);
    await new Roster(spec).join({ name: "layout-worker", description: "Layout worker", prompt: "Verify layout", tools: ["read"] });
    const profile = await readFile(join(project, expected.activeDir, `layout-worker${expected.extension}`), "utf8");
    assert.match(profile, /agent-foundry:profile id=layout-worker revision=4/);
  }
});

test("all harness rosters expose only fixed roles until owned SDLC profiles are activated", async () => {
  for (const harness of ["copilot", "opencode", "pi"] as const satisfies readonly HarnessName[]) {
    const root = await mkdtemp(join(tmpdir(), `harbor-${harness}-matrix-`));
    const home = join(root, "home"); const project = join(root, "project");
    const roster = new Roster(harnessSpec(harness, home, project));
    assert.deepEqual(listManagedActiveIds(harness, project), []);
    assert.deepEqual(listInvocablePlayerIds(harness, project), fixedIds);

    await roster.bench("on all", bundledPlayers);
    assert.deepEqual(listManagedActiveIds(harness, project), [...sdlcIds].sort());
    assert.deepEqual(new Set(listInvocablePlayerIds(harness, project)), new Set([...fixedIds, ...sdlcIds]));
    assert.equal(requireInvocablePlayer(harness, project, "portfolio-management").source, "active");
    if (harness === "pi") assert.deepEqual(loadPiActivePlayer(project, "build").tools, ["read", "edit"]);

    const active = harnessSpec(harness, home, project).activeDir;
    await mkdir(join(project, active), { recursive: true });
    await writeFile(join(project, active, `intruder${harnessSpec(harness, home, project).extension}`), "unmanaged", "utf8");
    assert.ok(!listManagedActiveIds(harness, project).includes("intruder"));
    assert.throws(() => requireInvocablePlayer(harness, project, "intruder"), /not found/);

    await roster.bench("off portfolio-management", bundledPlayers);
    assert.ok(!listInvocablePlayerIds(harness, project).includes("portfolio-management"));
    assert.throws(() => requireInvocablePlayer(harness, project, "portfolio-management"), /not found/);
  }
});

test("active-agent discovery fails closed on a linked discovery directory", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harbor-active-link-"));
  const project = join(root, "project"); const outside = join(root, "outside");
  await Promise.all([mkdir(project), mkdir(outside)]);
  try { await symlink(outside, join(project, ".github"), process.platform === "win32" ? "junction" : "dir"); }
  catch (error: any) {
    if (error?.code === "EPERM") { t.skip("directory links require an OS privilege"); return; }
    throw error;
  }
  assert.throws(() => listManagedActiveIds("copilot", project), /symlink traversal refused/);
});

test("Copilot reuses one orchestrator to dispatch every SDLC agent in order", async () => {
  const creates: Array<{ name: string; tools: string[]; prompt: string }> = [];
  const tasks: Array<{ name: string; task: string }> = [];
  const deletes: string[] = [];
  let stops = 0;
  let sequence = 0;
  const orchestrator = new CopilotOrchestrator(() => ({
    createSession: async (config: any) => {
      const id = `copilot-child-${++sequence}`;
      const name = config.customAgents[0].name;
      creates.push({ name, tools: config.customAgents[0].tools, prompt: config.customAgents[0].prompt });
      return {
        sessionId: id,
        abort: async () => {},
        sendAndWait: async ({ prompt }: any) => {
          tasks.push({ name, task: prompt });
          return { data: { content: `evidence:${name}` } };
        },
      };
    },
    deleteSession: async (id: string) => { deletes.push(id); },
    stop: async () => { stops += 1; },
  }) as any);

  assert.equal(await runMission(orchestrator), "evidence:dispose");
  assert.deepEqual(creates.map((entry) => entry.name), sdlcIds);
  assert.deepEqual(tasks.map((entry) => entry.name), sdlcIds);
  assert.deepEqual(deletes, sdlcIds.map((_id, index) => `copilot-child-${index + 1}`));
  assert.equal(stops, sdlcIds.length);
  for (const [index, player] of [...bundledPlayers.values()].entries()) {
    assert.deepEqual(creates[index].tools, nativeTools("copilot", player.tools));
    assert.match(creates[index].prompt, new RegExp(player.prompt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    if (index) assert.match(tasks[index].task, new RegExp(`evidence:${sdlcIds[index - 1]}`));
  }
});

test("OpenCode contract runner processes every staged SDLC definition with cleanup", async () => {
  const creates: Array<{ id: string; title: string }> = [];
  const prompts: Array<{ id: string; name: string; task: string; agent: string; tools: Record<string, boolean> }> = [];
  const deletes: string[] = [];
  const client = { session: {
    create: async ({ body }: any) => {
      const id = `opencode-child-${creates.length + 1}`;
      creates.push({ id, title: body.title });
      return { data: { id } };
    },
    prompt: async ({ path, body }: any) => {
      const text = body.parts[0].text as string;
      const name = /^Identity: ([^\n]+)$/m.exec(text)?.[1];
      assert.ok(name);
      prompts.push({ id: path.id, name, task: text, agent: body.agent, tools: body.tools });
      return { data: { parts: [{ type: "text", text: `evidence:${name}` }] } };
    },
    delete: async ({ path }: any) => { deletes.push(path.id); return { data: true }; },
  } };
  const orchestrator = new OpenCodeOrchestrator(client as any, process.cwd());

  assert.equal(await runMission(orchestrator), "evidence:dispose");
  assert.deepEqual(prompts.map((entry) => entry.name), sdlcIds);
  assert.deepEqual(deletes, creates.map((entry) => entry.id));
  for (const [index, player] of [...bundledPlayers.values()].entries()) {
    assert.equal(creates[index].title, `Harbor contract: ${player.name}`);
    assert.equal(prompts[index].agent, player.tools.some((tool) => tool === "edit" || tool === "execute") ? "general" : "explore");
    assert.deepEqual(prompts[index].tools, openCodeToolPolicy(player.tools));
    if (index) assert.match(prompts[index].task, new RegExp(`evidence:${sdlcIds[index - 1]}`));
  }
});

test("OpenCode named runner dispatches every fixed and activated ID exactly", async () => {
  const root = await mkdtemp(join(tmpdir(), "harbor-opencode-named-matrix-"));
  const project = join(root, "project");
  const roster = new Roster(harnessSpec("opencode", join(root, "home"), project));
  await roster.bench("on all", bundledPlayers);
  const ids = [...rolePlayers.keys(), ...bundledPlayers.keys()];
  assert.deepEqual(new Set(listInvocablePlayerIds("opencode", project)), new Set(ids));
  const creates: any[] = []; const prompts: any[] = []; const deletes: string[] = [];
  const client = { session: {
    create: async ({ body }: any) => {
      const id = `named-${creates.length + 1}`;
      creates.push({ id, body });
      return { data: { id } };
    },
    prompt: async ({ path, body }: any) => {
      prompts.push({ path, body });
      return { data: { parts: [{ type: "text", text: `evidence:${body.agent}` }] } };
    },
    delete: async ({ path }: any) => { deletes.push(path.id); return { data: true }; },
  } };
  const orchestrator = new OpenCodeOrchestrator(client as any, project);
  for (const id of ids) {
    requireInvocablePlayer("opencode", project, id);
    assert.equal(await orchestrator.runAgent(id, `task:${id}`, "parent", openCodeModel), `evidence:${id}`);
  }
  assert.deepEqual(prompts.map((entry) => entry.body.agent), ids);
  assert.deepEqual(prompts.map((entry) => entry.body.model), ids.map(() => ({ providerID: openCodeModel.providerID, modelID: openCodeModel.modelID })));
  assert.deepEqual(prompts.map((entry) => entry.body.variant), ids.map(() => openCodeModel.variant));
  assert.deepEqual(prompts.map((entry) => entry.body.parts[0].text), ids.map((id) => `task:${id}`));
  assert.ok(creates.every((entry) => entry.body.parentID === undefined));
  assert.deepEqual(deletes, creates.map((entry) => entry.id));
});

test("OpenCode team lead propagates the originating user model to its child prompt", async () => {
  const project = await mkdtemp(join(tmpdir(), "harbor-opencode-model-"));
  const prompts: any[] = [];
  let creates = 0;
  let originatingModel: { providerID: string; modelID: string } | undefined = {
    providerID: openCodeModel.providerID,
    modelID: openCodeModel.modelID,
  };
  const client = { session: {
    create: async () => ({ data: { id: `child-${++creates}` } }),
    message: async ({ path }: any) => path.messageID.startsWith("user-")
      ? { data: { info: { id: path.messageID, role: "user", model: originatingModel }, parts: [] } }
      : { data: {
        info: {
          id: path.messageID,
          role: "assistant",
          parentID: path.messageID === "assistant-missing" ? "user-missing" : "user-root",
          providerID: "must-not-propagate",
          modelID: "must-not-propagate",
        },
        parts: [],
      } },
    prompt: async ({ body }: any) => {
      prompts.push(body);
      return { data: { parts: [{ type: "text", text: "verified evidence" }] } };
    },
    delete: async () => ({ data: true }),
  } };
  const plugin = await AgentHarborPlugin({ client, directory: project } as any, {});
  const config: any = {};
  await plugin.config?.(config);
  assert.ok(config.agent["team-lead"].prompt.startsWith("Identity: team-lead\n"));
  assert.ok(config.agent["team-lead"].prompt.includes(rolePlayers.get("team-lead")!.prompt));
  assert.match(config.agent["team-lead"].prompt, /complete every required gate/);
  await plugin["chat.message"]!(
    { sessionID: "parent", messageID: "user-root", model: originatingModel, variant: openCodeModel.variant },
    { message: { id: "user-root", model: originatingModel }, parts: [] } as any,
  );
  const codexParams = { metadata: { session: "must-be-removed" }, keep: true };
  await plugin["chat.params"]!(
    { model: { providerID: "openai", id: openCodeModel.modelID } } as any,
    { options: codexParams } as any,
  );
  assert.deepEqual(codexParams, { keep: true });
  const otherParams = { metadata: { session: "must-remain" } };
  await plugin["chat.params"]!(
    { model: { providerID: "other", id: openCodeModel.modelID } } as any,
    { options: otherParams } as any,
  );
  assert.deepEqual(otherParams, { metadata: { session: "must-remain" } });

  const execution: any = {
    agent: "team-lead",
    directory: project,
    sessionID: "parent",
    messageID: "assistant-root",
    abort: new AbortController().signal,
  };
  assert.equal(await plugin.tool!.harbor_delegate.execute(
    { agent: "repo-cartographer", task: "Map the bounded fixture." }, execution,
  ), "verified evidence");
  assert.deepEqual(prompts[0].model, { providerID: openCodeModel.providerID, modelID: openCodeModel.modelID });
  assert.equal(prompts[0].variant, openCodeModel.variant);

  originatingModel = undefined;
  await assert.rejects(() => plugin.tool!.harbor_delegate.execute(
    { agent: "repo-cartographer", task: "Do not fall back to a default model." },
    { ...execution, messageID: "assistant-missing" },
  ), /no explicit model/);
  assert.equal(creates, 1, "a turn without an explicit model must create no child");
});

test("Pi reuses one orchestrator to dispatch every SDLC identity in isolated sessions", async () => {
  const model = { provider: "openai-codex", id: "gpt-5.3-codex-spark" };
  const creates: Array<{ name?: string; tools: string[]; customTools: unknown[]; model: unknown; thinkingLevel: unknown }> = [];
  const prompts: Array<{ name: string; task: string }> = [];
  const cleanup: string[] = [];
  const loaders: Array<{ options: any; reloaded: boolean }> = [];
  const sdk = {
    DefaultResourceLoader: class {
      private readonly record: { options: any; reloaded: boolean };
      private result = { skills: [], diagnostics: [] };
      constructor(options: any) { this.record = { options, reloaded: false }; loaders.push(this.record); }
      async reload() {
        this.record.reloaded = true;
        this.result = this.record.options.skillsOverride({ skills: [], diagnostics: [] });
      }
      getSkills() { return this.result; }
    },
    getAgentDir: () => "pi-agent-home",
    SessionManager: { inMemory: () => ({}) },
    createAgentSession: async (options: any) => {
      const record = {
        tools: options.tools,
        customTools: options.customTools,
        model: options.model,
        thinkingLevel: options.thinkingLevel,
      };
      creates.push(record);
      let handler = (_event: unknown) => {};
      return { session: {
        subscribe: (next: (event: unknown) => void) => { handler = next; return () => cleanup.push("unsubscribe"); },
        prompt: async (text: string) => {
          const name = /^Identity: ([^\n]+)$/m.exec(text)?.[1];
          assert.ok(name);
          (record as any).name = name;
          prompts.push({ name, task: text });
          handler({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: `evidence:${name}` } });
        },
        abort: async () => {},
        dispose: () => cleanup.push("dispose"),
      } };
    },
  };
  const orchestrator = new PiOrchestrator(
    process.cwd(), async () => sdk as any, [], undefined, [], undefined, { model, thinkingLevel: "minimal" },
  );

  assert.equal(await runMission(orchestrator), "evidence:dispose");
  assert.deepEqual(creates.map((entry) => entry.name), sdlcIds);
  assert.deepEqual(prompts.map((entry) => entry.name), sdlcIds);
  assert.deepEqual(cleanup, sdlcIds.flatMap(() => ["unsubscribe", "dispose"]));
  assert.equal(loaders.length, sdlcIds.length);
  assert.ok(loaders.every((loader) => loader.reloaded && [
    "noExtensions", "noSkills", "noPromptTemplates", "noThemes", "noContextFiles",
  ].every((option) => loader.options[option] === true)));
  for (const [index, player] of [...bundledPlayers.values()].entries()) {
    assert.deepEqual(creates[index].tools, nativeTools("pi", player.tools));
    assert.deepEqual(creates[index].customTools, []);
    assert.equal(creates[index].model, model);
    assert.equal(creates[index].thinkingLevel, "minimal");
    if (index) assert.match(prompts[index].task, new RegExp(`evidence:${sdlcIds[index - 1]}`));
  }
});
