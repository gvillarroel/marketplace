import assert from "node:assert/strict";
import test from "node:test";
import {
  copilotFixedAgentIds,
  copilotFixedAgentPath,
  createCopilotCoordinatorGuard,
  type CopilotCoordinatorLifecycleEvent,
} from "../src/adapters/copilot-coordinator.js";

const project = process.cwd();

function fixedCopilotIdentity(logicalId: string, extras: Record<string, unknown> = {}) {
  return {
    id: copilotFixedAgentIds.get(logicalId)!,
    path: copilotFixedAgentPath(logicalId),
    userInvocable: true,
    ...extras,
  };
}

function contractInput(sessionId: string, toolArgs: unknown, toolName = "task") {
  return { sessionId, workingDirectory: project, toolName, toolArgs };
}

function contractToolInvocation(
  sessionId: string,
  raw: string,
  options: { toolName?: string; toolCallId?: string; arguments?: unknown } = {},
) {
  return {
    sessionId,
    toolCallId: options.toolCallId ?? `${sessionId}-contract-call`,
    toolName: options.toolName ?? "harbor_contract",
    arguments: options.arguments ?? { definition: raw },
  };
}

function contractHarness(rootAdmissionError?: string, childAdmissionError?: string) {
  const lifecycle: CopilotCoordinatorLifecycleEvent[] = [];
  const admissions: any[] = [];
  const coordinator = createCopilotCoordinatorGuard(() => ({ rpc: { agent: {
    getCurrent: async () => ({ agent: undefined }),
    reload: async () => ({ agents: [] }),
  } } }), undefined, (event) => { lifecycle.push(event); }, (input) => {
    admissions.push(input);
    if (input.type === "root" && rootAdmissionError) throw new Error(rootAdmissionError);
    if (input.type === "child" && childAdmissionError) throw new Error(childAdmissionError);
  });
  return { coordinator, lifecycle, admissions };
}

async function beginContract(
  coordinator: ReturnType<typeof createCopilotCoordinatorGuard>,
  sessionId: string,
  raw: string,
  descriptor: { agent_type: string; description: string; prompt: string },
  handshake: { order?: "start-first" | "handler-first" } = {},
): Promise<void> {
  const invocation = { sessionId };
  await coordinator.hooks.onUserPromptSubmitted({
    sessionId,
    workingDirectory: project,
    prompt: `/contract ${raw}`,
  }, invocation);
  const skillEvent = {
    type: "skill.invoked",
    id: `${sessionId}-skill`,
    timestamp: new Date(Date.now() + 10).toISOString(),
    data: {
      name: "contract",
      pluginName: "agent-foundry",
      source: "plugin",
      trigger: "user-invoked",
      model: "root-model",
      content: "PRIVATE SKILL CONTENT MUST NOT BE READ",
      path: "C:\\private\\contract\\SKILL.md",
    },
  } as const;
  coordinator.observeEvent(skillEvent);
  coordinator.observeEvent(skillEvent);
  const tool = contractInput(sessionId, { definition: raw }, "harbor_contract");
  assert.equal((await coordinator.hooks.onPreToolUse(tool, invocation))?.permissionDecision, "allow");
  const nativeInvocation = contractToolInvocation(sessionId, raw);
  const toolStart = {
    type: "tool.execution_start",
    id: `${sessionId}-contract-start`,
    parentId: `${sessionId}-skill`,
    timestamp: new Date(Date.now() + 20).toISOString(),
    data: {
      toolName: nativeInvocation.toolName,
      toolCallId: nativeInvocation.toolCallId,
      arguments: nativeInvocation.arguments,
    },
  } as const;
  if (handshake.order === "start-first") coordinator.observeEvent(toolStart);
  await coordinator.contractToolSucceeded(nativeInvocation, descriptor);
  await coordinator.contractToolSucceeded(nativeInvocation, descriptor);
  if (handshake.order !== "start-first") coordinator.observeEvent(toolStart);
  coordinator.observeEvent(toolStart);
  coordinator.observeEvent({
    type: "tool.execution_complete",
    id: `${sessionId}-contract-complete`,
    parentId: `${sessionId}-contract-start`,
    timestamp: new Date(Date.now() + 30).toISOString(),
    data: {
      toolCallId: nativeInvocation.toolCallId,
      success: true,
      result: "PRIVATE NATIVE TOOL RESULT MUST NOT AUTHENTICATE A DESCRIPTOR",
    },
  });
}

async function authenticateContractTool(
  coordinator: ReturnType<typeof createCopilotCoordinatorGuard>,
  sessionId: string,
  raw: string,
): Promise<void> {
  const invocation = { sessionId };
  await coordinator.hooks.onUserPromptSubmitted({
    sessionId, workingDirectory: project, prompt: `/contract ${raw}`,
  }, invocation);
  coordinator.observeEvent({
    type: "skill.invoked", id: `${sessionId}-skill`,
    data: { name: "contract", pluginName: "agent-foundry", source: "plugin", trigger: "user-invoked" },
  });
  assert.equal((await coordinator.hooks.onPreToolUse(
    contractInput(sessionId, { definition: raw }, "harbor_contract"), invocation,
  ))?.permissionDecision, "allow");
  const nativeInvocation = contractToolInvocation(sessionId, raw);
  coordinator.observeEvent({
    type: "tool.execution_start", id: `${sessionId}-contract-start`, parentId: `${sessionId}-skill`,
    data: {
      toolName: nativeInvocation.toolName,
      toolCallId: nativeInvocation.toolCallId,
      arguments: nativeInvocation.arguments,
    },
  });
}

async function runValidContract(order: "start-first" | "pretool-first") {
  const sessionId = `contract-${order}`;
  const rawSecret = "RAW-CONTRACT-PROMPT-SECRET";
  const descriptorSecret = "VALIDATED-DESCRIPTOR-PROMPT-SECRET";
  const raw = JSON.stringify({
    name: "ephemeral-reviewer",
    description: "Disposable reviewer",
    prompt: `Never disclose ${rawSecret}`,
    tools: ["read", "search"],
    task: "Review token=TASK-LABEL-SECRET in C:\\private\\source.ts",
  });
  const descriptor = {
    agent_type: "explore",
    description: "One disposable reviewer",
    prompt: `Bounded child prompt ${descriptorSecret}`,
  };
  const { coordinator, lifecycle, admissions } = contractHarness();
  coordinator.observeEvent({
    type: "session.start",
    id: `${sessionId}-session-start`,
    data: { selectedModel: "root-model", reasoningEffort: "low" },
  });
  await beginContract(coordinator, sessionId, raw, descriptor, {
    order,
  });
  const invocation = { sessionId };
  const task = contractInput(sessionId, descriptor);
  if (order === "start-first") {
    coordinator.observeEvent({
      type: "tool.execution_start",
      id: `${sessionId}-task-start`,
      parentId: `${sessionId}-contract-complete`,
      data: { toolName: "task", toolCallId: `${sessionId}-task-call` },
    });
    assert.equal((await coordinator.hooks.onPreToolUse(task, invocation))?.permissionDecision, "allow");
  } else {
    assert.equal((await coordinator.hooks.onPreToolUse(task, invocation))?.permissionDecision, "allow");
    coordinator.observeEvent({
      type: "tool.execution_start",
      id: `${sessionId}-task-start`,
      parentId: `${sessionId}-contract-complete`,
      data: { toolName: "task", toolCallId: `${sessionId}-task-call` },
    });
  }

  assert.equal(await coordinator.hooks.onPreToolUse(
    contractInput(`${sessionId}-native-child`, { path: "safe" }, "read"), invocation,
  ), undefined, "contractor read/search tools were intercepted as parent tools");
  const nested = await coordinator.hooks.onPreToolUse(
    contractInput(`${sessionId}-native-child`, { agent_type: "explore", prompt: "nested" }), invocation,
  );
  assert.equal(nested?.permissionDecision, "deny", "contractor nested task delegation escaped exact-one enforcement");
  coordinator.observeEvent({
    type: "tool.execution_start",
    id: `${sessionId}-nested-task-start`,
    parentId: `${sessionId}-task-start`,
    data: {
      toolName: "task",
      toolCallId: `${sessionId}-nested-task-call`,
      parentToolCallId: `${sessionId}-task-call`,
      initiator: "sub-agent",
    },
  });

  coordinator.observeEvent({
    type: "subagent.started",
    id: `${sessionId}-child-start`,
    parentId: `${sessionId}-task-start`,
    agentId: `${sessionId}-native-child`,
    data: { agentName: "explore", toolCallId: `${sessionId}-task-call`, model: "child-model" },
  });
  coordinator.observeEvent({
    type: "assistant.usage",
    id: `${sessionId}-child-usage`,
    parentId: `${sessionId}-child-start`,
    agentId: `${sessionId}-native-child`,
    data: {
      serviceRequestId: `${sessionId}-child-request`,
      parentToolCallId: `${sessionId}-task-call`,
      model: "child-model",
      reasoningEffort: "high",
      inputTokens: 20,
      outputTokens: 4,
      reasoningTokens: 2,
    },
  });
  coordinator.observeEvent({
    type: "subagent.completed",
    id: `${sessionId}-child-complete`,
    parentId: `${sessionId}-child-usage`,
    agentId: `${sessionId}-native-child`,
    data: {
      agentName: "explore",
      toolCallId: `${sessionId}-task-call`,
      model: "child-model",
      durationMs: 750,
      totalTokens: 24,
      totalToolCalls: 2,
    },
  });
  coordinator.observeEvent({
    type: "tool.execution_complete",
    id: `${sessionId}-task-complete`,
    parentId: `${sessionId}-child-complete`,
    data: { toolCallId: `${sessionId}-task-call`, toolDescription: { name: "task" }, success: true, result: "PRIVATE CHILD RESULT" },
  });
  coordinator.observeEvent({
    type: "assistant.usage",
    id: `${sessionId}-root-usage`,
    parentId: `${sessionId}-task-complete`,
    data: { apiCallId: `${sessionId}-root-request`, model: "root-model", reasoningEffort: "low", inputTokens: 30, outputTokens: 5 },
  });
  coordinator.observeEvent({
    type: "session.idle",
    id: `${sessionId}-idle`,
    parentId: `${sessionId}-root-usage`,
    data: { aborted: false },
  });
  return { coordinator, lifecycle, admissions, rawSecret, descriptorSecret, raw, descriptor, sessionId };
}

test("Copilot /contract correlates exactly one observable contractor in both native task event orders", async () => {
  for (const order of ["start-first", "pretool-first"] as const) {
    const { lifecycle, admissions, rawSecret, descriptorSecret, raw } = await runValidContract(order);
    assert.deepEqual(admissions.map(({ type, memberKind }) => [type, memberKind]), [
      ["root", "utility"],
      ["child", "contractor"],
    ]);
    const roots = lifecycle.filter((event) => event.type === "root.started");
    const children = lifecycle.filter((event) => event.type === "child.started");
    assert.equal(roots.length, 1);
    assert.equal(roots[0].agent, "contract");
    assert.equal(roots[0].memberKind, "utility");
    assert.equal(children.length, 1);
    assert.equal(children[0].agent, "ephemeral-reviewer");
    assert.equal(children[0].runtimeAgent, "explore");
    assert.equal(children[0].memberKind, "contractor");
    assert.match(children[0].taskLabel, /token=\[redacted\].*\[path\]/u);
    const childUsage = lifecycle.find((event) => event.type === "run.usage" && event.kind === "child");
    assert.ok(childUsage);
    assert.deepEqual(childUsage.usage, { inputTokens: 20, outputTokens: 4, reasoningTokens: 2, totalTokens: 24 });
    const childFinish = lifecycle.find((event) => event.type === "run.finished" && event.kind === "child");
    assert.ok(childFinish);
    assert.equal(childFinish.outcome, "completed");
    assert.equal(childFinish.durationMs, 750);
    assert.equal(childFinish.totalToolCalls, 2);
    const rootFinish = lifecycle.find((event) => event.type === "run.finished" && event.kind === "root");
    assert.ok(rootFinish);
    assert.equal(rootFinish.outcome, "completed");
    assert.ok(lifecycle.some((event) => event.type === "run.reasoning" && event.kind === "child" && event.reasoningEffort === "high"));
    const serialized = JSON.stringify(lifecycle);
    for (const secret of [rawSecret, descriptorSecret, raw, "PRIVATE CHILD RESULT", "PRIVATE SKILL CONTENT", "C:\\private\\contract\\SKILL.md"]) {
      assert.equal(serialized.includes(secret), false, `contract observability retained ${secret}`);
    }
  }
});

test("Copilot /contract isolates a later invocation from rotated native-tool and task replays", async () => {
  const { coordinator, lifecycle } = contractHarness();
  const sessionId = "rotated-contract-invocation";
  const raw = JSON.stringify({ name: "reviewer", task: "Review safely" });
  const descriptor = { agent_type: "explore", description: "Disposable reviewer", prompt: "Review safely" };
  const base = Date.now() + 1_000;
  const invocation = { sessionId };
  const begin = async (prefix: "A" | "B", offset: number) => {
    await coordinator.hooks.onUserPromptSubmitted({
      sessionId, workingDirectory: project, prompt: `/contract ${raw}`,
    }, invocation);
    const skill = {
      type: "skill.invoked", id: `${prefix}-skill`, parentId: null,
      timestamp: new Date(base + offset).toISOString(),
      data: { name: "contract", pluginName: "agent-foundry", source: "plugin", trigger: "user-invoked" },
    } as const;
    coordinator.observeEvent(skill);
    assert.equal((await coordinator.hooks.onPreToolUse(
      contractInput(sessionId, { definition: raw }, "harbor_contract"), invocation,
    ))?.permissionDecision, "allow");
    const nativeInvocation = contractToolInvocation(sessionId, raw, {
      toolCallId: `${prefix}-contract-call`,
    });
    const toolStart = {
      type: "tool.execution_start", id: `${prefix}-contract-start`, parentId: `${prefix}-skill`,
      timestamp: new Date(base + offset + 1).toISOString(),
      data: {
        toolName: nativeInvocation.toolName,
        toolCallId: nativeInvocation.toolCallId,
        arguments: nativeInvocation.arguments,
      },
    } as const;
    coordinator.observeEvent(toolStart);
    await coordinator.contractToolSucceeded(nativeInvocation, descriptor);
    coordinator.observeEvent({
      type: "tool.execution_complete", id: `${prefix}-contract-complete`, parentId: `${prefix}-contract-start`,
      timestamp: new Date(base + offset + 2).toISOString(),
      data: {
        toolCallId: `${prefix}-contract-call`, success: true,
      },
    });
    return { skill, toolStart };
  };

  const first = await begin("A", 0);
  assert.equal((await coordinator.hooks.onPreToolUse(
    contractInput(sessionId, descriptor), invocation,
  ))?.permissionDecision, "allow");
  const oldTaskStart = {
    type: "tool.execution_start", id: "A-task-start", parentId: "A-contract-complete",
    timestamp: new Date(base + 3).toISOString(),
    data: { toolName: "task", toolCallId: "A-task-call" },
  } as const;
  coordinator.observeEvent(oldTaskStart);
  coordinator.observeEvent({
    type: "session.idle", id: "A-idle", parentId: "A-task-start",
    timestamp: new Date(base + 4).toISOString(), data: { aborted: false },
  });
  for (let index = 0; index < 4_100; index += 1) {
    coordinator.observeEvent({ type: "diagnostic.contract-noop", id: `contract-noop-${index}`, data: {} });
  }

  await begin("B", 100);
  coordinator.observeEvent(first.toolStart);
  assert.equal(coordinator.hostEventDisposition(first.toolStart), "replay");
  // B's authenticated native tool already completed. Replayed A task starts must
  // neither reserve nor conflict with B's one exact task call.
  coordinator.observeEvent(oldTaskStart);
  assert.equal(coordinator.hostEventDisposition(oldTaskStart), "replay");

  assert.equal((await coordinator.hooks.onPreToolUse(
    contractInput(sessionId, descriptor), invocation,
  ))?.permissionDecision, "allow");
  coordinator.observeEvent({
    type: "tool.execution_start", id: "B-task-start", parentId: "B-contract-complete",
    timestamp: new Date(base + 103).toISOString(),
    data: { toolName: "task", toolCallId: "B-task-call" },
  });
  coordinator.observeEvent({
    type: "subagent.started", id: "B-child-start", parentId: "B-task-start", agentId: "B-native-child",
    timestamp: new Date(base + 104).toISOString(),
    data: { agentName: "explore", toolCallId: "B-task-call", model: "child-model" },
  });
  coordinator.observeEvent({
    type: "subagent.completed", id: "B-child-complete", parentId: "B-child-start", agentId: "B-native-child",
    timestamp: new Date(base + 105).toISOString(),
    data: { agentName: "explore", toolCallId: "B-task-call", model: "child-model", totalTokens: 4 },
  });
  await coordinator.hooks.onPostToolUse({
    sessionId, workingDirectory: project, toolName: "task", toolArgs: descriptor, toolResult: "done",
  }, invocation);
  coordinator.observeEvent({
    type: "session.idle", id: "B-idle", parentId: "B-child-complete",
    timestamp: new Date(base + 106).toISOString(), data: { aborted: false },
  });
  const rootFinishes = lifecycle.filter((event) => event.type === "run.finished" && event.kind === "root");
  assert.equal(rootFinishes.at(-1)?.outcome, "completed");
  const finalRootRunId = rootFinishes.at(-1)?.rootRunId;
  assert.equal(lifecycle.filter((event) => event.type === "child.started" &&
    event.rootRunId === finalRootRunId).length, 1,
    "replayed task activity created an extra contractor");
  assert.equal(JSON.stringify(lifecycle).includes(raw), false);
});

test("Copilot /contract skill semantic identity cannot relabel a later ordinary prompt", async () => {
  const { coordinator, lifecycle } = contractHarness();
  const sessionId = "contract-skill-semantic-replay";
  const invocation = { sessionId };
  const timestamp = new Date(Date.now() + 60_000).toISOString();
  await coordinator.hooks.onUserPromptSubmitted({
    sessionId, workingDirectory: project, prompt: "/contract bounded descriptor",
  }, invocation);
  const skill = {
    type: "skill.invoked", id: "semantic-contract-skill-A", parentId: null, timestamp,
    data: {
      sessionId,
      name: "contract", pluginName: "agent-foundry", source: "plugin", trigger: "user-invoked",
      model: "root-model", content: "PRIVATE SKILL A", path: "C:\\private\\skill-A.md",
    },
  } as const;
  coordinator.observeEvent(skill);
  coordinator.observeEvent({
    type: "session.idle", id: "semantic-contract-idle-A", parentId: "semantic-contract-skill-A",
    timestamp: new Date(Date.now() + 60_001).toISOString(), data: { aborted: false },
  });
  assert.equal(lifecycle.filter((event) => event.type === "root.started").length, 1);
  assert.equal(lifecycle.find((event) => event.type === "run.finished" && event.kind === "root")?.outcome, "failed");

  await coordinator.hooks.onUserPromptSubmitted({
    sessionId, workingDirectory: project, prompt: "ordinary prompt that must stay ordinary",
  }, invocation);
  const replay = {
    ...skill,
    id: "semantic-contract-skill-B",
    data: {
      ...skill.data,
      model: "drifted-model",
      content: "PRIVATE SKILL B",
      path: "C:\\private\\skill-B.md",
    },
  } as const;
  coordinator.observeEvent(replay);
  assert.equal(coordinator.hostEventDisposition(replay), "replay");
  assert.equal(lifecycle.filter((event) => event.type === "root.started").length, 1,
    "a late skill replay relabeled an ordinary prompt as /contract");
  assert.equal(JSON.stringify(lifecycle).includes("PRIVATE SKILL"), false);
});

test("Copilot /contract provenance enrichment and drift cannot authenticate a later prompt", async (t) => {
  const exact = {
    name: "contract",
    pluginName: "agent-foundry",
    source: "plugin",
    trigger: "user-invoked",
  } as const;
  const cases = [
    { label: "missing-to-present", before: { name: "contract" }, after: exact },
    { label: "present-to-missing", before: exact, after: { name: "contract" } },
    { label: "plugin-drift", before: { ...exact, pluginName: "other-plugin" }, after: exact },
    { label: "source-drift", before: { ...exact, source: "personal-copilot" }, after: exact },
    { label: "trigger-drift", before: { ...exact, trigger: "agent-invoked" }, after: exact },
    { label: "name-drift", before: { ...exact, name: "other-skill" }, after: exact },
  ] as const;

  for (const scenario of cases) await t.test(scenario.label, async () => {
    const { coordinator, lifecycle } = contractHarness();
    const sessionId = `contract-provenance-${scenario.label}`;
    const invocation = { sessionId };
    const timestampMs = Date.now() + 60_000;
    const timestamp = new Date(timestampMs).toISOString();
    const parentId = `${scenario.label}-shared-parent`;
    await coordinator.hooks.onUserPromptSubmitted({
      sessionId, workingDirectory: project, prompt: "ordinary prompt A",
    }, invocation);
    const first = {
      type: "skill.invoked", id: `${scenario.label}-skill-A`, parentId, timestamp,
      data: scenario.before,
    } as const;
    coordinator.observeEvent(first);
    assert.equal(coordinator.hostEventDisposition(first), "claimed");
    coordinator.observeEvent({
      type: "session.idle", id: `${scenario.label}-idle-A`, parentId: first.id,
      timestamp: new Date(timestampMs + 1).toISOString(), data: { aborted: false },
    });
    const rootsBeforeReplay = lifecycle.filter((event) => event.type === "root.started").length;

    await coordinator.hooks.onUserPromptSubmitted({
      sessionId, workingDirectory: project, prompt: "ordinary prompt B",
    }, invocation);
    const enrichedOrDrifted = {
      type: "skill.invoked", id: `${scenario.label}-skill-B`, parentId, timestamp,
      data: scenario.after,
    } as const;
    coordinator.observeEvent(enrichedOrDrifted);
    assert.equal(coordinator.hostEventDisposition(enrichedOrDrifted), "unverified");
    assert.equal(coordinator.lifecycleIdentityUnverified(), true);
    assert.equal(lifecycle.filter((event) => event.type === "root.started").length, rootsBeforeReplay,
      "optional provenance drift authenticated a fresh /contract root");
  });
});

test("Copilot /contract exposes only its exact native custom tool and rejects lookalikes", async () => {
  const raw = JSON.stringify({
    name: "worker", description: "Bounded worker", prompt: "PRIVATE", tools: ["read"], task: "Review",
  });
  const descriptor = { agent_type: "explore", description: "Bounded worker", prompt: "PRIVATE CHILD" };

  const thirdParty = contractHarness();
  const legacyHookName = ["onPre", "M", "cpToolCall"].join("");
  assert.equal(legacyHookName in thirdParty.coordinator.hooks, false,
    "the coordinator still exposed the removed transport hook");
  const thirdPartySession = "contract-third-party-tool";
  await thirdParty.coordinator.hooks.onUserPromptSubmitted({
    sessionId: thirdPartySession, workingDirectory: project, prompt: "/contract lookalike",
  }, { sessionId: thirdPartySession });
  thirdParty.coordinator.observeEvent({
    type: "skill.invoked", id: "third-party-skill",
    data: { name: "contract", pluginName: "agent-foundry", source: "plugin", trigger: "user-invoked" },
  });
  const provisional = await thirdParty.coordinator.hooks.onPreToolUse(
    contractInput(thirdPartySession, { definition: raw }, "third-party-dangerous"),
    { sessionId: thirdPartySession },
  );
  assert.equal(provisional?.permissionDecision, "deny", "a lookalike tool was authorized");
  thirdParty.coordinator.observeEvent({
    type: "tool.execution_start", id: "third-party-start", parentId: "third-party-skill",
    data: {
      toolName: "third-party-dangerous",
      toolCallId: "third-party-call", arguments: { definition: raw },
    },
  });
  const thirdPartyTask = await thirdParty.coordinator.hooks.onPreToolUse(
    contractInput(thirdPartySession, descriptor), { sessionId: thirdPartySession },
  );
  assert.equal(thirdPartyTask?.permissionDecision, "deny");
  assert.equal(thirdParty.admissions.filter(({ type }) => type === "child").length, 0);
  thirdParty.coordinator.observeEvent({
    type: "session.idle", id: "third-party-idle", parentId: "third-party-start", data: { aborted: false },
  });
  assert.equal(thirdParty.lifecycle.find((event) => event.type === "run.finished" && event.kind === "root")?.outcome, "failed");

  const mismatch = contractHarness();
  const mismatchSession = "contract-native-id-mismatch";
  await mismatch.coordinator.hooks.onUserPromptSubmitted({
    sessionId: mismatchSession, workingDirectory: project, prompt: "/contract mismatch",
  }, { sessionId: mismatchSession });
  mismatch.coordinator.observeEvent({
    type: "skill.invoked", id: "mismatch-skill",
    data: { name: "contract", pluginName: "agent-foundry", source: "plugin", trigger: "user-invoked" },
  });
  assert.equal((await mismatch.coordinator.hooks.onPreToolUse(
    contractInput(mismatchSession, { definition: raw }, "harbor_contract"),
    { sessionId: mismatchSession },
  ))?.permissionDecision, "allow");
  const authenticated = contractToolInvocation(mismatchSession, raw, { toolCallId: "authenticated-call" });
  await mismatch.coordinator.contractToolSucceeded(authenticated, descriptor);
  mismatch.coordinator.observeEvent({
    type: "tool.execution_start", id: "mismatch-contract-start", parentId: "mismatch-skill",
    data: {
      toolName: "harbor_contract",
      toolCallId: "different-execution-call", arguments: { definition: raw },
    },
  });
  const mismatchTask = await mismatch.coordinator.hooks.onPreToolUse(
    contractInput(mismatchSession, descriptor), { sessionId: mismatchSession },
  );
  assert.equal(mismatchTask?.permissionDecision, "deny");
  assert.equal(mismatch.admissions.filter(({ type }) => type === "child").length, 0);
});

test("Copilot /contract closes native arguments and trusts only the authenticated handler descriptor", async (t) => {
  const raw = JSON.stringify({ name: "worker", tools: ["read"], task: "Review safely" });
  const descriptor = { agent_type: "explore", description: "Bounded worker", prompt: "PRIVATE CHILD" };
  const reserve = async (coordinator: ReturnType<typeof createCopilotCoordinatorGuard>, sessionId: string) => {
    await coordinator.hooks.onUserPromptSubmitted({
      sessionId, workingDirectory: project, prompt: `/contract ${raw}`,
    }, { sessionId });
    coordinator.observeEvent({
      type: "skill.invoked", id: `${sessionId}-skill`,
      data: { name: "contract", pluginName: "agent-foundry", source: "plugin", trigger: "user-invoked" },
    });
  };

  for (const [label, toolArgs] of [
    ["extra", { definition: raw, extra: true }],
    ["wrong-type", { definition: 42 }],
    ["serialized", JSON.stringify({ definition: raw })],
  ] as const) await t.test(`closed-pretool-${label}`, async () => {
    const harness = contractHarness();
    const sessionId = `closed-pretool-${label}`;
    await reserve(harness.coordinator, sessionId);
    const denied = await harness.coordinator.hooks.onPreToolUse(
      contractInput(sessionId, toolArgs, "harbor_contract"), { sessionId },
    );
    assert.equal(denied?.permissionDecision, "deny");
    assert.match(denied?.permissionDecisionReason ?? "", /exactly \{definition:string\}/u);
    assert.equal(harness.admissions.filter(({ type }) => type === "child").length, 0);
  });

  await t.test("closed-handler-invocation", async () => {
    const harness = contractHarness();
    const sessionId = "closed-handler-invocation";
    await reserve(harness.coordinator, sessionId);
    assert.equal((await harness.coordinator.hooks.onPreToolUse(
      contractInput(sessionId, { definition: raw }, "harbor_contract"), { sessionId },
    ))?.permissionDecision, "allow");
    await assert.rejects(harness.coordinator.contractToolSucceeded({
      ...contractToolInvocation(sessionId, raw),
      unexpected: "must fail closed",
    } as any, descriptor), /unauthenticated/u);
    const denied = await harness.coordinator.hooks.onPreToolUse(
      contractInput(sessionId, descriptor), { sessionId },
    );
    assert.equal(denied?.permissionDecision, "deny");
    assert.equal(harness.admissions.filter(({ type }) => type === "child").length, 0);
  });

  await t.test("sdk-trace-context", async () => {
    const harness = contractHarness();
    const sessionId = "contract-sdk-trace-context";
    await reserve(harness.coordinator, sessionId);
    assert.equal((await harness.coordinator.hooks.onPreToolUse(
      contractInput(sessionId, { definition: raw }, "harbor_contract"), { sessionId },
    ))?.permissionDecision, "allow");
    await harness.coordinator.contractToolSucceeded({
      ...contractToolInvocation(sessionId, raw),
      traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
      tracestate: "vendor=value",
    }, descriptor);
    assert.equal((await harness.coordinator.hooks.onPreToolUse(
      contractInput(sessionId, descriptor), { sessionId },
    ))?.permissionDecision, "allow");
    assert.equal(harness.admissions.filter(({ type }) => type === "child").length, 1);
  });

  await t.test("native-completion-cannot-authenticate", async () => {
    const harness = contractHarness();
    const sessionId = "native-completion-cannot-authenticate";
    await authenticateContractTool(harness.coordinator, sessionId, raw);
    harness.coordinator.observeEvent({
      type: "tool.execution_complete", id: `${sessionId}-contract-complete`,
      parentId: `${sessionId}-contract-start`,
      data: {
        toolCallId: `${sessionId}-contract-call`, success: true,
        result: { descriptor, privateResult: "MUST NOT BE TRUSTED" },
      },
    });
    const denied = await harness.coordinator.hooks.onPreToolUse(
      contractInput(sessionId, descriptor), { sessionId },
    );
    assert.equal(denied?.permissionDecision, "deny");
    assert.match(denied?.permissionDecisionReason ?? "", /authenticates one exact descriptor/u);
    assert.equal(harness.admissions.filter(({ type }) => type === "child").length, 0);
  });

  await t.test("native-start-before-pretool-cannot-drift", async () => {
    const harness = contractHarness();
    const sessionId = "native-start-before-pretool-drift";
    await reserve(harness.coordinator, sessionId);
    const drifted = contractToolInvocation(sessionId, `${raw} `);
    harness.coordinator.observeEvent({
      type: "tool.execution_start", id: `${sessionId}-contract-start`, parentId: `${sessionId}-skill`,
      data: {
        toolName: drifted.toolName,
        toolCallId: drifted.toolCallId,
        arguments: drifted.arguments,
      },
    });
    assert.equal((await harness.coordinator.hooks.onPreToolUse(
      contractInput(sessionId, { definition: raw }, "harbor_contract"), { sessionId },
    ))?.permissionDecision, "allow");
    await assert.rejects(harness.coordinator.contractToolSucceeded(
      contractToolInvocation(sessionId, raw), descriptor,
    ), /exactly one/u);
    const denied = await harness.coordinator.hooks.onPreToolUse(
      contractInput(sessionId, descriptor), { sessionId },
    );
    assert.equal(denied?.permissionDecision, "deny");
    assert.equal(harness.admissions.filter(({ type }) => type === "child").length, 0);
  });

  await t.test("handler-before-pretool", async () => {
    const harness = contractHarness();
    const sessionId = "handler-before-pretool";
    await reserve(harness.coordinator, sessionId);
    await assert.rejects(harness.coordinator.contractToolSucceeded(
      contractToolInvocation(sessionId, raw), descriptor,
    ), /pre-tool/u);
    const denied = await harness.coordinator.hooks.onPreToolUse(
      contractInput(sessionId, { definition: raw }, "harbor_contract"), { sessionId },
    );
    assert.equal(denied?.permissionDecision, "deny");
  });
});

test("Copilot /contract relabels the same-prompt selected root without losing its prior telemetry", async () => {
  const sessionId = "selected-root-contract";
  const crafter = copilotFixedAgentIds.get("crafter")!;
  const agents = [fixedCopilotIdentity("crafter", { model: "profile-model" })];
  const lifecycle: CopilotCoordinatorLifecycleEvent[] = [];
  const admissions: any[] = [];
  const coordinator = createCopilotCoordinatorGuard(() => ({ rpc: { agent: {
    getCurrent: async () => ({ agent: agents[0] }),
    reload: async () => ({ agents }),
  } } }), undefined, (event) => { lifecycle.push(event); }, (input) => { admissions.push(input); });
  const raw = JSON.stringify({
    name: "selected-contractor", description: "One child", prompt: "PRIVATE ROOT-ATTACHED PROMPT",
    tools: ["read"], task: "Inspect selected-root behavior",
  });
  const descriptor = { agent_type: "explore", description: "One child", prompt: "PRIVATE VALIDATED CHILD PROMPT" };
  coordinator.observeEvent({
    type: "session.start", id: "selected-session-start",
    data: { selectedModel: "host-default", reasoningEffort: "low" },
  });
  await coordinator.refresh();
  await coordinator.hooks.onUserPromptSubmitted({
    sessionId, workingDirectory: project, prompt: `Use this context first /contract ${raw}`,
  }, { sessionId });
  const originalRoot = lifecycle.find((event) => event.type === "root.started");
  assert.ok(originalRoot);
  assert.equal(originalRoot.agent, "crafter");
  assert.equal(originalRoot.taskLabel, "request references /contract; details hidden");
  coordinator.observeEvent({
    type: "assistant.usage", id: "selected-root-usage-before-contract", parentId: "previous-native-event",
    timestamp: new Date(Date.now() + 10).toISOString(),
    data: {
      apiCallId: "selected-root-call-before-contract",
      model: "profile-model",
      reasoningEffort: "low",
      inputTokens: 9,
      outputTokens: 2,
    },
  });
  coordinator.observeEvent({
    type: "skill.invoked", id: "selected-contract-skill", parentId: "selected-root-usage-before-contract",
    timestamp: new Date(Date.now() + 20).toISOString(),
    data: { name: "contract", pluginName: "agent-foundry", source: "plugin", trigger: "user-invoked", model: "profile-model" },
  });
  const identity = lifecycle.find((event) => event.type === "run.identity");
  assert.ok(identity);
  assert.equal(identity.runId, originalRoot.runId);
  assert.equal(identity.agent, "contract");
  assert.equal(identity.memberKind, "utility");
  assert.equal(identity.taskLabel, "validate and run one disposable contractor");
  assert.equal(lifecycle.filter((event) => event.type === "root.started").length, 1);
  assert.equal(admissions.filter(({ type }) => type === "root").length, 1,
    "relabeling the selected root changed its single admission reservation");
  const tool = contractInput(sessionId, { definition: raw }, "harbor_contract");
  assert.equal((await coordinator.hooks.onPreToolUse(tool, { sessionId }))?.permissionDecision, "allow");
  const nativeInvocation = contractToolInvocation(sessionId, raw, {
    toolCallId: "selected-contract-call",
  });
  coordinator.observeEvent({
    type: "tool.execution_start", id: "selected-contract-start", parentId: "selected-contract-skill",
    data: {
      toolName: nativeInvocation.toolName,
      toolCallId: nativeInvocation.toolCallId,
      arguments: nativeInvocation.arguments,
    },
  });
  await coordinator.contractToolSucceeded(nativeInvocation, descriptor);
  coordinator.observeEvent({
    type: "tool.execution_complete", id: "selected-contract-complete", parentId: "selected-contract-start",
    data: { toolCallId: "selected-contract-call", success: true },
  });
  assert.equal((await coordinator.hooks.onPreToolUse(contractInput(sessionId, descriptor), { sessionId }))?.permissionDecision, "allow");
  coordinator.observeEvent({
    type: "tool.execution_start", id: "selected-task-start", parentId: "selected-contract-complete",
    data: { toolName: "task", toolCallId: "selected-task-call" },
  });
  coordinator.observeEvent({
    type: "subagent.started", id: "selected-child-start", parentId: "selected-task-start", agentId: "selected-native-child",
    data: { agentName: "explore", toolCallId: "selected-task-call", model: "child-model" },
  });
  coordinator.observeEvent({
    type: "assistant.usage", id: "selected-child-usage", parentId: "selected-child-start", agentId: "selected-native-child",
    data: { parentToolCallId: "selected-task-call", model: "child-model", reasoningEffort: "high", inputTokens: 5, outputTokens: 1 },
  });
  coordinator.observeEvent({
    type: "subagent.completed", id: "selected-child-complete", parentId: "selected-child-usage", agentId: "selected-native-child",
    data: { agentName: "explore", toolCallId: "selected-task-call", model: "child-model", totalTokens: 6 },
  });
  coordinator.observeEvent({
    type: "tool.execution_complete", id: "selected-task-complete", parentId: "selected-child-complete",
    data: { toolCallId: "selected-task-call", toolDescription: { name: "task" }, success: true },
  });
  coordinator.observeEvent({
    type: "session.idle", id: "selected-root-idle", parentId: "selected-task-complete", data: { aborted: false },
  });
  assert.deepEqual(admissions.map(({ type, memberKind }) => [type, memberKind]), [
    ["root", undefined],
    ["child", "contractor"],
  ]);
  assert.equal(lifecycle.filter((event) => event.type === "run.usage" && event.kind === "root").length, 1);
  assert.equal(lifecycle.filter((event) => event.type === "run.usage" && event.kind === "child").length, 1);
  assert.equal(lifecycle.find((event) => event.type === "run.finished" && event.kind === "root")?.outcome, "completed");
  const serialized = JSON.stringify(lifecycle);
  assert.equal(serialized.includes("PRIVATE ROOT-ATTACHED PROMPT"), false);
  assert.equal(serialized.includes("PRIVATE VALIDATED CHILD PROMPT"), false);
});

test("Copilot hides ambiguous inline /contract details without reserving a wrapper before exact skill provenance", async () => {
  const crafter = copilotFixedAgentIds.get("crafter")!;
  const agents = [fixedCopilotIdentity("crafter")];
  const lifecycle: CopilotCoordinatorLifecycleEvent[] = [];
  const admissions: any[] = [];
  const coordinator = createCopilotCoordinatorGuard(() => ({ rpc: { agent: {
    getCurrent: async () => ({ agent: agents[0] }),
    reload: async () => ({ agents }),
  } } }), undefined, (event) => { lifecycle.push(event); }, (input) => { admissions.push(input); });
  await coordinator.refresh();
  await coordinator.hooks.onUserPromptSubmitted({
    sessionId: "ambiguous-inline-contract", workingDirectory: project,
    prompt: "Please explain /agent-foundry/contract syntax and PRIVATE-INLINE-MENTION",
  }, { sessionId: "ambiguous-inline-contract" });
  const root = lifecycle.find((event) => event.type === "root.started");
  assert.equal(root?.agent, "crafter");
  assert.equal(root?.taskLabel, "request references /contract; details hidden");
  assert.equal(lifecycle.some((event) => event.type === "run.identity"), false);
  assert.equal(admissions.length, 1);
  assert.equal(admissions[0].type, "root");
  assert.equal(JSON.stringify(lifecycle).includes("PRIVATE-INLINE-MENTION"), false);
  const denied = await coordinator.hooks.onPreToolUse(contractInput("ambiguous-inline-contract", {
    agent_type: "explore", description: "missing provenance", prompt: "must not run",
  }), { sessionId: "ambiguous-inline-contract" });
  assert.equal(denied?.permissionDecision, "deny");
  assert.match(denied?.permissionDecisionReason ?? "", /provenance is observed/u);
  assert.equal(admissions.length, 1);
});

test("Copilot selected /contract skill activity closes abandoned wrappers and child admission still fails before model start", async () => {
  const crafter = copilotFixedAgentIds.get("crafter")!;
  const agents = [fixedCopilotIdentity("crafter", { model: "profile-model" })];
  const abandonedLifecycle: CopilotCoordinatorLifecycleEvent[] = [];
  const abandoned = createCopilotCoordinatorGuard(() => ({ rpc: { agent: {
    getCurrent: async () => ({ agent: agents[0] }),
    reload: async () => ({ agents }),
  } } }), undefined, (event) => { abandonedLifecycle.push(event); });
  await abandoned.refresh();
  const abandonedSession = "selected-abandoned-contract";
  await abandoned.hooks.onUserPromptSubmitted({
    sessionId: abandonedSession, workingDirectory: project, prompt: "/contract abandoned",
  }, { sessionId: abandonedSession });
  abandoned.observeEvent({
    type: "skill.invoked", id: "selected-abandoned-skill",
    data: { name: "contract", pluginName: "agent-foundry", source: "plugin", trigger: "user-invoked" },
  });
  abandoned.observeEvent({
    type: "session.idle", id: "selected-abandoned-idle", parentId: "selected-abandoned-skill",
    data: { aborted: false },
  });
  assert.equal(abandonedLifecycle.find((event) =>
    event.type === "run.finished" && event.kind === "root")?.outcome, "failed");
  await abandoned.hooks.onUserPromptSubmitted({
    sessionId: "selected-after-abandoned", workingDirectory: project, prompt: "ordinary next turn",
  }, { sessionId: "selected-after-abandoned" });
  assert.equal(abandonedLifecycle.filter((event) => event.type === "root.started").length, 2,
    "an abandoned selected contract root remained mapped after idle");

  const raw = JSON.stringify({ name: "worker", description: "x", prompt: "PRIVATE", tools: ["read"], task: "review" });
  const descriptor = { agent_type: "explore", description: "Validated", prompt: "PRIVATE CHILD" };
  const admissionLifecycle: CopilotCoordinatorLifecycleEvent[] = [];
  const admissions: any[] = [];
  const admission = createCopilotCoordinatorGuard(() => ({ rpc: { agent: {
    getCurrent: async () => ({ agent: agents[0] }),
    reload: async () => ({ agents }),
  } } }), undefined, (event) => { admissionLifecycle.push(event); }, (input) => {
    admissions.push(input);
    if (input.type === "child") throw new Error("selected child capacity unavailable");
  });
  await admission.refresh();
  const admissionSession = "selected-contract-child-admission";
  await beginContract(admission, admissionSession, raw, descriptor);
  const denied = await admission.hooks.onPreToolUse(
    contractInput(admissionSession, descriptor), { sessionId: admissionSession },
  );
  assert.equal(denied?.permissionDecision, "deny");
  assert.match(denied?.permissionDecisionReason ?? "", /selected child capacity unavailable/u);
  assert.equal(admissionLifecycle.filter((event) => event.type === "root.started").length, 1);
  assert.equal(admissionLifecycle.filter((event) => event.type === "child.started").length, 0);
  assert.equal(admissions.filter(({ type }) => type === "root").length, 1,
    "selected-root relabel changed its single root admission");
  admission.observeEvent({
    type: "session.idle", id: "selected-child-admission-idle",
    parentId: `${admissionSession}-contract-complete`, data: { aborted: false },
  });
  assert.equal(admissionLifecycle.find((event) =>
    event.type === "run.finished" && event.kind === "root")?.outcome, "failed");
});

test("Copilot /contract rejects malformed native-handler descriptors", async () => {
  const raw = JSON.stringify({ name: "worker", description: "x", prompt: "PRIVATE", tools: ["read"], task: "review" });
  const descriptor = { agent_type: "explore", description: "Validated", prompt: "PRIVATE CHILD" };
  const cases: Array<{ label: string; descriptor: unknown }> = [
    { label: "string", descriptor: "corrupt" },
    { label: "array", descriptor: [descriptor] },
    { label: "null", descriptor: null },
    { label: "extra-field", descriptor: { ...descriptor, private_extra: "must fail closed" } },
    { label: "missing-prompt", descriptor: { agent_type: "explore", description: "missing" } },
  ];
  for (const candidate of cases) {
    const harness = contractHarness();
    const sessionId = `descriptor-${candidate.label}`;
    await authenticateContractTool(harness.coordinator, sessionId, raw);
    await assert.rejects(harness.coordinator.contractToolSucceeded(
      contractToolInvocation(sessionId, raw),
      candidate.descriptor as typeof descriptor,
    ), /exact descriptor/u, candidate.label);
    const denied = await harness.coordinator.hooks.onPreToolUse(
      contractInput(sessionId, descriptor), { sessionId },
    );
    assert.equal(denied?.permissionDecision, "deny", candidate.label);
    assert.equal(harness.admissions.filter(({ type }) => type === "child").length, 0, candidate.label);
    harness.coordinator.observeEvent({
      type: "session.idle", id: `${sessionId}-idle`, parentId: `${sessionId}-contract-start`,
      data: { aborted: false },
    });
    assert.equal(harness.lifecycle.find((event) =>
      event.type === "run.finished" && event.kind === "root")?.outcome, "failed", candidate.label);
  }
});

test("Copilot /contract binds its native tool, handler, and task to the prompt session and project", async () => {
  const otherProject = `${project}-other`;
  const raw = JSON.stringify({ name: "worker", description: "x", prompt: "PRIVATE", tools: ["read"], task: "review" });
  const descriptor = { agent_type: "explore", description: "Validated", prompt: "PRIVATE CHILD" };

  const tool = contractHarness();
  const toolSession = "contract-cross-project-tool";
  await tool.coordinator.hooks.onUserPromptSubmitted({
    sessionId: toolSession, workingDirectory: project, prompt: `/contract ${raw}`,
  }, { sessionId: toolSession });
  tool.coordinator.observeEvent({
    type: "skill.invoked", id: "cross-project-tool-skill",
    data: { name: "contract", pluginName: "agent-foundry", source: "plugin", trigger: "user-invoked" },
  });
  const crossTool = await tool.coordinator.hooks.onPreToolUse({
    ...contractInput(toolSession, { definition: raw }, "harbor_contract"),
    workingDirectory: otherProject,
  }, { sessionId: toolSession });
  assert.equal(crossTool?.permissionDecision, "deny");
  assert.match(crossTool?.permissionDecisionReason ?? "", /working directory changed/u);
  assert.equal(tool.admissions.filter(({ type }) => type === "child").length, 0);

  const handler = contractHarness();
  const handlerSession = "contract-cross-session-handler";
  await handler.coordinator.hooks.onUserPromptSubmitted({
    sessionId: handlerSession, workingDirectory: project, prompt: `/contract ${raw}`,
  }, { sessionId: handlerSession });
  handler.coordinator.observeEvent({
    type: "skill.invoked", id: "cross-session-handler-skill",
    data: { name: "contract", pluginName: "agent-foundry", source: "plugin", trigger: "user-invoked" },
  });
  assert.equal((await handler.coordinator.hooks.onPreToolUse(
    contractInput(handlerSession, { definition: raw }, "harbor_contract"), { sessionId: handlerSession },
  ))?.permissionDecision, "allow");
  await assert.rejects(handler.coordinator.contractToolSucceeded(
    contractToolInvocation("different-session", raw), descriptor,
  ), /unauthenticated/u);
  const afterCrossSession = await handler.coordinator.hooks.onPreToolUse(
    contractInput(handlerSession, descriptor), { sessionId: handlerSession },
  );
  assert.equal(afterCrossSession?.permissionDecision, "deny");
  assert.match(afterCrossSession?.permissionDecisionReason ?? "", /authenticates one exact descriptor/u);
  assert.equal(handler.admissions.filter(({ type }) => type === "child").length, 0);

  const task = contractHarness();
  const taskSession = "contract-cross-project-task";
  await beginContract(task.coordinator, taskSession, raw, descriptor);
  const crossTask = await task.coordinator.hooks.onPreToolUse({
    ...contractInput(taskSession, descriptor), workingDirectory: otherProject,
  }, { sessionId: taskSession });
  assert.equal(crossTask?.permissionDecision, "deny");
  assert.match(crossTask?.permissionDecisionReason ?? "", /working directory changed/u);
  assert.equal(task.admissions.filter(({ type }) => type === "child").length, 0);
  task.coordinator.observeEvent({
    type: "session.idle", id: "cross-project-task-idle",
    parentId: `${taskSession}-contract-complete`, data: { aborted: false },
  });
  assert.equal(task.lifecycle.find((event) =>
    event.type === "run.finished" && event.kind === "root")?.outcome, "failed");
});

test("Copilot /contract fails closed on duplicate skills, child admission failure, and native child identity drift", async () => {
  const raw = JSON.stringify({ name: "worker", description: "x", prompt: "PRIVATE", tools: ["read"], task: "review" });
  const descriptor = { agent_type: "explore", description: "Validated", prompt: "PRIVATE CHILD" };

  const duplicate = contractHarness();
  const duplicateSession = "duplicate-contract-skill";
  await duplicate.coordinator.hooks.onUserPromptSubmitted({
    sessionId: duplicateSession, workingDirectory: project, prompt: `/contract ${raw}`,
  }, { sessionId: duplicateSession });
  for (const id of ["duplicate-contract-skill-a", "duplicate-contract-skill-b"]) {
    duplicate.coordinator.observeEvent({
      type: "skill.invoked", id,
      data: { name: "contract", pluginName: "agent-foundry", source: "plugin", trigger: "user-invoked" },
    });
  }
  const duplicateDecision = await duplicate.coordinator.hooks.onPreToolUse(
    contractInput(duplicateSession, { definition: raw }, "harbor_contract"),
    { sessionId: duplicateSession },
  );
  assert.equal(duplicateDecision?.permissionDecision, "deny");
  assert.match(duplicateDecision?.permissionDecisionReason ?? "", /only once per user turn/u);
  assert.equal(duplicate.admissions.filter(({ type }) => type === "child").length, 0);
  duplicate.coordinator.observeEvent({
    type: "session.idle", id: "duplicate-contract-idle", data: { aborted: false },
  });
  assert.equal(duplicate.lifecycle.find((event) =>
    event.type === "run.finished" && event.kind === "root")?.outcome, "failed");

  const admission = contractHarness(undefined, "child capacity unavailable");
  const admissionSession = "contract-child-admission-failure";
  await beginContract(admission.coordinator, admissionSession, raw, descriptor);
  const admissionDecision = await admission.coordinator.hooks.onPreToolUse(
    contractInput(admissionSession, descriptor), { sessionId: admissionSession },
  );
  assert.equal(admissionDecision?.permissionDecision, "deny");
  assert.match(admissionDecision?.permissionDecisionReason ?? "", /child admission failed.*capacity unavailable/u);
  assert.equal(admission.lifecycle.filter((event) => event.type === "child.started").length, 0);
  admission.coordinator.observeEvent({
    type: "session.idle", id: "contract-child-admission-idle",
    parentId: `${admissionSession}-contract-complete`, data: { aborted: false },
  });
  assert.equal(admission.lifecycle.find((event) =>
    event.type === "run.finished" && event.kind === "root")?.outcome, "failed");

  for (const variant of ["wrong-name", "second-child", "prestart-drift", "no-native-child"] as const) {
    const native = contractHarness();
    const sessionId = `contract-native-${variant}`;
    await beginContract(native.coordinator, sessionId, raw, descriptor);
    assert.equal((await native.coordinator.hooks.onPreToolUse(
      contractInput(sessionId, descriptor), { sessionId },
    ))?.permissionDecision, "allow");
    native.coordinator.observeEvent({
      type: "tool.execution_start", id: `${sessionId}-task-start`,
      parentId: `${sessionId}-contract-complete`, data: { toolName: "task", toolCallId: `${sessionId}-task-call` },
    });
    let taskCompleteParentId = `${sessionId}-task-start`;
    if (variant === "prestart-drift") {
      native.coordinator.observeEvent({
        type: "assistant.usage", id: `${sessionId}-provisional-child-usage`,
        parentId: `${sessionId}-task-start`, agentId: `${sessionId}-child-b`,
        data: {
          parentToolCallId: `${sessionId}-task-call`, serviceRequestId: "provisional-child-request",
          inputTokens: 7, outputTokens: 1,
        },
      });
    }
    if (variant !== "no-native-child") {
      native.coordinator.observeEvent({
        type: "subagent.started", id: `${sessionId}-child-start-a`,
        parentId: `${sessionId}-task-start`, agentId: `${sessionId}-child-a`,
        data: {
          agentName: variant === "wrong-name" ? "wrong-agent" : "explore",
          toolCallId: `${sessionId}-task-call`, model: "child-model",
        },
      });
    }
    if (variant === "second-child") {
      native.coordinator.observeEvent({
        type: "subagent.started", id: `${sessionId}-child-start-a-replay`,
        parentId: `${sessionId}-task-start`, agentId: `${sessionId}-child-a`,
        data: { agentName: "explore", toolCallId: `${sessionId}-task-call`, model: "child-model" },
      });
      native.coordinator.observeEvent({
        type: "assistant.usage", id: `${sessionId}-child-b-usage`,
        parentId: `${sessionId}-task-start`, agentId: `${sessionId}-child-b`,
        data: {
          parentToolCallId: `${sessionId}-task-call`, serviceRequestId: "wrong-child-request",
          inputTokens: 999, outputTokens: 999,
        },
      });
      native.coordinator.observeEvent({
        type: "subagent.started", id: `${sessionId}-child-start-b`,
        parentId: `${sessionId}-child-b-usage`, agentId: `${sessionId}-child-b`,
        data: { agentName: "explore", toolCallId: `${sessionId}-task-call`, model: "child-model" },
      });
      taskCompleteParentId = `${sessionId}-child-start-b`;
    }
    if (variant === "no-native-child") {
      await native.coordinator.hooks.onPostToolUse({
        sessionId, workingDirectory: project, toolName: "task", toolArgs: descriptor,
        toolResult: "PRIVATE CHILD RESULT",
      }, { sessionId });
    } else {
      native.coordinator.observeEvent({
        type: "tool.execution_complete", id: `${sessionId}-task-complete`,
        parentId: taskCompleteParentId,
        data: {
          toolCallId: `${sessionId}-task-call`, toolDescription: { name: "task" },
          success: true, result: "PRIVATE CHILD RESULT",
        },
      });
    }
    native.coordinator.observeEvent({
      type: "session.idle", id: `${sessionId}-idle`,
      parentId: variant === "no-native-child" ? `${sessionId}-task-start` : `${sessionId}-task-complete`,
      data: { aborted: false },
    });
    assert.equal(native.lifecycle.filter((event) =>
      event.type === "child.started" && event.kind === "child").length, 1, variant);
    assert.equal(native.lifecycle.find((event) =>
      event.type === "run.finished" && event.kind === "child")?.outcome, "failed", variant);
    assert.equal(native.lifecycle.find((event) =>
      event.type === "run.finished" && event.kind === "root")?.outcome, "failed", variant);
    if (variant === "second-child") {
      assert.equal(native.lifecycle.some((event) =>
        event.type === "run.usage" && event.usage.inputTokens === 999), false,
      "activity from a second child identity was attributed to the admitted contractor");
    }
    if (variant === "prestart-drift") {
      assert.equal(native.lifecycle.find((event) =>
        event.type === "run.usage" && event.kind === "child")?.usage.totalTokens, 8,
      "the provisional child usage identity was lost before the conflicting native start");
    }
  }

  const unrelated = contractHarness();
  const unrelatedSession = "contract-unrelated-subagent";
  await beginContract(unrelated.coordinator, unrelatedSession, raw, descriptor);
  assert.equal((await unrelated.coordinator.hooks.onPreToolUse(
    contractInput(unrelatedSession, descriptor), { sessionId: unrelatedSession },
  ))?.permissionDecision, "allow");
  unrelated.coordinator.observeEvent({
    type: "tool.execution_start", id: "contract-terminal-only-task-start",
    parentId: `${unrelatedSession}-contract-complete`,
    data: { toolName: "task", toolCallId: `${unrelatedSession}-task-call` },
  });
  unrelated.coordinator.observeEvent({
    type: "subagent.started", id: "unrelated-child-start", agentId: "unrelated-child",
    data: { agentName: "other-agent", toolCallId: "unrelated-task-call" },
  });
  unrelated.coordinator.observeEvent({
    type: "subagent.completed", id: "contract-terminal-only", agentId: "terminal-only-child",
    data: {
      agentName: "explore", toolCallId: `${unrelatedSession}-task-call`, model: "child-model",
      durationMs: 10, totalTokens: 4, totalToolCalls: 1,
    },
  });
  unrelated.coordinator.observeEvent({
    type: "tool.execution_complete", id: "contract-terminal-only-tool-complete",
    data: {
      toolCallId: `${unrelatedSession}-task-call`, toolDescription: { name: "task" }, success: true,
      result: "PRIVATE",
    },
  });
  unrelated.coordinator.observeEvent({ type: "session.idle", id: "contract-terminal-only-idle", data: { aborted: false } });
  assert.equal(unrelated.lifecycle.find((event) =>
    event.type === "run.finished" && event.kind === "child")?.outcome, "completed");
  assert.ok(unrelated.lifecycle.find((event) =>
    event.type === "child.started" && event.kind === "child")?.childId,
  "a terminal-only exact native child did not seal its identity");
  assert.equal(unrelated.lifecycle.find((event) =>
    event.type === "run.finished" && event.kind === "root")?.outcome, "completed");
});

test("Copilot /contract fails exactly once after critical usage identity becomes ambiguous", async () => {
  const raw = JSON.stringify({
    name: "ambiguous-reviewer", description: "Bounded reviewer", prompt: "PRIVATE RAW AMBIGUITY",
    tools: ["read"], task: "Review bounded target",
  });
  const descriptor = {
    agent_type: "explore", description: "Bounded reviewer", prompt: "PRIVATE CHILD AMBIGUITY",
  };
  const { coordinator, lifecycle } = contractHarness();
  const sessionId = "contract-critical-usage-ambiguity";
  const invocation = { sessionId };
  await beginContract(coordinator, sessionId, raw, descriptor);
  const task = contractInput(sessionId, descriptor);
  assert.equal((await coordinator.hooks.onPreToolUse(task, invocation))?.permissionDecision, "allow");
  coordinator.observeEvent({
    type: "tool.execution_start", id: "ambiguity-task-start",
    parentId: `${sessionId}-contract-complete`,
    data: { toolName: "task", toolCallId: "ambiguity-task-call" },
  });
  coordinator.observeEvent({
    type: "subagent.started", id: "ambiguity-child-start", parentId: "ambiguity-task-start",
    agentId: "ambiguity-native-child",
    data: { agentName: "explore", toolCallId: "ambiguity-task-call", model: "child-model" },
  });
  const timestamp = new Date(Date.now() + 60_000).toISOString();
  const anonymousUsage = {
    type: "assistant.usage", parentId: "ambiguity-child-start", timestamp,
    agentId: "ambiguity-native-child",
    data: {
      parentToolCallId: "ambiguity-task-call", model: "child-model",
      inputTokens: 5, outputTokens: 1,
    },
  } as const;
  coordinator.observeEvent(anonymousUsage);
  const identifiedDrift = {
    ...anonymousUsage,
    id: "ambiguity-identified-usage",
    data: {
      ...anonymousUsage.data,
      serviceRequestId: "ambiguity-service-call", inputTokens: 999, outputTokens: 999,
    },
  } as const;
  coordinator.observeEvent(identifiedDrift);
  assert.equal(coordinator.hostEventDisposition(identifiedDrift), "unverified");
  assert.equal(coordinator.lifecycleIdentityUnverified(), true);

  coordinator.observeEvent({
    type: "subagent.completed", id: "ambiguity-child-complete", parentId: "ambiguity-child-start",
    agentId: "ambiguity-native-child",
    data: { agentName: "explore", toolCallId: "ambiguity-task-call", model: "child-model" },
  });
  coordinator.observeEvent({
    type: "tool.execution_complete", id: "ambiguity-task-complete", parentId: "ambiguity-child-complete",
    data: { toolCallId: "ambiguity-task-call", toolDescription: { name: "task" }, success: true },
  });
  await coordinator.hooks.onPostToolUse({
    ...task, toolResult: "PRIVATE RESULT AMBIGUITY",
  }, invocation);
  coordinator.observeEvent({
    type: "session.idle", id: "ambiguity-root-idle", parentId: "ambiguity-task-complete",
    data: { aborted: false },
  });

  const finishes = lifecycle.filter((event) => event.type === "run.finished");
  assert.deepEqual(finishes.map((event) => [event.kind, event.outcome]), [
    ["child", "failed"],
    ["root", "failed"],
  ]);
  assert.equal(lifecycle.filter((event) => event.type === "child.started").length, 1);
  assert.equal(lifecycle.filter((event) => event.type === "run.usage" && event.usage.totalTokens === 6).length, 1);
  assert.equal(lifecycle.some((event) => event.type === "run.usage" && event.usage.inputTokens === 999), false);
  assert.equal(lifecycle.filter((event) => event.type === "run.usage" && event.attributionUnverified).length, 1);
  for (const secret of [
    "PRIVATE RAW AMBIGUITY", "PRIVATE CHILD AMBIGUITY", "PRIVATE RESULT AMBIGUITY",
  ]) {
    assert.equal(JSON.stringify(lifecycle).includes(secret), false);
  }
});

test("Copilot /contract buffers a successful post-tool hook until the exact native child terminal", async () => {
  const raw = JSON.stringify({ name: "worker", description: "x", prompt: "PRIVATE", tools: ["read"], task: "review" });
  const descriptor = { agent_type: "explore", description: "Validated", prompt: "PRIVATE CHILD" };
  for (const order of ["hook-before-terminal", "hook-after-terminal"] as const) {
    const harness = contractHarness();
    const sessionId = `contract-${order}`;
    await beginContract(harness.coordinator, sessionId, raw, descriptor);
    assert.equal((await harness.coordinator.hooks.onPreToolUse(
      contractInput(sessionId, descriptor), { sessionId },
    ))?.permissionDecision, "allow");
    harness.coordinator.observeEvent({
      type: "tool.execution_start", id: `${sessionId}-task-start`,
      parentId: `${sessionId}-contract-complete`,
      data: { toolName: "task", toolCallId: `${sessionId}-task-call` },
    });
    harness.coordinator.observeEvent({
      type: "subagent.started", id: `${sessionId}-child-start`,
      parentId: `${sessionId}-task-start`, agentId: `${sessionId}-child`,
      data: { agentName: "explore", toolCallId: `${sessionId}-task-call`, model: "child-model" },
    });
    const postTool = () => harness.coordinator.hooks.onPostToolUse({
      sessionId, workingDirectory: project, toolName: "task", toolArgs: descriptor,
      toolResult: "PRIVATE CHILD RESULT",
    }, { sessionId });
    if (order === "hook-before-terminal") {
      await postTool();
      assert.equal(harness.lifecycle.some((event) =>
        event.type === "run.finished" && event.kind === "child"), false,
      "postToolUse finalized a contract before its native child terminal");
    }
    harness.coordinator.observeEvent({
      type: "subagent.completed", id: `${sessionId}-child-complete`,
      parentId: `${sessionId}-child-start`, agentId: `${sessionId}-child`,
      data: {
        agentName: "explore", toolCallId: `${sessionId}-task-call`, model: "child-model",
        durationMs: 10, totalTokens: 4, totalToolCalls: 1,
      },
    });
    if (order === "hook-after-terminal") await postTool();
    harness.coordinator.observeEvent({
      type: "session.idle", id: `${sessionId}-idle`, parentId: `${sessionId}-child-complete`,
      data: { aborted: false },
    });
    assert.equal(harness.lifecycle.find((event) =>
      event.type === "run.finished" && event.kind === "child")?.outcome, "completed", order);
    assert.equal(harness.lifecycle.find((event) =>
      event.type === "run.finished" && event.kind === "root")?.outcome, "completed", order);
  }

  for (const terminal of ["subagent.completed", "subagent.failed"] as const) {
    const harness = contractHarness();
    const sessionId = `contract-tool-complete-before-${terminal}`;
    await beginContract(harness.coordinator, sessionId, raw, descriptor);
    assert.equal((await harness.coordinator.hooks.onPreToolUse(
      contractInput(sessionId, descriptor), { sessionId },
    ))?.permissionDecision, "allow");
    harness.coordinator.observeEvent({
      type: "tool.execution_start", id: `${sessionId}-task-start`,
      parentId: `${sessionId}-contract-complete`,
      data: { toolName: "task", toolCallId: `${sessionId}-task-call` },
    });
    harness.coordinator.observeEvent({
      type: "subagent.started", id: `${sessionId}-child-start`,
      parentId: `${sessionId}-task-start`, agentId: `${sessionId}-child`,
      data: { agentName: "explore", toolCallId: `${sessionId}-task-call` },
    });
    harness.coordinator.observeEvent({
      type: "tool.execution_complete", id: `${sessionId}-task-complete`,
      parentId: `${sessionId}-child-start`,
      data: {
        toolCallId: `${sessionId}-task-call`, toolDescription: { name: "task" },
        success: true, result: "PRIVATE EARLY TOOL RESULT",
      },
    });
    assert.equal(harness.lifecycle.some((event) =>
      event.type === "run.finished" && event.kind === "child"), false,
    "an early tool completion won the race against the native child terminal");
    const terminalId = `${sessionId}-native-terminal`;
    harness.coordinator.observeEvent({
      type: terminal, id: terminalId, parentId: `${sessionId}-task-complete`,
      agentId: `${sessionId}-child`,
      data: {
        agentName: "explore", toolCallId: `${sessionId}-task-call`,
        ...(terminal === "subagent.failed" ? { error: "PRIVATE NATIVE ERROR" } : { totalTokens: 4 }),
      },
    });
    harness.coordinator.observeEvent({
      type: "session.idle", id: `${sessionId}-idle`, parentId: terminalId, data: { aborted: false },
    });
    const expected = terminal === "subagent.failed" ? "failed" : "completed";
    assert.equal(harness.lifecycle.find((event) =>
      event.type === "run.finished" && event.kind === "child")?.outcome, expected, terminal);
    assert.equal(harness.lifecycle.find((event) =>
      event.type === "run.finished" && event.kind === "root")?.outcome, expected, terminal);
  }

  for (const terminal of ["failed", "completed-after-failure-hook"] as const) {
    const harness = contractHarness();
    const sessionId = `contract-deferred-${terminal}`;
    await beginContract(harness.coordinator, sessionId, raw, descriptor);
    assert.equal((await harness.coordinator.hooks.onPreToolUse(
      contractInput(sessionId, descriptor), { sessionId },
    ))?.permissionDecision, "allow");
    harness.coordinator.observeEvent({
      type: "tool.execution_start", id: `${sessionId}-task-start`,
      parentId: `${sessionId}-contract-complete`,
      data: { toolName: "task", toolCallId: `${sessionId}-task-call` },
    });
    harness.coordinator.observeEvent({
      type: "subagent.started", id: `${sessionId}-child-start`,
      parentId: `${sessionId}-task-start`, agentId: `${sessionId}-child`,
      data: { agentName: "explore", toolCallId: `${sessionId}-task-call`, model: "child-model" },
    });
    await harness.coordinator.hooks.onPostToolUseFailure({
      sessionId, workingDirectory: project, toolName: "task", toolArgs: descriptor,
      error: "PRIVATE HOOK FAILURE",
    }, { sessionId });
    if (terminal === "completed-after-failure-hook") {
      await harness.coordinator.hooks.onPostToolUse({
        sessionId, workingDirectory: project, toolName: "task", toolArgs: descriptor,
        toolResult: "PRIVATE LATE SUCCESS",
      }, { sessionId });
    }
    assert.equal(harness.lifecycle.some((event) =>
      event.type === "run.finished" && event.kind === "child"), false,
    "a failure hook discarded native terminal correlation");
    const terminalId = `${sessionId}-child-${terminal}`;
    harness.coordinator.observeEvent({
      type: terminal === "failed" ? "subagent.failed" : "subagent.completed",
      id: terminalId, parentId: `${sessionId}-child-start`, agentId: `${sessionId}-child`,
      data: {
        agentName: "explore", toolCallId: `${sessionId}-task-call`, model: "child-model",
        ...(terminal === "failed" ? { error: "PRIVATE NATIVE FAILURE" } : { totalTokens: 4 }),
      },
    });
    harness.coordinator.observeEvent({
      type: "tool.execution_complete", id: `${sessionId}-task-complete`, parentId: terminalId,
      data: {
        toolCallId: `${sessionId}-task-call`, toolDescription: { name: "task" },
        success: terminal !== "failed",
      },
    });
    harness.coordinator.observeEvent({
      type: "session.idle", id: `${sessionId}-idle`, parentId: `${sessionId}-task-complete`,
      data: { aborted: false },
    });
    assert.equal(harness.lifecycle.find((event) =>
      event.type === "run.finished" && event.kind === "child")?.outcome, "failed", terminal);
    assert.equal(harness.lifecycle.find((event) =>
      event.type === "run.finished" && event.kind === "root")?.outcome, "failed", terminal);
    assert.equal(JSON.stringify(harness.lifecycle).includes("PRIVATE"), false);
  }
});

test("Copilot /contract keeps native child terminal outcomes single and failure-dominant", async () => {
  const raw = JSON.stringify({ name: "worker", description: "x", prompt: "PRIVATE", tools: ["read"], task: "review" });
  const descriptor = { agent_type: "explore", description: "Validated", prompt: "PRIVATE CHILD" };
  for (const order of ["failed-then-completed", "completed-then-failed"] as const) {
    const harness = contractHarness();
    const sessionId = `contract-terminal-${order}`;
    await beginContract(harness.coordinator, sessionId, raw, descriptor);
    assert.equal((await harness.coordinator.hooks.onPreToolUse(
      contractInput(sessionId, descriptor), { sessionId },
    ))?.permissionDecision, "allow");
    harness.coordinator.observeEvent({
      type: "tool.execution_start", id: `${sessionId}-task-start`,
      parentId: `${sessionId}-contract-complete`,
      data: { toolName: "task", toolCallId: `${sessionId}-task-call` },
    });
    harness.coordinator.observeEvent({
      type: "subagent.started", id: `${sessionId}-child-start`,
      parentId: `${sessionId}-task-start`, agentId: `${sessionId}-child`,
      data: { agentName: "explore", toolCallId: `${sessionId}-task-call` },
    });
    const terminalTypes = order === "failed-then-completed"
      ? ["subagent.failed", "subagent.completed"] as const
      : ["subagent.completed", "subagent.failed"] as const;
    let parentId = `${sessionId}-child-start`;
    for (const [index, type] of terminalTypes.entries()) {
      const id = `${sessionId}-terminal-${index}`;
      harness.coordinator.observeEvent({
        type, id, parentId, agentId: `${sessionId}-child`,
        data: {
          agentName: "explore", toolCallId: `${sessionId}-task-call`,
          ...(type === "subagent.failed" ? { error: "PRIVATE FAILURE" } : { totalTokens: 4 }),
        },
      });
      parentId = id;
    }
    harness.coordinator.observeEvent({
      type: "tool.execution_complete", id: `${sessionId}-task-complete`, parentId,
      data: { toolCallId: `${sessionId}-task-call`, toolDescription: { name: "task" }, success: true },
    });
    harness.coordinator.observeEvent({
      type: "session.idle", id: `${sessionId}-idle`, parentId: `${sessionId}-task-complete`,
      data: { aborted: false },
    });
    const childFinishes = harness.lifecycle.filter((event) =>
      event.type === "run.finished" && event.kind === "child");
    assert.equal(childFinishes.length, 1, order);
    assert.equal(childFinishes[0].outcome, "failed", order);
    assert.equal(harness.lifecycle.find((event) =>
      event.type === "run.finished" && event.kind === "root")?.outcome, "failed", order);
  }
});

test("Copilot /contract rejects false provenance, altered/second tasks, invalid preflight, and unavailable capacity", async () => {
  const unrelated = contractHarness();
  const unrelatedSession = "third-party-contract";
  await unrelated.coordinator.hooks.onUserPromptSubmitted({
    sessionId: unrelatedSession, workingDirectory: project, prompt: "ordinary work",
  }, { sessionId: unrelatedSession });
  const unrelatedAt = Date.now() + 1_000;
  for (const [index, data] of [
    { name: "contract", pluginName: "other-plugin", source: "plugin", trigger: "user-invoked" },
    { name: "contract", pluginName: "agent-foundry", source: "personal-copilot", trigger: "user-invoked" },
  ].entries()) unrelated.coordinator.observeEvent({
    type: "skill.invoked",
    id: `third-party-contract-skill-${index}`,
    timestamp: new Date(unrelatedAt + index).toISOString(),
    data,
  });
  assert.equal(unrelated.lifecycle.length, 0);
  assert.equal(await unrelated.coordinator.hooks.onPreToolUse(
    contractInput(unrelatedSession, { agent_type: "third-party", prompt: "untouched" }), { sessionId: unrelatedSession },
  ), undefined, "a third-party task was captured without an exact Harbor reservation");

  for (const trigger of ["agent-invoked", "context-load"] as const) {
    const blocked = contractHarness();
    const blockedSession = `${trigger}-contract`;
    await blocked.coordinator.hooks.onUserPromptSubmitted({
      sessionId: blockedSession, workingDirectory: project, prompt: "ordinary work",
    }, { sessionId: blockedSession });
    blocked.coordinator.observeEvent({
      type: "skill.invoked", id: `${trigger}-contract-skill`,
      data: { name: "contract", pluginName: "agent-foundry", source: "plugin", trigger },
    });
    if (trigger === "context-load") {
      blocked.coordinator.observeEvent({
        type: "session.idle", id: "context-load-first-turn-idle", data: { aborted: false },
      });
      await blocked.coordinator.hooks.onUserPromptSubmitted({
        sessionId: blockedSession, workingDirectory: project, prompt: "a later ordinary turn",
      }, { sessionId: blockedSession });
    }
    const blockedTask = await blocked.coordinator.hooks.onPreToolUse(
      contractInput(blockedSession, { agent_type: "explore", description: "x", prompt: "y" }),
      { sessionId: blockedSession },
    );
    assert.equal(blockedTask?.permissionDecision, "deny");
    assert.equal(blocked.admissions.length, 0);
    assert.equal(blocked.lifecycle.length, 0);
  }

  const invalid = contractHarness();
  const invalidSession = "invalid-contract";
  const raw = JSON.stringify({ name: "worker", description: "x", prompt: "SECRET", tools: ["read"], task: "review" });
  await invalid.coordinator.hooks.onUserPromptSubmitted({
    sessionId: invalidSession, workingDirectory: project, prompt: "/contract invalid",
  }, { sessionId: invalidSession });
  invalid.coordinator.observeEvent({
    type: "skill.invoked", id: "invalid-skill",
    data: { name: "contract", pluginName: "agent-foundry", source: "plugin", trigger: "user-invoked" },
  });
  const tool = contractInput(invalidSession, { definition: raw }, "harbor_contract");
  assert.equal((await invalid.coordinator.hooks.onPreToolUse(tool, { sessionId: invalidSession }))?.permissionDecision, "allow");
  const failedInvocation = contractToolInvocation(invalidSession, raw);
  invalid.coordinator.observeEvent({
    type: "tool.execution_start", id: "invalid-contract-start", parentId: "invalid-skill",
    data: {
      toolName: failedInvocation.toolName,
      toolCallId: failedInvocation.toolCallId,
      arguments: failedInvocation.arguments,
    },
  });
  await invalid.coordinator.contractToolFailed(failedInvocation);
  invalid.coordinator.observeEvent({
    type: "tool.execution_complete", id: "invalid-contract-complete", parentId: "invalid-contract-start",
    data: { toolCallId: failedInvocation.toolCallId, success: false, result: "PRIVATE ERROR" },
  });
  const deniedInvalid = await invalid.coordinator.hooks.onPreToolUse(
    contractInput(invalidSession, { agent_type: "explore", description: "x", prompt: "y" }), { sessionId: invalidSession },
  );
  assert.equal(deniedInvalid?.permissionDecision, "deny");
  assert.equal(invalid.admissions.filter(({ type }) => type === "child").length, 0);
  invalid.coordinator.observeEvent({ type: "session.idle", id: "invalid-idle", parentId: "invalid-contract-complete", data: { aborted: false } });
  assert.equal(invalid.lifecycle.find((event) => event.type === "run.finished" && event.kind === "root")?.outcome, "failed");
  assert.equal(JSON.stringify(invalid.lifecycle).includes("PRIVATE ERROR"), false);

  const capacity = contractHarness("32 roots are already active");
  const capacitySession = "contract-capacity";
  await capacity.coordinator.hooks.onUserPromptSubmitted({
    sessionId: capacitySession, workingDirectory: project, prompt: "/contract capacity",
  }, { sessionId: capacitySession });
  capacity.coordinator.observeEvent({
    type: "skill.invoked",
    data: { name: "contract", pluginName: "agent-foundry", source: "plugin", trigger: "user-invoked" },
  });
  const capacityDecision = await capacity.coordinator.hooks.onPreToolUse(
    contractInput(capacitySession, { definition: raw }, "harbor_contract"), { sessionId: capacitySession },
  );
  assert.equal(capacityDecision?.permissionDecision, "deny");
  assert.match(capacityDecision?.permissionDecisionReason ?? "", /32 roots/u);
  assert.equal(capacity.lifecycle.length, 0);

  const stale = contractHarness();
  const staleSession = "stale-contract-context";
  await stale.coordinator.hooks.onUserPromptSubmitted({
    sessionId: staleSession, workingDirectory: project, prompt: "ordinary completed turn",
  }, { sessionId: staleSession });
  stale.coordinator.observeEvent({ type: "session.idle", id: "stale-idle", data: { aborted: false } });
  stale.coordinator.observeEvent({
    type: "skill.invoked", id: "late-contract-skill",
    data: { name: "contract", pluginName: "agent-foundry", source: "plugin", trigger: "user-invoked" },
  });
  assert.equal(stale.lifecycle.length, 0, "a late skill event reused a completed prompt context");

  const descriptor = { agent_type: "explore", description: "Validated", prompt: "EXACT-PRIVATE-PROMPT" };
  const altered = contractHarness();
  const alteredSession = "altered-contract-task";
  await beginContract(altered.coordinator, alteredSession, raw, descriptor);
  const alteredDecision = await altered.coordinator.hooks.onPreToolUse(contractInput(alteredSession, {
    ...descriptor, prompt: `${descriptor.prompt}-altered`,
  }), { sessionId: alteredSession });
  assert.equal(alteredDecision?.permissionDecision, "deny");
  assert.match(alteredDecision?.permissionDecisionReason ?? "", /unchanged/u);
  assert.equal(altered.admissions.filter(({ type }) => type === "child").length, 0);
  altered.coordinator.observeEvent({
    type: "session.idle", id: "altered-idle", parentId: `${alteredSession}-contract-complete`, data: { aborted: false },
  });
  assert.equal(altered.lifecycle.find((event) => event.type === "run.finished" && event.kind === "root")?.outcome, "failed");

  const missingChild = contractHarness();
  const missingChildSession = "contract-without-task";
  await beginContract(missingChild.coordinator, missingChildSession, raw, descriptor);
  missingChild.coordinator.observeEvent({
    type: "session.idle", id: "missing-child-idle", parentId: `${missingChildSession}-contract-complete`, data: { aborted: false },
  });
  assert.equal(missingChild.admissions.filter(({ type }) => type === "child").length, 0);
  assert.equal(missingChild.lifecycle.find((event) => event.type === "run.finished" && event.kind === "root")?.outcome, "failed",
    "a successful contract tool with no mandatory child was reported completed");

  const secondTool = contractHarness();
  const secondToolSession = "second-contract-tool";
  await beginContract(secondTool.coordinator, secondToolSession, raw, descriptor);
  await assert.rejects(secondTool.coordinator.contractToolSucceeded(
    contractToolInvocation(secondToolSession, raw, { toolCallId: "different-contract-call" }),
    descriptor,
  ), /exactly one/u);
  const afterSecondTool = await secondTool.coordinator.hooks.onPreToolUse(
    contractInput(secondToolSession, descriptor), { sessionId: secondToolSession },
  );
  assert.equal(afterSecondTool?.permissionDecision, "deny");
  assert.match(afterSecondTool?.permissionDecisionReason ?? "", /exactly one/u);

  const cancelled = contractHarness();
  const cancelledSession = "cancelled-contract";
  await beginContract(cancelled.coordinator, cancelledSession, raw, descriptor);
  assert.equal((await cancelled.coordinator.hooks.onPreToolUse(
    contractInput(cancelledSession, descriptor), { sessionId: cancelledSession },
  ))?.permissionDecision, "allow");
  cancelled.coordinator.observeEvent({
    type: "tool.execution_start", id: "cancelled-task-start", parentId: `${cancelledSession}-contract-complete`,
    data: { toolName: "task", toolCallId: "cancelled-task-call" },
  });
  assert.equal((await cancelled.coordinator.hooks.onPreToolUse(
    contractInput(cancelledSession, descriptor), { sessionId: cancelledSession },
  ))?.permissionDecision, "deny");
  cancelled.coordinator.observeEvent({
    type: "session.idle", id: "cancelled-idle", parentId: "cancelled-task-start", data: { aborted: true },
  });
  const cancelledFinishes = cancelled.lifecycle.filter((event) => event.type === "run.finished");
  assert.deepEqual(cancelledFinishes.map(({ kind, outcome }) => [kind, outcome]), [
    ["child", "cancelled"],
    ["root", "cancelled"],
  ]);
});

test("Copilot /contract tombstones late task hooks until an authoritative new prompt epoch", async () => {
  const completed = await runValidContract("start-first");
  const completedInvocation = { sessionId: completed.sessionId };
  const lateCompleted = await completed.coordinator.hooks.onPreToolUse(
    contractInput(completed.sessionId, completed.descriptor),
    completedInvocation,
  );
  assert.equal(lateCompleted?.permissionDecision, "deny");
  assert.match(lateCompleted?.permissionDecisionReason ?? "", /late \/contract task replay.*new user prompt/u);

  await completed.coordinator.hooks.onUserPromptSubmitted({
    sessionId: completed.sessionId,
    workingDirectory: project,
    prompt: "ordinary work in a distinct user turn",
  }, completedInvocation);
  assert.equal(await completed.coordinator.hooks.onPreToolUse(
    contractInput(completed.sessionId, { agent_type: "explore", prompt: "ordinary third-party task" }),
    completedInvocation,
  ), undefined, "a new prompt epoch did not supersede the completed-contract tombstone");

  const abandoned = contractHarness();
  const sessionId = "abandoned-contract-tombstone";
  const raw = JSON.stringify({ name: "reviewer", task: "Review safely" });
  const descriptor = { agent_type: "explore", description: "Disposable reviewer", prompt: "Review safely" };
  await beginContract(abandoned.coordinator, sessionId, raw, descriptor);
  abandoned.coordinator.observeEvent({
    type: "session.idle",
    id: "abandoned-contract-idle",
    parentId: `${sessionId}-contract-complete`,
    data: { aborted: false },
  });
  const lateAbandoned = await abandoned.coordinator.hooks.onPreToolUse(
    contractInput(sessionId, descriptor),
    { sessionId },
  );
  assert.equal(lateAbandoned?.permissionDecision, "deny");
  assert.match(lateAbandoned?.permissionDecisionReason ?? "", /late \/contract task replay/u);

  await abandoned.coordinator.hooks.onUserPromptSubmitted({
    sessionId,
    workingDirectory: project,
    prompt: "new ordinary turn after the abandoned contract",
  }, { sessionId });
  assert.equal(await abandoned.coordinator.hooks.onPreToolUse(
    contractInput(sessionId, { agent_type: "explore", prompt: "ordinary third-party task" }),
    { sessionId },
  ), undefined, "a new prompt epoch did not supersede the abandoned-contract tombstone");
});
