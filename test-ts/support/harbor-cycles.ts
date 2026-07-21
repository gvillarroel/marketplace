import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const harborHarnesses = ["copilot", "opencode", "pi"] as const;
export type HarborHarness = (typeof harborHarnesses)[number];

export interface HarborRuntimeIds {
  readonly copilot: string;
  readonly opencode: string;
  readonly pi: string;
}

export interface HarborDatasetPlayer {
  readonly id: string;
  readonly runtimeIds: HarborRuntimeIds;
}

export interface HarborCycleStep {
  readonly agent: string;
  readonly task: string;
  readonly evidenceFrom: string | null;
}

export interface HarborCycle {
  readonly id: string;
  readonly coordinator: "team-lead";
  readonly activate: readonly string[];
  readonly steps: readonly HarborCycleStep[];
}

export interface HarborCycleDataset {
  readonly schemaVersion: 1;
  readonly roster: {
    readonly fixed: readonly HarborDatasetPlayer[];
    readonly bundled: readonly HarborDatasetPlayer[];
  };
  readonly cycles: readonly HarborCycle[];
}

const playerIdPattern = /^[a-z0-9][a-z0-9-]{0,47}$/;
const runtimeIdPattern = /^[a-z0-9][a-z0-9-]{0,47}(?::[a-z0-9][a-z0-9-]{0,47})?$/;
const canonicalFixedIds = ["team-lead", "crafter"] as const;
const canonicalBundledIds = ["portfolio-management", "design", "build", "manage", "consume", "dispose"] as const;
const canonicalCycles = {
  "default-specialists": ["crafter"],
  "full-sdlc": canonicalBundledIds,
} as const;

function fail(path: string, message: string): never {
  throw new Error(`invalid Agent Harbor cycle dataset at ${path}: ${message}`);
}

function objectAt(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(path, "expected an object");
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], path: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(path, `expected exactly keys ${wanted.join(", ")}; received ${actual.join(", ") || "none"}`);
  }
}

function arrayAt(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) fail(path, "expected an array");
  return value;
}

function stringAt(value: unknown, path: string, pattern = playerIdPattern): string {
  if (typeof value !== "string" || !pattern.test(value)) fail(path, `invalid string: ${String(value)}`);
  return value;
}

function unique(values: readonly string[], path: string): void {
  if (new Set(values).size !== values.length) fail(path, "duplicate IDs are not allowed");
}

function sameSequence(actual: readonly string[], expected: readonly string[], path: string): void {
  if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
    fail(path, `expected ${expected.join(" -> ")}; received ${actual.join(" -> ")}`);
  }
}

function parseRuntimeIds(value: unknown, path: string): HarborRuntimeIds {
  const input = objectAt(value, path);
  exactKeys(input, harborHarnesses, path);
  return {
    copilot: stringAt(input.copilot, `${path}.copilot`, runtimeIdPattern),
    opencode: stringAt(input.opencode, `${path}.opencode`, runtimeIdPattern),
    pi: stringAt(input.pi, `${path}.pi`, runtimeIdPattern),
  };
}

function parsePlayers(value: unknown, path: string): HarborDatasetPlayer[] {
  return arrayAt(value, path).map((candidate, index) => {
    const itemPath = `${path}[${index}]`;
    const input = objectAt(candidate, itemPath);
    exactKeys(input, ["id", "runtimeIds"], itemPath);
    return {
      id: stringAt(input.id, `${itemPath}.id`),
      runtimeIds: parseRuntimeIds(input.runtimeIds, `${itemPath}.runtimeIds`),
    };
  });
}

function validateRuntimeIdentities(players: readonly HarborDatasetPlayer[]): void {
  for (const harness of harborHarnesses) {
    const ids = players.map((player) => player.runtimeIds[harness]);
    unique(ids, `roster runtime IDs for ${harness}`);
  }
  for (const player of players) {
    if (player.runtimeIds.opencode !== player.id) fail(`roster.${player.id}.runtimeIds.opencode`, "must equal the logical ID");
    if (player.runtimeIds.pi !== player.id) fail(`roster.${player.id}.runtimeIds.pi`, "must equal the logical ID");
    if (canonicalBundledIds.includes(player.id as (typeof canonicalBundledIds)[number]) && player.runtimeIds.copilot !== player.id) {
      fail(`roster.${player.id}.runtimeIds.copilot`, "bundled runtime ID must equal the logical ID");
    }
  }
}

function parseCycle(value: unknown, index: number, knownIds: ReadonlySet<string>, bundledIds: ReadonlySet<string>): HarborCycle {
  const path = `cycles[${index}]`;
  const input = objectAt(value, path);
  exactKeys(input, ["id", "coordinator", "activate", "steps"], path);
  const id = stringAt(input.id, `${path}.id`);
  const coordinator = stringAt(input.coordinator, `${path}.coordinator`);
  if (coordinator !== "team-lead") fail(`${path}.coordinator`, "expected team-lead");
  const activate = arrayAt(input.activate, `${path}.activate`).map((candidate, activationIndex) =>
    stringAt(candidate, `${path}.activate[${activationIndex}]`));
  unique(activate, `${path}.activate`);
  for (const agent of activate) if (!bundledIds.has(agent)) fail(`${path}.activate`, `cannot activate non-bundled agent ${agent}`);

  const rawSteps = arrayAt(input.steps, `${path}.steps`);
  if (rawSteps.length < 1 || rawSteps.length > 6) fail(`${path}.steps`, "a cycle requires between one and six steps");
  const steps = rawSteps.map((candidate, stepIndex) => {
    const stepPath = `${path}.steps[${stepIndex}]`;
    const step = objectAt(candidate, stepPath);
    exactKeys(step, ["agent", "task", "evidenceFrom"], stepPath);
    const agent = stringAt(step.agent, `${stepPath}.agent`);
    if (!knownIds.has(agent)) fail(`${stepPath}.agent`, `unknown agent ${agent}`);
    if (agent === "team-lead") fail(`${stepPath}.agent`, "team-lead cannot be a cycle child");
    if (typeof step.task !== "string" || !step.task.trim() || step.task.length > 30_000) fail(`${stepPath}.task`, "expected a non-empty bounded task");
    const evidenceFrom = step.evidenceFrom === null
      ? null
      : stringAt(step.evidenceFrom, `${stepPath}.evidenceFrom`);
    return { agent, task: step.task, evidenceFrom };
  });

  unique(steps.map((step) => step.agent), `${path}.steps`);
  for (const [stepIndex, step] of steps.entries()) {
    const expected = stepIndex === 0 ? null : steps[stepIndex - 1].agent;
    if (step.evidenceFrom !== expected) {
      fail(`${path}.steps[${stepIndex}].evidenceFrom`, `expected ${expected ?? "null"}; received ${step.evidenceFrom ?? "null"}`);
    }
    if (bundledIds.has(step.agent) && !activate.includes(step.agent)) {
      fail(`${path}.steps[${stepIndex}].agent`, `bundled agent ${step.agent} is not activated by this cycle`);
    }
  }
  return { id, coordinator, activate, steps };
}

export function loadHarborCycleDataset(
  path = fileURLToPath(new URL("../fixtures/harbor-cycles.json", import.meta.url)),
): HarborCycleDataset {
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { throw new Error(`could not load Agent Harbor cycle dataset ${path}`, { cause: error }); }

  const root = objectAt(parsed, "root");
  exactKeys(root, ["schemaVersion", "roster", "cycles"], "root");
  if (root.schemaVersion !== 1) fail("root.schemaVersion", "expected 1");

  const roster = objectAt(root.roster, "roster");
  exactKeys(roster, ["fixed", "bundled"], "roster");
  const fixed = parsePlayers(roster.fixed, "roster.fixed");
  const bundled = parsePlayers(roster.bundled, "roster.bundled");
  sameSequence(fixed.map((player) => player.id), canonicalFixedIds, "roster.fixed");
  sameSequence(bundled.map((player) => player.id), canonicalBundledIds, "roster.bundled");
  const players = [...fixed, ...bundled];
  unique(players.map((player) => player.id), "roster");
  validateRuntimeIdentities(players);

  const knownIds = new Set(players.map((player) => player.id));
  const bundledIds = new Set(bundled.map((player) => player.id));
  const cycles = arrayAt(root.cycles, "cycles").map((cycle, index) => parseCycle(cycle, index, knownIds, bundledIds));
  unique(cycles.map((cycle) => cycle.id), "cycles");
  for (const [id, expected] of Object.entries(canonicalCycles)) {
    const cycle = cycles.find((candidate) => candidate.id === id);
    if (!cycle) fail("cycles", `required cycle missing: ${id}`);
    sameSequence(cycle.steps.map((step) => step.agent), expected, `cycles.${id}.steps`);
    sameSequence(cycle.activate, id === "full-sdlc" ? canonicalBundledIds : [], `cycles.${id}.activate`);
  }

  return { schemaVersion: 1, roster: { fixed, bundled }, cycles };
}
