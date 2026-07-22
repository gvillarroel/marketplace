import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  claimSharedAgentActivity,
  readSharedAgentActivities,
  withSharedRosterMutationGate,
} from "../src/adapters/opencode-agent-activity.js";
import { PiTeamRuntime } from "../src/adapters/pi-team-runtime.js";
import { formatPiTeamView } from "../src/adapters/pi-team-view.js";
import { CopilotTeamRuntime } from "../src/adapters/copilot-team-runtime.js";
import { formatCopilotTeamView } from "../src/adapters/copilot-team-view.js";
import { canonicalProjectIdentity } from "../src/core/project-identity.js";

function waitForLine(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    let pending = "";
    const data = (chunk: Buffer | string): void => {
      pending += chunk.toString();
      const newline = pending.indexOf("\n");
      if (newline < 0) return;
      stream.removeListener("data", data);
      resolve(pending.slice(0, newline));
    };
    stream.on("data", data);
    stream.once("error", reject);
  });
}

test("Pi and Copilot share physical-project activity, mutation safety, views, and degraded authority", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harbor-shared-runtime-"));
  const project = join(root, "project");
  const alias = join(root, "project-alias");
  const activityHome = join(root, "activity-home");
  await mkdir(project, { recursive: true });
  await symlink(project, alias, process.platform === "win32" ? "junction" : "dir");
  assert.equal(canonicalProjectIdentity(alias), canonicalProjectIdentity(project));

  const previousActivityHome = process.env.AGENT_HARBOR_ACTIVITY_HOME;
  const previousPiHome = process.env.PI_CODING_AGENT_DIR;
  const previousCopilotHome = process.env.COPILOT_HOME;
  process.env.AGENT_HARBOR_ACTIVITY_HOME = activityHome;
  process.env.PI_CODING_AGENT_DIR = join(root, "pi-home");
  process.env.COPILOT_HOME = join(root, "copilot-home");
  t.after(() => {
    if (previousActivityHome === undefined) delete process.env.AGENT_HARBOR_ACTIVITY_HOME;
    else process.env.AGENT_HARBOR_ACTIVITY_HOME = previousActivityHome;
    if (previousPiHome === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousPiHome;
    if (previousCopilotHome === undefined) delete process.env.COPILOT_HOME;
    else process.env.COPILOT_HOME = previousCopilotHome;
  });

  const piRuntime = new PiTeamRuntime();
  const piRun = piRuntime.begin({ project: alias, agent: "local-pi", kind: "contractor", task: "local" });
  assert.equal(piRuntime.activeProjectRuns(project)[0]?.id, piRun);
  const copilotRuntime = new CopilotTeamRuntime();
  const copilotRun = copilotRuntime.begin({ project: alias, agent: "local-copilot", kind: "contractor", task: "local" });
  assert.equal(copilotRuntime.activeProjectRuns(project)[0]?.id, copilotRun);
  piRuntime.finishIfOpen(piRun, "completed");
  copilotRuntime.finishIfOpen(copilotRun, "completed");

  const holder = spawn(process.execPath, [
    "--import", "tsx", join(process.cwd(), "test-ts", "fixtures", "shared-activity-holder.ts"), alias, "crafter",
  ], {
    cwd: process.cwd(),
    env: { ...process.env, AGENT_HARBOR_ACTIVITY_HOME: activityHome },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  t.after(() => { if (!holder.killed) holder.kill(); });
  assert.deepEqual(JSON.parse(await waitForLine(holder.stdout)), { ready: true });
  const heldSnapshot = readSharedAgentActivities(project)[0]!;
  assert.equal(heldSnapshot.agent, "crafter");
  assert.equal(heldSnapshot.ownerRuntime, "pi");
  assert.ok(heldSnapshot.processID > 0);
  assert.throws(
    () => claimSharedAgentActivity(project, "crafter", "direct", "competing-runtime", "copilot"),
    /busy in another direct or delegated run/u,
  );
  await assert.rejects(
    withSharedRosterMutationGate(project, ["crafter"], "retire crafter", async () => true),
    /cannot retire crafter while crafter is starting/u,
  );

  const sharedProjects = await readdir(join(activityHome, "agent-foundry", "team-activity-v1"));
  const heldClaimPath = join(activityHome, "agent-foundry", "team-activity-v1", sharedProjects[0], "crafter.json");
  const overdue = new Date(Date.now() - 60_000);
  await utimes(heldClaimPath, overdue, overdue);
  assert.equal(readSharedAgentActivities(project)[0]?.heartbeatOverdue, true);
  assert.throws(
    () => claimSharedAgentActivity(project, "crafter", "direct", "stale-live-competitor", "copilot"),
    /PID \d+ is live; possible PID reuse cannot be reclaimed safely.*after proving no Agent Harbor work is active.*remove only this stale managed claim/su,
  );
  const piView = await formatPiTeamView(project, new PiTeamRuntime());
  assert.match(piView, /crafter.*project-shared\s+persistent.*\/team\s+run:shared-crafter/su);
  assert.match(piView, /task\/telemetry not\s+disclosed.*owner pi PID \d+; stop there/su);
  assert.match(piView, /Heartbeat overdue.*recover or restart the owning process/su);
  assert.doesNotMatch(piView, new RegExp(`${heldSnapshot.claimToken}|${heldSnapshot.sessionID}`, "u"));
  await utimes(heldClaimPath, overdue, overdue);
  const copilotView = await formatCopilotTeamView(alias, new CopilotTeamRuntime());
  assert.match(copilotView, /crafter.*shared-craf.*shared persistent/su);
  assert.match(copilotView, /heartbeat overdue.*recover\/restart owner/su);
  assert.match(copilotView, new RegExp(`owner pi PID ${heldSnapshot.processID}`, "u"));
  assert.doesNotMatch(copilotView, new RegExp(`${heldSnapshot.claimToken}|${heldSnapshot.sessionID}`, "u"));
  assert.doesNotMatch(copilotView, /shared-crafter owns the session|Selection gate: fixed root/u);
  assert.match(copilotView, /Busy \(double-booking blocked\): crafter/u);

  const holderClosed = new Promise<void>((resolve, reject) => {
    holder.once("close", (code) => code === 0 ? resolve() : reject(new Error(`holder exited ${code}`)));
  });
  // Close the pipe as well as sending the release command. A flowing stdin
  // handle keeps the fixture process alive on Windows after its top-level
  // await settles, which would otherwise leave this test waiting for `close`.
  holder.stdin.end("release\n");
  assert.deepEqual(JSON.parse(await waitForLine(holder.stdout)), { released: true });
  await holderClosed;
  assert.deepEqual(readSharedAgentActivities(project), []);

  let releaseMutation!: () => void;
  let announceMutation!: () => void;
  const mutationStarted = new Promise<void>((resolve) => { announceMutation = resolve; });
  const mutationRelease = new Promise<void>((resolve) => { releaseMutation = resolve; });
  const pendingMutation = withSharedRosterMutationGate(project, ["crafter"], "replace crafter", async () => {
    announceMutation();
    await mutationRelease;
    return true;
  });
  await mutationStarted;
  try {
    assert.throws(() => readSharedAgentActivities(project), /admission or roster mutation is in progress/u);
    const lockedPi = await formatPiTeamView(project, new PiTeamRuntime());
    assert.match(lockedPi, /persistent availability\/activity unverified/u);
    assert.match(lockedPi, /Delegable now: none .*activity authority unavailable/su);
    const lockedCopilot = await formatCopilotTeamView(project, new CopilotTeamRuntime());
    assert.match(lockedCopilot, /persistent availability\/activity unverified/u);
    assert.match(lockedCopilot, /Selection gate: project-shared activity authority is unavailable/u);
    assert.throws(
      () => claimSharedAgentActivity(project, "crafter", "direct", "locked-competitor", "copilot"),
      /capacity lock is busy/u,
    );
  } finally {
    releaseMutation();
  }
  assert.equal(await pendingMutation, true);

  const scout = claimSharedAgentActivity(project, "talent-scout", "direct", "own-scout-run", "pi");
  await assert.rejects(
    withSharedRosterMutationGate(project, ["crafter"], "replace crafter", async () => true),
    /talent-scout owns an active roster snapshot/u,
  );
  assert.equal(await withSharedRosterMutationGate(
    alias, ["crafter"], "replace crafter", async () => true, scout.snapshot.claimToken,
  ), true, "a talent scout could not exclude only its own exact claim generation");
  assert.equal(scout.release(), true);

  const seed = claimSharedAgentActivity(project, "crafter", "direct", "corruption-seed", "copilot");
  const ownerEntries = await readdir(join(activityHome, "agent-foundry", "team-activity-v1"));
  assert.equal(ownerEntries.length, 1);
  const corruptClaim = join(activityHome, "agent-foundry", "team-activity-v1", ownerEntries[0], "crafter.json");
  const seedStored = JSON.parse(await readFile(corruptClaim, "utf8"));
  assert.equal(seed.release(), true);
  await writeFile(corruptClaim, JSON.stringify({ ...seedStored, ownerRuntime: "opencode" }), {
    encoding: "utf8", mode: 0o600,
  });
  assert.throws(
    () => readSharedAgentActivities(project),
    /invalid Agent Harbor activity owner runtime for this namespace/u,
    "the shared Pi/Copilot namespace accepted an OpenCode owner-runtime claim",
  );
  await writeFile(corruptClaim, "{", { encoding: "utf8", mode: 0o600 });

  const degradedPi = await formatPiTeamView(project, new PiTeamRuntime());
  assert.match(degradedPi, /persistent availability\/activity unverified/u);
  assert.match(degradedPi, /Delegable now: none .*activity authority unavailable/su);
  assert.match(degradedPi, /project activity unverified/u);
  assert.doesNotMatch(degradedPi, /\b\d+ ready · 0 active/u);
  const degradedPiNoMatch = await formatPiTeamView(project, new PiTeamRuntime(), { filter: "member:no-such-player" });
  assert.match(degradedPiNoMatch, /activity authority is unavailable.*Repair:/su);

  const degradedCopilot = await formatCopilotTeamView(project, new CopilotTeamRuntime());
  assert.match(degradedCopilot, /persistent availability\/activity unverified/u);
  assert.match(degradedCopilot, /Selection gate: project-shared activity authority is unavailable/u);
  assert.match(degradedCopilot, /project activity unverified/u);
  assert.doesNotMatch(degradedCopilot, /\b\d+ ready · 0 active/u);
  const degradedCopilotNoMatch = await formatCopilotTeamView(project, new CopilotTeamRuntime(), { filter: "member:no-such-player" });
  assert.match(degradedCopilotNoMatch, /activity authority is unavailable.*Repair:/su);
});
