/** Cross-isolate activity claims shared by OpenCode's server and TUI plugins. */
import { Buffer } from "node:buffer";
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  futimesSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import type { BigIntStats } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

export type OpenCodeAgentActivityKind = "direct" | "delegated";
export type OpenCodeAgentActivityPhase = "starting" | "working" | "cleaning";

export interface OpenCodeAgentActivitySnapshot {
  readonly agent: string;
  readonly kind: OpenCodeAgentActivityKind;
  readonly phase: OpenCodeAgentActivityPhase;
  readonly startedAt: number;
  /** Private native identity. Views must project this field away. */
  readonly sessionID: string;
  /** Claims from another OpenCode OS process are visible but never stoppable here. */
  readonly processID: number;
  /** Opaque ownership generation used only for compare-before-stop/release. */
  readonly claimToken: string;
}

export interface OpenCodeAgentActivityClaim {
  readonly snapshot: OpenCodeAgentActivitySnapshot;
  /** Publishes the disposable child identity before delegated work becomes visible as working. */
  setSessionID(sessionID: string): void;
  setPhase(phase: OpenCodeAgentActivityPhase): void;
  release(): void;
}

interface StoredClaim {
  readonly version: 1;
  readonly owner: "agent-harbor";
  readonly project: string;
  readonly agent: string;
  readonly kind: OpenCodeAgentActivityKind;
  readonly phase: "s" | "w" | "c";
  readonly slot: "a" | "b";
  readonly sessionA: string;
  readonly sessionB: string;
  readonly startedAt: number;
  readonly processID: number;
  readonly claimToken: string;
}

interface FileIdentity {
  readonly dev: string;
  readonly ino: string;
}

interface DirectoryNode extends FileIdentity {
  readonly path: string;
  readonly canonical: string;
  readonly privateMode: boolean;
}

interface ClaimPaths {
  readonly project: string;
  readonly directory: string;
  readonly binding: readonly DirectoryNode[];
}

interface ReadClaim {
  readonly snapshot: OpenCodeAgentActivitySnapshot;
  readonly fresh: boolean;
  readonly identity: FileIdentity;
}

const maximumOpenCodeAgentActivitiesPerProject = 32;
const maximumOpenCodeActivityDirectoryEntries = 64;
const maximumOpenCodeActivityClaimBytes = 2_048;
const maximumOpenCodeActivityIdentityBytes = 512;
const encodedSessionSlotBytes = 683;
const openCodeActivityHeartbeatMs = 2_000;
const openCodeActivityTtlMs = 30_000;
const activityOwnerDirectory = "agent-foundry";
const activityDirectory = "opencode-activity-v1";
const activityIDPattern = /^[a-z0-9][a-z0-9-]{0,47}$/u;
const tokenPattern = /^[A-Za-z0-9_-]{24}$/u;
const temporaryClaimPattern = /^\.agent-harbor-activity-tmp-[A-Za-z0-9_-]{24}$/u;
const phaseCodes: Record<OpenCodeAgentActivityPhase, StoredClaim["phase"]> = {
  starting: "s",
  working: "w",
  cleaning: "c",
};
const phases: Record<StoredClaim["phase"], OpenCodeAgentActivityPhase> = {
  s: "starting",
  w: "working",
  c: "cleaning",
};

function projectKey(project: string): string {
  const absolute = resolve(project);
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

function defaultOpenCodeHome(): string {
  return resolve(process.env.OPENCODE_CONFIG_DIR || join(homedir(), ".config", "opencode"));
}

function projectDigest(project: string): string {
  return createHash("sha256").update(projectKey(project), "utf8").digest("hex").slice(0, 40);
}

function contained(parent: string, child: string): string {
  const root = resolve(parent);
  const target = resolve(child);
  const rel = relative(root, target);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("unsafe OpenCode activity location");
  return target;
}

function identity(stat: { readonly dev: bigint; readonly ino: bigint }): FileIdentity {
  return { dev: stat.dev.toString(10), ino: stat.ino.toString(10) };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function inspectDirectory(directory: string, privateMode: boolean): DirectoryNode {
  const stat = lstatSync(directory, { bigint: true });
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("unsafe OpenCode activity directory");
  if (privateMode && process.platform !== "win32" && (stat.mode & 0o077n) !== 0n) {
    throw new Error("OpenCode activity directory permissions are too broad");
  }
  return {
    path: resolve(directory),
    canonical: resolve(realpathSync.native(directory)),
    privateMode,
    ...identity(stat),
  };
}

function ensureDirectory(directory: string, create: boolean, privateMode: boolean, recursive = false): DirectoryNode | undefined {
  try { return inspectDirectory(directory, privateMode); }
  catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
    if (!create) return undefined;
    try { mkdirSync(directory, { recursive, mode: 0o700 }); }
    catch (mkdirError: any) { if (mkdirError?.code !== "EEXIST") throw mkdirError; }
    return inspectDirectory(directory, privateMode);
  }
}

function assertDirectoryBinding(paths: ClaimPaths): void {
  let parent: DirectoryNode | undefined;
  for (const expected of paths.binding) {
    const current = inspectDirectory(expected.path, expected.privateMode);
    if (!sameIdentity(current, expected) || current.canonical !== expected.canonical) {
      throw new Error("OpenCode activity directory identity changed");
    }
    if (parent) {
      const rel = relative(parent.canonical, current.canonical);
      if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
        throw new Error("OpenCode activity directory escaped its canonical parent");
      }
    }
    parent = current;
  }
}

function claimPaths(project: string, create: boolean): ClaimPaths | undefined {
  const home = defaultOpenCodeHome();
  const homeNode = ensureDirectory(home, create, false, true);
  if (!homeNode) return undefined;
  const owner = contained(home, join(home, activityOwnerDirectory));
  const ownerNode = ensureDirectory(owner, create, true);
  if (!ownerNode) return undefined;
  const activity = contained(owner, join(owner, activityDirectory));
  const activityNode = ensureDirectory(activity, create, true);
  if (!activityNode) return undefined;
  const digest = projectDigest(project);
  const directory = contained(activity, join(activity, digest));
  const projectNode = ensureDirectory(directory, create, true);
  if (!projectNode) return undefined;
  const paths = { project: digest, directory, binding: [homeNode, ownerNode, activityNode, projectNode] };
  assertDirectoryBinding(paths);
  return paths;
}

function claimPath(directory: string, agent: string): string {
  if (!activityIDPattern.test(agent)) throw new Error("invalid OpenCode activity agent");
  return contained(directory, join(directory, `${agent}.json`));
}

function temporaryClaimPath(directory: string, token: string): string {
  if (!tokenPattern.test(token)) throw new Error("invalid OpenCode activity publication token");
  return contained(directory, join(directory, `.agent-harbor-activity-tmp-${token}`));
}

function validIdentity(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximumOpenCodeActivityIdentityBytes &&
    Buffer.byteLength(value, "utf8") <= maximumOpenCodeActivityIdentityBytes &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}

function sessionSlot(value: string): string {
  if (!validIdentity(value)) throw new Error("invalid OpenCode activity session identity");
  const encoded = Buffer.from(value, "utf8").toString("base64url");
  if (encoded.length > encodedSessionSlotBytes) throw new Error("OpenCode activity session identity exceeds its encoded bound");
  return encoded.padEnd(encodedSessionSlotBytes, " ");
}

function decodeSessionSlot(value: unknown): string {
  if (typeof value !== "string" || value.length !== encodedSessionSlotBytes) {
    throw new Error("invalid OpenCode activity session slot");
  }
  const encoded = value.trimEnd();
  if (!encoded || !/^[A-Za-z0-9_-]+$/u.test(encoded)) throw new Error("invalid OpenCode activity session slot");
  const decoded = Buffer.from(encoded, "base64url").toString("utf8");
  if (!validIdentity(decoded) || Buffer.from(decoded, "utf8").toString("base64url") !== encoded) {
    throw new Error("invalid OpenCode activity session slot");
  }
  return decoded;
}

function parseClaim(value: unknown, expectedProject: string, expectedAgent: string): {
  readonly claim: StoredClaim;
  readonly sessionID: string;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid OpenCode activity claim");
  const claim = value as Partial<StoredClaim>;
  if (claim.version !== 1 || claim.owner !== "agent-harbor" || claim.project !== expectedProject ||
      claim.agent !== expectedAgent || !activityIDPattern.test(claim.agent ?? "") ||
      !["direct", "delegated"].includes(claim.kind ?? "") || !["s", "w", "c"].includes(claim.phase ?? "") ||
      !["a", "b"].includes(claim.slot ?? "") ||
      !Number.isSafeInteger(claim.startedAt) || (claim.startedAt ?? -1) < 0 ||
      !Number.isSafeInteger(claim.processID) || (claim.processID ?? 0) <= 0 ||
      typeof claim.claimToken !== "string" || !tokenPattern.test(claim.claimToken)) {
    throw new Error("invalid OpenCode activity claim");
  }
  const stored = claim as StoredClaim;
  const sessionID = decodeSessionSlot(stored.slot === "a" ? stored.sessionA : stored.sessionB);
  // Validate the inactive slot too: a malformed half-published update must fail closed.
  decodeSessionSlot(stored.slot === "a" ? stored.sessionB : stored.sessionA);
  return { claim: stored, sessionID };
}

function safeClaimStat(file: string): BigIntStats {
  const stat = lstatSync(file, { bigint: true });
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size <= 0n || stat.size > BigInt(maximumOpenCodeActivityClaimBytes) ||
      process.platform !== "win32" && (stat.mode & 0o077n) !== 0n) {
    throw new Error("unsafe OpenCode activity claim");
  }
  return stat;
}

function readClaim(paths: ClaimPaths, file: string, agent: string, now = Date.now()): ReadClaim | undefined {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    assertDirectoryBinding(paths);
    let before;
    try { before = safeClaimStat(file); }
    catch (error: any) { if (error?.code === "ENOENT") return undefined; throw error; }
    let descriptor: number | undefined;
    try {
      descriptor = openSync(file, constants.O_RDONLY | (process.platform === "win32"
        ? 0
        : (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)));
      const opened = fstatSync(descriptor, { bigint: true });
      if (!opened.isFile() || opened.size !== before.size || !sameIdentity(identity(opened), identity(before))) continue;
      const bytes = readFileSync(descriptor);
      const afterHandle = fstatSync(descriptor, { bigint: true });
      const afterPath = safeClaimStat(file);
      assertDirectoryBinding(paths);
      if (BigInt(bytes.length) !== before.size || !sameIdentity(identity(afterHandle), identity(before)) ||
          !sameIdentity(identity(afterPath), identity(before)) || afterHandle.mtimeNs !== before.mtimeNs ||
          afterPath.mtimeNs !== before.mtimeNs) continue;
      const { claim, sessionID } = parseClaim(JSON.parse(bytes.toString("utf8")), paths.project, agent);
      const age = now - Number(before.mtimeMs);
      if (!Number.isFinite(age) || age < -5_000) throw new Error("invalid OpenCode activity claim timestamp");
      return {
        snapshot: {
          agent: claim.agent,
          kind: claim.kind,
          phase: phases[claim.phase],
          startedAt: claim.startedAt,
          sessionID,
          processID: claim.processID,
          claimToken: claim.claimToken,
        },
        fresh: age <= openCodeActivityTtlMs,
        identity: identity(before),
      };
    } catch (error: any) {
      if (error?.code === "ENOENT" && attempt < 2) continue;
      throw error;
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  }
  throw new Error("OpenCode activity claim changed while being read");
}

function pathHasIdentity(paths: ClaimPaths, file: string, expected: FileIdentity): boolean {
  try {
    assertDirectoryBinding(paths);
    const current = safeClaimStat(file);
    return sameIdentity(identity(current), expected);
  } catch { return false; }
}

function removeOwnedPath(paths: ClaimPaths, file: string, expected: FileIdentity): boolean {
  try {
    assertDirectoryBinding(paths);
    const current = safeClaimStat(file);
    if (!sameIdentity(identity(current), expected)) return false;
    unlinkSync(file);
    assertDirectoryBinding(paths);
    return true;
  } catch (error: any) {
    if (error?.code === "ENOENT") return true;
    return false;
  }
}

function projectClaims(project: string, includeStale: boolean): readonly ReadClaim[] {
  const paths = claimPaths(project, false);
  if (!paths) return [];
  assertDirectoryBinding(paths);
  const entries = readdirSync(paths.directory, { withFileTypes: true });
  assertDirectoryBinding(paths);
  if (entries.length > maximumOpenCodeActivityDirectoryEntries) {
    throw new Error("OpenCode activity inventory exceeds its directory-entry safety limit");
  }
  const claims: ReadClaim[] = [];
  for (const entry of entries) {
    if (temporaryClaimPattern.test(entry.name) && !entry.isSymbolicLink() && entry.isFile()) continue;
    const match = /^([a-z0-9][a-z0-9-]{0,47})\.json$/u.exec(entry.name);
    if (!match || entry.isSymbolicLink() || !entry.isFile()) throw new Error("unsafe OpenCode activity inventory entry");
    const claim = readClaim(paths, claimPath(paths.directory, match[1]), match[1]);
    if (claim && (includeStale || claim.fresh)) claims.push(claim);
  }
  assertDirectoryBinding(paths);
  return claims;
}

function writeAll(descriptor: number, bytes: Buffer, position = 0): void {
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(descriptor, bytes, offset, bytes.length - offset, position + offset);
    if (written <= 0) throw new Error("OpenCode activity claim write made no progress");
    offset += written;
  }
}

/** Atomically claims one player across OpenCode server/plugin isolates and OS processes. */
export function claimOpenCodeAgentActivity(
  project: string,
  agent: string,
  kind: OpenCodeAgentActivityKind,
  sessionID: string,
  now = Date.now(),
): OpenCodeAgentActivityClaim {
  if (!activityIDPattern.test(agent) || !validIdentity(sessionID) || !["direct", "delegated"].includes(kind) ||
      !Number.isSafeInteger(now) || now < 0) {
    throw new Error("invalid OpenCode activity claim input");
  }
  const paths = claimPaths(project, true)!;
  const file = claimPath(paths.directory, agent);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const existing = readClaim(paths, file, agent, now);
    if (existing) {
      if (existing.fresh) throw new Error(`Agent Harbor player ${agent} is busy in another direct or delegated run`);
      if (!removeOwnedPath(paths, file, existing.identity)) {
        throw new Error(`Agent Harbor player ${agent} has a stale activity claim that changed during cleanup`);
      }
    }
    const freshClaims = projectClaims(project, false);
    if (freshClaims.length >= maximumOpenCodeAgentActivitiesPerProject) {
      throw new Error(`Agent Harbor allows at most ${maximumOpenCodeAgentActivitiesPerProject} active runs per project; wait for work to finish or use /team stop`);
    }
    const claimToken = randomBytes(18).toString("base64url");
    const publicationToken = randomBytes(18).toString("base64url");
    const temporary = temporaryClaimPath(paths.directory, publicationToken);
    let phase: OpenCodeAgentActivityPhase = "starting";
    let currentSessionID = sessionID;
    let activeSlot: StoredClaim["slot"] = "a";
    let released = false;
    let descriptor: number | undefined;
    let fileIdentity: FileIdentity | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let published = false;
    try {
      descriptor = openSync(temporary, "wx", 0o600);
      const initialSlot = sessionSlot(sessionID);
      const stored: StoredClaim = {
        version: 1,
        owner: "agent-harbor",
        project: paths.project,
        agent,
        kind,
        phase: phaseCodes[phase],
        slot: activeSlot,
        sessionA: initialSlot,
        sessionB: initialSlot,
        startedAt: now,
        processID: process.pid,
        claimToken,
      };
      const encoded = JSON.stringify(stored);
      const encodedBytes = Buffer.from(encoded, "utf8");
      if (encodedBytes.length > maximumOpenCodeActivityClaimBytes) throw new Error("OpenCode activity claim exceeds its safety bound");
      writeAll(descriptor, encodedBytes);
      fsyncSync(descriptor);
      const opened = fstatSync(descriptor, { bigint: true });
      fileIdentity = identity(opened);
      const markerOffset = (property: string, valueOffset: number): number => {
        const marker = `"${property}":"`;
        const index = encoded.indexOf(marker);
        if (index < 0) throw new Error(`OpenCode activity ${property} marker is unavailable`);
        return Buffer.byteLength(encoded.slice(0, index + marker.length), "utf8") + valueOffset;
      };
      const phaseOffset = markerOffset("phase", 0);
      const slotOffset = markerOffset("slot", 0);
      const sessionAOffset = markerOffset("sessionA", 0);
      const sessionBOffset = markerOffset("sessionB", 0);

      assertDirectoryBinding(paths);
      linkSync(temporary, file);
      published = true;
      assertDirectoryBinding(paths);
      if (!pathHasIdentity(paths, file, fileIdentity)) throw new Error("OpenCode activity publication identity changed");
      if (!removeOwnedPath(paths, temporary, fileIdentity)) throw new Error("OpenCode activity temporary publication cleanup failed");

      const beat = (): void => {
        if (released || descriptor === undefined || !fileIdentity || !pathHasIdentity(paths, file, fileIdentity)) return;
        try {
          const current = fstatSync(descriptor, { bigint: true });
          if (!sameIdentity(identity(current), fileIdentity)) return;
          const time = new Date();
          futimesSync(descriptor, time, time);
        } catch { /* A failed heartbeat becomes stale and remains fail-closed until TTL cleanup. */ }
      };
      heartbeat = setInterval(beat, openCodeActivityHeartbeatMs);
      heartbeat.unref?.();
      beat();
      const snapshot = (): OpenCodeAgentActivitySnapshot => ({
        agent, kind, phase, startedAt: now, sessionID: currentSessionID, processID: process.pid, claimToken,
      });
      return {
        get snapshot() { return snapshot(); },
        setSessionID(next) {
          if (released || descriptor === undefined || !fileIdentity || !validIdentity(next) ||
              !pathHasIdentity(paths, file, fileIdentity)) return;
          try {
            const inactive = activeSlot === "a" ? "b" : "a";
            const bytes = Buffer.from(sessionSlot(next), "utf8");
            writeAll(descriptor, bytes, inactive === "a" ? sessionAOffset : sessionBOffset);
            fsyncSync(descriptor);
            writeAll(descriptor, Buffer.from(inactive, "utf8"), slotOffset);
            fsyncSync(descriptor);
            activeSlot = inactive;
            currentSessionID = next;
            beat();
          } catch { /* The active slot still points to the last complete session identity. */ }
        },
        setPhase(next) {
          if (released || descriptor === undefined || !fileIdentity || !Object.hasOwn(phaseCodes, next) ||
              kind === "direct" && next === "cleaning" || !pathHasIdentity(paths, file, fileIdentity)) return;
          try {
            writeAll(descriptor, Buffer.from(phaseCodes[next], "utf8"), phaseOffset);
            fsyncSync(descriptor);
            phase = next;
            beat();
          } catch { /* Keep the last safely published phase and continue heartbeating the ownership claim. */ }
        },
        release() {
          if (released) return;
          released = true;
          if (heartbeat) clearInterval(heartbeat);
          if (descriptor !== undefined) {
            try { closeSync(descriptor); } catch { /* already closed */ }
            descriptor = undefined;
          }
          if (fileIdentity) removeOwnedPath(paths, file, fileIdentity);
        },
      };
    } catch (error: any) {
      if (heartbeat) clearInterval(heartbeat);
      if (descriptor !== undefined) {
        try { closeSync(descriptor); } catch { /* preserve the original failure */ }
      }
      if (fileIdentity) {
        removeOwnedPath(paths, temporary, fileIdentity);
        if (published) removeOwnedPath(paths, file, fileIdentity);
      }
      if (error?.code === "EEXIST" && attempt === 0) continue;
      throw error;
    }
  }
  throw new Error(`Agent Harbor player ${agent} is busy in another direct or delegated run`);
}

/** Returns bounded, fresh claims; callers must project private native identities away before rendering. */
export function readOpenCodeAgentActivities(project: string): readonly OpenCodeAgentActivitySnapshot[] {
  return projectClaims(project, false)
    .slice(0, maximumOpenCodeAgentActivitiesPerProject)
    .map(({ snapshot }) => ({ ...snapshot }));
}
