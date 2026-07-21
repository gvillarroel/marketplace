/** Bounded descriptor-based reads for managed profile metadata. */
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
const noFollowFlag = constants.O_NOFOLLOW ?? 0;
const nonBlockingFlag = constants.O_NONBLOCK ?? 0;
function sameStableFile(left, right) {
    return left.isFile()
        && right.isFile()
        && left.dev === right.dev
        && left.ino === right.ino
        && left.size === right.size
        && left.mtimeMs === right.mtimeMs
        && left.ctimeMs === right.ctimeMs;
}
/** Reads one contained regular file without following links or allocating past its byte cap. */
export async function readSafeBoundedProfile(root, path, maximumBytes = 30_000) {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > 1_000_000) {
        throw new Error("safe profile byte limit must be an integer between 1 and 1000000");
    }
    const parent = resolve(root);
    const target = resolve(path);
    const rel = relative(parent, target);
    if (!rel || rel.startsWith("..") || isAbsolute(rel))
        throw new Error(`unsafe path: ${target}`);
    let cursor = parent;
    let before;
    let handle;
    try {
        for (const segment of ["", ...rel.split(/[\\/]+/u)]) {
            if (segment)
                cursor = join(cursor, segment);
            const stat = await lstat(cursor);
            if (stat.isSymbolicLink())
                throw new Error(`symlink traversal refused: ${cursor}`);
            if (cursor === target) {
                if (!stat.isFile() || stat.size > maximumBytes)
                    return undefined;
                before = stat;
            }
        }
        if (!before)
            return undefined;
        handle = await open(target, constants.O_RDONLY | noFollowFlag | nonBlockingFlag);
        const openedBefore = await handle.stat();
        if (!sameStableFile(before, openedBefore) || openedBefore.size > maximumBytes) {
            throw new Error("managed profile changed while it was opened");
        }
        const buffer = Buffer.alloc(maximumBytes + 1);
        let bytesRead = 0;
        while (bytesRead < buffer.length) {
            const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, null);
            if (result.bytesRead === 0)
                break;
            bytesRead += result.bytesRead;
        }
        if (bytesRead > maximumBytes)
            throw new Error("managed profile exceeded its read limit");
        const openedAfter = await handle.stat();
        const after = await lstat(target);
        if (!sameStableFile(openedBefore, openedAfter)
            || !sameStableFile(openedAfter, after)
            || bytesRead !== openedAfter.size) {
            throw new Error("managed profile changed while it was read");
        }
        return buffer.subarray(0, bytesRead).toString("utf8");
    }
    catch (error) {
        if (["ENOENT", "ENOTDIR"].includes(error?.code))
            return undefined;
        throw error;
    }
    finally {
        await handle?.close();
    }
}
