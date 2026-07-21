import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  copilotFixedAgentIds,
  copilotScoutAgentId,
  createCopilotCoordinatorGuard,
  resolveCopilotPlayer,
  type CopilotCoordinatorLifecycleEvent,
} from "../src/adapters/copilot-coordinator.js";
import { CopilotTeamRuntime } from "../src/adapters/copilot-team-runtime.js";
import { Roster } from "../src/core/lifecycle.js";
import { harnessSpec } from "../src/core/profiles.js";

test("Copilot coordinator emits correlated content-minimized root and child lifecycle events", async () => {
  const timelineBase = Date.now() + 10_000;
  const timeline = (offset: number): string => new Date(timelineBase + offset).toISOString();
  const teamLead = copilotFixedAgentIds.get("team-lead")!;
  const crafter = copilotFixedAgentIds.get("crafter")!;
  const agents = [...copilotFixedAgentIds.values()].map((id) => ({ id, userInvocable: true }));
  const lifecycle: CopilotCoordinatorLifecycleEvent[] = [];
  const coordinator = createCopilotCoordinatorGuard(() => ({ rpc: { agent: {
    getCurrent: async () => ({ agent: { id: teamLead } }),
    reload: async () => ({ agents }),
  } } }), undefined, (event) => { lifecycle.push(event); });

  coordinator.observeEvent({
    type: "session.start",
    id: "session-start-event",
    parentId: null,
    timestamp: timeline(0),
    data: {
      sessionId: "parent-session",
      selectedModel: "openai/gpt-root",
      reasoningEffort: "medium",
    },
  });
  await coordinator.refresh();

  const rootSecret = "root-secret-value";
  await coordinator.hooks.onUserPromptSubmitted({
    sessionId: "parent-session",
    workingDirectory: process.cwd(),
    prompt: `Review token=${rootSecret} in /home/alice/private.ts via https://private.example/item`,
  }, { sessionId: "parent-session" });

  const rootStarted = lifecycle.find((event) => event.type === "root.started");
  assert.ok(rootStarted);
  assert.equal(rootStarted.kind, "root");
  assert.equal(rootStarted.sessionId, "parent-session");
  assert.equal(rootStarted.rootRunId, rootStarted.runId);
  assert.equal(rootStarted.agent, "team-lead");
  assert.equal(rootStarted.runtimeAgent, teamLead);
  assert.equal(rootStarted.model, "openai/gpt-root");
  assert.equal(rootStarted.reasoningEffort, "medium");
  assert.match(rootStarted.taskLabel, /token=\[redacted\]/u);
  assert.match(rootStarted.taskLabel, /\[path\]/u);
  assert.match(rootStarted.taskLabel, /\[url\]/u);

  coordinator.observeEvent({
    type: "tool.execution_start",
    id: "tool-start-event",
    parentId: "root-turn-event",
    timestamp: timeline(1_000),
    data: { toolName: "task", toolCallId: "task-call-1" },
  });
  const childSecret = "child-secret-value";
  const toolInput = {
    sessionId: "parent-session",
    workingDirectory: process.cwd(),
    toolName: "task",
    toolArgs: {
      agent_type: crafter,
      prompt: `Implement password=${childSecret} from ./private/source.ts`,
    },
  };
  assert.equal((await coordinator.hooks.onPreToolUse(toolInput, { sessionId: "parent-session" }))?.permissionDecision, "allow");
  assert.equal(lifecycle.some((event) => event.type === "child.started"), false,
    "preflight acceptance is not a native child start");

  coordinator.observeEvent({
    type: "subagent.started",
    id: "child-start-event",
    parentId: "tool-start-event",
    timestamp: timeline(2_000),
    agentId: "native-child-1",
    data: { agentName: crafter, toolCallId: "task-call-1", model: "openai/gpt-child" },
  });
  coordinator.observeEvent({
    type: "assistant.turn_start",
    id: "child-turn-event",
    parentId: "child-start-event",
    timestamp: timeline(3_000),
    agentId: "native-child-1",
    data: { turnId: "child-turn-1", model: "openai/gpt-child" },
  });
  coordinator.observeEvent({
    type: "assistant.reasoning",
    id: "reasoning-content-event",
    parentId: "child-turn-event",
    agentId: "native-child-1",
    data: { content: "PRIVATE REASONING CONTENT", reasoningId: "reasoning-1" },
  });
  coordinator.observeEvent({
    type: "assistant.message",
    id: "global-content-between-child-events",
    parentId: "reasoning-content-event",
    data: { content: "PRIVATE GLOBAL CONTENT" },
  });
  coordinator.observeEvent({
    type: "assistant.usage",
    id: "stale-child-usage-event",
    parentId: "previous-child-event",
    timestamp: new Date(Date.now() - 60_000).toISOString(),
    agentId: "native-child-1",
    data: {
      apiCallId: "stale-child-api",
      model: "stale-child-model",
      inputTokens: 900,
      outputTokens: 90,
    },
  });
  coordinator.observeEvent({
    type: "assistant.usage",
    id: "child-usage-event",
    parentId: "global-content-between-child-events",
    timestamp: timeline(4_000),
    agentId: "native-child-1",
    data: {
      apiCallId: "api-call-1",
      parentToolCallId: "task-call-1",
      model: "openai/gpt-child-observed",
      reasoningEffort: "high",
      inputTokens: 11,
      outputTokens: 6,
      reasoningTokens: 3,
      cacheReadTokens: 4,
      cacheWriteTokens: 2,
    },
  });
  // Replayed native usage IDs must not double count downstream.
  coordinator.observeEvent({
    type: "assistant.usage",
    id: "child-usage-replay",
    agentId: "native-child-1",
    data: {
      apiCallId: "api-call-1",
      serviceRequestId: "service-enriched-replay",
      providerCallId: "provider-enriched-replay",
      inputTokens: 999,
      outputTokens: 999,
      model: "ignored/replay",
    },
  });
  coordinator.observeEvent({
    type: "assistant.usage",
    id: "child-usage-learned-alias-replay",
    agentId: "native-child-1",
    data: {
      serviceRequestId: "service-enriched-replay",
      inputTokens: 777,
      outputTokens: 777,
      model: "ignored/learned-alias-replay",
    },
  });
  coordinator.observeEvent({
    type: "subagent.completed",
    id: "child-complete-event",
    parentId: "child-usage-event",
    timestamp: timeline(5_000),
    agentId: "native-child-1",
    data: {
      agentName: crafter,
      toolCallId: "task-call-1",
      model: "openai/gpt-child-observed",
      durationMs: 3_000,
      totalTokens: 17,
      totalToolCalls: 2,
    },
  });
  await coordinator.hooks.onPostToolUse({ ...toolInput, toolResult: "PRIVATE CHILD EVIDENCE" }, { sessionId: "parent-session" });

  coordinator.observeEvent({
    type: "assistant.turn_start",
    id: "root-turn-event",
    parentId: "child-complete-event",
    timestamp: timeline(6_000),
    data: { turnId: "root-turn-1", model: "openai/gpt-root-observed" },
  });
  coordinator.observeEvent({
    type: "assistant.usage",
    id: "root-usage-event",
    parentId: "root-turn-event",
    timestamp: timeline(7_000),
    data: {
      apiCallId: "api-root-1",
      serviceRequestId: "service-root-1",
      providerCallId: "provider-root-1",
      model: "openai/gpt-root-observed",
      reasoningEffort: "low",
      inputTokens: 20,
      outputTokens: 5,
    },
  });
  coordinator.observeEvent({
    type: "session.idle",
    id: "session-idle-event",
    parentId: "root-usage-event",
    timestamp: timeline(8_000),
    data: { aborted: false },
  });

  const childStarted = lifecycle.find((event) => event.type === "child.started");
  assert.ok(childStarted);
  assert.equal(childStarted.kind, "child");
  assert.equal(childStarted.agent, "crafter");
  assert.equal(childStarted.runtimeAgent, crafter);
  assert.equal(childStarted.rootRunId, rootStarted.runId);
  assert.equal(childStarted.parentRunId, rootStarted.runId);
  assert.equal(childStarted.childId, "native-child-1");
  assert.equal(childStarted.invocationId, "task-call-1");
  assert.equal(childStarted.eventId, "child-start-event");
  assert.equal(childStarted.parentEventId, "tool-start-event");
  assert.match(childStarted.taskLabel, /password=\[redacted\]/u);
  assert.match(childStarted.taskLabel, /\[path\]/u);

  const childUsage = lifecycle.find((event) => event.type === "run.usage" && event.kind === "child");
  assert.ok(childUsage);
  assert.equal(childUsage.runId, childStarted.runId);
  assert.equal(childUsage.turnId, "child-turn-1");
  assert.equal(childUsage.apiCallId, "api-call-1");
  assert.equal(childUsage.serviceRequestId, undefined);
  assert.equal(childUsage.providerCallId, undefined);
  assert.equal(childUsage.eventId, "child-usage-event");
  assert.deepEqual(childUsage.usage, {
    inputTokens: 11,
    outputTokens: 6,
    reasoningTokens: 3,
    cacheReadTokens: 4,
    cacheWriteTokens: 2,
    totalTokens: 17,
  });
  assert.equal(lifecycle.filter((event) => event.type === "run.usage" && event.kind === "child").length, 1);
  assert.ok(lifecycle.some((event) => event.type === "run.model" && event.runId === childStarted.runId &&
    event.model === "openai/gpt-child-observed"));
  assert.ok(lifecycle.some((event) => event.type === "run.reasoning" && event.runId === childStarted.runId &&
    event.reasoningEffort === "high"));

  const childFinished = lifecycle.find((event) => event.type === "run.finished" && event.kind === "child");
  assert.ok(childFinished);
  assert.equal(childFinished.outcome, "completed");
  assert.equal(childFinished.durationMs, 3_000);
  assert.equal(childFinished.totalTokens, 17);
  assert.equal(childFinished.totalToolCalls, 2);
  const rootFinished = lifecycle.find((event) => event.type === "run.finished" && event.kind === "root");
  assert.ok(rootFinished);
  assert.equal(rootFinished.runId, rootStarted.runId);
  assert.equal(rootFinished.outcome, "completed");
  assert.ok(lifecycle.some((event) => event.type === "run.usage" && event.kind === "root" &&
    event.turnId === "root-turn-1" && event.usage.totalTokens === 25));
  const rootUsage = lifecycle.find((event) => event.type === "run.usage" && event.kind === "root");
  assert.ok(rootUsage);
  assert.equal(rootUsage.serviceRequestId, "service-root-1");
  assert.equal(rootUsage.providerCallId, "provider-root-1");

  const serialized = JSON.stringify(lifecycle);
  for (const privateValue of [
    rootSecret,
    childSecret,
    "/home/alice/private.ts",
    "./private/source.ts",
    "https://private.example/item",
    "PRIVATE REASONING CONTENT",
    "PRIVATE CHILD EVIDENCE",
    "service-enriched-replay",
    "provider-enriched-replay",
  ]) assert.equal(serialized.includes(privateValue), false, `lifecycle leaked ${privateValue}`);
  for (const event of lifecycle) {
    assert.equal("prompt" in event, false);
    assert.equal("result" in event, false);
    assert.equal("content" in event, false);
    assert.equal("evidence" in event, false);
    assert.equal("error" in event, false);
  }
});

test("Copilot keeps long opaque usage identities unique through the lifecycle/runtime handoff", async () => {
  const teamLead = copilotFixedAgentIds.get("team-lead")!;
  const agents = [...copilotFixedAgentIds.values()].map((id) => ({ id, userInvocable: true }));
  const lifecycle: CopilotCoordinatorLifecycleEvent[] = [];
  const coordinator = createCopilotCoordinatorGuard(() => ({ rpc: { agent: {
    getCurrent: async () => ({ agent: { id: teamLead } }),
    reload: async () => ({ agents }),
  } } }), undefined, (event) => { lifecycle.push(event); });
  await coordinator.refresh();
  await coordinator.hooks.onUserPromptSubmitted({
    sessionId: "long-opaque-usage",
    workingDirectory: process.cwd(),
    prompt: "count long opaque calls",
  }, { sessionId: "long-opaque-usage" });
  const shared = `opaque-${"x".repeat(240)}`;
  const rawIds = [`${shared}-left`, `${shared}-right`];
  coordinator.observeEvent({
    type: "assistant.usage",
    id: "long-usage-event-left",
    data: { apiCallId: rawIds[0], inputTokens: 3, outputTokens: 1 },
  });
  coordinator.observeEvent({
    type: "assistant.usage",
    id: "long-usage-event-right",
    data: { apiCallId: rawIds[1], inputTokens: 5, outputTokens: 2 },
  });

  const usageEvents = lifecycle.filter((event) => event.type === "run.usage");
  assert.equal(usageEvents.length, 2);
  assert.notEqual(usageEvents[0].apiCallId, usageEvents[1].apiCallId);
  assert.ok(usageEvents.every((event) => (event.apiCallId?.length ?? 0) <= 200));
  assert.ok(rawIds.every((raw) => !JSON.stringify(lifecycle).includes(raw)));

  const longToolCallId = `tool-${"z".repeat(240)}-unique-suffix`;
  const toolInput = {
    sessionId: "long-opaque-usage",
    workingDirectory: process.cwd(),
    toolName: "task",
    toolArgs: { agent_type: copilotFixedAgentIds.get("crafter")!, prompt: "correlate a long tool ID" },
  };
  coordinator.observeEvent({
    type: "tool.execution_start",
    id: "long-tool-start",
    data: { toolName: "task", toolCallId: longToolCallId },
  });
  assert.equal((await coordinator.hooks.onPreToolUse(toolInput, { sessionId: "long-opaque-usage" }))?.permissionDecision, "allow");
  coordinator.observeEvent({
    type: "subagent.started",
    id: "long-tool-child-start",
    agentId: `child-${"y".repeat(240)}-unique-suffix`,
    data: { agentName: copilotFixedAgentIds.get("crafter")!, toolCallId: longToolCallId },
  });
  const childStart = lifecycle.find((event) => event.type === "child.started");
  assert.ok(childStart);
  assert.ok((childStart.invocationId?.length ?? 0) <= 200);
  assert.ok((childStart.childId?.length ?? 0) <= 200);
  assert.equal(JSON.stringify(lifecycle).includes(longToolCallId), false);
  await coordinator.hooks.onPostToolUseFailure({ ...toolInput, error: "cleanup" }, { sessionId: "long-opaque-usage" });

  const runtime = new CopilotTeamRuntime();
  const runtimeRun = runtime.begin({
    project: process.cwd(), agent: "team-lead", kind: "manager", task: "count lifecycle usage",
  });
  for (const event of usageEvents) {
    runtime.observeUsageEvent({
      type: "assistant.usage",
      id: event.eventId,
      data: {
        apiCallId: event.apiCallId,
        serviceRequestId: event.serviceRequestId,
        providerCallId: event.providerCallId,
        inputTokens: event.usage.inputTokens,
        outputTokens: event.usage.outputTokens,
      },
    }, runtimeRun);
  }
  assert.equal(runtime.get(runtimeRun)?.nativeCalls, 2);
  assert.deepEqual(runtime.get(runtimeRun)?.usage, { input: 8, output: 3, total: 11 });
});

test("Copilot fixed and scout registry collisions fail closed for selection and lead delegation", async () => {
  const teamLead = copilotFixedAgentIds.get("team-lead")!;
  const crafter = copilotFixedAgentIds.get("crafter")!;
  assert.throws(() => resolveCopilotPlayer("team-lead", [{ id: teamLead }, { id: teamLead }], process.cwd()), /ambiguous/u);
  assert.throws(() => resolveCopilotPlayer("talent-scout", [
    { id: copilotScoutAgentId }, { id: copilotScoutAgentId },
  ], process.cwd()), /ambiguous/u);

  const duplicateAgents = [
    { id: teamLead, userInvocable: true },
    { id: teamLead, userInvocable: true },
    { id: crafter, userInvocable: true },
  ];
  const lifecycle: CopilotCoordinatorLifecycleEvent[] = [];
  const coordinator = createCopilotCoordinatorGuard(() => ({ rpc: { agent: {
    getCurrent: async () => ({ agent: { id: teamLead, userInvocable: true } }),
    reload: async () => ({ agents: duplicateAgents }),
  } } }), undefined, (event) => { lifecycle.push(event); });
  await coordinator.refresh();
  const invocation = { sessionId: "duplicate-fixed-registry" };
  const base = { sessionId: invocation.sessionId, workingDirectory: process.cwd() };
  await coordinator.hooks.onUserPromptSubmitted({ ...base, prompt: "must not trust a duplicate lead" }, invocation);
  assert.equal(lifecycle.some((event) => event.type === "root.started"), false);
  const decision = await coordinator.hooks.onPreToolUse({
    ...base,
    toolName: "task",
    toolArgs: { agent_type: crafter, prompt: "must not start" },
  }, invocation);
  assert.equal(decision?.permissionDecision, "deny");
  assert.match(decision?.permissionDecisionReason ?? "", /ambiguous/u);
  assert.equal(lifecycle.some((event) => event.type === "child.started"), false);
});

test("Copilot lifecycle observer failures cannot change guard decisions", async () => {
  const teamLead = copilotFixedAgentIds.get("team-lead")!;
  const crafter = copilotFixedAgentIds.get("crafter")!;
  const agents = [...copilotFixedAgentIds.values()].map((id) => ({ id, userInvocable: true }));
  const coordinator = createCopilotCoordinatorGuard(() => ({ rpc: { agent: {
    getCurrent: async () => ({ agent: { id: teamLead } }),
    reload: async () => ({ agents }),
  } } }), undefined, () => { throw new Error("observer failure"); });
  await coordinator.refresh();
  await coordinator.hooks.onUserPromptSubmitted({
    sessionId: "failure-isolation",
    workingDirectory: process.cwd(),
    prompt: "coordinate work",
  }, { sessionId: "failure-isolation" });
  const decision = await coordinator.hooks.onPreToolUse({
    sessionId: "failure-isolation",
    workingDirectory: process.cwd(),
    toolName: "task",
    toolArgs: { agent_type: crafter, prompt: "implement safely" },
  }, { sessionId: "failure-isolation" });
  assert.equal(decision?.permissionDecision, "allow");
});

test("Copilot session.error closes the active root without retaining its error body", async () => {
  const teamLead = copilotFixedAgentIds.get("team-lead")!;
  const agents = [...copilotFixedAgentIds.values()].map((id) => ({ id, userInvocable: true }));
  const lifecycle: CopilotCoordinatorLifecycleEvent[] = [];
  const coordinator = createCopilotCoordinatorGuard(() => ({ rpc: { agent: {
    getCurrent: async () => ({ agent: { id: teamLead } }),
    reload: async () => ({ agents }),
  } } }), undefined, (event) => { lifecycle.push(event); });
  await coordinator.refresh();
  await coordinator.hooks.onUserPromptSubmitted({
    sessionId: "root-error-session",
    workingDirectory: process.cwd(),
    prompt: "coordinate error handling",
  }, { sessionId: "root-error-session" });
  coordinator.observeEvent({
    type: "session.error",
    id: "root-error-event",
    data: { message: "PRIVATE ROOT PROVIDER ERROR BODY" },
  });

  const finished = lifecycle.find((event) => event.type === "run.finished" && event.kind === "root");
  assert.ok(finished);
  assert.equal(finished.outcome, "failed");
  assert.equal(finished.eventId, "root-error-event");
  assert.equal(JSON.stringify(lifecycle).includes("PRIVATE ROOT PROVIDER ERROR BODY"), false);
});

test("Copilot session terminals close an admitted child before its root and clear in-flight state", async () => {
  const teamLead = copilotFixedAgentIds.get("team-lead")!;
  const crafter = copilotFixedAgentIds.get("crafter")!;
  const agents = [...copilotFixedAgentIds.values()].map((id) => ({ id, userInvocable: true }));
  const lifecycle: CopilotCoordinatorLifecycleEvent[] = [];
  const coordinator = createCopilotCoordinatorGuard(() => ({ rpc: { agent: {
    getCurrent: async () => ({ agent: { id: teamLead } }),
    reload: async () => ({ agents }),
  } } }), undefined, (event) => { lifecycle.push(event); });
  await coordinator.refresh();
  const invocation = { sessionId: "terminal-with-child" };
  const promptInput = {
    sessionId: invocation.sessionId,
    workingDirectory: process.cwd(),
    prompt: "coordinate terminal cleanup",
  };
  const toolInput = {
    sessionId: invocation.sessionId,
    workingDirectory: process.cwd(),
    toolName: "task",
    toolArgs: { agent_type: crafter, prompt: "reserved child" },
  };
  await coordinator.hooks.onUserPromptSubmitted(promptInput, invocation);
  assert.equal((await coordinator.hooks.onPreToolUse(toolInput, invocation))?.permissionDecision, "allow");
  coordinator.observeEvent({ type: "session.error", id: "terminal-error", data: { message: "PRIVATE" } });

  const finished = lifecycle.filter((event) => event.type === "run.finished");
  assert.deepEqual(finished.map((event) => [event.kind, event.outcome]), [
    ["child", "failed"],
    ["root", "failed"],
  ]);
  assert.equal(finished[0].basis, "inferred");
  assert.equal(finished[1].basis, "observed");
  assert.equal(JSON.stringify(finished).includes("PRIVATE"), false);

  await coordinator.hooks.onUserPromptSubmitted({ ...promptInput, prompt: "coordinate again" }, invocation);
  assert.equal((await coordinator.hooks.onPreToolUse(toolInput, invocation))?.permissionDecision, "allow",
    "session terminal left the prior child in flight");
  await coordinator.hooks.onPostToolUseFailure({ ...toolInput, error: "cleanup" }, invocation);
});

test("Copilot child-scoped session terminals never terminate or clear the parent mission", async () => {
  const teamLead = copilotFixedAgentIds.get("team-lead")!;
  const crafter = copilotFixedAgentIds.get("crafter")!;
  const agents = [...copilotFixedAgentIds.values()].map((id) => ({ id, userInvocable: true }));
  const cases = [
    { label: "idle-agent", type: "session.idle", agentId: "native-child", data: { aborted: false } },
    { label: "error-agent", type: "session.error", agentId: "native-child", data: { message: "PRIVATE CHILD ERROR" } },
    { label: "shutdown-agent", type: "session.shutdown", agentId: "native-child", data: { shutdownType: "error" } },
    { label: "error-parent-tool", type: "session.error", data: { parentToolCallId: "child-tool", message: "PRIVATE CHILD ERROR" } },
  ] as const;

  for (const terminal of cases) {
    const lifecycle: CopilotCoordinatorLifecycleEvent[] = [];
    const coordinator = createCopilotCoordinatorGuard(() => ({ rpc: { agent: {
      getCurrent: async () => ({ agent: { id: teamLead } }),
      reload: async () => ({ agents }),
    } } }), undefined, (event) => { lifecycle.push(event); });
    await coordinator.refresh();
    const sessionId = `child-scoped-${terminal.label}`;
    const invocation = { sessionId };
    const toolInput = {
      sessionId,
      workingDirectory: process.cwd(),
      toolName: "task",
      toolArgs: { agent_type: crafter, prompt: `exercise ${terminal.label}` },
    };
    await coordinator.hooks.onUserPromptSubmitted({
      sessionId,
      workingDirectory: process.cwd(),
      prompt: "keep the root alive",
    }, invocation);
    coordinator.observeEvent({
      type: "tool.execution_start",
      id: `tool-start-${terminal.label}`,
      data: { toolName: "task", toolCallId: "child-tool" },
    });
    assert.equal((await coordinator.hooks.onPreToolUse(toolInput, invocation))?.permissionDecision, "allow");
    coordinator.observeEvent({
      type: "subagent.started",
      id: `child-start-${terminal.label}`,
      agentId: "native-child",
      data: { agentName: crafter, toolCallId: "child-tool" },
    });
    const { label: _label, ...childTerminal } = terminal;
    coordinator.observeEvent({
      ...childTerminal,
      id: `child-terminal-${terminal.label}`,
      parentId: `child-start-${terminal.label}`,
    });

    assert.equal(lifecycle.some((event) => event.type === "run.finished"), false,
      `${terminal.label} incorrectly terminalized the child or root`);
    assert.equal((await coordinator.hooks.onPreToolUse(toolInput, invocation))?.permissionDecision, "deny",
      `${terminal.label} cleared the pending child reservation`);

    coordinator.observeEvent({
      type: "subagent.failed",
      id: `child-failed-${terminal.label}`,
      parentId: `child-terminal-${terminal.label}`,
      agentId: "native-child",
      data: { agentName: crafter, toolCallId: "child-tool", error: "PRIVATE AUTHORITATIVE CHILD FAILURE" },
    });
    if (terminal.label === "idle-agent") {
      coordinator.observeEvent({
        type: "tool.execution_complete",
        id: "tool-complete-after-child-idle",
        parentId: `child-failed-${terminal.label}`,
        data: { toolCallId: "child-tool", toolDescription: { name: "task" }, success: false },
      });
    } else {
      await coordinator.hooks.onPostToolUseFailure({ ...toolInput, error: "cleanup" }, invocation);
    }
    assert.equal(lifecycle.filter((event) => event.type === "run.finished" && event.kind === "child").length, 1);
    assert.equal(lifecycle.some((event) => event.type === "run.finished" && event.kind === "root"), false);

    coordinator.observeEvent({
      type: "session.idle",
      id: `root-idle-${terminal.label}`,
      ...(terminal.label === "idle-agent" ? { parentId: "tool-complete-after-child-idle" } : {}),
      data: { aborted: false },
    });
    const finishes = lifecycle.filter((event) => event.type === "run.finished");
    assert.deepEqual(finishes.map((event) => [event.kind, event.outcome]), [
      ["child", "failed"],
      ["root", "completed"],
    ]);
    assert.equal(JSON.stringify(lifecycle).includes("PRIVATE"), false);
  }
});

test("Copilot subagent failures retain only a fingerprint, never the native error body", async () => {
  const teamLead = copilotFixedAgentIds.get("team-lead")!;
  const crafter = copilotFixedAgentIds.get("crafter")!;
  const agents = [...copilotFixedAgentIds.values()].map((id) => ({ id, userInvocable: true }));
  const evidence: unknown[] = [];
  const lifecycle: CopilotCoordinatorLifecycleEvent[] = [];
  const coordinator = createCopilotCoordinatorGuard(() => ({ rpc: { agent: {
    getCurrent: async () => ({ agent: { id: teamLead } }),
    reload: async () => ({ agents }),
  } } }), (event) => { evidence.push(event); }, (event) => { lifecycle.push(event); });
  await coordinator.refresh();
  const invocation = { sessionId: "private-child-error" };
  await coordinator.hooks.onUserPromptSubmitted({
    sessionId: invocation.sessionId,
    workingDirectory: process.cwd(),
    prompt: "coordinate",
  }, invocation);
  coordinator.observeEvent({
    type: "tool.execution_start",
    data: { toolName: "task", toolCallId: "private-error-tool" },
  });
  const toolInput = {
    sessionId: invocation.sessionId,
    workingDirectory: process.cwd(),
    toolName: "task",
    toolArgs: { agent_type: crafter, prompt: "attempt child" },
  };
  assert.equal((await coordinator.hooks.onPreToolUse(toolInput, invocation))?.permissionDecision, "allow");
  const sentinel = "PRIVATE NATIVE CHILD ERROR BODY token=top-secret";
  coordinator.observeEvent({
    type: "subagent.failed",
    agentId: "failed-child-id",
    data: { agentName: crafter, toolCallId: "private-error-tool", error: sentinel },
  });
  await coordinator.hooks.onPostToolUseFailure(toolInput, invocation);

  const serialized = JSON.stringify({ lifecycle, evidence });
  assert.equal(serialized.includes(sentinel), false);
  const failed = evidence.find((event: any) => event.phase === "child.failed") as any;
  assert.match(failed.error.sha256, /^[a-f0-9]{64}$/u);
  assert.ok(failed.error.utf8Bytes > 0);
});

test("Copilot steering prompts preserve an active root and admitted child until a native terminal", async () => {
  const teamLead = copilotFixedAgentIds.get("team-lead")!;
  const crafter = copilotFixedAgentIds.get("crafter")!;
  const agents = [...copilotFixedAgentIds.values()].map((id) => ({ id, userInvocable: true }));
  const lifecycle: CopilotCoordinatorLifecycleEvent[] = [];
  const coordinator = createCopilotCoordinatorGuard(() => ({ rpc: { agent: {
    getCurrent: async () => ({ agent: { id: teamLead } }),
    reload: async () => ({ agents }),
  } } }), undefined, (event) => { lifecycle.push(event); });
  await coordinator.refresh();
  const invocation = { sessionId: "steering-session" };
  const rootInput = { sessionId: invocation.sessionId, workingDirectory: process.cwd(), prompt: "first prompt" };
  const toolInput = {
    sessionId: invocation.sessionId,
    workingDirectory: process.cwd(),
    toolName: "task",
    toolArgs: { agent_type: crafter, prompt: "active child" },
  };
  await coordinator.hooks.onUserPromptSubmitted(rootInput, invocation);
  assert.equal((await coordinator.hooks.onPreToolUse(toolInput, invocation))?.permissionDecision, "allow");
  const rootStart = lifecycle.find((event) => event.type === "root.started");

  await coordinator.hooks.onUserPromptSubmitted({ ...rootInput, prompt: "steer without terminal" }, invocation);
  assert.equal(lifecycle.filter((event) => event.type === "root.started").length, 1);
  assert.equal(lifecycle.some((event) => event.type === "run.finished"), false,
    "a steering prompt fabricated a terminal lifecycle event");
  const blocked = await coordinator.hooks.onPreToolUse(toolInput, invocation);
  assert.equal(blocked?.permissionDecision, "deny");
  assert.match(blocked?.permissionDecisionReason ?? "", /sequentially/u);

  await coordinator.hooks.onPostToolUseFailure({ ...toolInput, error: "cleanup" }, invocation);
  coordinator.observeEvent({ type: "session.idle", id: "steering-idle", data: { aborted: false } });
  const rootFinish = lifecycle.find((event) => event.type === "run.finished" && event.kind === "root");
  assert.ok(rootStart && rootFinish);
  assert.equal(rootFinish.runId, rootStart.runId);
});

test("Copilot child admission denies before native work without poisoning the next delegation", async () => {
  const teamLead = copilotFixedAgentIds.get("team-lead")!;
  const crafter = copilotFixedAgentIds.get("crafter")!;
  const agents = [...copilotFixedAgentIds.values()].map((id) => ({ id, userInvocable: true }));
  const observed: Array<{ project: string; parentRunId: string; agent: string; taskLabel: string }> = [];
  let attempts = 0;
  const coordinator = createCopilotCoordinatorGuard(() => ({ rpc: { agent: {
    getCurrent: async () => ({ agent: { id: teamLead } }),
    reload: async () => ({ agents }),
  } } }), undefined, undefined, (input) => {
    attempts += 1;
    observed.push(input);
    if (attempts === 1) throw new Error("crafter is already working in copilot-run-7");
  });
  await coordinator.refresh();
  const invocation = { sessionId: "admission-session" };
  const project = process.cwd();
  await coordinator.hooks.onUserPromptSubmitted({
    sessionId: invocation.sessionId,
    workingDirectory: project,
    prompt: "coordinate safely",
  }, invocation);
  const secret = "private-admission-secret";
  const input = {
    sessionId: invocation.sessionId,
    workingDirectory: project,
    toolName: "task",
    toolArgs: { agent_type: crafter, prompt: `implement token=${secret}` },
  };

  const denied = await coordinator.hooks.onPreToolUse(input, invocation);
  assert.equal(denied?.permissionDecision, "deny");
  assert.match(denied?.permissionDecisionReason ?? "", /already working/u);
  assert.equal(observed[0].project, project);
  assert.equal(observed[0].agent, "crafter");
  assert.match(observed[0].taskLabel, /token=\[redacted\]/u);
  assert.equal(observed[0].taskLabel.includes(secret), false);

  const accepted = await coordinator.hooks.onPreToolUse(input, invocation);
  assert.equal(accepted?.permissionDecision, "allow");
  assert.equal(attempts, 2, "the rejected admission must not leave the session in flight");
  assert.equal(observed[1].parentRunId, observed[0].parentRunId);
  await coordinator.hooks.onPostToolUseFailure({ ...input, error: "expected test cleanup" }, invocation);
});

test("Copilot lifecycle closes inferred children and cancelled roots without error bodies", async () => {
  const teamLead = copilotFixedAgentIds.get("team-lead")!;
  const crafter = copilotFixedAgentIds.get("crafter")!;
  const agents = [...copilotFixedAgentIds.values()].map((id) => ({ id, userInvocable: true }));
  const lifecycle: CopilotCoordinatorLifecycleEvent[] = [];
  const coordinator = createCopilotCoordinatorGuard(() => ({ rpc: { agent: {
    getCurrent: async () => ({ agent: { id: teamLead } }),
    reload: async () => ({ agents }),
  } } }), undefined, (event) => { lifecycle.push(event); });
  await coordinator.refresh();
  const invocation = { sessionId: "inferred-session" };
  await coordinator.hooks.onUserPromptSubmitted({
    sessionId: invocation.sessionId,
    workingDirectory: process.cwd(),
    prompt: "coordinate the fallback",
  }, invocation);
  const input = {
    sessionId: invocation.sessionId,
    workingDirectory: process.cwd(),
    toolName: "task",
    toolArgs: { agent_type: crafter, prompt: "attempt the child" },
  };
  assert.equal((await coordinator.hooks.onPreToolUse(input, invocation))?.permissionDecision, "allow");
  await coordinator.hooks.onPostToolUseFailure({ ...input, error: "PRIVATE PROVIDER ERROR BODY" }, invocation);
  coordinator.observeEvent({ type: "session.idle", id: "cancelled-idle", data: { aborted: true } });

  const childStart = lifecycle.find((event) => event.type === "child.started");
  const childFinish = lifecycle.find((event) => event.type === "run.finished" && event.kind === "child");
  const rootFinish = lifecycle.find((event) => event.type === "run.finished" && event.kind === "root");
  assert.ok(childStart && childFinish && rootFinish);
  assert.equal(childStart.basis, "inferred");
  assert.equal(childStart.childId, undefined);
  assert.equal(childFinish.runId, childStart.runId);
  assert.equal(childFinish.outcome, "failed");
  assert.equal(childFinish.basis, "inferred");
  assert.equal(rootFinish.outcome, "cancelled");
  assert.equal(rootFinish.eventId, "cancelled-idle");
  assert.equal(JSON.stringify(lifecycle).includes("PRIVATE PROVIDER ERROR BODY"), false);
});

test("Copilot coordinator ignores an older refresh that settles after a newer registry snapshot", async () => {
  const teamLead = copilotFixedAgentIds.get("team-lead")!;
  const crafter = copilotFixedAgentIds.get("crafter")!;
  let reloadCalls = 0;
  let announceOldStarted!: () => void;
  let releaseOld!: (value: { agents: Array<{ id: string; userInvocable: boolean }> }) => void;
  const oldStarted = new Promise<void>((resolve) => { announceOldStarted = resolve; });
  const oldReload = new Promise<{ agents: Array<{ id: string; userInvocable: boolean }> }>((resolve) => {
    releaseOld = resolve;
  });
  const coordinator = createCopilotCoordinatorGuard(() => ({ rpc: { agent: {
    getCurrent: async () => ({ agent: { id: teamLead, userInvocable: true } }),
    reload: async () => {
      reloadCalls += 1;
      if (reloadCalls === 1) {
        announceOldStarted();
        return oldReload;
      }
      return { agents: [
        { id: teamLead, userInvocable: true },
        { id: crafter, userInvocable: true },
      ] };
    },
  } } }));

  const older = coordinator.refresh();
  await oldStarted;
  await coordinator.refresh();
  releaseOld({ agents: [{ id: teamLead, userInvocable: true }] });
  await older;

  const invocation = { sessionId: "refresh-generation-session" };
  const input = {
    sessionId: invocation.sessionId,
    workingDirectory: process.cwd(),
    toolName: "task",
    toolArgs: { agent_type: crafter, prompt: "use the newest registry" },
  };
  await coordinator.hooks.onUserPromptSubmitted({
    sessionId: invocation.sessionId,
    workingDirectory: process.cwd(),
    prompt: "coordinate",
  }, invocation);
  assert.equal((await coordinator.hooks.onPreToolUse(input, invocation))?.permissionDecision, "allow");
  await coordinator.hooks.onPostToolUseFailure({ ...input, error: "cleanup" }, invocation);
});

test("Copilot selection synchronization fails closed when superseded or changed during reload", async () => {
  const teamLead = copilotFixedAgentIds.get("team-lead")!;
  const agents = [...copilotFixedAgentIds.values()].map((id) => ({ id, userInvocable: true }));
  let firstReload = true;
  let releaseSuperseded!: () => void;
  let announceSuperseded!: () => void;
  const supersededStarted = new Promise<void>((resolve) => { announceSuperseded = resolve; });
  const supersededGate = new Promise<void>((resolve) => { releaseSuperseded = resolve; });
  const superseded = createCopilotCoordinatorGuard(() => ({ rpc: { agent: {
    getCurrent: async () => ({ agent: { id: teamLead, userInvocable: true } }),
    reload: async () => {
      if (firstReload) {
        firstReload = false;
        announceSuperseded();
        await supersededGate;
      }
      return { agents };
    },
  } } }));
  const expectedRefresh = superseded.refresh(teamLead);
  await supersededStarted;
  await superseded.refresh();
  releaseSuperseded();
  await assert.rejects(expectedRefresh, /selection synchronization was superseded/u);

  let releaseChanged!: () => void;
  let announceChanged!: () => void;
  const changedStarted = new Promise<void>((resolve) => { announceChanged = resolve; });
  const changedGate = new Promise<void>((resolve) => { releaseChanged = resolve; });
  const changed = createCopilotCoordinatorGuard(() => ({ rpc: { agent: {
    getCurrent: async () => ({ agent: { id: teamLead, userInvocable: true } }),
    reload: async () => {
      announceChanged();
      await changedGate;
      return { agents };
    },
  } } }));
  const changedRefresh = changed.refresh(teamLead);
  await changedStarted;
  changed.observeEvent({ type: "subagent.deselected" });
  releaseChanged();
  await assert.rejects(changedRefresh, /selected agent changed/u);
});

test("Copilot task guard reads manual selection authoritatively without intercepting third-party agents", async () => {
  const teamLead = copilotFixedAgentIds.get("team-lead")!;
  const crafter = copilotFixedAgentIds.get("crafter")!;
  const agents = [...copilotFixedAgentIds.values()].map((id) => ({ id, userInvocable: true }));
  let current: { id: string; userInvocable: boolean } | undefined;
  const lifecycle: CopilotCoordinatorLifecycleEvent[] = [];
  const coordinator = createCopilotCoordinatorGuard(() => ({ rpc: { agent: {
    getCurrent: async () => ({ agent: current }),
    reload: async () => ({ agents }),
  } } }), undefined, (event) => { lifecycle.push(event); });
  await coordinator.refresh();
  current = { id: teamLead, userInvocable: true };
  const invocation = { sessionId: "manual-selection-event-lag" };
  const base = { sessionId: invocation.sessionId, workingDirectory: process.cwd() };
  await coordinator.hooks.onUserPromptSubmitted({ ...base, prompt: "manually selected lead" }, invocation);
  coordinator.observeEvent({
    type: "assistant.usage",
    id: "manual-lead-first-usage",
    data: { serviceRequestId: "manual-lead-service", model: "manual-lead-model", inputTokens: 9, outputTokens: 2 },
  });
  assert.ok(lifecycle.some((event) => event.type === "root.started" && event.agent === "team-lead"),
    "manual team-lead selection lag lost the root before its first usage");
  assert.ok(lifecycle.some((event) => event.type === "run.usage" && event.kind === "root" && event.usage.totalTokens === 11),
    "the first team-lead usage before preTool was lost");
  const decision = await coordinator.hooks.onPreToolUse({
    ...base,
    toolName: "task",
    toolArgs: { agent_type: "totally-unmanaged", prompt: "must not bypass" },
  }, invocation);
  assert.equal(decision?.permissionDecision, "deny");
  assert.match(decision?.permissionDecisionReason ?? "", /player is not active/u);

  let specialistCurrent: { id: string; userInvocable: boolean } | undefined;
  const specialistLifecycle: CopilotCoordinatorLifecycleEvent[] = [];
  const specialist = createCopilotCoordinatorGuard(() => ({ rpc: { agent: {
    getCurrent: async () => ({ agent: specialistCurrent }),
    reload: async () => ({ agents }),
  } } }), undefined, (event) => { specialistLifecycle.push(event); });
  await specialist.refresh();
  specialistCurrent = { id: crafter, userInvocable: true };
  const specialistInvocation = { sessionId: "manual-specialist-event-lag" };
  await specialist.hooks.onUserPromptSubmitted({
    sessionId: specialistInvocation.sessionId,
    workingDirectory: process.cwd(),
    prompt: "manually selected specialist with no task tool",
  }, specialistInvocation);
  specialist.observeEvent({
    type: "assistant.usage",
    id: "manual-specialist-usage",
    data: { providerCallId: "manual-specialist-provider", model: "manual-specialist-model", inputTokens: 7, outputTokens: 1 },
  });
  specialist.observeEvent({ type: "session.idle", id: "manual-specialist-idle", data: { aborted: false } });
  assert.ok(specialistLifecycle.some((event) => event.type === "root.started" && event.agent === "crafter"));
  assert.ok(specialistLifecycle.some((event) => event.type === "run.usage" && event.usage.totalTokens === 8));
  assert.ok(specialistLifecycle.some((event) => event.type === "run.finished" && event.outcome === "completed"));

  const fallbackLifecycle: CopilotCoordinatorLifecycleEvent[] = [];
  let fallbackCurrentReads = 0;
  const fallback = createCopilotCoordinatorGuard(() => ({ rpc: { agent: {
    getCurrent: async () => {
      fallbackCurrentReads += 1;
      if (fallbackCurrentReads === 1) return { agent: undefined };
      throw new Error("best-effort observation unavailable");
    },
    reload: async () => ({ agents }),
  } } }), undefined, (event) => { fallbackLifecycle.push(event); });
  await fallback.refresh();
  fallback.observeEvent({ type: "subagent.selected", data: { agentName: "team-lead" } });
  await fallback.hooks.onUserPromptSubmitted({
    sessionId: "manual-selection-fallback",
    workingDirectory: process.cwd(),
    prompt: "use the observed snapshot",
  }, { sessionId: "manual-selection-fallback" });
  assert.ok(fallbackLifecycle.some((event) => event.type === "root.started" && event.agent === "team-lead"),
    "a best-effort getCurrent failure discarded a valid native selection snapshot");

  const previousRpcTimeout = process.env.AGENT_HARBOR_COPILOT_RPC_TIMEOUT_MS;
  process.env.AGENT_HARBOR_COPILOT_RPC_TIMEOUT_MS = "250";
  try {
    const boundedLifecycle: CopilotCoordinatorLifecycleEvent[] = [];
    let boundedCurrentReads = 0;
    const bounded = createCopilotCoordinatorGuard(() => ({ rpc: { agent: {
      getCurrent: async () => {
        boundedCurrentReads += 1;
        return boundedCurrentReads === 1 ? { agent: undefined } : new Promise<never>(() => {});
      },
      reload: async () => ({ agents }),
    } } }), undefined, (event) => { boundedLifecycle.push(event); });
    await bounded.refresh();
    bounded.observeEvent({ type: "subagent.selected", data: { agentName: "team-lead" } });
    const startedAt = Date.now();
    await bounded.hooks.onUserPromptSubmitted({
      sessionId: "manual-selection-bounded-fallback",
      workingDirectory: process.cwd(),
      prompt: "do not delay the user prompt",
    }, { sessionId: "manual-selection-bounded-fallback" });
    assert.ok(Date.now() - startedAt < 1_000, "best-effort prompt observation inherited the 15s guard timeout");
    assert.ok(boundedLifecycle.some((event) => event.type === "root.started" && event.agent === "team-lead"));
  } finally {
    if (previousRpcTimeout === undefined) delete process.env.AGENT_HARBOR_COPILOT_RPC_TIMEOUT_MS;
    else process.env.AGENT_HARBOR_COPILOT_RPC_TIMEOUT_MS = previousRpcTimeout;
  }

  let releaseRead!: () => void;
  let announceRead!: () => void;
  const readStarted = new Promise<void>((resolve) => { announceRead = resolve; });
  const readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
  const racedLifecycle: CopilotCoordinatorLifecycleEvent[] = [];
  let racedCurrentReads = 0;
  const raced = createCopilotCoordinatorGuard(() => ({ rpc: { agent: {
    getCurrent: async () => {
      racedCurrentReads += 1;
      if (racedCurrentReads === 1) return { agent: undefined };
      announceRead();
      await readGate;
      return { agent: { id: teamLead, userInvocable: true } };
    },
    reload: async () => ({ agents }),
  } } }), undefined, (event) => { racedLifecycle.push(event); });
  await raced.refresh();
  const racedPrompt = raced.hooks.onUserPromptSubmitted({
    sessionId: "manual-selection-race",
    workingDirectory: process.cwd(),
    prompt: "preserve the newer selection event",
  }, { sessionId: "manual-selection-race" });
  await readStarted;
  raced.observeEvent({ type: "subagent.selected", data: { agentName: "crafter" } });
  releaseRead();
  await racedPrompt;
  assert.ok(racedLifecycle.some((event) => event.type === "root.started" && event.agent === "crafter"),
    "an older getCurrent read overwrote a newer native selection generation");

  let thirdPartyReloads = 0;
  const thirdParty = createCopilotCoordinatorGuard(() => ({ rpc: { agent: {
    getCurrent: async () => ({ agent: { id: "third-party:ordinary-agent", userInvocable: true } }),
    reload: async () => {
      thirdPartyReloads += 1;
      throw new Error("registry unavailable");
    },
  } } }));
  const unrelated = await thirdParty.hooks.onPreToolUse({
    sessionId: "third-party-session",
    workingDirectory: process.cwd(),
    toolName: "task",
    toolArgs: { agent_type: "third-party:worker", prompt: "unrelated delegation" },
  }, { sessionId: "third-party-session" });
  assert.equal(unrelated, undefined, "Agent Harbor intercepted a task from a non-Harbor coordinator");
  assert.equal(thirdPartyReloads, 0, "third-party delegation unnecessarily depended on Harbor registry reload");

  const unverifiable = createCopilotCoordinatorGuard(() => ({ rpc: { agent: {
    getCurrent: async () => { throw new Error("current agent unavailable"); },
    reload: async () => ({ agents }),
  } } }));
  const failClosed = await unverifiable.hooks.onPreToolUse({
    sessionId: "unknown-session",
    workingDirectory: process.cwd(),
    toolName: "task",
    toolArgs: { agent_type: "anything", prompt: "cannot classify safely" },
  }, { sessionId: "unknown-session" });
  assert.equal(failClosed?.permissionDecision, "deny");
  assert.match(failClosed?.permissionDecisionReason ?? "", /fails closed/u);
});

test("Copilot ignores stale session.idle until the current root has native activity and a current terminal", async () => {
  const teamLead = copilotFixedAgentIds.get("team-lead")!;
  const agents = [...copilotFixedAgentIds.values()].map((id) => ({ id, userInvocable: true }));
  const lifecycle: CopilotCoordinatorLifecycleEvent[] = [];
  const coordinator = createCopilotCoordinatorGuard(() => ({ rpc: { agent: {
    getCurrent: async () => ({ agent: { id: teamLead, userInvocable: true } }),
    reload: async () => ({ agents }),
  } } }), undefined, (event) => { lifecycle.push(event); });
  await coordinator.refresh();
  const sessionId = "stale-idle-fence";
  await coordinator.hooks.onUserPromptSubmitted({
    sessionId,
    workingDirectory: process.cwd(),
    prompt: "observe the current turn",
  }, { sessionId });

  coordinator.observeEvent({
    type: "session.idle",
    id: "stale-idle-without-activity",
    parentId: "previous-root-event",
    data: { aborted: false },
  });
  assert.equal(lifecycle.some((event) => event.type === "run.finished"), false,
    "an idle preceding all current-root activity terminated the new mission");

  coordinator.observeEvent({
    type: "assistant.turn_start",
    id: "current-root-turn",
    parentId: "previous-root-event",
    timestamp: new Date(Date.now() + 500).toISOString(),
    data: { turnId: "current-root-turn", model: "current-model" },
  });
  coordinator.observeEvent({
    type: "assistant.usage",
    id: "delayed-old-usage",
    parentId: "previous-root-event",
    timestamp: new Date(Date.now() - 60_000).toISOString(),
    data: { apiCallId: "old-root-api", model: "old-model", inputTokens: 900, outputTokens: 90 },
  });
  coordinator.observeEvent({
    type: "session.error",
    id: "delayed-old-error",
    parentId: "previous-root-event",
    timestamp: new Date(Date.now() - 59_000).toISOString(),
    data: { message: "PRIVATE OLD ERROR" },
  });
  assert.equal(lifecycle.some((event) => event.type === "run.finished"), false,
    "a delayed prior-run error failed the current mission");
  coordinator.observeEvent({
    type: "assistant.usage",
    id: "current-root-usage-1",
    parentId: "current-root-turn",
    timestamp: new Date(Date.now() + 1_000).toISOString(),
    data: { apiCallId: "current-root-api-1", model: "current-model", inputTokens: 50, outputTokens: 5 },
  });
  coordinator.observeEvent({
    type: "session.idle",
    id: "delayed-old-idle",
    parentId: "previous-root-event",
    timestamp: new Date(Date.now() - 60_000).toISOString(),
    data: { aborted: false },
  });
  assert.equal(lifecycle.some((event) => event.type === "run.finished"), false,
    "an old timestamped idle terminated a root after current activity");
  coordinator.observeEvent({
    type: "session.idle",
    id: "delayed-old-aborted-idle",
    parentId: "previous-root-event",
    timestamp: new Date(Date.now() - 59_000).toISOString(),
    data: { aborted: true },
  });
  assert.equal(lifecycle.some((event) => event.type === "run.finished"), false,
    "an aborted idle from the prior mission cancelled the current root");

  coordinator.observeEvent({
    type: "assistant.usage",
    id: "current-root-usage-2",
    parentId: "current-root-usage-1",
    timestamp: new Date(Date.now() + 1_500).toISOString(),
    data: { apiCallId: "current-root-api-2", model: "current-model", inputTokens: 20, outputTokens: 2 },
  });

  coordinator.observeEvent({
    type: "session.idle",
    id: "current-idle",
    parentId: "current-root-usage-2",
    timestamp: new Date(Date.now() + 2_000).toISOString(),
    data: { aborted: false },
  });
  const finishes = lifecycle.filter((event) => event.type === "run.finished" && event.kind === "root");
  assert.equal(finishes.length, 1);
  assert.equal(finishes[0].eventId, "current-idle");
  const usage = lifecycle.filter((event) => event.type === "run.usage" && event.kind === "root");
  assert.deepEqual(usage.map((event) => event.usage.totalTokens), [55, 22]);
  assert.equal(JSON.stringify(lifecycle).includes("old-model"), false);
  assert.equal(new Set(usage.map((event) => event.runId)).size, 1, "stale idle split one root mission");
});

test("Copilot admits the first current event once and keeps child-scoped defaults out of later roots", async () => {
  const teamLead = copilotFixedAgentIds.get("team-lead")!;
  const agents = [{ id: teamLead, userInvocable: true, model: "host-A" }];
  const lifecycle: CopilotCoordinatorLifecycleEvent[] = [];
  const coordinator = createCopilotCoordinatorGuard(() => ({ rpc: { agent: {
    getCurrent: async () => ({ agent: agents[0] }),
    reload: async () => ({ agents }),
  } } }), undefined, (event) => { lifecycle.push(event); });
  coordinator.observeEvent({
    type: "session.start", id: "root-defaults", data: { selectedModel: "host-A", reasoningEffort: "low" },
  });
  await coordinator.refresh();
  const firstSession = "first-current-event";
  await coordinator.hooks.onUserPromptSubmitted({
    sessionId: firstSession, workingDirectory: process.cwd(), prompt: "observe first chain event",
  }, { sessionId: firstSession });
  const startedAt = Date.now() + 1_000;
  coordinator.observeEvent({
    type: "assistant.turn_start", id: "first-current-turn", parentId: "unknown-prior-chain-parent",
    timestamp: new Date(startedAt).toISOString(), data: { turnId: "first-current-turn", model: "host-A" },
  });
  coordinator.observeEvent({
    type: "session.model_change", id: "same-current-model", parentId: "first-current-turn",
    timestamp: new Date(startedAt + 1).toISOString(), data: { newModel: "host-A", reasoningEffort: "low" },
  });
  coordinator.observeEvent({
    type: "session.idle", id: "first-current-idle", parentId: "same-current-model",
    timestamp: new Date(startedAt + 2).toISOString(), data: { aborted: false },
  });
  assert.ok(lifecycle.some((event) => event.type === "run.model" && event.eventId === "first-current-turn" && event.model === "host-A"),
    "the already-admitted first event was rejected by its type-specific observer");
  assert.ok(lifecycle.some((event) => event.type === "run.reasoning" && event.eventId === "same-current-model" && event.reasoningEffort === "low"));
  assert.equal(lifecycle.find((event) => event.type === "run.finished" && event.kind === "root")?.eventId, "first-current-idle");

  coordinator.observeEvent({
    type: "session.start", id: "child-session-start-agent", agentId: "native-child",
    data: { selectedModel: "child-B", reasoningEffort: "high", initiator: "sub-agent" },
  });
  coordinator.observeEvent({
    type: "session.start", id: "child-session-start-parent",
    data: { selectedModel: "child-C", reasoningEffort: "high", parentToolCallId: "parent-task" },
  });
  coordinator.observeEvent({
    type: "session.model_change", id: "child-model-change-initiator",
    data: { newModel: "child-D", reasoningEffort: "high", initiator: "sub-agent" },
  });
  coordinator.observeEvent({
    type: "session.model_change", id: "child-model-change-parent",
    data: { newModel: "child-E", reasoningEffort: "high", parentToolCallId: "parent-task" },
  });
  const secondSession = "root-after-child-defaults";
  await coordinator.hooks.onUserPromptSubmitted({
    sessionId: secondSession, workingDirectory: process.cwd(), prompt: "inherit only root defaults",
  }, { sessionId: secondSession });
  const roots = lifecycle.filter((event) => event.type === "root.started");
  assert.equal(roots.at(-1)?.model, "host-A");
  assert.equal(roots.at(-1)?.reasoningEffort, "low");
  assert.doesNotMatch(JSON.stringify(lifecycle), /child-[BCDE]/u);
});

test("Copilot treats a root-scoped model change as activity so idle closes the mission", async () => {
  const teamLead = copilotFixedAgentIds.get("team-lead")!;
  const agents = [{ id: teamLead, userInvocable: true, model: "host-A" }];
  const lifecycle: CopilotCoordinatorLifecycleEvent[] = [];
  const coordinator = createCopilotCoordinatorGuard(() => ({ rpc: { agent: {
    getCurrent: async () => ({ agent: agents[0] }),
    reload: async () => ({ agents }),
  } } }), undefined, (event) => { lifecycle.push(event); });
  await coordinator.refresh();
  const firstSession = "model-only-root";
  await coordinator.hooks.onUserPromptSubmitted({
    sessionId: firstSession, workingDirectory: process.cwd(), prompt: "change the model only",
  }, { sessionId: firstSession });
  const eventTime = Date.now() + 1_000;
  coordinator.observeEvent({
    type: "session.model_change", id: "model-only-change", parentId: "unknown-current-parent",
    timestamp: new Date(eventTime).toISOString(), data: { newModel: "host-B", reasoningEffort: "high" },
  });
  coordinator.observeEvent({
    type: "session.idle", id: "model-only-idle", parentId: "model-only-change",
    timestamp: new Date(eventTime + 1).toISOString(), data: { aborted: false },
  });
  assert.equal(lifecycle.find((event) => event.type === "run.finished" && event.kind === "root")?.eventId,
    "model-only-idle");

  await coordinator.hooks.onUserPromptSubmitted({
    sessionId: "root-after-model-only", workingDirectory: process.cwd(), prompt: "start a fresh mission",
  }, { sessionId: "root-after-model-only" });
  const roots = lifecycle.filter((event) => event.type === "root.started");
  assert.equal(roots.length, 2);
  assert.notEqual(roots[0].runId, roots[1].runId);
});

test("Copilot host-event replays and older model observations cannot revert current telemetry", async () => {
  const teamLead = copilotFixedAgentIds.get("team-lead")!;
  const agents = [{ id: teamLead, userInvocable: true }];
  const lifecycle: CopilotCoordinatorLifecycleEvent[] = [];
  const coordinator = createCopilotCoordinatorGuard(() => ({ rpc: { agent: {
    getCurrent: async () => ({ agent: agents[0] }),
    reload: async () => ({ agents }),
  } } }), undefined, (event) => { lifecycle.push(event); });
  const base = Date.now() + 1_000;
  coordinator.observeEvent({
    type: "session.start", id: "ordered-session-start", timestamp: new Date(base).toISOString(),
    data: { selectedModel: "model-initial", reasoningEffort: "none" },
  });
  await coordinator.refresh();
  await coordinator.hooks.onUserPromptSubmitted({
    sessionId: "ordered-model-root", workingDirectory: process.cwd(), prompt: "observe ordered telemetry",
  }, { sessionId: "ordered-model-root" });
  const turn = {
    type: "assistant.turn_start", id: "ordered-turn", parentId: "ordered-session-start",
    timestamp: new Date(base + 10).toISOString(), data: { turnId: "ordered-turn", model: "model-initial" },
  } as const;
  coordinator.observeEvent(turn);
  const afterTurn = lifecycle.length;
  coordinator.observeEvent(turn);
  assert.equal(lifecycle.length, afterTurn, "an exact turn replay emitted lifecycle twice");

  const modelA = {
    type: "session.model_change", id: "ordered-model-A", parentId: "ordered-turn",
    timestamp: new Date(base + 20).toISOString(), data: { newModel: "model-A", reasoningEffort: "low" },
  } as const;
  coordinator.observeEvent(modelA);
  coordinator.observeEvent({
    type: "session.model_change", id: "ordered-model-B", parentId: "ordered-model-A",
    timestamp: new Date(base + 40).toISOString(), data: { newModel: "model-B", reasoningEffort: "high" },
  });
  const beforeReplay = lifecycle.length;
  coordinator.observeEvent(modelA);
  assert.equal(lifecycle.length, beforeReplay, "an exact model replay emitted or reverted lifecycle state");
  coordinator.observeEvent({
    type: "session.model_change", id: "ordered-model-C", parentId: "ordered-model-A",
    timestamp: new Date(base + 30).toISOString(), data: { newModel: "model-C", reasoningEffort: "medium" },
  });
  assert.equal(lifecycle.some((event) => event.type === "run.model" && event.model === "model-C"), false);
  assert.equal(lifecycle.some((event) => event.type === "run.reasoning" && event.reasoningEffort === "medium"), false);

  const usage = {
    type: "assistant.usage", id: "ordered-usage", parentId: "ordered-model-B",
    timestamp: new Date(base + 50).toISOString(), data: { apiCallId: "ordered-call", inputTokens: 8, outputTokens: 2 },
  } as const;
  coordinator.observeEvent(usage);
  coordinator.observeEvent(usage);
  const observedUsage = lifecycle.filter((event) => event.type === "run.usage");
  assert.equal(observedUsage.length, 1);
  assert.equal(observedUsage[0].model, "model-B");
  assert.equal(observedUsage[0].reasoningEffort, "high");
  const idle = {
    type: "session.idle", id: "ordered-idle", parentId: "ordered-usage",
    timestamp: new Date(base + 60).toISOString(), data: { aborted: false },
  } as const;
  coordinator.observeEvent(idle);
  coordinator.observeEvent(idle);
  assert.equal(lifecycle.filter((event) => event.type === "run.finished" && event.kind === "root").length, 1);

  await coordinator.hooks.onUserPromptSubmitted({
    sessionId: "root-after-ordered-models", workingDirectory: process.cwd(), prompt: "inherit latest settings",
  }, { sessionId: "root-after-ordered-models" });
  const latestRoot = lifecycle.filter((event) => event.type === "root.started").at(-1);
  assert.equal(latestRoot?.model, "model-B");
  assert.equal(latestRoot?.reasoningEffort, "high");
});

test("Copilot state timestamps reject an early replay after the bounded global event cache rotates", async () => {
  const teamLead = copilotFixedAgentIds.get("team-lead")!;
  const agents = [{ id: teamLead, userInvocable: true }];
  const lifecycle: CopilotCoordinatorLifecycleEvent[] = [];
  const coordinator = createCopilotCoordinatorGuard(() => ({ rpc: { agent: {
    getCurrent: async () => ({ agent: agents[0] }),
    reload: async () => ({ agents }),
  } } }), undefined, (event) => { lifecycle.push(event); });
  await coordinator.refresh();
  await coordinator.hooks.onUserPromptSubmitted({
    sessionId: "rotated-event-cache", workingDirectory: process.cwd(), prompt: "test bounded replay state",
  }, { sessionId: "rotated-event-cache" });
  const base = Date.now() + 1_000;
  const earlyTurn = {
    type: "assistant.turn_start", id: "rotated-early-turn", parentId: null,
    timestamp: new Date(base).toISOString(), data: { turnId: "rotated-early-turn", model: "model-A" },
  } as const;
  coordinator.observeEvent(earlyTurn);
  coordinator.observeEvent({
    type: "assistant.idle", id: "rotated-current-idle", parentId: "rotated-early-turn",
    timestamp: new Date(base + 100).toISOString(), data: {},
  });
  for (let index = 0; index < 4_100; index += 1) {
    coordinator.observeEvent({ type: "diagnostic.noop", id: `rotated-noop-${index}`, data: {} });
  }
  const beforeReplay = lifecycle.length;
  coordinator.observeEvent(earlyTurn);
  assert.equal(lifecycle.length, beforeReplay, "an evicted early turn replay resurrected idle work");
  const states = lifecycle.filter((event) => event.type === "run.state");
  assert.equal(states.at(-1)?.state, "idle");
});

test("Copilot same-timestamp model identities survive global cache rotation without reverting defaults", async () => {
  const teamLead = copilotFixedAgentIds.get("team-lead")!;
  const agents = [{ id: teamLead, userInvocable: true }];
  const lifecycle: CopilotCoordinatorLifecycleEvent[] = [];
  const coordinator = createCopilotCoordinatorGuard(() => ({ rpc: { agent: {
    getCurrent: async () => ({ agent: agents[0] }),
    reload: async () => ({ agents }),
  } } }), undefined, (event) => { lifecycle.push(event); });
  const base = Date.now() + 1_000;
  coordinator.observeEvent({
    type: "session.start", id: "same-ms-default-start", timestamp: new Date(base).toISOString(),
    data: { selectedModel: "default-A", reasoningEffort: "low" },
  });
  await coordinator.refresh();
  await coordinator.hooks.onUserPromptSubmitted({
    sessionId: "same-ms-model-root", workingDirectory: process.cwd(), prompt: "observe tied model changes",
  }, { sessionId: "same-ms-model-root" });
  coordinator.observeEvent({
    type: "assistant.turn_start", id: "same-ms-turn", parentId: "same-ms-default-start",
    timestamp: new Date(base + 10).toISOString(), data: { turnId: "same-ms-turn", model: "default-A" },
  });
  const tiedAt = new Date(base + 20).toISOString();
  const modelA = {
    type: "session.model_change", id: "same-ms-model-A", parentId: "same-ms-turn", timestamp: tiedAt,
    data: { newModel: "default-A", reasoningEffort: "low" },
  } as const;
  coordinator.observeEvent(modelA);
  coordinator.observeEvent({
    type: "session.model_change", id: "same-ms-model-B", parentId: "same-ms-model-A", timestamp: tiedAt,
    data: { newModel: "default-B", reasoningEffort: "high" },
  });
  for (let index = 0; index < 4_100; index += 1) {
    coordinator.observeEvent({ type: "diagnostic.same-ms-noop", id: `same-ms-noop-${index}`, data: {} });
  }
  const beforeReplay = lifecycle.length;
  coordinator.observeEvent(modelA);
  assert.equal(lifecycle.length, beforeReplay, "an evicted same-time A replay reverted the active run");
  const rootModels = lifecycle.filter((event) => event.type === "run.model" && event.kind === "root");
  const rootReasoning = lifecycle.filter((event) => event.type === "run.reasoning" && event.kind === "root");
  assert.equal(rootModels.at(-1)?.model, "default-B");
  assert.equal(rootReasoning.at(-1)?.reasoningEffort, "high");
  coordinator.observeEvent({
    type: "session.idle", id: "same-ms-idle", parentId: "same-ms-noop-4099",
    timestamp: new Date(base + 30).toISOString(), data: { aborted: false },
  });
  await coordinator.hooks.onUserPromptSubmitted({
    sessionId: "root-after-same-ms", workingDirectory: process.cwd(), prompt: "inherit tied winner",
  }, { sessionId: "root-after-same-ms" });
  const nextRoot = lifecycle.filter((event) => event.type === "root.started").at(-1);
  assert.equal(nextRoot?.model, "default-B");
  assert.equal(nextRoot?.reasoningEffort, "high");
});

test("Copilot selection timestamps reject an evicted selected replay after a newer deselection", async () => {
  const teamLead = copilotFixedAgentIds.get("team-lead")!;
  const agents = [{ id: teamLead, userInvocable: true }];
  let currentReadFails = false;
  const lifecycle: CopilotCoordinatorLifecycleEvent[] = [];
  const coordinator = createCopilotCoordinatorGuard(() => ({ rpc: { agent: {
    getCurrent: async () => {
      if (currentReadFails) throw new Error("current selection unavailable");
      return { agent: undefined };
    },
    reload: async () => ({ agents }),
  } } }), undefined, (event) => { lifecycle.push(event); });
  await coordinator.refreshAuthoritative();
  const base = Date.now() + 1_000;
  const selected = {
    type: "subagent.selected", id: "rotated-selected", timestamp: new Date(base).toISOString(),
    data: { agentName: "team-lead" },
  } as const;
  coordinator.observeEvent(selected);
  coordinator.observeEvent({
    type: "subagent.deselected", id: "newer-deselected", timestamp: new Date(base + 100).toISOString(), data: {},
  });
  for (let index = 0; index < 4_100; index += 1) {
    coordinator.observeEvent({ type: "diagnostic.selection-noop", id: `selection-noop-${index}`, data: {} });
  }
  coordinator.observeEvent(selected);
  currentReadFails = true;
  await coordinator.hooks.onUserPromptSubmitted({
    sessionId: "selection-after-rotation", workingDirectory: process.cwd(), prompt: "must remain unselected",
  }, { sessionId: "selection-after-rotation" });
  assert.equal(lifecycle.some((event) => event.type === "root.started"), false,
    "an evicted selected replay resurrected a deselected player during RPC outage");

  let sameTimeReadFails = false;
  const sameTimeLifecycle: CopilotCoordinatorLifecycleEvent[] = [];
  const sameTime = createCopilotCoordinatorGuard(() => ({ rpc: { agent: {
    getCurrent: async () => {
      if (sameTimeReadFails) throw new Error("current selection unavailable");
      return { agent: undefined };
    },
    reload: async () => ({ agents }),
  } } }), undefined, (event) => { sameTimeLifecycle.push(event); });
  await sameTime.refreshAuthoritative();
  const tiedAt = new Date(base + 500).toISOString();
  const tiedDeselected = { type: "subagent.deselected", id: "tied-deselected", timestamp: tiedAt, data: {} } as const;
  sameTime.observeEvent(tiedDeselected);
  sameTime.observeEvent({
    type: "subagent.selected", id: "tied-selected", timestamp: tiedAt, data: { agentName: "team-lead" },
  });
  for (let index = 0; index < 4_100; index += 1) {
    sameTime.observeEvent({ type: "diagnostic.selection-tie-noop", id: `selection-tie-noop-${index}`, data: {} });
  }
  sameTime.observeEvent(tiedDeselected);
  sameTimeReadFails = true;
  await sameTime.hooks.onUserPromptSubmitted({
    sessionId: "same-time-selected", workingDirectory: process.cwd(), prompt: "new same-time selection wins",
  }, { sessionId: "same-time-selected" });
  assert.equal(sameTimeLifecycle.filter((event) => event.type === "root.started").at(-1)?.agent, "team-lead");
});

test("Copilot critical ownership survives cache rotation across roots and future-skewed usage", async () => {
  const teamLead = copilotFixedAgentIds.get("team-lead")!;
  const agents = [{ id: teamLead, userInvocable: true }];
  const lifecycle: CopilotCoordinatorLifecycleEvent[] = [];
  const coordinator = createCopilotCoordinatorGuard(() => ({ rpc: { agent: {
    getCurrent: async () => ({ agent: agents[0] }),
    reload: async () => ({ agents }),
  } } }), undefined, (event) => { lifecycle.push(event); });
  await coordinator.refresh();
  const sessionId = "critical-cross-root";
  await coordinator.hooks.onUserPromptSubmitted({
    sessionId, workingDirectory: process.cwd(), prompt: "mission A",
  }, { sessionId });
  const rootA = lifecycle.filter((event) => event.type === "root.started").at(-1)!;
  const turnA = {
    type: "assistant.turn_start", id: "critical-turn-A",
    data: { turnId: "1", model: "model-A" },
  } as const;
  const modelA = {
    type: "session.model_change", id: "critical-model-A",
    data: { newModel: "model-A", reasoningEffort: "low" },
  } as const;
  const usageA = {
    type: "assistant.usage", id: "critical-usage-A",
    timestamp: new Date(Date.now() + 60_000).toISOString(),
    data: { apiCallId: "critical-api-A", model: "model-A", inputTokens: 100, outputTokens: 10 },
  } as const;
  coordinator.observeEvent(turnA);
  coordinator.observeEvent(modelA);
  coordinator.observeEvent(usageA);
  coordinator.observeEvent({ type: "session.idle", id: "critical-idle-A", data: { aborted: false } });
  assert.ok(lifecycle.some((event) => event.type === "run.finished" && event.runId === rootA.runId));

  await coordinator.hooks.onUserPromptSubmitted({
    sessionId, workingDirectory: process.cwd(), prompt: "mission B",
  }, { sessionId });
  const rootB = lifecycle.filter((event) => event.type === "root.started").at(-1)!;
  const turnB = {
    type: "assistant.turn_start", id: "critical-turn-B",
    data: { turnId: "1", model: "model-B" },
  } as const;
  coordinator.observeEvent(turnB);
  assert.equal(coordinator.hostEventDisposition(turnB), "claimed",
    "a turnId local to the next agentic loop was treated as a global replay identity");
  coordinator.observeEvent({
    type: "session.model_change", id: "critical-model-B",
    data: { newModel: "model-B", reasoningEffort: "high" },
  });
  coordinator.observeEvent({
    type: "assistant.usage", id: "critical-usage-B",
    data: { apiCallId: "critical-api-B", model: "model-B", inputTokens: 7, outputTokens: 3 },
  });
  for (let index = 0; index < 4_100; index += 1) {
    coordinator.observeEvent({ type: "diagnostic.critical-noop", id: `critical-noop-${index}`, data: {} });
  }
  const beforeReplay = lifecycle.length;
  coordinator.observeEvent(turnA);
  coordinator.observeEvent(modelA);
  coordinator.observeEvent(usageA);
  assert.equal(lifecycle.length, beforeReplay, "cross-root replay mutated lifecycle after generic cache rotation");
  assert.equal(coordinator.hostEventDisposition(usageA), "replay");
  const bUsage = lifecycle.filter((event) => event.type === "run.usage" && event.runId === rootB.runId);
  assert.deepEqual(bUsage.map((event) => event.usage.totalTokens), [10]);
  assert.equal(lifecycle.filter((event) => event.type === "run.model" && event.runId === rootB.runId).at(-1)?.model,
    "model-B");
  assert.equal(lifecycle.filter((event) => event.type === "run.reasoning" && event.runId === rootB.runId).at(-1)
    ?.reasoningEffort, "high");
});

test("Copilot usage ownership learns enriched aliases before generic replay rejection", async () => {
  const teamLead = copilotFixedAgentIds.get("team-lead")!;
  const agents = [{ id: teamLead, userInvocable: true }];
  const lifecycle: CopilotCoordinatorLifecycleEvent[] = [];
  const coordinator = createCopilotCoordinatorGuard(() => ({ rpc: { agent: {
    getCurrent: async () => ({ agent: agents[0] }), reload: async () => ({ agents }),
  } } }), undefined, (event) => { lifecycle.push(event); });
  await coordinator.refresh();
  const sessionId = "critical-enriched-alias";
  await coordinator.hooks.onUserPromptSubmitted({
    sessionId, workingDirectory: process.cwd(), prompt: "alias mission A",
  }, { sessionId });
  const first = {
    type: "assistant.usage", id: "enriched-event-E",
    data: { apiCallId: "enriched-api-A", model: "model-A", inputTokens: 5, outputTokens: 1 },
  } as const;
  coordinator.observeEvent(first);
  coordinator.observeEvent({
    ...first,
    data: { ...first.data, providerCallId: "enriched-provider-P", inputTokens: 999, outputTokens: 999 },
  });
  coordinator.observeEvent({ type: "session.idle", id: "enriched-idle-A", data: { aborted: false } });
  await coordinator.hooks.onUserPromptSubmitted({
    sessionId, workingDirectory: process.cwd(), prompt: "alias mission B",
  }, { sessionId });
  const rootB = lifecycle.filter((event) => event.type === "root.started").at(-1)!;
  coordinator.observeEvent({
    type: "assistant.usage", id: "enriched-own-B",
    data: { apiCallId: "enriched-api-B", model: "model-B", inputTokens: 2, outputTokens: 1 },
  });
  const providerReplay = {
    type: "assistant.usage", id: "enriched-event-F",
    data: { providerCallId: "enriched-provider-P", model: "wrong-model", inputTokens: 100, outputTokens: 10 },
  } as const;
  coordinator.observeEvent(providerReplay);
  assert.equal(coordinator.hostEventDisposition(providerReplay), "replay");
  const bUsage = lifecycle.filter((event) => event.type === "run.usage" && event.runId === rootB.runId);
  assert.deepEqual(bUsage.map((event) => event.usage.totalTokens), [3]);
});

test("Copilot weak identity bridge rejects anonymous and stable usage transitions in either direction", async (context) => {
  for (const direction of ["anonymous-to-stable", "stable-to-anonymous"] as const) {
    for (const acrossRoots of [false, true]) {
      await context.test(`${direction}-${acrossRoots ? "cross-root" : "same-root"}`, async () => {
        const teamLead = copilotFixedAgentIds.get("team-lead")!;
        const agents = [{ id: teamLead, userInvocable: true }];
        const lifecycle: CopilotCoordinatorLifecycleEvent[] = [];
        const coordinator = createCopilotCoordinatorGuard(() => ({ rpc: { agent: {
          getCurrent: async () => ({ agent: agents[0] }), reload: async () => ({ agents }),
        } } }), undefined, (event) => { lifecycle.push(event); });
        await coordinator.refresh();
        const sessionId = `weak-bridge-${direction}-${acrossRoots ? "cross" : "same"}`;
        const startRoot = async (prompt: string): Promise<CopilotCoordinatorLifecycleEvent> => {
          await coordinator.hooks.onUserPromptSubmitted({
            sessionId, workingDirectory: process.cwd(), prompt,
          }, { sessionId });
          return lifecycle.filter((event) => event.type === "root.started").at(-1)!;
        };
        const anonymous = {
          type: "assistant.usage",
          data: direction === "stable-to-anonymous"
            ? { model: "bridge-model-drifted", inputTokens: 999, outputTokens: 99 }
            : { model: "bridge-model", inputTokens: 10, outputTokens: 2 },
        } as const;
        const stable = {
          type: "assistant.usage", id: `bridge-event-${direction}-${acrossRoots}`,
          data: {
            providerCallId: `bridge-provider-${direction}-${acrossRoots}`,
            ...(direction === "anonymous-to-stable"
              ? { model: "bridge-model-drifted", inputTokens: 999, outputTokens: 99 }
              : { model: "bridge-model", inputTokens: 10, outputTokens: 2 }),
          },
        } as const;
        const first = direction === "anonymous-to-stable" ? anonymous : stable;
        const second = direction === "anonymous-to-stable" ? stable : anonymous;
        await startRoot("bridge mission A");
        coordinator.observeEvent(first);
        assert.equal(coordinator.hostEventDisposition(first), "claimed");
        if (acrossRoots) {
          coordinator.observeEvent({
            type: "session.idle", id: `bridge-idle-${direction}`, data: { aborted: false },
          });
          await startRoot("bridge mission B");
        }
        const targetRoot = lifecycle.filter((event) => event.type === "root.started").at(-1)!;
        coordinator.observeEvent(second);
        assert.equal(coordinator.hostEventDisposition(second), "unverified");
        assert.equal(coordinator.lifecycleIdentityUnverified(), true);
        const targetUsage = lifecycle.filter((event) =>
          event.type === "run.usage" && event.runId === targetRoot.runId);
        assert.equal(targetUsage.filter((event) => event.usage.totalTokens === 12).length,
          acrossRoots ? 0 : 1);
        assert.equal(targetUsage.filter((event) => event.attributionUnverified).length, 1);
        assert.equal(targetUsage.some((event) => event.usage.totalTokens === 24), false);
      });
    }
  }
});

test("Copilot anonymous weak shapes reject optional scope drift instead of binding a second fallback", () => {
  const make = () => createCopilotCoordinatorGuard(() => ({ rpc: { agent: {
    getCurrent: async () => ({ agent: undefined }), reload: async () => ({ agents: [] }),
  } } }));
  const timestamp = new Date(Date.now() + 1_000).toISOString();
  const missingFirst = make();
  missingFirst.observeEvent({
    type: "assistant.message", timestamp, data: { model: "scope-model" },
  });
  const scopeAppeared = {
    type: "assistant.message", timestamp, agentId: "late-agent", data: { model: "scope-model" },
  } as const;
  missingFirst.observeEvent(scopeAppeared);
  assert.equal(missingFirst.hostEventDisposition(scopeAppeared), "unverified");

  const presentFirst = make();
  presentFirst.observeEvent({
    type: "assistant.message", timestamp, agentId: "early-agent", data: { model: "scope-model" },
  });
  const scopeDisappeared = {
    type: "assistant.message", timestamp, data: { model: "scope-model" },
  } as const;
  presentFirst.observeEvent(scopeDisappeared);
  assert.equal(presentFirst.hostEventDisposition(scopeDisappeared), "unverified");

  const payloadDrift = make();
  payloadDrift.observeEvent({
    type: "assistant.usage", timestamp,
    data: { model: "payload-A", inputTokens: 1, outputTokens: 1 },
  });
  const changedPayload = {
    type: "assistant.usage", timestamp,
    data: { model: "payload-B", inputTokens: 200, outputTokens: 20 },
  } as const;
  payloadDrift.observeEvent(changedPayload);
  assert.equal(payloadDrift.hostEventDisposition(changedPayload), "unverified");
});

test("Copilot rejects identity-free usage reused by another root without phantom attribution", async () => {
  const teamLead = copilotFixedAgentIds.get("team-lead")!;
  const agents = [{ id: teamLead, userInvocable: true }];
  const lifecycle: CopilotCoordinatorLifecycleEvent[] = [];
  const coordinator = createCopilotCoordinatorGuard(() => ({ rpc: { agent: {
    getCurrent: async () => ({ agent: agents[0] }), reload: async () => ({ agents }),
  } } }), undefined, (event) => { lifecycle.push(event); });
  await coordinator.refresh();
  const sessionId = "critical-fallback-usage";
  const anonymousUsage = {
    type: "assistant.usage",
    data: { model: "fallback-model", inputTokens: 100, outputTokens: 10 },
  } as const;
  await coordinator.hooks.onUserPromptSubmitted({
    sessionId, workingDirectory: process.cwd(), prompt: "fallback mission A",
  }, { sessionId });
  coordinator.observeEvent(anonymousUsage);
  coordinator.observeEvent({ type: "session.idle", id: "fallback-idle-A", data: { aborted: false } });
  await coordinator.hooks.onUserPromptSubmitted({
    sessionId, workingDirectory: process.cwd(), prompt: "fallback mission B",
  }, { sessionId });
  const rootB = lifecycle.filter((event) => event.type === "root.started").at(-1)!;
  const replay = { ...anonymousUsage, data: { ...anonymousUsage.data } };
  coordinator.observeEvent(replay);
  assert.equal(coordinator.hostEventDisposition(replay), "unverified");
  assert.equal(coordinator.lifecycleIdentityUnverified(), true);
  const bUsage = lifecycle.filter((event) => event.type === "run.usage" && event.runId === rootB.runId);
  assert.equal(bUsage.length, 1);
  assert.equal(bUsage[0]?.attributionUnverified, true);
  assert.deepEqual(bUsage[0]?.usage, {});
  assert.equal(lifecycle.some((event) => event.type === "run.usage" && event.runId === rootB.runId &&
    event.usage.totalTokens === 110), false);
  const denied = await coordinator.hooks.onPreToolUse({
    sessionId, workingDirectory: process.cwd(), toolName: "task",
    toolArgs: { agent_type: copilotFixedAgentIds.get("crafter"), prompt: "must not start" },
  }, { sessionId });
  assert.equal(denied?.permissionDecision, "deny");
  assert.match(denied?.permissionDecisionReason ?? "", /lifecycle identity is unverified.*reload/iu);
});

test("Copilot identity-free model payload drift fails closed before it can change telemetry", async () => {
  const teamLead = copilotFixedAgentIds.get("team-lead")!;
  const agents = [{ id: teamLead, userInvocable: true }];
  const lifecycle: CopilotCoordinatorLifecycleEvent[] = [];
  const coordinator = createCopilotCoordinatorGuard(() => ({ rpc: { agent: {
    getCurrent: async () => ({ agent: agents[0] }), reload: async () => ({ agents }),
  } } }), undefined, (event) => { lifecycle.push(event); });
  await coordinator.refresh();
  const sessionId = "critical-fallback-model";
  await coordinator.hooks.onUserPromptSubmitted({
    sessionId, workingDirectory: process.cwd(), prompt: "observe model transitions",
  }, { sessionId });
  const root = lifecycle.filter((event) => event.type === "root.started").at(-1)!;
  const modelA = {
    type: "session.model_change", data: { newModel: "model-A", reasoningEffort: "low" },
  } as const;
  coordinator.observeEvent(modelA);
  const modelB = {
    type: "session.model_change", data: { newModel: "model-B", reasoningEffort: "high" },
  } as const;
  coordinator.observeEvent(modelB);
  assert.equal(coordinator.hostEventDisposition(modelB), "unverified");
  const replay = { ...modelA, data: { ...modelA.data } };
  coordinator.observeEvent(replay);
  assert.equal(coordinator.hostEventDisposition(replay), "unverified");
  assert.equal(lifecycle.filter((event) => event.type === "run.model" && event.runId === root.runId).at(-1)?.model,
    "model-A");
  assert.equal(lifecycle.filter((event) => event.type === "run.reasoning" && event.runId === root.runId).at(-1)
    ?.reasoningEffort, "low");
  assert.equal(lifecycle.filter((event) => event.type === "run.state" && event.runId === root.runId).at(-1)?.state,
    "working");
});

test("Copilot critical fallback capacity saturates fail-closed without evicting prior owners", async () => {
  const teamLead = copilotFixedAgentIds.get("team-lead")!;
  const agents = [{ id: teamLead, userInvocable: true }];
  const lifecycle: CopilotCoordinatorLifecycleEvent[] = [];
  const coordinator = createCopilotCoordinatorGuard(() => ({ rpc: { agent: {
    getCurrent: async () => ({ agent: agents[0] }), reload: async () => ({ agents }),
  } } }), undefined, (event) => { lifecycle.push(event); });
  await coordinator.refresh();
  const sessionId = "critical-fallback-capacity";
  await coordinator.hooks.onUserPromptSubmitted({
    sessionId, workingDirectory: process.cwd(), prompt: "fill defensive fallback identities",
  }, { sessionId });
  const base = Date.now() + 1_000;
  for (let index = 0; index < 512; index += 1) {
    coordinator.observeEvent({
      type: "assistant.message", timestamp: new Date(base + index).toISOString(),
      data: { model: `capacity-model-${index}` },
    });
  }
  const overflow = {
    type: "assistant.message", timestamp: new Date(base + 513).toISOString(),
    data: { model: "capacity-overflow" },
  } as const;
  coordinator.observeEvent(overflow);
  assert.equal(coordinator.hostEventDisposition(overflow), "unverified");
  assert.equal(coordinator.lifecycleIdentityUnverified(), true);
  assert.equal(lifecycle.filter((event) => event.type === "run.state").at(-1)?.state, "working");
});

test("Copilot hook and message aliases survive enriched replay identities", () => {
  const coordinator = createCopilotCoordinatorGuard(() => ({ rpc: { agent: {
    getCurrent: async () => ({ agent: undefined }), reload: async () => ({ agents: [] }),
  } } }));
  const first = {
    type: "hook.end", id: "hook-end-event-A",
    data: { hookType: "preToolUse", hookInvocationId: "native-hook-invocation" },
  } as const;
  coordinator.observeEvent(first);
  assert.equal(coordinator.hostEventDisposition(first), "claimed");
  const replay = {
    type: "hook.end", id: "hook-end-event-B",
    data: { hookType: "different-type", hookInvocationId: "native-hook-invocation" },
  } as const;
  coordinator.observeEvent(replay);
  assert.equal(coordinator.hostEventDisposition(replay), "replay");

  const message = { type: "assistant.message", id: "message-event-A", data: {} } as const;
  coordinator.observeEvent(message);
  coordinator.observeEvent({ ...message, data: { messageId: "native-message-M" } });
  const messageReplay = {
    type: "assistant.message", id: "message-event-B", agentId: "changed-or-late-agent",
    data: { messageId: "native-message-M" },
  } as const;
  coordinator.observeEvent(messageReplay);
  assert.equal(coordinator.hostEventDisposition(messageReplay), "replay");

  coordinator.observeEvent({
    type: "assistant.turn_start", id: "interaction-event-A",
    data: { turnId: "1", interactionId: "upstream-interaction", model: "model" },
  });
  const interactionReplay = {
    type: "assistant.turn_start", id: "interaction-event-B", agentId: "late-native-child",
    data: { turnId: "different-local-turn", interactionId: "upstream-interaction", model: "model" },
  } as const;
  coordinator.observeEvent(interactionReplay);
  assert.equal(coordinator.hostEventDisposition(interactionReplay), "replay");

  const reverseInteraction = createCopilotCoordinatorGuard(() => ({ rpc: { agent: {
    getCurrent: async () => ({ agent: undefined }), reload: async () => ({ agents: [] }),
  } } }));
  reverseInteraction.observeEvent({
    type: "assistant.turn_start", id: "reverse-interaction-A", agentId: "early-native-child",
    data: { turnId: "1", interactionId: "reverse-upstream-interaction", model: "model" },
  });
  const reverseInteractionReplay = {
    type: "assistant.turn_start", id: "reverse-interaction-B",
    data: { turnId: "2", interactionId: "reverse-upstream-interaction", model: "model" },
  } as const;
  reverseInteraction.observeEvent(reverseInteractionReplay);
  assert.equal(reverseInteraction.hostEventDisposition(reverseInteractionReplay), "replay");

  coordinator.observeEvent({
    type: "subagent.completed", id: "terminal-without-child-A",
    data: { agentName: "worker", toolCallId: "native-parent-task" },
  });
  const terminalReplay = {
    type: "subagent.completed", id: "terminal-without-child-B",
    data: { agentName: "worker", toolCallId: "native-parent-task" },
  } as const;
  coordinator.observeEvent(terminalReplay);
  assert.equal(coordinator.hostEventDisposition(terminalReplay), "replay");

  coordinator.observeEvent({
    type: "subagent.failed", id: "missing-child-first",
    data: { agentName: "worker", toolCallId: "identity-drift-task" },
  });
  const missingToPresent = {
    type: "subagent.failed", id: "present-child-second", agentId: "late-native-child",
    data: { agentName: "worker", toolCallId: "identity-drift-task" },
  } as const;
  coordinator.observeEvent(missingToPresent);
  assert.equal(coordinator.hostEventDisposition(missingToPresent), "unverified");

  const reverse = createCopilotCoordinatorGuard(() => ({ rpc: { agent: {
    getCurrent: async () => ({ agent: undefined }), reload: async () => ({ agents: [] }),
  } } }));
  reverse.observeEvent({
    type: "subagent.failed", id: "present-child-first", agentId: "native-child",
    data: { agentName: "worker", toolCallId: "reverse-identity-drift-task" },
  });
  const presentToMissing = {
    type: "subagent.failed", id: "missing-child-second",
    data: { agentName: "worker", toolCallId: "reverse-identity-drift-task" },
  } as const;
  reverse.observeEvent(presentToMissing);
  assert.equal(reverse.hostEventDisposition(presentToMissing), "unverified");
});

test("Copilot anonymous terminals are inert without a root and fail closed with an active root", async (context) => {
  for (const terminalType of ["session.idle", "session.error", "session.shutdown"] as const) {
    await context.test(terminalType, async () => {
      const teamLead = copilotFixedAgentIds.get("team-lead")!;
      const agents = [{ id: teamLead, userInvocable: true }];
      const lifecycle: CopilotCoordinatorLifecycleEvent[] = [];
      const coordinator = createCopilotCoordinatorGuard(() => ({ rpc: { agent: {
        getCurrent: async () => ({ agent: agents[0] }), reload: async () => ({ agents }),
      } } }), undefined, (event) => { lifecycle.push(event); });
      await coordinator.refresh();
      const terminalData = terminalType === "session.idle"
        ? { aborted: false }
        : terminalType === "session.shutdown" ? { shutdownType: "normal" } : {};
      const orphan = { type: terminalType, data: terminalData };
      coordinator.observeEvent(orphan);
      assert.equal(coordinator.terminalEventDisposition(orphan), "replay");
      assert.equal(coordinator.lifecycleIdentityUnverified(), false);

      const sessionId = `anonymous-terminal-${terminalType}`;
      await coordinator.hooks.onUserPromptSubmitted({
        sessionId, workingDirectory: process.cwd(), prompt: "terminal mission A",
      }, { sessionId });
      coordinator.observeEvent({
        type: "assistant.turn_start", id: `${terminalType}-turn-A`, data: { turnId: "A", model: "model" },
      });
      const root = lifecycle.filter((event) => event.type === "root.started").at(-1)!;
      const ambiguous = { type: terminalType, data: { ...terminalData } };
      coordinator.observeEvent(ambiguous);
      assert.equal(coordinator.terminalEventDisposition(ambiguous), "unverified");
      assert.equal(coordinator.lifecycleIdentityUnverified(), true);
      assert.equal(lifecycle.some((event) => event.type === "run.finished" && event.runId === root.runId), false);
      assert.equal(lifecycle.filter((event) => event.type === "run.state" && event.runId === root.runId).at(-1)
        ?.state, "working");
    });
  }
});

test("Copilot terminal semantic ownership blocks scope loss and cross-root native replays", async (context) => {
  for (const terminalType of ["session.idle", "session.error", "session.shutdown"] as const) {
    await context.test(terminalType, async () => {
      const teamLead = copilotFixedAgentIds.get("team-lead")!;
      const agents = [{ id: teamLead, userInvocable: true }];
      const terminalData = terminalType === "session.idle"
        ? { aborted: false }
        : terminalType === "session.shutdown" ? { shutdownType: "normal" } : {};
      const makeCoordinator = async (suffix: string) => {
        const lifecycle: CopilotCoordinatorLifecycleEvent[] = [];
        const coordinator = createCopilotCoordinatorGuard(() => ({ rpc: { agent: {
          getCurrent: async () => ({ agent: agents[0] }), reload: async () => ({ agents }),
        } } }), undefined, (event) => { lifecycle.push(event); });
        await coordinator.refresh();
        const sessionId = `terminal-semantic-${terminalType}-${suffix}`;
        await coordinator.hooks.onUserPromptSubmitted({
          sessionId, workingDirectory: process.cwd(), prompt: `terminal ${suffix}`,
        }, { sessionId });
        const turnId = `${terminalType}-${suffix}-turn`;
        coordinator.observeEvent({
          type: "assistant.turn_start", id: turnId, data: { turnId: suffix, model: "model" },
        });
        return { coordinator, lifecycle, sessionId, turnId };
      };

      const coexist = await makeCoordinator("coexist");
      const firstTimestamp = new Date(Date.now() + 1_000).toISOString();
      const childTerminal = {
        type: terminalType, id: `${terminalType}-coexist-child-A`,
        parentId: coexist.turnId, timestamp: firstTimestamp, agentId: "native-child",
        data: { ...terminalData },
      } as const;
      coexist.coordinator.observeEvent(childTerminal);
      assert.equal(coexist.coordinator.terminalEventDisposition(childTerminal), "claimed");
      const sameChildReplay = { ...childTerminal, id: `${terminalType}-coexist-child-B` };
      coexist.coordinator.observeEvent(sameChildReplay);
      assert.equal(coexist.coordinator.terminalEventDisposition(sameChildReplay), "replay");
      const rootTerminal = {
        type: terminalType, id: `${terminalType}-coexist-root`, parentId: coexist.turnId,
        timestamp: new Date(Date.now() + 2_000).toISOString(), data: { ...terminalData },
      } as const;
      coexist.coordinator.observeEvent(rootTerminal);
      assert.equal(coexist.coordinator.terminalEventDisposition(rootTerminal), "claimed");
      assert.equal(coexist.lifecycle.filter((event) => event.type === "run.finished" && event.kind === "root").length, 1);

      const childToRoot = await makeCoordinator("child-to-root");
      const driftTimestamp = new Date(Date.now() + 3_000).toISOString();
      const scoped = {
        type: terminalType, id: `${terminalType}-scoped`, parentId: childToRoot.turnId,
        timestamp: driftTimestamp, agentId: "native-child",
        data: terminalType === "session.error" ? { ...terminalData } : {},
      } as const;
      childToRoot.coordinator.observeEvent(scoped);
      const lostScope = {
        type: terminalType, id: `${terminalType}-lost-scope`, parentId: childToRoot.turnId,
        timestamp: driftTimestamp, data: { ...terminalData },
      } as const;
      childToRoot.coordinator.observeEvent(lostScope);
      assert.equal(childToRoot.coordinator.terminalEventDisposition(lostScope), "unverified");
      const childToRootRun = childToRoot.lifecycle.filter((event) => event.type === "root.started").at(-1)!;
      assert.equal(childToRoot.lifecycle.some((event) =>
        event.type === "run.finished" && event.runId === childToRootRun.runId), false);

      if (terminalType !== "session.error") {
        for (const reverseOutcome of [false, true]) {
          const outcomeDrift = await makeCoordinator(`outcome-${reverseOutcome ? "value-to-missing" : "missing-to-value"}`);
          const outcomeTimestamp = new Date(Date.now() + 3_500).toISOString();
          const firstData = reverseOutcome ? terminalData : {};
          const secondData = reverseOutcome ? {} : terminalData;
          const outcomeFirst = {
            type: terminalType, id: `${terminalType}-outcome-first-${reverseOutcome}`,
            parentId: outcomeDrift.turnId, timestamp: outcomeTimestamp, agentId: "native-child",
            data: { ...firstData },
          } as const;
          outcomeDrift.coordinator.observeEvent(outcomeFirst);
          const outcomeSecond = {
            ...outcomeFirst, id: `${terminalType}-outcome-second-${reverseOutcome}`, data: { ...secondData },
          } as const;
          outcomeDrift.coordinator.observeEvent(outcomeSecond);
          assert.equal(outcomeDrift.coordinator.terminalEventDisposition(outcomeSecond), "unverified");
        }
        if (terminalType === "session.shutdown") {
          const valueDrift = await makeCoordinator("outcome-normal-to-error");
          const valueTimestamp = new Date(Date.now() + 3_750).toISOString();
          const normal = {
            type: terminalType, id: "shutdown-normal-first", parentId: valueDrift.turnId,
            timestamp: valueTimestamp, agentId: "native-child", data: { shutdownType: "normal" },
          } as const;
          valueDrift.coordinator.observeEvent(normal);
          const error = { ...normal, id: "shutdown-error-second", data: { shutdownType: "error" } } as const;
          valueDrift.coordinator.observeEvent(error);
          assert.equal(valueDrift.coordinator.terminalEventDisposition(error), "unverified");
        }
      }

      const optionalMetadata = await makeCoordinator("optional-metadata");
      const metadataTimestamp = new Date(Date.now() + 3_900).toISOString();
      const metadataFirst = {
        type: terminalType, id: `${terminalType}-metadata-first`, parentId: optionalMetadata.turnId,
        timestamp: metadataTimestamp, agentId: "native-child", data: { ...terminalData },
      } as const;
      optionalMetadata.coordinator.observeEvent(metadataFirst);
      const metadataSecond = {
        ...metadataFirst, id: `${terminalType}-metadata-second`,
        data: { ...terminalData, sessionId: optionalMetadata.sessionId, toolCallId: "late-tool" },
      } as const;
      optionalMetadata.coordinator.observeEvent(metadataSecond);
      assert.equal(optionalMetadata.coordinator.terminalEventDisposition(metadataSecond), "unverified");

      const rootToChild = await makeCoordinator("root-to-child");
      const reverseTimestamp = new Date(Date.now() + 4_000).toISOString();
      const unchainedRoot = {
        type: terminalType, id: `${terminalType}-root-first`, parentId: "unknown-parent",
        timestamp: reverseTimestamp, data: { ...terminalData },
      } as const;
      rootToChild.coordinator.observeEvent(unchainedRoot);
      assert.equal(rootToChild.coordinator.terminalEventDisposition(unchainedRoot), "claimed");
      const gainedScope = {
        ...unchainedRoot, id: `${terminalType}-child-second`, agentId: "late-native-child",
      } as const;
      rootToChild.coordinator.observeEvent(gainedScope);
      assert.equal(rootToChild.coordinator.terminalEventDisposition(gainedScope), "unverified");

      const crossRoot = await makeCoordinator("cross-root");
      const ownerTimestamp = new Date(Date.now() + 5_000).toISOString();
      const terminalA = {
        type: terminalType, id: `${terminalType}-owner-A`, timestamp: ownerTimestamp,
        data: { ...terminalData },
      } as const;
      crossRoot.coordinator.observeEvent(terminalA);
      assert.equal(crossRoot.coordinator.terminalEventDisposition(terminalA), "claimed");
      const noRootReplay = { ...terminalA, id: `${terminalType}-owner-no-root-replay` };
      crossRoot.coordinator.observeEvent(noRootReplay);
      assert.equal(crossRoot.coordinator.terminalEventDisposition(noRootReplay), "replay");
      assert.equal(crossRoot.coordinator.lifecycleIdentityUnverified(), false);
      await crossRoot.coordinator.hooks.onUserPromptSubmitted({
        sessionId: crossRoot.sessionId, workingDirectory: process.cwd(), prompt: "terminal owner B",
      }, { sessionId: crossRoot.sessionId });
      const rootB = crossRoot.lifecycle.filter((event) => event.type === "root.started").at(-1)!;
      crossRoot.coordinator.observeEvent({
        type: "assistant.turn_start", id: `${terminalType}-owner-B-turn`,
        data: { turnId: "owner-B", model: "model" },
      });
      const terminalB = { ...terminalA, id: `${terminalType}-owner-B` };
      crossRoot.coordinator.observeEvent(terminalB);
      assert.equal(crossRoot.coordinator.terminalEventDisposition(terminalB), "replay");
      assert.equal(crossRoot.coordinator.lifecycleIdentityUnverified(), false);
      assert.equal(crossRoot.lifecycle.some((event) =>
        event.type === "run.finished" && event.runId === rootB.runId), false);
      assert.equal(crossRoot.lifecycle.filter((event) =>
        event.type === "run.state" && event.runId === rootB.runId).at(-1)?.state, "working");
    });
  }
});

test("Copilot enriches an id-only manual personal selection from the exact owned registry entry", async () => {
  const root = await mkdtemp(join(tmpdir(), "harbor-copilot-manual-personal-"));
  const home = join(root, "home");
  const project = join(root, "project");
  const previousHome = process.env.COPILOT_HOME;
  process.env.COPILOT_HOME = home;
  try {
    const roster = new Roster(harnessSpec("copilot", home, project));
    await roster.join({
      name: "manual-reviewer",
      description: "Manual reviewer",
      prompt: "Review safely",
      tools: ["read"],
    });
    const profile = harnessSpec("copilot", home, project);
    const exactOwned = {
      id: "manual-reviewer",
      path: join(project, profile.activeDir, `manual-reviewer${profile.extension}`),
      userInvocable: true,
    };
    const foreign = {
      id: "manual-reviewer",
      path: join(root, "foreign", `manual-reviewer${profile.extension}`),
      userInvocable: true,
    };
    const startsRoot = async (
      sessionId: string,
      agents: Array<{ id: string; path: string; userInvocable: boolean }>,
      current: { id: string; path?: string; userInvocable: boolean } = { id: "manual-reviewer", userInvocable: true },
    ): Promise<boolean> => {
      const lifecycle: CopilotCoordinatorLifecycleEvent[] = [];
      const coordinator = createCopilotCoordinatorGuard(() => ({ rpc: { agent: {
        getCurrent: async () => ({ agent: current }),
        reload: async () => ({ agents }),
      } } }), undefined, (event) => { lifecycle.push(event); });
      await coordinator.refresh();
      await coordinator.hooks.onUserPromptSubmitted({
        sessionId,
        workingDirectory: project,
        prompt: "review the current UX",
      }, { sessionId });
      return lifecycle.some((event) => event.type === "root.started" &&
        event.agent === "manual-reviewer" && event.runtimeAgent === "manual-reviewer");
    };

    assert.equal(await startsRoot("manual-personal-foreign-first", [foreign, exactOwned]), true,
      "registry order hid the exact owned personal definition");
    assert.equal(await startsRoot("manual-personal-owned-first", [exactOwned, foreign]), true,
      "a later foreign collision invalidated an otherwise exact owned definition");
    assert.equal(await startsRoot("manual-personal-foreign-only", [foreign]), false,
      "a foreign same-id definition was accepted as the personal player");
    assert.equal(await startsRoot("manual-personal-duplicate-owned", [exactOwned, { ...exactOwned }]), false,
      "duplicate exact definitions were not rejected as ambiguous");
    assert.equal(await startsRoot("manual-personal-current-foreign", [foreign, exactOwned], foreign), false,
      "a foreign path-bearing current selection was rewritten to the owned registry entry");
    assert.equal(await startsRoot("manual-personal-current-owned", [foreign, exactOwned], exactOwned), true,
      "the unique exact owned current selection was rejected because a foreign collision existed");
    assert.equal(await startsRoot("manual-personal-current-duplicate", [exactOwned, { ...exactOwned }], exactOwned), false,
      "a path-bearing current selection hid duplicate exact owned registry entries");
  } finally {
    if (previousHome === undefined) delete process.env.COPILOT_HOME;
    else process.env.COPILOT_HOME = previousHome;
    await rm(root, { recursive: true, force: true });
  }
});

test("Copilot contiguous tool completion finalizes the child before session idle", async () => {
  const teamLead = copilotFixedAgentIds.get("team-lead")!;
  const crafter = copilotFixedAgentIds.get("crafter")!;
  const agents = [...copilotFixedAgentIds.values()].map((id) => ({ id, userInvocable: true }));
  const lifecycle: CopilotCoordinatorLifecycleEvent[] = [];
  const coordinator = createCopilotCoordinatorGuard(() => ({ rpc: { agent: {
    getCurrent: async () => ({ agent: { id: teamLead, userInvocable: true } }),
    reload: async () => ({ agents }),
  } } }), undefined, (event) => { lifecycle.push(event); });
  await coordinator.refresh();
  const invocation = { sessionId: "contiguous-terminal-session" };
  const base = { sessionId: invocation.sessionId, workingDirectory: process.cwd() };
  await coordinator.hooks.onUserPromptSubmitted({ ...base, prompt: "coordinate terminals" }, invocation);
  assert.equal((await coordinator.hooks.onPreToolUse({
    ...base,
    toolName: "task",
    toolArgs: { agent_type: crafter, prompt: "finish successfully" },
  }, invocation))?.permissionDecision, "allow");

  coordinator.observeEvent({
    type: "tool.execution_complete",
    id: "tool-complete",
    data: { toolDescription: { name: "task" }, success: true, result: "PRIVATE RESULT" },
  });
  coordinator.observeEvent({ type: "session.idle", id: "immediate-idle", data: { aborted: false } });
  await new Promise<void>((resolve) => { setImmediate(resolve); });

  const finishes = lifecycle.filter((event) => event.type === "run.finished");
  const child = finishes.find((event) => event.kind === "child");
  const root = finishes.find((event) => event.kind === "root");
  assert.ok(child && root);
  assert.equal(child.outcome, "completed");
  assert.equal(root.outcome, "completed");
  assert.ok(finishes.indexOf(child) < finishes.indexOf(root), "root terminal preceded its contiguous child terminal");
  assert.equal(JSON.stringify(lifecycle).includes("PRIVATE RESULT"), false);
});
