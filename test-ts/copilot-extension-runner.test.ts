import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const harness = join(root, "test-ts", "fixtures", "copilot-extension-runner-harness.mjs");

interface ScenarioResult {
  scenario: string;
  result: any;
  calls: Record<string, number>;
  logs: Array<{ message: string }>;
}

function runScenario(scenario: string): Promise<ScenarioResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [harness, scenario], {
      cwd: root,
      windowsHide: true,
      env: {
        ...process.env,
        AGENT_HARBOR_COPILOT_TIMEOUT_MS: "1000",
        AGENT_HARBOR_COPILOT_SETTLE_MS: "250",
        AGENT_HARBOR_COPILOT_RPC_TIMEOUT_MS: scenario === "send-timeout-buffered-terminal"
          ? "750"
          : scenario === "accepting-terminal-default" ? "15000" : "250",
        AGENT_HARBOR_COPILOT_LOG_TIMEOUT_MS: scenario === "log-hang-default" ? "3000" : "100",
        ...(scenario.startsWith("team-") && scenario !== "team-default-budget"
          ? { AGENT_HARBOR_COPILOT_TEAM_BUDGET_MS: "700" }
          : {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => { child.kill(); reject(new Error(`${scenario} timed out\n${stderr}`)); }, 10_000);
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) return reject(new Error(`${scenario} exited ${code}\n${stderr}\n${stdout}`));
      try { resolve(JSON.parse(stdout.trim().split(/\r?\n/u).at(-1)!)); }
      catch (error) { reject(new Error(`${scenario} emitted invalid JSON: ${String(error)}\n${stdout}\n${stderr}`)); }
    });
  });
}

function errorText(value: any): string {
  return [value?.name, value?.message, ...(value?.errors ?? []).map(errorText)].filter(Boolean).join(" | ");
}

function commonRosterRows(value: unknown): any[] {
  return String(value).split(/\r?\n/u).flatMap((line) => {
    if (!line.startsWith("{")) return [];
    return [JSON.parse(line)];
  });
}

test("Copilot registers a minimal deferred native-tool union with bound ownership and no MCP surface", async () => {
  const [native, cancellation, argumentMismatch] = await Promise.all([
    runScenario("native-custom-tools"),
    runScenario("native-tool-abort"),
    runScenario("native-argument-mismatch"),
  ]);
  assert.deepEqual(native.result.registrations.map(({ name }: { name: string }) => name), [
    "harbor_contract",
    "harbor_team_roster",
    "harbor_filter_skills",
    "harbor_join_player",
    "harbor_skill_crafter",
  ]);
  assert.deepEqual(native.result.registrations.map(({ defer }: { defer: string }) => defer), [
    "never", "auto", "auto", "auto", "auto",
  ]);
  assert.ok(native.result.registrations.every(({ parameters }: any) =>
    parameters?.type === "object" && parameters.additionalProperties === false));
  assert.equal(native.result.hasMcpHook, false);
  assert.equal(native.result.hasMcpServers, false);
  assert.equal(native.result.crafter.ok, true);
  assert.equal(native.result.scout.ok, true);
  assert.equal(native.calls.send, 2);

  const tools = native.result.nativeToolResults;
  assert.equal(tools.boundPlayerRejectsModelId.ok, false);
  assert.match(errorText(tools.boundPlayerRejectsModelId.error), /closed schema/u);
  assert.equal(tools.scoutWrongSession.ok, false);
  assert.match(errorText(tools.scoutWrongSession.error), /invalid Copilot invocation identity/u);
  assert.equal(tools.scoutJoinBeforeRoster.ok, false);
  assert.match(errorText(tools.scoutJoinBeforeRoster.error), /requires one successful complete harbor_team_roster snapshot/u);
  assert.equal(tools.scoutFilterBeforeRoster.ok, false);
  assert.match(errorText(tools.scoutFilterBeforeRoster.error), /requires one successful complete harbor_team_roster snapshot/u);
  assert.equal(tools.scoutRoster.ok, true);
  const rosterRows = commonRosterRows(tools.scoutRoster.value);
  assert.ok(rosterRows.some(({ id, availability }: any) => id === "crafter" && availability === "ready"));
  assert.equal(rosterRows.some(({ id }: any) => id === "team-lead" || id === "talent-scout"), false);
  assert.equal(String(tools.scoutRoster.value).includes("agent-harbor-copilot-extension"), false);
  assert.equal(tools.scoutRosterAgain.ok, false);
  assert.match(errorText(tools.scoutRosterAgain.error), /harbor_team_roster may run exactly once/u);
  assert.equal(tools.scoutJoinBeforeFilter.ok, false);
  assert.match(errorText(tools.scoutJoinBeforeFilter.error), /requires a successful harbor_filter_skills call first/u);
  assert.equal(tools.scoutFilter.ok, true);
  assert.equal(tools.scoutConcurrentFilter.ok, false);
  assert.match(errorText(tools.scoutConcurrentFilter.error), /must run sequentially/u);
  assert.equal(tools.scoutJoin.ok, true);
  assert.match(String(tools.scoutJoin.value), /native-scouted joined.*registered in this project/u);
  assert.match(String(tools.scoutJoin.value), /Availability: verify with \/team member:native-scouted/u);
  assert.equal(tools.scoutJoinAgain.ok, false);
  assert.match(errorText(tools.scoutJoinAgain.error), /turn is terminal: join completed/u);

  assert.equal(native.result.joinWithSkills.ok, true);
  assert.match(native.result.joinWithSkillsOutput, /skills-reload-player stored.*pending Copilot reload/u);
  assert.match(native.result.joinWithSkillsOutput, /Configured skills require the extension tools registered at startup/u);
  assert.match(native.result.joinWithSkillsOutput, /Model: inherits the current Copilot host when run/u);
  assert.doesNotMatch(native.result.joinWithSkillsOutput, /ready in this project|Run now:/u);
  assert.equal(native.result.registrations.some(({ name }: { name: string }) =>
    name === "harbor_skill_skills-reload-player"), false);
  assert.equal(native.result.skillPlayerBeforeReload.ok, false);
  assert.match(errorText(native.result.skillPlayerBeforeReload.error), /native loader was not registered at startup.*reload Copilot/u);
  assert.equal(native.result.skillPlayerSendCount, 2, "missing skill loader reached a model prompt");
  assert.equal(native.result.benchSkillOff.ok, true);
  assert.equal(native.result.benchSkillOn.ok, true);
  assert.match(native.result.benchSkillOnOutput, /Native skill loader pending for skills-reload-player/u);
  assert.match(native.result.benchSkillOnOutput, /\/player stops before model use until\s+\/reload/u);

  assert.equal(cancellation.result.preTool?.permissionDecision, "allow");
  assert.equal(cancellation.result.aborted.ok, false);
  assert.match(errorText(cancellation.result.aborted.error), /AbortError|aborted|abort/u);
  assert.equal(cancellation.result.duplicate.ok, false);
  assert.match(errorText(cancellation.result.duplicate.error), /duplicate active native tool call ID/u);
  assert.equal(cancellation.result.retryAfterCleanup.ok, false);
  assert.doesNotMatch(errorText(cancellation.result.retryAfterCleanup.error), /duplicate active native tool call ID/u,
    "aborted native tool controller leaked after handler settlement");

  assert.equal(argumentMismatch.result.preTool?.permissionDecision, "allow");
  assert.equal(argumentMismatch.result.mismatch.ok, false);
  assert.match(errorText(argumentMismatch.result.mismatch.error), /handler arguments do not match its native invocation/u);
  assert.equal(argumentMismatch.calls.send, 0);
});

test("Copilot native tool rejections remove private causes at the host boundary", async () => {
  const run = await runScenario("native-private-tool-error");
  const failure = run.result.nativeToolResults.roster;
  const serialized = JSON.stringify(failure.error);

  assert.equal(run.result.invocation.ok, true);
  assert.equal(failure.ok, false);
  assert.match(errorText(failure.error), /native list failed at \[path\] with \[redacted\]/u);
  assert.equal(failure.error.cause, undefined);
  assert.doesNotMatch(serialized, /alice|private\.txt|abcdefghijklmnop/u);
});

test("Copilot talent scout inspects one bounded roster and can reuse ready capacity without recruiting", async () => {
  const reuse = await runScenario("scout-ready-reuse");
  assert.equal(reuse.result.invocation.ok, true);
  assert.equal(reuse.result.busyAdmission.permissionDecision, "allow");
  assert.equal(reuse.result.nativeToolResults.roster.ok, true);
  const rosterText = String(reuse.result.nativeToolResults.roster.value);
  const roster = commonRosterRows(rosterText);
  assert.match(rosterText, /^Complete enabled roster snapshot · 3\/3/mu);
  assert.equal(roster.some(({ id }: any) => id === "team-lead" || id === "talent-scout"), false,
    "the common specialist snapshot disclosed a manager or utility agent");
  assert.ok(roster.some(({ id, availability }: any) => id === "crafter" && availability === "busy"));
  assert.ok(roster.some(({ id, availability }: any) => id === "build" && availability === "ready"));
  const personal = roster.find(({ id }: any) => id === "path-bearing-reviewer");
  assert.ok(personal, "the bounded roster omitted an in-scope personal teammate");
  assert.equal(personal.availability, "ready");
  assert.match(personal.role, /\[path\]/u);
  assert.doesNotMatch(rosterText, /private|capacity\.ts/iu);
  assert.match(rosterText, /busy member is existing capacity, not permission to recruit a duplicate/u);
  assert.deepEqual(Object.keys(reuse.result.nativeToolResults), ["roster"]);
  assert.equal(reuse.calls.send, 1);
  assert.equal(reuse.logs.filter(({ message }) => /joined · personal/u.test(message)).length, 1,
    "the scout recruited another player after finding reusable ready capacity");
});

test("Copilot talent scout fails closed when its one roster inspection is truncated", async () => {
  const truncated = await runScenario("scout-truncated-roster");
  assert.equal(truncated.result.invocation.ok, true);
  assert.equal(truncated.result.nativeToolResults.roster.ok, true);
  const roster = String(truncated.result.nativeToolResults.roster.value);
  assert.match(roster, /Complete roster unavailable: 36 enabled specialists exceeds the 32-member model-facing limit/u);
  assert.match(roster, /No partial roster was disclosed and recruitment is blocked/u);
  assert.doesNotMatch(roster, /zz-sufficient-reviewer|aa-roster-filler|\{"id"/u,
    "the incomplete common snapshot disclosed partial member rows");
  assert.equal(truncated.result.nativeToolResults.filter.ok, false);
  assert.match(errorText(truncated.result.nativeToolResults.filter.error),
    /requires one successful complete harbor_team_roster snapshot/iu);
  assert.equal(truncated.result.nativeToolResults.join.ok, false);
  assert.match(errorText(truncated.result.nativeToolResults.join.error),
    /requires one successful complete harbor_team_roster snapshot/iu);
  assert.equal(truncated.result.blockedProfileExists, false,
    "an incomplete roster inspection allowed a duplicate recruitment mutation");
  assert.equal(truncated.result.nativeRosterToolCalls, 1, "the scout exceeded its one native roster inspection");
});

test("Copilot native tools cancel locally on every scoped terminal and preserve a post-commit join", async () => {
  const [sessionError, sessionIdle, sessionShutdown, matched, mismatched, stopped, precommit, postcommit] = await Promise.all([
    runScenario("native-tool-session-error"),
    runScenario("native-tool-session-idle"),
    runScenario("native-tool-session-shutdown"),
    runScenario("native-controller-scope-match"),
    runScenario("native-controller-scope-mismatch"),
    runScenario("native-controller-team-stop"),
    runScenario("native-precommit-join-stop"),
    runScenario("native-postcommit-join-abort"),
  ]);
  for (const terminal of [sessionError, sessionIdle, sessionShutdown]) {
    assert.equal(terminal.result.aborted.ok, false);
    assert.match(errorText(terminal.result.aborted.error), /AbortError|aborted|abort/u);
  }
  assert.equal(matched.result.nativeToolResults.roster.ok, false);
  assert.match(errorText(matched.result.nativeToolResults.roster.error), /AbortError|aborted|abort/u);
  assert.equal(matched.result.nativeToolResults.retryAfterAbortedRoster.ok, false);
  assert.match(errorText(matched.result.nativeToolResults.retryAfterAbortedRoster.error), /talent-scout turn is terminal/u,
    "a failed roster attempt could be retried beyond the scout's one-call contract");
  assert.equal(mismatched.result.nativeToolResults.roster.ok, true,
    "a terminal explicitly scoped to another session aborted this extension's native tool");
  assert.equal(stopped.result.stopped.ok, true);
  assert.equal(stopped.result.nativeToolResults.roster.ok, false);
  assert.match(errorText(stopped.result.nativeToolResults.roster.error), /AbortError|aborted|abort/u);
  assert.equal(stopped.calls.abort, 1);

  assert.equal(precommit.result.stopped.ok, true);
  assert.equal(precommit.result.nativeToolResults.join.ok, false);
  assert.match(errorText(precommit.result.nativeToolResults.join.error), /AbortError|aborted|abort/u);
  assert.equal(precommit.result.activeProfileExists, false,
    "a cancelled precommit native join mutated the active roster later");
  assert.equal(precommit.result.registrationExists, false,
    "a cancelled precommit native join mutated the persistent roster later");

  assert.equal(postcommit.result.nativeToolResults.roster.ok, true);
  assert.equal(postcommit.result.nativeToolResults.filter.ok, true);
  assert.equal(postcommit.result.nativeToolResults.join.ok, true,
    "a cancellation after the transaction boundary was reported as a failed join");
  assert.match(String(postcommit.result.nativeToolResults.join.value), /Roster commit preserved/u);
  assert.equal(postcommit.result.activeProfileExists, true);
  assert.equal(postcommit.result.registrationExists, true);
});

test("Copilot native ownership accepts normalized Windows/POSIX paths but rejects a different path", async () => {
  const [windows, posix, mismatch] = await Promise.all([
    runScenario("native-path-windows"),
    runScenario("native-path-posix"),
    runScenario("native-path-mismatch"),
  ]);
  assert.equal(windows.result.nativeToolResults.roster.ok, true);
  assert.equal(posix.result.nativeToolResults.roster.ok, true);
  assert.equal(mismatch.result.invocation.ok, false);
  assert.match(errorText(mismatch.result.invocation.error), /exact identity/u);
  assert.equal(mismatch.calls.send, 0);
  assert.equal(mismatch.result.nativeToolResults.roster, undefined);
});

test("Copilot startup discovery warns once and omitted profiles cannot be invoked", async () => {
  const discovery = await runScenario("startup-profile-diagnostics");
  assert.equal(discovery.result.startupWarnings.length, 1);
  assert.match(discovery.result.startupWarnings[0], /stopped after 512 directory entries/u);
  assert.match(discovery.result.startupWarnings[0], /Repair:/u);
  assert.equal(discovery.result.commandNames.includes("omitted-player"), false);
  assert.equal(discovery.result.blocked.ok, false);
  assert.match(errorText(discovery.result.blocked.error), /not admitted by this session's bounded startup discovery/u);
  assert.equal(discovery.calls.send, 0);
});

test("Copilot reuses an already-registered player skill loader after a same-ID replacement", async () => {
  const replacement = await runScenario("startup-skill-replace");
  assert.ok(replacement.result.registrations.includes("harbor_skill_startup-skilled"));
  assert.equal(replacement.result.joined.ok, true);
  assert.match(replacement.result.joinOutput, /startup-skilled joined · personal · registered in this project/u);
  assert.match(replacement.result.joinOutput, /Model: configured openai\/gpt-5-mini/u);
  assert.doesNotMatch(replacement.result.joinOutput, /pending Copilot reload|reload Copilot before invoking/u);
  assert.equal(replacement.result.player.ok, true);
  assert.equal(replacement.calls.send, 1);
});

test("Copilot direct runner bounds host hangs and preserves terminal/restore ordering", async () => {
  const [logging, sendLate, bufferedTerminal, selectHang, staleIdle, acceptanceIdle, restoreBlock] = await Promise.all([
    runScenario("log-hang"),
    runScenario("send-timeout-late"),
    runScenario("send-timeout-buffered-terminal"),
    runScenario("select-hang"),
    runScenario("stale-idle"),
    runScenario("acceptance-stale-idle"),
    runScenario("restore-block"),
  ]);

  assert.equal(logging.result.invocation.ok, false);
  assert.match(errorText(logging.result.invocation.error), /completed.*could not display.*report/u);
  assert.equal(logging.calls.send, 1);
  assert.equal(logging.calls.deselect, 1);
  assert.ok(logging.result.elapsedMs < 800, `bounded log calls took ${logging.result.elapsedMs}ms`);

  assert.equal(sendLate.result.invocation.ok, false);
  assert.match(errorText(sendLate.result.invocation.error), /selection is retained/u);
  assert.equal(sendLate.result.restoredAtReturn, 0, "selection restored before a terminal event");
  assert.equal(sendLate.result.restoredAfterLate, 1);
  assert.equal(sendLate.calls.abort, 1);
  assert.equal(sendLate.result.team.ok, true);
  assert.match(sendLate.result.teamOutput, /Selection gate: run copilot-run-1 is still settling/u);
  assert.match(sendLate.result.teamOutput, /Can delegate now: none/u);

  assert.equal(bufferedTerminal.result.invocation.ok, true,
    "a terminal observed before send timeout was discarded and left selection pinned");
  assert.equal(bufferedTerminal.calls.send, 1);
  assert.equal(bufferedTerminal.calls.abort, 0);
  assert.equal(bufferedTerminal.calls.deselect, 1);
  assert.ok(bufferedTerminal.result.elapsedMs < 950, `buffered terminal recovery took ${bufferedTerminal.result.elapsedMs}ms`);

  assert.equal(selectHang.result.invocation.ok, false);
  assert.match(errorText(selectHang.result.invocation.error), /player selection.*timed out/u);
  assert.match(errorText(selectHang.result.retry.error), /reload the Copilot session/u);
  assert.equal(selectHang.calls.send, 0);

  assert.equal(staleIdle.result.invocation.ok, true, "a stale pre-send idle settled the new run");
  assert.equal(staleIdle.calls.send, 1);
  assert.equal(staleIdle.calls.deselect, 1);

  assert.equal(acceptanceIdle.result.invocation.ok, true, "a stale idle during send acceptance settled the new run");
  assert.equal(acceptanceIdle.calls.send, 1);
  assert.equal(acceptanceIdle.result.restoredWhileActive, 0, "selection restored while accepted model work was still active");
  assert.equal(acceptanceIdle.calls.deselect, 1);

  assert.equal(restoreBlock.result.team.ok, true);
  assert.match(restoreBlock.result.teamOutput, /crafter · copilot-run-1 · cleaning/u,
    "the coordinator hid a direct run before selection restore completed");
  assert.match(restoreBlock.result.teamOutput, /Selection gate: direct run copilot-run-1 owns the Copilot session/u);
  assert.match(restoreBlock.result.teamOutput, /Can delegate now: none/u);
  assert.equal(restoreBlock.result.invocation.ok, true);
});

test("Copilot direct runner proves selection and restoration identities before reuse", async () => {
  const [selectResult, selectedCurrent, restoreIdentity, deselectIdentity] = await Promise.all([
    runScenario("select-result-mismatch"),
    runScenario("select-current-mismatch"),
    runScenario("restore-identity-mismatch"),
    runScenario("deselect-not-empty"),
  ]);

  assert.equal(selectResult.result.invocation.ok, false);
  assert.match(errorText(selectResult.result.invocation.error), /selection returned a different native identity/u);
  assert.equal(selectResult.calls.send, 0);

  assert.equal(selectedCurrent.result.invocation.ok, false);
  assert.match(errorText(selectedCurrent.result.invocation.error), /exact identity/u);
  assert.equal(selectedCurrent.calls.send, 0);

  assert.equal(restoreIdentity.result.invocation.ok, false);
  assert.match(errorText(restoreIdentity.result.invocation.error), /selection restore failed/u);
  assert.equal(restoreIdentity.calls.send, 1);
  assert.equal(restoreIdentity.calls.select, 4, "exact restoration was not retried three bounded times");
  assert.match(errorText(restoreIdentity.result.retry.error), /reload the Copilot session/u);

  assert.equal(deselectIdentity.result.invocation.ok, false);
  assert.match(errorText(deselectIdentity.result.invocation.error), /selection restore failed/u);
  assert.equal(deselectIdentity.calls.send, 1);
  assert.equal(deselectIdentity.calls.deselect, 3, "non-empty deselection was not retried three bounded times");
  assert.match(errorText(deselectIdentity.result.retry.error), /reload the Copilot session/u);
});

test("Copilot log circuit and accepting terminal wakeups stay bounded at default host timeouts", async () => {
  const [logging, accepting] = await Promise.all([
    runScenario("log-hang-default"),
    runScenario("accepting-terminal-default"),
  ]);

  assert.equal(logging.result.invocation.ok, false);
  assert.match(errorText(logging.result.invocation.error), /completed.*could not display.*report/u);
  assert.ok(logging.result.elapsedMs >= 2_800, `default log timeout was not exercised (${logging.result.elapsedMs}ms)`);
  assert.ok(logging.result.elapsedMs < 4_200, `one hung log accumulated repeated 3s waits (${logging.result.elapsedMs}ms)`);
  assert.equal(logging.result.logCallsAfterTimeout, 1, "the open log circuit retried within one failure interval");
  assert.equal(logging.result.retry.ok, true, "the log circuit did not permit a later retry");
  assert.equal(logging.calls.log, 2);

  assert.equal(accepting.result.invocation.ok, true);
  assert.equal(accepting.calls.abort, 0);
  assert.equal(accepting.calls.deselect, 1);
  assert.equal(accepting.result.restoredWhileActive, 0, "a stale accepting-phase idle restored selection early");
  assert.ok(accepting.calls.activity >= 3, "multiple accepting-phase terminal signals were not reconciled");
  assert.ok(accepting.result.elapsedMs < 1_000,
    `native terminal waited for the default 15s prompt RPC (${accepting.result.elapsedMs}ms)`);
});

test("Copilot direct runner reports active work, provider errors, abort failures, and restore hazards truthfully", async () => {
  const [active, provider, abortFailure, restoreFailure] = await Promise.all([
    runScenario("active-work"),
    runScenario("session-error"),
    runScenario("abort-failure"),
    runScenario("restore-failure"),
  ]);

  assert.equal(active.result.invocation.ok, false);
  assert.match(errorText(active.result.invocation.error), /already has active work/u);
  assert.equal(active.calls.select, 0);
  assert.equal(active.calls.send, 0);
  assert.match(active.logs.map(({ message }) => message).join("\n"), /Preflight stopped · 0 model tokens/u);

  assert.equal(provider.result.invocation.ok, false);
  assert.match(errorText(provider.result.invocation.error), /session\.error/u);
  assert.equal(provider.calls.deselect, 1);
  assert.equal(JSON.stringify(provider.logs).includes("PRIVATE PROVIDER BODY"), false);
  assert.equal(provider.result.team.ok, true);

  assert.equal(abortFailure.result.invocation.ok, false);
  assert.match(errorText(abortFailure.result.invocation.error), /exceeded 1000ms/u);
  assert.match(errorText(abortFailure.result.invocation.error), /abort failed/u);
  assert.equal(abortFailure.calls.deselect, 1);

  assert.equal(restoreFailure.result.invocation.ok, false);
  assert.match(errorText(restoreFailure.result.invocation.error), /session\.error/u);
  assert.match(errorText(restoreFailure.result.invocation.error), /selection restore failed/u);
  assert.match(errorText(restoreFailure.result.retry.error), /reload the Copilot session/u);
  assert.equal(restoreFailure.result.team.ok, true);
  assert.match(restoreFailure.result.teamOutput, /selection restoration is unverified after run/u);
  assert.match(restoreFailure.result.teamOutput, /Can delegate now: none/u);
  assert.equal(restoreFailure.calls.deselect, 3);
  assert.equal(restoreFailure.calls.send, 1);
});

test("Copilot direct runner treats session.shutdown as a strong accepting terminal", async () => {
  const [failed, cancelled] = await Promise.all([
    runScenario("session-shutdown-error"),
    runScenario("session-shutdown-cancelled"),
  ]);

  assert.equal(failed.result.invocation.ok, false);
  assert.match(errorText(failed.result.invocation.error), /session\.shutdown.*error/u);
  assert.match(failed.result.teamOutput, /crafter · copilot-run-1 · failed/u);
  assert.equal(failed.calls.abort, 0, "a strong shutdown terminal fell through to timeout abort");
  assert.equal(failed.calls.deselect, 1);

  assert.equal(cancelled.result.invocation.ok, false);
  assert.match(errorText(cancelled.result.invocation.error), /session\.shutdown.*normal/u);
  assert.match(cancelled.result.teamOutput, /crafter · copilot-run-1 · cancelled/u);
  assert.equal(cancelled.calls.abort, 0, "a cancelled shutdown fell through to timeout abort");
  assert.equal(cancelled.calls.deselect, 1);
});

test("Copilot direct runner fences prior-run idle and usage events after prompt acceptance", async () => {
  const [idle, abortedIdle, usage] = await Promise.all([
    runScenario("accepted-stale-idle"),
    runScenario("accepted-stale-aborted-idle"),
    runScenario("stale-direct-usage"),
  ]);

  for (const result of [idle, abortedIdle]) {
    assert.equal(result.result.invocation.ok, true, "a prior-run idle terminalized the accepted current run");
    assert.ok(result.result.elapsedMs >= 70, `selection restored before current idle (${result.result.elapsedMs}ms)`);
    assert.equal(result.result.restoredWhileActive, 0, "selection restored while current work remained active");
    assert.equal(result.calls.deselect, 1);
  }

  assert.equal(usage.result.invocation.ok, true);
  const report = String(usage.result.missionOutput).replace(/\s+/gu, " ");
  assert.match(report, /current-model \(observed\).*1 native usage event/u);
  assert.match(report, /in 20 · out 2 .* total 22/u);
  assert.doesNotMatch(report, /old-model|mixed observed|2 native usage events|\b900\b|\b990\b|1,012/u);
});

test("Copilot direct runner does not let an orphan message delta seed its native chain", async () => {
  const guarded = await runScenario("direct-replay-delta-first");

  assert.equal(guarded.result.invocation.ok, true,
    "a replayed delta poisoned the empty chain and hid the legitimate terminal");
  assert.equal(guarded.calls.abort, 0, "the legitimate chain fell through to timeout abort");
  assert.equal(guarded.calls.deselect, 1);
  assert.ok(guarded.result.elapsedMs < 900, `legitimate completion took ${guarded.result.elapsedMs}ms`);
  const report = String(guarded.result.missionOutput).replace(/\s+/gu, " ");
  assert.match(report, /direct-current-model \(observed\).*1 native usage event/u);
  assert.match(report, /in 17 · out 3 · reason 2 · cache r\/w 1\/0 · total 20/u);
  assert.doesNotMatch(report, /replayed-delta-model|PRIVATE REPLAYED DELTA/u);
});

test("Copilot direct correlation rejects oversized IDs and bounds accepting terminal floods", async () => {
  const [flood, oversized] = await Promise.all([
    runScenario("acceptance-terminal-flood"),
    runScenario("direct-oversized-event-ids"),
  ]);
  assert.equal(flood.result.invocation.ok, false);
  assert.match(errorText(flood.result.invocation.error), /timed out waiting for Copilot to accept/u,
    "oversized terminal identities were trusted as authoritative");
  assert.equal(flood.calls.abort, 1);
  assert.ok(flood.result.elapsedMs < 900, `terminal flood fell through to timeout (${flood.result.elapsedMs}ms)`);
  assert.doesNotMatch(JSON.stringify(flood.logs), /PRIVATE-OVERSIZED-EVENT-ID|x{100}/u);

  assert.equal(oversized.result.invocation.ok, false);
  assert.match(errorText(oversized.result.invocation.error), /exceeded 1000ms/u);
  assert.equal(oversized.calls.abort, 1);
  assert.equal(JSON.stringify(oversized.logs).includes("PRIVATE-DIRECT-EVENT-ID"), false,
    "a raw oversized correlation ID leaked into retained user-facing output");
});

test("Copilot native tools reject oversized call IDs before hashing or retaining them", async () => {
  const oversized = await runScenario("native-oversized-tool-call-id");
  assert.equal(oversized.result.oversized.ok, false);
  assert.match(errorText(oversized.result.oversized.error), /invalid Copilot invocation identity/u);
  assert.doesNotMatch(JSON.stringify(oversized), /PRIVATE-NATIVE-CALL-ID|z{100}/u);
});

test("Copilot stop cannot send after cancellation, selection syncs the guard, and child admission reserves the member", async () => {
  const [beforeSend, sendGap, guardSync, reservation] = await Promise.all([
    runScenario("stop-before-send"),
    runScenario("stop-send-gap"),
    runScenario("guard-sync"),
    runScenario("native-reservation"),
  ]);

  assert.equal(beforeSend.result.stopped.ok, true);
  assert.equal(beforeSend.result.invocation.ok, false);
  assert.match(errorText(beforeSend.result.invocation.error), /cancelled before prompt acceptance/u);
  assert.equal(beforeSend.calls.send, 0);
  assert.equal(beforeSend.calls.abort, 1);
  assert.equal(beforeSend.calls.deselect, 1);
  assert.doesNotMatch(beforeSend.logs.map(({ message }) => message).join("\n"), /Starting:|sending “/u);

  assert.equal(sendGap.result.stopped.ok, true);
  assert.equal(sendGap.result.invocation.ok, false);
  assert.match(errorText(sendGap.result.invocation.error), /cancelled before prompt acceptance/u);
  assert.equal(sendGap.calls.send, 0, "a queued stop won, but session.send still ran");
  assert.equal(sendGap.calls.deselect, 1);
  const sendGapLogs = sendGap.logs.map(({ message }) => message).join("\n");
  assert.match(sendGapLogs, /Prepared: selected crafter; no model call yet/u);
  assert.doesNotMatch(sendGapLogs, /Starting:|sending “/u);

  assert.equal(guardSync.result.invocation.ok, true);
  assert.equal(guardSync.result.guardDecision?.permissionDecision, "deny",
    "team-lead selection bypassed the coordinator guard before a native selected event");
  assert.match(guardSync.result.guardDecision?.permissionDecisionReason ?? "", /player is not active/u);

  assert.equal(reservation.result.admission.permissionDecision, "allow");
  assert.equal(reservation.result.benchStop.ok, true);
  assert.equal(reservation.result.benchStopAll.ok, true);
  assert.match(reservation.result.benchStopOutput, /Agent Harbor Copilot bench .*0 model tokens/u);
  assert.match(reservation.result.benchStopAllOutput, /Agent Harbor Copilot bench .*0 model tokens/u);
  assert.equal(reservation.result.abortAfterBenchLists, 0,
    "/bench list filters reached the destructive /team stop parser");
  assert.match(reservation.result.childId, /^copilot-run-\d+$/u);
  assert.equal(reservation.result.direct.ok, false);
  assert.match(errorText(reservation.result.direct.error), /already has active work/u);
  assert.equal(reservation.result.stopped.ok, true, "a displayed child ID did not stop its root");
  assert.equal(reservation.calls.send, 0);
  assert.equal(reservation.calls.abort, 1);
});

test("Copilot player selection rejects a concurrent command flood and clears its claim after failure", async () => {
  const run = await runScenario("selection-concurrency");
  assert.ok(run.result.sendsDuringConcurrentBatch <= 1);
  assert.equal(run.result.concurrent.filter((invocation: any) => invocation.ok).length, 0);
  assert.equal(run.result.concurrent.length, 50);
  assert.ok(run.result.concurrent.slice(1).every((invocation: any) =>
    /selection is already queued or in progress/u.test(errorText(invocation.error))));
  assert.equal(run.result.retry.ok, true, "failed selection left the bounded selection claim stuck");
  assert.equal(run.calls.send, 1, "retry did not make exactly one model send after the failed batch");
});

test("Copilot direct roots count each native usage event once across raw and lifecycle observation", async () => {
  const ownership = await runScenario("direct-root-usage-ownership");

  assert.equal(ownership.result.invocation.ok, true);
  assert.equal(ownership.result.team.ok, true);
  const output = `${ownership.result.missionOutput}\n${ownership.result.teamOutput}`;
  const flattened = output.replace(/\s+/gu, " ");
  assert.match(flattened, /1 native usage event/u);
  assert.doesNotMatch(flattened, /2 native usage events/u);
  assert.match(flattened, /in 101 · out 7 · reason 3 · cache r\/w 11\/2 · total 108/u);
  assert.doesNotMatch(flattened, /in 202|out 14|reason 6|cache r\/w 22\/4|total 216/u);
  assert.match(flattened, /crafter · run copilot-run-2 · parent copilot-run-1/u);
  assert.match(flattened, /child-model \(observed\).*1 native usage event.*in 31/u);
  assert.match(flattened, /Mission total .*in 132 · out 12 · reason 5 · cache r\/w 15\/3 · total 144/u);
  assert.match(flattened, /model-multiplier cost 1 · nano AIU 100/u);
  assert.match(flattened, /model-multiplier cost 0\.25 · nano AIU 25/u);
  assert.match(flattened, /Mission total .*model-multiplier cost 1\.25 · nano AIU 125/u);
  assert.doesNotMatch(flattened, /USD|dollars?|currency/iu);
  assert.equal(ownership.calls.send, 1);
});

test("Copilot counts metadata-only usage for manual roots, children, and direct roots without inventing zero", async () => {
  const parity = await runScenario("metadata-only-usage-parity");

  assert.equal(parity.result.admission.permissionDecision, "allow");
  assert.equal(parity.result.manualTeam.ok, true);
  assert.equal(parity.result.direct.ok, true);
  const manual = String(parity.result.manualTeamOutput).replace(/\s+/gu, " ");
  const direct = String(parity.result.directMissionOutput).replace(/\s+/gu, " ");
  assert.match(manual, /team-lead · run copilot-run-\d+ · manager · completed .*?1 native usage event · token counters unavailable/u);
  assert.match(manual, /crafter · run copilot-run-\d+ · parent copilot-run-\d+ · fixed · completed .*?1 native usage event · token counters unavailable/u);
  assert.match(direct, /crafter · run copilot-run-\d+ · fixed · completed .*?1 native usage event · token counters unavailable/u);
  assert.doesNotMatch(`${manual} ${direct}`, /\b(?:in|out|reason|total) 0\b|cache r\/w 0\/0/u);
});

test("Copilot manual roots prefer configured profile models and preserve explicit no-reasoning", async () => {
  const [profile, direct] = await Promise.all([
    runScenario("manual-profile-model"),
    runScenario("direct-provider-confirmation"),
  ]);

  assert.equal(profile.result.initialTeam.ok, true);
  assert.equal(profile.result.confirmedTeam.ok, true);
  assert.equal(profile.result.observedTeam.ok, true);
  const initial = String(profile.result.initialTeamOutput).replace(/\s+/gu, " ");
  const confirmed = String(profile.result.confirmedTeamOutput).replace(/\s+/gu, " ");
  const observed = String(profile.result.observedTeamOutput).replace(/\s+/gu, " ");
  assert.match(initial, /crafter · run copilot-run-\d+ · fixed · working .*profile-model \(configured\) · reasoning effort none \(inherited\)/u);
  assert.match(confirmed, /crafter · run copilot-run-\d+ · fixed · working .*profile-model \(observed\) · reasoning effort none \(observed\)/u);
  assert.match(observed, /crafter · run copilot-run-\d+ · fixed · working .*provider-model \(observed; also profile-model\) · reasoning effort high \(observed; also none\)/u);

  assert.equal(direct.result.invocation.ok, true);
  const directReport = String(direct.result.missionOutput).replace(/\s+/gu, " ");
  assert.match(directReport, /crafter · run copilot-run-\d+ · fixed · completed .*profile-model \(observed\) · reasoning effort none \(observed\)/u);
});

test("Copilot interactive output bypasses notification backlog and reports partial availability", async () => {
  const [displayFailure, backlog, refreshFailure, startupFailure, inferredChild] = await Promise.all([
    runScenario("display-reject"),
    runScenario("log-backlog"),
    runScenario("refresh-hang"),
    runScenario("startup-refresh-hang"),
    runScenario("inferred-child"),
  ]);

  assert.equal(displayFailure.result.invocation.ok, false, "/team silently succeeded after its requested output failed");
  assert.match(errorText(displayFailure.result.invocation.error), /display rejected/u);

  assert.equal(backlog.result.team.ok, true);
  assert.ok(backlog.result.elapsedMs < 200, `notification backlog delayed /team by ${backlog.result.elapsedMs}ms`);
  assert.equal(backlog.result.notifications.length, 12);

  assert.equal(refreshFailure.result.invocation.ok, true, "a post-commit refresh failure was reported as a roster mutation failure");
  const refreshLogs = refreshFailure.logs.map(({ message }) => message).join("\n");
  assert.match(refreshLogs, /fresh-worker stored · personal · pending Copilot reload/u);
  assert.match(refreshLogs, /Roster updated, but Copilot refresh failed/u);
  assert.doesNotMatch(refreshLogs, /ready in this project|Run now:/u);

  assert.equal(startupFailure.result.team.ok, true);
  assert.equal(startupFailure.result.bench.ok, true);
  assert.equal(startupFailure.result.player.ok, false);
  assert.equal(startupFailure.calls.send, 0);
  assert.match(errorText(startupFailure.result.player.error), /agent reload.*timed out/u);
  const startupLogs = startupFailure.logs.map(({ message }) => message).join("\n");
  assert.match(startupLogs, /Native agent discovery\/coordinator is not ready/u);
  assert.match(startupLogs, /Can delegate now: none/u);
  assert.doesNotMatch(startupLogs, /Can delegate now:.*crafter/u);

  const inferredLogs = inferredChild.logs.map(({ message }) => message).join("\n");
  assert.match(inferredLogs, /admitted \(inferred; native start not observed\)/u);
  assert.match(inferredLogs, /crafter failed/u);
  assert.doesNotMatch(inferredLogs, /crafter started/u);
});

test("Copilot /team keeps one shared interactive deadline across startup, degraded reads, display, and stop", async () => {
  const [degraded, defaultBudget, displayHang, stop] = await Promise.all([
    runScenario("team-degraded-budget"),
    runScenario("team-default-budget"),
    runScenario("team-total-budget"),
    runScenario("team-stop-budget"),
  ]);

  assert.equal(degraded.result.team.ok, true);
  assert.ok(degraded.result.elapsedMs < 1_700, `degraded import + /team took ${degraded.result.elapsedMs}ms`);
  assert.match(degraded.result.teamOutput, /Degraded bounded snapshot \(700ms budget\)/u);
  assert.match(degraded.result.teamOutput, /project scope unavailable/u);
  assert.doesNotMatch(degraded.result.teamOutput, /ROSTER|marketplace/u);
  assert.equal(degraded.calls.send, 0);

  assert.equal(defaultBudget.result.team.ok, false,
    "a display that exceeded the shared default deadline was reported as successful");
  assert.match(errorText(defaultBudget.result.team.error), /team display.*timed out/u);
  assert.ok(defaultBudget.result.elapsedMs >= 80,
    `late display did not exercise the bounded log deadline (${defaultBudget.result.elapsedMs}ms)`);
  assert.ok(defaultBudget.result.elapsedMs < 500,
    `default late display + /team took ${defaultBudget.result.elapsedMs}ms`);

  assert.equal(displayHang.result.team.ok, false, "a hung display was reported as a successful /team output");
  assert.ok(displayHang.result.elapsedMs < 1_700, `hung import + /team took ${displayHang.result.elapsedMs}ms`);

  assert.equal(stop.result.stopped.ok, false, "a hung abort was reported as settled");
  assert.ok(stop.result.elapsedMs < 950, `bounded /team stop took ${stop.result.elapsedMs}ms`);
  assert.equal(stop.calls.abort, 1);
  assert.equal(stop.result.team.ok, true);
  assert.match(stop.result.teamOutput, /crafter · copilot-run-1 · cleaning/u);
});

test("Copilot /team stop reports partial multi-root failure without hiding cleaning state", async () => {
  const partial = await runScenario("team-partial-stop");

  assert.equal(partial.result.stopped.ok, false);
  assert.equal(partial.calls.abort, 2);
  const stopping = /Stopping 1 root run\(s\): (copilot-run-[12])/u.exec(partial.result.stopOutput)?.[1];
  const failed = /• (copilot-run-[12]) · state cleaning · second abort failed/u.exec(partial.result.stopOutput)?.[1];
  assert.ok(stopping);
  assert.ok(failed);
  assert.notEqual(stopping, failed);
  assert.match(partial.result.stopOutput, /Failed or unconfirmed 1 root stop request\(s\)/u);
  assert.match(errorText(partial.result.stopped.error), new RegExp(`could not confirm stop for ${failed}`, "u"));
  assert.equal(partial.result.team.ok, true);
  assert.match(partial.result.teamOutput, /copilot-run-1[\s\S]*cleaning/u);
  assert.match(partial.result.teamOutput, /copilot-run-2[\s\S]*cleaning/u);
  assert.equal(partial.calls.send, 0);
});

test("Copilot /team closes delegation for untracked host work and reports only SDK-provided limits", async () => {
  const observed = await runScenario("team-host-untracked-context");
  assert.equal(observed.result.team.ok, true);
  const output = String(observed.result.teamOutput).replace(/\s+/gu, " ");
  assert.match(output, /HOST ACTIVITY \(Copilot SDK; outside Agent Harbor tracking\)/u);
  assert.match(output, /metadata\.activity\.hasActiveWork \+ metadata\.isProcessing/u);
  assert.match(output, /No Agent Harbor run ID exists for this work; delegation remains closed/u);
  assert.match(output, /No Agent Harbor mission is tracked; Copilot reports other active host work below/u);
  assert.doesNotMatch(output, /No one is working right now/u);
  assert.match(output, /Selection gate: Copilot host work is active outside Agent Harbor tracking/u);
  assert.match(output, /Can delegate now: none/u);
  assert.match(output,
    /currentTokens 500 · tokenLimit 32,000 · outputTokenLimit 4,096 · toolDefinitionsTokens 80/u);
  assert.match(output, /max output 4,096 tokens/u);
  assert.match(output, /AI-credit limit \(Copilot SDK\): maxAiCredits 7\.5/u);
  assert.equal(observed.calls.activity, 1);
  assert.equal(observed.calls.processing, 1);
  assert.equal(observed.calls.context, 1);
  assert.ok(String(observed.result.teamOutput).split("\n").every((line) => line.length <= 96));
});

test("Copilot /team fails closed without project scope and clears transient discovery failures after recovery", async () => {
  const [unverifiedStop, scope, read, unscopedHazard] = await Promise.all([
    runScenario("team-unverified-stop"),
    runScenario("team-scope-recovery"),
    runScenario("team-read-recovery"),
    runScenario("team-scope-identity-hazard"),
  ]);
  assert.equal(unverifiedStop.result.stopped.ok, false);
  assert.match(errorText(unverifiedStop.result.stopped.error), /project scope is unavailable.*stop fails closed/u);
  assert.equal(unverifiedStop.calls.abort, 0);

  assert.equal(scope.result.first.ok, true);
  assert.match(scope.result.firstOutput, /project scope unavailable/u);
  assert.doesNotMatch(scope.result.firstOutput, /ROSTER|marketplace/u);
  assert.equal(scope.result.second.ok, true);
  assert.match(scope.result.secondOutput, /Team: 3 ready · 0 active/u);
  assert.doesNotMatch(scope.result.secondOutput, /degraded|project scope unavailable/u);

  assert.equal(read.result.team.ok, true);
  assert.ok(read.calls.list >= 2, "the native roster was not retried after refresh");
  assert.doesNotMatch(read.result.teamOutput, /degraded|native roster unavailable/u);

  assert.equal(unscopedHazard.result.team.ok, true);
  assert.match(unscopedHazard.result.teamOutput, /project scope unavailable/u);
  assert.match(unscopedHazard.result.teamOutput,
    /Native lifecycle identity\/attribution is unverified; reload Copilot before delegation/u);
  assert.doesNotMatch(unscopedHazard.result.teamOutput, /ROSTER|copilot-run-|Task:/u);
  assert.equal(unscopedHazard.calls.send, 0);
});

test("Copilot active team-lead view keeps safe specialist delegation visible", async () => {
  const manager = await runScenario("team-lead-active-access");
  assert.equal(manager.result.team.ok, true);
  assert.equal(manager.result.invocation.ok, true);
  const output = String(manager.result.teamOutput).replace(/\s+/gu, " ");
  assert.match(output, /team-lead · copilot-run-1 · (?:starting|working)/u);
  assert.match(output, /Can delegate now: [^.]*crafter/u);
  assert.doesNotMatch(output, /Selection gate:/u);
  assert.doesNotMatch(output, /Can delegate now: none/u);
  assert.ok(String(manager.result.teamOutput).split("\n").every((line) => line.length <= 96));
});

test("Copilot /team help and --help are deterministic zero-token control guidance", async () => {
  const help = await runScenario("team-help");
  assert.equal(help.result.help.ok, true);
  assert.equal(help.result.longHelp.ok, true);
  assert.equal(help.result.outputs.length, 2);
  for (const output of help.result.outputs) {
    assert.match(output, /Agent Harbor Copilot team help · 0 model tokens/u);
    assert.match(output, /\/team <filter>/u);
    assert.match(output, /live work or, when idle, the last mission/u);
    assert.match(output, /member:\/id: · kind:\/role: · description:/u);
    assert.match(output,
      /tool: · capability: · skill: · status:\/state: · model: · reasoning: · task: · run:/u);
    assert.match(output, /\/team stop <run-id\|all>/u);
    assert.match(output, /Choose one teammate: \/<id> <task> or \/player <id> <task>/u);
    assert.match(output, /Personal model: \/join JSON with model:"provider\/model"; add replace:true/u);
    assert.match(output, /32 concurrent roots.*6 sequential team-lead delegations/u);
    assert.match(output, /omitted rows.*lossy\/redacted.*process-local/u);
    assert.match(output, /Tokens, AI credits, and max-output.*only when Copilot SDK reports/u);
    assert.match(output, /does not simulate a hard per-run token cap[\s\S]*concurrency and six\s+delegations/u);
    assert.ok(output.split("\n").every((line) => line.length <= 96));
  }
  assert.equal(help.calls.send, 0);
});

test("Copilot lifecycle identity hazard stays visible, blocks work, and preserves guard evidence alignment", async () => {
  const hazard = await runScenario("lifecycle-identity-hazard");
  assert.equal(hazard.result.firstDecision?.permissionDecision, "allow");
  assert.equal(hazard.result.secondDecision?.permissionDecision, "allow");
  assert.equal(hazard.result.team.ok, true);
  assert.equal(hazard.result.noMatch.ok, true);
  assert.equal(hazard.result.blocked.ok, false);
  assert.match(errorText(hazard.result.blocked.error), /lifecycle identity is unverified.*reload/u);
  assert.equal(hazard.calls.send, 0);
  assert.equal(hazard.result.guardEvidenceLogs, 2,
    "a replayed hook.end shifted or duplicated queued guard evidence");

  const output = String(hazard.result.teamOutput).replace(/\s+/gu, " ");
  assert.match(output, /team-lead · copilot-run-\d+ · working/u);
  assert.match(output, /verified-model \(observed\).*tok ≥3 \(unverified\)/u);
  assert.match(output, /Selection gate: lifecycle identity is unverified; reload Copilot before delegation/u);
  assert.match(output, /Can delegate now: none/u);
  assert.doesNotMatch(output, /manager · cleaning|110 native tokens|in 100/u);

  const noMatch = String(hazard.result.noMatchOutput).replace(/\s+/gu, " ");
  assert.match(noMatch, /No team member or tracked activity matches “does-not-exist”/u);
  assert.match(noMatch, /Selection gate: lifecycle identity is unverified; reload Copilot before delegation/u);
  assert.match(noMatch, /member ID, description, role\/kind, capability, tool, skill/u);
  assert.match(noMatch, /model\/reasoning, status\/state, task label, or run ID/u);
  assert.ok(String(hazard.result.teamOutput).split("\n").every((line) => line.length <= 96));
  assert.ok(String(hazard.result.noMatchOutput).split("\n").every((line) => line.length <= 96));
});

test("Copilot terminal events discard stale guard evidence without suppressing the next turn", async () => {
  const cleared = await runScenario("guard-terminal-clear");
  assert.equal(cleared.result.staleDecision?.permissionDecision, "allow");
  assert.equal(cleared.result.freshDecision?.permissionDecision, "allow");
  assert.equal(cleared.calls.send, 0);
  assert.equal(cleared.result.guardEvidence.length, 1,
    "a terminal event retained stale evidence or discarded the fresh turn");
  assert.equal(cleared.result.guardEvidence[0].phase, "target.resolved");
  assert.equal(cleared.result.guardEvidence[0].agent, "crafter");
  assert.equal(cleared.result.guardEvidence[0].runtimeAgent, "agent-foundry:crafter");
});

test("Copilot /contract flows through the extension runtime into active and historical /team telemetry", async () => {
  const contract = await runScenario("contract-team-observability");
  assert.equal(contract.result.controlWasUndefined, false);
  assert.equal(contract.result.controlDecision?.permissionDecision, "allow");
  assert.equal(contract.result.nativePreflight.ok, true);
  assert.deepEqual(Object.keys(contract.result.nativePreflight.value), ["agent_type", "description", "prompt"]);
  assert.equal(contract.result.taskDecision?.permissionDecision, "allow");
  assert.equal(contract.result.activeTeam.ok, true);
  assert.equal(contract.result.activeDetail.ok, true);
  assert.equal(contract.result.historyTeam.ok, true);
  assert.equal(contract.result.historyDetail.ok, true);
  const active = String(contract.result.activeTeamOutput).replace(/\s+/gu, " ");
  assert.match(active, /contract · copilot-run-1 · waiting/u);
  assert.match(active, /ephemeral-reviewer · copilot-run-2 · working/u);
  assert.match(active, /root-model \(observed\) · calls 1 · tok 13/u);
  assert.match(active, /child-model \(observed\) · calls 1 · tok 24/u);
  assert.match(active, /Selection gate: child run copilot-run-2 is active/u);
  assert.match(active, /Can delegate now: none/u);

  const activeDetail = String(contract.result.activeDetailOutput).replace(/\s+/gu, " ");
  assert.match(activeDetail, /ephemeral-reviewer · run copilot-run-2 · parent copilot-run-1 · contractor · working/u);
  assert.match(activeDetail, /child-model \(observed\) · reasoning effort high \(observed\).*1 native usage event · 24 native tokens/u);

  const history = String(contract.result.historyTeamOutput).replace(/\s+/gu, " ");
  assert.match(history, /LAST MISSION/u);
  assert.match(history, /contract · copilot-run-1 · completed/u);
  assert.match(history, /Mission: 2 tracked runs · total 43 native tokens · details: \/team run:copilot-run-1/u);
  assert.doesNotMatch(history, /ephemeral-reviewer|Native child:/u);

  const historyDetail = String(contract.result.historyDetailOutput).replace(/\s+/gu, " ");
  assert.match(historyDetail, /ephemeral-reviewer · run copilot-run-2 · parent copilot-run-1 · contractor · completed/u);
  assert.match(historyDetail, /Native child: duration 00:00\.750 · tool calls 2/u);
  assert.match(historyDetail, /1 native usage event[\s\S]*in ≥20 · out ≥4[\s\S]*total 30/u);
  assert.doesNotMatch(historyDetail, /2 native usage events/u);
  for (const secret of [
    "PRIVATE-RAW-CONTRACT-SECRET",
    "PRIVATE-TASK-SECRET",
    "PRIVATE-VALIDATED-CONTRACT-SECRET",
    "PRIVATE CHILD RESULT",
    "private\\contract.ts",
  ]) {
    assert.equal(`${contract.result.activeTeamOutput}\n${contract.result.activeDetailOutput}\n${contract.result.historyTeamOutput}\n${contract.result.historyDetailOutput}`.includes(secret), false);
  }
  assert.ok(String(contract.result.activeTeamOutput).split("\n").every((line) => line.length <= 96));
  assert.ok(String(contract.result.activeDetailOutput).split("\n").every((line) => line.length <= 96));
  assert.ok(String(contract.result.historyTeamOutput).split("\n").every((line) => line.length <= 96));
  assert.ok(String(contract.result.historyDetailOutput).split("\n").every((line) => line.length <= 96));
});

test("Copilot selected /contract relabels one root and preserves its pre-skill telemetry end to end", async () => {
  const contract = await runScenario("contract-selected-team-observability");
  assert.equal(contract.result.controlWasUndefined, false);
  assert.equal(contract.result.controlDecision?.permissionDecision, "allow");
  assert.equal(contract.result.nativePreflight.ok, true);
  assert.equal(contract.result.taskDecision?.permissionDecision, "allow");
  assert.equal(contract.result.activeTeam.ok, true);
  assert.equal(contract.result.activeDetail.ok, true);
  assert.equal(contract.result.historyTeam.ok, true);
  assert.equal(contract.result.historyDetail.ok, true);
  assert.equal(contract.calls.send, 0);

  const activeRaw = String(contract.result.activeTeamOutput);
  const active = activeRaw.replace(/\s+/gu, " ");
  assert.match(active, /contract · copilot-run-1 · waiting/u);
  assert.match(active, /ephemeral-reviewer · copilot-run-2 · working/u);
  assert.match(active, /mixed models \(observed\) · calls 1 · tok 13/u);
  assert.match(active, /child-model \(observed\) · calls 1 · tok 24/u);
  assert.equal((activeRaw.match(/● contract · copilot-run/gu) ?? []).length, 1);
  assert.equal((activeRaw.match(/↳ ephemeral-reviewer · copilot-run/gu) ?? []).length, 1);
  assert.doesNotMatch(activeRaw, /● crafter · copilot-run/u);

  const activeDetail = String(contract.result.activeDetailOutput).replace(/\s+/gu, " ");
  assert.match(activeDetail, /ephemeral-reviewer · run copilot-run-2 · parent copilot-run-1 · contractor · working/u);
  assert.match(activeDetail, /child-model \(observed\).*1 native usage event · 24 native tokens/u);

  const historyRaw = String(contract.result.historyTeamOutput);
  const history = historyRaw.replace(/\s+/gu, " ");
  assert.match(history, /contract · copilot-run-1 · completed/u);
  assert.match(history, /Mission: 2 tracked runs · total 43 native tokens/u);
  assert.equal((historyRaw.match(/● contract · copilot-run/gu) ?? []).length, 1);
  assert.doesNotMatch(historyRaw, /ephemeral-reviewer/u);

  const historyDetailRaw = String(contract.result.historyDetailOutput);
  const historyDetail = historyDetailRaw.replace(/\s+/gu, " ");
  assert.match(historyDetail, /ephemeral-reviewer · run copilot-run-2 · parent copilot-run-1 · contractor · completed/u);
  assert.equal((historyDetailRaw.match(/└─ ephemeral-reviewer · run/gu) ?? []).length, 1);
  for (const secret of [
    "PRIVATE-RAW-CONTRACT-SECRET",
    "PRIVATE-TASK-SECRET",
    "PRIVATE-VALIDATED-CONTRACT-SECRET",
    "PRIVATE CHILD RESULT",
    "private\\contract.ts",
  ]) {
    assert.equal(`${activeRaw}\n${contract.result.activeDetailOutput}\n${historyRaw}\n${historyDetailRaw}`.includes(secret), false);
  }
  assert.ok(activeRaw.split("\n").every((line) => line.length <= 96));
  assert.ok(String(contract.result.activeDetailOutput).split("\n").every((line) => line.length <= 96));
  assert.ok(historyRaw.split("\n").every((line) => line.length <= 96));
  assert.ok(historyDetailRaw.split("\n").every((line) => line.length <= 96));
});

test("Copilot first team view recovers delayed discovery and lifecycle controls stay actionable and private", async () => {
  const [delayed, controls] = await Promise.all([
    runScenario("first-team-delayed-discovery"),
    runScenario("control-surface-ux"),
  ]);

  assert.equal(delayed.result.team.ok, true);
  assert.match(delayed.result.teamOutput, /Team: 3 ready · 0 active · 6 benched · 0 unhealthy/u);
  assert.doesNotMatch(delayed.result.teamOutput, /discovery\/coordinator is not ready|reload the Copilot session/u);
  assert.ok(delayed.calls.reload >= 2, "first /team did not retry the delayed startup registry");
  assert.equal(delayed.calls.send, 0);
  const startupNotice = delayed.logs.find(({ message }) => message.includes("Agent Harbor startup"))?.message ?? "";
  assert.match(startupNotice, /Initial native discovery is still pending\. \/team will retry/u);
  assert.doesNotMatch(startupNotice, /discovery is unavailable; reload/u);

  assert.equal(controls.result.bench.ok, true);
  assert.match(controls.result.benchOutput, /Agent Harbor Copilot bench .*0 model tokens/u);
  assert.match(controls.result.benchOutput, /design · bundled · bench/u);
  assert.match(controls.result.benchOutput, /Capacity:/u);
  assert.doesNotMatch(controls.result.benchOutput, /^design \| bundled \| bench$/mu);
  assert.ok(controls.result.benchOutput.split("\n").every((line) => line.length <= 96));
  assert.equal(controls.result.bundledRetry.ok, false);
  assert.match(errorText(controls.result.bundledRetry.error), /player is benched: design; run \/bench on design/u);

  assert.equal(controls.result.joined.ok, true);
  assert.match(controls.result.joinOutput, /✓ ux-reviewer joined · personal · registered/u);
  assert.match(controls.result.joinOutput, /Role: Review user-facing behavior/u);
  assert.match(controls.result.joinOutput, /Capacity: read, search/u);
  assert.match(controls.result.joinOutput, /Model: inherits the current Copilot host when run/u);
  assert.match(controls.result.joinOutput, /Availability: verify with \/team member:ux-reviewer/u);
  assert.match(controls.result.joinOutput, /When ready: \/player ux-reviewer <task>/u);
  assert.match(controls.result.joinOutput, /After restarting Copilot: \/ux-reviewer <task>/u);
  assert.doesNotMatch(controls.result.joinOutput, /registration:|active:/u);
  assert.equal(controls.result.joinOutput.includes(controls.result.sandbox), false);
  assert.equal(controls.result.joinOutput.includes(controls.result.project), false);
  assert.equal(controls.result.benched.ok, true);
  assert.equal(controls.result.personalBenchRetry.ok, false);
  assert.match(errorText(controls.result.personalBenchRetry.error), /personal player is benched: ux-reviewer; run \/bench on ux-reviewer/u);

  assert.equal(controls.result.retired.ok, true);
  assert.match(controls.result.retireOutput, /retired ux-reviewer; other projects intentionally untouched/u);
  assert.match(controls.result.retireOutput, /blocked immediately through \/player[\s\S]*alias may remain visible\s+until \/reload/u);
  assert.equal(controls.result.retry.ok, false);
  assert.match(errorText(controls.result.retry.error), /missing or retired.*re-run \/join.*inspect \/team ux-reviewer/u);
  assert.doesNotMatch(errorText(controls.result.retry.error), /bench on/u);
  assert.equal(controls.result.privateJoined.ok, true);
  assert.equal(controls.result.privateTeam.ok, true);
  assert.match(controls.result.privateJoinOutput, /Role: Review \[path\] with \[redacted\]/u);
  assert.match(controls.result.privateTeamOutput, /Review \[path\] with \[redacted\]/u);
  assert.doesNotMatch(
    `${controls.result.privateJoinOutput}\n${controls.result.privateTeamOutput}`,
    /alice|secret\.txt|abcdefghijklmnop/u,
  );
  assert.equal(controls.result.oversizedTeam.ok, false);
  assert.match(errorText(controls.result.oversizedTeam.error), /\/team arguments exceed 4096 bytes/u);
  assert.doesNotMatch(errorText(controls.result.oversizedTeam.error), /x{100}/u);
  for (const [command, invocation, limit] of [
    ["join", controls.result.oversizedJoin, 100000],
    ["bench", controls.result.oversizedBench, 4096],
    ["retire", controls.result.oversizedRetire, 4096],
    ["list-skills", controls.result.oversizedListSkills, 4096],
  ]) {
    assert.equal(invocation.ok, false);
    assert.match(errorText(invocation.error), new RegExp(`/${command} arguments exceed ${limit} bytes`, "u"));
    assert.doesNotMatch(errorText(invocation.error), /x{100}/u);
  }
  assert.equal(controls.result.hostileJoin.ok, false);
  assert.match(errorText(controls.result.hostileJoin.error), /join|definition|JSON/iu);
  assert.doesNotMatch(errorText(controls.result.hostileJoin.error), /trim is not a function|\[object Object\]/u);
  assert.equal(controls.result.hostileScout.ok, false);
  assert.match(errorText(controls.result.hostileScout.error), /usage: \/scout <task>/u);
  assert.equal(controls.result.hostileAlias.ok, false);
  assert.match(errorText(controls.result.hostileAlias.error), /usage: \/crafter <task>/u);
  assert.equal(controls.result.reloadAfterRejectedControls, controls.result.reloadBeforeRejectedControls,
    "rejected lifecycle arguments refreshed or mutated the roster");
  assert.equal(controls.calls.send, 0);
});

test("Copilot no-model controls avoid fake defaults and join does not promise native readiness", async () => {
  const run = await runScenario("no-model-control-ux");
  assert.equal(run.result.joined.ok, true);
  assert.match(run.result.joinOutput, /offline-reviewer joined · personal · registered in this project/u);
  assert.match(run.result.joinOutput, /Availability: verify with \/team member:offline-reviewer/u);
  assert.doesNotMatch(run.result.joinOutput, /ready in this project|Run now:/u);
  assert.equal(run.result.team.ok, true);
  assert.match(run.result.teamOutput, /Host\/session default: no model reported \(unobserved\)/u);
  assert.doesNotMatch(run.result.teamOutput, /unknown\/default/u);
  assert.match(run.result.teamOutput, /offline-reviewer · personal · unavailable/u);
  assert.match(run.result.teamOutput, /Repair: reload the Copilot session/u);
  assert.equal(run.calls.send, 0);
});

test("Copilot refuses to retire an active persistent player until its root settles", async () => {
  const run = await runScenario("retire-active-personal");

  assert.equal(run.result.joined.ok, true);
  assert.equal(run.result.blockedRetire.ok, false);
  assert.match(errorText(run.result.blockedRetire.error),
    /cannot retire retire-reviewer while it is (?:starting|working) in copilot-run-1/u);
  assert.match(errorText(run.result.blockedRetire.error),
    /use \/team stop copilot-run-1, then wait for cleanup to settle/u);
  assert.equal(run.result.reloadAfterBlockedRetire, run.result.reloadBeforeBlockedRetire);
  assert.equal(run.result.profileAfterBlockedRetire, true);
  assert.equal(run.result.stopped.ok, true);
  assert.equal(run.result.invocation.ok, false);
  assert.equal(run.result.retired.ok, true);
  assert.equal(run.result.profileAfterRetire, false);
  assert.equal(run.calls.send, 1);
});

test("Copilot command errors redact host paths and credentials before rejection or logging", async () => {
  const run = await runScenario("private-error");
  const error = errorText(run.result.invocation.error);
  assert.match(error, /host failed at \[path\] with \[redacted\]/u);
  assert.doesNotMatch(error, /alice|secret\.txt|abcdefghijklmnop/u);
  assert.equal(run.result.invocation.error.cause, undefined);
  assert.doesNotMatch(JSON.stringify(run.result.invocation.error), /alice|secret\.txt|abcdefghijklmnop/u);
  assert.doesNotMatch(run.logs.map(({ message }) => message).join("\n"), /alice|secret\.txt|abcdefghijklmnop/u);
});

test("Copilot inactive personal players expose class-specific non-destructive repairs", async () => {
  const repairs = await runScenario("inactive-personal-repair");
  const active = errorText(repairs.result.activeStale.error);
  const registration = errorText(repairs.result.registrationStale.error);
  const conflict = errorText(repairs.result.conflict.error);

  assert.equal(repairs.result.activeStale.ok, false);
  assert.match(active, /personal active profile is stale: active-stale/u);
  assert.match(active, /\/bench on active-stale, then reload the Copilot session/u);
  assert.doesNotMatch(active, /\/join|replace/u);

  assert.equal(repairs.result.registrationStale.ok, false);
  assert.match(registration, /personal registration is stale: registration-stale/u);
  assert.match(registration, /\/join with the full definition and "replace":true, then reload/u);
  assert.doesNotMatch(registration, /\/bench on/u);

  assert.equal(repairs.result.conflict.ok, false);
  assert.match(conflict, /unmanaged collision: unmanaged-conflict/u);
  assert.match(conflict, /inspect \/team unmanaged-conflict/u);
  assert.match(conflict, /will never overwrite it/u);
  assert.doesNotMatch(conflict, /replace/u);
  assert.equal(repairs.calls.send, 0);
});
