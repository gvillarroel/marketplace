/**
 * Read-only discovery and validation of project-active player profiles.
 * Ownership markers identify Agent Harbor files; canonical validation separately decides whether
 * their complete executable representation is current and therefore invocable.
 */
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { bundledPlayers, rolePlayers } from "./defaults.js";
import { harnessProfileLayout } from "./harnesses.js";
import { isHarborId } from "./identity.js";
import { isOwnedProfile, validatePlayer } from "./lifecycle.js";
import { decodePlayer, isCanonicalPlayerProfile } from "./profiles.js";
const maxActiveProfiles = 200;
function locationFor(harness) {
    const { activeDir: directory, extension } = harnessProfileLayout(harness);
    return { directory, extension };
}
function requireValidId(id) {
    if (!isHarborId(id))
        throw new Error(`invalid player: ${String(id)}`);
    return id;
}
function contained(root, target) {
    const parent = resolve(root);
    const child = resolve(target);
    const rel = relative(parent, child);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel))
        throw new Error(`unsafe path: ${child}`);
    return child;
}
function rejectSymlinkTraversal(root, target) {
    const parent = resolve(root);
    const child = contained(parent, target);
    const rel = relative(parent, child);
    let cursor = parent;
    for (const segment of ["", ...rel.split(/[\\/]+/)]) {
        if (segment)
            cursor = join(cursor, segment);
        const stat = lstatSync(cursor);
        if (stat.isSymbolicLink())
            throw new Error(`symlink traversal refused: ${cursor}`);
    }
}
function activePath(harness, project, id) {
    const root = resolve(project);
    const { directory, extension } = locationFor(harness);
    return contained(root, join(root, directory, `${id}${extension}`));
}
function expectedRoster(id) {
    return bundledPlayers.has(id) ? "sdlc" : "personal";
}
// Reading proves only ownership and basic filesystem safety. Canonicality is intentionally a
// separate step so callers can distinguish stale Agent Harbor files from unmanaged collisions.
function readOwnedActiveProfile(harness, project, id) {
    const projectRoot = resolve(project);
    const path = activePath(harness, projectRoot, id);
    try {
        rejectSymlinkTraversal(projectRoot, path);
        const stat = lstatSync(path);
        if (!stat.isFile())
            return undefined;
        if (stat.size > 30_000)
            return undefined;
        const content = readFileSync(path, "utf8");
        if (!isOwnedProfile(content, id, expectedRoster(id)))
            return undefined;
        return content;
    }
    catch (error) {
        if (["ENOENT", "ENOTDIR"].includes(error?.code))
            return undefined;
        throw error;
    }
}
// A managed definition must decode from the profile and reproduce the complete revision-4 profile.
// Merely carrying an Agent Harbor ownership marker is insufficient for execution.
function validatedDefinition(content, id, harness, project) {
    const definition = validatePlayer(decodePlayer(content, id), bundledPlayers.has(id));
    if (!isCanonicalPlayerProfile(content, harness, definition, expectedRoster(id), project)) {
        throw new Error(`active managed player is stale: ${id}`);
    }
    return definition;
}
// Discovery reads each candidate at most once, then keeps both the broader ownership view and the
// narrower canonical view. Retaining the definition here proves the managed projection came from
// the same bytes as its ownership decision rather than from a second, potentially racy read.
function scanActiveProfiles(harness, project) {
    const projectRoot = resolve(project);
    const { directory, extension } = locationFor(harness);
    const activeRoot = contained(projectRoot, join(projectRoot, directory));
    try {
        rejectSymlinkTraversal(projectRoot, activeRoot);
        const rootStat = lstatSync(activeRoot);
        if (!rootStat.isDirectory())
            return { ownedIds: [], managedProfiles: [] };
        const candidates = readdirSync(activeRoot, { withFileTypes: true })
            .filter((entry) => entry.name.endsWith(extension))
            .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
        if (candidates.length > maxActiveProfiles)
            throw new Error(`too many active profiles: ${candidates.length}`);
        const ownedIds = [];
        const managedProfiles = [];
        for (const entry of candidates) {
            if (entry.isSymbolicLink())
                throw new Error(`symlink traversal refused: ${join(activeRoot, entry.name)}`);
            const id = entry.name.slice(0, -extension.length);
            if (!isHarborId(id))
                continue;
            if (!entry.isFile())
                continue;
            const content = readOwnedActiveProfile(harness, projectRoot, id);
            if (!content)
                continue;
            ownedIds.push(id);
            try {
                managedProfiles.push({ id, definition: validatedDefinition(content, id, harness, projectRoot) });
            }
            catch {
                // Owned but stale or malformed profiles remain visible only through the ownership view.
            }
        }
        return { ownedIds, managedProfiles };
    }
    catch (error) {
        if (["ENOENT", "ENOTDIR"].includes(error?.code))
            return { ownedIds: [], managedProfiles: [] };
        throw error;
    }
}
/**
 * Lists active files carrying a structurally valid Agent Harbor ownership marker.
 * The result may include stale revision-3 or modified revision-4 profiles; use
 * {@link listManagedActiveIds} when selecting an invocation target.
 */
export function listOwnedActiveIds(harness, project) {
    return scanActiveProfiles(harness, project).ownedIds;
}
/** Lists owned revision-4 profiles whose complete executable representation is canonical. */
export function listManagedActiveIds(harness, project) {
    return scanActiveProfiles(harness, project).managedProfiles.map(({ id }) => id);
}
/** Lists fixed roles first, followed by canonical project profiles that are safe to invoke. */
export function listInvocablePlayerIds(harness, project) {
    const ids = new Set(rolePlayers.keys());
    for (const { id } of scanActiveProfiles(harness, project).managedProfiles)
        ids.add(id);
    return [...ids];
}
/** Loads one active player only if it is owned, revision-4, validated, and canonical. */
export function loadManagedActivePlayer(harness, project, id) {
    const validId = requireValidId(id);
    const content = readOwnedActiveProfile(harness, project, validId);
    if (!content)
        throw new Error(`active managed player not found: ${validId}`);
    return validatedDefinition(content, validId, harness, resolve(project));
}
/** Pi-specific convenience wrapper for loading a canonical active player. */
export function loadPiActivePlayer(project, id) {
    return loadManagedActivePlayer("pi", project, id);
}
/** Resolves a fixed role or canonical active profile and returns its validated definition. */
export function requireInvocablePlayer(harness, project, id) {
    locationFor(harness);
    const validId = requireValidId(id);
    const fixed = rolePlayers.get(validId);
    if (fixed)
        return { id: validId, source: "fixed", definition: fixed };
    return { id: validId, source: "active", definition: loadManagedActivePlayer(harness, project, validId) };
}
/** Narrows an unknown identifier to a string after proving the corresponding player is invocable. */
export function assertInvocablePlayer(harness, project, id) {
    requireInvocablePlayer(harness, project, id);
}
/** Returns whether an identifier resolves to a fixed role or canonical active profile. */
export function isInvocablePlayer(harness, project, id) {
    try {
        requireInvocablePlayer(harness, project, id);
        return true;
    }
    catch {
        return false;
    }
}
