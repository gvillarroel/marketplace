import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { foldMarkdownWrappedText } from "./live-handoff.js";
import { loadHarborCycleDataset } from "./harbor-cycles.js";

export const liveCodexHarnesses = ["opencode", "pi"] as const;
export type LiveCodexHarness = (typeof liveCodexHarnesses)[number];

export const LIVE_CODEX_REPORT_SCHEMA = "agent-harbor/live-codex-team-lead@1" as const;
export const LIVE_CODEX_EXPECTED_FILES = [
  "ACCEPTANCE.md",
  "package.json",
  "src/score.js",
  "test/score.test.js",
] as const;

export const LIVE_CODEX_COMMUNICATION_BUDGET = {
  rootModelTurns: 8,
  totalModelTurns: 36,
  totalToolCalls: 60,
  wallTimeMs: 180_000,
  maxChildToolCalls: 12,
  totalObservedTokens: 200_000,
  maxChildTokens: 35_000,
  delegatedPromptBytes: 6 * 4_096,
  returnedEvidenceBytes: 6 * 12_288,
  finalBytes: 6_144,
} as const;

const sandboxPrefix = "harbor-live-codex-";
const playerIdPattern = /^[a-z0-9][a-z0-9-]{0,47}$/u;
const sha256Pattern = /^[a-f0-9]{64}$/u;

export interface SanitizedValue {
  readonly sha256: string;
  readonly utf8Bytes: number;
}

export interface SanitizedError extends SanitizedValue {
  readonly name: string;
}

export interface LiveCodexFixture {
  readonly harness: LiveCodexHarness;
  readonly sandbox: string;
  readonly project: string;
  readonly acceptanceId: string;
  readonly expectedAgents: readonly string[];
  readonly prompt: string;
  readonly files: typeof LIVE_CODEX_EXPECTED_FILES;
  readonly initialFingerprints: Readonly<Record<(typeof LIVE_CODEX_EXPECTED_FILES)[number], SanitizedValue>>;
}

export interface LiveCodexDelegation {
  readonly agent: string;
  readonly prompt: string;
  readonly result: string;
  readonly invocationId?: string;
  readonly childId?: string;
  readonly startedAt?: number;
  readonly completedAt?: number;
  readonly totalTokens?: number;
  readonly totalToolCalls?: number;
}

export interface SanitizedLiveCodexDelegation {
  readonly agent: string;
  readonly invocation?: SanitizedValue;
  readonly child?: SanitizedValue;
  readonly prompt: SanitizedValue;
  readonly evidence: SanitizedValue;
  readonly promptHandoff: {
    readonly acceptanceIdOccurrences: number;
    readonly predecessorMarkerOccurrences: number;
  };
  readonly handoff: {
    readonly exactOccurrences: number;
    readonly allCycleMarkerOccurrences: number;
    readonly standaloneFinalLine: boolean;
  };
  readonly durationMs?: number;
  readonly totalTokens?: number;
  readonly totalToolCalls?: number;
}

/** A normalized view over adapter hooks, native harness events, or custom JSONL observers. */
export interface LiveLifecycleRecord {
  readonly index: number;
  readonly kind: string;
  readonly harness?: string;
  readonly agent?: string;
  readonly identity?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly totalTokens?: number;
  readonly raw: Readonly<Record<string, unknown>>;
}

export interface LifecyclePairOptions {
  readonly startKind: string;
  readonly endKind: string;
  readonly identity?: (record: LiveLifecycleRecord) => string | undefined;
}

export interface LifecycleModelExpectation {
  readonly kind?: string;
  readonly provider: string;
  readonly model: string;
  readonly agents?: readonly string[];
  readonly requirePositiveUsage?: boolean;
}

export interface LiveCodexReportEnvelope extends Readonly<Record<string, unknown>> {
  readonly schema: string;
  readonly status: "passed" | "failed";
  readonly generatedAt: string;
  readonly harness: LiveCodexHarness;
  readonly provider: string;
  readonly model: string;
  readonly expectedAgents: readonly string[];
  readonly observedAgents: readonly string[];
}

export interface LiveCodexReportExpectation {
  readonly harness: LiveCodexHarness;
  readonly provider: string;
  readonly model: string;
  readonly expectedAgents: readonly string[];
  readonly startedAt?: number;
  readonly schema?: string;
  readonly now?: number;
  readonly maxAgeMs?: number;
  readonly rawValues?: readonly string[];
  readonly requirePositiveTokens?: boolean;
}

function objectAt(value: unknown, label: string): Record<string, unknown> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  return value as Record<string, unknown>;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string): string => process.platform === "win32"
    ? resolve(value).toLowerCase()
    : resolve(value);
  return normalize(left) === normalize(right);
}

function isPathInside(root: string, candidate: string): boolean {
  const child = relative(resolve(root), resolve(candidate));
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

function regexEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function normalizedLastLine(value: string): string {
  return value.replace(/\r\n?/gu, "\n").replace(/(?:\n[ \t]*)+$/u, "").split("\n").at(-1) ?? "";
}

function stringArray(value: unknown, label: string): string[] {
  assert.ok(Array.isArray(value), `${label} must be an array`);
  assert.ok(value.every((entry) => typeof entry === "string"), `${label} must contain only strings`);
  return [...value] as string[];
}

function nestedValue(root: Readonly<Record<string, unknown>>, path: readonly string[]): unknown {
  let value: unknown = root;
  for (const key of path) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

export function sanitizeValue(value: string): SanitizedValue {
  return { sha256: sha256(value), utf8Bytes: utf8Bytes(value) };
}

export function sanitizeError(error: unknown): SanitizedError {
  const normalized = error instanceof Error ? error : new Error(String(error));
  return { name: normalized.name, ...sanitizeValue(normalized.message) };
}

export function assertSanitizedValue(value: unknown, label = "sanitized value"): asserts value is SanitizedValue {
  const input = objectAt(value, label);
  assert.equal(typeof input.sha256, "string", `${label}.sha256 must be a string`);
  assert.match(input.sha256 as string, sha256Pattern, `${label}.sha256 must be lowercase SHA-256`);
  assert.ok(Number.isSafeInteger(input.utf8Bytes) && (input.utf8Bytes as number) >= 0,
    `${label}.utf8Bytes must be a non-negative safe integer`);
}

export function assertNoRawValues(value: unknown, rawValues: readonly string[]): void {
  const serialized = JSON.stringify(value);
  assert.equal(typeof serialized, "string", "sanitized evidence is not JSON serializable");
  for (const raw of rawValues.filter(Boolean)) {
    assert.equal(serialized!.includes(raw), false, "a raw prompt, result, nonce, path, command, or error leaked into sanitized evidence");
  }
}

export function assertLifecycleFingerprints(records: readonly LiveLifecycleRecord[]): void {
  const visit = (value: unknown, path: string): void => {
    if (Array.isArray(value)) {
      value.forEach((entry, index) => visit(entry, `${path}[${index}]`));
      return;
    }
    if (!value || typeof value !== "object") return;
    const input = value as Record<string, unknown>;
    if ("sha256" in input || "utf8Bytes" in input) assertSanitizedValue(input, path);
    for (const [key, entry] of Object.entries(input)) visit(entry, `${path}.${key}`);
  };
  records.forEach((record, index) => visit(record.raw, `lifecycle record ${index + 1}`));
}

export function occurrences(value: string, needle: string): number {
  assert.notEqual(needle, "", "occurrence needle must not be empty");
  return value.split(needle).length - 1;
}

export function handoffMarker(agent: string, acceptanceId: string): string {
  assert.match(agent, playerIdPattern, "handoff agent is invalid");
  assert.match(acceptanceId, /^AH-[a-f0-9]{16}$/u, "acceptance ID is invalid");
  return `HARBOR_HANDOFF:${agent}:${acceptanceId}`;
}

export function expectedSequencePrefix(expectedAgents: readonly string[]): string {
  return `HARBOR_SEQUENCE:${expectedAgents.join(" -> ")}`;
}

export function liveCodexExpectedAgents(): readonly string[] {
  const dataset = loadHarborCycleDataset();
  const cycle = dataset.cycles.find((candidate) => candidate.id === "full-sdlc");
  assert.ok(cycle, "full-sdlc cycle is missing from the Harbor dataset");
  const agents = cycle.steps.map((step) => step.agent);
  assert.equal(agents.length, 6, "the live Codex cycle must contain exactly six stages");
  return Object.freeze(agents);
}

export function buildLiveCodexPrompt(expectedAgents = liveCodexExpectedAgents()): string {
  assert.deepEqual(expectedAgents, ["scout", "sage", "smith", "probe", "guard", "pilot"],
    "the live prompt requires the canonical Harbor SDLC order");
  return [
    "This is a live Agent Harbor acceptance task in the current bounded fixture.",
    "Complete all six required, distinct delivery gates below in dependency order. Select the active specialist whose published role exactly matches each gate; do not perform specialist work in the parent and do not use built-in or intermediate routers.",
    "The only eligible specialists for this task and their published roles are intentionally listed out of workflow order: pilot (Delivery readiness), smith (Focused implementation), scout (Repository discovery), guard (Read-only review), probe (Focused verification), sage (Implementation design). Treat each published role as authoritative: each specialist may cover only its matching gate and must be used exactly once. Never call repo-cartographer, crafter, team-lead, or any unlisted specialist; after pilot, synthesize the final response immediately without another delegation.",
    "Required gates: discover the fixture and its hidden acceptance ID without editing; design the smallest evidence-backed fix; implement it; run focused verification; perform a read-only correctness/safety/coverage review; assess delivery readiness and rollback risk.",
    "All six gates are mandatory acceptance conditions. Passing the implementation or verification gate does not make the independent review and delivery-readiness gates optional.",
    "Do not emit a final response after only one through five delegation results. After probe returns, the only valid next delegation is guard; after guard returns, the only valid next delegation is pilot; only after pilot returns may you synthesize.",
    "Keep every gate inside ACCEPTANCE.md, src/score.js, and test/score.test.js. When reading, use only those exact relative file paths; never use glob, grep, find, list, wildcard paths, absolute paths, or exploratory search. Discovery and design are read-only; implementation edits only src/score.js and leaves test execution to verification; verification runs exactly npm test once; review only reads those three files and returned evidence; delivery readiness uses returned evidence and needs no exploratory tools.",
    "Use one synchronous delegation at a time and each eligible specialist exactly once. Give every child only its bounded gate, constraints, the immediately preceding handoff when one exists, and this completion contract:",
    "Copy this exact output rule into every child task: include the exact token HARBOR_HANDOFF:<your exact agent ID>:<acceptance ID> exactly once in the response, and never quote, copy, or emit any predecessor's HARBOR_HANDOFF token. A standalone final line is preferred but surrounding line formatting is not a validity condition. Keep all child evidence concise.",
    "Pass only concise evidence forward. Before each later delegation, remove the predecessor's literal HARBOR_HANDOFF token, strip every absolute path in favor of the three exact relative paths, and paraphrase its evidence while preserving the acceptance ID; never paste a complete prior response into another child task.",
    "The acceptance ID exists only in the fixture; do not guess it. Native tool lifecycle is authoritative for child identity and completion. A missing preferred marker alone does not fail a completed native delegation; a duplicated or stale marker does. Stop on any actual failed gate, never rewrite or retry a completed gate, and keep every delegated prompt under 4 KiB.",
    "A substantive finding, residual risk, or NO-GO conclusion is valid gate evidence when its exact handoff token is present; it is not a failed tool gate and never waives a later mandatory gate. In particular, always dispatch pilot after a marked guard response so pilot can independently assess readiness.",
    `After all gates pass, begin the final response exactly with ${expectedSequencePrefix(expectedAgents)}, then give a compact delivery conclusion.`,
  ].join("\n");
}

export async function createLiveCodexFixture(harness: LiveCodexHarness): Promise<LiveCodexFixture> {
  assert.ok(liveCodexHarnesses.includes(harness), `unsupported live Codex harness: ${String(harness)}`);
  const sandbox = await mkdtemp(join(tmpdir(), `${sandboxPrefix}${harness}-`));
  const project = join(sandbox, "fixture");
  const acceptanceId = `AH-${randomBytes(8).toString("hex")}`;
  const expectedAgents = liveCodexExpectedAgents();
  try {
    await Promise.all([
      mkdir(join(project, "src"), { recursive: true }),
      mkdir(join(project, "test"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(project, "package.json"), `${JSON.stringify({
        name: "agent-harbor-live-fixture",
        private: true,
        type: "module",
        scripts: { test: "node --test test/score.test.js" },
      }, null, 2)}\n`, "utf8"),
      writeFile(join(project, "ACCEPTANCE.md"), [
        "# Bounded acceptance fixture",
        "",
        `Acceptance ID: ${acceptanceId}`,
        "",
        "Repair clampScore without changing its exported name.",
        "It must reject non-finite input and clamp finite values to the inclusive range 0..100.",
        "The delivery gate is `npm test`. Do not add dependencies or touch files outside this fixture.",
        "",
      ].join("\n"), "utf8"),
      writeFile(join(project, "src", "score.js"), [
        "export function clampScore(value) {",
        "  if (!Number.isFinite(value)) throw new TypeError(\"score must be finite\");",
        "  return Math.min(0, Math.max(100, value));",
        "}",
        "",
      ].join("\n"), "utf8"),
      writeFile(join(project, "test", "score.test.js"), [
        "import assert from \"node:assert/strict\";",
        "import test from \"node:test\";",
        "import { clampScore } from \"../src/score.js\";",
        "",
        "test(\"clamps finite scores and rejects non-finite input\", () => {",
        "  assert.equal(clampScore(-4), 0);",
        "  assert.equal(clampScore(42), 42);",
        "  assert.equal(clampScore(140), 100);",
        "  assert.throws(() => clampScore(Infinity), TypeError);",
        "});",
        "",
      ].join("\n"), "utf8"),
    ]);
  } catch (error) {
    await removeLiveCodexSandbox(sandbox).catch(() => undefined);
    throw error;
  }
  const initialFingerprints = Object.fromEntries(await Promise.all(LIVE_CODEX_EXPECTED_FILES.map(async (path) => [
    path,
    sanitizeValue(await readFile(join(project, path), "utf8")),
  ]))) as Record<(typeof LIVE_CODEX_EXPECTED_FILES)[number], SanitizedValue>;
  return {
    harness,
    sandbox,
    project,
    acceptanceId,
    expectedAgents,
    prompt: buildLiveCodexPrompt(expectedAgents),
    files: LIVE_CODEX_EXPECTED_FILES,
    initialFingerprints,
  };
}

export async function assertLiveCodexFixtureShape(fixture: LiveCodexFixture): Promise<void> {
  assert.ok(isPathInside(fixture.sandbox, fixture.project), "fixture project escaped its sandbox");
  assert.equal(basename(fixture.project), "fixture", "fixture project directory is unexpected");
  const discovered: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      assert.equal(entry.isSymbolicLink(), false, "fixture contains a symbolic link");
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) discovered.push(relative(fixture.project, path).replace(/\\/gu, "/"));
      else assert.fail("fixture contains an unsupported filesystem entry");
    }
  };
  await walk(fixture.project);
  assert.deepEqual(discovered.sort(), [...LIVE_CODEX_EXPECTED_FILES].sort(), "fixture file boundary changed");
  const acceptance = await readFile(join(fixture.project, "ACCEPTANCE.md"), "utf8");
  assert.equal(occurrences(acceptance, fixture.acceptanceId), 1, "fixture acceptance ID must occur exactly once");
  assert.equal(fixture.prompt.includes(fixture.acceptanceId), false, "the hidden acceptance ID leaked into the lead prompt");
}

export async function assertLiveCodexFixtureBoundary(
  fixture: LiveCodexFixture,
  mutableFiles: readonly (typeof LIVE_CODEX_EXPECTED_FILES)[number][] = ["src/score.js"],
): Promise<void> {
  await assertLiveCodexFixtureShape(fixture);
  const mutable = new Set(mutableFiles);
  assert.ok([...mutable].every((path) => fixture.files.includes(path)), "mutable fixture path is outside the file boundary");
  for (const path of fixture.files) {
    if (mutable.has(path)) continue;
    assert.deepEqual(sanitizeValue(await readFile(join(fixture.project, path), "utf8")), fixture.initialFingerprints[path],
      `immutable fixture file changed: ${path}`);
  }
}

export async function removeLiveCodexSandbox(path: string): Promise<void> {
  const target = resolve(path);
  const temporaryRoot = resolve(tmpdir());
  const name = basename(target);
  if (!samePath(dirname(target), temporaryRoot) ||
      !/^harbor-live-codex-(?:opencode|pi)-[A-Za-z0-9_-]{6,}$/u.test(name)) {
    throw new Error(`refusing to remove unexpected live Codex sandbox: ${target}`);
  }
  let lastError: unknown;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await rm(target, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
      return;
    } catch (error: any) {
      lastError = error;
      if (!new Set(["EBUSY", "EPERM", "ENOTEMPTY"]).has(error?.code)) throw error;
      await delay(100 * (attempt + 1));
    }
  }
  throw lastError;
}

export function maxConcurrentDelegations(calls: readonly LiveCodexDelegation[]): number {
  const points = calls.flatMap((call, index) => {
    assert.ok(Number.isFinite(call.startedAt), `delegation ${index + 1} has no finite start time`);
    assert.ok(Number.isFinite(call.completedAt), `delegation ${index + 1} has no finite completion time`);
    assert.ok(call.completedAt! >= call.startedAt!, `delegation ${index + 1} completed before it started`);
    if (call.completedAt === call.startedAt) return [];
    return [
      { at: call.startedAt!, delta: 1 },
      { at: call.completedAt!, delta: -1 },
    ];
  }).sort((left, right) => left.at - right.at || left.delta - right.delta);
  let active = 0;
  let maximum = calls.length ? 1 : 0;
  for (const point of points) {
    active += point.delta;
    maximum = Math.max(maximum, active);
  }
  assert.equal(active, 0, "delegation lifecycle did not settle");
  return maximum;
}

export function assertLiveCodexDelegations(
  calls: readonly LiveCodexDelegation[],
  acceptanceId: string,
  expectedAgents = liveCodexExpectedAgents(),
): void {
  assert.deepEqual(calls.map((call) => call.agent), expectedAgents, "lead selected agents in the wrong order");
  assert.equal(new Set(calls.map((call) => call.agent)).size, expectedAgents.length, "lead reused a specialist");
  for (const field of ["invocationId", "childId"] as const) {
    const values = calls.map((call) => call[field]).filter((value): value is string => value !== undefined);
    if (values.length) {
      assert.equal(values.length, calls.length, `every delegation must expose ${field} when one does`);
      assert.ok(values.every(Boolean), `${field} values must not be empty`);
      assert.equal(new Set(values).size, calls.length, `${field} values must be unique`);
    }
  }
  const allMarkerPattern = new RegExp(`HARBOR_HANDOFF:[a-z0-9-]+:${regexEscape(acceptanceId)}`, "gu");
  for (const [index, call] of calls.entries()) {
    assert.match(call.agent, playerIdPattern, `delegation ${index + 1} has an invalid agent`);
    assert.ok(call.prompt.trim(), `delegation ${index + 1} has an empty prompt`);
    assert.ok(call.result.trim(), `delegation ${index + 1} returned empty evidence`);
    assert.ok(utf8Bytes(call.prompt) <= 4_096, `delegation ${index + 1} exceeded the prompt byte budget`);
    assert.ok(utf8Bytes(call.result) <= 12_288, `delegation ${index + 1} exceeded the evidence byte budget`);
    const marker = handoffMarker(call.agent, acceptanceId);
    assert.equal(occurrences(call.result, marker), 1, `delegation ${index + 1} did not return its marker exactly once`);
    assert.equal(call.result.match(allMarkerPattern)?.length ?? 0, 1,
      `delegation ${index + 1} returned a stale or additional cycle marker`);
    if (index === 0) {
      assert.equal(occurrences(call.prompt, acceptanceId), 0, "discovery prompt knew the hidden acceptance ID in advance");
    } else {
      const predecessor = handoffMarker(expectedAgents[index - 1], acceptanceId);
      assert.ok(occurrences(call.prompt, predecessor) <= 1,
        `delegation ${index + 1} duplicated its immediate predecessor marker`);
      const nonceOccurrences = occurrences(call.prompt, acceptanceId);
      assert.ok(nonceOccurrences >= 1 && nonceOccurrences <= 3,
        `delegation ${index + 1} transported the acceptance ID inefficiently`);
      const priorFolded = foldMarkdownWrappedText(calls[index - 1].result);
      if (priorFolded.length > predecessor.length + 32) {
        assert.equal(foldMarkdownWrappedText(call.prompt).includes(priorFolded), false,
          `delegation ${index + 1} copied the complete prior response`);
      }
    }
    if (call.totalTokens !== undefined) {
      assert.ok(Number.isFinite(call.totalTokens) && call.totalTokens > 0,
        `delegation ${index + 1} recorded no model tokens`);
      assert.ok(call.totalTokens <= LIVE_CODEX_COMMUNICATION_BUDGET.maxChildTokens,
        `delegation ${index + 1} exceeded its token budget`);
    }
    if (call.totalToolCalls !== undefined) {
      assert.ok(Number.isSafeInteger(call.totalToolCalls) && call.totalToolCalls >= 0,
        `delegation ${index + 1} has invalid tool usage`);
      assert.ok(call.totalToolCalls <= LIVE_CODEX_COMMUNICATION_BUDGET.maxChildToolCalls,
        `delegation ${index + 1} exceeded its tool-call budget`);
    }
  }
  if (calls.some((call) => call.startedAt !== undefined || call.completedAt !== undefined)) {
    assert.equal(maxConcurrentDelegations(calls), 1, "delegations overlapped");
  }
  assert.ok(calls.reduce((sum, call) => sum + utf8Bytes(call.prompt), 0) <=
    LIVE_CODEX_COMMUNICATION_BUDGET.delegatedPromptBytes, "cycle exceeded its delegated-prompt budget");
  assert.ok(calls.reduce((sum, call) => sum + utf8Bytes(call.result), 0) <=
    LIVE_CODEX_COMMUNICATION_BUDGET.returnedEvidenceBytes, "cycle exceeded its returned-evidence budget");
}

export function assertLiveCodexFinal(finalText: string, expectedAgents = liveCodexExpectedAgents()): void {
  assert.ok(finalText.startsWith(expectedSequencePrefix(expectedAgents)), "lead final response has the wrong sequence prefix");
  assert.ok(utf8Bytes(finalText) <= LIVE_CODEX_COMMUNICATION_BUDGET.finalBytes,
    "lead final response exceeded its byte budget");
}

export function sanitizeLiveCodexDelegation(
  call: LiveCodexDelegation,
  acceptanceId: string,
  index: number,
  expectedAgents = liveCodexExpectedAgents(),
): SanitizedLiveCodexDelegation {
  assert.equal(call.agent, expectedAgents[index], "cannot sanitize a delegation in an unexpected position");
  const marker = handoffMarker(call.agent, acceptanceId);
  const predecessor = index > 0 ? handoffMarker(expectedAgents[index - 1], acceptanceId) : "";
  const allMarkerPattern = new RegExp(`HARBOR_HANDOFF:[a-z0-9-]+:${regexEscape(acceptanceId)}`, "gu");
  return {
    agent: call.agent,
    ...(call.invocationId ? { invocation: sanitizeValue(call.invocationId) } : {}),
    ...(call.childId ? { child: sanitizeValue(call.childId) } : {}),
    prompt: sanitizeValue(call.prompt),
    evidence: sanitizeValue(call.result),
    promptHandoff: {
      acceptanceIdOccurrences: occurrences(call.prompt, acceptanceId),
      predecessorMarkerOccurrences: predecessor ? occurrences(call.prompt, predecessor) : 0,
    },
    handoff: {
      exactOccurrences: occurrences(call.result, marker),
      allCycleMarkerOccurrences: call.result.match(allMarkerPattern)?.length ?? 0,
      standaloneFinalLine: normalizedLastLine(call.result) === marker,
    },
    ...(call.startedAt !== undefined && call.completedAt !== undefined
      ? { durationMs: call.completedAt - call.startedAt }
      : {}),
    ...(call.totalTokens === undefined ? {} : { totalTokens: call.totalTokens }),
    ...(call.totalToolCalls === undefined ? {} : { totalToolCalls: call.totalToolCalls }),
  };
}

function lifecycleKind(input: Readonly<Record<string, unknown>>, label: string): string {
  const value = optionalString(input.kind) ?? optionalString(input.phase) ?? optionalString(input.type);
  assert.ok(value, `${label} has no kind, phase, or type`);
  return value;
}

function lifecycleAgent(input: Readonly<Record<string, unknown>>): string | undefined {
  return optionalString(input.agent) ?? optionalString(input.agentId) ?? optionalString(input.agentName) ??
    optionalString(nestedValue(input, ["data", "agent"])) ?? optionalString(nestedValue(input, ["data", "agentId"])) ??
    optionalString(nestedValue(input, ["properties", "agent"])) ??
    optionalString(nestedValue(input, ["properties", "info", "agent"]));
}

function lifecycleIdentity(input: Readonly<Record<string, unknown>>): string | undefined {
  return optionalString(input.childId) ?? optionalString(input.invocationId) ?? optionalString(input.sessionId) ??
    optionalString(input.sessionID) ?? optionalString(input.toolCallId) ?? optionalString(input.callID) ??
    optionalString(nestedValue(input, ["data", "childId"])) ?? optionalString(nestedValue(input, ["data", "toolCallId"])) ??
    optionalString(nestedValue(input, ["properties", "sessionID"])) ??
    optionalString(nestedValue(input, ["properties", "info", "id"]));
}

function lifecycleModel(input: Readonly<Record<string, unknown>>): { provider?: string; model?: string } {
  const modelObject = input.model && typeof input.model === "object" && !Array.isArray(input.model)
    ? input.model as Record<string, unknown>
    : undefined;
  return {
    provider: optionalString(input.provider) ?? optionalString(input.providerID) ??
      optionalString(modelObject?.provider) ?? optionalString(modelObject?.providerID) ??
      optionalString(nestedValue(input, ["data", "provider"])) ??
      optionalString(nestedValue(input, ["properties", "info", "providerID"])),
    model: optionalString(input.modelId) ?? optionalString(input.modelID) ?? optionalString(modelObject?.id) ??
      optionalString(modelObject?.modelId) ?? optionalString(modelObject?.modelID) ??
      (typeof input.model === "string" ? input.model : undefined) ??
      optionalString(nestedValue(input, ["data", "model"])) ??
      optionalString(nestedValue(input, ["properties", "info", "modelID"])),
  };
}

export function observedLifecycleTokens(input: Readonly<Record<string, unknown>>): number | undefined {
  const direct = finiteNonNegative(input.totalTokens);
  if (direct !== undefined) return direct;
  const candidates = [
    input.usage,
    input.tokens,
    nestedValue(input, ["data", "usage"]),
    nestedValue(input, ["data", "tokens"]),
    nestedValue(input, ["message", "usage"]),
    nestedValue(input, ["properties", "info", "tokens"]),
  ]
    .filter((value): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value));
  for (const usage of candidates) {
    const total = finiteNonNegative(usage.totalTokens) ?? finiteNonNegative(usage.total);
    if (total !== undefined) return total;
    const tokenNamed = ["inputTokens", "outputTokens"]
      .map((key) => finiteNonNegative(usage[key])).filter((value): value is number => value !== undefined);
    if (tokenNamed.length) return tokenNamed.reduce((sum, value) => sum + value, 0);
    const components = ["input", "output", "cacheRead", "cacheWrite"]
      .map((key) => finiteNonNegative(usage[key])).filter((value): value is number => value !== undefined);
    if (components.length) return components.reduce((sum, value) => sum + value, 0);
  }
  return undefined;
}

function lifecycleRecords(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const input = objectAt(value, "lifecycle evidence envelope");
  for (const key of ["events", "records", "evidence", "trace"] as const) {
    if (Array.isArray(input[key])) return input[key] as unknown[];
  }
  return [input];
}

export function parseLifecycleEvidence(input: string | unknown): LiveLifecycleRecord[] {
  let values: unknown[];
  if (typeof input === "string") {
    const trimmed = input.trim();
    assert.ok(trimmed, "lifecycle evidence is empty");
    if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
      try { values = lifecycleRecords(JSON.parse(trimmed)); }
      catch (wholeDocumentError) {
        if (!trimmed.includes("\n")) throw wholeDocumentError;
        values = trimmed.split(/\r?\n/gu).filter((line) => line.trim()).map((line, index) => {
          try { return JSON.parse(line); }
          catch (error) { throw new Error(`invalid lifecycle JSONL at line ${index + 1}`, { cause: error }); }
        });
      }
    } else {
      values = trimmed.split(/\r?\n/gu).filter((line) => line.trim()).map((line, index) => {
        try { return JSON.parse(line); }
        catch (error) { throw new Error(`invalid lifecycle JSONL at line ${index + 1}`, { cause: error }); }
      });
    }
  } else {
    values = lifecycleRecords(input);
  }
  return values.map((value, index) => {
    const raw = objectAt(value, `lifecycle record ${index + 1}`);
    const model = lifecycleModel(raw);
    return {
      index,
      kind: lifecycleKind(raw, `lifecycle record ${index + 1}`),
      harness: optionalString(raw.harness) ?? optionalString(nestedValue(raw, ["data", "harness"])),
      agent: lifecycleAgent(raw),
      identity: lifecycleIdentity(raw),
      provider: model.provider,
      model: model.model,
      totalTokens: observedLifecycleTokens(raw),
      raw: structuredClone(raw),
    };
  });
}

export function assertNoLifecycleFailures(
  records: readonly LiveLifecycleRecord[],
  failureKinds: readonly string[] = ["child.failed", "delegation.failed", "model.failed", "session.error", "error"],
): void {
  const failures = new Set(failureKinds);
  assert.equal(records.some((record) => failures.has(record.kind)), false, "lifecycle evidence contains a failure event");
  assert.equal(records.some((record) => record.raw.outcome === "error" || record.raw.status === "failed"), false,
    "lifecycle evidence contains a failed outcome");
}

export function assertLifecycleAgentOrder(
  records: readonly LiveLifecycleRecord[],
  kind: string,
  expectedAgents: readonly string[],
): void {
  const matching = records.filter((record) => record.kind === kind);
  assert.deepEqual(matching.map((record) => record.agent), expectedAgents,
    `lifecycle ${kind} events have the wrong agent order`);
}

export function assertLifecyclePairs(records: readonly LiveLifecycleRecord[], options: LifecyclePairOptions): void {
  const identity = options.identity ?? ((record: LiveLifecycleRecord) => record.identity);
  const starts = records.filter((record) => record.kind === options.startKind);
  const ends = records.filter((record) => record.kind === options.endKind);
  assert.equal(starts.length, ends.length, `${options.startKind}/${options.endKind} counts differ`);
  const endByIdentity = new Map<string, LiveLifecycleRecord>();
  for (const end of ends) {
    const id = identity(end);
    assert.ok(id, `${options.endKind} event has no identity`);
    assert.equal(endByIdentity.has(id), false, `${options.endKind} identity is duplicated`);
    endByIdentity.set(id, end);
  }
  const startIdentities = new Set<string>();
  for (const start of starts) {
    const id = identity(start);
    assert.ok(id, `${options.startKind} event has no identity`);
    assert.equal(startIdentities.has(id), false, `${options.startKind} identity is duplicated`);
    startIdentities.add(id);
    const end = endByIdentity.get(id);
    assert.ok(end, `${options.startKind} event has no matching ${options.endKind}`);
    assert.ok(end.index > start.index, `${options.endKind} occurred before ${options.startKind}`);
  }
}

export function assertLifecycleModels(
  records: readonly LiveLifecycleRecord[],
  expectation: LifecycleModelExpectation,
): void {
  const modelRecords = records.filter((record) => expectation.kind === undefined
    ? record.provider !== undefined || record.model !== undefined
    : record.kind === expectation.kind);
  assert.ok(modelRecords.length > 0, "lifecycle evidence contains no model records");
  assert.ok(modelRecords.every((record) => record.provider === expectation.provider),
    "lifecycle evidence used an unexpected provider");
  assert.ok(modelRecords.every((record) => record.model === expectation.model),
    "lifecycle evidence used an unexpected model");
  if (expectation.agents) {
    for (const agent of expectation.agents) {
      assert.ok(modelRecords.some((record) => record.agent === agent), `lifecycle evidence contains no model record for ${agent}`);
    }
  }
  if (expectation.requirePositiveUsage ?? true) {
    assert.ok(modelRecords.every((record) => (record.totalTokens ?? 0) > 0),
      "a lifecycle model record contains no observed tokens");
  }
}

export function parseLiveCodexReport(input: string | unknown): LiveCodexReportEnvelope {
  let value: unknown = input;
  if (typeof input === "string") {
    try { value = JSON.parse(input); }
    catch (error) { throw new Error("live Codex report is invalid JSON", { cause: error }); }
  }
  const report = objectAt(value, "live Codex report");
  assert.equal(typeof report.schema, "string", "live Codex report schema is missing");
  assert.ok(report.status === "passed" || report.status === "failed", "live Codex report status is invalid");
  assert.equal(typeof report.generatedAt, "string", "live Codex report timestamp is missing");
  assert.ok(liveCodexHarnesses.includes(report.harness as LiveCodexHarness), "live Codex report harness is invalid");
  assert.equal(typeof report.provider, "string", "live Codex report provider is missing");
  assert.equal(typeof report.model, "string", "live Codex report model is missing");
  const expectedAgents = stringArray(report.expectedAgents, "live Codex report expectedAgents");
  const observedAgents = stringArray(report.observedAgents, "live Codex report observedAgents");
  return { ...report, expectedAgents, observedAgents } as LiveCodexReportEnvelope;
}

export function reportObservedTokens(report: LiveCodexReportEnvelope): number | undefined {
  const paths = [
    ["communicationEfficiency", "observed", "totalObservedTokens"],
    ["nativeUsage", "total", "totalTokens"],
    ["nativeUsage", "totalTokens"],
    ["usage", "totalTokens"],
    ["totalObservedTokens"],
  ] as const;
  for (const path of paths) {
    const value = finiteNonNegative(nestedValue(report, path));
    if (value !== undefined) return value;
  }
  return undefined;
}

export function assertPassedLiveCodexReport(
  reportInput: LiveCodexReportEnvelope | string | unknown,
  expectation: LiveCodexReportExpectation,
): LiveCodexReportEnvelope {
  const report = parseLiveCodexReport(reportInput);
  assert.equal(report.schema, expectation.schema ?? LIVE_CODEX_REPORT_SCHEMA, "live Codex report schema is invalid");
  assert.equal(report.status, "passed", "live Codex report status is not passed");
  assert.equal(report.harness, expectation.harness, "live Codex report harness is unexpected");
  assert.equal(report.provider, expectation.provider, "live Codex report provider is unexpected");
  assert.equal(report.model, expectation.model, "live Codex report model is unexpected");
  assert.deepEqual(report.expectedAgents, expectation.expectedAgents, "live Codex report expected order changed");
  assert.deepEqual(report.observedAgents, expectation.expectedAgents, "live Codex report observed order is wrong");
  assert.match(report.generatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u,
    "live Codex report timestamp is invalid");
  const generatedAt = Date.parse(report.generatedAt);
  const now = expectation.now ?? Date.now();
  assert.ok(Number.isFinite(generatedAt) && generatedAt <= now + 5_000, "live Codex report timestamp is invalid");
  if (expectation.startedAt !== undefined) {
    assert.ok(generatedAt >= expectation.startedAt - 1_000, "live Codex report is stale");
  } else {
    assert.ok(generatedAt >= now - (expectation.maxAgeMs ?? 24 * 60 * 60_000), "live Codex report is too old");
  }
  if (expectation.requirePositiveTokens ?? true) {
    assert.ok((reportObservedTokens(report) ?? 0) > 0, "live Codex report contains no observed model tokens");
  }
  assert.ok(report.failure === undefined || report.failure === null, "passed live Codex report contains a failure");
  assert.ok(report.cleanup === undefined || report.cleanup === null ||
    (Array.isArray(report.cleanup) && report.cleanup.length === 0), "passed live Codex report contains cleanup failures");
  if (expectation.rawValues) assertNoRawValues(report, expectation.rawValues);
  return report;
}
