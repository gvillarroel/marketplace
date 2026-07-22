/** Cross-isolate activity claims shared by OpenCode's server and TUI plugins. */
import { Buffer } from "node:buffer";
import { createHash, randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, futimesSync, linkSync, lstatSync, mkdirSync, openSync, opendirSync, readFileSync, realpathSync, unlinkSync, writeSync, } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { bundledPlayers } from "../core/defaults.js";
import { isHarborId } from "../core/identity.js";
import { canonicalProjectIdentity } from "../core/project-identity.js";
const maximumOpenCodeAgentActivitiesPerProject = 32;
const maximumOpenCodeActivityDirectoryEntries = 64;
const maximumOpenCodeActivityClaimBytes = 2_048;
const maximumOpenCodeActivityIdentityBytes = 512;
const encodedSessionSlotBytes = 683;
const openCodeActivityHeartbeatMs = 2_000;
const openCodeActivityTtlMs = 30_000;
const openCodeCapacityLockTtlMs = 5_000;
const openCodeCapacityLockDeadlineMs = 1_500;
const activityOwnerDirectory = "agent-foundry";
const activityDirectory = "opencode-activity-v1";
const sharedActivityDirectory = "team-activity-v1";
const activityIDPattern = /^[a-z0-9][a-z0-9-]{0,47}$/u;
const tokenPattern = /^[A-Za-z0-9_-]{24}$/u;
const temporaryClaimPattern = /^\.agent-harbor-activity-tmp-[A-Za-z0-9_-]{24}$/u;
const capacityLockName = ".agent-harbor-capacity.lock";
const temporaryCapacityLockPattern = /^\.agent-harbor-capacity-tmp-[A-Za-z0-9_-]{24}$/u;
const phaseCodes = {
    starting: "s",
    working: "w",
    cleaning: "c",
};
const phases = {
    s: "starting",
    w: "working",
    c: "cleaning",
};
function projectKey(project) {
    return canonicalProjectIdentity(project);
}
function defaultOpenCodeHome() {
    // Activity is user runtime state, not OpenCode configuration. Keeping it in
    // a stable per-user root makes two OpenCode processes for the same physical
    // repository share claims even when they use different config homes.
    // Node's test runner gets an isolated compatibility root so tests never
    // write into a developer's real home; NODE_TEST_CONTEXT is reserved by Node.
    if (process.env.AGENT_HARBOR_ACTIVITY_HOME) {
        return resolve(process.env.AGENT_HARBOR_ACTIVITY_HOME);
    }
    if (process.env.NODE_TEST_CONTEXT && process.env.OPENCODE_CONFIG_DIR) {
        return resolve(process.env.OPENCODE_CONFIG_DIR);
    }
    if (process.env.NODE_TEST_CONTEXT) {
        return resolve(join(tmpdir(), `agent-harbor-node-test-${process.pid}`));
    }
    return resolve(join(homedir(), ".agent-harbor"));
}
function projectDigest(project) {
    return createHash("sha256").update(projectKey(project), "utf8").digest("hex").slice(0, 40);
}
function contained(parent, child) {
    const root = resolve(parent);
    const target = resolve(child);
    const rel = relative(root, target);
    if (!rel || rel.startsWith("..") || isAbsolute(rel))
        throw new Error("unsafe OpenCode activity location");
    return target;
}
function identity(stat) {
    return { dev: stat.dev.toString(10), ino: stat.ino.toString(10) };
}
function sameIdentity(left, right) {
    return left.dev === right.dev && left.ino === right.ino;
}
function inspectDirectory(directory, privateMode) {
    const stat = lstatSync(directory, { bigint: true });
    if (stat.isSymbolicLink() || !stat.isDirectory())
        throw new Error("unsafe OpenCode activity directory");
    if (privateMode && process.platform !== "win32" && (stat.mode & 63n) !== 0n) {
        throw new Error("OpenCode activity directory permissions are too broad");
    }
    return {
        path: resolve(directory),
        canonical: resolve(realpathSync.native(directory)),
        privateMode,
        ...identity(stat),
    };
}
function ensureDirectory(directory, create, privateMode, recursive = false) {
    try {
        return inspectDirectory(directory, privateMode);
    }
    catch (error) {
        if (error?.code !== "ENOENT")
            throw error;
        if (!create)
            return undefined;
        try {
            mkdirSync(directory, { recursive, mode: 0o700 });
        }
        catch (mkdirError) {
            if (mkdirError?.code !== "EEXIST")
                throw mkdirError;
        }
        return inspectDirectory(directory, privateMode);
    }
}
function assertDirectoryBinding(paths) {
    let parent;
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
function claimPaths(project, create, storeDirectory = activityDirectory) {
    const home = defaultOpenCodeHome();
    const homeNode = ensureDirectory(home, create, false, true);
    if (!homeNode)
        return undefined;
    const owner = contained(home, join(home, activityOwnerDirectory));
    const ownerNode = ensureDirectory(owner, create, true);
    if (!ownerNode)
        return undefined;
    const activity = contained(owner, join(owner, storeDirectory));
    const activityNode = ensureDirectory(activity, create, true);
    if (!activityNode)
        return undefined;
    const digest = projectDigest(project);
    const directory = contained(activity, join(activity, digest));
    const projectNode = ensureDirectory(directory, create, true);
    if (!projectNode)
        return undefined;
    const paths = { project: digest, directory, storeDirectory, binding: [homeNode, ownerNode, activityNode, projectNode] };
    assertDirectoryBinding(paths);
    return paths;
}
function claimPath(directory, agent) {
    if (!activityIDPattern.test(agent))
        throw new Error("invalid OpenCode activity agent");
    return contained(directory, join(directory, `${agent}.json`));
}
function temporaryClaimPath(directory, token) {
    if (!tokenPattern.test(token))
        throw new Error("invalid OpenCode activity publication token");
    return contained(directory, join(directory, `.agent-harbor-activity-tmp-${token}`));
}
function validIdentity(value) {
    return typeof value === "string" && value.length > 0 && value.length <= maximumOpenCodeActivityIdentityBytes &&
        Buffer.byteLength(value, "utf8") <= maximumOpenCodeActivityIdentityBytes &&
        !/[\u0000-\u001f\u007f]/u.test(value);
}
function sessionSlot(value) {
    if (!validIdentity(value))
        throw new Error("invalid OpenCode activity session identity");
    const encoded = Buffer.from(value, "utf8").toString("base64url");
    if (encoded.length > encodedSessionSlotBytes)
        throw new Error("OpenCode activity session identity exceeds its encoded bound");
    return encoded.padEnd(encodedSessionSlotBytes, " ");
}
function decodeSessionSlot(value) {
    if (typeof value !== "string" || value.length !== encodedSessionSlotBytes) {
        throw new Error("invalid OpenCode activity session slot");
    }
    const encoded = value.trimEnd();
    if (!encoded || !/^[A-Za-z0-9_-]+$/u.test(encoded))
        throw new Error("invalid OpenCode activity session slot");
    const decoded = Buffer.from(encoded, "base64url").toString("utf8");
    if (!validIdentity(decoded) || Buffer.from(decoded, "utf8").toString("base64url") !== encoded) {
        throw new Error("invalid OpenCode activity session slot");
    }
    return decoded;
}
function parseClaim(value, expectedProject, expectedAgent) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("invalid Agent Harbor shared activity claim");
    const legacyKeys = [
        "version", "owner", "project", "agent", "kind", "phase", "slot", "sessionA", "sessionB",
        "startedAt", "processID", "claimToken",
    ];
    const currentKeys = [...legacyKeys, "ownerRuntime"];
    const keys = Object.keys(value);
    const version = value.version;
    const expectedKeys = version === 1 ? legacyKeys : version === 2 ? currentKeys : [];
    if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
        throw new Error("invalid Agent Harbor shared activity claim");
    }
    const claim = value;
    if (![1, 2].includes(typeof claim.version === "number" ? claim.version : 0) ||
        claim.owner !== "agent-harbor" || claim.project !== expectedProject ||
        claim.agent !== expectedAgent || typeof claim.agent !== "string" || !activityIDPattern.test(claim.agent) ||
        typeof claim.kind !== "string" || !["direct", "delegated"].includes(claim.kind) ||
        typeof claim.phase !== "string" || !["s", "w", "c"].includes(claim.phase) ||
        typeof claim.slot !== "string" || !["a", "b"].includes(claim.slot) ||
        !Number.isSafeInteger(claim.startedAt) || claim.startedAt < 0 ||
        !Number.isSafeInteger(claim.processID) || claim.processID <= 0 ||
        typeof claim.claimToken !== "string" || !tokenPattern.test(claim.claimToken) ||
        claim.version === 2 && (typeof claim.ownerRuntime !== "string" ||
            !["opencode", "pi", "copilot"].includes(claim.ownerRuntime))) {
        throw new Error("invalid Agent Harbor shared activity claim");
    }
    const stored = claim;
    const sessionID = decodeSessionSlot(stored.slot === "a" ? stored.sessionA : stored.sessionB);
    // Validate the inactive slot too: a malformed half-published update must fail closed.
    decodeSessionSlot(stored.slot === "a" ? stored.sessionB : stored.sessionA);
    return { claim: stored, sessionID };
}
function safeClaimStat(file) {
    const stat = lstatSync(file, { bigint: true });
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size <= 0n || stat.size > BigInt(maximumOpenCodeActivityClaimBytes) ||
        process.platform !== "win32" && (stat.mode & 63n) !== 0n) {
        throw new Error("unsafe Agent Harbor shared activity claim");
    }
    return stat;
}
function capacityLockPath(paths) {
    return contained(paths.directory, join(paths.directory, capacityLockName));
}
function temporaryCapacityLockPath(paths, token) {
    if (!tokenPattern.test(token))
        throw new Error("invalid OpenCode capacity-lock publication token");
    return contained(paths.directory, join(paths.directory, `.agent-harbor-capacity-tmp-${token}`));
}
function parseCapacityLock(value, expectedProject) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("invalid OpenCode activity capacity lock");
    const expectedKeys = ["version", "owner", "project", "processID", "startedAt", "claimToken"];
    const keys = Object.keys(value);
    if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
        throw new Error("invalid OpenCode activity capacity lock");
    }
    const lock = value;
    if (lock.version !== 1 || lock.owner !== "agent-harbor" || lock.project !== expectedProject ||
        !Number.isSafeInteger(lock.processID) || (lock.processID ?? 0) <= 0 ||
        !Number.isSafeInteger(lock.startedAt) || (lock.startedAt ?? -1) < 0 ||
        typeof lock.claimToken !== "string" || !tokenPattern.test(lock.claimToken)) {
        throw new Error("invalid OpenCode activity capacity lock");
    }
    return lock;
}
function readCapacityLock(paths, now = Date.now()) {
    const file = capacityLockPath(paths);
    for (let attempt = 0; attempt < 3; attempt += 1) {
        assertDirectoryBinding(paths);
        let before;
        try {
            before = safeClaimStat(file);
        }
        catch (error) {
            if (error?.code === "ENOENT")
                return undefined;
            throw error;
        }
        if (before.nlink !== 1n)
            throw new Error("OpenCode activity capacity-lock recovery is required");
        let descriptor;
        try {
            descriptor = openSync(file, constants.O_RDONLY | (process.platform === "win32"
                ? 0
                : (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)));
            const opened = fstatSync(descriptor, { bigint: true });
            if (!opened.isFile() || opened.size !== before.size || !sameIdentity(identity(opened), identity(before)))
                continue;
            const bytes = readFileSync(descriptor);
            const afterHandle = fstatSync(descriptor, { bigint: true });
            const afterPath = safeClaimStat(file);
            assertDirectoryBinding(paths);
            if (BigInt(bytes.length) !== before.size || !sameIdentity(identity(afterHandle), identity(before)) ||
                !sameIdentity(identity(afterPath), identity(before)) || afterHandle.mtimeNs !== before.mtimeNs ||
                afterPath.mtimeNs !== before.mtimeNs)
                continue;
            const encoded = bytes.toString("utf8");
            let parsed;
            try {
                parsed = JSON.parse(encoded);
            }
            catch {
                throw new Error("invalid OpenCode activity capacity lock");
            }
            const value = parseCapacityLock(parsed, paths.project);
            if (JSON.stringify(value) !== encoded)
                throw new Error("invalid OpenCode activity capacity lock");
            const ageMs = now - Number(before.mtimeMs);
            if (!Number.isFinite(ageMs) || ageMs < -5_000)
                throw new Error("invalid OpenCode activity capacity-lock timestamp");
            return { value, identity: identity(before), mtimeNs: before.mtimeNs.toString(10), ageMs };
        }
        catch (error) {
            if (error?.code === "ENOENT" && attempt < 2)
                continue;
            throw error;
        }
        finally {
            if (descriptor !== undefined)
                closeSync(descriptor);
        }
    }
    throw new Error("OpenCode activity capacity lock changed while being read");
}
function pauseCapacityContender(milliseconds) {
    const shared = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(shared, 0, 0, Math.max(1, milliseconds));
}
function acquireCapacityLock(paths) {
    const file = capacityLockPath(paths);
    const deadlineAt = Date.now() + openCodeCapacityLockDeadlineMs;
    for (;;) {
        const now = Date.now();
        const existing = readCapacityLock(paths, now);
        if (existing) {
            if (existing.ageMs > openCodeCapacityLockTtlMs && processDefinitelyExited(existing.value.processID)) {
                const confirmed = readCapacityLock(paths, now);
                if (!confirmed || confirmed.value.claimToken !== existing.value.claimToken ||
                    !sameIdentity(confirmed.identity, existing.identity) || confirmed.mtimeNs !== existing.mtimeNs ||
                    !removeOwnedPath(paths, file, confirmed.identity, confirmed.mtimeNs)) {
                    throw new Error("OpenCode activity capacity-lock recovery changed during cleanup");
                }
                continue;
            }
            if (existing.ageMs > openCodeCapacityLockTtlMs) {
                throw new Error(`Agent Harbor activity capacity lock is overdue but PID ${existing.value.processID} is live; ` +
                    "possible PID reuse cannot be reclaimed safely. Stop the owning process, or after proving no Agent Harbor work is active remove only the stale managed lock and retry");
            }
            if (now >= deadlineAt)
                throw new Error("OpenCode activity capacity lock is busy; retry the command");
            pauseCapacityContender(Math.min(10, deadlineAt - now));
            continue;
        }
        const claimToken = randomBytes(18).toString("base64url");
        const publicationToken = randomBytes(18).toString("base64url");
        const temporary = temporaryCapacityLockPath(paths, publicationToken);
        let descriptor;
        let lockIdentity;
        let published = false;
        try {
            descriptor = openSync(temporary, "wx", 0o600);
            const value = {
                version: 1,
                owner: "agent-harbor",
                project: paths.project,
                processID: process.pid,
                startedAt: now,
                claimToken,
            };
            const bytes = Buffer.from(JSON.stringify(value), "utf8");
            writeAll(descriptor, bytes);
            fsyncSync(descriptor);
            lockIdentity = identity(fstatSync(descriptor, { bigint: true }));
            assertDirectoryBinding(paths);
            linkSync(temporary, file);
            published = true;
            assertDirectoryBinding(paths);
            if (!pathHasIdentity(paths, file, lockIdentity) || !removeOwnedPath(paths, temporary, lockIdentity)) {
                throw new Error("OpenCode activity capacity-lock publication could not be verified");
            }
            closeSync(descriptor);
            descriptor = undefined;
            let released = false;
            return {
                ownsExact() {
                    if (released || !lockIdentity)
                        return false;
                    try {
                        const current = readCapacityLock(paths);
                        return current !== undefined && current.value.processID === process.pid &&
                            current.value.claimToken === claimToken && sameIdentity(current.identity, lockIdentity);
                    }
                    catch {
                        return false;
                    }
                },
                release() {
                    if (released)
                        return true;
                    let current;
                    try {
                        current = readCapacityLock(paths);
                    }
                    catch {
                        return false;
                    }
                    if (!current) {
                        released = true;
                        return true;
                    }
                    if (!lockIdentity || current.value.claimToken !== claimToken ||
                        !sameIdentity(current.identity, lockIdentity) ||
                        !removeOwnedPath(paths, file, lockIdentity, current.mtimeNs))
                        return false;
                    released = true;
                    return true;
                },
            };
        }
        catch (error) {
            if (descriptor !== undefined) {
                try {
                    closeSync(descriptor);
                }
                catch { /* preserve original failure */ }
            }
            if (lockIdentity) {
                removeOwnedPath(paths, temporary, lockIdentity);
                if (published)
                    removeOwnedPath(paths, file, lockIdentity);
            }
            if (error?.code === "EEXIST" && Date.now() < deadlineAt) {
                pauseCapacityContender(5);
                continue;
            }
            throw error;
        }
    }
}
function readClaim(paths, file, agent, now = Date.now()) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
        assertDirectoryBinding(paths);
        let before;
        try {
            before = safeClaimStat(file);
        }
        catch (error) {
            if (error?.code === "ENOENT")
                return undefined;
            throw error;
        }
        if (before.nlink !== 1n) {
            throw new Error("OpenCode activity publication recovery is required; a claim has multiple filesystem links");
        }
        let descriptor;
        try {
            descriptor = openSync(file, constants.O_RDONLY | (process.platform === "win32"
                ? 0
                : (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)));
            const opened = fstatSync(descriptor, { bigint: true });
            if (!opened.isFile() || opened.size !== before.size || !sameIdentity(identity(opened), identity(before)))
                continue;
            const bytes = readFileSync(descriptor);
            const afterHandle = fstatSync(descriptor, { bigint: true });
            const afterPath = safeClaimStat(file);
            assertDirectoryBinding(paths);
            if (BigInt(bytes.length) !== before.size || !sameIdentity(identity(afterHandle), identity(before)) ||
                !sameIdentity(identity(afterPath), identity(before)) || afterHandle.mtimeNs !== before.mtimeNs ||
                afterPath.mtimeNs !== before.mtimeNs)
                continue;
            const encoded = bytes.toString("utf8");
            let parsed;
            try {
                parsed = JSON.parse(encoded);
            }
            catch {
                throw new Error("invalid Agent Harbor shared activity claim");
            }
            const { claim, sessionID } = parseClaim(parsed, paths.project, agent);
            if (claim.version === 2 && (paths.storeDirectory === sharedActivityDirectory
                ? claim.ownerRuntime === "opencode"
                : claim.ownerRuntime !== "opencode")) {
                throw new Error("invalid Agent Harbor activity owner runtime for this namespace");
            }
            if (JSON.stringify(claim) !== encoded)
                throw new Error("invalid Agent Harbor shared activity claim");
            const age = now - Number(before.mtimeMs);
            if (!Number.isFinite(age) || age < -5_000)
                throw new Error("invalid Agent Harbor shared activity claim timestamp");
            return {
                snapshot: {
                    agent: claim.agent,
                    kind: claim.kind,
                    phase: phases[claim.phase],
                    startedAt: claim.startedAt,
                    sessionID,
                    processID: claim.processID,
                    claimToken: claim.claimToken,
                    ...(claim.version === 2 ? { ownerRuntime: claim.ownerRuntime } : {}),
                },
                fresh: age <= openCodeActivityTtlMs,
                identity: identity(before),
                mtimeNs: before.mtimeNs.toString(10),
            };
        }
        catch (error) {
            if (error?.code === "ENOENT" && attempt < 2)
                continue;
            throw error;
        }
        finally {
            if (descriptor !== undefined)
                closeSync(descriptor);
        }
    }
    throw new Error("Agent Harbor shared activity claim changed while being read");
}
function pathHasIdentity(paths, file, expected) {
    try {
        assertDirectoryBinding(paths);
        const current = safeClaimStat(file);
        return sameIdentity(identity(current), expected);
    }
    catch {
        return false;
    }
}
function removeOwnedPath(paths, file, expected, expectedMtimeNs) {
    try {
        assertDirectoryBinding(paths);
        const current = safeClaimStat(file);
        if (!sameIdentity(identity(current), expected) ||
            expectedMtimeNs !== undefined && current.mtimeNs.toString(10) !== expectedMtimeNs)
            return false;
        unlinkSync(file);
        assertDirectoryBinding(paths);
        return true;
    }
    catch (error) {
        if (error?.code === "ENOENT")
            return true;
        return false;
    }
}
function processDefinitelyExited(processID) {
    try {
        process.kill(processID, 0);
        return false;
    }
    catch (error) {
        // EPERM proves that a process owns the PID even when it cannot be signalled.
        return error?.code === "ESRCH";
    }
}
function removeExactClaim(paths, file, agent, expected, claimToken) {
    try {
        const current = readClaim(paths, file, agent);
        if (!current)
            return true;
        if (!sameIdentity(current.identity, expected) || current.snapshot.claimToken !== claimToken)
            return false;
        return removeOwnedPath(paths, file, expected, current.mtimeNs);
    }
    catch {
        return false;
    }
}
function ownsExactClaim(paths, file, agent, expected, claimToken) {
    try {
        const current = readClaim(paths, file, agent);
        return current !== undefined && sameIdentity(current.identity, expected) &&
            current.snapshot.claimToken === claimToken && current.snapshot.processID === process.pid;
    }
    catch {
        return false;
    }
}
function removeDefinitelyExitedClaim(paths, file, agent, observed, now, capacityLock) {
    if (!capacityLock.ownsExact())
        return false;
    const confirmed = readClaim(paths, file, agent, now);
    if (!confirmed)
        return capacityLock.ownsExact();
    if (confirmed.fresh || !processDefinitelyExited(confirmed.snapshot.processID) ||
        confirmed.snapshot.processID !== observed.snapshot.processID ||
        confirmed.snapshot.claimToken !== observed.snapshot.claimToken ||
        confirmed.mtimeNs !== observed.mtimeNs || !sameIdentity(confirmed.identity, observed.identity) ||
        !capacityLock.ownsExact() ||
        !removeOwnedPath(paths, file, confirmed.identity, confirmed.mtimeNs))
        return false;
    return capacityLock.ownsExact();
}
function projectClaimsWhileLocked(paths, includeStale, capacityLock) {
    if (!capacityLock.ownsExact())
        throw new Error("OpenCode activity capacity lock ownership changed before inventory recovery");
    assertDirectoryBinding(paths);
    const inventory = [];
    const directory = opendirSync(paths.directory);
    let inspected = 0;
    const now = Date.now();
    try {
        for (;;) {
            const entry = directory.readSync();
            if (!entry)
                break;
            if (temporaryClaimPattern.test(entry.name) || temporaryCapacityLockPattern.test(entry.name)) {
                // A publisher crashed before or after link(2). Never ignore that
                // partial/full or nlink=2 state: ownership requires explicit recovery.
                throw new Error("OpenCode activity publication recovery is required; a temporary claim remains");
            }
            if (entry.name === capacityLockName) {
                // The lock is transient serialization metadata, not an inventory
                // claim. Excluding this one exact owned entry keeps the 64-entry
                // safety bound intact for every claim/foreign entry while allowing a
                // full 64-claim dead inventory to be recovered under the lock.
                if (!capacityLock.ownsExact())
                    throw new Error("OpenCode activity capacity lock ownership changed during inventory recovery");
                continue;
            }
            inspected += 1;
            if (inspected > maximumOpenCodeActivityDirectoryEntries) {
                throw new Error("OpenCode activity inventory exceeds its directory-entry safety limit");
            }
            const match = /^([a-z0-9][a-z0-9-]{0,47})\.json$/u.exec(entry.name);
            if (!match || entry.isSymbolicLink() || !entry.isFile())
                throw new Error("unsafe OpenCode activity inventory entry");
            const file = claimPath(paths.directory, match[1]);
            const claim = readClaim(paths, file, match[1], now);
            if (claim)
                inventory.push({ agent: match[1], file, claim });
        }
    }
    finally {
        directory.closeSync();
    }
    assertDirectoryBinding(paths);
    if (!capacityLock.ownsExact())
        throw new Error("OpenCode activity capacity lock ownership changed after inventory read");
    const claims = [];
    for (const item of inventory) {
        const { claim } = item;
        if (!claim.fresh && processDefinitelyExited(claim.snapshot.processID)) {
            if (!removeDefinitelyExitedClaim(paths, item.file, item.agent, claim, now, capacityLock)) {
                throw new Error(`Agent Harbor player ${item.agent} has a dead stale activity claim that changed during cleanup`);
            }
            continue;
        }
        // A missed heartbeat is not proof that ownership ended. Keep a stale
        // claim visible/capacity-counted whenever PID death is not definite;
        // this includes live owners, permission ambiguity, and possible PID reuse.
        if (includeStale || claim.fresh || !processDefinitelyExited(claim.snapshot.processID))
            claims.push(claim);
    }
    if (!capacityLock.ownsExact())
        throw new Error("OpenCode activity capacity lock ownership changed after stale-claim recovery");
    return claims;
}
function projectClaims(project, includeStale, storeDirectory = activityDirectory, heldCapacityLock) {
    const paths = claimPaths(project, false, storeDirectory);
    if (!paths)
        return [];
    if (heldCapacityLock)
        return projectClaimsWhileLocked(paths, includeStale, heldCapacityLock);
    // Preserve the fast degraded-view signal for a live admission/mutation. A
    // definitely dead overdue lock instead flows through acquireCapacityLock,
    // whose exact double-read cleanup recovers it before this inventory scan.
    const existingLock = readCapacityLock(paths);
    if (existingLock && !(existingLock.ageMs > openCodeCapacityLockTtlMs &&
        processDefinitelyExited(existingLock.value.processID))) {
        if (existingLock.ageMs > openCodeCapacityLockTtlMs) {
            throw new Error(`Agent Harbor activity capacity lock is overdue but PID ${existingLock.value.processID} is live; ` +
                "possible PID reuse cannot be reclaimed safely. Stop the owning process, or after proving no Agent Harbor work is active remove only the stale managed lock and retry");
        }
        throw new Error("Agent Harbor persistent-player admission or roster mutation is in progress; retry the activity view");
    }
    const capacityLock = acquireCapacityLock(paths);
    let value;
    let failure;
    try {
        value = projectClaimsWhileLocked(paths, includeStale, capacityLock);
    }
    catch (error) {
        failure = error;
    }
    const released = capacityLock.release();
    if (failure !== undefined && !released) {
        throw new AggregateError([failure], "OpenCode activity inventory recovery and capacity-lock cleanup both failed");
    }
    if (failure !== undefined)
        throw failure;
    if (!released)
        throw new Error("OpenCode activity inventory recovered but capacity-lock cleanup could not be verified");
    return value;
}
function writeAll(descriptor, bytes, position = 0) {
    let offset = 0;
    while (offset < bytes.length) {
        const written = writeSync(descriptor, bytes, offset, bytes.length - offset, position + offset);
        if (written <= 0)
            throw new Error("Agent Harbor shared activity claim write made no progress");
        offset += written;
    }
}
function createOpenCodeAgentActivityClaim(project, agent, kind, sessionID, ownerRuntime, now = Date.now(), validateAdmission, storeDirectory = activityDirectory) {
    if (!activityIDPattern.test(agent) || !validIdentity(sessionID) || !["direct", "delegated"].includes(kind) ||
        !["opencode", "pi", "copilot"].includes(ownerRuntime) ||
        !Number.isSafeInteger(now) || now < 0) {
        throw new Error("invalid Agent Harbor shared activity claim input");
    }
    const paths = claimPaths(project, true, storeDirectory);
    const file = claimPath(paths.directory, agent);
    for (let attempt = 0; attempt < 2; attempt += 1) {
        const capacityLock = acquireCapacityLock(paths);
        let capacityReleased = false;
        const releaseCapacity = () => {
            if (capacityReleased)
                return true;
            const result = capacityLock.release();
            if (result)
                capacityReleased = true;
            return result;
        };
        let freshClaims;
        try {
            const existing = readClaim(paths, file, agent, now);
            if (existing) {
                // TTL is necessary but not sufficient: a suspended live process may
                // resume its heartbeat at any instant. Reclaim only after the owning PID
                // is definitely absent, then compare the exact token + mtime generation.
                if (existing.fresh) {
                    throw new Error(`Agent Harbor player ${agent} is busy in another direct or delegated run`);
                }
                if (!processDefinitelyExited(existing.snapshot.processID)) {
                    throw new Error(`Agent Harbor player ${agent} has an overdue activity heartbeat but PID ${existing.snapshot.processID} is live; ` +
                        "possible PID reuse cannot be reclaimed safely. Stop/recover the owning process, or after proving no Agent Harbor work is active remove only this stale managed claim and retry");
                }
                if (!capacityLock.ownsExact()) {
                    throw new Error("OpenCode activity capacity lock ownership changed before stale-claim cleanup");
                }
                const confirmed = readClaim(paths, file, agent, now);
                if (!confirmed || confirmed.fresh || !processDefinitelyExited(confirmed.snapshot.processID) ||
                    confirmed.snapshot.claimToken !== existing.snapshot.claimToken ||
                    !sameIdentity(confirmed.identity, existing.identity) ||
                    !capacityLock.ownsExact() ||
                    !removeOwnedPath(paths, file, confirmed.identity, confirmed.mtimeNs) ||
                    !capacityLock.ownsExact()) {
                    throw new Error(`Agent Harbor player ${agent} has a stale activity claim that changed during cleanup`);
                }
            }
            freshClaims = projectClaims(project, false, storeDirectory, capacityLock);
        }
        catch (error) {
            if (!releaseCapacity()) {
                throw new AggregateError([error], "OpenCode activity inventory and capacity-lock cleanup failed");
            }
            throw error;
        }
        if (kind === "direct" && freshClaims.some(({ snapshot }) => snapshot.kind === "direct" && snapshot.sessionID === sessionID)) {
            if (!releaseCapacity())
                throw new Error("OpenCode direct-session admission and capacity-lock cleanup both failed");
            throw new Error("Agent Harbor allows only one direct player claim per owning runtime session");
        }
        if (freshClaims.length >= maximumOpenCodeAgentActivitiesPerProject) {
            if (!releaseCapacity())
                throw new Error("OpenCode activity capacity-lock cleanup failed at the project limit");
            throw new Error(`Agent Harbor allows at most ${maximumOpenCodeAgentActivitiesPerProject} active runs per project; inspect /team page:1 and stop settled work in each listed owning runtime`);
        }
        const claimToken = randomBytes(18).toString("base64url");
        const publicationToken = randomBytes(18).toString("base64url");
        const temporary = temporaryClaimPath(paths.directory, publicationToken);
        let phase = "starting";
        let currentSessionID = sessionID;
        let activeSlot = "a";
        let released = false;
        let descriptor;
        let fileIdentity;
        let heartbeat;
        let ownershipLost = false;
        const ownershipLostListeners = new Set();
        let published = false;
        try {
            // This is deliberately the last roster/configuration check. The same
            // cross-process gate excludes destructive roster mutations until this
            // exact ownership generation is published.
            validateAdmission?.({
                activeClaimCount: freshClaims.length,
                maximumClaimCount: maximumOpenCodeAgentActivitiesPerProject,
            });
            descriptor = openSync(temporary, "wx", 0o600);
            const initialSlot = sessionSlot(sessionID);
            const stored = {
                version: 2,
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
                ownerRuntime,
            };
            const encoded = JSON.stringify(stored);
            const encodedBytes = Buffer.from(encoded, "utf8");
            if (encodedBytes.length > maximumOpenCodeActivityClaimBytes)
                throw new Error("Agent Harbor shared activity claim exceeds its safety bound");
            writeAll(descriptor, encodedBytes);
            fsyncSync(descriptor);
            const opened = fstatSync(descriptor, { bigint: true });
            fileIdentity = identity(opened);
            const markerOffset = (property, valueOffset) => {
                const marker = `"${property}":"`;
                const index = encoded.indexOf(marker);
                if (index < 0)
                    throw new Error(`OpenCode activity ${property} marker is unavailable`);
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
            if (!pathHasIdentity(paths, file, fileIdentity))
                throw new Error("OpenCode activity publication identity changed");
            if (!removeOwnedPath(paths, temporary, fileIdentity))
                throw new Error("OpenCode activity temporary publication cleanup failed");
            if (!releaseCapacity())
                throw new Error("OpenCode activity capacity-lock cleanup could not be verified");
            const beat = () => {
                if (released || descriptor === undefined || !fileIdentity)
                    return;
                const notifyOwnershipLost = () => {
                    if (ownershipLost || released)
                        return;
                    ownershipLost = true;
                    if (heartbeat) {
                        clearInterval(heartbeat);
                        heartbeat = undefined;
                    }
                    for (const listener of ownershipLostListeners) {
                        try {
                            listener();
                        }
                        catch { /* Ownership loss remains authoritative even if an observer fails. */ }
                    }
                    ownershipLostListeners.clear();
                };
                if (!ownsExactClaim(paths, file, agent, fileIdentity, claimToken)) {
                    notifyOwnershipLost();
                    return;
                }
                try {
                    const current = fstatSync(descriptor, { bigint: true });
                    if (!sameIdentity(identity(current), fileIdentity) || current.nlink !== 1n) {
                        notifyOwnershipLost();
                        return;
                    }
                    const time = new Date();
                    futimesSync(descriptor, time, time);
                }
                catch { /* A failed heartbeat becomes stale and remains fail-closed until TTL cleanup. */ }
            };
            heartbeat = setInterval(beat, openCodeActivityHeartbeatMs);
            heartbeat.unref?.();
            beat();
            const snapshot = () => ({
                agent, kind, phase, startedAt: now, sessionID: currentSessionID, processID: process.pid, claimToken,
                ownerRuntime,
            });
            return {
                get snapshot() { return snapshot(); },
                setSessionID(next) {
                    // The owner/lead identity may become the disposable child exactly
                    // while delegated work is starting. Once work is visible, freeze it
                    // so a later bug cannot retarget stop authorization.
                    if (released || descriptor === undefined || !fileIdentity || kind !== "delegated" ||
                        phase !== "starting" || !validIdentity(next) ||
                        !ownsExactClaim(paths, file, agent, fileIdentity, claimToken))
                        return false;
                    try {
                        if (next === currentSessionID) {
                            beat();
                            return true;
                        }
                        const inactive = activeSlot === "a" ? "b" : "a";
                        const bytes = Buffer.from(sessionSlot(next), "utf8");
                        writeAll(descriptor, bytes, inactive === "a" ? sessionAOffset : sessionBOffset);
                        fsyncSync(descriptor);
                        writeAll(descriptor, Buffer.from(inactive, "utf8"), slotOffset);
                        fsyncSync(descriptor);
                        const verified = readClaim(paths, file, agent);
                        const confirmed = verified?.snapshot.claimToken === claimToken && verified.snapshot.sessionID === next &&
                            sameIdentity(verified.identity, fileIdentity);
                        if (!confirmed)
                            return false;
                        activeSlot = inactive;
                        currentSessionID = next;
                        beat();
                        return true;
                    }
                    catch {
                        return false; /* The active slot still points to the last complete session identity. */
                    }
                },
                setPhase(next) {
                    // Direct OpenCode turns also need a durable reconciling/cleaning
                    // state when a session-scoped terminal cannot yet be tied to their
                    // exact message generation. A later native busy event may prove the
                    // turn is still live and restore working; delegated cleanup remains
                    // monotonic because its disposable child identity is exact.
                    const supportsCleaning = true;
                    const supportsDirectRecovery = kind === "direct" && storeDirectory === activityDirectory;
                    const transitionAllowed = next === phase || phase === "starting" &&
                        (next === "working" || supportsCleaning && next === "cleaning") ||
                        supportsCleaning && phase === "working" && next === "cleaning" ||
                        supportsDirectRecovery && phase === "cleaning" && next === "working";
                    if (released || descriptor === undefined || !fileIdentity || !Object.hasOwn(phaseCodes, next) ||
                        !transitionAllowed ||
                        !ownsExactClaim(paths, file, agent, fileIdentity, claimToken))
                        return false;
                    try {
                        writeAll(descriptor, Buffer.from(phaseCodes[next], "utf8"), phaseOffset);
                        fsyncSync(descriptor);
                        const verified = readClaim(paths, file, agent);
                        const confirmed = verified?.snapshot.claimToken === claimToken && verified.snapshot.phase === next &&
                            sameIdentity(verified.identity, fileIdentity);
                        if (!confirmed)
                            return false;
                        phase = next;
                        beat();
                        return true;
                    }
                    catch {
                        return false; /* Keep the last safely published phase and continue heartbeating the ownership claim. */
                    }
                },
                onOwnershipLost(listener) {
                    if (typeof listener !== "function")
                        throw new Error("invalid Agent Harbor activity ownership-loss listener");
                    if (ownershipLost) {
                        try {
                            listener();
                        }
                        catch { /* The loss state is already durable. */ }
                        return () => undefined;
                    }
                    ownershipLostListeners.add(listener);
                    return () => { ownershipLostListeners.delete(listener); };
                },
                release() {
                    if (released)
                        return true;
                    if (heartbeat) {
                        clearInterval(heartbeat);
                        heartbeat = undefined;
                    }
                    if (descriptor !== undefined) {
                        try {
                            closeSync(descriptor);
                        }
                        catch { /* already closed */ }
                        descriptor = undefined;
                    }
                    if (fileIdentity && !removeExactClaim(paths, file, agent, fileIdentity, claimToken))
                        return false;
                    released = true;
                    ownershipLostListeners.clear();
                    return true;
                },
            };
        }
        catch (error) {
            const lockReleased = releaseCapacity();
            if (heartbeat)
                clearInterval(heartbeat);
            if (descriptor !== undefined) {
                try {
                    closeSync(descriptor);
                }
                catch { /* preserve the original failure */ }
            }
            if (fileIdentity) {
                removeOwnedPath(paths, temporary, fileIdentity);
                if (published)
                    removeOwnedPath(paths, file, fileIdentity);
            }
            if (!lockReleased) {
                throw new AggregateError([error], "OpenCode activity publication and capacity-lock cleanup failed");
            }
            if (error?.code === "EEXIST" && attempt === 0)
                continue;
            throw error;
        }
    }
    throw new Error(`Agent Harbor player ${agent} is busy in another direct or delegated run`);
}
/** Atomically claims one player across OpenCode server/plugin isolates and OS processes. */
export function claimOpenCodeAgentActivity(project, agent, kind, sessionID, now = Date.now()) {
    return createOpenCodeAgentActivityClaim(project, agent, kind, sessionID, "opencode", now);
}
/** Claims only if the final live roster/configuration check still passes under the capacity gate. */
export function claimValidatedOpenCodeAgentActivity(project, agent, kind, sessionID, validateAdmission, now = Date.now()) {
    if (typeof validateAdmission !== "function")
        throw new Error("invalid OpenCode activity admission validation");
    return createOpenCodeAgentActivityClaim(project, agent, kind, sessionID, "opencode", now, validateAdmission);
}
/** Cross-process claim shared by Pi and Copilot without entering OpenCode's native-session inventory. */
export function claimSharedAgentActivity(project, agent, kind, runID, ownerRuntime, now = Date.now()) {
    return createOpenCodeAgentActivityClaim(project, agent, kind, runID, ownerRuntime, now, undefined, sharedActivityDirectory);
}
/** Shared claim whose final roster/configuration validation runs under the cross-process gate. */
export function claimValidatedSharedAgentActivity(project, agent, kind, runID, ownerRuntime, validateAdmission, now = Date.now()) {
    if (typeof validateAdmission !== "function")
        throw new Error("invalid shared activity admission validation");
    return createOpenCodeAgentActivityClaim(project, agent, kind, runID, ownerRuntime, now, validateAdmission, sharedActivityDirectory);
}
function destructiveRosterMutation(command, args) {
    if (command === "retire") {
        const target = args.trim();
        return isHarborId(target) ? { targets: [target], actionLabel: `retire ${target}` } : undefined;
    }
    if (command === "bench") {
        const match = /^off\s+(.+)$/u.exec(args.trim());
        if (!match)
            return undefined;
        const requested = match[1].split(/[\s,]+/u).filter(Boolean);
        const targets = requested.length === 1 && requested[0] === "all"
            ? [...bundledPlayers.keys()]
            : [...new Set(requested)];
        return targets.length && targets.every(isHarborId)
            ? { targets, actionLabel: `turn off ${targets.join(", ")}` }
            : undefined;
    }
    if (command === "join") {
        let candidate;
        try {
            candidate = JSON.parse(args);
        }
        catch {
            return undefined;
        }
        if (!candidate || typeof candidate !== "object" || Array.isArray(candidate))
            return undefined;
        const input = candidate;
        const target = typeof input.name === "string" ? input.name : undefined;
        return input.replace === true && isHarborId(target)
            ? { targets: [target], actionLabel: `replace ${target}` }
            : undefined;
    }
    return undefined;
}
/** Applies the activity gate only when an OpenCode command can remove/replace owned roster state. */
export function runOpenCodeRosterMutationGate(command, args, project, action, ignoredClaimToken) {
    const mutation = destructiveRosterMutation(command, args);
    return mutation
        ? withOpenCodeRosterMutationGate(project, mutation.targets, mutation.actionLabel, action, ignoredClaimToken)
        : action();
}
/**
 * Runs one destructive roster mutation while new activity admissions are
 * excluded. A specialist claim protects that member; manager/scout claims
 * conservatively protect the complete roster snapshot they may be using.
 */
export async function withOpenCodeRosterMutationGate(project, targets, actionLabel, action, ignoredClaimToken) {
    return withRosterMutationGate(project, targets, actionLabel, action, activityDirectory, ignoredClaimToken);
}
async function withRosterMutationGate(project, targets, actionLabel, action, storeDirectory, ignoredClaimToken) {
    const uniqueTargets = [...new Set(targets)];
    if (!uniqueTargets.length || uniqueTargets.length > maximumOpenCodeAgentActivitiesPerProject ||
        uniqueTargets.some((target) => !activityIDPattern.test(target)) ||
        typeof actionLabel !== "string" || !actionLabel || actionLabel.length > 200 ||
        typeof action !== "function") {
        throw new Error("invalid OpenCode roster-mutation gate input");
    }
    const paths = claimPaths(project, true, storeDirectory);
    const capacityLock = acquireCapacityLock(paths);
    let value;
    let failure;
    try {
        const claims = projectClaims(project, false, storeDirectory, capacityLock)
            .filter(({ snapshot }) => snapshot.claimToken !== ignoredClaimToken);
        const wildcard = claims.find(({ snapshot }) => snapshot.agent === "team-lead" || snapshot.agent === "talent-scout");
        const target = claims.find(({ snapshot }) => uniqueTargets.includes(snapshot.agent));
        if (wildcard) {
            throw new Error(`Agent Harbor cannot ${actionLabel} while ${wildcard.snapshot.agent} owns an active roster snapshot; inspect /team and stop that run first`);
        }
        if (target) {
            throw new Error(`Agent Harbor cannot ${actionLabel} while ${target.snapshot.agent} is ${target.snapshot.phase}; inspect /team and stop that run first`);
        }
        value = await action();
    }
    catch (error) {
        failure = error;
    }
    const released = capacityLock.release();
    if (failure !== undefined && !released) {
        throw new AggregateError([failure], "OpenCode roster mutation and activity-gate cleanup both failed");
    }
    if (failure !== undefined)
        throw failure;
    if (!released)
        throw new Error("OpenCode roster mutation succeeded but activity-gate cleanup could not be verified");
    return value;
}
/** Shared Pi/Copilot destructive-mutation gate; an exact owner may mutate for its own scout run. */
export function withSharedRosterMutationGate(project, targets, actionLabel, action, ignoredClaimToken) {
    return withRosterMutationGate(project, targets, actionLabel, action, sharedActivityDirectory, ignoredClaimToken);
}
/** Returns bounded claims that are fresh or whose owner PID is not definitely absent. */
export function readOpenCodeAgentActivities(project) {
    const claims = projectClaims(project, false);
    if (claims.length > maximumOpenCodeAgentActivitiesPerProject) {
        throw new Error("OpenCode activity inventory exceeds its active-claim safety limit");
    }
    return claims.map(({ snapshot, fresh }) => ({ ...snapshot, ...(fresh ? {} : { heartbeatOverdue: true }) }));
}
/** Private stop/recovery inventory; overdue claims remain observable unless exact dead-owner recovery succeeds. */
export function readOpenCodeAgentActivitiesIncludingStale(project) {
    return projectClaims(project, true)
        .map(({ snapshot, fresh }) => ({ ...snapshot, ...(fresh ? {} : { heartbeatOverdue: true }) }));
}
/** Bounded live claims shared across Pi and Copilot OS processes. */
export function readSharedAgentActivities(project) {
    const claims = projectClaims(project, false, sharedActivityDirectory);
    if (claims.length > maximumOpenCodeAgentActivitiesPerProject) {
        throw new Error("Agent Harbor shared activity inventory exceeds its active-claim safety limit");
    }
    return claims.map(({ snapshot, fresh }) => ({
        ...snapshot,
        ...(fresh ? {} : { heartbeatOverdue: true }),
    }));
}
