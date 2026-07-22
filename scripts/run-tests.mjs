/** Clean-build test gate that rejects false-green child or TAP outcomes. */
import { spawn } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

function cleanTestEnvironment() {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

async function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: root,
      env: cleanTestEnvironment(),
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
}

function requireSuccess(result, stage) {
  if (result.code !== 0 || result.signal) {
    throw new Error(`${stage} failed (${result.signal ? `signal ${result.signal}` : `exit ${result.code}`})`);
  }
}

try {
  requireSuccess(await run(["scripts/build.mjs"]), "build");
  requireSuccess(await run(["scripts/run-test-suite.mjs"]), "test suite");
  requireSuccess(await run(["scripts/run-capture-tests.mjs"]), "capture hardening tests");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
