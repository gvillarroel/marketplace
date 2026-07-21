import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  copilotFixedAgentIds,
  createCopilotCoordinatorGuard,
  type CopilotCoordinatorLifecycleEvent,
} from "../src/adapters/copilot-coordinator.js";
import { CopilotTeamRuntime } from "../src/adapters/copilot-team-runtime.js";
import { Roster } from "../src/core/lifecycle.js";
import { harnessSpec } from "../src/core/profiles.js";

test("Copilot coordinator emits correlated content-minimized root and child lifecycle events", async () => {
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
    timestamp: "2026-07-21T12:00:00.000Z",
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
    timestamp: "2026-07-21T12:00:01.000Z",
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
    timestamp: "2026-07-21T12:00:02.000Z",
    agentId: "native-child-1",
    data: { agentName: crafter, toolCallId: "task-call-1", model: "openai/gpt-child" },
  });
  coordinator.observeEvent({
    type: "assistant.turn_start",
    id: "child-turn-event",
    parentId: "child-start-event",
    timestamp: "2026-07-21T12:00:03.000Z",
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
    timestamp: "2026-07-21T12:00:04.000Z",
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
    timestamp: "2026-07-21T12:00:05.000Z",
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
    timestamp: "2026-07-21T12:00:06.000Z",
    data: { turnId: "root-turn-1", model: "openai/gpt-root-observed" },
  });
  coordinator.observeEvent({
    type: "assistant.usage",
    id: "root-usage-event",
    parentId: "root-turn-event",
    timestamp: "2026-07-21T12:00:07.000Z",
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
    timestamp: "2026-07-21T12:00:08.000Z",
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
      agentId: "native-child",
      data: { agentName: crafter, toolCallId: "child-tool", error: "PRIVATE AUTHORITATIVE CHILD FAILURE" },
    });
    await coordinator.hooks.onPostToolUseFailure({ ...toolInput, error: "cleanup" }, invocation);
    assert.equal(lifecycle.filter((event) => event.type === "run.finished" && event.kind === "child").length, 1);
    assert.equal(lifecycle.some((event) => event.type === "run.finished" && event.kind === "root"), false);

    coordinator.observeEvent({ type: "session.idle", id: `root-idle-${terminal.label}`, data: { aborted: false } });
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
  const raced = createCopilotCoordinatorGuard(() => ({ rpc: { agent: {
    getCurrent: async () => {
      announceRead();
      await readGate;
      return { agent: { id: teamLead, userInvocable: true } };
    },
    reload: async () => ({ agents }),
  } } }), undefined, (event) => { racedLifecycle.push(event); });
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
    ): Promise<boolean> => {
      const lifecycle: CopilotCoordinatorLifecycleEvent[] = [];
      const coordinator = createCopilotCoordinatorGuard(() => ({ rpc: { agent: {
        getCurrent: async () => ({ agent: { id: "manual-reviewer", userInvocable: true } }),
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
