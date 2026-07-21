import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, copyFile, lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  LIVE_CODEX_COMMUNICATION_BUDGET,
  LIVE_CODEX_REPORT_SCHEMA,
  assertLifecycleFingerprints,
  assertLifecycleModels,
  assertLifecyclePairs,
  assertNoLifecycleFailures,
  assertNoRawValues,
  assertLiveCodexFinal,
  assertLiveCodexFixtureShape,
  createLiveCodexFixture,
  liveCodexExpectedAgents,
  parseLifecycleEvidence,
  removeLiveCodexSandbox,
  sanitizeError,
  sanitizeValue,
  sha256,
  type LiveCodexHarness,
  type LiveLifecycleRecord,
} from "./support/live-codex-cycle.js";
import { LIVE_FIXTURE_TOOL_TARGETS } from "./support/live-tool-targets.mjs";

const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const preferredModel = "gpt-5.3-codex-spark";
const fallbackModel = "gpt-5.6-luna";
const expectedAgents = liveCodexExpectedAgents();
const liveRequested = process.env.AGENT_HARBOR_LIVE_CODEX === "1";
const requestedHarness = process.env.AGENT_HARBOR_LIVE_HARNESS ?? "all";
const selectedHarnesses: readonly LiveCodexHarness[] = requestedHarness === "all"
  ? ["opencode", "pi"]
  : requestedHarness === "opencode" || requestedHarness === "pi" ? [requestedHarness] : [];
const outputLimit = 16 * 1024 * 1024;

interface ProcessResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly timedOut: boolean;
}

interface HarnessRun {
  readonly provider: string;
  readonly model: string;
  readonly fallbackUsed: boolean;
  readonly reasoning: string;
  readonly version: string;
  readonly finalText: string;
  readonly traceText: string;
  readonly durationMs: number;
  readonly rootSessionCleaned: boolean;
  readonly rosterCleaned: boolean;
}

function cleanEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...overrides, CI: "1", NO_COLOR: "1" };
  for (const key of [
    "NODE_TEST_CONTEXT", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN",
    "AZURE_OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "OPENROUTER_API_KEY",
    "AI_GATEWAY_API_KEY", "GROQ_API_KEY", "CEREBRAS_API_KEY", "XAI_API_KEY",
    "DEEPSEEK_API_KEY", "MISTRAL_API_KEY", "TOGETHER_API_KEY", "FIREWORKS_API_KEY",
  ]) delete env[key];
  return env;
}

async function executable(path: string): Promise<boolean> {
  try { await access(path, constants.X_OK); return true; }
  catch { return false; }
}

async function findGlobalPackage(name: string): Promise<string> {
  const override = name.includes("pi-coding-agent")
    ? process.env.PI_CODING_AGENT_PACKAGE_ROOT?.trim()
    : undefined;
  const candidates = [
    ...(override ? [override] : []),
    ...(process.env.PATH ?? "").split(delimiter).filter(Boolean).map((directory) => join(directory, "node_modules", ...name.split("/"))),
  ];
  for (const candidate of candidates) {
    try { await access(join(candidate, "package.json")); return candidate; }
    catch { /* keep searching */ }
  }
  throw new Error(`required global package is not installed: ${name}`);
}

async function findOpenCode(): Promise<string> {
  const override = process.env.OPENCODE_CLI_PATH?.trim();
  if (override && await executable(override)) return override;
  const suffixes = process.platform === "win32" ? [".exe", ".com"] : [""];
  const directories = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  for (const directory of directories) {
    for (const suffix of suffixes) {
      const direct = join(directory, `opencode${suffix}`);
      if (await executable(direct)) return direct;
      const npmPackage = join(directory, "node_modules", "opencode-ai", "bin", `opencode${suffix}`);
      if (await executable(npmPackage)) return npmPackage;
    }
  }
  throw new Error("authenticated OpenCode CLI executable was not found");
}

function processFailure(label: string, result: ProcessResult): Error {
  return new Error(`${label} failed: exit=${String(result.code)} signal=${String(result.signal)} stdout=${sha256(result.stdout)} stderr=${sha256(result.stderr)}`);
}

async function runProcess(
  label: string,
  command: string,
  args: readonly string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; input?: string; timeoutMs?: number; allowNonZero?: boolean },
): Promise<ProcessResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const started = Date.now();
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: cleanEnvironment(options.env),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let overflow = false;
    let timedOut = false;
    const collect = (target: "stdout" | "stderr", chunk: string): void => {
      if (overflow) return;
      if (target === "stdout") stdout += chunk; else stderr += chunk;
      if (Buffer.byteLength(stdout, "utf8") + Buffer.byteLength(stderr, "utf8") > outputLimit) {
        overflow = true;
        child.kill();
      }
    };
    child.stdout.setEncoding("utf8").on("data", (chunk) => collect("stdout", chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => collect("stderr", chunk));
    child.once("error", rejectPromise);
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, options.timeoutMs ?? 60_000);
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      const result = { code, signal, stdout, stderr, durationMs: Date.now() - started, timedOut };
      if (overflow) rejectPromise(new Error(`${label} exceeded its bounded output limit`));
      else if (!options.allowNonZero && (code !== 0 || signal)) rejectPromise(processFailure(label, result));
      else resolvePromise(result);
    });
    if (options.input !== undefined) child.stdin.end(options.input); else child.stdin.end();
  });
}

interface OpenCodeListedSession {
  readonly id: string;
  readonly title: string;
  readonly directory: string;
}

async function listOpenCodeSessions(
  cli: string,
  project: string,
  env: NodeJS.ProcessEnv,
): Promise<OpenCodeListedSession[]> {
  const result = await runProcess(
    "OpenCode session inventory",
    cli,
    ["session", "list", "--pure", "--format", "json"],
    { cwd: project, env, timeoutMs: 30_000 },
  );
  const parsed: unknown = JSON.parse(result.stdout);
  assert.ok(Array.isArray(parsed), "OpenCode session inventory is not an array");
  return parsed.map((entry, index) => {
    assert.ok(entry && typeof entry === "object" && !Array.isArray(entry), `OpenCode session ${index + 1} is invalid`);
    const value = entry as Record<string, unknown>;
    assert.equal(typeof value.id, "string");
    assert.equal(typeof value.title, "string");
    assert.equal(typeof value.directory, "string");
    return { id: value.id, title: value.title, directory: value.directory };
  });
}

async function cleanupOpenCodeRunSessions(
  cli: string,
  project: string,
  env: NodeJS.ProcessEnv,
  before: readonly OpenCodeListedSession[],
): Promise<void> {
  const beforeIds = new Set(before.map((session) => session.id));
  const target = process.platform === "win32" ? resolve(project).toLowerCase() : resolve(project);
  const after = await listOpenCodeSessions(cli, project, env);
  const created = after.filter((session) => !beforeIds.has(session.id));
  const owned = created.filter((session) => {
    const directory = process.platform === "win32" ? resolve(session.directory).toLowerCase() : resolve(session.directory);
    return directory === target && (/^Agent Harbor live [a-f0-9]{12}$/u.test(session.title) || /^Harbor agent: [a-z0-9][a-z0-9-]{0,47}$/u.test(session.title));
  });
  assert.equal(owned.length, created.length, "OpenCode created an unrecognized session; cleanup refused");
  for (const session of owned) {
    await runProcess(
      "OpenCode owned session cleanup",
      cli,
      ["session", "delete", session.id, "--pure"],
      { cwd: project, env, timeoutMs: 30_000 },
    );
  }
  const remaining = await listOpenCodeSessions(cli, project, env);
  assert.equal(remaining.some((session) => owned.some((candidate) => candidate.id === session.id)), false,
    "OpenCode left an owned live session behind");
}

function chooseModel(catalog: string, provider: string): { model: string; fallbackUsed: boolean } {
  const models = new Set(catalog.split(/\r?\n/gu).flatMap((line) => {
    const trimmed = line.trim();
    if (!trimmed) return [];
    const columns = trimmed.split(/\s+/u);
    if (columns.length >= 2 && columns[0] === provider) return [`${columns[0]}/${columns[1]}`];
    return [columns[0]];
  }));
  if (models.has(`${provider}/${preferredModel}`)) return { model: preferredModel, fallbackUsed: false };
  if (models.has(`${provider}/${fallbackModel}`)) return { model: fallbackModel, fallbackUsed: true };
  throw new Error(`neither preferred nor fallback Codex model is present for ${provider}`);
}

function jsonLines(value: string): Record<string, any>[] {
  return value.split(/\r?\n/gu).filter((line) => line.trim()).map((line, index) => {
    try { return JSON.parse(line); }
    catch (error) { throw new Error(`invalid JSONL output at line ${index + 1}`, { cause: error }); }
  });
}

function finalOpenCodeText(stdout: string): { text: string; sessionId: string } {
  const events = jsonLines(stdout);
  const textEvents = events.filter((event) => event.type === "text");
  const finalMessageId = textEvents.map((event) => event.part?.messageID ?? event.messageID).filter(Boolean).at(-1);
  const finalEvents = finalMessageId
    ? textEvents.filter((event) => (event.part?.messageID ?? event.messageID) === finalMessageId)
    : textEvents.slice(-1);
  const text = finalEvents
    .map((event) => event.part?.text ?? event.text ?? "")
    .filter((value) => typeof value === "string")
    .join("");
  const sessionId = events.map((event) => event.sessionID ?? event.part?.sessionID).find((value) => typeof value === "string");
  assert.ok(text.trim(), "OpenCode returned no final text event");
  assert.ok(sessionId, "OpenCode returned no root session ID");
  return { text, sessionId };
}

async function activateCycle(harness: LiveCodexHarness, project: string, env: NodeJS.ProcessEnv): Promise<void> {
  await runProcess(
    `${harness} deterministic bench activation`,
    process.execPath,
    [join(root, "dist", "cli.js"), harness, "bench", "on", "all"],
    { cwd: project, env, timeoutMs: 30_000 },
  );
}

async function deactivateCycle(harness: LiveCodexHarness, project: string, env: NodeJS.ProcessEnv): Promise<void> {
  await runProcess(
    `${harness} deterministic bench cleanup`,
    process.execPath,
    [join(root, "dist", "cli.js"), harness, "bench", "off", "all"],
    { cwd: project, env, timeoutMs: 30_000 },
  );
}

async function removeHarnessRuntimeArtifacts(harness: LiveCodexHarness, project: string): Promise<void> {
  const directoryName = harness === "opencode" ? ".opencode" : ".pi";
  const projectRoot = resolve(project);
  const target = resolve(project, directoryName);
  assert.equal(target, join(projectRoot, directoryName), `${harness} runtime artifact path escaped the fixture`);
  try {
    const info = await lstat(target);
    assert.equal(info.isSymbolicLink(), false, `${harness} runtime artifact root is a symbolic link`);
    assert.equal(info.isDirectory(), true, `${harness} runtime artifact root is not a directory`);
    await rm(target, { recursive: true, force: false, maxRetries: 5, retryDelay: 50 });
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function runOpenCode(
  project: string,
  sandbox: string,
  acceptanceId: string,
  prompt: string,
): Promise<HarnessRun> {
  const cli = await findOpenCode();
  const configDir = join(sandbox, "opencode-home");
  const tracePath = join(sandbox, "opencode-trace.jsonl");
  await mkdir(configDir, { recursive: true });
  const baseEnv = { OPENCODE_CONFIG_DIR: configDir };
  // OpenCode's local store is single-writer; even read-only CLI preflights are serialized.
  const versionResult = await runProcess("OpenCode version preflight", cli, ["--version"], { cwd: project, env: baseEnv, timeoutMs: 30_000 });
  const authResult = await runProcess("OpenCode auth preflight", cli, ["auth", "list"], { cwd: project, env: baseEnv, timeoutMs: 30_000 });
  const catalogResult = await runProcess("OpenCode model catalog preflight", cli, ["models", "openai"], { cwd: project, env: baseEnv, timeoutMs: 30_000 });
  assert.match(authResult.stdout, /OpenAI/iu, "OpenCode has no OpenAI OAuth authentication");
  const selection = chooseModel(catalogResult.stdout, "openai");
  const plugin = `file:${root}`;
  const observer = pathToFileURL(join(root, "test-ts", "support", "live-opencode-observer.mjs")).href;
  const config = {
    $schema: "https://opencode.ai/config.json",
    model: `openai/${selection.model}`,
    plugin: [plugin, observer],
    permission: {
      "*": "deny",
      read: "allow",
      glob: "allow",
      grep: "allow",
      list: "allow",
      edit: "allow",
      bash: { "*": "deny", "npm test": "allow", "npm.cmd test": "allow" },
      external_directory: "deny",
      harbor_delegate: "allow",
    },
  };
  const env = {
    ...baseEnv,
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
    AGENT_HARBOR_LIVE_TRACE_FILE: tracePath,
    AGENT_HARBOR_LIVE_NONCE: acceptanceId,
  };
  await activateCycle("opencode", project, env);
  const sessionsBefore = await listOpenCodeSessions(cli, project, baseEnv);
  const result = await runProcess(
    "OpenCode live team-lead",
    cli,
    [
      "run", "--dir", project, "--command", "team-lead", "--model", `openai/${selection.model}`,
      "--variant", "medium", "--format", "json", "--title", `Agent Harbor live ${sha256(acceptanceId).slice(0, 12)}`,
      prompt,
    ],
    { cwd: project, env, timeoutMs: LIVE_CODEX_COMMUNICATION_BUDGET.wallTimeMs, allowNonZero: true },
  );
  await cleanupOpenCodeRunSessions(cli, project, baseEnv, sessionsBefore);
  if (result.code !== 0 || result.signal) throw processFailure("OpenCode live team-lead", result);
  const final = finalOpenCodeText(result.stdout);
  await deactivateCycle("opencode", project, env);
  await removeHarnessRuntimeArtifacts("opencode", project);
  return {
    provider: "openai",
    model: selection.model,
    fallbackUsed: selection.fallbackUsed,
    reasoning: "medium",
    version: versionResult.stdout.trim().split(/\r?\n/u)[0] ?? "unknown",
    finalText: final.text,
    traceText: await readFile(tracePath, "utf8"),
    durationMs: result.durationMs,
    rootSessionCleaned: true,
    rosterCleaned: true,
  };
}

async function runPi(
  project: string,
  sandbox: string,
  acceptanceId: string,
  prompt: string,
): Promise<HarnessRun> {
  const packageRoot = await findGlobalPackage("@earendil-works/pi-coding-agent");
  const cli = join(packageRoot, "dist", "cli.js");
  const configDir = join(sandbox, "pi-home");
  const tracePath = join(sandbox, "pi-trace.jsonl");
  await mkdir(configDir, { recursive: true });
  const sourceAuth = join(homedir(), ".pi", "agent", "auth.json");
  const auth = JSON.parse(await readFile(sourceAuth, "utf8"));
  assert.ok(auth["openai-codex"], "Pi has no OpenAI Codex OAuth authentication");
  await copyFile(sourceAuth, join(configDir, "auth.json"));
  const baseEnv = { PI_CODING_AGENT_DIR: configDir, PI_OFFLINE: "1", PI_TELEMETRY: "0" };
  const [versionResult, catalogResult] = await Promise.all([
    runProcess("Pi version preflight", process.execPath, [cli, "--version"], { cwd: project, env: baseEnv, timeoutMs: 30_000 }),
    runProcess("Pi model catalog preflight", process.execPath, [cli, "--offline", "--list-models", "gpt-5"], { cwd: project, env: baseEnv, timeoutMs: 30_000 }),
  ]);
  const selection = chooseModel(catalogResult.stdout, "openai-codex");
  const env = {
    ...baseEnv,
    AGENT_HARBOR_PI_PACKAGE_ROOT: packageRoot,
    AGENT_HARBOR_LIVE_TRACE_FILE: tracePath,
    AGENT_HARBOR_LIVE_NONCE: acceptanceId,
  };
  await activateCycle("pi", project, env);
  const result = await runPiRpcWithPreload(packageRoot, project, env, prompt, selection.model);
  assert.equal(result.state.model?.provider, "openai-codex", "Pi selected a non-Codex provider");
  assert.equal(result.state.model?.id, selection.model, "Pi selected the wrong model");
  assert.equal(result.state.thinkingLevel, "low", "Pi selected the wrong bounded thinking level");
  await deactivateCycle("pi", project, env);
  await removeHarnessRuntimeArtifacts("pi", project);
  return {
    provider: "openai-codex",
    model: selection.model,
    fallbackUsed: selection.fallbackUsed,
    reasoning: "low",
    version: versionResult.stdout.trim().split(/\r?\n/u)[0] ?? "unknown",
    finalText: result.finalText,
    traceText: await readFile(tracePath, "utf8"),
    durationMs: result.durationMs,
    rootSessionCleaned: true,
    rosterCleaned: true,
  };
}

async function runPiRpcWithPreload(
  packageRoot: string,
  project: string,
  env: NodeJS.ProcessEnv,
  prompt: string,
  model: string,
): Promise<{ finalText: string; state: Record<string, any>; durationMs: number; stderr: string }> {
  const observer = pathToFileURL(join(root, "test-ts", "support", "live-pi-observer.mjs")).href;
  const cliArgs = [
    "--offline", "--no-session", "--no-extensions", "-e", join(root, "dist", "adapters", "pi.js"),
    "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-tools",
    "--provider", "openai-codex", "--model", model, "--thinking", "low", "--mode", "rpc", "--approve",
  ];
  return runPiRpcCore(["--import", observer, join(packageRoot, "dist", "cli.js"), ...cliArgs], project, env, prompt);
}

async function runPiRpcCore(
  nodeArgs: readonly string[],
  project: string,
  env: NodeJS.ProcessEnv,
  prompt: string,
): Promise<{ finalText: string; state: Record<string, any>; durationMs: number; stderr: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const started = Date.now();
    const child = spawn(process.execPath, [...nodeArgs], { cwd: project, env: cleanEnvironment(env), stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let stdout = ""; let stderr = ""; let pending = ""; let state: any; let stateAfter: any; let notify: any; let promptResponse: any;
    let commandsChecked = false; let extensionError = false; let stateAfterSent = false; let overflow = false;
    const maybeClose = () => { if (notify && promptResponse && stateAfter) child.stdin.end(); };
    const onLine = (line: string) => {
      if (!line.trim()) return;
      let event: any;
      try { event = JSON.parse(line); } catch { extensionError = true; return; }
      if (event.type === "extension_error") extensionError = true;
      if (event.id === "state-before" && event.type === "response" && event.success) state = event.data;
      if (event.id === "commands-before" && event.type === "response" && event.success) commandsChecked = Boolean(event.data?.commands?.some((command: any) => command.name === "team-lead" && command.source === "extension"));
      if (event.type === "extension_ui_request" && event.method === "notify") {
        if (notify) extensionError = true;
        notify = event;
        if (!stateAfterSent) { stateAfterSent = true; child.stdin.write(`${JSON.stringify({ id: "state-after", type: "get_state" })}\n`); }
      }
      if (event.id === "lead-1" && event.type === "response") promptResponse = event;
      if (event.id === "state-after" && event.type === "response" && event.success) stateAfter = event.data;
      maybeClose();
    };
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk; pending += chunk;
      if (Buffer.byteLength(stdout, "utf8") + Buffer.byteLength(stderr, "utf8") > outputLimit) { overflow = true; child.kill(); return; }
      const lines = pending.split(/\r?\n/u); pending = lines.pop() ?? ""; lines.forEach(onLine);
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", rejectPromise);
    const timer = setTimeout(() => child.kill(), LIVE_CODEX_COMMUNICATION_BUDGET.wallTimeMs);
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (overflow) return rejectPromise(new Error("Pi RPC exceeded its bounded output limit"));
      if (code !== 0 || signal) return rejectPromise(new Error(`Pi RPC failed: exit=${String(code)} signal=${String(signal)} stdout=${sha256(stdout)} stderr=${sha256(stderr)}`));
      try {
        assert.ok(state); assert.ok(commandsChecked); assert.ok(notify); assert.equal(notify.notifyType, "info");
        assert.equal(promptResponse?.success, true); assert.equal(stateAfter?.isStreaming, false); assert.equal(extensionError, false);
        assert.equal(typeof notify.message, "string");
        resolvePromise({ finalText: notify.message, state, durationMs: Date.now() - started, stderr });
      } catch (error) { rejectPromise(error); }
    });
    child.stdin.write(`${JSON.stringify({ id: "state-before", type: "get_state" })}\n`);
    child.stdin.write(`${JSON.stringify({ id: "commands-before", type: "get_commands" })}\n`);
    child.stdin.write(`${JSON.stringify({ id: "lead-1", type: "prompt", message: `/team-lead ${prompt}` })}\n`);
  });
}

function numberAt(record: LiveLifecycleRecord, key: string): number {
  const value = record.raw[key];
  assert.equal(typeof value, "number", `${record.kind}.${key} is missing`);
  return value;
}

function stringAt(record: LiveLifecycleRecord, key: string): string {
  const value = record.raw[key];
  assert.equal(typeof value, "string", `${record.kind}.${key} is missing`);
  return value;
}

function safeTraceDiagnostics(traceText: string): Record<string, unknown> {
  const records = parseLifecycleEvidence(traceText);
  const sessionAgents = new Map(records
    .filter((record) => ["chat.message", "session.prompt"].includes(record.kind) && record.agent && typeof record.raw.sessionSha256 === "string")
    .map((record) => [record.raw.sessionSha256 as string, record.agent!]));
  const eventCounts: Record<string, number> = {};
  for (const record of records) eventCounts[record.kind] = (eventCounts[record.kind] ?? 0) + 1;
  const modelRecords = records.filter((record) => record.kind === "model.completed");
  const failureRecords = records.filter((record) => ["child.failed", "delegation.failed", "model.failed", "session.error", "error", "native.tool.failed"].includes(record.kind)
    || record.raw.outcome === "error"
    || record.raw.status === "failed"
    || record.raw.isError === true);
  return {
    records: records.length,
    eventCounts,
    modelTurns: modelRecords.length,
    rootModelTurns: modelRecords.filter((record) => record.agent === "team-lead").length,
    observedTokens: modelRecords.reduce((sum, record) => sum + (record.totalTokens ?? 0), 0),
    delegatedAgents: records.filter((record) => record.kind === "delegation.start").map((record) => record.agent ?? null),
    failures: failureRecords.map((record) => ({
      kind: record.kind,
      agent: record.agent ?? (typeof record.raw.sessionSha256 === "string" ? sessionAgents.get(record.raw.sessionSha256) : undefined) ?? null,
      tool: typeof record.raw.tool === "string" ? record.raw.tool : null,
      targetClass: typeof record.raw.targetClass === "string" ? record.raw.targetClass : null,
      errorClass: typeof record.raw.errorClass === "string" ? record.raw.errorClass : null,
    })),
  };
}

function inspectTrace(run: HarnessRun, acceptanceId: string, prompt: string, project: string): Record<string, unknown> {
  const records = parseLifecycleEvidence(run.traceText);
  assert.ok(records.every((record) => record.harness === undefined || record.harness === run.provider || record.harness === "opencode" || record.harness === "pi"));
  assertLifecycleFingerprints(records);
  const lifecycleFailures = records
    .filter((record) => record.kind !== "native.tool.failed" && (["child.failed", "delegation.failed", "model.failed", "session.error", "error"].includes(record.kind)
      || record.raw.outcome === "error"
      || record.raw.status === "failed"))
    .map((record) => ({
      kind: record.kind,
      agent: record.agent ?? null,
      tool: typeof record.raw.tool === "string" ? record.raw.tool : null,
      finish: typeof record.raw.finish === "string" ? record.raw.finish : null,
    }));
  assert.deepEqual(lifecycleFailures, [], `lifecycle failure summary: ${JSON.stringify(lifecycleFailures)}`);
  assertNoLifecycleFailures(records.filter((record) => record.kind !== "native.tool.failed"));
  assertNoRawValues(records.map((record) => record.raw), [acceptanceId, prompt, project]);
  assertLifecyclePairs(records, { startKind: "delegation.start", endKind: "delegation.end", identity: (record) => stringAt(record, "callSha256") });
  const starts = records.filter((record) => record.kind === "delegation.start");
  const ends = records.filter((record) => record.kind === "delegation.end");
  assert.deepEqual(starts.map((record) => record.agent), expectedAgents, "team-lead delegated in the wrong order");
  assert.deepEqual(ends.map((record) => record.agent), expectedAgents, "delegations completed in the wrong order");
  assert.equal(starts.length, 6);
  assert.equal(new Set(starts.map((record) => stringAt(record, "callSha256"))).size, 6, "delegations reused a call identity");
  for (const [index, start] of starts.entries()) {
    const end = ends[index];
    assert.equal(numberAt(start, "concurrentDelegations"), 1, `stage ${index + 1} overlapped`);
    assert.equal(numberAt(start, "maxConcurrentDelegations"), 1, `stage ${index + 1} exceeded sequential concurrency`);
    assert.equal(numberAt(start, "nonceOccurrences"), index === 0 ? 0 : numberAt(start, "nonceOccurrences"));
    if (index > 0) {
      assert.ok(numberAt(start, "nonceOccurrences") >= 1 && numberAt(start, "nonceOccurrences") <= 3, `stage ${index + 1} transported the nonce inefficiently`);
      assert.ok(numberAt(start, "predecessorMarkerOccurrences") <= 1, `stage ${index + 1} duplicated its immediate handoff token`);
    }
    assert.equal(start.raw.completePredecessorCopied, false, `stage ${index + 1} copied the complete predecessor response`);
    assert.ok((start.raw.task as any).utf8Bytes <= 4_096, `stage ${index + 1} prompt exceeded 4 KiB`);
    const markerOccurrences = numberAt(end, "markerOccurrences");
    const allCycleMarkerOccurrences = numberAt(end, "allCycleMarkerOccurrences");
    assert.ok(markerOccurrences <= 1, `stage ${index + 1} duplicated its preferred marker`);
    assert.equal(allCycleMarkerOccurrences, markerOccurrences, `stage ${index + 1} returned a foreign or stale handoff marker`);
    assert.ok(numberAt(end, "nonceOccurrences") >= (index === expectedAgents.length - 1 ? 0 : 1)
      && numberAt(end, "nonceOccurrences") <= 3, `stage ${index + 1} returned an inefficient hidden-ID count`);
    assert.equal(numberAt(end, "concurrentDelegations"), 0, `stage ${index + 1} did not settle`);
    assert.ok((end.raw.evidence as any).utf8Bytes <= 12_288, `stage ${index + 1} evidence is oversized`);
    assert.ok(start.index < end.index, `stage ${index + 1} ended before it started`);
    if (index > 0) assert.ok(ends[index - 1].index < start.index, `stages ${index} and ${index + 1} overlapped`);
  }

  const promptKind = run.provider === "openai" ? "chat.message" : "session.prompt";
  const prompts = records.filter((record) => record.kind === promptKind);
  const agentSessions = new Map<string, string>();
  for (const record of prompts) {
    const session = stringAt(record, "sessionSha256");
    assert.ok(record.agent, `${promptKind} has no agent identity`);
    agentSessions.set(session, record.agent);
  }
  for (const agent of ["team-lead", ...expectedAgents]) {
    assert.equal(prompts.filter((record) => record.agent === agent).length, 1, `${agent} did not receive exactly one native prompt`);
  }
  if (run.provider === "openai") {
    assert.ok(prompts.every((record) => record.raw.variant === run.reasoning),
      "OpenCode did not propagate the root reasoning variant to every child");
  }
  assert.equal(new Set(prompts.map((record) => stringAt(record, "sessionSha256"))).size, 7, "agents did not use distinct native sessions");
  assertLifecycleModels(records, {
    kind: "model.completed",
    provider: run.provider,
    model: run.model,
    agents: ["team-lead", ...expectedAgents],
    requirePositiveUsage: false,
  });
  const modelRecords = records.filter((record) => record.kind === "model.completed");
  const rootTurns = modelRecords.filter((record) => record.agent === "team-lead").length;
  const rootTokens = modelRecords.filter((record) => record.agent === "team-lead")
    .reduce((sum, record) => sum + (record.totalTokens ?? 0), 0);
  const totalTokens = modelRecords.reduce((sum, record) => sum + (record.totalTokens ?? 0), 0);
  assert.ok(rootTurns <= LIVE_CODEX_COMMUNICATION_BUDGET.rootModelTurns, "team-lead exceeded its turn budget");
  assert.ok(rootTokens > 0, "team-lead has no observed token usage");
  assert.ok(modelRecords.length <= LIVE_CODEX_COMMUNICATION_BUDGET.totalModelTurns, "cycle exceeded its model-turn budget");
  assert.ok(totalTokens > 0 && totalTokens <= LIVE_CODEX_COMMUNICATION_BUDGET.totalObservedTokens, "cycle exceeded its token budget");
  const childUsage = Object.fromEntries(expectedAgents.map((agent) => {
    const turns = modelRecords.filter((record) => record.agent === agent);
    const tokens = turns.reduce((sum, record) => sum + (record.totalTokens ?? 0), 0);
    assert.ok(tokens > 0 && tokens <= LIVE_CODEX_COMMUNICATION_BUDGET.maxChildTokens, `${agent} exceeded its token budget`);
    return [agent, { turns: turns.length, totalTokens: tokens }];
  }));

  const toolStarts = records.filter((record) => record.kind === "specialist.tool.start");
  const toolTerminals = run.provider === "openai"
    ? records.filter((record) => ["native.tool.completed", "native.tool.failed"].includes(record.kind) && record.raw.tool !== "harbor_delegate")
    : records.filter((record) => record.kind === "specialist.tool.end");
  const toolFailures = run.provider === "openai"
    ? toolTerminals.filter((record) => record.kind === "native.tool.failed")
    : toolTerminals.filter((record) => record.raw.isError === true);
  assert.equal(toolFailures.length, 0, "a specialist tool failed");
  assert.equal(toolStarts.length, toolTerminals.length, "specialist native tool lifecycle is incomplete");
  assert.deepEqual(
    new Set(toolTerminals.map((record) => stringAt(record, "callSha256"))),
    new Set(toolStarts.map((record) => stringAt(record, "callSha256"))),
    "specialist native tool identities do not match",
  );
  const agentForTool = (record: LiveLifecycleRecord): string => record.agent ?? agentSessions.get(stringAt(record, "sessionSha256")) ?? "";
  const toolsFor = (agent: string) => toolStarts.filter((record) => agentForTool(record) === agent);
  const targetClassFor = (record: LiveLifecycleRecord): string => stringAt(record, "targetClass");
  const allowedFixtureTargets = new Set<string>(LIVE_FIXTURE_TOOL_TARGETS);
  const portfolioTools = toolsFor("portfolio-management");
  assert.ok(portfolioTools.length >= 1 && portfolioTools.length <= 3,
    "portfolio-management must make between one and three bounded reads");
  assert.ok(portfolioTools.every((record) => new Set(["read", "grep", "glob", "find", "ls", "search"]).has(record.raw.tool as string)),
    "portfolio-management used a non-read/search tool");
  assert.ok(portfolioTools.every((record) => allowedFixtureTargets.has(targetClassFor(record))),
    "portfolio-management accessed a target outside the three bounded fixture files");
  assert.equal(toolsFor("design").length, 0, "design used tools instead of the portfolio handoff");
  const buildTools = toolsFor("build");
  const buildReads = buildTools.filter((record) => record.raw.tool === "read");
  assert.ok(buildReads.length >= 1 && buildReads.length <= 3,
    "build must make between one and three bounded reads before editing");
  assert.ok(buildTools.every((record) => new Set(["read", "apply_patch", "edit", "write"]).has(record.raw.tool as string)),
    "build used an unrelated tool");
  assert.ok(buildTools.every((record) => allowedFixtureTargets.has(targetClassFor(record))),
    "build accessed a target outside the three bounded fixture files");
  const mutations = toolStarts.filter((record) => new Set(["apply_patch", "edit", "write"]).has(record.raw.tool as string));
  assert.ok(mutations.length > 0, "build made no observed edit");
  assert.ok(mutations.every((record) => agentForTool(record) === "build"), "a non-build specialist edited the fixture");
  assert.ok(mutations.every((record) => targetClassFor(record) === "src/score.js"), "build edited outside src/score.js");
  const shellCalls = toolStarts.filter((record) => record.raw.tool === "bash");
  assert.equal(shellCalls.length, 1, "the cycle must make exactly one shell call");
  assert.equal(agentForTool(shellCalls[0]), "manage", "only manage may run operational verification");
  assert.equal(shellCalls[0].raw.commandClass, "npm-test", "manage did not run exactly npm test");
  assert.equal(toolsFor("manage").length, 1, "manage must use only the single operational verification call");
  const consumeTools = toolsFor("consume");
  assert.equal(consumeTools.length, 3, "consume must read exactly the three bounded acceptance files");
  assert.ok(consumeTools.every((record) => record.raw.tool === "read"), "consume used a non-read acceptance tool");
  assert.deepEqual(consumeTools.map(targetClassFor).sort(), [...LIVE_FIXTURE_TOOL_TARGETS].sort(),
    "consume did not read each bounded acceptance file exactly once");
  const disposeTools = toolsFor("dispose");
  assert.equal(disposeTools.length, 0,
    "dispose used a tool instead of the returned handoff while assessing closure and end-of-life readiness");
  const totalToolCalls = starts.length + toolStarts.length;
  assert.ok(totalToolCalls <= LIVE_CODEX_COMMUNICATION_BUDGET.totalToolCalls, "cycle exceeded its tool-call budget");
  for (const agent of expectedAgents) {
    assert.ok(toolStarts.filter((record) => agentForTool(record) === agent).length <= LIVE_CODEX_COMMUNICATION_BUDGET.maxChildToolCalls, `${agent} exceeded its tool budget`);
  }

  if (run.provider === "openai") {
    const rootSession = prompts.find((record) => record.agent === "team-lead")!.raw.sessionSha256;
    const children = records.filter((record) => record.kind === "session.created" && record.raw.sessionSha256 !== rootSession);
    const deleted = records.filter((record) => record.kind === "session.deleted");
    assert.equal(children.length, 6, "OpenCode did not create exactly six child sessions");
    assert.equal(deleted.length, 6, "OpenCode did not clean exactly six child sessions");
    assert.deepEqual(new Set(deleted.map((record) => stringAt(record, "sessionSha256"))), new Set(children.map((record) => stringAt(record, "sessionSha256"))), "OpenCode cleaned the wrong child sessions");
  } else {
    const completed = records.filter((record) => record.kind === "session.completed");
    assert.equal(completed.length, 7, "Pi did not settle every native session");
    assert.ok(completed.every((record) => record.raw.outcome === "ok"), "a Pi session failed");
    const turnStarts = records.filter((record) => record.kind === "turn.start");
    const turnEnds = records.filter((record) => record.kind === "turn.end");
    assert.equal(turnStarts.length, turnEnds.length, "Pi turn lifecycle is incomplete");
    assert.equal(turnEnds.length, modelRecords.length, "Pi has a model-turn telemetry gap");
  }
  return {
    records: records.length,
    trace: sanitizeValue(run.traceText),
    maxConcurrentDelegations: 1,
    rootModelTurns: rootTurns,
    rootObservedTokens: rootTokens,
    totalModelTurns: modelRecords.length,
    totalToolCalls,
    totalObservedTokens: totalTokens,
    childUsage,
    delegatedPromptBytes: starts.reduce((sum, record) => sum + (record.raw.task as any).utf8Bytes, 0),
    returnedEvidenceBytes: ends.reduce((sum, record) => sum + (record.raw.evidence as any).utf8Bytes, 0),
    delegations: starts.map((record, index) => ({
      agent: record.agent,
      callSha256: record.raw.callSha256,
      prompt: record.raw.task,
      evidence: ends[index].raw.evidence,
      nonceOccurrences: record.raw.nonceOccurrences,
      predecessorMarkerOccurrences: record.raw.predecessorMarkerOccurrences,
      markerOccurrences: ends[index].raw.markerOccurrences,
      nonceOccurrencesInEvidence: ends[index].raw.nonceOccurrences,
      standaloneFinalLine: ends[index].raw.standaloneFinalLine,
    })),
  };
}

async function writeReport(harness: LiveCodexHarness, report: unknown): Promise<void> {
  const work = join(root, "work");
  await mkdir(work, { recursive: true });
  await writeFile(join(work, `live-${harness}-team-lead-report.json`), `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

for (const harness of selectedHarnesses) {
  test(`live ${harness} team-lead selects and orchestrates the Harbor SDLC cycle with Codex`, {
    skip: liveRequested ? false : "opt-in: run the matching test:live:* script (this consumes Codex tokens)",
    timeout: 15 * 60_000,
  }, async () => {
    const fixture = await createLiveCodexFixture(harness);
    let failure: unknown;
    let passedReport: Record<string, unknown> | undefined;
    let failedRunDiagnostics: Record<string, unknown> | undefined;
    const immutablePaths = ["ACCEPTANCE.md", "package.json", "test/score.test.js"];
    const beforeHashes = Object.fromEntries(await Promise.all(immutablePaths.map(async (path) => [path, sha256(await readFile(join(fixture.project, path), "utf8"))])));
    const beforeScore = sha256(await readFile(join(fixture.project, "src", "score.js"), "utf8"));
    try {
      await assertLiveCodexFixtureShape(fixture);
      const failing = await runProcess("fixture negative preflight", process.execPath, ["--test", "test/score.test.js"], {
        cwd: fixture.project,
        allowNonZero: true,
        timeoutMs: 30_000,
      });
      assert.notEqual(failing.code, 0, "fixture unexpectedly passed before implementation");
      const run = harness === "opencode"
        ? await runOpenCode(fixture.project, fixture.sandbox, fixture.acceptanceId, fixture.prompt)
        : await runPi(fixture.project, fixture.sandbox, fixture.acceptanceId, fixture.prompt);
      failedRunDiagnostics = {
        provider: run.provider,
        model: run.model,
        fallbackUsed: run.fallbackUsed,
        reasoning: run.reasoning,
        durationMs: run.durationMs,
        ...safeTraceDiagnostics(run.traceText),
      };
      assert.equal(run.rootSessionCleaned, true, `${harness} root session was not cleaned`);
      assert.equal(run.rosterCleaned, true, `${harness} managed roster was not cleaned`);
      const trace = inspectTrace(run, fixture.acceptanceId, fixture.prompt, fixture.project);
      assert.ok(run.durationMs <= LIVE_CODEX_COMMUNICATION_BUDGET.wallTimeMs, `${harness} exceeded its wall-time budget`);
      assertLiveCodexFinal(run.finalText, expectedAgents);
      const passing = await runProcess("fixture positive verification", process.execPath, ["--test", "test/score.test.js"], {
        cwd: fixture.project,
        timeoutMs: 30_000,
      });
      assert.equal(passing.code, 0);
      await assertLiveCodexFixtureShape(fixture);
      for (const path of immutablePaths) {
        assert.equal(sha256(await readFile(join(fixture.project, path), "utf8")), beforeHashes[path], `${path} changed outside the implementation boundary`);
      }
      const afterScore = sha256(await readFile(join(fixture.project, "src", "score.js"), "utf8"));
      assert.notEqual(afterScore, beforeScore, "build did not change src/score.js");
      passedReport = {
        schema: LIVE_CODEX_REPORT_SCHEMA,
        status: "passed",
        generatedAt: new Date().toISOString(),
        harness,
        provider: run.provider,
        model: run.model,
        selection: { preferredModel, fallbackModel, fallbackUsed: run.fallbackUsed, reasoning: run.reasoning },
        runtime: { version: run.version },
        expectedAgents,
        observedAgents: expectedAgents,
        orchestration: trace,
        communicationEfficiency: {
          budget: LIVE_CODEX_COMMUNICATION_BUDGET,
          observed: { ...(trace as any), wallTimeMs: run.durationMs, finalBytes: Buffer.byteLength(run.finalText, "utf8") },
        },
        fixture: {
          negativePreflightFailed: true,
          positiveVerificationPassed: true,
          immutableFilesUnchanged: true,
          implementationChanged: true,
          managedRosterCleaned: true,
          beforeScoreSha256: beforeScore,
          afterScoreSha256: afterScore,
        },
        final: sanitizeValue(run.finalText),
        authentication: { kind: "openai-codex-oauth", observedTokensPositive: true },
      };
      assertNoRawValues(passedReport, [fixture.acceptanceId, fixture.prompt, fixture.project, fixture.sandbox, run.finalText]);
    } catch (error) {
      failure = error;
    }
    let cleanupFailure: unknown;
    try { await removeLiveCodexSandbox(fixture.sandbox); }
    catch (error) { cleanupFailure = error; }
    if (failure || cleanupFailure || !passedReport) {
      const errors = [failure, cleanupFailure].filter((error) => error !== undefined);
      await writeReport(harness, {
        schema: LIVE_CODEX_REPORT_SCHEMA,
        status: "failed",
        generatedAt: new Date().toISOString(),
        harness,
        ...(typeof failedRunDiagnostics?.provider === "string" ? { provider: failedRunDiagnostics.provider } : {}),
        model: typeof failedRunDiagnostics?.model === "string" ? failedRunDiagnostics.model : preferredModel,
        expectedAgents,
        observedAgents: Array.isArray(failedRunDiagnostics?.delegatedAgents)
          ? failedRunDiagnostics.delegatedAgents.filter((agent): agent is string => typeof agent === "string" && expectedAgents.includes(agent))
          : [],
        failure: errors.map(sanitizeError),
        ...(failedRunDiagnostics ? { diagnostics: failedRunDiagnostics } : {}),
      });
      throw errors.length > 1 ? new AggregateError(errors, `${harness} live acceptance and cleanup failed`) : errors[0];
    }
    await writeReport(harness, passedReport);
  });
}

test("live Codex harness selector is valid", { skip: liveRequested ? false : "live runner only" }, () => {
  assert.ok(selectedHarnesses.length > 0, `invalid AGENT_HARBOR_LIVE_HARNESS: ${requestedHarness}`);
});
