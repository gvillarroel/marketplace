/**
 * Read-only discovery and validation of project-active player profiles.
 * Ownership markers identify Agent Harbor files; canonical validation separately decides whether
 * their complete executable representation is current and therefore invocable.
 */

import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  opendirSync,
  readSync,
  type Dirent,
  type Stats,
} from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { bundledPlayers, rolePlayers } from "./defaults.js";
import { harnessProfileLayout } from "./harnesses.js";
import { isHarborId } from "./identity.js";
import { isOwnedProfile, validatePlayer } from "./lifecycle.js";
import { decodePlayer, isCanonicalPlayerProfile } from "./profiles.js";
import type { HarnessName, PlayerDefinition } from "./types.js";

const maxActiveProfiles = 200;
const maxActiveDirectoryEntries = 512;
const maxActiveProfileBytes = 30_000;
const noFollowFlag = (constants as Record<string, number>).O_NOFOLLOW ?? 0;
const nonBlockingFlag = (constants as Record<string, number>).O_NONBLOCK ?? 0;

/** Resolved player identity returned only after its definition is safe to invoke. */
export interface InvocablePlayerIdentity {
  /** Stable player identifier used by harness delegation tools. */
  id: string;
  /** Whether the definition is built in or recovered from an active managed profile. */
  source: "fixed" | "active";
  /** Validated definition recovered from a fixed role or revision-5 managed profile. */
  definition: PlayerDefinition;
}

interface ManagedActiveProfile {
  readonly id: string;
  readonly definition: PlayerDefinition;
}

interface ActiveProfileScan {
  readonly ownedIds: string[];
  readonly managedProfiles: ManagedActiveProfile[];
  readonly startupDiagnostics: ActiveStartupDiagnostic[];
}

/** A bounded, path-free startup warning that is safe to show in the host UI. */
export interface ActiveStartupDiagnostic {
  readonly code:
    | "unsafe-active-directory"
    | "foreign-profile-symlink"
    | "directory-entry-limit"
    | "profile-candidate-limit"
    | "profile-unreadable";
  /** Public summary; deliberately excludes absolute paths and raw filesystem errors. */
  readonly message: string;
  /** Concrete local repair that does not weaken Agent Harbor ownership checks. */
  readonly repair: string;
}

/**
 * Startup-only discovery result. `ids` contains only canonical managed profiles;
 * `complete` is false whenever an unsafe or bounded-away entry was observed.
 */
export interface ActiveStartupProfileDiscovery {
  readonly ids: string[];
  readonly complete: boolean;
  readonly diagnostics: ActiveStartupDiagnostic[];
}

type ActiveProfileScanMode = "strict" | "startup";

const emptyActiveProfileScan = (): ActiveProfileScan => ({
  ownedIds: [],
  managedProfiles: [],
  startupDiagnostics: [],
});

function startupDiagnostic(
  diagnostics: ActiveStartupDiagnostic[],
  diagnostic: ActiveStartupDiagnostic,
): void {
  // Codes are intentionally unique. A directory containing hundreds of hostile
  // entries can therefore produce at most five short public diagnostics.
  if (!diagnostics.some(({ code }) => code === diagnostic.code)) diagnostics.push(diagnostic);
}

function symlinkDiagnostic(): ActiveStartupDiagnostic {
  return {
    code: "foreign-profile-symlink",
    message: "A symlinked active-profile entry was ignored; no profile was loaded through it.",
    repair: "Remove or rename symlinks in the active-profile directory, then reload the host session.",
  };
}

function locationFor(harness: HarnessName): { directory: string; extension: string } {
  const { activeDir: directory, extension } = harnessProfileLayout(harness);
  return { directory, extension };
}

function requireValidId(id: unknown): string {
  if (!isHarborId(id)) throw new Error(`invalid player: ${String(id)}`);
  return id;
}

function contained(root: string, target: string): string {
  const parent = resolve(root);
  const child = resolve(target);
  const rel = relative(parent, child);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) throw new Error(`unsafe path: ${child}`);
  return child;
}

function rejectSymlinkTraversal(root: string, target: string): void {
  const parent = resolve(root);
  const child = contained(parent, target);
  const rel = relative(parent, child);
  let cursor = parent;
  for (const segment of ["", ...rel.split(/[\\/]+/)]) {
    if (segment) cursor = join(cursor, segment);
    const stat = lstatSync(cursor);
    if (stat.isSymbolicLink()) throw new Error(`symlink traversal refused: ${cursor}`);
  }
}

function activePath(harness: HarnessName, project: string, id: string): string {
  const root = resolve(project);
  const { directory, extension } = locationFor(harness);
  return contained(root, join(root, directory, `${id}${extension}`));
}

function expectedRoster(id: string): "personal" | "sdlc" {
  return bundledPlayers.has(id) ? "sdlc" : "personal";
}

function sameStableFile(left: Stats, right: Stats): boolean {
  return left.isFile()
    && right.isFile()
    && left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

// Reading proves only ownership and basic filesystem safety. Canonicality is intentionally a
// separate step so callers can distinguish stale Agent Harbor files from unmanaged collisions.
function readOwnedActiveProfile(harness: HarnessName, project: string, id: string): string | undefined {
  const projectRoot = resolve(project);
  const path = activePath(harness, projectRoot, id);
  let descriptor: number | undefined;
  try {
    rejectSymlinkTraversal(projectRoot, path);
    const before = lstatSync(path);
    if (!before.isFile() || before.size > maxActiveProfileBytes) return undefined;
    descriptor = openSync(path, constants.O_RDONLY | noFollowFlag | nonBlockingFlag);
    const openedBefore = fstatSync(descriptor);
    if (!sameStableFile(before, openedBefore) || openedBefore.size > maxActiveProfileBytes) {
      throw new Error("active profile changed while it was opened");
    }
    const buffer = Buffer.alloc(maxActiveProfileBytes + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const count = readSync(descriptor, buffer, bytesRead, buffer.length - bytesRead, null);
      if (count === 0) break;
      bytesRead += count;
    }
    if (bytesRead > maxActiveProfileBytes) throw new Error("active profile exceeded its read limit");
    const openedAfter = fstatSync(descriptor);
    const after = lstatSync(path);
    if (!sameStableFile(openedBefore, openedAfter)
      || !sameStableFile(openedAfter, after)
      || bytesRead !== openedAfter.size) {
      throw new Error("active profile changed while it was read");
    }
    const content = buffer.subarray(0, bytesRead).toString("utf8");
    if (!isOwnedProfile(content, id, expectedRoster(id))) return undefined;
    return content;
  } catch (error: any) {
    if (["ENOENT", "ENOTDIR"].includes(error?.code)) return undefined;
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

// A managed definition must decode from the profile and reproduce the complete revision-5 profile.
// Merely carrying an Agent Harbor ownership marker is insufficient for execution.
function validatedDefinition(content: string, id: string, harness: HarnessName, project: string): PlayerDefinition {
  const definition = validatePlayer(decodePlayer(content, id), bundledPlayers.has(id));
  if (!isCanonicalPlayerProfile(content, harness, definition, expectedRoster(id), project)) {
    throw new Error(`active managed player is stale: ${id}`);
  }
  return definition;
}

// Discovery reads each candidate at most once, then keeps both the broader ownership view and the
// narrower canonical view. Retaining the definition here proves the managed projection came from
// the same bytes as its ownership decision rather than from a second, potentially racy read.
function scanActiveProfiles(
  harness: HarnessName,
  project: string,
  mode: ActiveProfileScanMode = "strict",
): ActiveProfileScan {
  const projectRoot = resolve(project);
  const { directory, extension } = locationFor(harness);
  const activeRoot = contained(projectRoot, join(projectRoot, directory));
  const startupDiagnostics: ActiveStartupDiagnostic[] = [];
  try {
    rejectSymlinkTraversal(projectRoot, activeRoot);
    const rootStat = lstatSync(activeRoot);
    if (!rootStat.isDirectory()) {
      if (mode === "strict") return emptyActiveProfileScan();
      startupDiagnostic(startupDiagnostics, {
        code: "unsafe-active-directory",
        message: "The active-profile location is not a real directory, so project profiles were not loaded.",
        repair: "Move the conflicting entry aside, recreate the active-profile directory, then run /bench on and reload.",
      });
      return { ...emptyActiveProfileScan(), startupDiagnostics };
    }
    const candidates: Dirent[] = [];
    let inspectedEntries = 0;
    let candidateCount = 0;
    const directoryHandle = opendirSync(activeRoot, { bufferSize: 32 });
    try {
      for (;;) {
        const entry = directoryHandle.readSync();
        if (entry === null) break;
        inspectedEntries += 1;
        if (inspectedEntries > maxActiveDirectoryEntries) {
          if (mode === "strict") {
            throw new Error(`too many active profile directory entries: ${inspectedEntries}`);
          }
          startupDiagnostic(startupDiagnostics, {
            code: "directory-entry-limit",
            message: `Active-profile startup discovery stopped after ${maxActiveDirectoryEntries} directory entries.`,
            repair: `Keep at most ${maxActiveDirectoryEntries} entries in the active-profile directory, then reload the host session.`,
          });
          break;
        }
        if (!entry.name.endsWith(extension)) continue;
        candidateCount += 1;
        if (candidateCount > maxActiveProfiles) {
          if (mode === "strict") throw new Error(`too many active profiles: ${candidateCount}`);
          startupDiagnostic(startupDiagnostics, {
            code: "profile-candidate-limit",
            message: `Active-profile startup discovery stopped after ${maxActiveProfiles} candidate profiles.`,
            repair: `Keep at most ${maxActiveProfiles} profile files in the active-profile directory, then reload the host session.`,
          });
          break;
        }
        candidates.push(entry);
      }
    } finally {
      directoryHandle.closeSync();
    }
    candidates.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    const ownedIds: string[] = [];
    const managedProfiles: ManagedActiveProfile[] = [];
    for (const entry of candidates) {
      if (entry.isSymbolicLink()) {
        if (mode === "strict") throw new Error(`symlink traversal refused: ${join(activeRoot, entry.name)}`);
        startupDiagnostic(startupDiagnostics, symlinkDiagnostic());
        continue;
      }
      const id = entry.name.slice(0, -extension.length);
      if (!isHarborId(id)) continue;
      if (!entry.isFile()) continue;
      let content: string | undefined;
      try {
        content = readOwnedActiveProfile(harness, projectRoot, id);
      } catch (error) {
        if (mode === "strict") throw error;
        if (error instanceof Error && /symlink traversal refused/u.test(error.message)) {
          startupDiagnostic(startupDiagnostics, symlinkDiagnostic());
        } else {
          startupDiagnostic(startupDiagnostics, {
            code: "profile-unreadable",
            message: "An active-profile candidate changed or could not be read safely and was ignored.",
            repair: "Inspect or recreate unreadable active profiles with /bench on, then reload the host session.",
          });
        }
        continue;
      }
      if (!content) continue;
      ownedIds.push(id);
      try {
        managedProfiles.push({ id, definition: validatedDefinition(content, id, harness, projectRoot) });
      } catch {
        // Owned but stale or malformed profiles remain visible only through the ownership view.
      }
    }
    return { ownedIds, managedProfiles, startupDiagnostics };
  } catch (error: any) {
    if (["ENOENT", "ENOTDIR"].includes(error?.code)) return emptyActiveProfileScan();
    if (mode === "startup") {
      startupDiagnostic(startupDiagnostics, {
        code: "unsafe-active-directory",
        message: "The active-profile directory could not be inspected safely, so project profiles were not loaded.",
        repair: "Replace symlinked or unreadable path components with real accessible directories, then reload the host session.",
      });
      return { ...emptyActiveProfileScan(), startupDiagnostics };
    }
    throw error;
  }
}

/**
 * Discovers startup aliases without allowing foreign filesystem entries to abort
 * the extension. The scan streams at most 513 directory entries and retains at
 * most 200 candidates; every returned ID still passed full ownership, revision,
 * validation, and canonical-profile checks. Direct invocation remains strict.
 */
export function discoverStartupActiveProfiles(
  harness: HarnessName,
  project: string,
): ActiveStartupProfileDiscovery {
  const scan = scanActiveProfiles(harness, project, "startup");
  return {
    ids: scan.managedProfiles.map(({ id }) => id),
    complete: scan.startupDiagnostics.length === 0,
    diagnostics: scan.startupDiagnostics,
  };
}

/**
 * Lists active files carrying a structurally valid Agent Harbor ownership marker.
 * The result may include exact legacy revision-4 or modified revision-5 profiles; use
 * {@link listManagedActiveIds} when selecting an invocation target.
 */
export function listOwnedActiveIds(harness: HarnessName, project: string): string[] {
  return scanActiveProfiles(harness, project).ownedIds;
}

/** Lists owned revision-5 profiles whose complete executable representation is canonical. */
export function listManagedActiveIds(harness: HarnessName, project: string): string[] {
  return scanActiveProfiles(harness, project).managedProfiles.map(({ id }) => id);
}

/** Lists fixed roles first, followed by canonical project profiles that are safe to invoke. */
export function listInvocablePlayerIds(harness: HarnessName, project: string): string[] {
  return listInvocablePlayers(harness, project).map(({ id }) => id);
}

/**
 * Returns an invocation-scoped snapshot of every fixed/current player. Active
 * definitions are parsed once during the scan so callers cannot create a run
 * and then lose its preparation to a second filesystem read.
 */
export function listInvocablePlayers(harness: HarnessName, project: string): InvocablePlayerIdentity[] {
  locationFor(harness);
  const players: InvocablePlayerIdentity[] = [...rolePlayers].map(([id, definition]) => ({
    id,
    source: "fixed" as const,
    definition,
  }));
  const ids = new Set(rolePlayers.keys());
  for (const { id, definition } of scanActiveProfiles(harness, project).managedProfiles) {
    if (ids.has(id)) continue;
    ids.add(id);
    players.push({ id, source: "active", definition });
  }
  return players;
}

/** Loads one active player only if it is owned, revision-5, validated, and canonical. */
export function loadManagedActivePlayer(harness: HarnessName, project: string, id: unknown): PlayerDefinition {
  const validId = requireValidId(id);
  const content = readOwnedActiveProfile(harness, project, validId);
  if (!content) throw new Error(`active managed player not found: ${validId}`);
  return validatedDefinition(content, validId, harness, resolve(project));
}

/** Pi-specific convenience wrapper for loading a canonical active player. */
export function loadPiActivePlayer(project: string, id: unknown): PlayerDefinition {
  return loadManagedActivePlayer("pi", project, id);
}

/** Resolves a fixed role or canonical active profile and returns its validated definition. */
export function requireInvocablePlayer(harness: HarnessName, project: string, id: unknown): InvocablePlayerIdentity {
  locationFor(harness);
  const validId = requireValidId(id);
  const fixed = rolePlayers.get(validId);
  if (fixed) return { id: validId, source: "fixed", definition: fixed };
  return { id: validId, source: "active", definition: loadManagedActivePlayer(harness, project, validId) };
}

/** Narrows an unknown identifier to a string after proving the corresponding player is invocable. */
export function assertInvocablePlayer(harness: HarnessName, project: string, id: unknown): asserts id is string {
  requireInvocablePlayer(harness, project, id);
}

/** Returns whether an identifier resolves to a fixed role or canonical active profile. */
export function isInvocablePlayer(harness: HarnessName, project: string, id: unknown): boolean {
  try { requireInvocablePlayer(harness, project, id); return true; }
  catch { return false; }
}
