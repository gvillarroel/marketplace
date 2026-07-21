/**
 * Persistent roster lifecycle with ownership-aware collision handling and transactional updates.
 * Registration lives under the user's harness home while active profiles live in one project;
 * mutations coordinate both locations without overwriting or deleting unmanaged files.
 */
import { spawn } from "node:child_process";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { basename, delimiter, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { bundledPlayers, trustedSkills } from "./defaults.js";
import { isHarborId } from "./identity.js";
import { decodePlayer, isCanonicalPlayerProfile } from "./profiles.js";
import { validateConfiguredSkillReferences } from "./skills.js";
const piBuiltInCommands = [
    "settings", "model", "scoped-models", "export", "import", "share", "copy", "name", "session", "changelog",
    "hotkeys", "fork", "clone", "tree", "trust", "login", "logout", "new", "compact", "resume", "reload", "quit",
];
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
const maximumTransactionFileBytes = 30_000;
const lifecycleWorkerRpcTimeoutMs = 5_000;
const lifecycleWorkerExitTimeoutMs = 2_000;
const lifecycleRuntimeProbeTimeoutMs = 2_000;
const lifecycleRuntimeResolutionTimeoutMs = 4_500;
const maximumLifecycleRuntimeCandidates = 64;
const lifecycleRuntimeProbeMarker = "agent-harbor-node-runtime-v1";
const minimumLifecycleNodeVersion = "22.19.0";
/** Parses bench syntax without touching roster state or the filesystem. */
function parseBenchCommand(args, bundled) {
    const value = args.trim();
    if (!value || value === "list" || value.startsWith("list ")) {
        return { kind: "list", filter: value.startsWith("list ") ? value.slice(5).trim().toLowerCase() : "" };
    }
    const match = /^(on|off)\s+(.+)$/.exec(value);
    if (!match)
        throw new Error("usage: bench [list|on|off]");
    const requested = match[2].split(/[\s,]+/).filter(Boolean);
    const ids = requested.length === 1 && requested[0] === "all" ? [...bundled.keys()] : [...new Set(requested)];
    if (!ids.length || ids.some((id) => !isHarborId(id)))
        throw new Error("invalid player list");
    return { kind: "mutate", action: match[1], ids };
}
function contained(parent, child) {
    const root = resolve(parent);
    const target = resolve(child);
    const rel = relative(root, target);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel))
        throw new Error(`unsafe path: ${target}`);
    return target;
}
async function existingBytes(path) {
    try {
        return await readFile(path);
    }
    catch (error) {
        if (error?.code === "ENOENT")
            return undefined;
        throw error;
    }
}
async function existing(path) {
    return (await existingBytes(path))?.toString("utf8");
}
function sameSnapshot(left, right) {
    if (left.content === undefined || right.content === undefined) {
        return left.content === undefined && right.content === undefined;
    }
    return left.identity !== undefined && right.identity !== undefined
        && left.identity.dev === right.identity.dev && left.identity.ino === right.identity.ino
        && left.content.equals(right.content);
}
function snapshotFromWire(value) {
    if (!value || typeof value.exists !== "boolean")
        throw new Error("lifecycle worker returned an invalid snapshot");
    if (!value.exists)
        return {};
    if (typeof value.content !== "string" || !Number.isFinite(value.mtimeMs)) {
        throw new Error("lifecycle worker returned an invalid snapshot");
    }
    const content = Buffer.from(value.content, "base64");
    if (content.length > maximumTransactionFileBytes || content.toString("base64") !== value.content) {
        throw new Error("lifecycle worker returned invalid snapshot content");
    }
    return { content, identity: identityFromWire(value.identity), mtimeMs: value.mtimeMs };
}
function identityOf(stat) {
    if (stat.dev === 0n || stat.ino === 0n)
        throw new Error("filesystem returned an unusable zero identity");
    return { dev: stat.dev.toString(), ino: stat.ino.toString() };
}
function identityFromWire(value) {
    const candidate = value;
    if (!candidate || typeof candidate.dev !== "string" || typeof candidate.ino !== "string"
        || !/^[1-9][0-9]*$/u.test(candidate.dev) || !/^[1-9][0-9]*$/u.test(candidate.ino)) {
        throw new Error("lifecycle worker returned an invalid filesystem identity");
    }
    return { dev: candidate.dev, ino: candidate.ino };
}
function sameIdentity(left, right) {
    return left.dev === right.dev && left.ino === right.ino;
}
function isSupportedLifecycleNodeVersion(value) {
    if (typeof value !== "string")
        return false;
    const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/u.exec(value);
    if (!match)
        return false;
    const [major, minor, patch] = match.slice(1).map(Number);
    return major > 22 || (major === 22 && (minor > 19 || (minor === 19 && patch >= 0)));
}
function isNodeExecutableName(path) {
    const name = basename(path).toLowerCase();
    return name === "node" || name === "node.exe" || name === "nodejs";
}
function isWithinAnyRoot(path, roots) {
    const target = resolve(path);
    return roots.some((root) => {
        const absoluteRoot = resolve(root);
        // A filesystem root is not a meaningful untrusted project boundary.
        if (dirname(absoluteRoot) === absoluteRoot)
            return false;
        const rel = relative(absoluteRoot, target);
        return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
    });
}
function sanitizedLifecycleWorkerEnvironment(source) {
    const environment = { ...source };
    for (const key of Object.keys(environment)) {
        const normalized = key.toUpperCase();
        if (normalized === "NODE_OPTIONS" || normalized === "NODE_PATH")
            delete environment[key];
    }
    return environment;
}
function lifecycleNodeCandidates(hostExecutable, environment, forbiddenRoots, platform = process.platform) {
    const candidates = [];
    const seen = new Set();
    const executableNames = platform === "win32" ? ["node.exe"] : ["node", "nodejs"];
    const addExecutable = (value) => {
        if (typeof value !== "string" || value.length === 0 || value.length > 32_768 || value.includes("\0"))
            return;
        if (!isAbsolute(value) || !isNodeExecutableName(value) || isWithinAnyRoot(value, forbiddenRoots))
            return;
        const key = platform === "win32" ? value.toLowerCase() : value;
        if (!seen.has(key)) {
            seen.add(key);
            candidates.push(value);
        }
    };
    const addDirectory = (value, suffix = "") => {
        if (typeof value !== "string" || value.length === 0 || value.length > 32_768 || value.includes("\0"))
            return;
        if (!isAbsolute(value))
            return;
        const directory = suffix ? join(value, suffix) : value;
        for (const name of executableNames)
            addExecutable(join(directory, name));
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
    }
    else {
        for (const candidate of [
            "/usr/bin/node", "/usr/bin/nodejs", "/usr/local/bin/node", "/usr/local/bin/nodejs",
            "/opt/homebrew/bin/node", "/opt/local/bin/node", "/snap/bin/node",
        ])
            addExecutable(candidate);
    }
    // Never ask the OS to search PATH. Empty entries mean cwd and relative
    // entries are cwd-relative, so both are intentionally ignored. Absolute
    // entries are still rejected later when they fall inside a protected root.
    // Fixed install roots stay ahead so an oversized PATH cannot starve them.
    const pathValue = environment.PATH ?? environment.Path;
    if (typeof pathValue === "string" && pathValue.length <= 1_000_000) {
        for (const entry of pathValue.split(delimiter).slice(0, maximumLifecycleRuntimeCandidates)) {
            const directory = entry.trim();
            if (!directory || !isAbsolute(directory))
                continue;
            addDirectory(directory);
        }
    }
    return candidates.slice(0, maximumLifecycleRuntimeCandidates);
}
async function terminateRuntimeProbe(child) {
    if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined)
        return;
    child.kill();
    const exited = await Promise.race([
        new Promise((resolveExit) => child.once("close", () => resolveExit(true))),
        delay(250).then(() => false),
    ]);
    if (exited || child.exitCode !== null || child.signalCode !== null)
        return;
    child.kill("SIGKILL");
    await Promise.race([
        new Promise((resolveExit) => child.once("close", () => resolveExit())),
        delay(250).then(() => undefined),
    ]);
}
async function canonicalLifecycleNodeExecutable(candidate, forbiddenRoots, timeoutMs) {
    let timeout;
    const resolved = (async () => {
        try {
            const executable = await realpath(candidate);
            const stat = await lstat(executable);
            if (!stat.isFile() || isWithinAnyRoot(executable, forbiddenRoots))
                return undefined;
            return executable;
        }
        catch {
            return undefined;
        }
    })();
    const result = await Promise.race([
        resolved,
        new Promise((resolveTimeout) => {
            timeout = setTimeout(() => resolveTimeout(undefined), Math.max(1, timeoutMs));
        }),
    ]);
    if (timeout)
        clearTimeout(timeout);
    return result;
}
async function probeLifecycleNodeRuntime(candidate, environment, forbiddenRoots, timeoutMs) {
    if (!isAbsolute(candidate) || !isNodeExecutableName(candidate) || isWithinAnyRoot(candidate, forbiddenRoots)) {
        return undefined;
    }
    const deadline = Date.now() + Math.max(1, timeoutMs);
    const canonicalCandidate = await canonicalLifecycleNodeExecutable(candidate, forbiddenRoots, deadline - Date.now());
    if (!canonicalCandidate || Date.now() >= deadline)
        return undefined;
    const probeSource = `process.stdout.write(JSON.stringify({marker:${JSON.stringify(lifecycleRuntimeProbeMarker)},version:process.versions.node,execPath:process.execPath}))`;
    const child = spawn(canonicalCandidate, ["--input-type=module", "--eval", probeSource], {
        env: environment,
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
    });
    let output = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
        output += chunk;
        if (output.length > 2_048)
            child.kill();
    });
    const completion = new Promise((resolveProbe) => {
        let settled = false;
        const finish = (ok) => {
            if (settled)
                return;
            settled = true;
            resolveProbe(ok);
        };
        child.once("error", () => finish(false));
        child.once("close", (code, signal) => finish(code === 0 && signal === null));
    });
    let timeout;
    const exited = await Promise.race([
        completion,
        new Promise((resolveTimeout) => {
            timeout = setTimeout(() => resolveTimeout(undefined), Math.max(1, deadline - Date.now()));
        }),
    ]);
    if (timeout)
        clearTimeout(timeout);
    if (exited !== true) {
        await terminateRuntimeProbe(child);
        return undefined;
    }
    if (output.length > 2_048)
        return undefined;
    let result;
    try {
        result = JSON.parse(output);
    }
    catch {
        return undefined;
    }
    if (result.marker !== lifecycleRuntimeProbeMarker || !isSupportedLifecycleNodeVersion(result.version)
        || typeof result.execPath !== "string" || !isAbsolute(result.execPath) || !isNodeExecutableName(result.execPath)) {
        return undefined;
    }
    if (Date.now() >= deadline)
        return undefined;
    return canonicalLifecycleNodeExecutable(result.execPath, forbiddenRoots, deadline - Date.now());
}
async function resolveLifecycleNodeRuntime(hostExecutable, sourceEnvironment, forbiddenRoots) {
    const environment = sanitizedLifecycleWorkerEnvironment(sourceEnvironment);
    const deadline = Date.now() + lifecycleRuntimeResolutionTimeoutMs;
    for (const candidate of lifecycleNodeCandidates(hostExecutable, sourceEnvironment, forbiddenRoots)) {
        const remaining = deadline - Date.now();
        if (remaining <= 0)
            break;
        const executable = await probeLifecycleNodeRuntime(candidate, environment, forbiddenRoots, Math.min(lifecycleRuntimeProbeTimeoutMs, remaining));
        if (executable)
            return { executable, environment };
    }
    throw new Error(`Agent Harbor lifecycle requires an absolute Node.js ${minimumLifecycleNodeVersion} or newer runtime; ` +
        "the current host is not compatible and no safe runtime was found outside the project");
}
/**
 * Inline ESM worker. Its cwd is the directory capability: after bootstrap it
 * accepts only single path segments and journal-relative operations.
 */
const lifecycleDirectoryWorkerSource = String.raw `
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
    return { before: current, after: current };
  }
  if (!current.exists && !desired) {
    const step = { stepId, name, before: current, after: current, noop: true };
    steps.set(stepId, step);
    return { before: current, after: current };
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
    return { before: current, after };
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
    child;
    canonicalPath;
    identityValue;
    sequence = 0;
    closed = false;
    processClosed = false;
    termination;
    pending = new Map();
    constructor(child, canonicalPath, identityValue) {
        this.child = child;
        this.canonicalPath = canonicalPath;
        this.identityValue = identityValue;
        child.on("message", (message) => this.onMessage(message));
        child.on("error", (error) => this.fail(error));
        child.on("exit", (code, signal) => {
            if (!this.closed)
                this.fail(new Error(`lifecycle worker exited unexpectedly (${code ?? signal ?? "unknown"})`));
        });
        child.on("close", () => { this.processClosed = true; });
    }
    get identity() { return this.identityValue; }
    get pid() {
        const pid = this.child.pid;
        if (!Number.isSafeInteger(pid) || (pid ?? 0) <= 0)
            throw new Error("lifecycle worker has no usable process id");
        return pid;
    }
    static async bind(canonicalPath, runtime) {
        let existingPath = resolve(canonicalPath);
        const segments = [];
        let stat;
        while (true) {
            try {
                stat = await lstat(existingPath, { bigint: true });
                break;
            }
            catch (error) {
                if (error?.code !== "ENOENT")
                    throw error;
                const parent = dirname(existingPath);
                if (parent === existingPath)
                    throw new Error(`no existing directory anchors ${canonicalPath}`);
                segments.unshift(basename(existingPath));
                existingPath = parent;
            }
        }
        if (stat.isSymbolicLink())
            throw new Error(`symlink traversal refused: ${existingPath}`);
        if (!stat.isDirectory())
            throw new Error(`unsafe lifecycle directory: ${existingPath}`);
        await rejectSymlinkTraversal(parse(existingPath).root, join(existingPath, ".harbor-bind-probe"));
        const expected = identityOf(stat);
        const child = spawn(runtime.executable, ["--input-type=module", "--eval", lifecycleDirectoryWorkerSource], {
            cwd: existingPath,
            env: runtime.environment,
            stdio: ["ignore", "ignore", "ignore", "ipc"],
            windowsHide: true,
        });
        await new Promise((resolveSpawn, rejectSpawn) => {
            child.once("spawn", resolveSpawn);
            child.once("error", rejectSpawn);
        });
        const provisional = new LifecycleDirectoryWorker(child, resolve(canonicalPath), expected);
        try {
            const result = await provisional.request("bootstrap", { expected, segments });
            provisional.identityValue = identityFromWire(result?.parentIdentity);
            await provisional.assertCanonical();
            return provisional;
        }
        catch (error) {
            await provisional.terminate();
            throw error;
        }
    }
    onMessage(message) {
        const pending = this.pending.get(message.requestId);
        if (!pending)
            return;
        this.pending.delete(message.requestId);
        clearTimeout(pending.timer);
        if (message.ok)
            pending.resolve(message.value);
        else {
            const error = new Error(message.error?.message ?? "lifecycle worker failed");
            if (message.error?.code)
                error.code = message.error.code;
            pending.reject(error);
        }
    }
    fail(error) {
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(error);
        }
        this.pending.clear();
    }
    request(op, payload = {}) {
        if (this.closed || !this.child.connected)
            return Promise.reject(new Error("lifecycle worker is closed"));
        const requestId = ++this.sequence;
        return new Promise((resolveRequest, rejectRequest) => {
            const timer = setTimeout(() => {
                this.pending.delete(requestId);
                rejectRequest(new Error(`lifecycle worker ${op} timed out`));
                void this.terminate();
            }, lifecycleWorkerRpcTimeoutMs);
            this.pending.set(requestId, { resolve: resolveRequest, reject: rejectRequest, timer });
            this.child.send({ requestId, op, ...payload }, (error) => {
                if (!error)
                    return;
                const pending = this.pending.get(requestId);
                if (!pending)
                    return;
                this.pending.delete(requestId);
                clearTimeout(pending.timer);
                pending.reject(error);
            });
        });
    }
    async assertCanonical() {
        const stat = await lstat(this.canonicalPath, { bigint: true });
        if (stat.isSymbolicLink() || !stat.isDirectory() || !sameIdentity(identityOf(stat), this.identity)) {
            throw new Error(`lifecycle directory identity changed: ${this.canonicalPath}`);
        }
    }
    async snapshot(name) {
        return snapshotFromWire(await this.request("snapshot", { name }));
    }
    async list() {
        const entries = await this.request("list");
        if (!Array.isArray(entries) || entries.some((entry) => typeof entry !== "string") || entries.length > 4_096) {
            throw new Error("lifecycle worker returned an invalid directory listing");
        }
        return entries;
    }
    async stage(name, stepId, expected, content) {
        const result = await this.request("stage", {
            name,
            stepId,
            expected: this.toWire(expected),
            content: content === undefined ? null : content.toString("base64"),
        });
        return snapshotFromWire(result.after);
    }
    async verify(stepId) { await this.request("verify", { stepId }); }
    async rollback(stepId) { await this.request("rollback", { stepId }); }
    async finalize(stepId) { await this.request("finalize", { stepId }); }
    async acquireLock(name, content) {
        return snapshotFromWire(await this.request("lock.acquire", { name, content: content.toString("base64") }));
    }
    async releaseLock(name) { await this.request("lock.release", { name }); }
    async removeExact(name, expected) {
        await this.request("remove.exact", { name, expected: this.toWire(expected) });
    }
    toWire(snapshot) {
        return snapshot.content === undefined
            ? { exists: false }
            : { exists: true, content: snapshot.content.toString("base64"), identity: snapshot.identity, mtimeMs: snapshot.mtimeMs };
    }
    async close() {
        if (this.closed)
            return;
        try {
            await this.request("close");
        }
        finally {
            await this.terminate();
        }
    }
    terminate() {
        this.termination ??= this.terminateOnce();
        return this.termination;
    }
    async waitForProcessClose() {
        if (this.processClosed)
            return true;
        return Promise.race([
            new Promise((resolveClose) => this.child.once("close", () => resolveClose(true))),
            delay(lifecycleWorkerExitTimeoutMs).then(() => false),
        ]);
    }
    async terminateOnce() {
        this.closed = true;
        this.fail(new Error("lifecycle worker closed"));
        if (this.processClosed)
            return;
        // Do not call child.disconnect() before termination. With a dedicated IPC
        // stdio slot Node may then omit ChildProcess's `close` event on Windows,
        // which is the only public signal that every inherited handle is released.
        if (this.child.exitCode === null && this.child.signalCode === null)
            this.child.kill();
        if (await this.waitForProcessClose())
            return;
        if (this.child.exitCode === null && this.child.signalCode === null)
            this.child.kill("SIGKILL");
        if (!await this.waitForProcessClose()) {
            throw new Error("lifecycle worker did not close after termination");
        }
    }
}
async function rejectSymlinkTraversal(root, target) {
    const parent = resolve(root);
    const rel = relative(parent, resolve(target));
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel))
        throw new Error(`unsafe path: ${target}`);
    let cursor = parent;
    for (const segment of ["", ...rel.split(/[\\/]+/)]) {
        if (segment)
            cursor = join(cursor, segment);
        try {
            if ((await lstat(cursor)).isSymbolicLink())
                throw new Error(`symlink traversal refused: ${cursor}`);
        }
        catch (error) {
            if (error?.code === "ENOENT")
                return;
            throw error;
        }
    }
}
// Ownership is intentionally narrower than validity: this recognizes only the
// current structural marker or its exact revision-4 predecessor. Revision 4 is
// retained solely so upgrades can repair/remove files Agent Harbor owns; only
// the revision-5 canonical renderer is invocable.
export function isOwnedProfile(content, id, expectedRoster) {
    if (!content?.startsWith("---\n"))
        return false;
    const end = content.indexOf("\n---\n", 4);
    if (end < 0)
        return false;
    const marker = /^<!-- agent-foundry:profile id=([a-z0-9-]+) revision=(4|5) -->\n/.exec(content.slice(end + 5));
    if (!marker || marker[1] !== id)
        return false;
    const revision = marker[2];
    const lines = content.slice(4, end).split("\n");
    if (lines.filter((line) => line === `name: ${JSON.stringify(id)}`).length !== 1)
        return false;
    const roster = expectedRoster ?? (lines.includes("  roster: personal") ? "personal" : lines.includes("  roster: sdlc") ? "sdlc" : undefined);
    if (!roster)
        return false;
    const metadata = [
        "metadata:",
        "  owner: agent-foundry",
        `  roster: ${roster}`,
        `  player: ${JSON.stringify(id)}`,
        `  revision: ${JSON.stringify(revision)}`,
    ];
    if (lines.slice(-metadata.length).join("\n") !== metadata.join("\n"))
        return false;
    return metadata.every((expected) => lines.filter((line) => line === expected).length === 1) &&
        lines.filter((line) => line === "  roster: personal" || line === "  roster: sdlc").length === 1;
}
/**
 * Strictly validates an external player definition and returns its typed form.
 * Unknown keys, duplicate capabilities, reserved names, untrusted GitHub skills, and skill-bearing
 * definitions without read access are rejected before any filesystem mutation occurs.
 */
export function validatePlayer(value, allowReserved = false) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("expected one JSON object");
    const input = value;
    const keys = new Set(["name", "description", "prompt", "tools", "model", "replace", "skills"]);
    for (const key of Object.keys(input))
        if (!keys.has(key))
            throw new Error(`unknown key: ${key}`);
    if (!isHarborId(input.name) || (!allowReserved && reserved.has(input.name)))
        throw new Error("invalid or reserved name");
    if (typeof input.description !== "string" || !input.description.trim() || input.description.length > 500 || publicMetadataControl.test(input.description))
        throw new Error("invalid description");
    if (typeof input.prompt !== "string" || !input.prompt.trim() || input.prompt.length > 18_000)
        throw new Error("invalid prompt");
    if (!Array.isArray(input.tools) || (!allowReserved && input.tools.length === 0) || input.tools.some((tool) => typeof tool !== "string" || !allowedTools.has(tool)))
        throw new Error("invalid tools");
    if (new Set(input.tools).size !== input.tools.length)
        throw new Error("duplicate tools");
    if (input.model !== undefined && (typeof input.model !== "string" || !input.model.trim() || input.model.length > 200 || publicMetadataControl.test(input.model)))
        throw new Error("invalid model");
    if (input.replace !== undefined && typeof input.replace !== "boolean")
        throw new Error("invalid replace");
    if (input.skills !== undefined)
        validateConfiguredSkillReferences(input.skills, input.tools, trustedSkills);
    return {
        ...input,
        description: input.description.trim(),
        prompt: input.prompt.trim(),
        ...(typeof input.model === "string" ? { model: input.model.trim() } : {}),
    };
}
/**
 * Owns deterministic join, bench, and retire operations for one harness/project pair.
 * Every mutation is serialized by the home-scoped roster lock and committed across registration
 * and active paths as a verified transaction with best-effort full rollback.
 */
export class Roster {
    spec;
    activeTransaction;
    boundDirectories;
    bindingDirectories;
    lifecycleRuntime;
    /** Binds lifecycle operations to one harness's home, project, layout, and renderer. */
    constructor(spec) {
        this.spec = spec;
    }
    /** Testable host boundary: packaged CLIs may not expose Node through process.execPath. */
    lifecycleHostExecutable() { return process.execPath; }
    /** Testable environment boundary; executable selection never asks a shell to resolve it. */
    lifecycleHostEnvironment() { return process.env; }
    nodeRuntime() {
        this.lifecycleRuntime ??= resolveLifecycleNodeRuntime(this.lifecycleHostExecutable(), this.lifecycleHostEnvironment(), [this.spec.home, this.spec.project, process.cwd()]);
        return this.lifecycleRuntime;
    }
    rootFor(path) {
        for (const root of [this.spec.home, this.spec.project]) {
            const rel = relative(resolve(root), resolve(path));
            if (rel && !rel.startsWith("..") && !isAbsolute(rel))
                return root;
        }
        throw new Error(`unsafe transaction path: ${path}`);
    }
    directoryKey(path) {
        const value = resolve(path);
        return process.platform === "win32" ? value.toLowerCase() : value;
    }
    async bindDirectory(path) {
        const directories = this.boundDirectories;
        const bindings = this.bindingDirectories;
        if (!directories || !bindings)
            throw new Error("lifecycle directory binding is unavailable outside a mutation");
        const canonical = resolve(path);
        const key = this.directoryKey(canonical);
        const existing = directories.get(key);
        if (existing) {
            await existing.worker.assertCanonical();
            return existing;
        }
        const pending = bindings.get(key);
        if (pending)
            return pending;
        const binding = this.nodeRuntime().then((runtime) => LifecycleDirectoryWorker.bind(canonical, runtime)).then((worker) => {
            const directory = { path: canonical, identity: worker.identity, worker };
            directories.set(key, directory);
            return directory;
        });
        bindings.set(key, binding);
        try {
            return await binding;
        }
        finally {
            if (bindings.get(key) === binding)
                bindings.delete(key);
        }
    }
    async bindTarget(path) {
        this.rootFor(path);
        const name = basename(path);
        if (!name || name === "." || name === ".." || /[\\/\0]/u.test(name))
            throw new Error(`unsafe transaction target: ${path}`);
        return { directory: await this.bindDirectory(dirname(path)), name };
    }
    async existingBound(path) {
        const target = await this.bindTarget(path);
        await target.directory.worker.assertCanonical();
        const snapshot = await target.directory.worker.snapshot(target.name);
        await target.directory.worker.assertCanonical();
        return snapshot.content?.toString("utf8");
    }
    async closeBoundDirectories() {
        const directories = this.boundDirectories;
        const bindings = this.bindingDirectories;
        this.boundDirectories = undefined;
        this.bindingDirectories = undefined;
        if (!directories)
            return [];
        const errors = [];
        if (bindings?.size) {
            const settled = await Promise.allSettled(bindings.values());
            for (const result of settled)
                if (result.status === "rejected")
                    errors.push(result.reason);
        }
        for (const directory of [...directories.values()].reverse()) {
            try {
                await directory.worker.close();
            }
            catch (error) {
                errors.push(error);
            }
        }
        return errors;
    }
    // The lock is shared through the harness home, so concurrent projects cannot race updates to the
    // same persistent registration. `wx` provides exclusive acquisition. A dead owner's lock is removed
    // only after its structured ownership record is re-read unchanged; foreign or malformed locks are
    // collisions, never cleanup candidates. Release likewise verifies the token before deleting the file.
    async withMutationLock(action) {
        const path = contained(this.spec.home, join(this.spec.home, this.spec.registrationDir, ".roster.lock"));
        if (this.boundDirectories)
            throw new Error("nested roster mutation is not allowed");
        this.boundDirectories = new Map();
        this.bindingDirectories = new Map();
        const token = randomUUID();
        const errors = [];
        let failure;
        let value;
        let lockDirectory;
        let ownsLock = false;
        try {
            lockDirectory = await this.bindDirectory(dirname(path));
            const record = JSON.stringify({ owner: "agent-harbor", pid: lockDirectory.worker.pid, token });
            for (let attempt = 0; attempt < 200 && !ownsLock; attempt += 1) {
                await lockDirectory.worker.assertCanonical();
                try {
                    await lockDirectory.worker.acquireLock(basename(path), Buffer.from(record, "utf8"));
                    ownsLock = true;
                }
                catch (error) {
                    if (error?.code !== "EEXIST")
                        throw error;
                    const current = await lockDirectory.worker.snapshot(basename(path));
                    if (current.content === undefined)
                        continue;
                    let owner;
                    try {
                        owner = JSON.parse(current.content.toString("utf8"));
                    }
                    catch {
                        if (Date.now() - (current.mtimeMs ?? 0) < 1_000) {
                            await delay(25);
                            continue;
                        }
                        throw new Error(`unmanaged roster lock collision: ${path}`);
                    }
                    if (owner.owner !== "agent-harbor" || typeof owner.pid !== "number" || !Number.isSafeInteger(owner.pid) || owner.pid <= 0
                        || typeof owner.token !== "string" || owner.token.length === 0 || owner.token.length > 200) {
                        throw new Error(`unmanaged roster lock collision: ${path}`);
                    }
                    let alive = true;
                    try {
                        process.kill(owner.pid, 0);
                    }
                    catch (signalError) {
                        if (signalError?.code === "ESRCH")
                            alive = false;
                        else
                            throw signalError;
                    }
                    if (!alive) {
                        await lockDirectory.worker.removeExact(basename(path), current);
                        continue;
                    }
                    await delay(25);
                }
            }
            if (!ownsLock)
                throw new Error("roster is busy; retry the operation");
            await this.bindDirectory(contained(this.spec.project, join(this.spec.project, this.spec.activeDir)));
            value = await action();
        }
        catch (error) {
            failure = error;
        }
        if (ownsLock && lockDirectory) {
            try {
                await lockDirectory.worker.releaseLock(basename(path));
            }
            catch (error) {
                errors.push(error);
            }
        }
        errors.push(...await this.closeBoundDirectories());
        if (failure !== undefined && errors.length) {
            const message = failure instanceof Error ? failure.message : "roster mutation failed";
            throw new AggregateError([failure, ...errors], `${message}; lifecycle cleanup was incomplete`);
        }
        if (failure !== undefined)
            throw failure;
        if (errors.length) {
            const first = errors[0] instanceof Error ? errors[0].message : "lifecycle cleanup failed";
            throw new AggregateError(errors, `${first}; roster mutation committed but lifecycle cleanup was incomplete`);
        }
        return value;
    }
    /** Stages one identity-bound transaction step; protected for deterministic failure/race injection. */
    async applyChange(change, _index) {
        const transaction = this.activeTransaction;
        const expected = transaction?.expected.get(change.path);
        const target = transaction?.targets.get(change.path);
        if (!transaction || expected === undefined || !target)
            throw new Error("transaction step has no bound snapshot");
        const desired = change.content === undefined ? undefined : Buffer.from(change.content, "utf8");
        if (desired && desired.length > maximumTransactionFileBytes) {
            throw new Error(`transaction content exceeds ${maximumTransactionFileBytes} bytes: ${change.path}`);
        }
        await target.directory.worker.assertCanonical();
        const stepId = `step-${_index}-${randomUUID()}`;
        const after = await target.directory.worker.stage(target.name, stepId, expected, desired);
        await target.directory.worker.assertCanonical();
        transaction.staged.push({
            path: change.path,
            directory: target.directory,
            stepId,
            before: expected,
            after,
        });
    }
    async verifyStagedChange(change) {
        await change.directory.worker.verify(change.stepId);
        await change.directory.worker.assertCanonical();
    }
    async finalizeStagedChange(change) {
        await change.directory.worker.finalize(change.stepId);
    }
    async rollbackStagedChange(change) {
        // Never consult the canonical path here. If an ancestor was renamed, the
        // worker cwd remains bound to the original directory and rollback stays there.
        await change.directory.worker.rollback(change.stepId);
    }
    // Snapshot both identity and exact bytes before writing, stage each change
    // with create-if-absent publication, then verify the complete transaction.
    // Rollback removes only the inode installed by this transaction. Concurrent
    // foreign replacements are preserved and reported as incomplete rollback.
    async transaction(changes) {
        if (this.activeTransaction)
            throw new Error("nested roster transaction is not allowed");
        const bound = await Promise.all(changes.map(async ({ path }) => {
            const target = await this.bindTarget(path);
            await target.directory.worker.assertCanonical();
            const snapshot = await target.directory.worker.snapshot(target.name);
            await target.directory.worker.assertCanonical();
            return { path, target, snapshot };
        }));
        const transaction = {
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
                for (const change of transaction.staged)
                    await this.verifyStagedChange(change);
            }
            catch (error) {
                const rollbackErrors = [];
                for (const item of [...transaction.staged].reverse()) {
                    try {
                        await this.rollbackStagedChange(item);
                    }
                    catch (restoreError) {
                        rollbackErrors.push(restoreError);
                    }
                }
                if (rollbackErrors.length)
                    throw new AggregateError([error, ...rollbackErrors], "mutation failed and rollback was incomplete");
                throw error;
            }
            // Verification is the commit boundary. Journal cleanup after it must
            // never route through rollback after an earlier entry has been erased.
            const cleanupErrors = [];
            for (const change of transaction.staged) {
                try {
                    await this.finalizeStagedChange(change);
                }
                catch (cleanupError) {
                    cleanupErrors.push(cleanupError);
                }
            }
            if (cleanupErrors.length) {
                throw new AggregateError(cleanupErrors, "mutation committed but transaction cleanup was incomplete");
            }
        }
        finally {
            if (this.activeTransaction === transaction)
                this.activeTransaction = undefined;
        }
    }
    paths(id) {
        const registration = contained(this.spec.home, join(this.spec.home, this.spec.registrationDir, `${id}${this.spec.extension}`));
        const active = contained(this.spec.project, join(this.spec.project, this.spec.activeDir, `${id}${this.spec.extension}`));
        return { registration, active };
    }
    /**
     * Validates and joins a personal player by writing identical registration and active profiles.
     * Unmanaged collisions are never replaced. A differing owned profile requires `replace: true`,
     * and both files either verify successfully or are restored to their prior exact bytes.
     */
    async join(input) {
        const player = validatePlayer(input);
        const content = this.spec.renderPlayer(player, "personal");
        if (Buffer.byteLength(content, "utf8") > 30_000)
            throw new Error("profile exceeds 30000 bytes");
        return this.withMutationLock(async () => {
            const paths = this.paths(player.name);
            const current = await Promise.all([this.existingBound(paths.registration), this.existingBound(paths.active)]);
            for (const collision of current)
                if (collision !== undefined && !isOwnedProfile(collision, player.name, "personal"))
                    throw new Error("unmanaged collision");
            if (current[0] === undefined && (await this.registrationEntries()).length >= 200) {
                throw new Error("personal roster limit reached (200); retire an existing personal member before joining another");
            }
            if (!player.replace && current.some((value) => value !== undefined &&
                !isCanonicalPlayerProfile(value, this.spec.name, player, "personal", this.spec.project))) {
                throw new Error("replace:true required");
            }
            await this.transaction([{ path: paths.registration, content }, { path: paths.active, content }]);
            return `joined ${player.name}\ncommand: /${player.name} <request>\nregistration: ${paths.registration}\nactive: ${paths.active}`;
        });
    }
    async bundledBenchInventory(bundled, filter) {
        const rows = [];
        for (const [id, definition] of bundled) {
            const { active } = this.paths(id);
            await rejectSymlinkTraversal(this.spec.project, active);
            const content = await existing(active);
            const state = content === undefined
                ? "bench"
                : !isOwnedProfile(content, id, "sdlc") ? "conflict"
                    : isCanonicalPlayerProfile(content, this.spec.name, definition, "sdlc", this.spec.project) ? "on" : "stale";
            if (!filter || id.includes(filter))
                rows.push({ id, roster: "bundled", state });
        }
        return rows;
    }
    async registrationEntries() {
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
        }
        catch (error) {
            if (error?.code === "ENOENT")
                return [];
            throw error;
        }
    }
    personalBenchState(active, activeOwned, definition, registrationCanonical) {
        if (active !== undefined && !activeOwned)
            return "conflict";
        if (!definition || !registrationCanonical)
            return "stale";
        if (active !== undefined && !isCanonicalPlayerProfile(active, this.spec.name, definition, "personal", this.spec.project))
            return "stale";
        return active === undefined ? "bench" : "on";
    }
    async personalBenchInventory(filter) {
        const rows = [];
        for (const filename of await this.registrationEntries()) {
            const id = filename.slice(0, -this.spec.extension.length);
            if (!isHarborId(id) || (filter && !id.includes(filter)))
                continue;
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
            let definition;
            try {
                definition = validatePlayer(decodePlayer(registration, id));
            }
            catch {
                definition = undefined;
            }
            const registrationCanonical = definition !== undefined &&
                isCanonicalPlayerProfile(registration, this.spec.name, definition, "personal", this.spec.project);
            rows.push({
                id,
                roster: "personal",
                state: this.personalBenchState(active, isOwnedProfile(active, id, "personal"), definition, registrationCanonical),
            });
        }
        return rows;
    }
    async listBench(filter, bundled) {
        const rows = [];
        rows.push(...await this.bundledBenchInventory(bundled, filter));
        rows.push(...await this.personalBenchInventory(filter));
        return rows.map(({ id, roster, state }) => `${id} | ${roster} | ${state}`).join("\n");
    }
    async planBenchPlayer(id, action, bundled) {
        const paths = this.paths(id);
        const active = await this.existingBound(paths.active);
        const definition = bundled.get(id);
        const roster = definition ? "sdlc" : "personal";
        if (active !== undefined && !isOwnedProfile(active, id, roster))
            throw new Error(`unmanaged collision: ${id}`);
        if (action === "off") {
            if (roster === "personal" && active !== undefined && !isOwnedProfile(await this.existingBound(paths.registration), id, "personal")) {
                throw new Error(`personal registration missing: ${id}`);
            }
            return { path: paths.active };
        }
        const registration = definition ? undefined : await this.existingBound(paths.registration);
        if (!definition && (!registration || !isOwnedProfile(registration, id, "personal")))
            throw new Error(`unknown player: ${id}`);
        try {
            return {
                path: paths.active,
                content: definition
                    ? this.spec.renderPlayer(definition, "sdlc")
                    : this.spec.renderPlayer(validatePlayer(decodePlayer(registration, id)), "personal"),
            };
        }
        catch {
            throw new Error(`stale personal profile: ${id}; re-run join with replace:true`);
        }
    }
    /** Completes every collision/read/render preflight before returning transaction input. */
    async planBenchMutation(command, bundled) {
        const changes = [];
        for (const id of command.ids)
            changes.push(await this.planBenchPlayer(id, command.action, bundled));
        return changes;
    }
    /**
     * Lists roster state or deterministically turns bundled/personal players on and off.
     * Turning a personal player off removes only its owned active copy; its registration remains the
     * source of truth. Turning it on requires a recoverable current registration.
     */
    async bench(args, bundled) {
        const command = parseBenchCommand(args, bundled);
        if (command.kind === "list")
            return this.listBench(command.filter, bundled);
        return this.withMutationLock(async () => {
            const changes = await this.planBenchMutation(command, bundled);
            await this.transaction(changes);
            return command.ids.map((id) => `${id}: turned ${command.action}`).join("\n");
        });
    }
    /**
     * Removes an owned personal registration and this project's owned active copy transactionally.
     * Active copies in other projects are intentionally outside the transaction and remain untouched.
     */
    async retire(id) {
        // Names newly reserved by a host must remain removable when an older
        // Agent Harbor version already created a verified personal profile.
        if (!isHarborId(id))
            throw new Error("invalid personal player");
        return this.withMutationLock(async () => {
            const paths = this.paths(id);
            const registration = await this.existingBound(paths.registration);
            const active = await this.existingBound(paths.active);
            if (registration === undefined && active === undefined) {
                return `retired ${id}; already absent; other projects intentionally untouched`;
            }
            if (!isOwnedProfile(registration, id, "personal"))
                throw new Error("owned registration not found");
            if (active !== undefined && !isOwnedProfile(active, id, "personal"))
                throw new Error("unmanaged collision");
            await this.transaction([{ path: paths.registration }, { path: paths.active }]);
            return `retired ${id}; other projects intentionally untouched`;
        });
    }
}
