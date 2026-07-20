import { lstat, mkdir, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { trustedSkills } from "./defaults.js";
import { validateGithubSkill } from "./github.js";
const idPattern = /^[a-z0-9][a-z0-9-]{0,47}$/;
const reserved = new Set(["scout", "sage", "smith", "probe", "guard", "pilot", "team-lead", "repo-cartographer", "crafter", "bench", "join", "retire", "contract", "list-skills"]);
const allowedTools = new Set(["read", "search", "edit", "execute"]);
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
async function atomicWrite(path, content) {
    await mkdir(dirname(path), { recursive: true });
    const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
    try {
        await writeFile(temporary, content, typeof content === "string"
            ? { encoding: "utf8", flag: "wx", mode: 0o600 }
            : { flag: "wx", mode: 0o600 });
        await rename(temporary, path);
    }
    catch (error) {
        await rm(temporary, { force: true }).catch(() => undefined);
        throw error;
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
export function isOwnedProfile(content, id, expectedRoster) {
    if (!content?.startsWith("---\n"))
        return false;
    const end = content.indexOf("\n---\n", 4);
    if (end < 0 || !content.slice(end + 5).startsWith(`<!-- agent-foundry:profile id=${id} revision=3 -->\n`))
        return false;
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
        '  revision: "3"',
    ];
    if (lines.slice(-metadata.length).join("\n") !== metadata.join("\n"))
        return false;
    return metadata.every((expected) => lines.filter((line) => line === expected).length === 1) &&
        lines.filter((line) => line === "  roster: personal" || line === "  roster: sdlc").length === 1;
}
export function validatePlayer(value, allowReserved = false) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("expected one JSON object");
    const input = value;
    const keys = new Set(["name", "description", "prompt", "tools", "model", "replace", "skills"]);
    for (const key of Object.keys(input))
        if (!keys.has(key))
            throw new Error(`unknown key: ${key}`);
    if (typeof input.name !== "string" || !idPattern.test(input.name) || (!allowReserved && reserved.has(input.name)))
        throw new Error("invalid or reserved name");
    if (typeof input.description !== "string" || !input.description || /[\r\n]/.test(input.description))
        throw new Error("invalid description");
    if (typeof input.prompt !== "string" || !input.prompt.trim())
        throw new Error("invalid prompt");
    if (!Array.isArray(input.tools) || input.tools.length === 0 || input.tools.some((tool) => typeof tool !== "string" || !allowedTools.has(tool)))
        throw new Error("invalid tools");
    if (new Set(input.tools).size !== input.tools.length)
        throw new Error("duplicate tools");
    if (input.model !== undefined && typeof input.model !== "string")
        throw new Error("invalid model");
    if (input.replace !== undefined && typeof input.replace !== "boolean")
        throw new Error("invalid replace");
    if (input.skills !== undefined) {
        if (!Array.isArray(input.skills) || input.skills.length > 3)
            throw new Error("skills must be an array of at most three GitHub references");
        const seen = new Set();
        for (const value of input.skills) {
            const skill = validateGithubSkill(value);
            const identity = `${skill.repo}\0${skill.path}\0${skill.track}`;
            if (seen.has(identity))
                throw new Error("duplicate GitHub skill reference");
            if (!trustedSkills.some((trusted) => trusted.name === skill.name && trusted.repo.toLowerCase() === skill.repo.toLowerCase() && trusted.path === skill.path && trusted.track === skill.track))
                throw new Error("untrusted GitHub skill reference");
            seen.add(identity);
        }
        if (input.skills.length && !input.tools.includes("execute"))
            throw new Error("GitHub skills require execute");
    }
    return input;
}
export class Roster {
    spec;
    constructor(spec) {
        this.spec = spec;
    }
    rootFor(path) {
        for (const root of [this.spec.home, this.spec.project]) {
            const rel = relative(resolve(root), resolve(path));
            if (rel && !rel.startsWith("..") && !isAbsolute(rel))
                return root;
        }
        throw new Error(`unsafe transaction path: ${path}`);
    }
    async withMutationLock(action) {
        const path = contained(this.spec.home, join(this.spec.home, this.spec.registrationDir, ".roster.lock"));
        await rejectSymlinkTraversal(this.spec.home, path);
        await mkdir(dirname(path), { recursive: true });
        const token = randomUUID();
        const record = JSON.stringify({ owner: "agent-harbor", pid: process.pid, token });
        let handle;
        for (let attempt = 0; attempt < 200 && !handle; attempt += 1) {
            try {
                const candidate = await open(path, "wx", 0o600);
                try {
                    await candidate.writeFile(record, "utf8");
                    await candidate.sync();
                    handle = candidate;
                }
                catch (error) {
                    await candidate.close();
                    await rm(path, { force: true });
                    throw error;
                }
            }
            catch (error) {
                if (error?.code !== "EEXIST")
                    throw error;
                let lockStat;
                try {
                    lockStat = await lstat(path);
                }
                catch (probe) {
                    if (probe?.code === "ENOENT")
                        continue;
                    throw probe;
                }
                if (!lockStat.isFile() || lockStat.isSymbolicLink())
                    throw new Error(`unmanaged roster lock collision: ${path}`);
                const current = await existing(path);
                let owner;
                try {
                    owner = JSON.parse(current ?? "");
                }
                catch {
                    if (Date.now() - lockStat.mtimeMs < 1_000) {
                        await delay(25);
                        continue;
                    }
                    throw new Error(`unmanaged roster lock collision: ${path}`);
                }
                if (owner.owner !== "agent-harbor" || typeof owner.pid !== "number" || typeof owner.token !== "string")
                    throw new Error(`unmanaged roster lock collision: ${path}`);
                let alive = true;
                try {
                    process.kill(owner.pid, 0);
                }
                catch (probe) {
                    if (probe?.code === "ESRCH")
                        alive = false;
                }
                if (!alive) {
                    if ((await existing(path)) === current)
                        await rm(path, { force: true });
                    continue;
                }
                await delay(25);
            }
        }
        if (!handle)
            throw new Error("roster is busy; retry the operation");
        try {
            return await action();
        }
        finally {
            await handle.close();
            const lockStat = await lstat(path);
            if (!lockStat.isFile() || lockStat.isSymbolicLink())
                throw new Error(`roster lock ownership lost: ${path}`);
            if ((await existing(path)) !== record)
                throw new Error(`roster lock ownership lost: ${path}`);
            await rm(path, { force: true });
        }
    }
    async applyChange(change, _index) {
        try {
            if ((await lstat(change.path)).isSymbolicLink())
                throw new Error(`symlink traversal refused: ${change.path}`);
        }
        catch (error) {
            if (error?.code !== "ENOENT")
                throw error;
        }
        if (change.content === undefined)
            await rm(change.path, { force: true });
        else
            await atomicWrite(change.path, change.content);
    }
    async transaction(changes) {
        const before = await Promise.all(changes.map(async ({ path }) => {
            await rejectSymlinkTraversal(this.rootFor(path), path);
            return { path, content: await existingBytes(path) };
        }));
        try {
            for (const [index, change] of changes.entries()) {
                await rejectSymlinkTraversal(this.rootFor(change.path), change.path);
                await this.applyChange(change, index);
            }
            for (const change of changes) {
                await rejectSymlinkTraversal(this.rootFor(change.path), change.path);
                const actual = await existingBytes(change.path);
                const expected = change.content === undefined ? undefined : Buffer.from(change.content, "utf8");
                if (actual === undefined !== (expected === undefined) || (actual && expected && !actual.equals(expected)))
                    throw new Error(`verification failed: ${change.path}`);
            }
        }
        catch (error) {
            const rollbackErrors = [];
            for (const item of [...before].reverse()) {
                try {
                    await rejectSymlinkTraversal(this.rootFor(item.path), item.path);
                    try {
                        if ((await lstat(item.path)).isSymbolicLink())
                            await rm(item.path, { force: true });
                    }
                    catch (restoreError) {
                        if (restoreError?.code !== "ENOENT")
                            throw restoreError;
                    }
                    if (item.content === undefined)
                        await rm(item.path, { force: true });
                    else
                        await atomicWrite(item.path, item.content);
                }
                catch (restoreError) {
                    rollbackErrors.push(restoreError);
                }
            }
            if (rollbackErrors.length)
                throw new AggregateError([error, ...rollbackErrors], "mutation failed and rollback was incomplete");
            throw error;
        }
    }
    paths(id) {
        const registration = contained(this.spec.home, join(this.spec.home, this.spec.registrationDir, `${id}${this.spec.extension}`));
        const active = contained(this.spec.project, join(this.spec.project, this.spec.activeDir, `${id}${this.spec.extension}`));
        return { registration, active };
    }
    async join(input) {
        const player = validatePlayer(input);
        const content = this.spec.renderPlayer(player, "personal");
        if (content.length > 30_000)
            throw new Error("profile exceeds 30000 characters");
        return this.withMutationLock(async () => {
            const paths = this.paths(player.name);
            await Promise.all([rejectSymlinkTraversal(this.spec.home, paths.registration), rejectSymlinkTraversal(this.spec.project, paths.active)]);
            const current = await Promise.all([existing(paths.registration), existing(paths.active)]);
            for (const collision of current)
                if (collision !== undefined && !isOwnedProfile(collision, player.name, "personal"))
                    throw new Error("unmanaged collision");
            if (!player.replace && current.some((value) => value !== undefined && value !== content))
                throw new Error("replace:true required");
            await this.transaction([{ path: paths.registration, content }, { path: paths.active, content }]);
            return `joined ${player.name}\nregistration: ${paths.registration}\nactive: ${paths.active}`;
        });
    }
    async bench(args, bundled) {
        const value = args.trim();
        if (!value || value === "list" || value.startsWith("list ")) {
            const rows = [];
            const filter = value.startsWith("list ") ? value.slice(5).trim().toLowerCase() : "";
            for (const [id, definition] of bundled) {
                const { active } = this.paths(id);
                await rejectSymlinkTraversal(this.spec.project, active);
                const content = await existing(active);
                const canonical = this.spec.renderPlayer(definition, "sdlc");
                const state = content === undefined ? "bench" : !isOwnedProfile(content, id, "sdlc") ? "conflict" : content === canonical ? "on" : "stale";
                if (!filter || id.includes(filter))
                    rows.push(`${id} | bundled | ${state}`);
            }
            const registrationRoot = contained(this.spec.home, join(this.spec.home, this.spec.registrationDir));
            let entries = [];
            try {
                await rejectSymlinkTraversal(this.spec.home, join(registrationRoot, "placeholder"));
                entries = (await readdir(registrationRoot)).filter((filename) => filename.endsWith(this.spec.extension)).sort().slice(0, 200);
            }
            catch (error) {
                if (error?.code !== "ENOENT")
                    throw error;
            }
            for (const filename of entries) {
                const id = filename.slice(0, -this.spec.extension.length);
                if (!idPattern.test(id) || (filter && !id.includes(filter)))
                    continue;
                const paths = this.paths(id);
                await Promise.all([rejectSymlinkTraversal(this.spec.home, paths.registration), rejectSymlinkTraversal(this.spec.project, paths.active)]);
                const registration = await existing(paths.registration);
                const active = await existing(paths.active);
                if (!isOwnedProfile(registration, id, "personal")) {
                    rows.push(`${id} | personal | conflict`);
                    continue;
                }
                const state = active === undefined ? "bench" : !isOwnedProfile(active, id, "personal") ? "conflict" : active === registration ? "on" : "stale";
                rows.push(`${id} | personal | ${state}`);
            }
            return rows.join("\n");
        }
        const match = /^(on|off)\s+(.+)$/.exec(value);
        if (!match)
            throw new Error("usage: bench [list|on|off]");
        const ids = match[2].split(/[\s,]+/).filter(Boolean);
        const expanded = ids.length === 1 && ids[0] === "all" ? [...bundled.keys()] : [...new Set(ids)];
        if (!expanded.length || expanded.some((id) => !idPattern.test(id)))
            throw new Error("invalid player list");
        return this.withMutationLock(async () => {
            const changes = [];
            for (const id of expanded) {
                const paths = this.paths(id);
                await Promise.all([rejectSymlinkTraversal(this.spec.home, paths.registration), rejectSymlinkTraversal(this.spec.project, paths.active)]);
                const active = await existing(paths.active);
                const definition = bundled.get(id);
                const roster = definition ? "sdlc" : "personal";
                if (active !== undefined && !isOwnedProfile(active, id, roster))
                    throw new Error(`unmanaged collision: ${id}`);
                if (match[1] === "off") {
                    if (roster === "personal" && active !== undefined && !isOwnedProfile(await existing(paths.registration), id, "personal"))
                        throw new Error(`personal registration missing: ${id}`);
                    changes.push({ path: paths.active });
                    continue;
                }
                const source = definition ? this.spec.renderPlayer(definition, "sdlc") : await existing(paths.registration);
                if (!source || (!definition && !isOwnedProfile(source, id, "personal")))
                    throw new Error(`unknown player: ${id}`);
                changes.push({ path: paths.active, content: source });
            }
            await this.transaction(changes);
            return expanded.map((id) => `${id}: turned ${match[1]}`).join("\n");
        });
    }
    async retire(id) {
        if (!idPattern.test(id) || reserved.has(id))
            throw new Error("invalid personal player");
        return this.withMutationLock(async () => {
            const paths = this.paths(id);
            await Promise.all([rejectSymlinkTraversal(this.spec.home, paths.registration), rejectSymlinkTraversal(this.spec.project, paths.active)]);
            const registration = await existing(paths.registration);
            const active = await existing(paths.active);
            if (!isOwnedProfile(registration, id, "personal"))
                throw new Error("owned registration not found");
            if (active !== undefined && !isOwnedProfile(active, id, "personal"))
                throw new Error("unmanaged collision");
            await this.transaction([{ path: paths.registration }, { path: paths.active }]);
            return `retired ${id}; other projects intentionally untouched`;
        });
    }
}
