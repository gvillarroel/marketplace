import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scenario = process.argv[2];
const teamReadHangs = scenario === "team-total-budget" || scenario === "team-degraded-budget";
const harnessStartedAt = Date.now();
const root = dirname(fileURLToPath(new URL("../../package.json", import.meta.url)));
const keepAlive = setInterval(() => {}, 1_000);
const sandbox = await mkdtemp(join(tmpdir(), "harbor-copilot-extension-"));
const project = join(sandbox, "project");
process.env.COPILOT_HOME = join(sandbox, "copilot-home");
await mkdir(project, { recursive: true });
if (scenario === "startup-profile-diagnostics") {
  process.chdir(project);
  const activeRoot = join(project, ".github", "agents");
  await mkdir(activeRoot, { recursive: true });
  await Promise.all(Array.from({ length: 513 }, (_, index) =>
    writeFile(join(activeRoot, `foreign-${String(index).padStart(3, "0")}.txt`), "unmanaged\n", "utf8")));
}
const never = () => new Promise(() => {});
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const listeners = new Set();
const logs = [];
const calls = {
  abort: 0, activity: 0, context: 0, currentAgent: 0, deselect: 0, list: 0, log: 0,
  metadata: 0, processing: 0, reload: 0, select: 0, send: 0,
};
const fixedAgentDirectory = join(root, "plugins", "agent-foundry", "agents");
const agents = [
  { id: "agent-foundry:team-lead", name: "team-lead", userInvocable: true, path: join(fixedAgentDirectory, "team-lead.agent.md") },
  { id: "agent-foundry:crafter", name: "crafter", userInvocable: true, model: "profile-model", path: join(fixedAgentDirectory, "crafter.agent.md") },
  { id: "agent-foundry:talent-scout", name: "talent-scout", userInvocable: true, path: join(fixedAgentDirectory, "talent-scout.agent.md") },
];
if (scenario === "startup-skill-replace") {
  process.chdir(project);
  const [{ Roster }, { harnessSpec }] = await Promise.all([
    import(pathToFileURL(join(root, "dist", "core", "lifecycle.js")).href),
    import(pathToFileURL(join(root, "dist", "core", "profiles.js")).href),
  ]);
  const roster = new Roster(harnessSpec("copilot", process.env.COPILOT_HOME, project));
  await roster.join({
    name: "startup-skilled",
    description: "Startup skill-enabled player",
    prompt: "Work narrowly.",
    tools: ["read"],
    skills: [{
      kind: "github",
      name: "zx-example-author",
      repo: "gvillarroel/zx-harness",
      path: "skills/zx-example-author/SKILL.md",
      track: "refs/heads/main",
    }],
  });
  agents.push({
    id: "startup-skilled",
    name: "startup-skilled",
    userInvocable: true,
    path: join(project, ".github", "agents", "startup-skilled.agent.md"),
  });
}
if (scenario === "scout-truncated-roster") {
  const { harnessSpec } = await import(pathToFileURL(join(root, "dist", "core", "profiles.js")).href);
  const spec = harnessSpec("copilot", process.env.COPILOT_HOME, project);
  const definitions = [
    ...Array.from({ length: 34 }, (_, index) => ({
      name: `aa-roster-filler-${String(index).padStart(2, "0")}`,
      description: "Existing teammate without the requested specialist capacity",
      prompt: "Handle only unrelated work.",
      tools: ["read"],
    })),
    {
      name: "zz-sufficient-reviewer",
      description: "Existing teammate with sufficient security-review capacity",
      prompt: "Perform the requested security review.",
      tools: ["read"],
    },
  ];
  const registrationRoot = join(spec.home, spec.registrationDir);
  const activeRoot = join(spec.project, spec.activeDir);
  await Promise.all([mkdir(registrationRoot, { recursive: true }), mkdir(activeRoot, { recursive: true })]);
  await Promise.all(definitions.flatMap((definition) => {
    const content = spec.renderPlayer(definition, "personal");
    return [
      writeFile(join(registrationRoot, `${definition.name}${spec.extension}`), content, "utf8"),
      writeFile(join(activeRoot, `${definition.name}${spec.extension}`), content, "utf8"),
    ];
  }));
  for (const definition of definitions) {
    agents.push({
      id: definition.name,
      name: definition.name,
      userInvocable: true,
      path: join(project, ".github", "agents", `${definition.name}.agent.md`),
    });
  }
}
let selected = scenario === "native-reservation" || scenario === "inferred-child" ||
  scenario === "metadata-only-usage-parity" || scenario === "lifecycle-identity-hazard" ||
  scenario === "guard-terminal-clear" || scenario === "restore-identity-mismatch" ||
  scenario === "team-partial-stop" ? agents[0] :
  scenario === "manual-profile-model" || scenario === "team-stop-budget" ||
  scenario === "contract-selected-team-observability" ? agents[1] : undefined;
let options;
let releaseSelection;
let releaseRestore;
let releaseManagerSend;
let releaseNativeList;
let releaseJoinAuthentication;
let holdNativeRosterList = false;
let holdJoinAuthentication = false;
let firstSelection = true;
let hostActive = scenario === "active-work" || scenario === "team-host-untracked-context";
let restoredWhileActive = 0;
let guardDecision;
let busyAdmission;
let gapStop;
let postCommitAbortEmitted = false;
let logHangs = scenario === "log-hang" || scenario === "log-hang-default";
let nativeRosterToolCalls = 0;
const nativeToolResults = {};

function emit(event) {
  for (const listener of [...listeners]) listener(event);
}

function errorShape(error) {
  if (!(error instanceof Error)) return { name: typeof error, message: String(error) };
  return {
    name: error.name,
    message: error.message,
    ...(error.cause === undefined ? {} : { cause: errorShape(error.cause) }),
    ...(Array.isArray(error.errors) ? { errors: error.errors.map(errorShape) } : {}),
  };
}

const session = {
  sessionId: "fake-copilot-session",
  rpc: {
    metadata: {
      snapshot: async () => {
        calls.metadata += 1;
        if ((teamReadHangs && scenario !== "team-default-budget") || scenario === "team-unverified-stop" ||
            scenario === "team-scope-identity-hazard") return never();
        if (scenario === "team-scope-recovery" && calls.metadata === 1) return never();
        return {
          workingDirectory: project,
          ...(scenario === "team-host-untracked-context"
            ? { sessionLimits: { maxAiCredits: 7.5 } }
            : { sessionLimits: null }),
        };
      },
      activity: async () => {
        calls.activity += 1;
        return { abortable: true, hasActiveWork: hostActive };
      },
      isProcessing: async () => {
        calls.processing += 1;
        return { processing: hostActive };
      },
      contextInfo: async () => {
        calls.context += 1;
        if (teamReadHangs) return never();
        if (scenario !== "team-host-untracked-context") return { contextInfo: null };
        return {
          contextInfo: {
            modelName: "host-model",
            systemTokens: 120,
            conversationTokens: 300,
            toolDefinitionsTokens: 80,
            mcpToolsTokens: 0,
            totalTokens: 500,
            promptTokenLimit: 32_000,
            compactionThreshold: 25_600,
            limit: 36_096,
            bufferTokens: 1_600,
          },
        };
      },
    },
    model: {
      getCurrent: async () => {
        if (teamReadHangs) return never();
        if (scenario === "no-model-control-ux") return { modelId: "unknown/default", reasoningEffort: null };
        return { modelId: "host-model", reasoningEffort: null };
      },
    },
    agent: {
      getCurrent: async () => {
        calls.currentAgent += 1;
        if (teamReadHangs) return never();
        if (holdJoinAuthentication && selected?.id === "agent-foundry:talent-scout") {
          return new Promise((resolve) => {
            releaseJoinAuthentication = () => {
              holdJoinAuthentication = false;
              resolve({ agent: selected });
            };
          });
        }
        if (scenario === "native-path-windows" && selected?.id === "agent-foundry:talent-scout") {
          return { agent: { ...selected, path: selected.path.toLowerCase().replace(/\\/gu, "/") + "/" } };
        }
        if (scenario === "native-path-posix" && selected?.id === "agent-foundry:talent-scout") {
          return { agent: { ...selected, path: join(dirname(selected.path), "roles", "..", "talent-scout.agent.md").replace(/\\/gu, "/") } };
        }
        if (scenario === "native-path-mismatch" && selected?.id === "agent-foundry:talent-scout") {
          return { agent: { ...selected, path: "C:\\Workspace\\Other\\talent-scout.agent.md" } };
        }
        if (scenario === "select-current-mismatch" && selected?.id === "agent-foundry:crafter") {
          return { agent: agents[0] };
        }
        return { agent: selected };
      },
      reload: async () => {
        calls.reload += 1;
        if (teamReadHangs) return never();
        if (scenario === "native-postcommit-join-abort" &&
            existsSync(join(project, ".github", "agents", "postcommit-player.agent.md"))) {
          if (!postCommitAbortEmitted) {
            postCommitAbortEmitted = true;
            queueMicrotask(() => emit({
              type: "abort",
              id: "native-postcommit-join-abort-event",
              data: { sessionId: session.sessionId },
            }));
          }
          return never();
        }
        if (scenario === "startup-refresh-hang") return never();
        if (scenario === "first-team-delayed-discovery" && calls.reload === 1) return never();
        if (scenario === "refresh-hang" && calls.reload > 1) return never();
        return { agents };
      },
      list: async () => {
        calls.list += 1;
        if (teamReadHangs) return never();
        if (scenario === "native-private-tool-error" && selected?.id === "agent-foundry:talent-scout") {
          throw new Error("native list failed at C:/Users/alice/private.txt with Bearer abcdefghijklmnop");
        }
        if (holdNativeRosterList) {
          return new Promise((resolve) => {
            releaseNativeList = () => { holdNativeRosterList = false; resolve({ agents }); };
          });
        }
        if (scenario === "team-read-recovery" && calls.list === 1) throw new Error("temporary registry read failure");
        return { agents };
      },
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
        if ((scenario === "select-result-mismatch" || scenario === "selection-concurrency") && calls.select === 1) {
          selected = agents.find((agent) => agent.id === name);
          return { agent: agents[0] };
        }
        if (scenario === "restore-identity-mismatch" && calls.select >= 2) {
          selected = agents[1];
          return { agent: selected };
        }
        selected = agents.find((agent) => agent.id === name);
        return { agent: selected };
      },
      deselect: async () => {
        calls.deselect += 1;
        if (hostActive) restoredWhileActive += 1;
        if (scenario === "restore-failure") throw new Error("restore failed");
        if (scenario === "deselect-not-empty") {
          selected = agents[1];
          return;
        }
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
    calls.log += 1;
    logs.push({ message, metadata });
    if (scenario === "stop-send-gap" && message.includes("no model call yet") && !gapStop) {
      gapStop = invoke("team", "stop all");
    }
    if (logHangs) return never();
    if (scenario === "team-total-budget") return never();
    if (scenario === "team-default-budget") return never();
    if (scenario === "display-reject") throw new Error("display rejected");
    if (scenario === "private-error") {
      throw new Error("host failed at C:/Users/alice/secret.txt with Bearer abcdefghijklmnop");
    }
    if (scenario === "log-backlog" && logs.length === 1) return never();
  },
  async send() {
    calls.send += 1;
    if (scenario === "native-private-tool-error") {
      nativeToolResults.roster = await invokeNativeTool(
        "harbor_team_roster",
        { query: "security" },
        "native-private-roster",
      );
      queueMicrotask(() => emit({
        type: "session.idle",
        id: "native-private-tool-idle",
        timestamp: new Date().toISOString(),
        data: { aborted: false },
      }));
      return;
    }
    if (scenario === "scout-truncated-roster") {
      const definition = JSON.stringify({
        name: "must-not-join-after-truncation",
        description: "Duplicate recruitment that an incomplete roster cannot authorize",
        prompt: "Work narrowly.",
        tools: ["read"],
      });
      nativeToolResults.roster = await invokeNativeTool(
        "harbor_team_roster",
        { query: "" },
        "truncated-roster",
      );
      nativeToolResults.filter = await invokeNativeTool(
        "harbor_filter_skills",
        { query: "security review" },
        "truncated-filter",
      );
      nativeToolResults.join = await invokeNativeTool(
        "harbor_join_player",
        { definition },
        "truncated-join",
      );
      queueMicrotask(() => emit({
        type: "session.idle",
        id: "truncated-roster-idle",
        timestamp: new Date().toISOString(),
        data: { aborted: false },
      }));
      return;
    }
    if (["native-path-windows", "native-path-posix", "native-path-mismatch", "scout-ready-reuse"].includes(scenario)) {
      let busyToolInput;
      const managerInvocation = { sessionId: session.sessionId };
      if (scenario === "scout-ready-reuse") {
        const scoutSelection = selected;
        selected = agents[0];
        await options.hooks.onUserPromptSubmitted({
          sessionId: session.sessionId,
          workingDirectory: project,
          prompt: "keep the existing crafter occupied while scouting other capacity",
        }, managerInvocation);
        busyToolInput = {
          sessionId: session.sessionId,
          workingDirectory: project,
          toolName: "task",
          toolArgs: { agent_type: "agent-foundry:crafter", prompt: "continue existing specialist work" },
        };
        busyAdmission = await options.hooks.onPreToolUse(busyToolInput, managerInvocation);
        selected = scoutSelection;
      }
      nativeToolResults.roster = await invokeNativeTool(
        "harbor_team_roster",
        { query: scenario === "scout-ready-reuse" ? "" : "crafter" },
        `roster-${scenario}`,
      );
      if (busyToolInput) {
        await options.hooks.onPostToolUseFailure({ ...busyToolInput, error: "bounded busy-state cleanup" }, managerInvocation);
      }
      queueMicrotask(() => emit({
        type: "session.idle",
        id: `roster-idle-${scenario}`,
        timestamp: new Date().toISOString(),
        data: { aborted: false },
      }));
      return;
    }
    if (scenario === "native-postcommit-join-abort") {
      nativeToolResults.roster = await invokeNativeTool(
        "harbor_team_roster",
        { query: "postcommit" },
        "postcommit-roster",
      );
      nativeToolResults.filter = await invokeNativeTool(
        "harbor_filter_skills",
        { query: "a" },
        "postcommit-filter",
      );
      nativeToolResults.join = await invokeNativeTool(
        "harbor_join_player",
        { definition: JSON.stringify({
          name: "postcommit-player",
          description: "Player committed before cancellation",
          prompt: "Work narrowly.",
          tools: ["read"],
        }) },
        "postcommit-join",
      );
      queueMicrotask(() => emit({
        type: "session.idle",
        id: "native-postcommit-idle",
        timestamp: new Date().toISOString(),
        data: { aborted: false },
      }));
      return;
    }
    if (scenario === "native-precommit-join-stop") {
      nativeToolResults.roster = await invokeNativeTool(
        "harbor_team_roster",
        { query: "precommit" },
        "precommit-roster",
      );
      nativeToolResults.filter = await invokeNativeTool(
        "harbor_filter_skills",
        { query: "a" },
        "precommit-filter",
      );
      holdJoinAuthentication = true;
      nativeToolResults.join = await invokeNativeTool(
        "harbor_join_player",
        { definition: JSON.stringify({
          name: "precommit-player",
          description: "Must never commit after cancellation",
          prompt: "Work narrowly.",
          tools: ["read"],
        }) },
        "precommit-join",
      );
      return;
    }
    if (scenario === "native-controller-scope-match" || scenario === "native-controller-scope-mismatch" ||
        scenario === "native-controller-team-stop") {
      holdNativeRosterList = true;
      const roster = invokeNativeTool(
        "harbor_team_roster",
        { query: "crafter" },
        `held-roster-${scenario}`,
      );
      await waitFor(() => typeof releaseNativeList === "function", "held native roster read");
      if (scenario !== "native-controller-team-stop") {
        emit({
          type: "abort",
          id: `native-controller-abort-${scenario}`,
          data: {
            sessionId: scenario === "native-controller-scope-match"
              ? session.sessionId
              : "different-copilot-session",
          },
        });
        releaseNativeList?.();
      }
      nativeToolResults.roster = await roster;
      if (scenario === "native-controller-scope-match") {
        nativeToolResults.retryAfterAbortedRoster = await invokeNativeTool(
          "harbor_team_roster",
          { query: "retry" },
          "held-roster-retry-after-abort",
        );
      }
      queueMicrotask(() => emit({
        type: "session.idle",
        id: `held-roster-idle-${scenario}`,
        timestamp: new Date().toISOString(),
        data: { aborted: scenario !== "native-controller-scope-mismatch" },
      }));
      return;
    }
    if (scenario === "native-custom-tools") {
      if (selected?.id === "agent-foundry:crafter") {
        nativeToolResults.boundPlayerRejectsModelId = await invokeNativeTool(
          "harbor_skill_crafter",
          { player: "crafter" },
          "bound-skill-forged-player",
        );
      } else if (selected?.id === "agent-foundry:talent-scout") {
        const definition = JSON.stringify({
          name: "native-scouted",
          description: "Native scouted player",
          prompt: "Work narrowly.",
          tools: ["read"],
        });
        nativeToolResults.scoutWrongSession = await invokeNativeTool(
          "harbor_join_player",
          { definition },
          "scout-wrong-session",
          { sessionId: "forged-session" },
        );
        nativeToolResults.scoutJoinBeforeRoster = await invokeNativeTool(
          "harbor_join_player",
          { definition },
          "scout-join-before-roster",
        );
        nativeToolResults.scoutFilterBeforeRoster = await invokeNativeTool(
          "harbor_filter_skills",
          { query: "a" },
          "scout-filter-before-roster",
        );
        nativeToolResults.scoutRoster = await invokeNativeTool(
          "harbor_team_roster",
          { query: "crafter" },
          "scout-roster",
        );
        nativeToolResults.scoutRosterAgain = await invokeNativeTool(
          "harbor_team_roster",
          { query: "crafter" },
          "scout-roster-again",
        );
        nativeToolResults.scoutJoinBeforeFilter = await invokeNativeTool(
          "harbor_join_player",
          { definition },
          "scout-join-before-filter",
        );
        const firstFilter = invokeNativeTool(
          "harbor_filter_skills",
          { query: "a" },
          "scout-filter-first",
        );
        const concurrentFilter = invokeNativeTool(
          "harbor_filter_skills",
          { query: "a" },
          "scout-filter-concurrent",
        );
        [nativeToolResults.scoutFilter, nativeToolResults.scoutConcurrentFilter] =
          await Promise.all([firstFilter, concurrentFilter]);
        nativeToolResults.scoutJoin = await invokeNativeTool(
          "harbor_join_player",
          { definition },
          "scout-join",
        );
        nativeToolResults.scoutJoinAgain = await invokeNativeTool(
          "harbor_join_player",
          { definition: JSON.stringify({
            name: "native-scouted-again",
            description: "Second player",
            prompt: "Work narrowly.",
            tools: ["read"],
          }) },
          "scout-join-again",
        );
      }
      queueMicrotask(() => emit({
        type: "session.idle",
        id: `native-custom-tools-idle-${selected?.name ?? "unknown"}`,
        timestamp: new Date().toISOString(),
        data: { aborted: false },
      }));
      return;
    }
    if (scenario === "metadata-only-usage-parity") {
      const now = Date.now() + 1_000;
      emit({
        type: "assistant.usage",
        id: "metadata-only-direct-usage",
        timestamp: new Date(now).toISOString(),
        data: { serviceRequestId: "metadata-only-direct-request", model: "metadata-only-direct-model" },
      });
      emit({
        type: "session.idle", id: "metadata-only-direct-idle", parentId: "metadata-only-direct-usage",
        timestamp: new Date(now + 1).toISOString(), data: { aborted: false },
      });
      return;
    }
    if (scenario === "direct-provider-confirmation") {
      const invocation = { sessionId: session.sessionId };
      await options.hooks.onUserPromptSubmitted({
        sessionId: session.sessionId,
        workingDirectory: project,
        prompt: "confirm the configured provider before any assistant turn",
      }, invocation);
      const now = Date.now() + 1_000;
      emit({
        type: "session.model_change",
        id: "direct-provider-confirmation-model",
        parentId: "prior-session-chain",
        timestamp: new Date(now).toISOString(),
        data: { newModel: "profile-model", reasoningEffort: null },
      });
      emit({
        type: "session.idle",
        id: "direct-provider-confirmation-idle",
        parentId: "direct-provider-confirmation-model",
        timestamp: new Date(now + 1).toISOString(),
        data: { aborted: false },
      });
      return;
    }
    if (scenario === "direct-replay-delta-first") {
      const now = Date.now() + 1_000;
      emit({
        type: "assistant.message_delta",
        id: "replayed-delta-before-current-chain",
        parentId: "direct-current-turn",
        timestamp: new Date(now).toISOString(),
        data: { model: "replayed-delta-model", delta: "PRIVATE REPLAYED DELTA" },
      });
      emit({
        type: "assistant.turn_start",
        id: "direct-current-turn",
        parentId: "direct-current-prompt",
        timestamp: new Date(now + 1).toISOString(),
        data: { turnId: "direct-current-turn", model: "direct-current-model" },
      });
      emit({
        type: "assistant.usage",
        id: "direct-current-usage",
        parentId: "direct-current-turn",
        timestamp: new Date(now + 2).toISOString(),
        data: {
          serviceRequestId: "direct-current-request",
          model: "direct-current-model",
          inputTokens: 17,
          outputTokens: 3,
          reasoningTokens: 2,
          cacheReadTokens: 1,
          cacheWriteTokens: 0,
        },
      });
      emit({
        type: "session.idle",
        id: "direct-current-idle",
        parentId: "direct-current-usage",
        timestamp: new Date(now + 3).toISOString(),
        data: { aborted: false },
      });
      return;
    }
    if (scenario === "direct-root-usage-ownership") {
      const invocation = { sessionId: session.sessionId };
      const rootActivityAt = Date.now() + 1_000;
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
        timestamp: new Date(rootActivityAt).toISOString(),
        data: { toolName: "task", toolCallId: "task-call-root-1" },
      });
      const decision = await options.hooks.onPreToolUse(toolInput, invocation);
      if (decision?.permissionDecision !== "allow") throw new Error(`delegation denied: ${decision?.permissionDecisionReason}`);
      emit({
        type: "subagent.started",
        id: "child-start-1",
        parentId: "tool-start-root-1",
        timestamp: new Date(rootActivityAt + 1).toISOString(),
        agentId: "native-child-1",
        data: { agentName: "agent-foundry:crafter", toolCallId: "task-call-root-1", model: "child-model" },
      });
      emit({
        type: "assistant.usage",
        id: "usage-event-child-1",
        parentId: "child-start-1",
        timestamp: new Date(rootActivityAt + 2).toISOString(),
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
          cost: 0.25,
          copilotUsage: { totalNanoAiu: 25 },
        },
      });
      emit({
        type: "subagent.completed",
        id: "child-complete-1",
        parentId: "usage-event-child-1",
        timestamp: new Date(rootActivityAt + 3).toISOString(),
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
        timestamp: new Date(rootActivityAt + 4).toISOString(),
        data: { turnId: "turn-root-1", model: "host-model-observed" },
      });
      emit({
        type: "assistant.usage",
        id: "usage-event-root-1",
        parentId: "turn-root-1",
        timestamp: new Date(rootActivityAt + 5).toISOString(),
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
          cost: 1,
          copilotUsage: { totalNanoAiu: 100 },
        },
      });
      emit({
        type: "session.idle", id: "idle-root-1", parentId: "usage-event-root-1",
        timestamp: new Date(rootActivityAt + 6).toISOString(), data: { aborted: false },
      });
      return;
    }
    if (scenario === "accepting-terminal-default") {
      const now = Date.now() + 1_000;
      hostActive = true;
      queueMicrotask(() => emit({
        type: "session.idle", id: "accepting-terminal-stale-one", parentId: null,
        timestamp: new Date(now).toISOString(), data: { aborted: false },
      }));
      setTimeout(() => emit({
        type: "session.idle", id: "accepting-terminal-stale-two", parentId: null,
        timestamp: new Date(now + 1).toISOString(), data: { aborted: false },
      }), 35);
      setTimeout(() => {
        hostActive = false;
        emit({
          type: "session.idle", id: "accepting-terminal-current", parentId: null,
          timestamp: new Date(now + 2).toISOString(), data: { aborted: false },
        });
      }, 90);
      return never();
    }
    if (scenario === "acceptance-terminal-flood") {
      const now = Date.now() + 1_000;
      hostActive = true;
      const privateSuffix = `PRIVATE-OVERSIZED-EVENT-ID-${"x".repeat(8_192)}`;
      for (let index = 0; index < 128; index += 1) {
        emit({
          type: "session.idle",
          id: `acceptance-flood-${index}-${privateSuffix}`,
          timestamp: new Date(now + index).toISOString(),
          data: { aborted: false },
        });
      }
      emit({
        type: "session.shutdown",
        id: `acceptance-flood-shutdown-${privateSuffix}`,
        timestamp: new Date(now + 200).toISOString(),
        data: { shutdownType: "normal" },
      });
      emit({
        type: "session.error",
        id: `acceptance-flood-error-${privateSuffix}`,
        timestamp: new Date(now + 201).toISOString(),
        data: { message: "PRIVATE PROVIDER FLOOD ERROR" },
      });
      hostActive = false;
      return never();
    }
    if (scenario === "direct-oversized-event-ids") {
      const now = Date.now() + 1_000;
      const privateId = `PRIVATE-DIRECT-EVENT-ID-${"y".repeat(256_000)}`;
      const turnId = `${privateId}-turn`;
      const usageId = `${privateId}-usage`;
      emit({
        type: "assistant.turn_start",
        id: turnId,
        timestamp: new Date(now).toISOString(),
        data: { turnId: "bounded-public-turn", model: "oversized-id-model" },
      });
      emit({
        type: "assistant.usage",
        id: usageId,
        parentId: turnId,
        timestamp: new Date(now + 1).toISOString(),
        data: { serviceRequestId: "bounded-provider-call", model: "oversized-id-model", inputTokens: 5, outputTokens: 1 },
      });
      emit({
        type: "session.idle",
        id: `${privateId}-idle`,
        parentId: usageId,
        timestamp: new Date(now + 2).toISOString(),
        data: { aborted: false },
      });
      return;
    }
    if (scenario === "acceptance-stale-idle") {
      const now = Date.now();
      hostActive = true;
      queueMicrotask(() => emit({
        type: "session.idle", id: "acceptance-stale-idle-old", parentId: "previous-run-event",
        timestamp: new Date(now - 60_000).toISOString(), data: { aborted: false },
      }));
      setTimeout(() => {
        hostActive = false;
        emit({
          type: "session.idle", id: "acceptance-stale-idle-current", parentId: null,
          timestamp: new Date(now + 100).toISOString(), data: { aborted: false },
        });
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
    if (scenario === "team-lead-active-access" || scenario === "retire-active-personal") {
      emit({
        type: "assistant.turn_start", id: `active-direct-turn-${scenario}`, parentId: null,
        timestamp: new Date().toISOString(), data: { turnId: `active-direct-turn-${scenario}`, model: "host-model" },
      });
      return new Promise((resolve) => { releaseManagerSend = resolve; });
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
      queueMicrotask(() => emit({
        type: "session.idle", id: "guard-sync-idle", timestamp: new Date().toISOString(),
        data: { aborted: false },
      }));
      return;
    }
    if (scenario === "send-timeout-late") {
      setTimeout(() => emit({
        type: "session.idle", id: "send-timeout-late-idle", timestamp: new Date().toISOString(),
        data: { aborted: false },
      }), 650);
      return never();
    }
    if (scenario === "send-timeout-buffered-terminal") {
      setTimeout(() => emit({
        type: "session.idle", id: "send-timeout-buffered-idle", timestamp: new Date().toISOString(),
        data: { aborted: false },
      }), 650);
      return never();
    }
    if (scenario === "abort-failure") {
      setTimeout(() => emit({
        type: "session.idle", id: "abort-failure-idle", timestamp: new Date().toISOString(),
        data: { aborted: true },
      }), 1_100);
      return;
    }
    if (scenario === "session-error" || scenario === "restore-failure") {
      queueMicrotask(() => emit({
        type: "session.error", id: `provider-error-${scenario}`, timestamp: new Date().toISOString(),
        data: { message: "PRIVATE PROVIDER BODY" },
      }));
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
    queueMicrotask(() => emit({
      type: "session.idle", id: `default-idle-${scenario}`, timestamp: new Date().toISOString(),
      data: { aborted: false },
    }));
  },
  async abort() {
    calls.abort += 1;
    if (scenario === "team-stop-budget") return never();
    if (scenario === "team-partial-stop" && calls.abort === 2) throw new Error("second abort failed");
    if (scenario === "abort-failure") throw new Error("abort failed");
    if (scenario === "native-controller-team-stop") releaseNativeList?.();
    if (scenario === "native-precommit-join-stop") releaseJoinAuthentication?.();
    if (scenario === "stop-before-send" || scenario === "stop-send-gap" || scenario === "native-reservation" ||
        scenario === "retire-active-personal" ||
        scenario === "native-controller-team-stop" || scenario === "native-precommit-join-stop") {
      queueMicrotask(() => emit({
        type: "session.idle", id: `abort-idle-${scenario}`, timestamp: new Date().toISOString(),
        data: { aborted: true },
      }));
      if (scenario === "retire-active-personal") releaseManagerSend?.();
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

function nativeTool(name) {
  const found = options.tools?.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`missing native tool: ${name}`);
  return found;
}

async function invokeNativeTool(name, args, toolCallId, overrides = {}) {
  if (name === "harbor_team_roster") nativeRosterToolCalls += 1;
  try {
    const value = await nativeTool(name).handler(args, {
      sessionId: session.sessionId,
      toolCallId,
      toolName: name,
      arguments: args,
      ...overrides,
    });
    return { ok: true, value };
  } catch (error) {
    return { ok: false, error: errorShape(error) };
  }
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
if (["native-tool-abort", "native-tool-session-error", "native-tool-session-idle", "native-tool-session-shutdown"].includes(scenario)) {
  const invocation = { sessionId: session.sessionId };
  const raw = JSON.stringify({
    name: "aborted-reviewer",
    description: "Abortable native preflight",
    prompt: "Review only.",
    tools: ["read"],
    task: "Review bounded evidence",
  });
  await options.hooks.onUserPromptSubmitted({
    sessionId: session.sessionId,
    workingDirectory: project,
    prompt: `/contract ${raw}`,
  }, invocation);
  emit({
    type: "skill.invoked",
    id: "native-abort-contract-skill",
    timestamp: new Date().toISOString(),
    data: { name: "contract", pluginName: "agent-foundry", source: "plugin", trigger: "user-invoked" },
  });
  const args = { definition: raw };
  const preTool = await options.hooks.onPreToolUse({
    sessionId: session.sessionId,
    workingDirectory: project,
    toolName: "harbor_contract",
    toolArgs: args,
  }, invocation);
  const first = invokeNativeTool("harbor_contract", args, "reused-native-call");
  const duplicate = invokeNativeTool("harbor_contract", args, "reused-native-call");
  const terminalType = {
    "native-tool-abort": "abort",
    "native-tool-session-error": "session.error",
    "native-tool-session-idle": "session.idle",
    "native-tool-session-shutdown": "session.shutdown",
  }[scenario];
  emit({
    type: terminalType,
    id: `${terminalType}-active-native-tool`,
    timestamp: new Date().toISOString(),
    data: {
      sessionId: session.sessionId,
      ...(terminalType === "session.idle" ? { aborted: false } : {}),
      ...(terminalType === "session.shutdown" ? { shutdownType: "normal" } : {}),
    },
  });
  const [aborted, duplicateResult] = await Promise.all([first, duplicate]);
  const retryAfterCleanup = await invokeNativeTool("harbor_contract", args, "reused-native-call");
  result = { preTool, aborted, duplicate: duplicateResult, retryAfterCleanup };
} else if (scenario === "native-argument-mismatch") {
  const invocation = { sessionId: session.sessionId };
  const rawA = JSON.stringify({
    name: "argument-a",
    description: "First exact contract",
    prompt: "Review A.",
    tools: ["read"],
    task: "Review A",
  });
  const rawB = JSON.stringify({
    name: "argument-b",
    description: "Forged native argument",
    prompt: "Review B.",
    tools: ["read"],
    task: "Review B",
  });
  await options.hooks.onUserPromptSubmitted({
    sessionId: session.sessionId,
    workingDirectory: project,
    prompt: `/contract ${rawA}`,
  }, invocation);
  emit({
    type: "skill.invoked",
    id: "native-argument-mismatch-skill",
    timestamp: new Date().toISOString(),
    data: { name: "contract", pluginName: "agent-foundry", source: "plugin", trigger: "user-invoked" },
  });
  const preTool = await options.hooks.onPreToolUse({
    sessionId: session.sessionId,
    workingDirectory: project,
    toolName: "harbor_contract",
    toolArgs: { definition: rawA },
  }, invocation);
  const mismatch = await invokeNativeTool(
    "harbor_contract",
    { definition: rawA },
    "native-argument-mismatch-call",
    { arguments: { definition: rawB } },
  );
  result = { preTool, mismatch };
} else if (scenario === "native-oversized-tool-call-id") {
  const raw = JSON.stringify({
    name: "bounded-call-id",
    description: "Reject oversized native identity",
    prompt: "Review safely.",
    tools: ["read"],
    task: "Review bounded evidence",
  });
  const privateCallId = `PRIVATE-NATIVE-CALL-ID-${"z".repeat(256_000)}`;
  const oversized = await invokeNativeTool("harbor_contract", { definition: raw }, privateCallId);
  result = { oversized };
} else if (scenario === "startup-skill-replace") {
  const replacement = JSON.stringify({
    name: "startup-skilled",
    description: "Replaced startup skill-enabled player",
    prompt: "Work narrowly after replacement.",
    tools: ["read"],
    model: "openai/gpt-5-mini",
    skills: [{
      kind: "github",
      name: "zx-example-author",
      repo: "gvillarroel/zx-harness",
      path: "skills/zx-example-author/SKILL.md",
      track: "refs/heads/main",
    }],
    replace: true,
  });
  const joined = await invoke("join", replacement);
  const joinOutput = logs.map(({ message }) => message)
    .findLast((message) => message.includes("startup-skilled"));
  const player = await invoke("player", "startup-skilled verify the replacement preflight");
  result = {
    registrations: (options.tools ?? []).map(({ name }) => name),
    joined,
    joinOutput,
    player,
  };
} else if (scenario === "startup-profile-diagnostics") {
  await waitFor(() => logs.some(({ message }) => message.includes("bounded profile discovery")),
    "one bounded startup profile warning");
  const blocked = await invoke("player", "omitted-player must remain unavailable");
  result = {
    blocked,
    startupWarnings: logs.map(({ message }) => message)
      .filter((message) => message.includes("bounded profile discovery")),
    commandNames: options.commands.map(({ name }) => name),
  };
} else if (scenario === "native-custom-tools") {
  const registrations = (options.tools ?? []).map(({ name, defer, parameters }) => ({ name, defer, parameters }));
  const crafter = await invoke("crafter", "exercise the bound native skill-tool boundary");
  const scout = await invoke("scout", "recruit one narrow read-only teammate");
  const joinWithSkillsInput = JSON.stringify({
    name: "skills-reload-player",
    description: "Player whose native skill loader needs a reload",
    prompt: "Work narrowly.",
    tools: ["read"],
    skills: [{
      kind: "github",
      name: "zx-example-author",
      repo: "gvillarroel/zx-harness",
      path: "skills/zx-example-author/SKILL.md",
      track: "refs/heads/main",
    }],
  });
  const joinWithSkills = await invoke("join", joinWithSkillsInput);
  const joinWithSkillsOutput = logs.map(({ message }) => message)
    .findLast((message) => message.includes("skills-reload-player"));
  const skillPlayerBeforeReload = await invoke("player", "skills-reload-player perform one bounded review");
  const skillPlayerSendCount = calls.send;
  const benchSkillOff = await invoke("bench", "off skills-reload-player");
  const benchSkillOn = await invoke("bench", "on skills-reload-player");
  const benchSkillOnOutput = logs.map(({ message }) => message)
    .findLast((message) => message.includes("Native skill loader pending for skills-reload-player"));
  result = {
    registrations,
    crafter,
    scout,
    joinWithSkills,
    joinWithSkillsOutput,
    skillPlayerBeforeReload,
    skillPlayerSendCount,
    benchSkillOff,
    benchSkillOn,
    benchSkillOnOutput,
    nativeToolResults,
    hasMcpHook: typeof options.hooks?.onPreMcpToolCall === "function",
    hasMcpServers: options.mcpServers !== undefined,
  };
} else if (scenario === "native-private-tool-error") {
  const invocation = await invoke("scout", "inspect a failing native roster boundary");
  result = { invocation, nativeToolResults };
} else if (scenario === "team-help") {
  const help = await invoke("team", "help");
  const longHelp = await invoke("team", "--help");
  result = {
    help,
    longHelp,
    outputs: logs.map(({ message }) => message).filter((message) => message.includes("Copilot team help")),
  };
} else if (scenario === "team-host-untracked-context") {
  const team = await invoke("team", "");
  result = {
    team,
    teamOutput: logs.map(({ message }) => message)
      .findLast((message) => message.includes("Agent Harbor Copilot team")),
  };
} else if (scenario === "scout-truncated-roster") {
  const invocation = await invoke("scout", "find security-review capacity without duplicating a teammate");
  result = {
    invocation,
    nativeToolResults,
    nativeRosterToolCalls,
    blockedProfileExists: existsSync(join(project, ".github", "agents", "must-not-join-after-truncation.agent.md")),
  };
} else if (["native-path-windows", "native-path-posix", "native-path-mismatch", "scout-ready-reuse",
  "native-controller-scope-match", "native-controller-scope-mismatch"].includes(scenario)) {
  if (scenario === "scout-ready-reuse") {
    await invoke("join", JSON.stringify({
      name: "path-bearing-reviewer",
      description: "Review C:\\private\\capacity.ts without exposing its location",
      prompt: "Work narrowly.",
      tools: ["read"],
    }));
    agents.push({
      id: "path-bearing-reviewer",
      name: "path-bearing-reviewer",
      userInvocable: true,
      path: join(project, ".github", "agents", "path-bearing-reviewer.agent.md"),
    });
    await invoke("bench", "on build");
    agents.push({
      id: "build",
      name: "build",
      userInvocable: true,
      path: join(project, ".github", "agents", "build.agent.md"),
    });
  }
  const invocation = await invoke("scout", "inspect existing team capacity");
  result = { invocation, busyAdmission, nativeToolResults };
} else if (scenario === "native-controller-team-stop") {
  const pending = invoke("scout", "hold one native roster read until stopped");
  await waitFor(() => typeof releaseNativeList === "function", "native roster controller before /team stop");
  const stopped = await invoke("team", "stop all");
  result = { invocation: await pending, stopped, nativeToolResults };
} else if (scenario === "native-precommit-join-stop") {
  const pending = invoke("scout", "never commit a player after cancellation");
  await waitFor(() => typeof releaseJoinAuthentication === "function", "held precommit join authentication");
  const stopped = await invoke("team", "stop all");
  result = {
    invocation: await pending,
    stopped,
    nativeToolResults,
    activeProfileExists: existsSync(join(project, ".github", "agents", "precommit-player.agent.md")),
    registrationExists: existsSync(join(process.env.COPILOT_HOME, "agent-foundry", "bench", "precommit-player.agent.md")),
  };
} else if (scenario === "native-postcommit-join-abort") {
  const invocation = await invoke("scout", "join one player and preserve any completed transaction");
  result = {
    invocation,
    nativeToolResults,
    activeProfileExists: existsSync(join(project, ".github", "agents", "postcommit-player.agent.md")),
    registrationExists: existsSync(join(process.env.COPILOT_HOME, "agent-foundry", "bench", "postcommit-player.agent.md")),
  };
} else if (scenario === "team-degraded-budget" || scenario === "team-default-budget") {
  const team = await invoke("team", "");
  result = {
    team,
    elapsedMs: Date.now() - harnessStartedAt,
    teamOutput: logs.map(({ message }) => message).findLast((message) => message.includes("Agent Harbor Copilot team")),
  };
} else if (scenario === "team-total-budget") {
  const team = await invoke("team", "");
  result = { team, elapsedMs: Date.now() - harnessStartedAt };
} else if (scenario === "team-stop-budget") {
  const invocation = { sessionId: session.sessionId };
  await options.hooks.onUserPromptSubmitted({
    sessionId: session.sessionId,
    workingDirectory: project,
    prompt: "keep this controlled root active",
  }, invocation);
  emit({ type: "assistant.turn_start", id: "team-stop-active-turn", data: { turnId: "team-stop-active-turn", model: "host-model" } });
  const started = Date.now();
  const stopped = await invoke("team", "stop all");
  const elapsedMs = Date.now() - started;
  const team = await invoke("team", "");
  result = {
    stopped,
    elapsedMs,
    team,
    teamOutput: logs.map(({ message }) => message).findLast((message) => message.includes("Agent Harbor Copilot team")),
  };
} else if (scenario === "team-partial-stop") {
  for (const suffix of ["a", "b"]) {
    if (suffix === "b") selected = agents[1];
    const invocation = { sessionId: `partial-stop-${suffix}` };
    await options.hooks.onUserPromptSubmitted({
      sessionId: invocation.sessionId,
      workingDirectory: project,
      prompt: `keep controlled root ${suffix} active`,
    }, invocation);
    emit({
      type: "assistant.turn_start",
      id: `partial-stop-turn-${suffix}`,
      data: { sessionId: invocation.sessionId, turnId: `partial-stop-turn-${suffix}`, model: "host-model" },
    });
  }
  const stopped = await invoke("team", "stop all");
  const stopOutput = logs.map(({ message }) => message)
    .findLast((message) => message.includes("Agent Harbor Copilot stop"));
  const team = await invoke("team", "");
  result = {
    stopped,
    stopOutput,
    team,
    teamOutput: logs.map(({ message }) => message)
      .findLast((message) => message.includes("Agent Harbor Copilot team")),
  };
} else if (scenario === "team-unverified-stop") {
  const stopped = await invoke("team", "stop all");
  result = { stopped };
} else if (scenario === "team-scope-recovery") {
  const first = await invoke("team", "");
  const firstOutput = logs.map(({ message }) => message)
    .findLast((message) => message.includes("Agent Harbor Copilot team"));
  const second = await invoke("team", "");
  const secondOutput = logs.map(({ message }) => message)
    .findLast((message) => message.includes("Agent Harbor Copilot team"));
  result = { first, firstOutput, second, secondOutput };
} else if (scenario === "team-read-recovery") {
  const team = await invoke("team", "");
  result = {
    team,
    teamOutput: logs.map(({ message }) => message)
      .findLast((message) => message.includes("Agent Harbor Copilot team")),
  };
} else if (scenario === "team-scope-identity-hazard") {
  const timestamp = new Date(Date.now() + 1_000).toISOString();
  emit({
    type: "assistant.usage", timestamp,
    data: { model: "unscoped-anonymous", inputTokens: 10, outputTokens: 1 },
  });
  emit({
    type: "assistant.usage", id: "unscoped-identified-replay", timestamp,
    data: {
      providerCallId: "unscoped-provider-replay", model: "unscoped-drifted",
      inputTokens: 999, outputTokens: 999,
    },
  });
  const team = await invoke("team", "");
  result = {
    team,
    teamOutput: logs.map(({ message }) => message)
      .findLast((message) => message.includes("Agent Harbor Copilot team")),
  };
} else if (scenario === "team-lead-active-access") {
  const pending = invoke("team-lead", "coordinate without a child yet");
  await waitFor(() => calls.send === 1, "active manager prompt");
  const team = await invoke("team", "");
  const teamOutput = logs.map(({ message }) => message)
    .findLast((message) => message.includes("Agent Harbor Copilot team"));
  emit({
    type: "session.idle", id: "active-manager-idle", parentId: "active-direct-turn-team-lead-active-access",
    timestamp: new Date(Date.now() + 1).toISOString(), data: { aborted: false },
  });
  releaseManagerSend?.();
  result = { invocation: await pending, team, teamOutput };
} else if (scenario === "retire-active-personal") {
  const definition = JSON.stringify({
    name: "retire-reviewer",
    description: "Review retirement safety",
    prompt: "Review safely",
    tools: ["read"],
  });
  const joined = await invoke("join", definition);
  agents.push({
    id: "retire-reviewer",
    name: "retire-reviewer",
    userInvocable: true,
    path: join(project, ".github", "agents", "retire-reviewer.agent.md"),
  });
  const pending = invoke("player", "retire-reviewer remain active during retirement preflight");
  await waitFor(() => calls.send === 1, "active personal player before retirement");
  const reloadBeforeBlockedRetire = calls.reload;
  const blockedRetire = await invoke("retire", "retire-reviewer");
  const reloadAfterBlockedRetire = calls.reload;
  const profileAfterBlockedRetire = existsSync(join(project, ".github", "agents", "retire-reviewer.agent.md"));
  const stopped = await invoke("team", "stop all");
  const invocation = await pending;
  const retired = await invoke("retire", "retire-reviewer");
  result = {
    joined,
    blockedRetire,
    reloadBeforeBlockedRetire,
    reloadAfterBlockedRetire,
    profileAfterBlockedRetire,
    stopped,
    invocation,
    retired,
    profileAfterRetire: existsSync(join(project, ".github", "agents", "retire-reviewer.agent.md")),
  };
} else if (scenario === "lifecycle-identity-hazard") {
  const invocation = { sessionId: session.sessionId };
  await options.hooks.onUserPromptSubmitted({
    sessionId: session.sessionId,
    workingDirectory: project,
    prompt: "prepare two auditable manager decisions",
  }, invocation);
  const toolInput = (suffix) => ({
    sessionId: session.sessionId,
    workingDirectory: project,
    toolName: "task",
    toolArgs: { agent_type: "agent-foundry:crafter", prompt: `bounded evidence ${suffix}` },
  });
  const firstInput = toolInput("one");
  const firstDecision = await options.hooks.onPreToolUse(firstInput, invocation);
  await options.hooks.onPostToolUseFailure({ ...firstInput, error: "bounded cleanup one" }, invocation);
  const secondInput = toolInput("two");
  const secondDecision = await options.hooks.onPreToolUse(secondInput, invocation);
  await options.hooks.onPostToolUseFailure({ ...secondInput, error: "bounded cleanup two" }, invocation);

  const future = Date.now() + 60_000;
  emit({
    type: "hook.end", id: "hazard-hook-event-A", timestamp: new Date(future - 20).toISOString(),
    data: { hookType: "preToolUse", hookInvocationId: "hazard-hook-invocation-A" },
  });
  emit({
    type: "hook.end", id: "hazard-hook-event-A-replay", timestamp: new Date(future - 20).toISOString(),
    data: { hookType: "preToolUse", hookInvocationId: "hazard-hook-invocation-A" },
  });
  emit({
    type: "hook.end", id: "hazard-hook-event-B", timestamp: new Date(future - 19).toISOString(),
    data: { hookType: "preToolUse", hookInvocationId: "hazard-hook-invocation-B" },
  });
  await waitFor(() => logs.filter(({ metadata }) => metadata?.type === "agent-harbor-guard").length === 2,
    "two non-replayed guard evidence logs");

  const anonymousUsage = {
    type: "assistant.usage", timestamp: new Date(future).toISOString(),
    data: { model: "anonymous-model", inputTokens: 100, outputTokens: 10 },
  };
  emit(anonymousUsage);
  emit({
    type: "session.idle", id: "hazard-root-A-idle", timestamp: new Date(future + 1).toISOString(),
    data: { aborted: false },
  });
  await options.hooks.onUserPromptSubmitted({
    sessionId: session.sessionId,
    workingDirectory: project,
    prompt: "keep the current team state visible",
  }, invocation);
  emit({
    type: "assistant.usage", id: "hazard-root-B-usage", timestamp: new Date(future + 10).toISOString(),
    data: {
      apiCallId: "hazard-root-B-call", model: "verified-model", inputTokens: 2, outputTokens: 1,
    },
  });
  emit({ ...anonymousUsage, data: { ...anonymousUsage.data } });

  const team = await invoke("team", "");
  const teamOutput = logs.map(({ message }) => message)
    .findLast((message) => message.includes("Agent Harbor Copilot team"));
  const noMatch = await invoke("team", "does-not-exist");
  const noMatchOutput = logs.map(({ message }) => message)
    .findLast((message) => message.includes("Agent Harbor Copilot team"));
  const blocked = await invoke("crafter", "must fail before model work");
  result = {
    firstDecision,
    secondDecision,
    team,
    teamOutput,
    noMatch,
    noMatchOutput,
    blocked,
    guardEvidenceLogs: logs.filter(({ metadata }) => metadata?.type === "agent-harbor-guard").length,
  };
} else if (scenario === "guard-terminal-clear") {
  const invocation = { sessionId: session.sessionId };
  const toolInput = (prompt) => ({
    sessionId: session.sessionId,
    workingDirectory: project,
    toolName: "task",
    toolArgs: { agent_type: "agent-foundry:crafter", prompt },
  });
  await options.hooks.onUserPromptSubmitted({
    sessionId: session.sessionId,
    workingDirectory: project,
    prompt: "first auditable manager turn",
  }, invocation);
  const staleInput = toolInput("stale evidence must be discarded");
  const staleDecision = await options.hooks.onPreToolUse(staleInput, invocation);
  await options.hooks.onPostToolUseFailure({ ...staleInput, error: "bounded stale cleanup" }, invocation);
  emit({ type: "abort", id: "guard-clear-abort", data: { sessionId: session.sessionId } });
  emit({
    type: "hook.end",
    id: "guard-clear-stale-hook",
    data: { hookType: "preToolUse", hookInvocationId: "guard-clear-stale-invocation" },
  });
  emit({
    type: "session.idle",
    id: "guard-clear-idle",
    data: { sessionId: session.sessionId, aborted: true },
  });

  await options.hooks.onUserPromptSubmitted({
    sessionId: session.sessionId,
    workingDirectory: project,
    prompt: "fresh auditable manager turn",
  }, invocation);
  const freshInput = toolInput("fresh evidence may be logged");
  const freshDecision = await options.hooks.onPreToolUse(freshInput, invocation);
  await options.hooks.onPostToolUseFailure({ ...freshInput, error: "bounded fresh cleanup" }, invocation);
  emit({
    type: "hook.end",
    id: "guard-clear-fresh-hook",
    data: { hookType: "preToolUse", hookInvocationId: "guard-clear-fresh-invocation" },
  });
  await waitFor(() => logs.filter(({ metadata }) => metadata?.type === "agent-harbor-guard").length === 1,
    "one fresh guard evidence log");
  result = {
    staleDecision,
    freshDecision,
    guardEvidence: logs
      .filter(({ metadata }) => metadata?.type === "agent-harbor-guard")
      .map(({ message }) => JSON.parse(message)),
  };
} else if (scenario === "log-hang") {
  const started = Date.now();
  result = { invocation: await invoke("crafter", "bounded logging"), elapsedMs: Date.now() - started };
} else if (scenario === "log-hang-default") {
  const started = Date.now();
  const invocation = await invoke("crafter", "default bounded logging");
  const elapsedMs = Date.now() - started;
  const logCallsAfterTimeout = calls.log;
  logHangs = false;
  await wait(1_100);
  const retry = await invoke("team", "help");
  result = { invocation, elapsedMs, logCallsAfterTimeout, retry };
} else if (scenario === "active-work") {
  result = { invocation: await invoke("crafter", "must not start") };
} else if (scenario === "display-reject") {
  result = { invocation: await invoke("team", "") };
} else if (scenario === "private-error") {
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
} else if (scenario === "no-model-control-ux") {
  const definition = JSON.stringify({
    name: "offline-reviewer",
    description: "Review without a configured host model",
    prompt: "Review safely",
    tools: ["read"],
  });
  const joined = await invoke("join", definition);
  const joinOutput = logs.map(({ message }) => message).findLast((message) => message.includes("Agent Harbor /join"));
  const team = await invoke("team", "member:offline-reviewer");
  const teamOutput = logs.map(({ message }) => message).findLast((message) => message.includes("Agent Harbor Copilot team"));
  result = { joined, joinOutput, team, teamOutput };
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
  const privateJoined = await invoke("join", JSON.stringify({
    name: "private-metadata",
    description: "Review C:/Users/alice/secret.txt with Bearer abcdefghijklmnop",
    prompt: "Review safely",
    tools: ["read"],
  }));
  const privateJoinOutput = logs.map(({ message }) => message).findLast((message) => message.includes("private-metadata"));
  const privateTeam = await invoke("team", "private-metadata");
  const privateTeamOutput = logs.map(({ message }) => message)
    .findLast((message) => message.includes("Agent Harbor Copilot team"));
  const reloadBeforeRejectedControls = calls.reload;
  const oversizedTeam = await invoke("team", "x".repeat(4_097));
  const oversizedJoin = await invoke("join", "x".repeat(100_001));
  const oversizedBench = await invoke("bench", "x".repeat(4_097));
  const oversizedRetire = await invoke("retire", "x".repeat(4_097));
  const oversizedListSkills = await invoke("list-skills", "x".repeat(4_097));
  const hostileJoin = await invoke("join", { definition: "x".repeat(200_000) });
  const hostileScout = await invoke("scout", { task: "x".repeat(200_000) });
  const hostileAlias = await invoke("crafter", { task: "x".repeat(200_000) });
  const reloadAfterRejectedControls = calls.reload;
  result = {
    bench, benchOutput, bundledRetry, joined, joinOutput, benched, personalBenchRetry,
    retired, retireOutput, retry, privateJoined, privateJoinOutput, privateTeam, privateTeamOutput,
    oversizedTeam, oversizedJoin, oversizedBench, oversizedRetire, oversizedListSkills,
    hostileJoin, hostileScout, hostileAlias,
    reloadBeforeRejectedControls, reloadAfterRejectedControls, sandbox, project,
  };
} else if (scenario === "inactive-personal-repair") {
  const definitions = [
    { name: "active-stale", description: "Active stale", prompt: "Work", tools: ["read"] },
    { name: "registration-stale", description: "Registration stale", prompt: "Work", tools: ["read"] },
    { name: "unmanaged-conflict", description: "Unmanaged conflict", prompt: "Work", tools: ["read"] },
  ];
  for (const definition of definitions) {
    const joined = await invoke("join", JSON.stringify(definition));
    if (!joined.ok) throw new Error(`fixture join failed: ${definition.name}`);
  }
  const activeRoot = join(project, ".github", "agents");
  const registrationRoot = join(process.env.COPILOT_HOME, "agent-foundry", "bench");
  const activeStalePath = join(activeRoot, "active-stale.agent.md");
  await writeFile(
    activeStalePath,
    (await readFile(activeStalePath, "utf8")).replace("Active stale", "Altered active stale"),
    "utf8",
  );
  const registrationStalePath = join(registrationRoot, "registration-stale.agent.md");
  const invalidDefinition = Buffer.from(JSON.stringify({ name: "registration-stale" }), "utf8").toString("base64url");
  await writeFile(
    registrationStalePath,
    (await readFile(registrationStalePath, "utf8"))
      .replace(/<!-- agent-foundry:definition [A-Za-z0-9_-]+ -->/u,
        `<!-- agent-foundry:definition ${invalidDefinition} -->`),
    "utf8",
  );
  await writeFile(join(activeRoot, "unmanaged-conflict.agent.md"), "unmanaged collision\n", "utf8");
  result = {
    activeStale: await invoke("player", "active-stale inspect repair"),
    registrationStale: await invoke("player", "registration-stale inspect repair"),
    conflict: await invoke("player", "unmanaged-conflict inspect repair"),
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
  const team = await invoke("team", "");
  const teamOutput = logs.map(({ message }) => message)
    .findLast((message) => message.includes("Agent Harbor Copilot team"));
  await wait(350);
  result = { invocation, restoredAtReturn, restoredAfterLate: calls.deselect, team, teamOutput };
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
  const team = await invoke("team", "");
  const teamOutput = logs.map(({ message }) => message)
    .findLast((message) => message.includes("Agent Harbor Copilot team"));
  result = { invocation, retry, team, teamOutput };
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
} else if (scenario === "select-result-mismatch" || scenario === "select-current-mismatch") {
  result = { invocation: await invoke("crafter", "selection identity must be exact") };
} else if (scenario === "selection-concurrency") {
  const concurrent = await Promise.all(Array.from(
    { length: 50 },
    (_, index) => invoke("crafter", `concurrent selection ${index}`),
  ));
  const sendsDuringConcurrentBatch = calls.send;
  const retry = await invoke("crafter", "selection lock clears after failure");
  result = { concurrent, sendsDuringConcurrentBatch, retry };
} else if (scenario === "restore-identity-mismatch" || scenario === "deselect-not-empty") {
  const invocation = await invoke("crafter", "restoration identity must be exact");
  const retry = await invoke("crafter", "must remain blocked after unverified restoration");
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
  emit({
    type: "session.idle", id: "stale-idle-before-selection", parentId: "previous-run-event",
    timestamp: new Date(Date.now() - 60_000).toISOString(), data: { aborted: false },
  });
  releaseSelection();
  result = { invocation: await pending };
} else if (scenario === "acceptance-stale-idle") {
  result = {
    invocation: await invoke("crafter", "ignore idle during prompt acceptance"),
    restoredWhileActive,
  };
} else if (scenario === "accepting-terminal-default") {
  const started = Date.now();
  result = {
    invocation: await invoke("crafter", "wake default prompt acceptance from native terminal"),
    elapsedMs: Date.now() - started,
    restoredWhileActive,
  };
} else if (scenario === "acceptance-terminal-flood" || scenario === "direct-oversized-event-ids") {
  const started = Date.now();
  const invocation = await invoke("crafter", `exercise ${scenario}`);
  result = {
    invocation,
    elapsedMs: Date.now() - started,
    missionOutput: logs.map(({ message }) => message)
      .findLast((message) => message.includes("TEAM RUN (native Copilot telemetry)")),
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
} else if (scenario === "direct-replay-delta-first") {
  const started = Date.now();
  const invocation = await invoke("crafter", "ignore a replayed delta before the current native chain");
  result = {
    invocation,
    elapsedMs: Date.now() - started,
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
  const manualTeam = await invoke("team", "run:copilot-run");
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
} else if (scenario === "manual-profile-model") {
  const now = Date.now();
  emit({
    type: "session.start",
    id: "manual-profile-session-start",
    parentId: null,
    timestamp: new Date(now).toISOString(),
    data: { selectedModel: "host-model", reasoningEffort: null },
  });
  const invocation = { sessionId: session.sessionId };
  await options.hooks.onUserPromptSubmitted({
    sessionId: session.sessionId,
    workingDirectory: project,
    prompt: "exercise the configured manual profile",
  }, invocation);
  const initialTeam = await invoke("team", "member:crafter");
  const initialTeamOutput = logs.map(({ message }) => message)
    .findLast((message) => message.includes("Agent Harbor Copilot team"));
  const activityAt = Date.now() + 1_000;
  emit({
    type: "session.model_change",
    id: "manual-profile-confirmation",
    parentId: "manual-profile-session-start",
    timestamp: new Date(activityAt).toISOString(),
    data: { newModel: "profile-model", reasoningEffort: null },
  });
  const confirmedTeam = await invoke("team", "member:crafter");
  const confirmedTeamOutput = logs.map(({ message }) => message)
    .findLast((message) => message.includes("Agent Harbor Copilot team"));
  emit({
    type: "session.model_change",
    id: "manual-profile-changed-before-turn",
    parentId: "manual-profile-confirmation",
    timestamp: new Date(activityAt + 1).toISOString(),
    data: { newModel: "provider-model", reasoningEffort: "high" },
  });
  const observedTeam = await invoke("team", "member:crafter");
  const observedTeamOutput = logs.map(({ message }) => message)
    .findLast((message) => message.includes("Agent Harbor Copilot team"));
  emit({
    type: "session.idle",
    id: "manual-profile-idle",
    parentId: "manual-profile-changed-before-turn",
    timestamp: new Date(activityAt + 2).toISOString(),
    data: { aborted: false },
  });
  result = { initialTeam, initialTeamOutput, confirmedTeam, confirmedTeamOutput, observedTeam, observedTeamOutput };
} else if (scenario === "direct-provider-confirmation") {
  const invocation = await invoke("crafter", "confirm configured provider");
  result = {
    invocation,
    missionOutput: logs.map(({ message }) => message)
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
  const childId = logs.flatMap(({ message }) => [...message.matchAll(/^↳ crafter · (copilot-run-\d+) ·/gmu)].map((match) => match[1])).at(-1);
  const direct = await invoke("crafter", "must not race reserved child");
  const stopped = await invoke("team", `stop ${childId}`);
  await options.hooks.onPostToolUseFailure({ ...toolInput, error: "test cleanup" }, invocation);
  result = {
    admission, benchStop, benchStopOutput, benchStopAll, benchStopAllOutput,
    abortAfterBenchLists, childId, direct, stopped,
  };
} else if (scenario === "contract-team-observability" || scenario === "contract-selected-team-observability") {
  const selectedContract = scenario === "contract-selected-team-observability";
  const invocation = { sessionId: session.sessionId };
  const now = Date.now() + 1_000;
  const raw = JSON.stringify({
    name: "ephemeral-reviewer",
    description: "Disposable reviewer",
    prompt: "PRIVATE-RAW-CONTRACT-SECRET",
    tools: ["read", "search"],
    task: "Review token=PRIVATE-TASK-SECRET in C:\\private\\contract.ts",
  });
  emit({
    type: "session.start", id: "contract-session-start", timestamp: new Date(now).toISOString(),
    data: { selectedModel: "root-model", reasoningEffort: "low" },
  });
  await options.hooks.onUserPromptSubmitted({
    sessionId: session.sessionId,
    workingDirectory: project,
    prompt: `Context first\n/contract ${raw}`,
  }, invocation);
  if (selectedContract) {
    emit({
      type: "assistant.usage", id: "contract-root-usage", parentId: "contract-session-start",
      timestamp: new Date(now + 1).toISOString(),
      data: {
        apiCallId: "contract-root-provider-call", model: "selected-root-model", reasoningEffort: "low",
        inputTokens: 11, outputTokens: 2, reasoningTokens: 1, cacheReadTokens: 3, cacheWriteTokens: 1,
      },
    });
  }
  emit({
    type: "skill.invoked", id: "contract-skill",
    parentId: selectedContract ? "contract-root-usage" : "contract-session-start",
    timestamp: new Date(now + (selectedContract ? 2 : 1)).toISOString(),
    data: { name: "contract", pluginName: "agent-foundry", source: "plugin", trigger: "user-invoked" },
  });
  if (!selectedContract) {
    emit({
      type: "assistant.usage", id: "contract-root-usage", parentId: "contract-skill",
      timestamp: new Date(now + 2).toISOString(),
      data: {
        apiCallId: "contract-root-provider-call", model: "root-model", reasoningEffort: "low",
        inputTokens: 11, outputTokens: 2, reasoningTokens: 1, cacheReadTokens: 3, cacheWriteTokens: 1,
      },
    });
  }
  const contractArguments = { definition: raw };
  const controlInput = {
    sessionId: session.sessionId,
    workingDirectory: project,
    toolName: "harbor_contract",
    toolArgs: contractArguments,
  };
  const controlDecision = await options.hooks.onPreToolUse(controlInput, invocation);
  emit({
    type: "tool.execution_start", id: "contract-control-start", parentId: "contract-root-usage",
    timestamp: new Date(now + 3).toISOString(),
    data: {
      toolName: "harbor_contract", toolCallId: "contract-control-call", arguments: contractArguments,
    },
  });
  const nativePreflight = await invokeNativeTool(
    "harbor_contract",
    contractArguments,
    "contract-control-call",
  );
  if (!nativePreflight.ok) throw new Error(`native contract preflight failed: ${nativePreflight.error.message}`);
  const descriptor = nativePreflight.value;
  emit({
    type: "tool.execution_complete", id: "contract-control-complete", parentId: "contract-control-start",
    timestamp: new Date(now + 4).toISOString(),
    data: {
      toolCallId: "contract-control-call", success: true,
      result: descriptor,
    },
  });
  const taskInput = {
    sessionId: session.sessionId,
    workingDirectory: project,
    toolName: "task",
    toolArgs: descriptor,
  };
  emit({
    type: "tool.execution_start", id: "contract-task-start", parentId: "contract-control-complete",
    timestamp: new Date(now + 5).toISOString(),
    data: { toolName: "task", toolCallId: "contract-task-call" },
  });
  const taskDecision = await options.hooks.onPreToolUse(taskInput, invocation);
  emit({
    type: "subagent.started", id: "contract-child-start", parentId: "contract-task-start",
    timestamp: new Date(now + 6).toISOString(), agentId: "contract-native-child",
    data: { agentName: "explore", toolCallId: "contract-task-call", model: "child-model" },
  });
  const childUsage = {
    type: "assistant.usage", id: "contract-child-usage", parentId: "contract-child-start",
    timestamp: new Date(now + 7).toISOString(), agentId: "contract-native-child",
    data: {
      serviceRequestId: "contract-child-provider-call", parentToolCallId: "contract-task-call",
      model: "child-model", reasoningEffort: "high", inputTokens: 20, outputTokens: 4,
      reasoningTokens: 2, cacheReadTokens: 5, cacheWriteTokens: 1,
    },
  };
  emit(childUsage);
  emit(childUsage);
  const activeTeam = await invoke("team", "");
  const activeTeamOutput = logs.map(({ message }) => message)
    .findLast((message) => message.includes("Agent Harbor Copilot team"));
  const activeDetail = await invoke("team", "run:copilot-run-2");
  const activeDetailOutput = logs.map(({ message }) => message)
    .findLast((message) => message.includes("Agent Harbor Copilot team"));
  emit({
    type: "subagent.completed", id: "contract-child-complete", parentId: "contract-child-usage",
    timestamp: new Date(now + 8).toISOString(), agentId: "contract-native-child",
    data: {
      agentName: "explore", toolCallId: "contract-task-call", model: "child-model",
      durationMs: 750, totalTokens: 30, totalToolCalls: 2,
    },
  });
  emit({
    type: "tool.execution_complete", id: "contract-task-complete", parentId: "contract-child-complete",
    timestamp: new Date(now + 9).toISOString(),
    data: { toolCallId: "contract-task-call", toolDescription: { name: "task" }, success: true },
  });
  await options.hooks.onPostToolUse({ ...taskInput, toolResult: "PRIVATE CHILD RESULT" }, invocation);
  emit({
    type: "session.idle", id: "contract-root-idle", parentId: "contract-task-complete",
    timestamp: new Date(now + 10).toISOString(), data: { aborted: false },
  });
  const historyTeam = await invoke("team", "");
  const historyTeamOutput = logs.map(({ message }) => message)
    .findLast((message) => message.includes("Agent Harbor Copilot team"));
  const historyDetail = await invoke("team", "run:copilot-run-2");
  const historyDetailOutput = logs.map(({ message }) => message)
    .findLast((message) => message.includes("Agent Harbor Copilot team"));
  result = {
    controlWasUndefined: controlDecision === undefined,
    controlDecision,
    nativePreflight,
    taskDecision,
    activeTeam,
    activeTeamOutput,
    activeDetail,
    activeDetailOutput,
    historyTeam,
    historyTeamOutput,
    historyDetail,
    historyDetailOutput,
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
  await waitFor(() => logs.some(({ message }) => /crafter failed/u.test(message)), "inferred child terminal log");
  result = { admission };
} else {
  throw new Error(`unknown scenario: ${scenario}`);
}

clearInterval(keepAlive);
process.chdir(root);
await rm(sandbox, { recursive: true, force: true });
process.stdout.write(`${JSON.stringify({ scenario, result, calls, logs })}\n`);
