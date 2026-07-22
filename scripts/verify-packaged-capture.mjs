#!/usr/bin/env node

/** Proves the published tarball can execute its documented capture test gate. */
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
const temporary = await mkdtemp(join(tmpdir(), "agent-harbor-package-capture-"));
const packed = join(temporary, "packed");
const unpacked = join(temporary, "unpacked");
await Promise.all([mkdir(packed), mkdir(unpacked)]);
const npmExecPath = process.env.npm_execpath;
const npm = npmExecPath
  ? { command: process.execPath, prefix: [npmExecPath] }
  : { command: "npm", prefix: [] };

function requireSuccess(result, label) {
  if (result.error || result.status !== 0 || result.signal) {
    const detail = result.error?.message ?? result.stderr ?? `exit ${result.status}`;
    throw new Error(`${label} failed: ${detail}`);
  }
}

try {
  const pack = spawnSync(npm.command, [...npm.prefix,
    "pack",
    "--ignore-scripts",
    "--json",
    "--silent",
    "--pack-destination",
    packed,
  ], { cwd: root, encoding: "utf8", windowsHide: true });
  requireSuccess(pack, "npm pack");
  const metadata = JSON.parse(pack.stdout);
  const filename = metadata?.[0]?.filename;
  if (typeof filename !== "string") throw new Error("npm pack did not report a tarball filename");
  const extract = spawnSync("tar", ["-xf", join(packed, filename), "-C", unpacked], {
    encoding: "utf8",
    windowsHide: true,
  });
  requireSuccess(extract, "tarball extraction");
  const packageRoot = join(unpacked, "package");
  const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  if (manifest.scripts?.["test:capture"] !== "node scripts/run-capture-tests.mjs") {
    throw new Error("packed package does not expose the documented capture test command");
  }
  const test = spawnSync(npm.command, [...npm.prefix, "run", "test:capture", "--ignore-scripts"], {
    cwd: packageRoot,
    env: process.env,
    stdio: "inherit",
    windowsHide: true,
  });
  requireSuccess(test, "packed npm run test:capture");
  console.log(`packaged capture gate passed: ${metadata[0].name}@${metadata[0].version}`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
