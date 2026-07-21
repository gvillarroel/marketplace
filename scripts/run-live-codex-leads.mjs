/** Runs or verifies authenticated OpenCode/Pi team-lead acceptance reports. */
import { spawn } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const requested = process.argv[2] ?? "all";
if (!["opencode", "pi", "all"].includes(requested)) {
  console.error("usage: node scripts/run-live-codex-leads.mjs [opencode|pi|all]");
  process.exit(2);
}
const harnesses = requested === "all" ? ["opencode", "pi"] : [requested];
const reports = new Map(harnesses.map((harness) => [harness, join(root, "work", `live-${harness}-team-lead-report.json`)]));
const verifyOnly = process.argv.includes("--verify-report-only") || process.env.AGENT_HARBOR_VERIFY_REPORT_ONLY === "1";
const startedAt = Date.now();

function cleanEnvironment() {
  const env = {
    ...process.env,
    AGENT_HARBOR_LIVE_CODEX: "1",
    AGENT_HARBOR_LIVE_HARNESS: requested,
  };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

async function runNode(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: root,
      env: cleanEnvironment(),
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
}

async function verifyReport(harness, requireFresh) {
  let report;
  try { report = JSON.parse(await readFile(reports.get(harness), "utf8")); }
  catch { throw new Error(`${harness} live lead report is missing or invalid JSON`); }
  if (report?.schema !== "agent-harbor/live-codex-team-lead@1") throw new Error(`${harness} live lead report schema is invalid`);
  if (report?.status !== "passed" || report?.harness !== harness) throw new Error(`${harness} live lead report is not passed`);
  if (report?.model !== "gpt-5.3-codex-spark" && report?.model !== "gpt-5.6-luna") throw new Error(`${harness} live lead report model is invalid`);
  if (typeof report.generatedAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(report.generatedAt)) {
    throw new Error(`${harness} live lead report timestamp is invalid`);
  }
  const generatedAt = Date.parse(report.generatedAt);
  const now = Date.now();
  if (!Number.isFinite(generatedAt) || generatedAt > now + 5_000) throw new Error(`${harness} live lead report timestamp is invalid`);
  if (requireFresh && generatedAt < startedAt - 1_000) throw new Error(`${harness} live lead report is stale`);
  if (!requireFresh && generatedAt < now - 24 * 60 * 60_000) throw new Error(`${harness} live lead report is older than 24 hours`);
}

try {
  if (!verifyOnly) {
    const build = await runNode(["scripts/build.mjs"]);
    if (build.code !== 0 || build.signal) throw new Error(`live build failed (${build.signal ? `signal ${build.signal}` : `exit ${build.code}`})`);
    await Promise.all([...reports.values()].map((path) => rm(path, { force: true })));
  }
  const result = verifyOnly
    ? { code: 0, signal: null }
    : await runNode(["--import", "tsx", "--test", "--test-concurrency=1", "test-ts/live-codex-leads.test.ts"]);
  for (const harness of harnesses) await verifyReport(harness, !verifyOnly);
  if (result.code !== 0 || result.signal) throw new Error(`live test runner failed (${result.signal ? `signal ${result.signal}` : `exit ${result.code}`})`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
