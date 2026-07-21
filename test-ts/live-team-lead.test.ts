import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  CopilotClient,
  RuntimeConnection,
  type PermissionHandler,
  type PermissionRequest,
  type SessionEvent,
} from "@github/copilot-sdk";
import { runDeterministicCommand } from "../src/adapters/direct.js";
import { copilotFixedAgentIds, resolveCopilotPlayer } from "../src/adapters/copilot-coordinator.js";
import { loadHarborCycleDataset } from "./support/harbor-cycles.js";
import { foldMarkdownWrappedText } from "./support/live-handoff.js";
import { LIVE_FIXTURE_TOOL_TARGETS, classifyLiveToolTarget } from "./support/live-tool-targets.mjs";

const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const plugins = join(root, "plugins");
const reportPath = join(root, "work", "live-team-lead-report.json");
const harborExtensionId = "plugin:agent-foundry:agent-harbor";
const harborExtensionName = "agent-foundry:agent-harbor";
const model = process.env.AGENT_HARBOR_LIVE_MODEL || "gpt-5.4-mini";
const reasoningEffort = process.env.AGENT_HARBOR_LIVE_REASONING || "low";
const maxAiCredits = 60;
const liveRequested = process.env.npm_lifecycle_event === "test:live:lead" || process.env.AGENT_HARBOR_LIVE === "1";
const sandboxBypassCanarySessionId = "agent-harbor-sandbox-bypass-canary";

interface LiveCall {
  agent: string;
  prompt: string;
  result: string;
  toolCallId: string;
  childId: string;
  startedIndex: number;
  childStartedIndex: number;
  childCompletedIndex: number;
  completedIndex: number;
  durationMs?: number;
  totalTokens?: number;
  totalToolCalls?: number;
}

interface PermissionAuditEntry {
  decision: "approved" | "rejected";
  kind: PermissionRequest["kind"];
  sandboxBypassRequested: boolean;
  source: "runtime" | "sandbox-bypass-canary";
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function occurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}

function withoutTrailingBlankLines(value: string): string {
  return normalizeLineEndings(value).replace(/(?:\n[ \t]*)+$/u, "");
}

function isFixturePath(project: string, value: string): boolean {
  const raw = value.trim();
  if (!raw || /^(?:~(?:[\\/]|$)|%[^%]+%|\$(?:env:|\{|[A-Za-z_]))/iu.test(raw) || /["'`]/u.test(raw)) return false;
  const base = resolve(project);
  const candidate = resolve(base, raw);
  const child = relative(base, candidate);
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

function samePath(left: string, right: string): boolean {
  const normalized = (value: string) => process.platform === "win32" ? resolve(value).toLowerCase() : resolve(value);
  return normalized(left) === normalized(right);
}

function createFixturePermissionHandler(project: string, audit: PermissionAuditEntry[]): PermissionHandler {
  return (request, invocation) => {
    const sandboxBypassRequested = "requestSandboxBypass" in request && request.requestSandboxBypass === true;
    let approved = false;
    if (!sandboxBypassRequested) {
      switch (request.kind) {
        case "read":
          approved = isFixturePath(project, request.path);
          break;
        case "write":
          approved = samePath(resolve(project, request.fileName), join(project, "src", "score.js"));
          break;
        case "shell":
          approved = request.possibleUrls.length === 0 &&
            request.possiblePaths.every((path) => isFixturePath(project, path)) &&
            !request.hasWriteFileRedirection &&
            /^npm(?:\.cmd)? test$/iu.test(request.fullCommandText.trim());
          break;
        case "custom-tool":
          approved = request.toolName === "task";
          break;
        case "extension-permission-access":
          approved = new Set(["agent-harbor", harborExtensionName, harborExtensionId]).has(request.extensionName);
          break;
        default:
          approved = false;
      }
    }
    audit.push({
      decision: approved ? "approved" : "rejected",
      kind: request.kind,
      sandboxBypassRequested,
      source: invocation.sessionId === sandboxBypassCanarySessionId ? "sandbox-bypass-canary" : "runtime",
    });
    return approved
      ? { kind: "approve-once" }
      : { kind: "reject", feedback: "Agent Harbor live smoke permits only fixture-local, sandboxed task work" };
  };
}

function decisionCounts(audit: readonly PermissionAuditEntry[], decision: PermissionAuditEntry["decision"]): Record<string, number> {
  const counts = new Map<string, number>();
  for (const entry of audit) {
    if (entry.decision === decision) counts.set(entry.kind, (counts.get(entry.kind) ?? 0) + 1);
  }
  return Object.fromEntries([...counts].sort(([left], [right]) => left.localeCompare(right)));
}

function summarizeUsage(events: readonly SessionEvent[]): { events: number; inputTokens: number; outputTokens: number; totalTokens: number } {
  const usage = events.filter((event) => event.type === "assistant.usage");
  const inputTokens = usage.reduce((sum, event) =>
    sum + (event.type === "assistant.usage" ? event.data.inputTokens ?? 0 : 0), 0);
  const outputTokens = usage.reduce((sum, event) =>
    sum + (event.type === "assistant.usage" ? event.data.outputTokens ?? 0 : 0), 0);
  return { events: usage.length, inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
}

function childUsageEvents(events: readonly SessionEvent[], call: LiveCall): SessionEvent[] {
  return events.filter((event) => event.type === "assistant.usage" && event.agentId === call.childId);
}

function observedChildTokens(events: readonly SessionEvent[], call: LiveCall): number {
  return Math.max(call.totalTokens ?? 0, summarizeUsage(childUsageEvents(events, call)).totalTokens);
}

function cleanChildEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

async function findCopilot(): Promise<string> {
  const override = process.env.COPILOT_CLI_PATH?.trim();
  if (override) {
    await access(override, constants.X_OK);
    return override;
  }
  const suffixes = process.platform === "win32" ? [".exe", ".com"] : [""];
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    for (const suffix of suffixes) {
      const candidate = join(directory, `copilot${suffix}`);
      try { await access(candidate, constants.X_OK); return candidate; }
      catch { /* keep looking */ }
    }
  }
  throw new Error("Copilot CLI not found; set COPILOT_CLI_PATH to the authenticated executable");
}

async function runProcess(command: string, args: string[], cwd: string, timeoutMs = 60_000): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: cleanChildEnvironment(),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = ""; let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    const timer = setTimeout(() => { child.kill(); reject(new Error(`process timed out after ${timeoutMs}ms`)); }, timeoutMs);
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`process exited ${code}: ${stderr || stdout}`));
    });
  });
}

function eventIndex(events: readonly SessionEvent[], candidate: SessionEvent): number {
  return events.indexOf(candidate);
}

function maxConcurrentChildren(events: readonly SessionEvent[]): number {
  const active = new Set<string>();
  let maximum = 0;
  for (const event of events) {
    if (event.type === "subagent.started" && event.agentId) {
      active.add(event.agentId);
      maximum = Math.max(maximum, active.size);
    } else if ((event.type === "subagent.completed" || event.type === "subagent.failed") && event.agentId) {
      active.delete(event.agentId);
    }
  }
  return maximum;
}

function inspectCalls(events: readonly SessionEvent[], expectedAgents: readonly string[]): LiveCall[] {
  const taskStarts = events.filter((event) => event.type === "tool.execution_start" && !event.agentId && event.data.toolName === "task");
  const otherRootTools = events.filter((event) => event.type === "tool.execution_start" && !event.agentId && event.data.toolName !== "task");
  const allChildStarts = events.filter((event) => event.type === "subagent.started");
  assert.equal(otherRootTools.length, 0, "team-lead used a redundant root tool");
  assert.equal(taskStarts.length, expectedAgents.length, "team-lead must make exactly one task call per required stage");
  assert.deepEqual(allChildStarts.map((event) => event.type === "subagent.started" ? event.data.agentName : ""), expectedAgents,
    "team-lead created an extra, missing, or out-of-order child");

  const calls = taskStarts.map((started, index): LiveCall => {
    const args = started.data.arguments ?? {};
    const agent = typeof args.agent_type === "string" ? args.agent_type : "";
    const prompt = typeof args.prompt === "string" ? args.prompt : "";
    assert.equal(agent, expectedAgents[index], `wrong specialist at stage ${index + 1}`);
    assert.ok(prompt, `stage ${index + 1} has no bounded task prompt`);
    assert.ok(utf8Bytes(prompt) <= 4_096, `stage ${index + 1} prompt exceeds 4 KiB`);

    const childStarts = events.filter((event) => event.type === "subagent.started" && event.data.toolCallId === started.data.toolCallId);
    const childCompletions = events.filter((event) => event.type === "subagent.completed" && event.data.toolCallId === started.data.toolCallId);
    const childFailures = events.filter((event) => event.type === "subagent.failed" && event.data.toolCallId === started.data.toolCallId);
    const toolCompletions = events.filter((event) => event.type === "tool.execution_complete" && !event.agentId && event.data.toolCallId === started.data.toolCallId);
    assert.equal(childStarts.length, 1, `stage ${index + 1} must create exactly one child`);
    assert.equal(childCompletions.length, 1, `stage ${index + 1} child did not complete exactly once`);
    assert.equal(childFailures.length, 0, `stage ${index + 1} child failed`);
    assert.equal(toolCompletions.length, 1, `stage ${index + 1} task did not complete exactly once`);
    const childStarted = childStarts[0];
    const childCompleted = childCompletions[0];
    const completed = toolCompletions[0];
    assert.equal(childStarted.data.agentName, agent, `stage ${index + 1} runtime agent mismatch`);
    assert.equal(childCompleted.data.agentName, agent, `stage ${index + 1} terminal agent mismatch`);
    assert.equal(childStarted.agentId, childCompleted.agentId, `stage ${index + 1} child identity changed`);
    assert.ok(childStarted.agentId, `stage ${index + 1} has no native child ID`);
    assert.equal(completed.data.success, true, `stage ${index + 1} task failed`);
    const result = completed.data.result?.content ?? "";
    assert.ok(result, `stage ${index + 1} returned no evidence`);

    const startedIndex = eventIndex(events, started);
    const childStartedIndex = eventIndex(events, childStarted);
    const childCompletedIndex = eventIndex(events, childCompleted);
    const completedIndex = eventIndex(events, completed);
    assert.ok(startedIndex < childStartedIndex, `stage ${index + 1} child started before its task`);
    assert.ok(childStartedIndex < childCompletedIndex, `stage ${index + 1} terminal preceded child start`);
    assert.ok(childCompletedIndex < completedIndex, `stage ${index + 1} task completed before its child`);
    return {
      agent, prompt, result, toolCallId: started.data.toolCallId, childId: childStarted.agentId!,
      startedIndex, childStartedIndex, childCompletedIndex, completedIndex,
      durationMs: childCompleted.data.durationMs,
      totalTokens: childCompleted.data.totalTokens,
      totalToolCalls: childCompleted.data.totalToolCalls,
    };
  });

  assert.equal(new Set(calls.map((call) => call.toolCallId)).size, calls.length, "task call IDs must be unique");
  assert.equal(new Set(calls.map((call) => call.childId)).size, calls.length, "child IDs must be unique");
  for (let index = 1; index < calls.length; index += 1) {
    assert.ok(calls[index - 1].completedIndex < calls[index].startedIndex, `stages ${index} and ${index + 1} overlapped`);
  }
  assert.equal(events.some((event) => event.type === "subagent.failed"), false, "a live subagent failed");
  assert.equal(events.some((event) => event.type === "tool.execution_start" && Boolean(event.agentId) && event.data.toolName === "task"), false, "a child delegated recursively");
  return calls;
}

async function writeReport(report: unknown): Promise<void> {
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

async function removeSandbox(path: string): Promise<void> {
  const temporaryRoot = resolve(tmpdir());
  const target = resolve(path);
  if (dirname(target) !== temporaryRoot || !target.slice(temporaryRoot.length + 1).startsWith("harbor-live-lead-")) {
    throw new Error(`refusing to remove unexpected live sandbox: ${target}`);
  }
  let lastError: unknown;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try { await rm(target, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 }); return; }
    catch (error: any) {
      lastError = error;
      if (!new Set(["EBUSY", "EPERM", "ENOTEMPTY"]).has(error?.code)) throw error;
      await delay(100 * (attempt + 1));
    }
  }
  throw lastError;
}

test("live Copilot team-lead selects and orchestrates the Harbor SDLC cycle efficiently", {
  skip: liveRequested ? false : "opt-in: run npm run test:live:lead (this consumes model tokens)",
  timeout: 15 * 60_000,
}, async (t) => {
  const dataset = loadHarborCycleDataset();
  const cycle = dataset.cycles.find((candidate) => candidate.id === "full-sdlc")!;
  const expectedAgents = cycle.steps.map((step) => step.agent);
  const runtimeAgents = cycle.steps.map((step) =>
    dataset.roster.bundled.find((player) => player.id === step.agent)!.runtimeIds.copilot);
  const communicationBudget = {
    rootModelTurns: expectedAgents.length + 2,
    totalModelTurns: 36,
    totalToolCalls: 60,
    wallTimeMs: 180_000,
    maxChildToolCalls: 12,
    totalObservedTokens: 200_000,
    maxChildTokens: 35_000,
    delegatedPromptBytes: expectedAgents.length * 4_096,
    returnedEvidenceBytes: expectedAgents.length * 12_288,
    finalBytes: 6_144,
  } as const;
  const sandbox = await mkdtemp(join(tmpdir(), "harbor-live-lead-"));
  let sandboxRemoved = false;
  t.after(async () => {
    if (!sandboxRemoved) {
      await removeSandbox(sandbox);
      sandboxRemoved = true;
    }
  });
  const project = join(sandbox, "fixture");
  const isolatedHome = join(sandbox, "copilot-home");
  const acceptanceId = `AH-${randomBytes(8).toString("hex")}`;
  await Promise.all([
    mkdir(join(project, "src"), { recursive: true }),
    mkdir(join(project, "test"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(project, "package.json"), JSON.stringify({
      name: "agent-harbor-live-fixture", private: true, type: "module", scripts: { test: "node --test test/score.test.js" },
    }, null, 2), "utf8"),
    writeFile(join(project, "ACCEPTANCE.md"), [
      "# Bounded acceptance fixture", "", `Acceptance ID: ${acceptanceId}`,
      "", "Repair clampScore without changing its exported name.",
      "It must reject non-finite input and clamp finite values to the inclusive range 0..100.",
      "The operational management gate is `npm test`. Do not add dependencies or touch files outside this fixture.", "",
    ].join("\n"), "utf8"),
    writeFile(join(project, "src", "score.js"), [
      "export function clampScore(value) {", "  if (!Number.isFinite(value)) throw new TypeError(\"score must be finite\");",
      "  return Math.min(0, Math.max(100, value));", "}", "",
    ].join("\n"), "utf8"),
    writeFile(join(project, "test", "score.test.js"), [
      "import assert from \"node:assert/strict\";", "import test from \"node:test\";",
      "import { clampScore } from \"../src/score.js\";", "",
      "test(\"clamps finite scores and rejects non-finite input\", () => {",
      "  assert.equal(clampScore(-4), 0);", "  assert.equal(clampScore(42), 42);",
      "  assert.equal(clampScore(140), 100);", "  assert.throws(() => clampScore(Infinity), TypeError);", "});", "",
    ].join("\n"), "utf8"),
  ]);
  const previousHome = process.env.COPILOT_HOME;
  process.env.COPILOT_HOME = isolatedHome;
  try { await runDeterministicCommand("copilot", "bench", `on ${cycle.activate.join(" ")}`, project); }
  finally {
    if (previousHome === undefined) delete process.env.COPILOT_HOME;
    else process.env.COPILOT_HOME = previousHome;
  }
  await assert.rejects(() => runProcess(process.execPath, ["--test", "test/score.test.js"], project, 60_000), /process exited [1-9]/,
    "the bounded fixture must fail before team-lead dispatches implementation");

  const executable = await findCopilot();
  const cliVersion = (await runProcess(executable, ["--version"], root, 30_000)).stdout.trim().split(/\r?\n/)[0];
  const client = new CopilotClient({
    connection: RuntimeConnection.forStdio({
      path: executable,
      args: [
        "--experimental", "--no-auto-update", "--no-color", "--max-ai-credits", String(maxAiCredits),
        "--plugin-dir", join(plugins, "agent-foundry"),
        "--plugin-dir", join(plugins, "repo-cartographer"),
      ],
    }),
    workingDirectory: project,
    logLevel: "error",
    env: {
      ...cleanChildEnvironment(),
      CI: "1",
      NO_COLOR: "1",
      COPILOT_PLUGIN_DIR_ONLY: "true",
      OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT: "false",
    },
  });
  let session: Awaited<ReturnType<CopilotClient["createSession"]>> | undefined;
  const events: SessionEvent[] = [];
  const permissionAudit: PermissionAuditEntry[] = [];
  const permissionHandler = createFixturePermissionHandler(project, permissionAudit);
  const requestedSandboxConfig = {
    enabled: true,
    addCurrentWorkingDirectory: false,
    userPolicy: {
      filesystem: { readwritePaths: [project], clearPolicyOnExit: true },
      network: { allowOutbound: false, allowLocalNetwork: false },
    },
  };
  let calls: LiveCall[] = [];
  let usageMetrics: any;
  let finalContent = "";
  let inferenceDurationMs = 0;
  let sandboxPolicyRequestAttempted = false;
  let sandboxPolicyUpdateAcknowledged = false;
  let harborExtension: { id: string; name: string; source: string; status: string; pid?: number } | undefined;
  let benchCommandRegistered = false;
  let failure: unknown;
  try {
    const bypassCanaryDecision = await permissionHandler({
      canOfferSessionApproval: false,
      commands: [{ identifier: "npm", readOnly: false }],
      fullCommandText: "npm test",
      hasWriteFileRedirection: false,
      intention: "deterministically verify that an otherwise allowed command cannot bypass the sandbox",
      kind: "shell",
      possiblePaths: ["."],
      possibleUrls: [],
      requestSandboxBypass: true,
      requestSandboxBypassReason: "Agent Harbor acceptance canary",
    }, { sessionId: sandboxBypassCanarySessionId });
    assert.equal(bypassCanaryDecision.kind, "reject", "the deterministic sandbox-bypass canary was not rejected");
    await client.start();
    session = await client.createSession({
      workingDirectory: project,
      model,
      reasoningEffort: reasoningEffort as any,
      enableConfigDiscovery: true,
      requestExtensions: true,
      onPermissionRequest: permissionHandler,
      onEvent: (event) => { events.push(event); },
      enableSessionTelemetry: false,
      infiniteSessions: { enabled: false },
      skipCustomInstructions: true,
      customAgentsLocalOnly: true,
      coauthorEnabled: false,
      streaming: false,
      includeSubAgentStreamingEvents: false,
    });

    sandboxPolicyRequestAttempted = true;
    const sandboxUpdate = await session.rpc.options.update({ sandboxConfig: requestedSandboxConfig });
    assert.equal(sandboxUpdate.success, true, "Copilot did not apply the fixture sandbox policy");
    sandboxPolicyUpdateAcknowledged = true;

    for (let attempt = 0; attempt < 50; attempt += 1) {
      const extensionList = await session.rpc.extensions.list();
      const matchingExtensions = extensionList.extensions.filter((extension) =>
        extension.id === harborExtensionId &&
        extension.name === harborExtensionName &&
        extension.source === "plugin");
      assert.ok(matchingExtensions.length <= 1, "Agent Harbor extension was discovered more than once");
      harborExtension = matchingExtensions[0];
      if (harborExtension?.status === "running") break;
      assert.notEqual(harborExtension?.status, "failed", "Agent Harbor extension failed to start");
      assert.notEqual(harborExtension?.status, "disabled", "Agent Harbor extension is disabled");
      await delay(100);
    }
    assert.ok(harborExtension, "Agent Harbor extension was not discovered");
    assert.equal(harborExtension.status, "running", "Agent Harbor extension is not running");
    assert.ok((harborExtension.pid ?? 0) > 0, "Agent Harbor extension has no live process");

    const commands = await session.rpc.commands.list({
      includeBuiltins: false,
      includeSkills: false,
      includeClientCommands: true,
    });
    benchCommandRegistered = commands.commands.some((command) => command.name === "bench" && command.kind === "client");
    assert.equal(benchCommandRegistered, true, "running extension did not register the native /bench client command");

    const listed = await session.rpc.agent.reload();
    const lead = resolveCopilotPlayer("team-lead", listed.agents, project);
    assert.equal(lead.id, copilotFixedAgentIds.get("team-lead"));
    for (const id of cycle.activate) resolveCopilotPlayer(id, listed.agents, project);
    const selected = await session.rpc.agent.select({ name: lead.id });
    assert.equal(selected.agent.id, lead.id, "the live session did not select team-lead");

    const prompt = [
      "This is a live Agent Harbor acceptance task in the current bounded fixture.",
      "Complete all six required, distinct lifecycle gates below in dependency order. Select the active specialist whose published role exactly matches each gate; do not perform specialist work in the parent and do not use built-in or intermediate routers.",
      "The eligible specialists and their published roles are intentionally listed out of workflow order: dispose (Non-destructive disposition review), build (Focused construction), portfolio-management (Portfolio framing), consume (Consumer acceptance), manage (Operational management and verification), design (Solution design). Treat each published role as authoritative: each specialist may cover only its matching gate and must be used exactly once.",
      "Required gates: frame the fixture's portfolio outcome, scope, constraints, dependencies, acceptance criteria, and hidden acceptance ID without editing; design the smallest evidence-backed fix; build it; manage it by running the required operational verification; validate it from the consumer perspective with a read-only correctness, safety, usability, integration, acceptance, and coverage review; produce a non-destructive disposition record recommending keep, evolve, or eventual retirement and covering rollback, retention, and residual dependencies without undoing the fix.",
      "Mandatory state machine: portfolio-management -> design -> build -> manage -> consume -> dispose -> final synthesis. Keep a private monotonic gate_index initialized to 0. Call only the agent_type at that index; after every successful task result increment it exactly once and never decrement or reuse an ID, regardless of evidence content. At gate_index 6 all tools are forbidden: synthesize immediately and do not act on Dispose's recommendation. Never finalize at indices 0-5. On an actual task tool error, stop immediately and make no later tool call.",
      "Keep every gate inside ACCEPTANCE.md, src/score.js, and test/score.test.js; never use wildcard paths or unbounded exploration. When a native tool schema requires an absolute path, resolve only one of those three exact relative paths against the fixture root and never return the absolute form in evidence. Portfolio management uses one to three bounded read/search calls; design uses only the portfolio handoff and no tools; build uses one to three bounded reads, edits only src/score.js, and leaves test execution to manage; manage uses only the shell to run exactly npm test once; consume reads each of the three files exactly once; dispose uses only returned evidence and no tools, makes no changes, and leaves the fix intact.",
      "Use one synchronous task at a time and each eligible specialist exactly once. Give every child only its bounded gate, constraints, the immediately preceding handoff when one exists, and this completion contract:",
      "Copy this required child-output request literally into every child task: include the exact token HARBOR_HANDOFF:<your exact agent_type>:<acceptance ID> exactly once as a standalone final line, never quote, copy, or emit any predecessor's HARBOR_HANDOFF token, and keep the acceptance ID to at most three total occurrences. Keep all child evidence concise. If a successful child nevertheless omits the preferred diagnostic token, that gate is still consumed: never retry it.",
      "For gates 2-6, pass the immediately preceding evidence concisely. Copy its HARBOR_HANDOFF line at most once if present; a bounded paraphrase carrying the same acceptance ID is equally valid. Do not copy any older handoff or full child response.",
      "The acceptance ID exists only in the fixture; do not guess it. Native child identity and completion are authoritative. A duplicated or foreign handoff token is a failed gate; a missing preferred token alone is not. Stop without rewriting or retrying an actually failed gate. A marked risk or NO-GO result is valid evidence and never waives a later state. Manage is not the end: always dispatch Consume after Manage and Dispose after Consume. Calling Dispose is mandatory and non-destructive; it records a recommendation and does not retire or undo the change. Keep every delegated prompt under 4 KiB.",
      `After all gates pass, the first non-whitespace content in the final response must be exactly HARBOR_SEQUENCE:${expectedAgents.join(" -> ")}. Do not put a heading, Markdown delimiter, or preamble before it; then give a compact lifecycle conclusion.`,
      "Final invariant: six successful delegations means zero remaining tool calls. After the first successful Dispose result, write the final response immediately; never call Dispose or any other agent again.",
    ].join("\n");
    const inferenceStartedAt = Date.now();
    let response;
    try { response = await session.sendAndWait({ prompt }, communicationBudget.wallTimeMs); }
    finally { inferenceDurationMs = Date.now() - inferenceStartedAt; }
    finalContent = response?.data.content ?? "";
    assert.ok(finalContent, "team-lead returned no final synthesis");
    assert.ok(inferenceDurationMs <= communicationBudget.wallTimeMs, "orchestrated run exceeded its wall-time budget");

    calls = inspectCalls(events, runtimeAgents);
    const childToolStarts = events.filter((event) =>
      event.type === "tool.execution_start" && Boolean(event.agentId));
    const agentForChildTool = (event: SessionEvent): string =>
      calls.find((call) => call.childId === event.agentId)?.agent ?? "";
    const toolsFor = (agent: string) => childToolStarts.filter((event) => agentForChildTool(event) === agent);
    const targetFor = (event: Extract<SessionEvent, { type: "tool.execution_start" }>): string =>
      classifyLiveToolTarget(event.data.toolName, event.data.arguments, project);
    const portfolioTools = toolsFor("portfolio-management");
    assert.ok(portfolioTools.length >= 1 && portfolioTools.length <= 3,
      "portfolio-management must make between one and three bounded read/search calls");
    assert.ok(portfolioTools.every((event) => LIVE_FIXTURE_TOOL_TARGETS.includes(
      targetFor(event),
    )), `portfolio-management accessed a path outside the bounded fixture files: ${JSON.stringify(portfolioTools.map((event) => ({ tool: event.data.toolName, target: targetFor(event) })))}`);
    assert.equal(toolsFor("design").length, 0, "design used tools instead of the portfolio handoff");
    const buildTools = toolsFor("build");
    assert.ok(buildTools.length >= 2 && buildTools.length <= 4,
      "build must make a bounded read/edit sequence");
    const buildReads = buildTools.filter((event) => !new Set(["apply_patch", "edit", "write"]).has(event.data.toolName));
    assert.ok(buildReads.length >= 1 && buildReads.length <= 3,
      "build must make between one and three bounded reads before editing");
    assert.ok(buildReads.every((event) => LIVE_FIXTURE_TOOL_TARGETS.includes(
      targetFor(event),
    )), `build read outside the bounded fixture files: ${JSON.stringify(buildReads.map((event) => ({ tool: event.data.toolName, target: targetFor(event) })))}`);
    const mutations = childToolStarts.filter((event) => event.type === "tool.execution_start" &&
      new Set(["apply_patch", "edit", "write"]).has(event.data.toolName));
    assert.ok(mutations.length > 0, "build made no observed edit");
    assert.ok(mutations.every((event) => agentForChildTool(event) === "build"),
      "a non-build specialist edited the fixture");
    assert.equal(toolsFor("manage").length, 1, "manage must use only the single operational verification call");
    assert.equal(permissionAudit.filter((entry) =>
      entry.source === "runtime" && entry.kind === "shell" && entry.decision === "approved").length, 1,
    "the cycle must approve exactly one sandboxed npm test execution");
    const consumeTools = toolsFor("consume");
    assert.equal(consumeTools.length, 3, "consume must read exactly the three bounded acceptance files");
    assert.deepEqual(
      consumeTools.map(targetFor).sort(),
      [...LIVE_FIXTURE_TOOL_TARGETS].sort(),
      "consume did not read each bounded acceptance file exactly once",
    );
    const disposeTools = toolsFor("dispose");
    assert.equal(disposeTools.length, 0,
      "dispose used a tool instead of the returned handoff while assessing closure and end-of-life readiness");
    const markers = expectedAgents.map((agent) => `HARBOR_HANDOFF:${agent}:${acceptanceId}`);
    for (const [index, call] of calls.entries()) {
      const normalizedResult = withoutTrailingBlankLines(call.result);
      const markerOccurrences = occurrences(normalizedResult, markers[index]);
      assert.ok(markerOccurrences <= 1, `stage ${index + 1} duplicated its handoff marker`);
      assert.equal(markers.reduce((total, marker) => total + occurrences(normalizedResult, marker), 0), markerOccurrences,
        `stage ${index + 1} returned a stale or additional handoff marker`);
      const resultHiddenIdOccurrences = occurrences(normalizedResult, acceptanceId);
      assert.ok(resultHiddenIdOccurrences >= (index === expectedAgents.length - 1 ? 0 : 1) && resultHiddenIdOccurrences <= 3,
        `stage ${index + 1} returned an inefficient hidden-ID count`);
      assert.ok(utf8Bytes(call.result) <= communicationBudget.returnedEvidenceBytes / expectedAgents.length,
        `stage ${index + 1} returned excessive evidence`);
      if (index === 0) {
        assert.equal(call.prompt.includes(acceptanceId), false, "lead knew the hidden acceptance ID before discovery");
      } else {
        const hiddenIdOccurrences = occurrences(call.prompt, acceptanceId);
        assert.ok(hiddenIdOccurrences >= 1 && hiddenIdOccurrences <= 3,
          `stage ${index + 1} did not receive bounded hidden handoff evidence`);
        assert.ok(occurrences(call.prompt, markers[index - 1]) <= 1,
          `stage ${index + 1} duplicated its immediate handoff`);
        const previousResult = withoutTrailingBlankLines(calls[index - 1].result);
        if (foldMarkdownWrappedText(previousResult) !== markers[index - 1]) {
          assert.equal(foldMarkdownWrappedText(call.prompt).includes(foldMarkdownWrappedText(previousResult)), false,
            `stage ${index + 1} copied the predecessor's complete response`);
        }
        for (let prior = 0; prior < index - 1; prior += 1) {
          assert.equal(call.prompt.includes(markers[prior]), false, `stage ${index + 1} duplicated stale handoff evidence`);
        }
      }
    }

    const extensionLoaded = events.filter((event) => event.type === "session.extensions_loaded")
      .flatMap((event) => event.type === "session.extensions_loaded" ? event.data.extensions : [])
      .filter((extension) => extension.id === harborExtension?.id &&
        extension.name === harborExtensionName && extension.source === "plugin" && extension.status === "running");
    assert.equal(extensionLoaded.length, 1, "native events did not confirm one running Agent Harbor extension");

    const preToolStarts = events.filter((event) => event.type === "hook.start" && event.data.hookType === "preToolUse");
    assert.ok(preToolStarts.length >= calls.length, "native runtime emitted too few preToolUse hook starts");
    for (const start of preToolStarts) {
      if (start.type !== "hook.start") throw new Error("unreachable hook event type");
      const endings = events.filter((event) => event.type === "hook.end" &&
        event.data.hookInvocationId === start.data.hookInvocationId);
      assert.equal(endings.length, 1, "a native preToolUse hook did not terminate exactly once");
      assert.equal(endings[0].type === "hook.end" && endings[0].data.success, true, "a native preToolUse hook failed");
    }

    let guardEvidenceEvents = events.filter((event) => event.type === "session.info" &&
      event.data.infoType === "agent-harbor-guard");
    for (let attempt = 0; guardEvidenceEvents.length < calls.length && attempt < 50; attempt += 1) {
      await delay(100);
      guardEvidenceEvents = events.filter((event) => event.type === "session.info" &&
        event.data.infoType === "agent-harbor-guard");
    }
    assert.equal(guardEvidenceEvents.length, calls.length, "Agent Harbor guard did not emit one approval proof per delegation");
    const guardEvidence = guardEvidenceEvents.map((event) => {
      if (event.type !== "session.info") throw new Error("unreachable guard evidence event type");
      return JSON.parse(event.data.message) as any;
    });
    for (const [index, call] of calls.entries()) {
      const matching = guardEvidence.filter((evidence) => evidence.invocationId === call.toolCallId);
      assert.equal(matching.length, 1, `stage ${index + 1} did not have exactly one correlated guard proof`);
      const evidence = matching[0];
      assert.equal(evidence.schema, "agent-harbor/evidence@1", `stage ${index + 1} guard evidence schema mismatch`);
      assert.equal(evidence.source, "adapter-hook", `stage ${index + 1} guard evidence source mismatch`);
      assert.equal(evidence.basis, "observed", `stage ${index + 1} guard evidence was not observed`);
      assert.equal(evidence.phase, "target.resolved", `stage ${index + 1} guard evidence phase mismatch`);
      assert.equal(evidence.harness, "copilot", `stage ${index + 1} guard evidence harness mismatch`);
      assert.equal(evidence.agent, expectedAgents[index], `stage ${index + 1} logical guard target mismatch`);
      assert.equal(evidence.runtimeAgent, runtimeAgents[index], `stage ${index + 1} runtime guard target mismatch`);
      assert.equal(evidence.outcome, "ok", `stage ${index + 1} guard did not approve its target`);
      assert.deepEqual(evidence.task, {
        sha256: sha256(call.prompt.trim()),
        utf8Bytes: utf8Bytes(call.prompt.trim()),
      }, `stage ${index + 1} guard proof did not fingerprint its exact prompt`);
    }

    assert.ok(occurrences(finalContent, acceptanceId) <= 3, "final synthesis repeated the hidden acceptance ID excessively");
    const sequenceLine = /^\s*HARBOR_SEQUENCE:\s*([^\r\n]+)/u.exec(finalContent)?.[1] ?? "";
    const reportedAgents = sequenceLine.match(new RegExp(`\\b(?:${expectedAgents.join("|")})\\b`, "g")) ?? [];
    assert.deepEqual(reportedAgents, expectedAgents, "final synthesis did not report the observed sequence exactly");
    assert.ok(utf8Bytes(finalContent) <= communicationBudget.finalBytes, "team-lead final synthesis is not compact");
    const usageEvents = events.filter((event) => event.type === "assistant.usage");
    const turnStarts = events.filter((event) => event.type === "assistant.turn_start");
    const turnEnds = events.filter((event) => event.type === "assistant.turn_end");
    const rootUsage = events.filter((event) => event.type === "assistant.usage" && !event.agentId);
    const rootTurnStarts = turnStarts.filter((event) => !event.agentId);
    const rootTurnEnds = turnEnds.filter((event) => !event.agentId);
    const rootUsageSummary = summarizeUsage(rootUsage);
    assert.ok(rootUsage.length > 0, "live lead emitted no model usage event");
    assert.equal(rootTurnStarts.length, rootTurnEnds.length, "lead turn starts and ends did not match");
    assert.equal(rootTurnStarts.length, rootUsage.length, "lead turns and usage events did not match");
    assert.ok(rootTurnStarts.length <= communicationBudget.rootModelTurns, "lead used redundant model turns");
    assert.ok(rootUsage.some((event) => event.type === "assistant.usage" &&
      ((event.data.inputTokens ?? 0) + (event.data.outputTokens ?? 0)) > 0), "lead usage contained no tokens");
    assert.equal(turnStarts.length, turnEnds.length, "total model turn starts and ends did not match");
    assert.equal(turnStarts.length, usageEvents.length, "total model turns and usage events did not match");
    assert.ok(turnStarts.length <= communicationBudget.totalModelTurns, "orchestrated run exceeded its total model-turn budget");
    const knownChildIds = new Set(calls.map((call) => call.childId));
    assert.equal([...turnStarts, ...turnEnds, ...usageEvents]
      .some((event) => event.agentId && !knownChildIds.has(event.agentId)), false,
    "native model events included an uncorrelated child");
    const totalObservedTokens = Math.max(
      summarizeUsage(usageEvents).totalTokens,
      rootUsageSummary.totalTokens + calls.reduce((sum, call) => sum + observedChildTokens(events, call), 0),
    );
    assert.ok(totalObservedTokens <= communicationBudget.totalObservedTokens,
      "orchestrated run exceeded its conservative observed-token budget");
    const totalToolCalls = events.filter((event) => event.type === "tool.execution_start").length;
    assert.ok(totalToolCalls <= communicationBudget.totalToolCalls, "orchestrated run exceeded its total tool-call budget");
    assert.ok(calls.reduce((sum, call) => sum + utf8Bytes(call.prompt), 0) <= communicationBudget.delegatedPromptBytes,
      "orchestrated run exceeded its delegated-prompt byte budget");
    assert.ok(calls.reduce((sum, call) => sum + utf8Bytes(call.result), 0) <= communicationBudget.returnedEvidenceBytes,
      "orchestrated run exceeded its returned-evidence byte budget");
    for (const [index, call] of calls.entries()) {
      const childStarts = turnStarts.filter((event) => event.agentId === call.childId).length;
      const childEnds = turnEnds.filter((event) => event.agentId === call.childId).length;
      const childUsage = childUsageEvents(events, call).length;
      assert.ok(childUsage > 0, `stage ${index + 1} emitted no correlated native usage event`);
      assert.equal(childStarts, childEnds, `stage ${index + 1} turn starts and ends did not match`);
      assert.equal(childStarts, childUsage, `stage ${index + 1} turns and usage events did not match`);
      const childTokens = observedChildTokens(events, call);
      assert.ok(childTokens > 0, `stage ${index + 1} recorded no model tokens`);
      assert.ok(childTokens <= communicationBudget.maxChildTokens, `stage ${index + 1} exceeded its child token budget`);
      assert.ok((call.totalToolCalls ?? Number.POSITIVE_INFINITY) <= communicationBudget.maxChildToolCalls,
        `stage ${index + 1} exceeded its child tool-call budget`);
    }
    usageMetrics = await session.rpc.usage.getMetrics();
    const metricTokens = Object.values(usageMetrics.modelMetrics).reduce((sum, metric) =>
      sum + (metric?.usage.inputTokens ?? 0) + (metric?.usage.outputTokens ?? 0), 0);
    assert.ok(metricTokens > 0, "session usage metrics recorded no model tokens");
    const runtimePermissionAudit = permissionAudit.filter((entry) => entry.source === "runtime");
    assert.ok(runtimePermissionAudit.length > 0, "live execution emitted no runtime permission decisions");
    const bypassCanaryAudit = permissionAudit.filter((entry) => entry.source === "sandbox-bypass-canary");
    assert.deepEqual(bypassCanaryAudit, [{
      decision: "rejected", kind: "shell", sandboxBypassRequested: true, source: "sandbox-bypass-canary",
    }], "sandbox-bypass rejection was not proven by exactly one deterministic canary");
    assert.equal(permissionAudit.some((entry) => entry.sandboxBypassRequested && entry.decision === "approved"), false,
      "a sandbox bypass request was approved");
    await runProcess(process.execPath, ["--test", "test/score.test.js"], project, 60_000);
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    const cleanupErrors: Error[] = [];
    if (session) {
      try { await client.deleteSession(session.sessionId); }
      catch (error) { cleanupErrors.push(error instanceof Error ? error : new Error(String(error))); }
    }
    try {
      cleanupErrors.push(...await client.stop());
    } catch (error) {
      cleanupErrors.push(error instanceof Error ? error : new Error(String(error)));
    }
    try {
      await removeSandbox(sandbox);
      sandboxRemoved = true;
    } catch (error) {
      cleanupErrors.push(error instanceof Error ? error : new Error(String(error)));
    }
    const usageEvents = events.filter((event) => event.type === "assistant.usage");
    const turnStartEvents = events.filter((event) => event.type === "assistant.turn_start");
    const rootUsageEvents = usageEvents.filter((event) => !event.agentId);
    const childTokenObservations = calls.map((call) => observedChildTokens(events, call));
    const nativeChildIds = [...new Set(usageEvents.map((event) => event.agentId).filter(Boolean))] as string[];
    const nativeChildTokenObservations = nativeChildIds.map((agentId) => summarizeUsage(
      usageEvents.filter((event) => event.agentId === agentId),
    ).totalTokens);
    const totalObservedTokens = Math.max(
      summarizeUsage(usageEvents).totalTokens,
      summarizeUsage(rootUsageEvents).totalTokens + childTokenObservations.reduce((sum, tokens) => sum + tokens, 0),
    );
    const runtimePermissionAudit = permissionAudit.filter((entry) => entry.source === "runtime");
    const canaryPermissionAudit = permissionAudit.filter((entry) => entry.source === "sandbox-bypass-canary");
    const eventCounts = Object.fromEntries([...new Set(events.map((event) => event.type))].sort().map((type) => [
      type, events.filter((event) => event.type === type).length,
    ]));
    const taskAttempts = events
      .filter((event) => event.type === "tool.execution_start" && !event.agentId && event.data.toolName === "task")
      .map((event, index) => {
        if (event.type !== "tool.execution_start") throw new Error("unreachable event type");
        const args = event.data.arguments ?? {};
        const prompt = typeof args.prompt === "string" ? args.prompt : "";
        const terminal = events.find((candidate) => candidate.type === "tool.execution_complete" &&
          !candidate.agentId && candidate.data.toolCallId === event.data.toolCallId);
        const result = terminal?.type === "tool.execution_complete" ? terminal.data.result?.content ?? "" : "";
        const error = terminal?.type === "tool.execution_complete" ? terminal.data.error?.message ?? "" : "";
        const agent = typeof args.agent_type === "string" ? args.agent_type : "";
        const expectedMarker = agent ? `HARBOR_HANDOFF:${agent}:${acceptanceId}` : "";
        const previousMarker = index > 0 && expectedAgents[index - 1]
          ? `HARBOR_HANDOFF:${expectedAgents[index - 1]}:${acceptanceId}`
          : "";
        const normalizedResult = withoutTrailingBlankLines(result);
        return {
          agent,
          invocationSha256: sha256(event.data.toolCallId),
          prompt: { sha256: sha256(prompt), utf8Bytes: utf8Bytes(prompt) },
          promptHandoff: {
            hiddenIdOccurrences: occurrences(prompt, acceptanceId),
            immediateTokenOccurrences: previousMarker ? occurrences(prompt, previousMarker) : 0,
          },
          success: terminal?.type === "tool.execution_complete" ? terminal.data.success : undefined,
          evidence: result ? { sha256: sha256(result), utf8Bytes: utf8Bytes(result) } : undefined,
          handoff: result && expectedMarker ? {
            exactOccurrences: occurrences(result, expectedMarker),
            allCycleMarkerOccurrences: expectedAgents.reduce((total, candidate) =>
              total + occurrences(result, `HARBOR_HANDOFF:${candidate}:${acceptanceId}`), 0),
            hiddenIdOccurrences: occurrences(result, acceptanceId),
            transportedExactlyOnce: occurrences(result, expectedMarker) === 1,
            standaloneFinalLine: normalizedResult.split("\n").at(-1) === expectedMarker,
          } : undefined,
          error: error ? { sha256: sha256(error), utf8Bytes: utf8Bytes(error) } : undefined,
        };
      });
    const report = {
      schema: "agent-harbor/live-team-lead@2",
      status: failure || cleanupErrors.length ? "failed" : "passed",
      generatedAt: new Date().toISOString(),
      harness: "copilot",
      cliVersion,
      model,
      reasoningEffort,
      maxAiCredits,
      coordinator: copilotFixedAgentIds.get("team-lead"),
      expectedAgents,
      security: {
        sandboxPolicy: {
          requestAttempted: sandboxPolicyRequestAttempted,
          updateAcknowledged: sandboxPolicyUpdateAcknowledged,
          requested: {
            enabled: requestedSandboxConfig.enabled,
            addCurrentWorkingDirectory: requestedSandboxConfig.addCurrentWorkingDirectory,
            filesystemReadwritePathCount: requestedSandboxConfig.userPolicy.filesystem.readwritePaths.length,
            clearFilesystemPolicyOnExit: requestedSandboxConfig.userPolicy.filesystem.clearPolicyOnExit,
            networkAllowOutbound: requestedSandboxConfig.userPolicy.network.allowOutbound,
            networkAllowLocalNetwork: requestedSandboxConfig.userPolicy.network.allowLocalNetwork,
          },
        },
        extension: harborExtension ? {
          id: harborExtension.id,
          name: harborExtension.name,
          source: harborExtension.source,
          status: harborExtension.status,
          liveProcess: (harborExtension.pid ?? 0) > 0,
        } : undefined,
        benchCommandRegistered,
        guardApprovalProofs: events.filter((event) => event.type === "session.info" &&
          event.data.infoType === "agent-harbor-guard").length,
        permissions: {
          runtime: {
            decisions: runtimePermissionAudit.length,
            approved: decisionCounts(runtimePermissionAudit, "approved"),
            rejected: decisionCounts(runtimePermissionAudit, "rejected"),
            sandboxBypassRequests: runtimePermissionAudit.filter((entry) => entry.sandboxBypassRequested).length,
            sandboxBypassApprovals: runtimePermissionAudit.filter((entry) =>
              entry.sandboxBypassRequested && entry.decision === "approved").length,
          },
          syntheticHandlerCanary: {
            requests: canaryPermissionAudit.length,
            bypassRequests: canaryPermissionAudit.filter((entry) => entry.sandboxBypassRequested).length,
            approvals: canaryPermissionAudit.filter((entry) => entry.decision === "approved").length,
            rejections: canaryPermissionAudit.filter((entry) => entry.decision === "rejected").length,
          },
        },
      },
      eventCounts,
      taskAttempts,
      observedAgents: events
        .filter((event) => event.type === "subagent.started")
        .map((event) => event.type === "subagent.started" ? event.data.agentName : ""),
      maxConcurrentChildren: maxConcurrentChildren(events),
      calls: calls.map((call) => ({
        agent: call.agent,
        invocationSha256: sha256(call.toolCallId),
        childSha256: sha256(call.childId),
        prompt: { sha256: sha256(call.prompt), utf8Bytes: utf8Bytes(call.prompt) },
        evidence: { sha256: sha256(call.result), utf8Bytes: utf8Bytes(call.result) },
        durationMs: call.durationMs,
        totalTokens: call.totalTokens,
        observedTokens: observedChildTokens(events, call),
        totalToolCalls: call.totalToolCalls,
      })),
      communicationEfficiency: {
        scope: "routing, immediate handoff, and bounded run resources",
        budgets: communicationBudget,
        observed: {
          rootModelTurns: turnStartEvents.filter((event) => !event.agentId).length,
          totalModelTurns: turnStartEvents.length,
          totalToolCalls: events.filter((event) => event.type === "tool.execution_start").length,
          wallTimeMs: inferenceDurationMs,
          totalObservedTokens,
          maxChildTokens: [...childTokenObservations, ...nativeChildTokenObservations]
            .reduce((maximum, tokens) => Math.max(maximum, tokens), 0),
          maxChildToolCalls: calls.reduce((maximum, call) => Math.max(maximum, call.totalToolCalls ?? 0), 0),
          delegatedPromptBytes: taskAttempts.reduce((sum, attempt) => sum + attempt.prompt.utf8Bytes, 0),
          returnedEvidenceBytes: taskAttempts.reduce((sum, attempt) => sum + (attempt.evidence?.utf8Bytes ?? 0), 0),
          finalBytes: utf8Bytes(finalContent),
        },
      },
      nativeUsage: {
        root: summarizeUsage(rootUsageEvents),
        children: summarizeUsage(usageEvents.filter((event) => Boolean(event.agentId))),
        total: summarizeUsage(usageEvents),
      },
      sessionMetrics: usageMetrics ? {
        totalPremiumRequestCost: usageMetrics.totalPremiumRequestCost,
        totalUserRequests: usageMetrics.totalUserRequests,
        totalApiDurationMs: usageMetrics.totalApiDurationMs,
        modelMetrics: usageMetrics.modelMetrics,
      } : undefined,
      final: finalContent ? { sha256: sha256(finalContent), utf8Bytes: utf8Bytes(finalContent) } : undefined,
      failure: failure instanceof Error ? {
        name: failure.name,
        messageSha256: sha256(failure.message),
        messageUtf8Bytes: utf8Bytes(failure.message),
      } : undefined,
      cleanup: cleanupErrors.length ? cleanupErrors.map((error) => ({
        name: error.name,
        messageSha256: sha256(error.message),
        messageUtf8Bytes: utf8Bytes(error.message),
      })) : undefined,
    };
    await writeReport(report);
    if (!failure && cleanupErrors.length) throw new AggregateError(cleanupErrors, "Copilot live smoke cleanup failed");
  }
});
