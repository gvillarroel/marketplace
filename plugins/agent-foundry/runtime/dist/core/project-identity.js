/** Physical project/path identity shared by every Agent Harbor runtime. */
import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
function platformKey(path) {
    const normalized = resolve(path);
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
function validPathInput(value) {
    if (typeof value !== "string" || !value.trim() || value.includes("\0")) {
        throw new Error("Agent Harbor project identity is invalid");
    }
}
/**
 * Resolves an existing path through symlinks/junctions. A deliberately
 * synthetic path is keyed below its nearest physical directory ancestor.
 * Permission and other I/O failures remain fatal instead of splitting scope.
 */
export function canonicalPathIdentity(value) {
    validPathInput(value);
    const absolute = resolve(value);
    let cursor = absolute;
    const missing = [];
    for (;;) {
        try {
            const stat = lstatSync(cursor);
            if (missing.length && !stat.isDirectory()) {
                throw new Error("Agent Harbor project identity has a non-directory ancestor");
            }
            const physical = resolve(realpathSync.native(cursor));
            const candidate = resolve(physical, ...missing.reverse());
            const suffix = relative(physical, candidate);
            if (suffix.startsWith("..") || isAbsolute(suffix)) {
                throw new Error("Agent Harbor project identity escaped its physical ancestor");
            }
            return platformKey(candidate);
        }
        catch (error) {
            if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR")
                throw error;
            const parent = dirname(cursor);
            if (parent === cursor) {
                throw new Error("Agent Harbor could not establish a physical project identity", { cause: error });
            }
            missing.push(basename(cursor));
            cursor = parent;
        }
    }
}
/** Canonical directory identity used for admission, views, and stop scope. */
export function canonicalProjectIdentity(project) {
    const canonical = canonicalPathIdentity(project);
    try {
        const stat = lstatSync(canonical);
        if (!stat.isDirectory())
            throw new Error("Agent Harbor project path is not a directory");
    }
    catch (error) {
        // Missing synthetic projects are accepted only after the bounded fallback
        // above established a real directory ancestor.
        if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR")
            throw error;
    }
    return canonical;
}
export function sameCanonicalProject(left, right) {
    return canonicalProjectIdentity(left) === canonicalProjectIdentity(right);
}
export function samePhysicalPath(left, right) {
    return canonicalPathIdentity(left) === canonicalPathIdentity(right);
}
