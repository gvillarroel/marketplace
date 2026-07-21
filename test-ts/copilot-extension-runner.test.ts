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
        AGENT_HARBOR_COPILOT_RPC_TIMEOUT_MS: scenario === "send-timeout-buffered-terminal" ? "750" : "250",
        AGENT_HARBOR_COPILOT_LOG_TIMEOUT_MS: "100",
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
  assert.match(restoreBlock.result.teamOutput, /crafter · run copilot-run-1 · fixed · cleaning/u,
    "the coordinator hid a direct run before selection restore completed");
  assert.equal(restoreBlock.result.invocation.ok, true);
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
  assert.match(failed.result.teamOutput, /crafter · run copilot-run-1 · fixed · failed/u);
  assert.equal(failed.calls.abort, 0, "a strong shutdown terminal fell through to timeout abort");
  assert.equal(failed.calls.deselect, 1);

  assert.equal(cancelled.result.invocation.ok, false);
  assert.match(errorText(cancelled.result.invocation.error), /session\.shutdown.*normal/u);
  assert.match(cancelled.result.teamOutput, /crafter · run copilot-run-1 · fixed · cancelled/u);
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
  assert.match(report, /current-model \(observed\).*native usage events 1/u);
  assert.match(report, /in 20 · out 2 .* total 22/u);
  assert.doesNotMatch(report, /old-model|mixed observed|native usage events 2|\b900\b|\b990\b|1,012/u);
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

  assert.equal(sendGap.result.stopped.ok, true);
  assert.equal(sendGap.result.invocation.ok, false);
  assert.match(errorText(sendGap.result.invocation.error), /cancelled before prompt acceptance/u);
  assert.equal(sendGap.calls.send, 0, "a queued stop won, but session.send still ran");
  assert.equal(sendGap.calls.deselect, 1);

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

test("Copilot direct roots count each native usage event once across raw and lifecycle observation", async () => {
  const ownership = await runScenario("direct-root-usage-ownership");

  assert.equal(ownership.result.invocation.ok, true);
  assert.equal(ownership.result.team.ok, true);
  const output = `${ownership.result.missionOutput}\n${ownership.result.teamOutput}`;
  const flattened = output.replace(/\s+/gu, " ");
  assert.match(flattened, /native usage events 1/u);
  assert.doesNotMatch(flattened, /native usage events 2/u);
  assert.match(flattened, /in 101 · out 7 · reason 3 · cache r\/w 11\/2 · total 108/u);
  assert.doesNotMatch(flattened, /in 202|out 14|reason 6|cache r\/w 22\/4|total 216/u);
  assert.match(flattened, /crafter · run copilot-run-2 · parent copilot-run-1/u);
  assert.match(flattened, /child-model \(observed\).*native usage events 1.*in 31/u);
  assert.match(flattened, /Mission total .*in 132 · out 12 · reason 5 · cache r\/w 15\/3 · total 144/u);
  assert.equal(ownership.calls.send, 1);
});

test("Copilot counts metadata-only usage for manual roots, children, and direct roots without inventing zero", async () => {
  const parity = await runScenario("metadata-only-usage-parity");

  assert.equal(parity.result.admission.permissionDecision, "allow");
  assert.equal(parity.result.manualTeam.ok, true);
  assert.equal(parity.result.direct.ok, true);
  const manual = String(parity.result.manualTeamOutput).replace(/\s+/gu, " ");
  const direct = String(parity.result.directMissionOutput).replace(/\s+/gu, " ");
  assert.match(manual, /team-lead · run copilot-run-\d+ · manager · completed .*?native usage events 1 · in — · out —/u);
  assert.match(manual, /crafter · run copilot-run-\d+ · parent copilot-run-\d+ · fixed · completed .*?native usage events 1 · in — · out —/u);
  assert.match(direct, /crafter · run copilot-run-\d+ · fixed · completed .*?native usage events 1 · in — · out —/u);
  assert.doesNotMatch(`${manual} ${direct}`, /\b(?:in|out|reason|total) 0\b|cache r\/w 0\/0/u);
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
  assert.match(refreshFailure.logs.map(({ message }) => message).join("\n"), /Roster updated, but Copilot refresh failed/u);

  assert.equal(startupFailure.result.team.ok, true);
  assert.equal(startupFailure.result.bench.ok, true);
  assert.equal(startupFailure.result.player.ok, false);
  assert.equal(startupFailure.calls.send, 0);
  assert.match(errorText(startupFailure.result.player.error), /agent reload.*timed out/u);
  const startupLogs = startupFailure.logs.map(({ message }) => message).join("\n");
  assert.match(startupLogs, /Native agent discovery\/coordinator is not ready/u);
  assert.match(startupLogs, /Delegable now: none/u);
  assert.doesNotMatch(startupLogs, /Delegable now:.*crafter/u);

  const inferredLogs = inferredChild.logs.map(({ message }) => message).join("\n");
  assert.match(inferredLogs, /admitted \(inferred; native start not observed\)/u);
  assert.doesNotMatch(inferredLogs, /crafter started/u);
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

  assert.equal(controls.result.bench.ok, true);
  assert.match(controls.result.benchOutput, /Agent Harbor Copilot bench .*0 model tokens/u);
  assert.match(controls.result.benchOutput, /design · bundled · bench/u);
  assert.match(controls.result.benchOutput, /Capacity:/u);
  assert.doesNotMatch(controls.result.benchOutput, /^design \| bundled \| bench$/mu);
  assert.ok(controls.result.benchOutput.split("\n").every((line) => line.length <= 96));
  assert.equal(controls.result.bundledRetry.ok, false);
  assert.match(errorText(controls.result.bundledRetry.error), /player is benched: design; run \/bench on design/u);

  assert.equal(controls.result.joined.ok, true);
  assert.match(controls.result.joinOutput, /✓ ux-reviewer joined · personal · ready/u);
  assert.match(controls.result.joinOutput, /Role: Review user-facing behavior/u);
  assert.match(controls.result.joinOutput, /Capacity: read, search/u);
  assert.match(controls.result.joinOutput, /Run now: \/player ux-reviewer <task>/u);
  assert.match(controls.result.joinOutput, /After restarting Copilot: \/ux-reviewer <task>/u);
  assert.doesNotMatch(controls.result.joinOutput, /registration:|active:/u);
  assert.equal(controls.result.joinOutput.includes(controls.result.sandbox), false);
  assert.equal(controls.result.joinOutput.includes(controls.result.project), false);
  assert.equal(controls.result.benched.ok, true);
  assert.equal(controls.result.personalBenchRetry.ok, false);
  assert.match(errorText(controls.result.personalBenchRetry.error), /personal player is benched: ux-reviewer; run \/bench on ux-reviewer/u);

  assert.equal(controls.result.retired.ok, true);
  assert.match(controls.result.retireOutput, /retired ux-reviewer; other projects intentionally untouched/u);
  assert.equal(controls.result.retry.ok, false);
  assert.match(errorText(controls.result.retry.error), /missing or retired.*re-run \/join.*inspect \/team ux-reviewer/u);
  assert.doesNotMatch(errorText(controls.result.retry.error), /bench on/u);
  assert.equal(controls.calls.send, 0);
});
