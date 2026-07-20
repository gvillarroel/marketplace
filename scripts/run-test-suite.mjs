import { spawn } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const defaults = [
  "test-ts/contracts.test.ts",
  "test-ts/adapters.test.ts",
  "test-ts/agent-matrix.test.ts",
  "test-ts/cycle-evidence.test.ts",
  "test-ts/compatibility.test.ts",
];
const files = process.argv.slice(2);

function cleanTestEnvironment() {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

function tapCount(output, label) {
  const matches = [...output.matchAll(new RegExp(`^# ${label} (\\d+)\\r?$`, "gmu"))];
  if (matches.length !== 1) throw new Error(`native test runner emitted no unique TAP ${label} summary`);
  return Number(matches[0][1]);
}

async function run() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      "--import", "tsx", "--test", "--test-reporter=tap", ...(files.length ? files : defaults),
    ], {
      cwd: root,
      env: cleanTestEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; process.stdout.write(chunk); });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { process.stderr.write(chunk); });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout }));
  });
}

try {
  const result = await run();
  const tests = tapCount(result.stdout, "tests");
  const failures = tapCount(result.stdout, "fail");
  if (tests < 1) throw new Error("native test runner executed no tests");
  if (failures !== 0) throw new Error(`native test runner reported ${failures} failure(s)`);
  if (result.code !== 0 || result.signal) {
    throw new Error(`native test runner failed (${result.signal ? `signal ${result.signal}` : `exit ${result.code}`})`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
