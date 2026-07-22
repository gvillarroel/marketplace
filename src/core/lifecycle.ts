/**
 * Persistent roster lifecycle with ownership-aware collision handling and transactional updates.
 * Registration lives under the user's harness home while active profiles live in one project;
 * mutations coordinate both locations without overwriting or deleting unmanaged files.
 */

import type { BigIntStats } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { basename, delimiter, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { HarnessSpec, PlayerDefinition } from "./types.js";
import { bundledPlayers, trustedSkills } from "./defaults.js";
import { isHarborId } from "./identity.js";
import {
  decodePlayer,
  isCanonicalPlayerProfile,
  isCanonicalPlayerRegistration,
  isCompatiblePlayerRegistration,
  renderPlayerRegistration,
} from "./profiles.js";
import { validateConfiguredSkillReferences } from "./skills.js";

const piBuiltInCommands = [
  "settings", "model", "scoped-models", "export", "import", "share", "copy", "name", "session", "changelog",
  "hotkeys", "fork", "clone", "tree", "trust", "login", "logout", "new", "compact", "resume", "reload", "quit",
] as const;
const reserved = new Set([
  ...bundledPlayers.keys(),
  "team-lead", "crafter", "talent-scout", "team", "bench", "join", "retire", "contract", "list-skills", "scout",
  "player",
  ...piBuiltInCommands,
]);
const allowedTools = new Set(["read", "search", "edit", "execute"]);
// Public roster metadata is rendered in terminal/UI surfaces. Cc includes C0,
// C1, DEL, newlines, and ESC; Cf includes bidi/zero-width format controls.
const publicMetadataControl = /[\p{Cc}\p{Cf}]/u;

type BenchAction = "on" | "off";
type BenchCommand =
  | { kind: "list"; filter: string }
  | { kind: "mutate"; action: BenchAction; ids: string[] };
type BenchChange = { path: string; content?: string };
type BenchPlayerPlan = { changes: BenchChange[] };
type BenchInventoryRow = { id: string; roster: "bundled" | "personal"; state: string };

/** Truthful filesystem outcome reported by the identity-bound lifecycle worker. */
export type LifecycleMutationStatus = "changed" | "already-current";

/** Structured join outcome for native adapters; `join()` remains the text-compatible API. */
export interface RosterJoinResult {
  readonly kind: "join";
  readonly player: string;
  readonly status: LifecycleMutationStatus;
  readonly text: string;
}

/** Structured retire outcome for native adapters; `retire()` remains the text-compatible API. */
export interface RosterRetireResult {
  readonly kind: "retire";
  readonly player: string;
  readonly status: LifecycleMutationStatus;
  readonly text: string;
}

export interface RosterBenchMutationRow {
  readonly id: string;
  readonly action: BenchAction;
  readonly status: LifecycleMutationStatus;
}

/** Structured bench outcome for native adapters; `bench()` remains the text-compatible API. */
export type RosterBenchResult =
  | { readonly kind: "list"; readonly text: string }
  | {
      readonly kind: "mutation";
      readonly status: LifecycleMutationStatus;
      readonly rows: readonly RosterBenchMutationRow[];
      readonly text: string;
    };

const maximumTransactionFileBytes = 30_000;
const lifecycleWorkerRpcTimeoutMs = 5_000;
const lifecycleWorkerExitTimeoutMs = 2_000;
const lifecycleRuntimeProbeTimeoutMs = 2_000;
const lifecycleRuntimeResolutionTimeoutMs = 4_500;
const maximumLifecycleRuntimeCandidates = 64;
const lifecycleRuntimeProbeMarker = "agent-harbor-node-runtime-v1";
const minimumLifecycleNodeVersion = "22.19.0";

interface FileIdentity {
  readonly dev: string;
  readonly ino: string;
}

interface FileSnapshot {
  readonly content?: Buffer;
  readonly identity?: FileIdentity;
  readonly mtimeMs?: number;
}

interface StagedChange {
  readonly path: string;
  readonly directory: BoundDirectory;
  readonly stepId: string;
  readonly before: FileSnapshot;
  readonly after: FileSnapshot;
  readonly status: LifecycleMutationStatus;
}

interface ActiveTransaction {
  readonly expected: ReadonlyMap<string, FileSnapshot>;
  readonly targets: ReadonlyMap<string, BoundTarget>;
  readonly staged: StagedChange[];
}

interface WireSnapshot {
  readonly exists: boolean;
  readonly content?: string;
  readonly identity?: FileIdentity;
  readonly mtimeMs?: number;
}

interface WorkerResponse {
  readonly requestId: number;
  readonly ok: boolean;
  readonly value?: any;
  readonly error?: { readonly message?: string; readonly code?: string };
}

interface BoundDirectory {
  readonly path: string;
  readonly identity: FileIdentity;
  readonly worker: LifecycleDirectoryWorker;
}

interface BoundTarget {
  readonly directory: BoundDirectory;
  readonly name: string;
}

interface LifecycleNodeRuntime {
  readonly executable: string;
  readonly environment: NodeJS.ProcessEnv;
}

/** Parses bench syntax without touching roster state or the filesystem. */
function parseBenchCommand(args: string, bundled: ReadonlyMap<string, PlayerDefinition>): BenchCommand {
  const value = args.trim();
  if (!value || value === "list" || value.startsWith("list ")) {
    return { kind: "list", filter: value.startsWith("list ") ? value.slice(5).trim().toLowerCase() : "" };
  }
  const match = /^(on|off)\s+(.+)$/.exec(value);
  if (!match) throw new Error("usage: bench [list|on|off]");
  const requested = match[2].split(/[\s,]+/).filter(Boolean);
  const ids = requested.length === 1 && requested[0] === "all" ? [...bundled.keys()] : [...new Set(requested)];
  if (!ids.length || ids.some((id) => !isHarborId(id))) throw new Error("invalid player list");
  return { kind: "mutate", action: match[1] as BenchAction, ids };
}

function contained(parent: string, child: string): string {
  const root = resolve(parent);
  const target = resolve(child);
  const rel = relative(root, target);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) throw new Error(`unsafe path: ${target}`);
  return target;
}

async function existingBytes(path: string): Promise<Buffer | undefined> {
  try { return await readFile(path); } catch (error: any) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

async function existing(path: string): Promise<string | undefined> {
  return (await existingBytes(path))?.toString("utf8");
}

function sameSnapshot(left: FileSnapshot, right: FileSnapshot): boolean {
  if (left.content === undefined || right.content === undefined) {
    return left.content === undefined && right.content === undefined;
  }
  return left.identity !== undefined && right.identity !== undefined
    && left.identity.dev === right.identity.dev && left.identity.ino === right.identity.ino
    && left.content.equals(right.content);
}

function snapshotFromWire(value: WireSnapshot): FileSnapshot {
  if (!value || typeof value.exists !== "boolean") throw new Error("lifecycle worker returned an invalid snapshot");
  if (!value.exists) return {};
  if (typeof value.content !== "string" || !Number.isFinite(value.mtimeMs)) {
    throw new Error("lifecycle worker returned an invalid snapshot");
  }
  const content = Buffer.from(value.content, "base64");
  if (content.length > maximumTransactionFileBytes || content.toString("base64") !== value.content) {
    throw new Error("lifecycle worker returned invalid snapshot content");
  }
  return { content, identity: identityFromWire(value.identity), mtimeMs: value.mtimeMs };
}

function identityOf(stat: BigIntStats): FileIdentity {
  if (stat.dev === 0n || stat.ino === 0n) throw new Error("filesystem returned an unusable zero identity");
  return { dev: stat.dev.toString(), ino: stat.ino.toString() };
}

function identityFromWire(value: unknown): FileIdentity {
  const candidate = value as Partial<FileIdentity> | undefined;
  if (!candidate || typeof candidate.dev !== "string" || typeof candidate.ino !== "string"
      || !/^[1-9][0-9]*$/u.test(candidate.dev) || !/^[1-9][0-9]*$/u.test(candidate.ino)) {
    throw new Error("lifecycle worker returned an invalid filesystem identity");
  }
  return { dev: candidate.dev, ino: candidate.ino };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function isSupportedLifecycleNodeVersion(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/u.exec(value);
  if (!match) return false;
  const [major, minor, patch] = match.slice(1).map(Number);
  return major > 22 || (major === 22 && (minor > 19 || (minor === 19 && patch >= 0)));
}

function isNodeExecutableName(path: string): boolean {
  const name = basename(path).toLowerCase();
  return name === "node" || name === "node.exe" || name === "nodejs";
}

function isWithinAnyRoot(path: string, roots: readonly string[]): boolean {
  const target = resolve(path);
  return roots.some((root) => {
    const absoluteRoot = resolve(root);
    // A filesystem root is not a meaningful untrusted project boundary.
    if (dirname(absoluteRoot) === absoluteRoot) return false;
    const rel = relative(absoluteRoot, target);
    return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
  });
}

function sanitizedLifecycleWorkerEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment = { ...source };
  for (const key of Object.keys(environment)) {
    const normalized = key.toUpperCase();
    if (normalized === "NODE_OPTIONS" || normalized === "NODE_PATH") delete environment[key];
  }
  return environment;
}

function lifecycleNodeCandidates(
  hostExecutable: string,
  environment: NodeJS.ProcessEnv,
  forbiddenRoots: readonly string[],
  platform: NodeJS.Platform = process.platform,
): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();
  const executableNames = platform === "win32" ? ["node.exe"] : ["node", "nodejs"];
  const addExecutable = (value: string | undefined): void => {
    if (typeof value !== "string" || value.length === 0 || value.length > 32_768 || value.includes("\0")) return;
    if (!isAbsolute(value) || !isNodeExecutableName(value) || isWithinAnyRoot(value, forbiddenRoots)) return;
    const key = platform === "win32" ? value.toLowerCase() : value;
    if (!seen.has(key)) {
      seen.add(key);
      candidates.push(value);
    }
  };
  const addDirectory = (value: string | undefined, suffix = ""): void => {
    if (typeof value !== "string" || value.length === 0 || value.length > 32_768 || value.includes("\0")) return;
    if (!isAbsolute(value)) return;
    const directory = suffix ? join(value, suffix) : value;
    for (const name of executableNames) addExecutable(join(directory, name));
  };

  addExecutable(hostExecutable);
  addExecutable(environment.npm_node_execpath);
  addDirectory(environment.NODE_HOME, "bin");
  addDirectory(environment.NVM_BIN);
  addDirectory(environment.NVM_SYMLINK);
  addDirectory(environment.FNM_MULTISHELL_PATH, "bin");
  addDirectory(environment.VOLTA_HOME, "bin");
  addDirectory(environment.ASDF_DATA_DIR, "shims");
  addDirectory(environment.MISE_DATA_DIR, "shims");

  if (platform === "win32") {
    for (const root of [environment.ProgramW6432, environment.ProgramFiles, environment["ProgramFiles(x86)"]]) {
      addDirectory(root, "nodejs");
    }
    addDirectory(environment.LOCALAPPDATA, join("Programs", "nodejs"));
  } else {
    for (const candidate of [
      "/usr/bin/node", "/usr/bin/nodejs", "/usr/local/bin/node", "/usr/local/bin/nodejs",
      "/opt/homebrew/bin/node", "/opt/local/bin/node", "/snap/bin/node",
    ]) addExecutable(candidate);
  }

  // Never ask the OS to search PATH. Empty entries mean cwd and relative
  // entries are cwd-relative, so both are intentionally ignored. Absolute
  // entries are still rejected later when they fall inside a protected root.
  // Fixed install roots stay ahead so an oversized PATH cannot starve them.
  const pathValue = environment.PATH ?? environment.Path;
  if (typeof pathValue === "string" && pathValue.length <= 1_000_000) {
    for (const entry of pathValue.split(delimiter).slice(0, maximumLifecycleRuntimeCandidates)) {
      const directory = entry.trim();
      if (!directory || !isAbsolute(directory)) continue;
      addDirectory(directory);
    }
  }
  return candidates.slice(0, maximumLifecycleRuntimeCandidates);
}

async function terminateRuntimeProbe(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
  child.kill();
  const exited = await Promise.race([
    new Promise<boolean>((resolveExit) => child.once("close", () => resolveExit(true))),
    delay(250).then(() => false),
  ]);
  if (exited || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGKILL");
  await Promise.race([
    new Promise<void>((resolveExit) => child.once("close", () => resolveExit())),
    delay(250).then(() => undefined),
  ]);
}

async function canonicalLifecycleNodeExecutable(
  candidate: string,
  forbiddenRoots: readonly string[],
  timeoutMs: number,
): Promise<string | undefined> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const resolved = (async (): Promise<string | undefined> => {
    try {
      const executable = await realpath(candidate);
      const stat = await lstat(executable);
      if (!stat.isFile() || isWithinAnyRoot(executable, forbiddenRoots)) return undefined;
      return executable;
    } catch {
      return undefined;
    }
  })();
  const result = await Promise.race([
    resolved,
    new Promise<undefined>((resolveTimeout) => {
      timeout = setTimeout(() => resolveTimeout(undefined), Math.max(1, timeoutMs));
    }),
  ]);
  if (timeout) clearTimeout(timeout);
  return result;
}

async function probeLifecycleNodeRuntime(
  candidate: string,
  environment: NodeJS.ProcessEnv,
  forbiddenRoots: readonly string[],
  timeoutMs: number,
): Promise<string | undefined> {
  if (!isAbsolute(candidate) || !isNodeExecutableName(candidate) || isWithinAnyRoot(candidate, forbiddenRoots)) {
    return undefined;
  }
  const deadline = Date.now() + Math.max(1, timeoutMs);
  const canonicalCandidate = await canonicalLifecycleNodeExecutable(candidate, forbiddenRoots, deadline - Date.now());
  if (!canonicalCandidate || Date.now() >= deadline) return undefined;
  const probeSource = `process.stdout.write(JSON.stringify({marker:${JSON.stringify(lifecycleRuntimeProbeMarker)},version:process.versions.node,execPath:process.execPath}))`;
  const child = spawn(canonicalCandidate, ["--input-type=module", "--eval", probeSource], {
    env: environment,
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
  });
  let output = "";
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    output += chunk;
    if (output.length > 2_048) child.kill();
  });
  const completion = new Promise<boolean>((resolveProbe) => {
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      resolveProbe(ok);
    };
    child.once("error", () => finish(false));
    child.once("close", (code, signal) => finish(code === 0 && signal === null));
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const exited = await Promise.race([
    completion,
    new Promise<undefined>((resolveTimeout) => {
      timeout = setTimeout(() => resolveTimeout(undefined), Math.max(1, deadline - Date.now()));
    }),
  ]);
  if (timeout) clearTimeout(timeout);
  if (exited !== true) {
    await terminateRuntimeProbe(child);
    return undefined;
  }
  if (output.length > 2_048) return undefined;
  let result: { marker?: unknown; version?: unknown; execPath?: unknown };
  try { result = JSON.parse(output); } catch { return undefined; }
  if (result.marker !== lifecycleRuntimeProbeMarker || !isSupportedLifecycleNodeVersion(result.version)
      || typeof result.execPath !== "string" || !isAbsolute(result.execPath) || !isNodeExecutableName(result.execPath)) {
    return undefined;
  }
  if (Date.now() >= deadline) return undefined;
  return canonicalLifecycleNodeExecutable(result.execPath, forbiddenRoots, deadline - Date.now());
}

async function resolveLifecycleNodeRuntime(
  hostExecutable: string,
  sourceEnvironment: NodeJS.ProcessEnv,
  forbiddenRoots: readonly string[],
): Promise<LifecycleNodeRuntime> {
  const environment = sanitizedLifecycleWorkerEnvironment(sourceEnvironment);
  const deadline = Date.now() + lifecycleRuntimeResolutionTimeoutMs;
  for (const candidate of lifecycleNodeCandidates(hostExecutable, sourceEnvironment, forbiddenRoots)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const executable = await probeLifecycleNodeRuntime(
      candidate,
      environment,
      forbiddenRoots,
      Math.min(lifecycleRuntimeProbeTimeoutMs, remaining),
    );
    if (executable) return { executable, environment };
  }
  throw new Error(
    `Agent Harbor lifecycle requires an absolute Node.js ${minimumLifecycleNodeVersion} or newer runtime; ` +
    "the current host is not compatible and no safe runtime was found outside the project",
  );
}

/**
 * Inline ESM worker. Its cwd is the directory capability: after bootstrap it
 * accepts only single path segments and journal-relative operations.
 */
const lifecycleDirectoryWorkerSource = String.raw`
import { constants } from "node:fs";
import { chmod, link, lstat, mkdir, mkdtemp, open, readdir, rename, rmdir, unlink } from "node:fs/promises";
import { randomBytes } from "node:crypto";

const nodeVersion = process.versions.node.split(".").map(Number);
if (nodeVersion[0] < 22 || (nodeVersion[0] === 22 && nodeVersion[1] < 19)) {
  throw new Error("Agent Harbor lifecycle requires Node.js 22.19.0 or newer");
}

const maximumBytes = 30000;
const noFollow = constants.O_NOFOLLOW || 0;
const nonBlocking = constants.O_NONBLOCK || 0;
let parentIdentity;
let anchorName;
let anchorIdentity;
let lock;
const steps = new Map();
let queue = Promise.resolve();

function identity(stat) {
  if (stat.dev === 0n || stat.ino === 0n) throw new Error("filesystem returned an unusable zero identity");
  return { dev: String(stat.dev), ino: String(stat.ino) };
}
function sameIdentity(left, right) { return Boolean(left && right && left.dev === right.dev && left.ino === right.ino); }
function segment(value) {
  if (typeof value !== "string" || !value || value === "." || value === ".." || value.length > 255 || /[\\/\0]/u.test(value)) {
    throw new Error("worker refused a non-segment path");
  }
  return value;
}
function journal(stepId, suffix) {
  if (typeof stepId !== "string" || !/^[a-z0-9-]{1,80}$/u.test(stepId)) throw new Error("invalid worker step id");
  return anchorName + "/" + stepId + "-" + suffix;
}
async function entry(path) {
  try { return await lstat(path, { bigint: true }); }
  catch (error) { if (error && error.code === "ENOENT") return undefined; throw error; }
}
async function assertBound(requireAnchor = true) {
  const current = await lstat(".", { bigint: true });
  if (!current.isDirectory() || current.isSymbolicLink() || !sameIdentity(identity(current), parentIdentity)) {
    throw new Error("worker cwd identity changed");
  }
  if (requireAnchor) {
    const anchor = await lstat(anchorName, { bigint: true });
    if (!anchor.isDirectory() || anchor.isSymbolicLink() || !sameIdentity(identity(anchor), anchorIdentity)) {
      throw new Error("worker anchor identity changed");
    }
  }
}
async function snapshot(path) {
  const before = await entry(path);
  if (!before) return { exists: false };
  if (before.isSymbolicLink()) throw new Error("symlink traversal refused: transaction target");
  if (!before.isFile()) throw new Error("transaction target is not a regular file");
  if (before.size > BigInt(maximumBytes)) throw new Error("transaction target exceeds 30000 bytes");
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | noFollow | nonBlocking);
    const openedBefore = await handle.stat({ bigint: true });
    if (!openedBefore.isFile() || !sameIdentity(identity(before), identity(openedBefore)) || openedBefore.size > BigInt(maximumBytes)) {
      throw new Error("transaction target changed while opening");
    }
    const bytes = Buffer.alloc(maximumBytes + 1);
    let used = 0;
    while (used < bytes.length) {
      const result = await handle.read(bytes, used, bytes.length - used, null);
      if (result.bytesRead === 0) break;
      used += result.bytesRead;
    }
    const openedAfter = await handle.stat({ bigint: true });
    const after = await lstat(path, { bigint: true });
    if (used > maximumBytes || !after.isFile() || after.isSymbolicLink()
      || !sameIdentity(identity(openedBefore), identity(openedAfter))
      || !sameIdentity(identity(openedAfter), identity(after))
      || openedBefore.size !== openedAfter.size || openedBefore.mtimeNs !== openedAfter.mtimeNs
      || BigInt(used) !== openedAfter.size) {
      throw new Error("transaction target changed while reading");
    }
    return {
      exists: true,
      content: bytes.subarray(0, used).toString("base64"),
      identity: identity(openedAfter),
      mtimeMs: Number(openedAfter.mtimeMs),
    };
  } finally { if (handle) await handle.close(); }
}
function sameSnapshot(left, right) {
  if (Boolean(left && left.exists) !== Boolean(right && right.exists)) return false;
  if (!left || !left.exists) return true;
  return sameIdentity(left.identity, right.identity) && left.content === right.content;
}
async function writeNext(path, content) {
  const bytes = Buffer.from(content, "base64");
  if (bytes.length > maximumBytes) throw new Error("transaction content exceeds 30000 bytes");
  let handle;
  try {
    handle = await open(path, "wx", 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
  } finally { if (handle) await handle.close(); }
  return snapshot(path);
}
async function removePrivate(path, expected) {
  const current = await snapshot(path);
  if (!sameSnapshot(current, expected)) throw new Error("private journal ownership changed");
  await unlink(path);
}
async function restoreLink(source, target, expected) {
  await link(source, target);
  const restored = await snapshot(target);
  if (!sameSnapshot(restored, expected)) throw new Error("could not prove restored file identity");
}
async function removeNamedExact(name, expected, stepId) {
  await assertBound();
  const current = await snapshot(name);
  if (!sameSnapshot(current, expected)) throw new Error("ownership changed before cleanup");
  const held = journal(stepId, "remove");
  await rename(name, held);
  const moved = await snapshot(held);
  if (!sameSnapshot(moved, expected)) {
    try { await restoreLink(held, name, moved); } catch {}
    throw new Error("ownership changed during cleanup");
  }
  await removePrivate(held, moved);
}
async function bootstrap(message) {
  if (parentIdentity) throw new Error("worker is already bound");
  const initial = await lstat(".", { bigint: true });
  if (!initial.isDirectory() || initial.isSymbolicLink() || !sameIdentity(identity(initial), message.expected)) {
    throw new Error("worker bootstrap identity mismatch");
  }
  if (!Array.isArray(message.segments) || message.segments.length > 32) throw new Error("invalid bootstrap path");
  for (const raw of message.segments) {
    const name = segment(raw);
    let child = await entry(name);
    if (!child) {
      try { await mkdir(name, { recursive: false, mode: 0o700 }); }
      catch (error) { if (!error || error.code !== "EEXIST") throw error; }
      child = await lstat(name, { bigint: true });
    }
    if (child.isSymbolicLink()) throw new Error("symlink traversal refused: bootstrap directory");
    if (!child.isDirectory()) throw new Error("unsafe bootstrap directory");
    const expected = identity(child);
    process.chdir(name);
    const landed = await lstat(".", { bigint: true });
    if (!landed.isDirectory() || landed.isSymbolicLink() || !sameIdentity(identity(landed), expected)) {
      throw new Error("bootstrap directory changed during descent");
    }
  }
  const parent = await lstat(".", { bigint: true });
  parentIdentity = identity(parent);
  let probeIdentity;
  let probeCandidate;
  try {
    anchorName = await mkdtemp(".harbor-txn-" + randomBytes(24).toString("hex") + "-");
    const anchor = await lstat(anchorName, { bigint: true });
    anchorIdentity = identity(anchor);
    if (process.platform !== "win32") await chmod(anchorName, 0o700);
    const probeSource = anchorName + "/probe-source";
    const probeLink = anchorName + "/probe-link";
    let probe;
    try {
      probe = await open(probeSource, "wx", 0o600);
      probeIdentity = identity(await probe.stat({ bigint: true }));
      await probe.writeFile("probe");
      await probe.sync();
      const opened = await probe.stat({ bigint: true });
      probeCandidate = {
        exists: true,
        content: Buffer.from("probe").toString("base64"),
        identity: identity(opened),
        mtimeMs: Number(opened.mtimeMs),
      };
    } finally { if (probe) await probe.close(); }
    await link(probeSource, probeLink);
    const source = await snapshot(probeSource);
    const linked = await snapshot(probeLink);
    if (!sameSnapshot(source, probeCandidate) || !sameSnapshot(source, linked)) {
      throw new Error("filesystem hard-link identity is unavailable");
    }
    await removePrivate(probeLink, linked);
    await removePrivate(probeSource, source);
    return { parentIdentity, anchorIdentity };
  } catch (error) {
    if (anchorName && anchorIdentity) {
      try {
        await assertBound();
        for (const path of [anchorName + "/probe-link", anchorName + "/probe-source"]) {
          try {
            const current = await snapshot(path);
            if (current.exists && probeIdentity && sameIdentity(current.identity, probeIdentity)) {
              await removePrivate(path, current);
            }
          } catch {}
        }
        const currentAnchor = await lstat(anchorName, { bigint: true });
        const entries = await readdir(anchorName);
        if (sameIdentity(identity(currentAnchor), anchorIdentity) && entries.length === 0) await rmdir(anchorName);
      } catch {}
    }
    throw error;
  }
}
async function stage(message) {
  await assertBound();
  const name = segment(message.name);
  const stepId = message.stepId;
  if (steps.has(stepId)) throw new Error("duplicate worker step id");
  const current = await snapshot(name);
  if (!sameSnapshot(current, message.expected)) throw new Error("transaction target changed after ownership preflight");
  const desired = message.content === null ? undefined : Buffer.from(message.content, "base64");
  if (desired && desired.length > maximumBytes) throw new Error("transaction content exceeds 30000 bytes");
  if (current.exists && desired && current.content === desired.toString("base64")) {
    const step = { stepId, name, before: current, after: current, noop: true };
    steps.set(stepId, step);
    return { before: current, after: current, status: "already-current" };
  }
  if (!current.exists && !desired) {
    const step = { stepId, name, before: current, after: current, noop: true };
    steps.set(stepId, step);
    return { before: current, after: current, status: "already-current" };
  }
  const beforePath = current.exists ? journal(stepId, "before") : undefined;
  const nextPath = desired ? journal(stepId, "next") : undefined;
  let next;
  try {
    if (nextPath) next = await writeNext(nextPath, message.content);
    if (beforePath) {
      await rename(name, beforePath);
      const moved = await snapshot(beforePath);
      if (!sameSnapshot(moved, current)) {
        try { await restoreLink(beforePath, name, moved); } catch {}
        throw new Error("transaction target changed before commit");
      }
    }
    let after = { exists: false };
    if (nextPath) {
      try { await link(nextPath, name); }
      catch (error) {
        if (beforePath) {
          try { await restoreLink(beforePath, name, current); } catch {}
        }
        throw error;
      }
      after = await snapshot(name);
      if (!sameSnapshot(after, next)) throw new Error("transaction could not prove publication identity");
    }
    const step = { stepId, name, before: current, after, beforePath, nextPath, noop: false };
    steps.set(stepId, step);
    return { before: current, after, status: "changed" };
  } catch (error) {
    if (nextPath) {
      try { const owned = await snapshot(nextPath); if (next && sameSnapshot(owned, next)) await removePrivate(nextPath, next); } catch {}
    }
    throw error;
  }
}
async function verify(message) {
  await assertBound();
  const step = steps.get(message.stepId);
  if (!step) throw new Error("unknown worker step");
  const current = await snapshot(step.name);
  if (!sameSnapshot(current, step.after)) throw new Error("transaction verification failed");
  return current;
}
async function rollback(message) {
  await assertBound();
  const step = steps.get(message.stepId);
  if (!step) throw new Error("unknown worker step");
  if (step.noop) {
    const current = await snapshot(step.name);
    if (!sameSnapshot(current, step.after)) throw new Error("transaction target changed before rollback; foreign file preserved");
    steps.delete(step.stepId);
    return;
  }
  let rolledForwardPath;
  let rolledForward;
  if (step.after.exists) {
    rolledForwardPath = journal(step.stepId, "after");
    await rename(step.name, rolledForwardPath);
    rolledForward = await snapshot(rolledForwardPath);
    if (!sameSnapshot(rolledForward, step.after)) {
      try { await restoreLink(rolledForwardPath, step.name, rolledForward); } catch {}
      throw new Error("transaction target changed before rollback; foreign file preserved");
    }
  } else {
    const current = await snapshot(step.name);
    if (current.exists) throw new Error("transaction target appeared before rollback; foreign file preserved");
  }
  if (step.before.exists) {
    if (!step.beforePath) throw new Error("transaction lost rollback snapshot");
    await restoreLink(step.beforePath, step.name, step.before);
  }
  if (rolledForwardPath) await removePrivate(rolledForwardPath, rolledForward);
  if (step.nextPath) await removePrivate(step.nextPath, step.after);
  if (step.beforePath) await removePrivate(step.beforePath, step.before);
  steps.delete(step.stepId);
}
async function finalize(message) {
  await assertBound();
  const step = steps.get(message.stepId);
  if (!step) throw new Error("unknown worker step");
  const current = await snapshot(step.name);
  if (!sameSnapshot(current, step.after)) throw new Error("transaction changed before finalize");
  if (step.beforePath) await removePrivate(step.beforePath, step.before);
  if (step.nextPath) await removePrivate(step.nextPath, step.after);
  steps.delete(step.stepId);
}
async function acquireLock(message) {
  await assertBound();
  if (lock) throw new Error("worker already owns a lock");
  const name = segment(message.name);
  const bytes = Buffer.from(message.content, "base64");
  if (bytes.length > maximumBytes) throw new Error("lock record is oversized");
  let handle;
  let candidate;
  try {
    handle = await open(name, "wx", 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.size !== BigInt(bytes.length)) throw new Error("lock changed during acquisition");
    candidate = {
      exists: true,
      content: bytes.toString("base64"),
      identity: identity(opened),
      mtimeMs: Number(opened.mtimeMs),
    };
    const owned = await snapshot(name);
    if (!sameSnapshot(owned, candidate)) throw new Error("lock changed during acquisition");
    lock = { name, handle, snapshot: owned };
    return owned;
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    if (candidate) {
      try { await removeNamedExact(name, candidate, "failed-lock-" + randomBytes(10).toString("hex")); } catch {}
    }
    throw error;
  }
}
async function releaseLock(message) {
  await assertBound();
  if (!lock || lock.name !== segment(message.name)) throw new Error("worker does not own this lock");
  await lock.handle.close();
  const owned = lock.snapshot;
  lock = undefined;
  try { await removeNamedExact(message.name, owned, "lock-" + randomBytes(10).toString("hex")); }
  catch (error) { throw new Error("roster lock ownership changed before cleanup", { cause: error }); }
}
async function closeWorker() {
  await assertBound();
  if (lock) throw new Error("worker lock is still open");
  if (steps.size) throw new Error("worker transaction journal is still active");
  const entries = await readdir(anchorName);
  if (entries.length) throw new Error("worker anchor is not empty");
  const anchor = await lstat(anchorName, { bigint: true });
  if (!sameIdentity(identity(anchor), anchorIdentity)) throw new Error("worker anchor ownership changed");
  await rmdir(anchorName);
  anchorName = undefined;
  anchorIdentity = undefined;
}
async function dispatch(message) {
  if (!message || typeof message !== "object" || !Number.isSafeInteger(message.requestId)) throw new Error("invalid worker request");
  switch (message.op) {
    case "bootstrap": return bootstrap(message);
    case "snapshot": await assertBound(); return snapshot(segment(message.name));
    case "list": await assertBound(); return readdir(".");
    case "stage": return stage(message);
    case "verify": return verify(message);
    case "rollback": return rollback(message);
    case "finalize": return finalize(message);
    case "lock.acquire": return acquireLock(message);
    case "lock.release": return releaseLock(message);
    case "remove.exact": return removeNamedExact(segment(message.name), message.expected, "remove-" + randomBytes(10).toString("hex"));
    case "close": return closeWorker();
    default: throw new Error("unsupported worker operation");
  }
}
process.on("message", (message) => {
  queue = queue.then(async () => {
    try {
      const value = await dispatch(message);
      if (process.send) process.send({ requestId: message.requestId, ok: true, value });
    } catch (error) {
      if (process.send) process.send({
        requestId: message && message.requestId,
        ok: false,
        error: { message: error instanceof Error ? error.message : "worker failure", code: error && error.code },
      });
    }
  });
});
`;

class LifecycleDirectoryWorker {
  private sequence = 0;
  private closed = false;
  private processClosed = false;
  private termination?: Promise<void>;
  private readonly pending = new Map<number, {
    resolve(value: any): void;
    reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  private constructor(
    private readonly child: ChildProcess,
    readonly canonicalPath: string,
    private identityValue: FileIdentity,
  ) {
    child.on("message", (message: WorkerResponse) => this.onMessage(message));
    child.on("error", (error) => this.fail(error));
    child.on("exit", (code, signal) => {
      if (!this.closed) this.fail(new Error(`lifecycle worker exited unexpectedly (${code ?? signal ?? "unknown"})`));
    });
    child.on("close", () => { this.processClosed = true; });
  }

  get identity(): FileIdentity { return this.identityValue; }

  get pid(): number {
    const pid = this.child.pid;
    if (!Number.isSafeInteger(pid) || (pid ?? 0) <= 0) throw new Error("lifecycle worker has no usable process id");
    return pid!;
  }

  static async bind(canonicalPath: string, runtime: LifecycleNodeRuntime): Promise<LifecycleDirectoryWorker> {
    let existingPath = resolve(canonicalPath);
    const segments: string[] = [];
    let stat: BigIntStats;
    while (true) {
      try {
        stat = await lstat(existingPath, { bigint: true });
        break;
      } catch (error: any) {
        if (error?.code !== "ENOENT") throw error;
        const parent = dirname(existingPath);
        if (parent === existingPath) throw new Error(`no existing directory anchors ${canonicalPath}`);
        segments.unshift(basename(existingPath));
        existingPath = parent;
      }
    }
    if (stat.isSymbolicLink()) throw new Error(`symlink traversal refused: ${existingPath}`);
    if (!stat.isDirectory()) throw new Error(`unsafe lifecycle directory: ${existingPath}`);
    await rejectSymlinkTraversal(parse(existingPath).root, join(existingPath, ".harbor-bind-probe"));
    const expected = identityOf(stat);
    const child = spawn(runtime.executable, ["--input-type=module", "--eval", lifecycleDirectoryWorkerSource], {
      cwd: existingPath,
      env: runtime.environment,
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      windowsHide: true,
    });
    await new Promise<void>((resolveSpawn, rejectSpawn) => {
      child.once("spawn", resolveSpawn);
      child.once("error", rejectSpawn);
    });
    const provisional = new LifecycleDirectoryWorker(child, resolve(canonicalPath), expected);
    try {
      const result = await provisional.request("bootstrap", { expected, segments });
      provisional.identityValue = identityFromWire(result?.parentIdentity);
      await provisional.assertCanonical();
      return provisional;
    } catch (error) {
      await provisional.terminate();
      throw error;
    }
  }

  private onMessage(message: WorkerResponse): void {
    const pending = this.pending.get(message.requestId);
    if (!pending) return;
    this.pending.delete(message.requestId);
    clearTimeout(pending.timer);
    if (message.ok) pending.resolve(message.value);
    else {
      const error: any = new Error(message.error?.message ?? "lifecycle worker failed");
      if (message.error?.code) error.code = message.error.code;
      pending.reject(error);
    }
  }

  private fail(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private request(op: string, payload: Record<string, unknown> = {}): Promise<any> {
    if (this.closed || !this.child.connected) return Promise.reject(new Error("lifecycle worker is closed"));
    const requestId = ++this.sequence;
    return new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        rejectRequest(new Error(`lifecycle worker ${op} timed out`));
        void this.terminate();
      }, lifecycleWorkerRpcTimeoutMs);
      this.pending.set(requestId, { resolve: resolveRequest, reject: rejectRequest, timer });
      this.child.send({ requestId, op, ...payload }, (error) => {
        if (!error) return;
        const pending = this.pending.get(requestId);
        if (!pending) return;
        this.pending.delete(requestId);
        clearTimeout(pending.timer);
        pending.reject(error);
      });
    });
  }

  async assertCanonical(): Promise<void> {
    const stat = await lstat(this.canonicalPath, { bigint: true });
    if (stat.isSymbolicLink() || !stat.isDirectory() || !sameIdentity(identityOf(stat), this.identity)) {
      throw new Error(`lifecycle directory identity changed: ${this.canonicalPath}`);
    }
  }

  async snapshot(name: string): Promise<FileSnapshot> {
    return snapshotFromWire(await this.request("snapshot", { name }));
  }

  async list(): Promise<string[]> {
    const entries = await this.request("list");
    if (!Array.isArray(entries) || entries.some((entry) => typeof entry !== "string") || entries.length > 4_096) {
      throw new Error("lifecycle worker returned an invalid directory listing");
    }
    return entries;
  }

  async stage(
    name: string,
    stepId: string,
    expected: FileSnapshot,
    content: Buffer | undefined,
  ): Promise<{ readonly after: FileSnapshot; readonly status: LifecycleMutationStatus }> {
    const result = await this.request("stage", {
      name,
      stepId,
      expected: this.toWire(expected),
      content: content === undefined ? null : content.toString("base64"),
    });
    if (result?.status !== "changed" && result?.status !== "already-current") {
      throw new Error("lifecycle worker returned an invalid mutation status");
    }
    return { after: snapshotFromWire(result.after), status: result.status };
  }

  async verify(stepId: string): Promise<void> { await this.request("verify", { stepId }); }
  async rollback(stepId: string): Promise<void> { await this.request("rollback", { stepId }); }
  async finalize(stepId: string): Promise<void> { await this.request("finalize", { stepId }); }

  async acquireLock(name: string, content: Buffer): Promise<FileSnapshot> {
    return snapshotFromWire(await this.request("lock.acquire", { name, content: content.toString("base64") }));
  }

  async releaseLock(name: string): Promise<void> { await this.request("lock.release", { name }); }

  async removeExact(name: string, expected: FileSnapshot): Promise<void> {
    await this.request("remove.exact", { name, expected: this.toWire(expected) });
  }

  private toWire(snapshot: FileSnapshot): WireSnapshot {
    return snapshot.content === undefined
      ? { exists: false }
      : { exists: true, content: snapshot.content.toString("base64"), identity: snapshot.identity, mtimeMs: snapshot.mtimeMs };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    try { await this.request("close"); }
    finally { await this.terminate(); }
  }

  terminate(): Promise<void> {
    this.termination ??= this.terminateOnce();
    return this.termination;
  }

  private async waitForProcessClose(): Promise<boolean> {
    if (this.processClosed) return true;
    return Promise.race([
      new Promise<boolean>((resolveClose) => this.child.once("close", () => resolveClose(true))),
      delay(lifecycleWorkerExitTimeoutMs).then(() => false),
    ]);
  }

  private async terminateOnce(): Promise<void> {
    this.closed = true;
    this.fail(new Error("lifecycle worker closed"));
    if (this.processClosed) return;
    // Do not call child.disconnect() before termination. With a dedicated IPC
    // stdio slot Node may then omit ChildProcess's `close` event on Windows,
    // which is the only public signal that every inherited handle is released.
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill();
    if (await this.waitForProcessClose()) return;
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill("SIGKILL");
    if (!await this.waitForProcessClose()) {
      throw new Error("lifecycle worker did not close after termination");
    }
  }
}

async function rejectSymlinkTraversal(root: string, target: string): Promise<void> {
  const parent = resolve(root);
  const rel = relative(parent, resolve(target));
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) throw new Error(`unsafe path: ${target}`);
  let cursor = parent;
  for (const segment of ["", ...rel.split(/[\\/]+/)]) {
    if (segment) cursor = join(cursor, segment);
    try { if ((await lstat(cursor)).isSymbolicLink()) throw new Error(`symlink traversal refused: ${cursor}`); }
    catch (error: any) { if (error?.code === "ENOENT") return; throw error; }
  }
}

// Ownership is intentionally narrower than validity: this recognizes only the
// current structural marker or its exact revision-4 predecessor. Revision 4 is
// retained solely so upgrades can repair/remove files Agent Harbor owns; only
// the revision-5 canonical renderer is invocable.
export function isOwnedProfile(content: string | undefined, id: string, expectedRoster?: "personal" | "sdlc"): boolean {
  if (!content?.startsWith("---\n")) return false;
  const end = content.indexOf("\n---\n", 4);
  if (end < 0) return false;
  const marker = /^<!-- agent-foundry:profile id=([a-z0-9-]+) revision=(4|5) -->\n/.exec(content.slice(end + 5));
  if (!marker || marker[1] !== id) return false;
  const revision = marker[2];
  const lines = content.slice(4, end).split("\n");
  if (lines.filter((line) => line === `name: ${JSON.stringify(id)}`).length !== 1) return false;
  const roster = expectedRoster ?? (lines.includes("  roster: personal") ? "personal" : lines.includes("  roster: sdlc") ? "sdlc" : undefined);
  if (!roster) return false;
  const metadata = [
    "metadata:",
    "  owner: agent-foundry",
    `  roster: ${roster}`,
    `  player: ${JSON.stringify(id)}`,
    `  revision: ${JSON.stringify(revision)}`,
  ];
  if (lines.slice(-metadata.length).join("\n") !== metadata.join("\n")) return false;
  return metadata.every((expected) => lines.filter((line) => line === expected).length === 1) &&
    lines.filter((line) => line === "  roster: personal" || line === "  roster: sdlc").length === 1;
}

/**
 * Strictly validates an external player definition and returns its typed form.
 * Unknown keys, duplicate capabilities, reserved names, untrusted GitHub skills, and skill-bearing
 * definitions without read access are rejected before any filesystem mutation occurs.
 */
export function validatePlayer(value: unknown, allowReserved = false): PlayerDefinition {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("expected one JSON object");
  const input = value as Record<string, unknown>;
  const keys = new Set(["name", "description", "prompt", "tools", "model", "replace", "skills"]);
  for (const key of Object.keys(input)) if (!keys.has(key)) throw new Error(`unknown key: ${key}`);
  if (!isHarborId(input.name) || (!allowReserved && reserved.has(input.name))) throw new Error("invalid or reserved name");
  if (typeof input.description !== "string" || !input.description.trim() || input.description.length > 500 || publicMetadataControl.test(input.description)) throw new Error("invalid description");
  if (typeof input.prompt !== "string" || !input.prompt.trim() || input.prompt.length > 18_000) throw new Error("invalid prompt");
  if (!Array.isArray(input.tools) || (!allowReserved && input.tools.length === 0) || input.tools.some((tool) => typeof tool !== "string" || !allowedTools.has(tool))) throw new Error("invalid tools");
  if (new Set(input.tools).size !== input.tools.length) throw new Error("duplicate tools");
  if (input.model !== undefined && (typeof input.model !== "string" || !input.model.trim() || input.model.length > 200 || publicMetadataControl.test(input.model))) throw new Error("invalid model");
  if (input.replace !== undefined && typeof input.replace !== "boolean") throw new Error("invalid replace");
  if (input.skills !== undefined) validateConfiguredSkillReferences(input.skills, input.tools as string[], trustedSkills);
  return {
    ...input,
    description: input.description.trim(),
    prompt: input.prompt.trim(),
    ...(typeof input.model === "string" ? { model: input.model.trim() } : {}),
  } as unknown as PlayerDefinition;
}

/**
 * Owns deterministic join, bench, and retire operations for one harness/project pair.
 * Every mutation is serialized by the home-scoped roster lock and committed across registration
 * and active paths as a verified transaction with best-effort full rollback.
 */
export class Roster {
  private activeTransaction?: ActiveTransaction;
  private boundDirectories?: Map<string, BoundDirectory>;
  private bindingDirectories?: Map<string, Promise<BoundDirectory>>;
  private lifecycleRuntime?: Promise<LifecycleNodeRuntime>;

  /** Binds lifecycle operations to one harness's home, project, layout, and renderer. */
  constructor(private readonly spec: HarnessSpec) {}

  /** Testable host boundary: packaged CLIs may not expose Node through process.execPath. */
  protected lifecycleHostExecutable(): string { return process.execPath; }

  /** Testable environment boundary; executable selection never asks a shell to resolve it. */
  protected lifecycleHostEnvironment(): NodeJS.ProcessEnv { return process.env; }

  /** Abortable contention wait; protected so lock/abort ordering can be tested without sleeps. */
  protected async waitForMutationLock(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    await delay(25, undefined, signal ? { signal } : undefined);
  }

  private nodeRuntime(): Promise<LifecycleNodeRuntime> {
    this.lifecycleRuntime ??= resolveLifecycleNodeRuntime(
      this.lifecycleHostExecutable(),
      this.lifecycleHostEnvironment(),
      [this.spec.home, this.spec.project, process.cwd()],
    );
    return this.lifecycleRuntime;
  }

  private rootFor(path: string): string {
    for (const root of [this.spec.home, this.spec.project]) {
      const rel = relative(resolve(root), resolve(path));
      if (rel && !rel.startsWith("..") && !isAbsolute(rel)) return root;
    }
    throw new Error(`unsafe transaction path: ${path}`);
  }

  private directoryKey(path: string): string {
    const value = resolve(path);
    return process.platform === "win32" ? value.toLowerCase() : value;
  }

  private async bindDirectory(path: string): Promise<BoundDirectory> {
    const directories = this.boundDirectories;
    const bindings = this.bindingDirectories;
    if (!directories || !bindings) throw new Error("lifecycle directory binding is unavailable outside a mutation");
    const canonical = resolve(path);
    const key = this.directoryKey(canonical);
    const existing = directories.get(key);
    if (existing) {
      await existing.worker.assertCanonical();
      return existing;
    }
    const pending = bindings.get(key);
    if (pending) return pending;
    const binding = this.nodeRuntime().then((runtime) => LifecycleDirectoryWorker.bind(canonical, runtime)).then((worker) => {
      const directory = { path: canonical, identity: worker.identity, worker };
      directories.set(key, directory);
      return directory;
    });
    bindings.set(key, binding);
    try { return await binding; }
    finally { if (bindings.get(key) === binding) bindings.delete(key); }
  }

  private async bindTarget(path: string): Promise<BoundTarget> {
    this.rootFor(path);
    const name = basename(path);
    if (!name || name === "." || name === ".." || /[\\/\0]/u.test(name)) throw new Error(`unsafe transaction target: ${path}`);
    return { directory: await this.bindDirectory(dirname(path)), name };
  }

  private async existingBound(path: string): Promise<string | undefined> {
    const target = await this.bindTarget(path);
    await target.directory.worker.assertCanonical();
    const snapshot = await target.directory.worker.snapshot(target.name);
    await target.directory.worker.assertCanonical();
    return snapshot.content?.toString("utf8");
  }

  private async closeBoundDirectories(): Promise<unknown[]> {
    const directories = this.boundDirectories;
    const bindings = this.bindingDirectories;
    this.boundDirectories = undefined;
    this.bindingDirectories = undefined;
    if (!directories) return [];
    const errors: unknown[] = [];
    if (bindings?.size) {
      const settled = await Promise.allSettled(bindings.values());
      for (const result of settled) if (result.status === "rejected") errors.push(result.reason);
    }
    for (const directory of [...directories.values()].reverse()) {
      try { await directory.worker.close(); }
      catch (error) { errors.push(error); }
    }
    return errors;
  }

  // The lock is shared through the harness home, so concurrent projects cannot race updates to the
  // same persistent registration. `wx` provides exclusive acquisition. A dead owner's lock is removed
  // only after its structured ownership record is re-read unchanged; foreign or malformed locks are
  // collisions, never cleanup candidates. Release likewise verifies the token before deleting the file.
  private async withMutationLock<T>(action: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const path = contained(this.spec.home, join(this.spec.home, this.spec.registrationDir, ".roster.lock"));
    if (this.boundDirectories) throw new Error("nested roster mutation is not allowed");
    this.boundDirectories = new Map();
    this.bindingDirectories = new Map();
    const token = randomUUID();
    const errors: unknown[] = [];
    let failure: unknown;
    let value: T | undefined;
    let lockDirectory: BoundDirectory | undefined;
    let ownsLock = false;
    try {
      signal?.throwIfAborted();
      lockDirectory = await this.bindDirectory(dirname(path));
      signal?.throwIfAborted();
      const record = JSON.stringify({ owner: "agent-harbor", pid: lockDirectory.worker.pid, token });
      for (let attempt = 0; attempt < 200 && !ownsLock; attempt += 1) {
        signal?.throwIfAborted();
        await lockDirectory.worker.assertCanonical();
        try {
          await lockDirectory.worker.acquireLock(basename(path), Buffer.from(record, "utf8"));
          ownsLock = true;
        } catch (error: any) {
          if (error?.code !== "EEXIST") throw error;
          signal?.throwIfAborted();
          const current = await lockDirectory.worker.snapshot(basename(path));
          signal?.throwIfAborted();
          if (current.content === undefined) continue;
          let owner: { owner?: unknown; pid?: unknown; token?: unknown };
          try { owner = JSON.parse(current.content.toString("utf8")); }
          catch {
            if (Date.now() - (current.mtimeMs ?? 0) < 1_000) { await delay(25); continue; }
            throw new Error(`unmanaged roster lock collision: ${path}`);
          }
          if (owner.owner !== "agent-harbor" || typeof owner.pid !== "number" || !Number.isSafeInteger(owner.pid) || owner.pid <= 0
              || typeof owner.token !== "string" || owner.token.length === 0 || owner.token.length > 200) {
            throw new Error(`unmanaged roster lock collision: ${path}`);
          }
          let alive = true;
          try { process.kill(owner.pid, 0); }
          catch (signalError: any) { if (signalError?.code === "ESRCH") alive = false; else throw signalError; }
          if (!alive) {
            signal?.throwIfAborted();
            await lockDirectory.worker.removeExact(basename(path), current);
            continue;
          }
          await this.waitForMutationLock(signal);
        }
      }
      if (!ownsLock) throw new Error("roster is busy; retry the operation");
      signal?.throwIfAborted();
      await this.bindDirectory(contained(
        this.spec.project,
        join(this.spec.project, this.spec.activeDir),
      ));
      signal?.throwIfAborted();
      value = await action();
    } catch (error) {
      failure = error;
    }
    if (ownsLock && lockDirectory) {
      try { await lockDirectory.worker.releaseLock(basename(path)); }
      catch (error) { errors.push(error); }
    }
    errors.push(...await this.closeBoundDirectories());
    if (failure !== undefined && errors.length) {
      const message = failure instanceof Error ? failure.message : "roster mutation failed";
      throw new AggregateError([failure, ...errors], `${message}; lifecycle cleanup was incomplete`);
    }
    if (failure !== undefined) throw failure;
    if (errors.length) {
      const first = errors[0] instanceof Error ? errors[0].message : "lifecycle cleanup failed";
      throw new AggregateError(errors, `${first}; roster mutation committed but lifecycle cleanup was incomplete`);
    }
    return value as T;
  }

  /** Stages one identity-bound transaction step; protected for deterministic failure/race injection. */
  protected async applyChange(change: { path: string; content?: string }, _index: number): Promise<void> {
    const transaction = this.activeTransaction;
    const expected = transaction?.expected.get(change.path);
    const target = transaction?.targets.get(change.path);
    if (!transaction || expected === undefined || !target) throw new Error("transaction step has no bound snapshot");
    const desired = change.content === undefined ? undefined : Buffer.from(change.content, "utf8");
    if (desired && desired.length > maximumTransactionFileBytes) {
      throw new Error(`transaction content exceeds ${maximumTransactionFileBytes} bytes: ${change.path}`);
    }
    await target.directory.worker.assertCanonical();
    const stepId = `step-${_index}-${randomUUID()}`;
    const { after, status } = await target.directory.worker.stage(target.name, stepId, expected, desired);
    await target.directory.worker.assertCanonical();
    transaction.staged.push({
      path: change.path,
      directory: target.directory,
      stepId,
      before: expected,
      after,
      status,
    });
  }

  private async verifyStagedChange(change: StagedChange): Promise<void> {
    await change.directory.worker.verify(change.stepId);
    await change.directory.worker.assertCanonical();
  }

  private async finalizeStagedChange(change: StagedChange): Promise<void> {
    await change.directory.worker.finalize(change.stepId);
  }

  private async rollbackStagedChange(change: StagedChange): Promise<void> {
    // Never consult the canonical path here. If an ancestor was renamed, the
    // worker cwd remains bound to the original directory and rollback stays there.
    await change.directory.worker.rollback(change.stepId);
  }

  // Snapshot both identity and exact bytes before writing, stage each change
  // with create-if-absent publication, then verify the complete transaction.
  // Rollback removes only the inode installed by this transaction. Concurrent
  // foreign replacements are preserved and reported as incomplete rollback.
  private async transaction(
    changes: Array<{ path: string; content?: string }>,
  ): Promise<readonly LifecycleMutationStatus[]> {
    if (this.activeTransaction) throw new Error("nested roster transaction is not allowed");
    const bound = await Promise.all(changes.map(async ({ path }) => {
      const target = await this.bindTarget(path);
      await target.directory.worker.assertCanonical();
      const snapshot = await target.directory.worker.snapshot(target.name);
      await target.directory.worker.assertCanonical();
      return { path, target, snapshot };
    }));
    const transaction: ActiveTransaction = {
      expected: new Map(bound.map(({ path, snapshot }) => [path, snapshot])),
      targets: new Map(bound.map(({ path, target }) => [path, target])),
      staged: [],
    };
    this.activeTransaction = transaction;
    try {
      try {
        for (const [index, change] of changes.entries()) {
          await this.applyChange(change, index);
        }
        if (transaction.staged.length !== changes.length || transaction.staged.some((item, index) => item.path !== changes[index]?.path)) {
          throw new Error("lifecycle transaction did not report every staged mutation outcome");
        }
        for (const change of transaction.staged) await this.verifyStagedChange(change);
      } catch (error) {
        const rollbackErrors: unknown[] = [];
        for (const item of [...transaction.staged].reverse()) {
          try { await this.rollbackStagedChange(item); }
          catch (restoreError) { rollbackErrors.push(restoreError); }
        }
        if (rollbackErrors.length) throw new AggregateError([error, ...rollbackErrors], "mutation failed and rollback was incomplete");
        throw error;
      }

      // Verification is the commit boundary. Journal cleanup after it must
      // never route through rollback after an earlier entry has been erased.
      const cleanupErrors: unknown[] = [];
      for (const change of transaction.staged) {
        try { await this.finalizeStagedChange(change); }
        catch (cleanupError) { cleanupErrors.push(cleanupError); }
      }
      if (cleanupErrors.length) {
        throw new AggregateError(cleanupErrors, "mutation committed but transaction cleanup was incomplete");
      }
      return transaction.staged.map(({ status }) => status);
    } finally {
      if (this.activeTransaction === transaction) this.activeTransaction = undefined;
    }
  }

  private paths(id: string) {
    const registration = contained(this.spec.home, join(this.spec.home, this.spec.registrationDir, `${id}${this.spec.extension}`));
    const active = contained(this.spec.project, join(this.spec.project, this.spec.activeDir, `${id}${this.spec.extension}`));
    return { registration, active };
  }

  /**
   * Validates and joins a personal player by writing a portable user registration and a
   * project-bound active profile. Unmanaged collisions are never replaced. A differing owned
   * profile requires `replace: true`, and both files either verify successfully or are restored
   * to their prior exact bytes.
   */
  async joinResult(input: unknown, signal?: AbortSignal): Promise<RosterJoinResult> {
    signal?.throwIfAborted();
    const player = validatePlayer(input);
    const registrationContent = renderPlayerRegistration(this.spec.name, player);
    const activeContent = this.spec.renderPlayer(player, "personal");
    if ([registrationContent, activeContent].some((content) => Buffer.byteLength(content, "utf8") > 30_000)) {
      throw new Error("profile exceeds 30000 bytes");
    }
    return this.withMutationLock(async () => {
      const paths = this.paths(player.name);
      const current = await Promise.all([this.existingBound(paths.registration), this.existingBound(paths.active)]);
      signal?.throwIfAborted();
      for (const collision of current) if (collision !== undefined && !isOwnedProfile(collision, player.name, "personal")) throw new Error("unmanaged collision");
      if (current[0] === undefined) {
        const registrations = await this.registrationEntries();
        signal?.throwIfAborted();
        if (registrations.length >= 200) {
          throw new Error("personal roster limit reached (200); retire an existing personal member before joining another");
        }
      }
      signal?.throwIfAborted();
      const registrationCompatible = current[0] === undefined ||
        isCompatiblePlayerRegistration(current[0], this.spec.name, player);
      const activeCanonical = current[1] === undefined ||
        isCanonicalPlayerProfile(current[1], this.spec.name, player, "personal", this.spec.project);
      if (!player.replace && (!registrationCompatible || !activeCanonical)) {
        throw new Error("replace:true required");
      }
      // This is the cancellation boundary. Once transaction staging begins,
      // ignore later aborts so the verified multi-file commit can finish and
      // its truthful lifecycle outcome reaches the caller.
      signal?.throwIfAborted();
      const fileStatuses = await this.transaction([
        { path: paths.registration, content: registrationContent },
        { path: paths.active, content: activeContent },
      ]);
      const status: LifecycleMutationStatus = fileStatuses.includes("changed") ? "changed" : "already-current";
      const summary = status === "changed"
        ? `joined ${player.name}\nRoster registration and active profile updated.`
        : `${player.name} is already joined with the requested definition.\nNo roster files changed.`;
      return {
        kind: "join",
        player: player.name,
        status,
        text: `${summary}\ncommand: /${player.name} <request>\nregistration: ${paths.registration}\nactive: ${paths.active}`,
      };
    }, signal);
  }

  /** Text-compatible lifecycle API. Native adapters should prefer `joinResult()`. */
  async join(input: unknown, signal?: AbortSignal): Promise<string> {
    return (await this.joinResult(input, signal)).text;
  }

  private async bundledBenchInventory(
    bundled: ReadonlyMap<string, PlayerDefinition>,
    filter: string,
  ): Promise<BenchInventoryRow[]> {
    const rows: BenchInventoryRow[] = [];
    for (const [id, definition] of bundled) {
      const { active } = this.paths(id);
      await rejectSymlinkTraversal(this.spec.project, active);
      const content = await existing(active);
      const state = content === undefined
        ? "bench"
        : !isOwnedProfile(content, id, "sdlc") ? "conflict"
          : isCanonicalPlayerProfile(content, this.spec.name, definition, "sdlc", this.spec.project) ? "on" : "stale";
      if (!filter || id.includes(filter)) rows.push({ id, roster: "bundled", state });
    }
    return rows;
  }

  private async registrationEntries(): Promise<string[]> {
    const registrationRoot = contained(this.spec.home, join(this.spec.home, this.spec.registrationDir));
    try {
      const entries = (this.boundDirectories
        ? await (await this.bindDirectory(registrationRoot)).worker.list()
        : await (async () => {
          await rejectSymlinkTraversal(this.spec.home, join(registrationRoot, "placeholder"));
          return readdir(registrationRoot);
        })())
        .filter((filename) => filename.endsWith(this.spec.extension))
        .sort();
      if (entries.length > 200) {
        throw new Error(`personal roster has ${entries.length} registrations; retire members until at most 200 remain`);
      }
      return entries;
    } catch (error: any) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
  }

  private personalBenchState(
    active: string | undefined,
    activeOwned: boolean,
    definition: PlayerDefinition | undefined,
    registrationCanonical: boolean,
  ): string {
    if (active !== undefined && !activeOwned) return "conflict";
    if (!definition || !registrationCanonical) return "stale";
    if (active !== undefined && !isCanonicalPlayerProfile(active, this.spec.name, definition, "personal", this.spec.project)) return "stale";
    return active === undefined ? "bench" : "on";
  }

  private async personalBenchInventory(filter: string): Promise<BenchInventoryRow[]> {
    const rows: BenchInventoryRow[] = [];
    for (const filename of await this.registrationEntries()) {
      const id = filename.slice(0, -this.spec.extension.length);
      if (!isHarborId(id) || (filter && !id.includes(filter))) continue;
      const paths = this.paths(id);
      await Promise.all([
        rejectSymlinkTraversal(this.spec.home, paths.registration),
        rejectSymlinkTraversal(this.spec.project, paths.active),
      ]);
      const registration = await existing(paths.registration);
      const active = await existing(paths.active);
      if (!isOwnedProfile(registration, id, "personal")) {
        rows.push({ id, roster: "personal", state: "conflict" });
        continue;
      }
      let definition: PlayerDefinition | undefined;
      try { definition = validatePlayer(decodePlayer(registration!, id)); }
      catch { definition = undefined; }
      const registrationCanonical = definition !== undefined &&
        isCanonicalPlayerRegistration(registration!, this.spec.name, definition);
      rows.push({
        id,
        roster: "personal",
        state: this.personalBenchState(active, isOwnedProfile(active, id, "personal"), definition, registrationCanonical),
      });
    }
    return rows;
  }

  private async listBench(
    filter: string,
    bundled: ReadonlyMap<string, PlayerDefinition>,
  ): Promise<string> {
    const rows: BenchInventoryRow[] = [];
    rows.push(...await this.bundledBenchInventory(bundled, filter));
    rows.push(...await this.personalBenchInventory(filter));
    return rows.map(({ id, roster, state }) => `${id} | ${roster} | ${state}`).join("\n");
  }

  private async planBenchPlayer(
    id: string,
    action: BenchAction,
    bundled: ReadonlyMap<string, PlayerDefinition>,
  ): Promise<BenchPlayerPlan> {
    const paths = this.paths(id);
    const active = await this.existingBound(paths.active);
    const definition = bundled.get(id);
    const roster = definition ? "sdlc" : "personal";
    if (active !== undefined && !isOwnedProfile(active, id, roster)) throw new Error(`unmanaged collision: ${id}`);
    if (action === "off") {
      if (roster === "personal" && active !== undefined && !isOwnedProfile(await this.existingBound(paths.registration), id, "personal")) {
        throw new Error(`personal registration missing: ${id}`);
      }
      return { changes: [{ path: paths.active }] };
    }
    const registration = definition ? undefined : await this.existingBound(paths.registration);
    if (!definition && (!registration || !isOwnedProfile(registration, id, "personal"))) throw new Error(`unknown player: ${id}`);
    try {
      if (definition) {
        return { changes: [{ path: paths.active, content: this.spec.renderPlayer(definition, "sdlc") }] };
      }
      const personal = validatePlayer(decodePlayer(registration!, id));
      if (!isCompatiblePlayerRegistration(registration!, this.spec.name, personal)) {
        throw new Error("registration is not canonical");
      }
      return {
        changes: [
          { path: paths.registration, content: renderPlayerRegistration(this.spec.name, personal) },
          { path: paths.active, content: this.spec.renderPlayer(personal, "personal") },
        ],
      };
    } catch {
      throw new Error(`stale personal profile: ${id}; re-run join with replace:true`);
    }
  }

  /** Completes every collision/read/render preflight before returning transaction input. */
  private async planBenchMutation(
    command: Extract<BenchCommand, { kind: "mutate" }>,
    bundled: ReadonlyMap<string, PlayerDefinition>,
    signal?: AbortSignal,
  ): Promise<BenchPlayerPlan[]> {
    const plans: BenchPlayerPlan[] = [];
    for (const id of command.ids) {
      signal?.throwIfAborted();
      plans.push(await this.planBenchPlayer(id, command.action, bundled));
      signal?.throwIfAborted();
    }
    return plans;
  }

  /**
   * Lists roster state or deterministically turns bundled/personal players on and off.
   * Turning a personal player off removes only its owned active copy; its registration remains the
   * source of truth. Turning it on requires a recoverable current registration.
   */
  async benchResult(
    args: string,
    bundled: ReadonlyMap<string, PlayerDefinition>,
    signal?: AbortSignal,
  ): Promise<RosterBenchResult> {
    signal?.throwIfAborted();
    const command = parseBenchCommand(args, bundled);
    if (command.kind === "list") return { kind: "list", text: await this.listBench(command.filter, bundled) };
    return this.withMutationLock(async () => {
      const plans = await this.planBenchMutation(command, bundled, signal);
      signal?.throwIfAborted();
      const fileStatuses = await this.transaction(plans.flatMap(({ changes }) => changes));
      let statusIndex = 0;
      const rows = command.ids.map((id, index): RosterBenchMutationRow => {
        const statuses = fileStatuses.slice(statusIndex, statusIndex + plans[index]!.changes.length);
        statusIndex += plans[index]!.changes.length;
        return {
          id,
          action: command.action,
          status: statuses.includes("changed") ? "changed" : "already-current",
        };
      });
      const status: LifecycleMutationStatus = rows.some((row) => row.status === "changed")
        ? "changed"
        : "already-current";
      const textRows = rows.map(({ id, action, status: rowStatus }) => rowStatus === "changed"
        ? action === "on"
          ? `${id}: enabled in this project.`
          : `${id}: moved to the bench in this project.`
        : action === "on"
          ? `${id}: currently enabled in this project · this member was unchanged.`
          : `${id}: currently benched in this project · this member was unchanged.`);
      if (status === "already-current") textRows.push("No roster files changed.");
      return {
        kind: "mutation",
        status,
        rows,
        text: textRows.join("\n"),
      };
    }, signal);
  }

  /** Text-compatible lifecycle API. Native adapters should prefer `benchResult()`. */
  async bench(
    args: string,
    bundled: ReadonlyMap<string, PlayerDefinition>,
    signal?: AbortSignal,
  ): Promise<string> {
    return (await this.benchResult(args, bundled, signal)).text;
  }

  /**
   * Removes an owned personal registration and this project's owned active copy transactionally.
   * Active copies in other projects are intentionally outside the transaction and remain untouched.
   */
  async retireResult(id: string, signal?: AbortSignal): Promise<RosterRetireResult> {
    signal?.throwIfAborted();
    // Names newly reserved by a host must remain removable when an older
    // Agent Harbor version already created a verified personal profile.
    if (!isHarborId(id)) throw new Error("invalid personal player");
    return this.withMutationLock(async () => {
      const paths = this.paths(id);
      const registration = await this.existingBound(paths.registration);
      signal?.throwIfAborted();
      const active = await this.existingBound(paths.active);
      signal?.throwIfAborted();
      if (registration === undefined && active === undefined) {
        return {
          kind: "retire",
          player: id,
          status: "already-current",
          text: `${id} is already retired here; other projects intentionally untouched\nNo roster files changed.`,
        };
      }
      if (!isOwnedProfile(registration, id, "personal")) throw new Error("owned registration not found");
      if (active !== undefined && !isOwnedProfile(active, id, "personal")) throw new Error("unmanaged collision");
      signal?.throwIfAborted();
      await this.transaction([{ path: paths.registration }, { path: paths.active }]);
      return {
        kind: "retire",
        player: id,
        status: "changed",
        text: `retired ${id}; other projects intentionally untouched`,
      };
    }, signal);
  }

  /** Text-compatible lifecycle API. Native adapters should prefer `retireResult()`. */
  async retire(id: string, signal?: AbortSignal): Promise<string> {
    return (await this.retireResult(id, signal)).text;
  }
}
