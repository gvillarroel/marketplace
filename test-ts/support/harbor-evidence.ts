import assert from "node:assert/strict";
import {
  HARBOR_EVIDENCE_SCHEMA,
  fingerprintHarborEvidence,
  type HarborEvidenceEvent,
  type HarborEvidenceHook,
  type HarborEvidencePhase,
} from "../../src/core/evidence.js";
import type { HarborCycle, HarborCycleDataset, HarborHarness } from "./harbor-cycles.js";

export type HarborSdkWitnessPhase = "child.started" | "prompt.sent" | "evidence.returned" | "child.cleaned";

export interface HarborSdkWitness {
  readonly phase: HarborSdkWitnessPhase;
  readonly agent: string;
  readonly runtimeAgent: string;
  readonly childId: string;
  readonly fingerprint?: ReturnType<typeof fingerprintHarborEvidence>;
}

export interface HarborCycleExecution {
  readonly agent: string;
  readonly task: string;
  readonly evidence: string;
}

const successfulHookPhases: readonly HarborEvidencePhase[] = [
  "target.resolved",
  "child.started",
  "prompt.attempted",
  "evidence.returned",
  "child.completed",
  "child.cleaned",
];

const successfulSdkPhases: readonly HarborSdkWitnessPhase[] = [
  "child.started",
  "prompt.sent",
  "evidence.returned",
  "child.cleaned",
];

const evidenceEventKeys = new Set([
  "schema", "source", "basis", "phase", "harness", "agent", "runtimeAgent",
  "parentSessionId", "childId", "invocationId", "outcome", "task", "evidence", "error",
]);

export function assertHarborEvidenceMetadataOnly(
  events: readonly HarborEvidenceEvent[],
  rawValues: readonly string[],
): void {
  const serialized = JSON.stringify(events);
  for (const value of rawValues.filter(Boolean)) assert.ok(!serialized.includes(value), "raw task, evidence, or error leaked into trace");
  for (const event of events) {
    assert.ok(Object.keys(event).every((key) => evidenceEventKeys.has(key)), `unexpected evidence field in ${event.phase}`);
    for (const fingerprint of [event.task, event.evidence, event.error].filter(Boolean)) {
      assert.deepEqual(Object.keys(fingerprint!).sort(), ["sha256", "utf8Bytes"]);
    }
  }
}

export class HarborEvidenceCollector {
  readonly hookEvents: HarborEvidenceEvent[] = [];
  readonly sdkWitnesses: HarborSdkWitness[] = [];
  readonly hook: HarborEvidenceHook = (event) => { this.hookEvents.push(structuredClone(event)); };

  constructor(
    readonly harness: HarborHarness,
    readonly cycleId: string,
  ) {}

  witness(event: HarborSdkWitness): void {
    this.sdkWitnesses.push(structuredClone(event));
  }

  assertSuccessfulCycle(
    dataset: HarborCycleDataset,
    cycle: HarborCycle,
    executions: readonly HarborCycleExecution[],
  ): void {
    assert.equal(cycle.id, this.cycleId);
    assert.deepEqual(executions.map((entry) => entry.agent), cycle.steps.map((step) => step.agent));
    assert.deepEqual(
      this.hookEvents.map((event) => `${event.agent}:${event.phase}`),
      cycle.steps.flatMap((step) => successfulHookPhases.map((phase) => `${step.agent}:${phase}`)),
      `${this.harness}/${cycle.id} hook trace must be complete and sequential`,
    );
    const startedChildIds = this.hookEvents
      .filter((event) => event.phase === "child.started")
      .map((event) => event.childId);
    assert.ok(startedChildIds.every((childId) => typeof childId === "string" && childId.length > 0));
    assert.equal(new Set(startedChildIds).size, cycle.steps.length, `${this.harness}/${cycle.id} must use one unique child per stage`);
    assert.deepEqual(
      this.sdkWitnesses.map((event) => `${event.agent}:${event.phase}`),
      cycle.steps.flatMap((step) => successfulSdkPhases.map((phase) => `${step.agent}:${phase}`)),
      `${this.harness}/${cycle.id} SDK trace must be complete and sequential`,
    );

    const players = [...dataset.roster.fixed, ...dataset.roster.bundled];
    for (const [index, execution] of executions.entries()) {
      const player = players.find((candidate) => candidate.id === execution.agent);
      assert.ok(player, `dataset player missing: ${execution.agent}`);
      const expectedRuntime = player.runtimeIds[this.harness];
      const hookEvents = this.hookEvents.slice(index * successfulHookPhases.length, (index + 1) * successfulHookPhases.length);
      const sdkEvents = this.sdkWitnesses.slice(index * successfulSdkPhases.length, (index + 1) * successfulSdkPhases.length);
      const childIds = new Set([...hookEvents, ...sdkEvents].map((event) => event.childId).filter(Boolean));

      assert.equal(childIds.size, 1, `${this.harness}/${cycle.id}/${execution.agent} must correlate one child`);
      assert.ok(hookEvents.every((event) => event.schema === HARBOR_EVIDENCE_SCHEMA));
      assert.ok(hookEvents.every((event) => event.source === "adapter-hook"));
      assert.ok(hookEvents.every((event) => event.basis === "observed"));
      assert.ok(hookEvents.every((event) => event.harness === this.harness));
      assert.ok(hookEvents.every((event) => event.agent === execution.agent));
      assert.ok(hookEvents.every((event) => event.runtimeAgent === expectedRuntime));
      assert.ok(hookEvents.every((event) => event.outcome === "ok"));
      assert.ok(sdkEvents.every((event) => event.agent === execution.agent && event.runtimeAgent === expectedRuntime));

      assert.deepEqual(hookEvents[0].task, fingerprintHarborEvidence(execution.task));
      assert.deepEqual(hookEvents[3].evidence, fingerprintHarborEvidence(execution.evidence));
      assert.ok((hookEvents[3].evidence?.utf8Bytes ?? 0) > 0, "a completed stage must return non-empty evidence");
      assert.deepEqual(sdkEvents[1].fingerprint, fingerprintHarborEvidence(execution.task));
      assert.deepEqual(sdkEvents[2].fingerprint, fingerprintHarborEvidence(execution.evidence));

      const predecessor = cycle.steps[index].evidenceFrom;
      if (predecessor) {
        const priorEvidence = executions[index - 1].evidence;
        assert.match(execution.task, new RegExp(priorEvidence.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      }
    }
    assertHarborEvidenceMetadataOnly(
      this.hookEvents,
      executions.flatMap((execution) => [execution.task, execution.evidence]),
    );
  }
}
