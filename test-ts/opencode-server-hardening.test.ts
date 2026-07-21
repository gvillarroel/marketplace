import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readOpenCodeAgentActivities } from "../src/adapters/opencode-agent-activity.js";
import { readOpenCodeAgentConflicts } from "../src/adapters/opencode-agent-conflicts.js";
import { AgentHarborPlugin } from "../src/adapters/opencode.js";
import { bundledPlayers, rolePlayers, scoutPlayer } from "../src/core/defaults.js";
import { GhResolver } from "../src/core/github.js";
import { Roster } from "../src/core/lifecycle.js";
import { harnessSpec } from "../src/core/profiles.js";

async function isolatedOpenCodeProject(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const project = join(root, "project");
  const home = join(root, "home");
  return { root, project, home, spec: harnessSpec("opencode", home, project) };
}

function userMessage(id = "user-turn") {
  return {
    data: {
      info: {
        id,
        role: "user",
        model: { providerID: "openai", modelID: "gpt-test" },
      },
      parts: [],
    },
  };
}

function toolExecution(project: string, overrides: Record<string, unknown> = {}) {
  return {
    agent: "team-lead",
    directory: project,
    worktree: project,
    sessionID: "lead-session",
    messageID: "assistant-turn",
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {},
    ...overrides,
  };
}

function withEmptyOpenCodeActivity<T extends object>(client: T) {
  return {
    ...client,
    session: {
      ...((client as any).session ?? {}),
      status: async () => ({ data: {} }),
      messages: async () => { throw new Error("empty activity inventory must not request messages"); },
    },
  };
}

function activityMessage(sessionID: string, agent: string, created = 1) {
  const entry: Record<string, unknown> = {
    info: {
      id: `message-${sessionID}`,
      sessionID,
      role: "user",
      time: { created },
      agent,
      model: { providerID: "local", modelID: "zero" },
    },
  };
  Object.defineProperty(entry, "parts", {
    get() { throw new Error("activity verification must not inspect message parts"); },
  });
  return entry;
}

test("OpenCode preserves foreign commands and managed agents while disabling only the colliding Harbor identity", async () => {
  const fixture = await isolatedOpenCodeProject("harbor-opencode-config-collision-");
  const previous = process.env.OPENCODE_CONFIG_DIR;
  process.env.OPENCODE_CONFIG_DIR = fixture.home;
  try {
    await new Roster(fixture.spec).join({
      name: "collision-worker",
      description: "Owned collision worker",
      prompt: "Work only on the assigned task.",
      tools: ["read"],
    });
    const logs: any[] = [];
    let childCreates = 0;
    const client = {
      app: { log: async (entry: unknown) => { logs.push(entry); return { data: true }; } },
      session: {
        message: async () => userMessage(),
        create: async () => { childCreates += 1; return { data: { id: "must-not-create" } }; },
      },
    };
    const plugin = await AgentHarborPlugin({ client: withEmptyOpenCodeActivity(client), directory: fixture.project } as any, {});
    const foreignLifecycle = { description: "My bench command", template: "foreign $ARGUMENTS" };
    const foreignAlias = { description: "My worker command", template: "foreign $ARGUMENTS", agent: "foreign-worker", subtask: false };
    const foreignScout = { description: "My scout command", template: "foreign $ARGUMENTS", agent: "foreign-scout", subtask: false };
    const foreignAgent = { description: "Foreign collision worker", tools: { bash: true } };
    const foreignLead = { description: "Foreign attempted lead", tools: { bash: true } };
    const config: any = {
      command: { bench: foreignLifecycle, "collision-worker": foreignAlias, scout: foreignScout },
      agent: { "collision-worker": foreignAgent, "team-lead": foreignLead },
    };

    await plugin.config?.(config);

    assert.equal(config.command.bench, foreignLifecycle, "foreign lifecycle command was overwritten");
    assert.equal(config.command["collision-worker"], foreignAlias, "foreign direct alias was overwritten");
    assert.equal(config.command.scout, foreignScout, "foreign scout alias was overwritten");
    assert.equal(config.agent["collision-worker"], foreignAgent, "foreign managed agent was overwritten");
    assert.notEqual(config.agent["team-lead"], foreignLead, "fixed control-plane namespace was not claimed");
    assert.equal(config.agent["team-lead"].tools.harbor_delegate, true);
    assert.deepEqual([...readOpenCodeAgentConflicts(fixture.project)], ["collision-worker"]);

    const roster = String(await plugin.tool!.harbor_team_roster.execute(
      { query: "collision-worker" },
      toolExecution(fixture.project) as any,
    ));
    assert.match(roster, /"id":"collision-worker","availability":"busy"/u);
    await assert.rejects(() => plugin.tool!.harbor_delegate.execute(
      { agent: "collision-worker", task: "must remain blocked" },
      toolExecution(fixture.project, { messageID: "delegate-turn" }) as any,
    ), /conflicts with a foreign OpenCode agent/u);
    await assert.rejects(() => plugin.tool!.agent_harbor_skills.execute(
      {},
      toolExecution(fixture.project, { agent: "collision-worker" }) as any,
    ), /conflicts with a foreign OpenCode agent/u);
    assert.equal(childCreates, 0, "a colliding Harbor identity created a model child");
    assert.ok(logs.some((entry) => /Unavailable Harbor agents: collision-worker/u.test(entry.body.message)));
    assert.ok(logs.some((entry) => /Unavailable Harbor slash aliases:/u.test(entry.body.message)));

    delete config.agent["collision-worker"];
    delete config.command["collision-worker"];
    await plugin.config?.(config);
    assert.equal(config.agent["collision-worker"].metadata.owner, "agent-foundry");
    assert.equal(config.command["collision-worker"].agent, "collision-worker");
    assert.deepEqual([...readOpenCodeAgentConflicts(fixture.project)], [], "repaired config retained stale conflict state");
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_CONFIG_DIR;
    else process.env.OPENCODE_CONFIG_DIR = previous;
  }
});

test("OpenCode direct preflight reserves lead and scout, caps each project at 32 active runs, and rejects oversized tasks before host work", async () => {
  const fixture = await isolatedOpenCodeProject("harbor-opencode-reservation-cap-");
  const previous = process.env.OPENCODE_CONFIG_DIR;
  process.env.OPENCODE_CONFIG_DIR = fixture.home;
  try {
    const roster = new Roster(fixture.spec);
    await roster.bench("on all", bundledPlayers);
    const builtInAliases = [...new Set([...rolePlayers.keys(), "scout", ...bundledPlayers.keys()])];
    const personalCount = 33 - builtInAliases.length;
    const personalIds: string[] = [];
    for (let index = 0; index < personalCount; index += 1) {
      const id = `cap-worker-${index.toString().padStart(2, "0")}`;
      personalIds.push(id);
      await roster.join({ name: id, description: `Capacity worker ${index}`, prompt: "Work narrowly.", tools: ["read"] });
    }
    let hostCalls = 0;
    const plugin = await AgentHarborPlugin({
      client: withEmptyOpenCodeActivity({ session: { message: async () => { hostCalls += 1; return userMessage(); } } }),
      directory: fixture.project,
    } as any, {});
    const config: any = {};
    await plugin.config?.(config);
    const direct = plugin["command.execute.before"]!;

    await assert.rejects(() => direct({
      command: personalIds[0], sessionID: "non-string-task", arguments: null as any,
    }, { parts: [] }), /requires a string task/u);
    await assert.rejects(() => direct({
      command: personalIds[0], sessionID: "huge-task", arguments: "x".repeat(2_000_000),
    }, { parts: [] }), /30 KiB direct-run limit/u);
    await assert.rejects(() => direct({
      command: personalIds[0], sessionID: 42 as any, arguments: "valid task",
    }, { parts: [] }), /invalid OpenCode session ID/u);
    await assert.rejects(() => direct({
      command: personalIds[0], sessionID: "s".repeat(2_000_000), arguments: "valid task",
    }, { parts: [] }), /invalid OpenCode session ID/u);
    await assert.rejects(() => direct({
      command: personalIds[0], sessionID: "oversized", arguments: "x".repeat(30 * 1_024 + 1),
    }, { parts: [] }), /30 KiB direct-run limit/u);
    assert.equal(hostCalls, 0, "malformed or huge direct input contacted the host");

    await direct({ command: "team-lead", sessionID: "direct-team-lead", arguments: "coordinate" }, { parts: [] });
    await assert.rejects(() => direct(
      { command: "team-lead", sessionID: "duplicate-team-lead", arguments: "overlap" }, { parts: [] },
    ), /busy in another direct or delegated run/u);
    await direct({ command: "scout", sessionID: "direct-scout", arguments: "find capacity" }, { parts: [] });
    await assert.rejects(() => direct(
      { command: "scout", sessionID: "duplicate-scout", arguments: "overlap" }, { parts: [] },
    ), /busy in another direct or delegated run/u);

    const remainingAliases = builtInAliases.filter((id) => id !== "team-lead" && id !== "scout");
    for (const [index, command] of [...remainingAliases, ...personalIds.slice(0, -1)].entries()) {
      await direct({ command, sessionID: `capacity-${index}`, arguments: "hold reservation" }, { parts: [] });
    }
    await assert.rejects(() => direct(
      { command: personalIds.at(-1)!, sessionID: "capacity-overflow", arguments: "must not start" }, { parts: [] },
    ), /at most 32 active runs per project/u);
    assert.equal(hostCalls, 0, "direct preflight contacted the model/host");

    await plugin.event?.({ event: { type: "session.idle", properties: { sessionID: "direct-team-lead" } } } as any);
    await direct({ command: personalIds.at(-1)!, sessionID: "capacity-after-release", arguments: "now start" }, { parts: [] });
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_CONFIG_DIR;
    else process.env.OPENCODE_CONFIG_DIR = previous;
  }
});

test("OpenCode v1 activity treats busy and retry as occupied, ignores idle, and never reads message parts", async () => {
  const fixture = await isolatedOpenCodeProject("harbor-opencode-v1-native-busy-");
  let statusReads = 0;
  const messageReads: string[] = [];
  let creates = 0;
  const client = { session: {
    status: async ({ query, signal }: any) => {
      statusReads += 1;
      assert.equal(query.directory, fixture.project);
      assert.equal(signal.aborted, false);
      return { data: {
        "native-crafter": { type: "busy" },
        "native-scout-retry": { type: "retry", attempt: 2, message: "bounded retry", next: Date.now() + 1_000 },
        "native-idle": { type: "idle" },
      } };
    },
    messages: async ({ path, query, signal }: any) => {
      messageReads.push(path.id);
      assert.equal(query.directory, fixture.project);
      assert.equal(query.limit, 8);
      assert.equal(signal.aborted, false);
      if (path.id === "native-crafter") return { data: [activityMessage(path.id, "crafter")] };
      if (path.id === "native-scout-retry") return { data: [activityMessage(path.id, scoutPlayer.name)] };
      throw new Error("idle sessions must not request messages");
    },
    message: async () => userMessage("native-busy-user"),
    create: async () => { creates += 1; return { data: { id: "must-not-create" } }; },
  } };
  const plugin = await AgentHarborPlugin({ client, directory: fixture.project } as any, {});
  await plugin.config?.({} as any);
  const execution = toolExecution(fixture.project, { messageID: "native-busy-assistant" }) as any;
  const roster = String(await plugin.tool!.harbor_team_roster.execute({ query: "crafter" }, execution));
  assert.match(roster, /"id":"crafter","availability":"busy"/u);
  await assert.rejects(
    () => plugin.tool!.harbor_delegate.execute({ agent: "crafter", task: "Do not overlap" }, execution),
    /busy in an active OpenCode session/u,
  );
  await assert.rejects(
    () => plugin["command.execute.before"]!({ command: "crafter", sessionID: "direct-busy", arguments: "No overlap" }, { parts: [] }),
    /busy in an active OpenCode session/u,
  );
  assert.equal(creates, 0);
  assert.equal(statusReads, 3);
  assert.deepEqual(messageReads.sort(), Array(3).fill(["native-crafter", "native-scout-retry"]).flat().sort());
  assert.ok(!messageReads.includes("native-idle"));
});

test("OpenCode v1 activity excludes the caller session before requesting messages", async () => {
  const fixture = await isolatedOpenCodeProject("harbor-opencode-v1-caller-exclusion-");
  let messageReads = 0;
  const client = { session: {
    status: async () => ({ data: { "current-session": { type: "busy" }, idle: { type: "idle" } } }),
    messages: async () => { messageReads += 1; throw new Error("caller and idle sessions must be excluded"); },
  } };
  const plugin = await AgentHarborPlugin({ client, directory: fixture.project } as any, {});
  await plugin.config?.({} as any);
  await plugin["command.execute.before"]!(
    { command: "crafter", sessionID: "current-session", arguments: "Continue this caller safely" },
    { parts: [] },
  );
  assert.equal(messageReads, 0);
  assert.deepEqual(readOpenCodeAgentActivities(fixture.project).map(({ agent, phase }) => ({ agent, phase })), [
    { agent: "crafter", phase: "starting" },
  ]);
  await plugin.event?.({ event: { type: "session.idle", properties: { sessionID: "current-session" } } } as any);
});

test("OpenCode v1 activity rejects oversized or hostile status and message telemetry before reservations or model work", async () => {
  const fixture = await isolatedOpenCodeProject("harbor-opencode-v1-hostile-activity-");
  let statusResponse: unknown = { data: {} };
  let messagesResponse: unknown = { data: [] };
  let messageReads = 0;
  let modelRequests = 0;
  const client = { session: {
    status: async () => statusResponse,
    messages: async () => { messageReads += 1; return messagesResponse; },
    prompt: async () => { modelRequests += 1; return { data: {} }; },
  } };
  const plugin = await AgentHarborPlugin({ client, directory: fixture.project } as any, {});
  await plugin.config?.({} as any);
  const direct = plugin["command.execute.before"]!;

  statusResponse = { data: Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`active-${index}`, { type: "busy" }])) };
  await assert.rejects(() => direct(
    { command: "crafter", sessionID: "oversized-status-caller", arguments: "Remain blocked" }, { parts: [] },
  ), /more than 32 active sessions/u);
  assert.equal(messageReads, 0);

  statusResponse = { data: { ["s".repeat(600)]: { type: "busy" } } };
  await assert.rejects(() => direct(
    { command: "crafter", sessionID: "hostile-status-caller", arguments: "Remain blocked" }, { parts: [] },
  ), /invalid session/u);
  assert.equal(messageReads, 0);

  statusResponse = { data: {
    "active-hostile-retry": {
      type: "retry", attempt: 1, next: Date.now() + 1_000, message: "m".repeat(2_000_000),
    },
  } };
  await assert.rejects(() => direct(
    { command: "crafter", sessionID: "hostile-retry-caller", arguments: "Remain blocked" }, { parts: [] },
  ), /retry telemetry was incompatible/u);
  assert.equal(messageReads, 0, "oversized retry telemetry reached active-session messages");

  statusResponse = { error: { message: "private status credential abcdefghijklmnop" } };
  await assert.rejects(() => direct(
    { command: "crafter", sessionID: "error-status-caller", arguments: "Remain blocked" }, { parts: [] },
  ), (error: Error) => {
    assert.match(error.message, /activity verification returned an error/u);
    assert.doesNotMatch(error.message, /credential|abcdefghijklmnop/u);
    return true;
  });

  statusResponse = { data: { "active-hostile": { type: "busy" } } };
  messagesResponse = { data: Array.from({ length: 9 }, () => activityMessage("active-hostile", "crafter")) };
  await assert.rejects(() => direct(
    { command: "crafter", sessionID: "oversized-message-caller", arguments: "Remain blocked" }, { parts: [] },
  ), /messages were incompatible/u);

  messagesResponse = { data: [activityMessage("active-hostile", "a".repeat(1_000))] };
  await assert.rejects(() => direct(
    { command: "crafter", sessionID: "hostile-agent-caller", arguments: "Remain blocked" }, { parts: [] },
  ), /agent identity was incompatible/u);
  assert.equal(modelRequests, 0);
  assert.deepEqual(readOpenCodeAgentActivities(fixture.project), []);
});

test("OpenCode v1 activity bounds SDK errors and timeouts, propagates abort, and never reserves on failure", async () => {
  const fixture = await isolatedOpenCodeProject("harbor-opencode-v1-activity-failure-");
  let mode: "error" | "hang" = "error";
  let entered!: () => void;
  let enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
  let activitySignal: AbortSignal | undefined;
  let statusReads = 0;
  const client = { session: {
    message: async () => userMessage("activity-failure-user"),
    status: async ({ signal }: any) => {
      statusReads += 1;
      if (mode === "error") throw new Error("private status SDK path C:/Users/alice/token.txt");
      activitySignal = signal;
      entered();
      return new Promise((_resolve, reject) => {
        const fail = () => reject(new Error("private aborted activity detail"));
        if (signal.aborted) fail();
        else signal.addEventListener("abort", fail, { once: true });
      });
    },
    messages: async () => { throw new Error("failed status must not request messages"); },
  } };
  const plugin = await AgentHarborPlugin({ client, directory: fixture.project } as any, {});
  await plugin.config?.({} as any);
  const direct = plugin["command.execute.before"]!;

  await assert.rejects(() => direct(
    { command: "crafter", sessionID: "activity-error", arguments: "Remain blocked" }, { parts: [] },
  ), (error: Error) => {
    assert.match(error.message, /activity verification failed/u);
    assert.doesNotMatch(error.message, /alice|token|private status/u);
    return true;
  });

  mode = "hang";
  const started = Date.now();
  const timedOut = direct(
    { command: "crafter", sessionID: "activity-timeout", arguments: "Remain blocked" }, { parts: [] },
  );
  await enteredPromise;
  await assert.rejects(timedOut, /active-session inventory timed out/u);
  assert.ok(Date.now() - started < 2_500);
  assert.equal(activitySignal?.aborted, true);

  enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
  const controller = new AbortController();
  const aborted = plugin.tool!.harbor_team_roster.execute(
    { query: "" },
    toolExecution(fixture.project, {
      sessionID: "activity-abort", messageID: "activity-abort-message", abort: controller.signal,
    }) as any,
  );
  await enteredPromise;
  controller.abort();
  await assert.rejects(aborted, (error: any) => {
    assert.equal(error.name, "AbortError");
    assert.match(error.message, /was cancelled/u);
    assert.doesNotMatch(error.message, /private aborted/u);
    return true;
  });
  assert.equal(activitySignal?.aborted, true);
  assert.equal(statusReads, 3);
  assert.deepEqual(readOpenCodeAgentActivities(fixture.project), []);
});

test("OpenCode bounds hostile host model identities before trim, ledger, active preflight, or create", async () => {
  const fixture = await isolatedOpenCodeProject("harbor-opencode-host-model-bound-");
  let originatingModel: any = { providerID: "x".repeat(2_000_000), modelID: "gpt" };
  let activeReads = 0;
  let creates = 0;
  const client = withEmptyOpenCodeActivity({ session: {
    message: async ({ path }: any) => path.messageID === "hostile-user"
      ? { data: { info: { id: "hostile-user", role: "user", model: originatingModel }, parts: [] } }
      : { data: { info: { id: path.messageID, role: "assistant", parentID: "hostile-user" }, parts: [] } },
    create: async () => ({ data: { id: `bounded-child-${++creates}` } }),
    update: async ({ path, body }: any) => ({ data: { id: path.id, title: body.title } }),
    prompt: async () => ({ data: { parts: [{ type: "text", text: "bounded evidence" }] } }),
    delete: async () => ({ data: true }),
  } });
  client.session.status = async () => { activeReads += 1; return { data: {} }; };
  const plugin = await AgentHarborPlugin({ client, directory: fixture.project } as any, {});
  await plugin.config?.({} as any);
  await plugin["chat.message"]!(
    { sessionID: "lead-session", messageID: "hostile-user", model: { providerID: 7, modelID: "gpt" } as any },
    { message: { id: "hostile-user", model: { providerID: "openai", modelID: "gpt" } }, parts: [] } as any,
  );
  await plugin["chat.message"]!(
    { sessionID: "lead-session", messageID: "hostile-user", model: { providerID: "openai", modelID: "gpt" }, variant: "v".repeat(2_000_000) },
    { message: { id: "hostile-user", model: { providerID: "openai", modelID: "gpt" } }, parts: [] } as any,
  );
  const execution = toolExecution(fixture.project, {
    sessionID: "lead-session", messageID: "hostile-assistant",
  }) as any;
  await assert.rejects(
    () => plugin.tool!.harbor_delegate.execute({ agent: "crafter", task: "Reject hostile model" }, execution),
    /no explicit model with a valid bounded identity/u,
  );
  assert.equal(activeReads, 0);
  assert.equal(creates, 0);

  originatingModel = { providerID: "openai", modelID: "gpt" };
  assert.equal(await plugin.tool!.harbor_delegate.execute(
    { agent: "crafter", task: "Proceed with valid bounded model" }, execution,
  ), "bounded evidence");
  assert.equal(activeReads, 1);
  assert.equal(creates, 1);
});

test("OpenCode ancestry RPCs honor caller aborts and local deadlines without poisoning the turn ledger", async () => {
  const fixture = await isolatedOpenCodeProject("harbor-opencode-ancestry-");
  let mode: "hang" | "ready" = "hang";
  let entered!: () => void;
  let enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
  let rpcSignal: AbortSignal | undefined;
  let rpcCalls = 0;
  const client = { session: {
    message: async ({ signal }: any) => {
      rpcCalls += 1;
      rpcSignal = signal;
      if (mode === "ready") return userMessage();
      entered();
      return new Promise((_resolve, reject) => {
        const fail = () => reject(new Error("rpc-secret-must-not-escape"));
        if (signal.aborted) fail();
        else signal.addEventListener("abort", fail, { once: true });
      });
    },
  } };
  const plugin = await AgentHarborPlugin({ client: withEmptyOpenCodeActivity(client), directory: fixture.project } as any, {});
  await plugin.config?.({} as any);
  const roster = plugin.tool!.harbor_team_roster;

  const alreadyAborted = new AbortController();
  alreadyAborted.abort();
  await assert.rejects(() => roster.execute(
    { query: "" },
    toolExecution(fixture.project, { abort: alreadyAborted.signal }) as any,
  ), /cancelled while reading message ancestry/u);
  assert.equal(rpcCalls, 0, "a pre-aborted ancestry lookup reached session.message");

  const controller = new AbortController();
  const aborted = roster.execute(
    { query: "" },
    toolExecution(fixture.project, { abort: controller.signal }) as any,
  );
  await enteredPromise;
  controller.abort();
  await assert.rejects(aborted, (error: any) => {
    assert.match(error.message, /cancelled while reading message ancestry/u);
    assert.doesNotMatch(error.message, /rpc-secret/u);
    return true;
  });
  assert.equal(rpcSignal?.aborted, true, "caller abort was not propagated to session.message");

  mode = "ready";
  assert.match(String(await roster.execute(
    { query: "" }, toolExecution(fixture.project, { messageID: "after-abort" }) as any,
  )), /Complete enabled roster snapshot/u);

  mode = "hang";
  enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
  const started = Date.now();
  const timedOut = roster.execute(
    { query: "" }, toolExecution(fixture.project, { messageID: "timeout-turn" }) as any,
  );
  await enteredPromise;
  await assert.rejects(timedOut, (error: any) => {
    assert.match(error.message, /message ancestry lookup timed out/u);
    assert.doesNotMatch(error.message, /rpc-secret/u);
    return true;
  });
  assert.ok(Date.now() - started < 2_500, "hung ancestry RPC escaped its local deadline");
  assert.equal(rpcSignal?.aborted, true, "deadline did not abort session.message");

  mode = "ready";
  assert.match(String(await roster.execute(
    { query: "" }, toolExecution(fixture.project, { messageID: "after-timeout" }) as any,
  )), /Complete enabled roster snapshot/u);
});

test("OpenCode scout join confirmation bounds and redacts path, credential, and model metadata", async () => {
  const fixture = await isolatedOpenCodeProject("harbor-opencode-scout-redaction-");
  const previous = process.env.OPENCODE_CONFIG_DIR;
  process.env.OPENCODE_CONFIG_DIR = fixture.home;
  try {
    const plugin = await AgentHarborPlugin({
      client: withEmptyOpenCodeActivity({ session: { message: async () => userMessage("scout-user") } }),
      directory: fixture.project,
    } as any, {});
    await plugin.config?.({} as any);
    const definition = JSON.stringify({
      name: "redacted-scout-result",
      description: "Reads C:\\Users\\alice\\secret.txt with API_KEY=topsecret123456",
      prompt: "Work narrowly without disclosing private context.",
      tools: ["read"],
      model: "openai/sk-abcdefghijklmnopqrstuvwxyz",
    });
    const execution = toolExecution(fixture.project, {
      agent: scoutPlayer.name,
      sessionID: "scout-session",
      messageID: "scout-assistant",
    });
    await plugin.tool!.harbor_team_roster.execute({ query: "redaction" }, execution as any);
    await plugin.tool!.harbor_filter_skills.execute({ query: "a" }, execution as any);
    const result = String(await plugin.tool!.harbor_join_player.execute(
      { definition },
      execution as any,
    ));
    assert.match(result, /Role: Reads \[path\] with API_KEY=\[redacted\]/u);
    assert.match(result, /Model: configured openai\/\[redacted\]/u);
    assert.doesNotMatch(result, /C:\\Users|topsecret123456|sk-abcdefghijklmnopqrstuvwxyz/u);
    assert.ok(Buffer.byteLength(result, "utf8") < 2_000, "scout confirmation was not bounded");
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_CONFIG_DIR;
    else process.env.OPENCODE_CONFIG_DIR = previous;
  }
});

test("OpenCode custom-tool failures preserve cancellation semantics but never expose SDK or GitHub secrets", async () => {
  const fixture = await isolatedOpenCodeProject("harbor-opencode-public-tool-errors-");
  const previous = process.env.OPENCODE_CONFIG_DIR;
  const originalListCatalog = GhResolver.prototype.listCatalog;
  process.env.OPENCODE_CONFIG_DIR = fixture.home;
  try {
    let messageCalls = 0;
    const client = { session: {
      message: async () => { messageCalls += 1; return userMessage(); },
      create: async () => { throw new Error("C:/Users/alice/private-sdk.txt Bearer abcdefghijklmnop"); },
    } };
    const plugin = await AgentHarborPlugin({ client: withEmptyOpenCodeActivity(client), directory: fixture.project } as any, {});
    await plugin.config?.({} as any);

    await assert.rejects(() => plugin.tool!.harbor_delegate.execute(
      { agent: "crafter", task: "Work" },
      toolExecution(fixture.project, { messageID: "delegate-public-error" }) as any,
    ), (error: any) => {
      assert.equal(error.name, "AgentHarborToolError");
      assert.match(error.message, /harbor_delegate failed.*\[path\].*\[redacted\]/u);
      assert.doesNotMatch(error.message, /alice|private-sdk|abcdefghijklmnop/u);
      assert.equal(error.cause, undefined);
      assert.ok(Buffer.byteLength(error.message, "utf8") < 1_000);
      return true;
    });

    const scoutExecution = toolExecution(fixture.project, {
      agent: scoutPlayer.name,
      sessionID: "scout-public-error",
      messageID: "scout-public-error-message",
    });
    await plugin.tool!.harbor_team_roster.execute({ query: "" }, scoutExecution as any);
    GhResolver.prototype.listCatalog = async () => {
      throw new Error("C:\\Users\\alice\\private-gh.txt API_KEY=topsecret123456");
    };
    await assert.rejects(() => plugin.tool!.harbor_filter_skills.execute(
      { query: "zx" }, scoutExecution as any,
    ), (error: any) => {
      assert.equal(error.name, "AgentHarborToolError");
      assert.match(error.message, /harbor_filter_skills failed.*\[path\].*API_KEY=\[redacted\]/u);
      assert.doesNotMatch(error.message, /alice|private-gh|topsecret123456/u);
      assert.equal(error.cause, undefined);
      return true;
    });

    for (const overrides of [
      { sessionID: 42 },
      { messageID: { forged: true } },
      { sessionID: "s".repeat(2_000_000) },
      { messageID: "m".repeat(2_000_000) },
    ]) {
      const before = messageCalls;
      await assert.rejects(() => plugin.tool!.harbor_team_roster.execute(
        { query: "" }, toolExecution(fixture.project, overrides) as any,
      ), /invalid OpenCode (?:session|message) ID/u);
      assert.equal(messageCalls, before, "invalid host identity reached ancestry RPC");
    }

    const cancelled = new AbortController();
    cancelled.abort();
    await assert.rejects(() => plugin.tool!.harbor_team_roster.execute(
      { query: "" }, toolExecution(fixture.project, {
        sessionID: "cancelled-session", messageID: "cancelled-message", abort: cancelled.signal,
      }) as any,
    ), (error: any) => {
      assert.equal(error.name, "AbortError");
      assert.match(error.message, /was cancelled/u);
      assert.equal(error.cause, undefined);
      return true;
    });
  } finally {
    GhResolver.prototype.listCatalog = originalListCatalog;
    if (previous === undefined) delete process.env.OPENCODE_CONFIG_DIR;
    else process.env.OPENCODE_CONFIG_DIR = previous;
  }
});
