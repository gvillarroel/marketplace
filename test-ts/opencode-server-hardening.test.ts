import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { readOpenCodeAgentActivities, runOpenCodeRosterMutationGate } from "../src/adapters/opencode-agent-activity.js";
import { readOpenCodeAgentConflicts } from "../src/adapters/opencode-agent-conflicts.js";
import {
  readOpenCodeDirectAliasCollisions,
  recordOpenCodeDirectAliasCollisions,
} from "../src/adapters/opencode-team-runtime.js";
import { AgentHarborPlugin } from "../src/adapters/opencode.js";
import { runDeterministicCommandResult } from "../src/adapters/direct.js";
import { HarborInvocationLedger } from "../src/core/custom-tools.js";
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

async function nativeSelectorWorker(
  project: string,
  home: string,
  agent: string,
  sessionID: string,
): Promise<string> {
  const moduleURL = pathToFileURL(join(process.cwd(), "src", "adapters", "opencode.ts")).href;
  const source = `
    const { AgentHarborPlugin } = await import(${JSON.stringify(moduleURL)});
    const sessionID = ${JSON.stringify(sessionID)};
    try {
      const plugin = await AgentHarborPlugin({
        directory: ${JSON.stringify(project)},
        client: { session: {
          status: async () => ({ data: {} }),
          messages: async () => { throw new Error("unexpected activity message read"); },
        } },
      }, {});
      await plugin.config?.({});
      await plugin["chat.message"](
        { sessionID, messageID: "native-message", agent: ${JSON.stringify(agent)}, model: { providerID: "openai", modelID: "gpt-test" } },
        { message: { id: "native-message", agent: ${JSON.stringify(agent)}, model: { providerID: "openai", modelID: "gpt-test" } }, parts: [] },
      );
      process.stdout.write("admitted\\n");
      await new Promise((resolve) => setTimeout(resolve, 650));
      await plugin.event?.({ event: { type: "session.idle", properties: { sessionID } } });
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
      if (code !== 0 || signal) rejectWorker(new Error(`native selector worker failed: ${stderr}`));
      else resolveWorker(stdout.trim());
    });
  });
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
    const staleJoinFallback = {
      description: "Agent Harbor join model-routed fallback; prefer the direct TUI or agent-harbor CLI control",
      template: "Call the harbor tool exactly once with command \"join\" and args $ARGUMENTS. Return its result verbatim.",
    };
    const staleContractFallback = {
      description: "Agent Harbor contract model-routed fallback; prefer the direct TUI or agent-harbor CLI control",
      template: "Call the harbor tool exactly once with command \"contract\" and args $ARGUMENTS. Return its result verbatim.",
    };
    const foreignAgent = { description: "Foreign collision worker", tools: { bash: true } };
    const foreignLead = { description: "Foreign attempted lead", tools: { bash: true } };
    const config: any = {
      command: {
        bench: foreignLifecycle, "collision-worker": foreignAlias, scout: foreignScout,
        join: staleJoinFallback, contract: staleContractFallback,
      },
      agent: { "collision-worker": foreignAgent, "team-lead": foreignLead },
    };

    await plugin.config?.(config);

    assert.equal(config.command.bench, foreignLifecycle, "foreign lifecycle command was overwritten");
    assert.equal(config.command["collision-worker"], foreignAlias, "foreign direct alias was overwritten");
    assert.equal(config.command.scout, foreignScout, "foreign scout alias was overwritten");
    assert.equal(config.command.join, undefined, "legacy model-routed join fallback survived migration");
    assert.equal(config.command.contract, undefined, "legacy model-routed contract fallback survived migration");
    assert.equal(config.agent["collision-worker"], foreignAgent, "foreign managed agent was overwritten");
    assert.notEqual(config.agent["team-lead"], foreignLead, "fixed control-plane namespace was not claimed");
    assert.equal(config.agent["team-lead"].tools.harbor_delegate, true);
    assert.equal((plugin.tool as any).harbor, undefined, "an ambient generic lifecycle tool remained model-callable");
    assert.equal(config.agent.crafter.tools.harbor, false, "a default agent retained generic lifecycle access");
    assert.deepEqual([...readOpenCodeAgentConflicts(fixture.project)], ["collision-worker"]);
    assert.deepEqual(readOpenCodeDirectAliasCollisions(fixture.project), [
      { alias: "collision-worker", agent: "collision-worker" },
      { alias: "scout", agent: scoutPlayer.name },
    ], "the config hook did not publish its preserved foreign direct alias to the TUI bridge");

    const roster = String(await plugin.tool!.harbor_team_roster.execute(
      { query: "collision-worker" },
      toolExecution(fixture.project) as any,
    ));
    assert.match(roster,
      /Complete roster unavailable: 1 of 2 enabled specialists are not loaded.*collision-worker/su);
    assert.match(roster, /No partial roster was disclosed and no model child was started/u);
    assert.doesNotMatch(roster, /"id":"collision-worker"/u);
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
    assert.deepEqual(readOpenCodeDirectAliasCollisions(fixture.project), [
      { alias: "scout", agent: scoutPlayer.name },
    ], "repairing an agent collision incorrectly erased an independent foreign alias");

    delete config.command.scout;
    await plugin.config?.(config);
    assert.equal(config.command.scout.agent, scoutPlayer.name);
    assert.deepEqual(readOpenCodeDirectAliasCollisions(fixture.project), [],
      "repaired direct alias remained unavailable in the process-local bridge");
  } finally {
    recordOpenCodeDirectAliasCollisions(fixture.project, []);
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

test("OpenCode rechecks the lead roster cap before a reserved turn and releases the rejected claim", async () => {
  const fixture = await isolatedOpenCodeProject("harbor-opencode-lead-roster-recheck-");
  const previous = process.env.OPENCODE_CONFIG_DIR;
  process.env.OPENCODE_CONFIG_DIR = fixture.home;
  try {
    let hostCalls = 0;
    const client = withEmptyOpenCodeActivity({ session: {
      message: async () => { hostCalls += 1; return userMessage(); },
    } });
    const plugin = await AgentHarborPlugin({ client, directory: fixture.project } as any, {});
    await plugin.config?.({} as any);
    const direct = plugin["command.execute.before"]!;
    const sessionID = "lead-roster-recheck";
    await direct({ command: "team-lead", sessionID, arguments: "coordinate" }, { parts: [] });
    assert.equal(readOpenCodeAgentActivities(fixture.project).length, 1);

    const roster = new Roster(fixture.spec);
    for (let index = 0; index < 33; index += 1) {
      await roster.join({
        name: `overflow-worker-${index.toString().padStart(2, "0")}`,
        description: `Overflow worker ${index}`,
        prompt: "Work narrowly.",
        tools: ["read"],
      });
    }
    await assert.rejects(() => plugin["chat.message"]!(
      {
        sessionID,
        messageID: "lead-over-cap-message",
        agent: "team-lead",
        model: { providerID: "openai", modelID: "gpt-test" },
      } as any,
      {
        message: {
          id: "lead-over-cap-message",
          agent: "team-lead",
          model: { providerID: "openai", modelID: "gpt-test" },
        },
        parts: [],
      } as any,
    ), /exceeds the 32-member model-facing limit/u);
    assert.equal(hostCalls, 0, "an over-capacity lead preflight contacted the model/host");
    assert.deepEqual(readOpenCodeAgentActivities(fixture.project), [],
      "the rejected lead turn retained its starting ownership claim");

    await direct({ command: "crafter", sessionID, arguments: "repair without the lead" }, { parts: [] });
    assert.equal(readOpenCodeAgentActivities(fixture.project)[0]?.agent, "crafter",
      "the rejected lead reservation kept the native session locked");
    await plugin.event?.({ event: { type: "session.idle", properties: { sessionID } } } as any);
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_CONFIG_DIR;
    else process.env.OPENCODE_CONFIG_DIR = previous;
  }
});

test("OpenCode native selector admission is atomic with roster mutation and validates slash identity", async () => {
  const fixture = await isolatedOpenCodeProject("harbor-opencode-native-selector-gate-");
  const previous = process.env.OPENCODE_CONFIG_DIR;
  process.env.OPENCODE_CONFIG_DIR = fixture.home;
  try {
    const roster = new Roster(fixture.spec);
    await roster.bench("on design build", bundledPlayers);
    let mutateDuringStatus = false;
    const client = { session: {
      status: async () => {
        if (mutateDuringStatus) {
          mutateDuringStatus = false;
          await roster.bench("off design", bundledPlayers);
        }
        return { data: {} };
      },
      messages: async () => { throw new Error("empty activity inventory must not request messages"); },
    } };
    const plugin = await AgentHarborPlugin({ client, directory: fixture.project } as any, {});
    await plugin.config?.({} as any);
    const nativeMessage = (agent: string, sessionID: string, overrides: Record<string, unknown> = {}) => plugin["chat.message"]!(
      {
        sessionID,
        messageID: `${sessionID}-message`,
        agent,
        model: { providerID: "openai", modelID: "gpt-test" },
        ...overrides,
      } as any,
      {
        message: {
          id: `${sessionID}-message`,
          agent,
          model: { providerID: "openai", modelID: "gpt-test" },
        },
        parts: [],
      } as any,
    );
    const mutate = (args: string) => runOpenCodeRosterMutationGate(
      "bench",
      args,
      fixture.project,
      () => runDeterministicCommandResult("opencode", "bench", args, fixture.project),
    );

    mutateDuringStatus = true;
    await assert.rejects(
      () => nativeMessage("design", "mutation-wins"),
      /active managed player not found: design/u,
    );
    assert.deepEqual(readOpenCodeAgentActivities(fixture.project), [], "stale native admission published a claim");

    await roster.bench("on design", bundledPlayers);
    await nativeMessage("design", "admission-wins");
    assert.equal(readOpenCodeAgentActivities(fixture.project)[0]?.phase, "working");
    await assert.rejects(() => mutate("off design"), /cannot turn off design while design is working/u);
    await plugin.event?.({ event: { type: "session.status", properties: { sessionID: "admission-wins", status: { type: "busy" } } } } as any);
    await plugin.event?.({ event: { type: "session.idle", properties: { sessionID: "admission-wins" } } } as any);
    assert.deepEqual(readOpenCodeAgentActivities(fixture.project), []);

    const direct = plugin["command.execute.before"]!;
    await direct({ command: "build", sessionID: "slash-agent", arguments: "implement" }, { parts: [] });
    await assert.rejects(
      () => nativeMessage("design", "slash-agent"),
      /mismatched agent identity/u,
    );
    assert.deepEqual(readOpenCodeAgentActivities(fixture.project), [], "slash mismatch leaked its reservation");

    await nativeMessage("team-lead", "lead-native");
    await assert.rejects(() => mutate("off build"), /team-lead owns an active roster snapshot/u);
    await plugin.event?.({ event: { type: "session.status", properties: { sessionID: "lead-native", status: { type: "busy" } } } } as any);
    await plugin.event?.({ event: { type: "session.idle", properties: { sessionID: "lead-native" } } } as any);

    await assert.rejects(
      () => nativeMessage("design", "input-agent-mismatch", { agent: "build" }),
      /mismatched agent identity/u,
    );
    await assert.rejects(
      () => nativeMessage("foreign-native-agent", "output-agent-mismatch", { agent: "design" }),
      /mismatched agent identity/u,
    );
    await assert.rejects(
      () => nativeMessage("design", "invalid-model", { model: { providerID: 7, modelID: "gpt-test" } }),
      /model telemetry before model execution/u,
    );
    await assert.doesNotReject(() => nativeMessage(
      "foreign-native-agent",
      "foreign-invalid-model",
      { model: { providerID: 7, modelID: "gpt-test" } },
    ));

    const originalAcquire = HarborInvocationLedger.prototype.acquire;
    try {
      HarborInvocationLedger.prototype.acquire = function (scope, invocation) {
        if (invocation.includes("ledger-failure-message")) throw new Error("injected model ledger failure");
        return originalAcquire.call(this, scope, invocation);
      };
      await assert.rejects(
        () => nativeMessage("design", "ledger-failure"),
        /injected model ledger failure/u,
      );
    } finally {
      HarborInvocationLedger.prototype.acquire = originalAcquire;
    }
    assert.deepEqual(readOpenCodeAgentActivities(fixture.project), []);
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_CONFIG_DIR;
    else process.env.OPENCODE_CONFIG_DIR = previous;
  }
});

test("OpenCode native selector admits one direct player per session across OS processes", async () => {
  const fixture = await isolatedOpenCodeProject("harbor-opencode-native-selector-process-");
  const previous = process.env.OPENCODE_CONFIG_DIR;
  process.env.OPENCODE_CONFIG_DIR = fixture.home;
  try {
    await new Roster(fixture.spec).bench("on design build", bundledPlayers);
    const outcomes = await Promise.all([
      nativeSelectorWorker(fixture.project, fixture.home, "design", "shared-native-session"),
      nativeSelectorWorker(fixture.project, fixture.home, "build", "shared-native-session"),
    ]);
    assert.deepEqual(outcomes.sort(), ["admitted", "blocked"]);
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_CONFIG_DIR;
    else process.env.OPENCODE_CONFIG_DIR = previous;
  }
});

test("OpenCode direct preflight shows a bounded public TUI error for a stale alias without model work", async () => {
  const fixture = await isolatedOpenCodeProject("harbor-opencode-direct-preflight-toast-");
  const previous = process.env.OPENCODE_CONFIG_DIR;
  process.env.OPENCODE_CONFIG_DIR = fixture.home;
  try {
    const roster = new Roster(fixture.spec);
    await roster.join({
      name: "reviewer", description: "Review safely", prompt: "Review the assigned task.", tools: ["read"],
    });
    const toasts: any[] = [];
    const toastSignals: AbortSignal[] = [];
    let toastBehavior: "success" | "sync-error" | "async-error" | "error-envelope" | "hang" = "success";
    let statusReads = 0;
    let modelRequests = 0;
    const client = {
      tui: {
        showToast: (input: any) => {
          assert.equal(input.signal.aborted, false);
          toastSignals.push(input.signal);
          toasts.push({ body: input.body, query: input.query });
          if (toastBehavior === "sync-error") throw new Error("private toast transport failure");
          if (toastBehavior === "async-error") return Promise.reject(new Error("private async toast failure"));
          if (toastBehavior === "error-envelope") return Promise.resolve({ data: undefined, error: { message: "private envelope" } });
          return toastBehavior === "hang" ? new Promise(() => {}) : Promise.resolve({ data: true });
        },
      },
      session: {
        status: async () => { statusReads += 1; return { data: {} }; },
        messages: async () => { throw new Error("empty activity inventory must not request messages"); },
        prompt: async () => { modelRequests += 1; return { data: {} }; },
      },
    };
    const plugin = await AgentHarborPlugin({ client, directory: fixture.project } as any, {});
    const config: any = {};
    await plugin.config?.(config);
    assert.ok(config.command.reviewer, "the loaded alias needed for the stale-alias reproduction was not registered");
    const direct = plugin["command.execute.before"]!;
    const invoke = () => direct({
      command: "reviewer", sessionID: "stale-alias-session", arguments: "private task must not reach a provider",
    }, { parts: [] });
    await direct({ command: "reviewer", sessionID: "successful-preflight", arguments: "safe local task" }, { parts: [] });
    await plugin.event?.({ event: { type: "session.idle", properties: { sessionID: "successful-preflight" } } } as any);
    await direct({ command: "unknown", sessionID: "ignored-command", arguments: "ignored" }, { parts: [] });
    assert.deepEqual(toasts, [], "a successful or unknown direct command published an error toast");
    assert.equal(statusReads, 1);

    await roster.bench("off reviewer", bundledPlayers);
    await assert.rejects(invoke, (error: Error) => {
      assert.equal(error.name, "AgentHarborDirectPreflightError");
      assert.match(error.message, /^\/reviewer is no longer active in Agent Harbor; reload OpenCode/u);
      assert.equal((error as Error & { cause?: unknown }).cause, undefined);
      return true;
    });
    assert.deepEqual(toasts, [{
      body: {
        title: "Agent Harbor command blocked",
        message: "/reviewer is no longer active in Agent Harbor; reload OpenCode to remove this stale alias",
        variant: "error",
        duration: 8_000,
      },
      query: { directory: fixture.project },
    }]);
    assert.doesNotMatch(JSON.stringify(toasts[0].body), /private task|sessionID|provider|model/u);
    assert.equal(statusReads, 1, "the inactive alias reached authoritative host activity RPC");
    assert.equal(modelRequests, 0, "the inactive alias reached model execution");

    for (const behavior of ["sync-error", "async-error", "error-envelope"] as const) {
      toastBehavior = behavior;
      const before = toasts.length;
      await assert.rejects(invoke, /no longer active in Agent Harbor/u);
      assert.equal(toasts.length, before + 1, `${behavior} did not publish exactly one toast attempt`);
    }

    toastBehavior = "success";
    const beforeInvalid = toasts.length;
    await assert.rejects(() => direct({
      command: "reviewer", sessionID: "invalid-input", arguments: "",
    }, { parts: [] }), /requires a non-empty task/u);
    assert.equal(toasts.length, beforeInvalid + 1);
    assert.match(toasts.at(-1).body.message, /requires a non-empty task/u);

    toastBehavior = "hang";
    const startedAt = Date.now();
    await assert.rejects(invoke, /no longer active in Agent Harbor/u);
    assert.ok(Date.now() - startedAt < 1_500, "a hung best-effort TUI notification blocked direct preflight");
    assert.equal(toastSignals.at(-1)?.aborted, true, "the timed-out toast request signal remained live");
    assert.equal(modelRequests, 0);
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

test("OpenCode direct terminal reconciliation clears proven errors without accepting replayed session terminals", async () => {
  const fixture = await isolatedOpenCodeProject("harbor-opencode-direct-terminal-fence-");
  const terminalStatuses: Array<"busy" | "idle" | undefined> = [];
  let terminalReads = 0;
  let terminalMessageID: string | undefined;
  const client = { session: {
    status: async () => {
      const next = terminalStatuses.shift();
      if (next === undefined) return { data: {} };
      terminalReads += 1;
      return { data: { reuse: { type: next } } };
    },
    messages: async () => ({ data: terminalMessageID ? [{ info: {
      id: `assistant-${terminalMessageID}`,
      sessionID: "reuse",
      role: "assistant",
      parentID: terminalMessageID,
      time: { created: 1, completed: 2 },
    } }] : [] }),
  } };
  const plugin = await AgentHarborPlugin({ client, directory: fixture.project } as any, {});
  const config: any = {};
  await plugin.config?.(config);
  const direct = plugin["command.execute.before"]!;
  const message = (messageID: string) => plugin["chat.message"]!(
    {
      sessionID: "reuse",
      messageID,
      agent: "crafter",
      model: { providerID: "openai", modelID: "gpt-test" },
    } as any,
    {
      message: {
        id: messageID,
        agent: "crafter",
        model: { providerID: "openai", modelID: "gpt-test" },
      },
      parts: [],
    } as any,
  );

  await direct({ command: "crafter", sessionID: "reuse", arguments: "preflight only" }, { parts: [] });
  assert.equal(readOpenCodeAgentActivities(fixture.project)[0]?.phase, "starting");
  await plugin.event?.({ event: { type: "session.error", properties: { sessionID: "reuse" } } } as any);
  await assert.doesNotReject(() => direct(
    { command: "crafter", sessionID: "reuse", arguments: "retry after pre-chat error" },
    { parts: [] },
  ));

  await message("turn-one");
  assert.equal(readOpenCodeAgentActivities(fixture.project)[0]?.phase, "working");
  terminalMessageID = "turn-one";
  terminalStatuses.push(undefined, undefined);
  await plugin.event?.({ event: { type: "session.error", properties: { sessionID: "reuse" } } } as any);
  terminalMessageID = undefined;
  assert.deepEqual(readOpenCodeAgentActivities(fixture.project), [], "an immediate provider error leaked its claim");

  await direct({ command: "crafter", sessionID: "reuse", arguments: "new generation" }, { parts: [] });
  await message("turn-two");
  await plugin.event?.({ event: { type: "session.idle", properties: { sessionID: "reuse" } } } as any);
  assert.equal(readOpenCodeAgentActivities(fixture.project)[0]?.phase, "working",
    "a replayed idle erased the newer generation before native activity");
  await plugin.event?.({ event: { type: "session.error", properties: { sessionID: "reuse" } } } as any);
  assert.equal(readOpenCodeAgentActivities(fixture.project)[0]?.phase, "cleaning",
    "an unproven session-scoped error erased the newer generation");
  await assert.rejects(
    () => direct({ command: "crafter", sessionID: "competing", arguments: "must remain blocked" }, { parts: [] }),
    /busy in another direct or delegated run/u,
  );

  await plugin.event?.({ event: { type: "session.status", properties: { sessionID: "reuse", status: { type: "busy" } } } } as any);
  terminalStatuses.push("busy", "idle", "idle");
  await plugin.event?.({ event: { type: "session.idle", properties: { sessionID: "reuse" } } } as any);
  assert.ok(terminalReads >= 3, "terminal reconciliation did not poll through lagging native busy state");
  assert.deepEqual(readOpenCodeAgentActivities(fixture.project), []);
});

test("OpenCode aborts and re-fences a direct turn when its exact shared claim disappears", async () => {
  const fixture = await isolatedOpenCodeProject("harbor-opencode-direct-claim-loss-");
  const previous = process.env.OPENCODE_CONFIG_DIR;
  process.env.OPENCODE_CONFIG_DIR = fixture.home;
  try {
    let aborts = 0;
    const first = await AgentHarborPlugin({ directory: fixture.project, client: { session: {
      status: async () => ({ data: {} }),
      messages: async () => ({ data: [] }),
      abort: async () => { aborts += 1; return { data: true }; },
    } } } as any, {});
    const second = await AgentHarborPlugin({ directory: fixture.project, client: { session: {
      status: async () => ({ data: {} }),
      messages: async () => ({ data: [] }),
    } } } as any, {});
    await first.config?.({} as any);
    await second.config?.({} as any);
    await first["command.execute.before"]!(
      { command: "crafter", sessionID: "owner", arguments: "hold exact ownership" },
      { parts: [] },
    );
    await first["chat.message"]!(
      { sessionID: "owner", messageID: "owner-turn", agent: "crafter", model: { providerID: "openai", modelID: "gpt-test" } } as any,
      { message: { id: "owner-turn", agent: "crafter", model: { providerID: "openai", modelID: "gpt-test" } }, parts: [] } as any,
    );
    const stored = await readdir(fixture.home, { recursive: true });
    const claim = stored.find((entry) => entry.replace(/\\/gu, "/").endsWith("/crafter.json"));
    assert.ok(claim, "the exact direct claim was not published under the isolated activity home");
    await rm(join(fixture.home, claim));

    await assert.rejects(
      () => first.event?.({ event: { type: "session.status", properties: { sessionID: "owner", status: { type: "busy" } } } } as any),
      /lost the exact direct activity generation.*session was aborted/u,
    );
    assert.equal(aborts, 1);
    assert.equal(readOpenCodeAgentActivities(fixture.project)[0]?.phase, "cleaning",
      "ownership-loss recovery did not restore a durable admission fence");
    await assert.rejects(
      () => second["command.execute.before"]!(
        { command: "crafter", sessionID: "competitor", arguments: "must stay fenced" },
        { parts: [] },
      ),
      /busy in another direct or delegated run/u,
    );
    await first.event?.({ event: { type: "session.deleted", properties: { info: { id: "owner" } } } } as any);
    assert.deepEqual(readOpenCodeAgentActivities(fixture.project), []);
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_CONFIG_DIR;
    else process.env.OPENCODE_CONFIG_DIR = previous;
  }
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
    await plugin["chat.message"]!(
      {
        sessionID: "scout-session",
        messageID: "scout-user",
        agent: scoutPlayer.name,
        model: { providerID: "openai", modelID: "gpt-test" },
      } as any,
      {
        message: {
          id: "scout-user",
          agent: scoutPlayer.name,
          model: { providerID: "openai", modelID: "gpt-test" },
        },
        parts: [],
      } as any,
    );
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
    await plugin.event?.({ event: { type: "session.deleted", properties: { info: { id: "scout-session" } } } } as any);
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
