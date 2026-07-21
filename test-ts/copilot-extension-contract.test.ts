import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

const root = join(import.meta.dirname, "..");
const extensionPath = join(root, "plugins", "agent-foundry", "extensions", "agent-harbor", "extension.mjs");

test("Copilot extension exposes zero-model team controls and one explicit native send path", async () => {
  const source = await readFile(extensionPath, "utf8");
  assert.match(source, /name: "team"/u);
  assert.match(source, /name: "player"/u);
  assert.match(source, /0 model tokens · \/team/u);
  assert.match(source, /\/player <id> <task>/u);
  assert.equal(source.match(/session\.send\(/gu)?.length, 1);
  assert.doesNotMatch(source, /sendAndWait/u);
  assert.doesNotMatch(source, /createSession|\.prompt\(/u);

  const runStart = source.indexOf("async function runPlayer");
  const runEnd = source.indexOf("\nfunction mapLifecycleState", runStart);
  assert.ok(runStart >= 0 && runEnd > runStart);
  const runner = source.slice(runStart, runEnd);
  assert.ok(runner.indexOf("session.on((event)") < runner.indexOf("session.send({ prompt: task })"),
    "terminal and usage listeners must be attached before the prompt is accepted");
  assert.match(runner, /Promise\.race\(\[terminal\.promise, delay\(directTimeoutMs/u);
  assert.match(runner, /await abort\(\)/u);
  assert.match(runner, /delay\(abortSettlementMs/u);
  assert.match(runner, /selection is retained until Copilot reports idle or error/u);
  assert.match(runner, /if \(!lateSettlement\)[\s\S]*unsubscribe\(\)[\s\S]*restoreSelection\(previous\)/u);
  assert.match(runner, /AggregateError\([\s\S]*primaryFailure[\s\S]*restoreError/u);
});

test("Copilot extension scopes native lifecycle and child admission to the event project", async () => {
  const source = await readFile(extensionPath, "utf8");
  assert.match(source, /project: event\.project/u);
  assert.match(source, /createCopilotCoordinatorGuard\([\s\S]*lifecycleHook, \(input\) =>/u);
  assert.match(source, /runtime\.begin\(\{[\s\S]*project: input\.project[\s\S]*parentRunId[\s\S]*correlationRuns\.set\(input\.runId, runId\)/u);
  assert.match(source, /event\.reasoningEffort === null \? "none"/u);
  assert.match(source, /event\.outcome === "cancelled"\) runtime\.finishIfOpen\(runId, "cancelled"\)/u);
  assert.match(source, /wrapPlainText\(message\)/u);
});
