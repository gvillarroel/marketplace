import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { bundledPlayers, rolePlayers } from "./defaults.js";
import { isOwnedProfile, validatePlayer } from "./lifecycle.js";
import { decodePlayer, isCanonicalPlayerProfile } from "./profiles.js";
import type { HarnessName, PlayerDefinition } from "./types.js";

const idPattern = /^[a-z0-9][a-z0-9-]{0,47}$/;
const maxActiveProfiles = 200;

const activeLocations: Record<HarnessName, { directory: string; extension: string }> = {
  copilot: { directory: ".github/agents", extension: ".agent.md" },
  opencode: { directory: ".opencode/agents", extension: ".md" },
  pi: { directory: ".pi/agents", extension: ".md" },
};

export interface InvocablePlayerIdentity {
  id: string;
  source: "fixed" | "active";
  /** Validated definition recovered from a fixed role or revision-4 managed profile. */
  definition: PlayerDefinition;
}

function locationFor(harness: HarnessName): { directory: string; extension: string } {
  const location = activeLocations[harness];
  if (!location) throw new Error(`unsupported harness: ${String(harness)}`);
  return location;
}

function requireValidId(id: unknown): string {
  if (typeof id !== "string" || !idPattern.test(id)) throw new Error(`invalid player: ${String(id)}`);
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

function readManagedActiveProfile(harness: HarnessName, project: string, id: string): string | undefined {
  const projectRoot = resolve(project);
  const path = activePath(harness, projectRoot, id);
  try {
    rejectSymlinkTraversal(projectRoot, path);
    const stat = lstatSync(path);
    if (!stat.isFile()) return undefined;
    if (stat.size > 30_000) return undefined;
    const content = readFileSync(path, "utf8");
    if (!isOwnedProfile(content, id, expectedRoster(id))) return undefined;
    return content;
  } catch (error: any) {
    if (["ENOENT", "ENOTDIR"].includes(error?.code)) return undefined;
    throw error;
  }
}

function validatedDefinition(content: string, id: string, harness: HarnessName, project: string): PlayerDefinition {
  const definition = validatePlayer(decodePlayer(content, id), bundledPlayers.has(id));
  if (!isCanonicalPlayerProfile(content, harness, definition, expectedRoster(id), project)) {
    throw new Error(`active managed player is stale: ${id}`);
  }
  return definition;
}

/** Lists project profiles that are owned by Agent Harbor and safe to invoke. */
export function listOwnedActiveIds(harness: HarnessName, project: string): string[] {
  const projectRoot = resolve(project);
  const { directory, extension } = locationFor(harness);
  const activeRoot = contained(projectRoot, join(projectRoot, directory));
  try {
    rejectSymlinkTraversal(projectRoot, activeRoot);
    const rootStat = lstatSync(activeRoot);
    if (!rootStat.isDirectory()) return [];
    const candidates = readdirSync(activeRoot, { withFileTypes: true })
      .filter((entry) => entry.name.endsWith(extension))
      .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    if (candidates.length > maxActiveProfiles) throw new Error(`too many active profiles: ${candidates.length}`);
    const ids: string[] = [];
    for (const entry of candidates) {
      if (entry.isSymbolicLink()) throw new Error(`symlink traversal refused: ${join(activeRoot, entry.name)}`);
      const id = entry.name.slice(0, -extension.length);
      if (!idPattern.test(id)) continue;
      if (!entry.isFile()) continue;
      const content = readManagedActiveProfile(harness, projectRoot, id);
      if (!content) continue;
      ids.push(id);
    }
    return ids;
  } catch (error: any) {
    if (["ENOENT", "ENOTDIR"].includes(error?.code)) return [];
    throw error;
  }
}

/** Lists owned profiles whose entire executable representation is canonical and safe to invoke. */
export function listManagedActiveIds(harness: HarnessName, project: string): string[] {
  const projectRoot = resolve(project);
  return listOwnedActiveIds(harness, projectRoot).filter((id) => {
    const content = readManagedActiveProfile(harness, projectRoot, id);
    if (!content) return false;
    try { validatedDefinition(content, id, harness, projectRoot); return true; }
    catch { return false; }
  });
}

/** Fixed roles first, followed by ownership-verified project profiles. */
export function listInvocablePlayerIds(harness: HarnessName, project: string): string[] {
  const ids = new Set(rolePlayers.keys());
  for (const id of listManagedActiveIds(harness, project)) ids.add(id);
  return [...ids];
}

export function loadManagedActivePlayer(harness: HarnessName, project: string, id: unknown): PlayerDefinition {
  const validId = requireValidId(id);
  const content = readManagedActiveProfile(harness, project, validId);
  if (!content) throw new Error(`active managed player not found: ${validId}`);
  return validatedDefinition(content, validId, harness, resolve(project));
}

export function loadPiActivePlayer(project: string, id: unknown): PlayerDefinition {
  return loadManagedActivePlayer("pi", project, id);
}

export function requireInvocablePlayer(harness: HarnessName, project: string, id: unknown): InvocablePlayerIdentity {
  locationFor(harness);
  const validId = requireValidId(id);
  const fixed = rolePlayers.get(validId);
  if (fixed) return { id: validId, source: "fixed", definition: fixed };
  return { id: validId, source: "active", definition: loadManagedActivePlayer(harness, project, validId) };
}

export function assertInvocablePlayer(harness: HarnessName, project: string, id: unknown): asserts id is string {
  requireInvocablePlayer(harness, project, id);
}

export function isInvocablePlayer(harness: HarnessName, project: string, id: unknown): boolean {
  try { requireInvocablePlayer(harness, project, id); return true; }
  catch { return false; }
}
