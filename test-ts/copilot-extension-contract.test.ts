import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

const root = join(import.meta.dirname, "..");
const extensionPath = join(root, "plugins", "agent-foundry", "extensions", "agent-harbor", "extension.mjs");
const contractSkillPath = join(root, "plugins", "agent-foundry", "skills", "contract", "SKILL.md");

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
  assert.match(runner, /selection is retained until Copilot reports a terminal event/u);
  assert.match(runner, /if \(!lateSettlement\)[\s\S]*unsubscribe\(\)[\s\S]*restoreSelection\(previous\)/u);
  assert.match(runner, /AggregateError\([\s\S]*primaryFailure[\s\S]*restoreError/u);
});

test("Copilot extension fixes a minimal native custom-tool union at startup", async () => {
  const source = await readFile(extensionPath, "utf8");
  assert.match(source, /const startupSkillPlayers = new Map\(rolePlayers\)/u);
  assert.match(source, /for \(const id of startupActiveIds\)[\s\S]*requireInvocablePlayer\("copilot", process\.cwd\(\), id\)/u);
  assert.match(source, /const copilotNativeTools = \[[\s\S]*harborCustomToolNames\.contractPreflight[\s\S]*harborCustomToolNames\.teamRoster[\s\S]*harborCustomToolNames\.filterSkills[\s\S]*harborCustomToolNames\.joinPlayer/u);
  assert.match(source, /startupSkillPlayers\.values\(\)[\s\S]*filter\(\(player\) => player\.skills\?\.length\)[\s\S]*harborPlayerSkillToolSpec\(player\)/u);
  assert.match(source, /joinSession\(\{\s*tools: copilotNativeTools,/u);
  assert.doesNotMatch(source, /harborCustomToolNames\.delegate/u);
});

test("Copilot contract skill exposes only its native preflight tool and cannot be model-invoked", async () => {
  const source = await readFile(contractSkillPath, "utf8");
  assert.match(source, /^allowed-tools: \["harbor_contract"\]$/mu);
  assert.match(source, /^user-invocable: true$/mu);
  assert.match(source, /^disable-model-invocation: true$/mu);
  assert.doesNotMatch(source, /^allowed-tools:.*\btask\b/mu);
});

test("Copilot contract authenticates its native handler before permitting one task", async () => {
  const source = await readFile(extensionPath, "utf8");
  const start = source.indexOf("async function contractNativeTool");
  const end = source.indexOf("\nasync function playerSkillsNativeTool", start);
  assert.ok(start >= 0 && end > start);
  const handler = source.slice(start, end);
  assert.match(handler, /authenticatedNativeToolContext\(name, args, invocation\)/u);
  assert.match(handler, /assertHarborCustomToolAccess\(name, \{ skill: "contract" \}\)/u);
  assert.match(handler, /validateHarborCustomToolArguments\(name, args\)/u);
  assert.match(handler, /runCopilotControl\("contract", call\.definition, context\.project, signal\)/u);
  assert.match(handler, /coordinator\.contractToolSucceeded\(exactInvocation, descriptor\)/u);
  assert.match(handler, /coordinator\.contractToolFailed\(failedInvocation\)/u);
});

test("Copilot extension scopes native lifecycle and child admission to the event project", async () => {
  const source = await readFile(extensionPath, "utf8");
  assert.match(source, /project: event\.project/u);
  assert.match(source, /createCopilotCoordinatorGuard\([\s\S]*lifecycleHook, \(input\) =>/u);
  assert.match(source, /const beginInput = \{[\s\S]*project,[\s\S]*parentRunId[\s\S]*beginSharedPersistentRun\(beginInput, "delegated"[\s\S]*correlationRuns\.set\(input\.runId, runId\)/u);
  assert.match(source, /event\.reasoningEffort === null \? "none"/u);
  assert.match(source, /event\.outcome === "cancelled"\) runtime\.finishIfOpen\(runId, "cancelled"\)/u);
  assert.match(source, /wrapPlainText\(message\)/u);
});

test("Copilot extension closes every late lifecycle and repeated-prompt path on a shared authority hazard", async () => {
  const source = await readFile(extensionPath, "utf8");
  const lifecycleStart = source.indexOf("function lifecycleHook");
  const lifecycleEnd = source.indexOf("\nconst maximumGuardEvidenceQueue", lifecycleStart);
  assert.ok(lifecycleStart >= 0 && lifecycleEnd > lifecycleStart);
  const lifecycle = source.slice(lifecycleStart, lifecycleEnd);

  assert.match(lifecycle,
    /event\.type === "root\.started"[\s\S]*assertNoSharedActivityProjectHazard\(event\.project\)[\s\S]*Copilot abort hazardous native root/u);
  assert.match(lifecycle,
    /event\.type === "child\.started"[\s\S]*assertNoSharedActivityProjectHazard\(event\.project\)[\s\S]*Copilot abort hazardous native child/u);
  assert.match(lifecycle,
    /runId = kind === "contractor"[\s\S]*runtime\.begin\(beginInput\)[\s\S]*beginSharedPersistentRun\(beginInput, "delegated"/u);
  assert.doesNotMatch(lifecycle,
    /if \(!runId\) \{\s*runId = runtime\.begin\(\{[\s\S]*event\.taskLabel/u);

  const admissionStart = source.indexOf("}, lifecycleHook, (input) =>");
  const admissionEnd = source.indexOf("\n});", admissionStart);
  assert.ok(admissionStart >= 0 && admissionEnd > admissionStart);
  const admission = source.slice(admissionStart, admissionEnd);
  assert.ok(admission.indexOf("assertNoSharedActivityProjectHazard(project)") < admission.indexOf('if (input.type === "root")'));

  assert.match(source,
    /const projectAuthorityCoordinatorHooks = \{[\s\S]*onUserPromptSubmitted\(input, invocation\)[\s\S]*assertNoSharedActivityProjectHazard\(project\)[\s\S]*coordinator\.hooks\.onUserPromptSubmitted/u);
  assert.match(source, /joinSession\(\{\s*tools: copilotNativeTools,\s*hooks: projectAuthorityCoordinatorHooks,/u);
});
