import { registerHooks } from "node:module";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scenario = process.argv[2];
const root = dirname(fileURLToPath(new URL("../../package.json", import.meta.url)));
const keepAlive = setInterval(() => {}, 1_000);
const sandbox = await mkdtemp(join(tmpdir(), "harbor-copilot-extension-"));
const project = join(sandbox, "project");
process.env.COPILOT_HOME = join(sandbox, "copilot-home");
await mkdir(project, { recursive: true });
const never = () => new Promise(() => {});
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const listeners = new Set();
const logs = [];
const calls = { abort: 0, deselect: 0, reload: 0, select: 0, send: 0 };
const agents = [
  { id: "agent-foundry:team-lead", name: "team-lead", userInvocable: true },
  { id: "agent-foundry:crafter", name: "crafter", userInvocable: true, model: "profile-model" },
  { id: "agent-foundry:talent-scout", name: "talent-scout", userInvocable: true },
];
let selected = scenario === "native-reservation" || scenario === "inferred-child" ||
  scenario === "metadata-only-usage-parity" ? agents[0] : undefined;
let options;
let releaseSelection;
let releaseRestore;
let firstSelection = true;
let hostActive = scenario === "active-work";
let restoredWhileActive = 0;
let guardDecision;
let gapStop;

function emit(event) {
  for (const listener of [...listeners]) listener(event);
}

function errorShape(error) {
  if (!(error instanceof Error)) return { name: typeof error, message: String(error) };
  return {
    name: error.name,
    message: error.message,
    ...(Array.isArray(error.errors) ? { errors: error.errors.map(errorShape) } : {}),
  };
}

const session = {
  sessionId: "fake-copilot-session",
  rpc: {
    metadata: {
      snapshot: async () => ({ workingDirectory: project }),
      activity: async () => ({ abortable: true, hasActiveWork: hostActive }),
      isProcessing: async () => ({ processing: hostActive }),
    },
    model: {
      getCurrent: async () => ({ modelId: "host-model", reasoningEffort: null }),
    },
    agent: {
      getCurrent: async () => ({ agent: selected }),
      reload: async () => {
        calls.reload += 1;
        if (scenario === "startup-refresh-hang") return never();
        if (scenario === "first-team-delayed-discovery" && calls.reload === 1) return never();
        if (scenario === "refresh-hang" && calls.reload > 1) return never();
        return { agents };
      },
      list: async () => ({ agents }),
      select: async ({ name }) => {
        calls.select += 1;
        if (scenario === "select-hang" && firstSelection) {
          firstSelection = false;
          return never();
        }
        if ((scenario === "stop-before-send" || scenario === "stale-idle") && firstSelection) {
          firstSelection = false;
          return new Promise((resolve) => {
            releaseSelection = () => { selected = agents.find((agent) => agent.id === name); resolve({ agent: selected }); };
          });
        }
        selected = agents.find((agent) => agent.id === name);
        return { agent: selected };
      },
      deselect: async () => {
        calls.deselect += 1;
        if (hostActive) restoredWhileActive += 1;
        if (scenario === "restore-failure") throw new Error("restore failed");
        if (scenario === "restore-block") {
          return new Promise((resolve) => {
            releaseRestore = () => { selected = undefined; resolve(); };
          });
        }
        selected = undefined;
      },
    },
  },
  on(listener) {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
  async log(message, metadata) {
    logs.push({ message, metadata });
    if (scenario === "stop-send-gap" && message.includes("Starting:") && !gapStop) {
      gapStop = invoke("team", "stop all");
    }
    if (scenario === "log-hang") return never();
    if (scenario === "display-reject") throw new Error("display rejected");
    if (scenario === "log-backlog" && logs.length === 1) return never();
  },
  async send() {
    calls.send += 1;
    if (scenario === "metadata-only-usage-parity") {
      emit({
        type: "assistant.usage",
        id: "metadata-only-direct-usage",
        data: { serviceRequestId: "metadata-only-direct-request", model: "metadata-only-direct-model" },
      });
      emit({ type: "session.idle", id: "metadata-only-direct-idle", data: { aborted: false } });
      return;
    }
    if (scenario === "direct-root-usage-ownership") {
      const invocation = { sessionId: session.sessionId };
      await options.hooks.onUserPromptSubmitted({
        sessionId: session.sessionId,
        workingDirectory: project,
        prompt: "observe one direct provider call and one delegated provider call",
      }, invocation);
      const toolInput = {
        sessionId: session.sessionId,
        workingDirectory: project,
        toolName: "task",
        toolArgs: { agent_type: "agent-foundry:crafter", prompt: "one delegated provider call" },
      };
      emit({
        type: "tool.execution_start",
        id: "tool-start-root-1",
        data: { toolName: "task", toolCallId: "task-call-root-1" },
      });
      const decision = await options.hooks.onPreToolUse(toolInput, invocation);
      if (decision?.permissionDecision !== "allow") throw new Error(`delegation denied: ${decision?.permissionDecisionReason}`);
      emit({
        type: "subagent.started",
        id: "child-start-1",
        agentId: "native-child-1",
        data: { agentName: "agent-foundry:crafter", toolCallId: "task-call-root-1", model: "child-model" },
      });
      emit({
        type: "assistant.usage",
        id: "usage-event-child-1",
        data: {
          initiator: "sub-agent",
          providerCallId: "provider-child-1",
          serviceRequestId: "service-child-1",
          model: "child-model",
          reasoningEffort: "low",
          inputTokens: 31,
          outputTokens: 5,
          reasoningTokens: 2,
          cacheReadTokens: 4,
          cacheWriteTokens: 1,
        },
      });
      emit({
        type: "subagent.completed",
        id: "child-complete-1",
        agentId: "native-child-1",
        data: {
          agentName: "agent-foundry:crafter",
          toolCallId: "task-call-root-1",
          model: "child-model",
          durationMs: 20,
          totalTokens: 36,
          totalToolCalls: 0,
        },
      });
      await options.hooks.onPostToolUse({ ...toolInput, toolResult: "bounded evidence" }, invocation);
      emit({
        type: "assistant.turn_start",
        id: "turn-root-1",
        parentId: "child-complete-1",
        timestamp: "2026-07-21T11:59:59.000Z",
        data: { turnId: "turn-root-1", model: "host-model-observed" },
      });
      emit({
        type: "assistant.usage",
        id: "usage-event-root-1",
        parentId: "turn-root-1",
        timestamp: "2026-07-21T12:00:00.000Z",
        data: {
          // The lifecycle adapter deliberately bounds public metadata. A
          // long native ID therefore proves correctness comes from source
          // ownership, not accidental equality between two representations.
          apiCallId: `provider-call-${"x".repeat(260)}`,
          model: "host-model-observed",
          reasoningEffort: "low",
          inputTokens: 101,
          outputTokens: 7,
          reasoningTokens: 3,
          cacheReadTokens: 11,
          cacheWriteTokens: 2,
        },
      });
      emit({ type: "session.idle", id: "idle-root-1", data: { aborted: false } });
      return;
    }
    if (scenario === "acceptance-stale-idle") {
      hostActive = true;
      queueMicrotask(() => emit({ type: "session.idle", data: { aborted: false } }));
      setTimeout(() => {
        hostActive = false;
        emit({ type: "session.idle", data: { aborted: false } });
      }, 100);
      await wait(30);
      return;
    }
    if (scenario === "accepted-stale-idle" || scenario === "accepted-stale-aborted-idle") {
      const now = Date.now();
      hostActive = true;
      emit({
        type: "assistant.turn_start",
        id: `accepted-current-turn-${scenario}`,
        parentId: null,
        timestamp: new Date(now).toISOString(),
        data: { turnId: `accepted-current-turn-${scenario}`, model: "accepted-current-model" },
      });
      setTimeout(() => emit({
        type: "session.idle",
        id: `accepted-stale-idle-${scenario}`,
        parentId: "previous-run-event",
        timestamp: new Date(now - 60_000).toISOString(),
        data: { aborted: scenario === "accepted-stale-aborted-idle" },
      }), 10);
      setTimeout(() => {
        hostActive = false;
        emit({
          type: "session.idle",
          id: `accepted-current-idle-${scenario}`,
          parentId: `accepted-current-turn-${scenario}`,
          timestamp: new Date(now + 100).toISOString(),
          data: { aborted: false },
        });
      }, 100);
      return;
    }
    if (scenario === "stale-direct-usage") {
      const now = Date.now();
      emit({
        type: "assistant.turn_start",
        id: "stale-usage-current-turn",
        parentId: null,
        timestamp: new Date(now).toISOString(),
        data: { turnId: "stale-usage-current-turn", model: "current-model" },
      });
      emit({
        type: "assistant.usage",
        id: "previous-run-late-usage",
        parentId: "previous-run-event",
        timestamp: new Date(now - 60_000).toISOString(),
        data: { serviceRequestId: "previous-run-request", model: "old-model", inputTokens: 900, outputTokens: 90 },
      });
      emit({
        type: "session.error",
        id: "previous-run-late-error",
        parentId: "previous-run-event",
        timestamp: new Date(now - 59_000).toISOString(),
        data: { message: "PRIVATE PREVIOUS RUN ERROR" },
      });
      emit({
        type: "assistant.usage",
        id: "stale-usage-current-usage",
        parentId: "stale-usage-current-turn",
        timestamp: new Date(now + 1).toISOString(),
        data: { serviceRequestId: "current-run-request", model: "current-model", inputTokens: 20, outputTokens: 2 },
      });
      emit({
        type: "session.idle",
        id: "stale-usage-current-idle",
        parentId: "stale-usage-current-usage",
        timestamp: new Date(now + 2).toISOString(),
        data: { aborted: false },
      });
      return;
    }
    if (scenario === "guard-sync") {
      const invocation = { sessionId: session.sessionId };
      await options.hooks.onUserPromptSubmitted({
        sessionId: session.sessionId,
        workingDirectory: project,
        prompt: "coordinate with a synchronized guard",
      }, invocation);
      guardDecision = await options.hooks.onPreToolUse({
        sessionId: session.sessionId,
        workingDirectory: project,
        toolName: "task",
        toolArgs: { agent_type: "totally-unmanaged", prompt: "must be denied" },
      }, invocation);
      queueMicrotask(() => emit({ type: "session.idle", data: { aborted: false } }));
      return;
    }
    if (scenario === "send-timeout-late") {
      setTimeout(() => emit({ type: "session.idle", data: { aborted: false } }), 650);
      return never();
    }
    if (scenario === "send-timeout-buffered-terminal") {
      setTimeout(() => emit({ type: "session.idle", data: { aborted: false } }), 650);
      return never();
    }
    if (scenario === "abort-failure") {
      setTimeout(() => emit({ type: "session.idle", data: { aborted: true } }), 1_100);
      return;
    }
    if (scenario === "session-error" || scenario === "restore-failure") {
      queueMicrotask(() => emit({ type: "session.error", data: { message: "PRIVATE PROVIDER BODY" } }));
      return;
    }
    if (scenario === "session-shutdown-error" || scenario === "session-shutdown-cancelled") {
      emit({
        type: "session.shutdown",
        id: `shutdown-${scenario}`,
        data: { shutdownType: scenario === "session-shutdown-error" ? "error" : "normal" },
      });
      return;
    }
    queueMicrotask(() => emit({ type: "session.idle", data: { aborted: false } }));
  },
  async abort() {
    calls.abort += 1;
    if (scenario === "abort-failure") throw new Error("abort failed");
    if (scenario === "stop-before-send" || scenario === "stop-send-gap" || scenario === "native-reservation") {
      queueMicrotask(() => emit({ type: "session.idle", data: { aborted: true } }));
    }
  },
};

globalThis.__agentHarborJoinSession = async (input) => {
  options = input;
  return session;
};
const mockSource = "export const joinSession = (...args) => globalThis.__agentHarborJoinSession(...args);";
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@github/copilot-sdk/extension") {
      return { url: `data:text/javascript,${encodeURIComponent(mockSource)}`, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

await import(`${pathToFileURL(join(root, "plugins", "agent-foundry", "extensions", "agent-harbor", "extension.mjs")).href}?scenario=${scenario}`);

function command(name) {
  const found = options.commands.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`missing command: ${name}`);
  return found;
}

async function invoke(name, args) {
  try {
    await command(name).handler({ args });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: errorShape(error) };
  }
}

async function waitFor(predicate, label) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await wait(10);
  }
  throw new Error(`timed out waiting for ${label}`);
}

let result;
if (scenario === "log-hang") {
  const started = Date.now();
  result = { invocation: await invoke("crafter", "bounded logging"), elapsedMs: Date.now() - started };
} else if (scenario === "active-work") {
  result = { invocation: await invoke("crafter", "must not start") };
} else if (scenario === "display-reject") {
  result = { invocation: await invoke("team", "") };
} else if (scenario === "log-backlog") {
  const notifications = Promise.all(Array.from({ length: 12 }, () => invoke("player", "")));
  await waitFor(() => logs.length === 1, "first notification log");
  const started = Date.now();
  const team = await invoke("team", "");
  result = { team, elapsedMs: Date.now() - started, notifications: await notifications };
} else if (scenario === "refresh-hang") {
  const definition = JSON.stringify({
    name: "fresh-worker",
    description: "Fresh worker",
    prompt: "Work safely",
    tools: ["read"],
  });
  result = { invocation: await invoke("join", definition) };
} else if (scenario === "startup-refresh-hang") {
  result = {
    team: await invoke("team", ""),
    bench: await invoke("bench", "list"),
    player: await invoke("crafter", "must remain preflight-only"),
  };
} else if (scenario === "first-team-delayed-discovery") {
  const team = await invoke("team", "");
  result = {
    team,
    teamOutput: logs.map(({ message }) => message).findLast((message) => message.includes("Agent Harbor Copilot team")),
  };
} else if (scenario === "control-surface-ux") {
  const bench = await invoke("bench", "list design");
  const benchOutput = logs.map(({ message }) => message).findLast((message) => message.includes("Agent Harbor Copilot bench"));
  const bundledRetry = await invoke("player", "design inspect while benched");
  const definition = JSON.stringify({
    name: "ux-reviewer",
    description: "Review user-facing behavior",
    prompt: "Review safely",
    tools: ["read", "search"],
  });
  const joined = await invoke("join", definition);
  const joinOutput = logs.map(({ message }) => message).findLast((message) => message.includes("Agent Harbor /join"));
  const benched = await invoke("bench", "off ux-reviewer");
  const personalBenchRetry = await invoke("player", "ux-reviewer inspect while benched");
  const retired = await invoke("retire", "ux-reviewer");
  const retireOutput = logs.map(({ message }) => message).findLast((message) => message.includes("Agent Harbor /retire"));
  const retry = await invoke("player", "ux-reviewer inspect again");
  result = {
    bench, benchOutput, bundledRetry, joined, joinOutput, benched, personalBenchRetry,
    retired, retireOutput, retry, sandbox, project,
  };
} else if (scenario === "session-error") {
  result = {
    invocation: await invoke("crafter", "observe terminal error"),
    team: await invoke("team", ""),
  };
} else if (scenario === "session-shutdown-error" || scenario === "session-shutdown-cancelled") {
  const invocation = await invoke("crafter", "observe strong shutdown terminal");
  const team = await invoke("team", "");
  result = {
    invocation,
    team,
    teamOutput: logs.map(({ message }) => message)
      .findLast((message) => message.includes("Agent Harbor Copilot team")),
  };
} else if (scenario === "send-timeout-late") {
  const invocation = await invoke("crafter", "late terminal");
  const restoredAtReturn = calls.deselect;
  await wait(350);
  result = { invocation, restoredAtReturn, restoredAfterLate: calls.deselect };
} else if (scenario === "send-timeout-buffered-terminal") {
  const started = Date.now();
  result = {
    invocation: await invoke("crafter", "terminal precedes prompt acceptance timeout"),
    elapsedMs: Date.now() - started,
  };
} else if (scenario === "abort-failure") {
  result = { invocation: await invoke("crafter", "timeout and abort failure") };
} else if (scenario === "restore-failure") {
  const invocation = await invoke("crafter", "provider and restore fail");
  const retry = await invoke("crafter", "must remain blocked");
  result = { invocation, retry };
} else if (scenario === "restore-block") {
  const pending = invoke("crafter", "inspect cleanup visibility");
  await waitFor(() => calls.deselect === 1, "selection restore");
  const team = await invoke("team", "");
  const teamOutput = logs.map(({ message }) => message).findLast((message) => message.includes("ACTIVITY"));
  releaseRestore();
  result = { invocation: await pending, team, teamOutput };
} else if (scenario === "select-hang") {
  const invocation = await invoke("crafter", "selection hangs");
  const retry = await invoke("crafter", "must remain blocked");
  result = { invocation, retry };
} else if (scenario === "stop-before-send") {
  const pending = invoke("crafter", "stop during selection");
  await waitFor(() => calls.select === 1, "player selection");
  const stopped = await invoke("team", "stop all");
  releaseSelection();
  result = { invocation: await pending, stopped };
} else if (scenario === "stale-idle") {
  const pending = invoke("crafter", "ignore stale idle");
  await waitFor(() => calls.select === 1, "player selection");
  emit({ type: "session.idle", data: { aborted: false } });
  releaseSelection();
  result = { invocation: await pending };
} else if (scenario === "acceptance-stale-idle") {
  result = {
    invocation: await invoke("crafter", "ignore idle during prompt acceptance"),
    restoredWhileActive,
  };
} else if (scenario === "accepted-stale-idle" || scenario === "accepted-stale-aborted-idle") {
  const started = Date.now();
  result = {
    invocation: await invoke("crafter", "reject an accepted-phase stale idle"),
    elapsedMs: Date.now() - started,
    restoredWhileActive,
  };
} else if (scenario === "stale-direct-usage") {
  const invocation = await invoke("crafter", "ignore previous-run usage");
  result = {
    invocation,
    missionOutput: logs.map(({ message }) => message)
      .findLast((message) => message.includes("TEAM RUN (native Copilot telemetry)")),
  };
} else if (scenario === "stop-send-gap") {
  const invocation = await invoke("crafter", "stop in the send scheduling gap");
  result = { invocation, stopped: await gapStop };
} else if (scenario === "guard-sync") {
  result = {
    invocation: await invoke("team-lead", "exercise guard synchronization"),
    guardDecision,
  };
} else if (scenario === "direct-root-usage-ownership") {
  const invocation = await invoke("team-lead", "observe one direct and one delegated provider call");
  const team = await invoke("team", "");
  result = {
    invocation,
    team,
    missionOutput: logs.map(({ message }) => message)
      .findLast((message) => message.includes("TEAM RUN (native Copilot telemetry)")),
    teamOutput: logs.map(({ message }) => message)
      .findLast((message) => message.includes("Agent Harbor Copilot team")),
  };
} else if (scenario === "metadata-only-usage-parity") {
  const invocation = { sessionId: session.sessionId };
  await options.hooks.onUserPromptSubmitted({
    sessionId: session.sessionId,
    workingDirectory: project,
    prompt: "coordinate metadata-only telemetry",
  }, invocation);
  const toolInput = {
    sessionId: session.sessionId,
    workingDirectory: project,
    toolName: "task",
    toolArgs: { agent_type: "agent-foundry:crafter", prompt: "emit metadata-only child telemetry" },
  };
  emit({
    type: "tool.execution_start",
    id: "metadata-only-tool-start",
    data: { toolName: "task", toolCallId: "metadata-only-task-call" },
  });
  const admission = await options.hooks.onPreToolUse(toolInput, invocation);
  if (admission?.permissionDecision !== "allow") {
    throw new Error(`metadata-only delegation denied: ${admission?.permissionDecisionReason}`);
  }
  emit({
    type: "subagent.started",
    id: "metadata-only-child-start",
    agentId: "metadata-only-native-child",
    data: { agentName: "agent-foundry:crafter", toolCallId: "metadata-only-task-call" },
  });
  emit({
    type: "assistant.usage",
    id: "metadata-only-child-usage",
    agentId: "metadata-only-native-child",
    data: { serviceRequestId: "metadata-only-child-request", model: "metadata-only-child-model" },
  });
  emit({
    type: "subagent.completed",
    id: "metadata-only-child-complete",
    agentId: "metadata-only-native-child",
    data: { agentName: "agent-foundry:crafter", toolCallId: "metadata-only-task-call" },
  });
  await options.hooks.onPostToolUse({ ...toolInput, toolResult: "bounded metadata-only evidence" }, invocation);
  emit({
    type: "assistant.usage",
    id: "metadata-only-manual-root-usage",
    data: { providerCallId: "metadata-only-manual-root-request", model: "metadata-only-manual-root-model" },
  });
  emit({ type: "session.idle", id: "metadata-only-manual-root-idle", data: { aborted: false } });
  const manualTeam = await invoke("team", "");
  const manualTeamOutput = logs.map(({ message }) => message)
    .findLast((message) => message.includes("Agent Harbor Copilot team"));

  const direct = await invoke("crafter", "emit metadata-only direct telemetry");
  result = {
    admission,
    manualTeam,
    manualTeamOutput,
    direct,
    directMissionOutput: logs.map(({ message }) => message)
      .findLast((message) => message.includes("TEAM RUN (native Copilot telemetry)")),
  };
} else if (scenario === "native-reservation") {
  const invocation = { sessionId: session.sessionId };
  await options.hooks.onUserPromptSubmitted({
    sessionId: session.sessionId,
    workingDirectory: project,
    prompt: "coordinate",
  }, invocation);
  const toolInput = {
    sessionId: session.sessionId,
    workingDirectory: project,
    toolName: "task",
    toolArgs: { agent_type: "agent-foundry:crafter", prompt: "reserved child" },
  };
  const admission = await options.hooks.onPreToolUse(toolInput, invocation);
  const benchStop = await invoke("bench", "list stop");
  const benchStopOutput = logs.map(({ message }) => message)
    .findLast((message) => message.includes("Agent Harbor Copilot bench"));
  const benchStopAll = await invoke("bench", "list stop all");
  const benchStopAllOutput = logs.map(({ message }) => message)
    .findLast((message) => message.includes("Agent Harbor Copilot bench"));
  const abortAfterBenchLists = calls.abort;
  await invoke("team", "");
  const childId = logs.flatMap(({ message }) => [...message.matchAll(/crafter · run (copilot-run-\d+) · parent/gu)].map((match) => match[1])).at(-1);
  const direct = await invoke("crafter", "must not race reserved child");
  const stopped = await invoke("team", `stop ${childId}`);
  await options.hooks.onPostToolUseFailure({ ...toolInput, error: "test cleanup" }, invocation);
  result = {
    admission, benchStop, benchStopOutput, benchStopAll, benchStopAllOutput,
    abortAfterBenchLists, childId, direct, stopped,
  };
} else if (scenario === "inferred-child") {
  const invocation = { sessionId: session.sessionId };
  await options.hooks.onUserPromptSubmitted({
    sessionId: session.sessionId,
    workingDirectory: project,
    prompt: "coordinate inferred failure",
  }, invocation);
  const toolInput = {
    sessionId: session.sessionId,
    workingDirectory: project,
    toolName: "task",
    toolArgs: { agent_type: "agent-foundry:crafter", prompt: "never starts" },
  };
  const admission = await options.hooks.onPreToolUse(toolInput, invocation);
  await options.hooks.onPostToolUseFailure({ ...toolInput, error: "native start missing" }, invocation);
  result = { admission };
} else {
  throw new Error(`unknown scenario: ${scenario}`);
}

clearInterval(keepAlive);
await rm(sandbox, { recursive: true, force: true });
process.stdout.write(`${JSON.stringify({ scenario, result, calls, logs })}\n`);
