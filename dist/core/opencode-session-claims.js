/** Signed provenance for disposable OpenCode sessions created by Agent Harbor. */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { isHarborId } from "./identity.js";
const keyBytes = 32;
const nonceBytes = 12;
const tagBytes = 16;
const keyDirectoryName = "agent-foundry";
const keyFileName = "opencode-title-key-v1";
const signedTitlePattern = /^Harbor (agent|contract): ([a-z0-9][a-z0-9-]{0,47}) · ah1:([A-Za-z0-9_-]{16}):([A-Za-z0-9_-]{22})$/u;
function contained(parent, child) {
    const root = resolve(parent);
    const target = resolve(child);
    const rel = relative(root, target);
    if (!rel || rel.startsWith("..") || isAbsolute(rel))
        throw new Error("unsafe OpenCode title-key location");
    return target;
}
function keyPaths(home) {
    const root = resolve(home);
    const directory = contained(root, join(root, keyDirectoryName));
    return { directory, key: contained(root, join(directory, keyFileName)) };
}
async function requireSafeDirectory(directory, create) {
    try {
        const stat = await lstat(directory);
        if (stat.isSymbolicLink() || !stat.isDirectory())
            throw new Error("unsafe OpenCode title-key directory");
        return true;
    }
    catch (error) {
        if (error?.code !== "ENOENT")
            throw error;
        if (!create)
            return false;
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const stat = await lstat(directory);
        if (stat.isSymbolicLink() || !stat.isDirectory())
            throw new Error("unsafe OpenCode title-key directory");
        return true;
    }
}
async function readValidatedKey(home) {
    const paths = keyPaths(home);
    if (!await requireSafeDirectory(paths.directory, false))
        return undefined;
    let before;
    try {
        before = await lstat(paths.key);
    }
    catch (error) {
        if (error?.code === "ENOENT")
            return undefined;
        throw error;
    }
    if (before.isSymbolicLink() || !before.isFile() || before.size !== keyBytes) {
        throw new Error("invalid OpenCode title-key file");
    }
    if (process.platform !== "win32" && (before.mode & 0o077) !== 0) {
        throw new Error("OpenCode title-key permissions are too broad");
    }
    let handle;
    try {
        const flags = constants.O_RDONLY | (process.platform === "win32"
            ? 0
            : (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
        handle = await open(paths.key, flags);
        const opened = await handle.stat();
        if (!opened.isFile() || opened.size !== keyBytes
            || before.dev !== opened.dev || before.ino !== opened.ino
            || process.platform !== "win32" && (opened.mode & 0o077) !== 0) {
            throw new Error("OpenCode title-key changed before it was opened");
        }
        // Never use an unbounded path read after validation: a raced replacement
        // can contribute at most 33 bytes before identity/size checks reject it.
        const bounded = Buffer.alloc(keyBytes + 1);
        let bytesRead = 0;
        while (bytesRead < bounded.length) {
            const chunk = await handle.read(bounded, bytesRead, bounded.length - bytesRead, bytesRead);
            if (chunk.bytesRead === 0)
                break;
            bytesRead += chunk.bytesRead;
        }
        const afterHandle = await handle.stat();
        const afterPath = await lstat(paths.key);
        if (bytesRead !== keyBytes || !afterHandle.isFile() || afterHandle.size !== keyBytes
            || afterPath.isSymbolicLink() || !afterPath.isFile() || afterPath.size !== keyBytes
            || before.dev !== afterHandle.dev || before.ino !== afterHandle.ino
            || before.dev !== afterPath.dev || before.ino !== afterPath.ino
            || before.mtimeMs !== afterHandle.mtimeMs || before.mtimeMs !== afterPath.mtimeMs) {
            throw new Error("OpenCode title-key changed while being read");
        }
        return Buffer.from(bounded.subarray(0, keyBytes));
    }
    finally {
        await handle?.close().catch(() => undefined);
    }
}
async function loadOrCreateKey(home) {
    const existing = await readValidatedKey(home);
    if (existing)
        return existing;
    const paths = keyPaths(home);
    await requireSafeDirectory(paths.directory, true);
    const generated = randomBytes(keyBytes);
    const temporary = contained(paths.directory, join(paths.directory, `${keyFileName}.tmp-${process.pid}-${randomBytes(12).toString("base64url")}`));
    let handle;
    let temporaryIdentity;
    try {
        // Publish only a fully written and fsynced inode. A crash or disk error
        // before `link` can leave at most a private temporary file, never a
        // canonical zero/partial key that permanently disables the extension.
        handle = await open(temporary, "wx", 0o600);
        const opened = await handle.stat();
        temporaryIdentity = { dev: opened.dev, ino: opened.ino };
        await handle.writeFile(generated);
        await handle.sync();
        await handle.close();
        handle = undefined;
        try {
            // Hard-link creation is an atomic create-if-absent publication: it
            // cannot overwrite a key won by a concurrent process.
            await link(temporary, paths.key);
            const published = await readValidatedKey(home);
            if (!published || !published.equals(generated))
                throw new Error("published OpenCode title key could not be verified");
            return published;
        }
        catch (error) {
            if (error?.code === "EEXIST") {
                const raced = await readValidatedKey(home);
                if (raced)
                    return raced;
            }
            throw error;
        }
    }
    catch (error) {
        await handle?.close().catch(() => undefined);
        handle = undefined;
        if (temporaryIdentity) {
            try {
                const current = await lstat(temporary);
                if (!current.isSymbolicLink() && current.isFile()
                    && current.dev === temporaryIdentity.dev && current.ino === temporaryIdentity.ino) {
                    await rm(temporary, { force: true });
                }
            }
            catch { /* Preserve the original key-establishment failure. */ }
        }
        throw new Error("Agent Harbor could not establish the OpenCode session title key");
    }
    finally {
        await handle?.close().catch(() => undefined);
        if (temporaryIdentity) {
            try {
                const current = await lstat(temporary);
                if (!current.isSymbolicLink() && current.isFile()
                    && current.dev === temporaryIdentity.dev && current.ino === temporaryIdentity.ino) {
                    await rm(temporary, { force: true });
                }
            }
            catch { /* The temporary path may already be gone. */ }
        }
    }
}
function projectKey(project) {
    const value = resolve(project);
    return process.platform === "win32" ? value.toLowerCase() : value;
}
function signedBody(project, invocation, agent, nonce, sessionID) {
    return ["ah1", projectKey(project), invocation, agent, nonce, sessionID]
        .map((value) => `${Buffer.byteLength(value, "utf8")}:${value}`)
        .join("|");
}
function tag(key, project, invocation, agent, nonce, sessionID) {
    return createHmac("sha256", key)
        .update(signedBody(project, invocation, agent, nonce, sessionID), "utf8")
        .digest().subarray(0, tagBytes).toString("base64url");
}
/** Prepares an ID-bound signer before any child is created. */
export async function prepareSignedOpenCodeHarborTitle(home, project, invocation, agent) {
    if (!isHarborId(agent))
        throw new Error("invalid OpenCode Harbor title agent");
    const key = await loadOrCreateKey(home);
    const nonce = randomBytes(nonceBytes).toString("base64url");
    return (sessionID) => {
        if (!sessionID || sessionID.length > 512)
            throw new Error("invalid OpenCode Harbor session ID");
        return `Harbor ${invocation}: ${agent} · ah1:${nonce}:${tag(key, project, invocation, agent, nonce, sessionID)}`;
    };
}
/** Verifies a title using an existing user key; read-only callers never create trust material. */
export async function verifySignedOpenCodeHarborTitle(home, project, title, sessionID) {
    const key = await readValidatedKey(home);
    if (!key)
        return undefined;
    return verifyWithKey(key, project, title, sessionID);
}
function verifyWithKey(key, project, title, sessionID) {
    const parsed = signedTitlePattern.exec(title);
    if (!parsed)
        return undefined;
    const invocation = parsed[1];
    const agent = parsed[2];
    if (!isHarborId(agent))
        return undefined;
    const actual = Buffer.from(parsed[4], "utf8");
    if (!sessionID || sessionID.length > 512)
        return undefined;
    const expected = Buffer.from(tag(key, project, invocation, agent, parsed[3], sessionID), "utf8");
    return actual.length === expected.length && timingSafeEqual(actual, expected)
        ? { invocation, agent }
        : undefined;
}
/** Verifies a bounded batch with one key read, preserving input order. */
export async function verifySignedOpenCodeHarborTitles(home, project, sessions) {
    const key = await readValidatedKey(home);
    return key
        ? sessions.map(({ title, sessionID }) => verifyWithKey(key, project, title, sessionID))
        : sessions.map(() => undefined);
}
/** Loads one read-only verifier for immediate bounded stop rechecks. */
export async function loadOpenCodeHarborTitleVerifier(home, project) {
    const key = await readValidatedKey(home);
    return key ? (title, sessionID) => verifyWithKey(key, project, title, sessionID) : undefined;
}
/** Cheap detection used only for diagnostics; it never grants ownership. */
export function looksLikeOpenCodeHarborTitle(title) {
    const conservative = title
        .replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, "")
        .replace(/[\p{Cc}\p{Cf}]/gu, "")
        .trimStart();
    return /^Harbor (?:agent|contract):/u.test(conservative);
}
