import { lstat, mkdir, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { HarnessSpec, PlayerDefinition } from "./types.js";
import { bundledPlayers, legacyBundledPlayerIds, trustedSkills } from "./defaults.js";
import { isTrustedGithubSkill } from "./github.js";
import { decodePlayer, isCanonicalPlayerProfile } from "./profiles.js";
import { validateSkillReference } from "./skills.js";

const idPattern = /^[a-z0-9][a-z0-9-]{0,47}$/;
const legacyBundledIds = new Set<string>(legacyBundledPlayerIds);
const reserved = new Set([...bundledPlayers.keys(), ...legacyBundledPlayerIds, "team-lead", "repo-cartographer", "crafter", "bench", "join", "retire", "contract", "list-skills"]);
const allowedTools = new Set(["read", "search", "edit", "execute"]);

function contained(parent: string, child: string): string {
  const root = resolve(parent);
  const target = resolve(child);
  const rel = relative(root, target);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) throw new Error(`unsafe path: ${target}`);
  return target;
}

async function existingBytes(path: string): Promise<Buffer | undefined> {
  try { return await readFile(path); } catch (error: any) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

async function existing(path: string): Promise<string | undefined> {
  return (await existingBytes(path))?.toString("utf8");
}

async function atomicWrite(path: string, content: string | Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, content, typeof content === "string"
      ? { encoding: "utf8", flag: "wx", mode: 0o600 }
      : { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function rejectSymlinkTraversal(root: string, target: string): Promise<void> {
  const parent = resolve(root);
  const rel = relative(parent, resolve(target));
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) throw new Error(`unsafe path: ${target}`);
  let cursor = parent;
  for (const segment of ["", ...rel.split(/[\\/]+/)]) {
    if (segment) cursor = join(cursor, segment);
    try { if ((await lstat(cursor)).isSymbolicLink()) throw new Error(`symlink traversal refused: ${cursor}`); }
    catch (error: any) { if (error?.code === "ENOENT") return; throw error; }
  }
}

function ownedProfileRevision(content: string | undefined, id: string, expectedRoster?: "personal" | "sdlc"): "3" | "4" | undefined {
  if (!content?.startsWith("---\n")) return undefined;
  const end = content.indexOf("\n---\n", 4);
  if (end < 0) return undefined;
  const marker = /^<!-- agent-foundry:profile id=([a-z0-9-]+) revision=(3|4) -->\n/.exec(content.slice(end + 5));
  if (!marker || marker[1] !== id) return undefined;
  const revision = marker[2] as "3" | "4";
  const lines = content.slice(4, end).split("\n");
  if (lines.filter((line) => line === `name: ${JSON.stringify(id)}`).length !== 1) return undefined;
  const roster = expectedRoster ?? (lines.includes("  roster: personal") ? "personal" : lines.includes("  roster: sdlc") ? "sdlc" : undefined);
  if (!roster) return undefined;
  const metadata = [
    "metadata:",
    "  owner: agent-foundry",
    `  roster: ${roster}`,
    `  player: ${JSON.stringify(id)}`,
    `  revision: "${revision}"`,
  ];
  if (lines.slice(-metadata.length).join("\n") !== metadata.join("\n")) return undefined;
  return metadata.every((expected) => lines.filter((line) => line === expected).length === 1) &&
    lines.filter((line) => line === "  roster: personal" || line === "  roster: sdlc").length === 1
    ? revision
    : undefined;
}

export function isOwnedProfile(content: string | undefined, id: string, expectedRoster?: "personal" | "sdlc"): boolean {
  return ownedProfileRevision(content, id, expectedRoster) !== undefined;
}

export function validatePlayer(value: unknown, allowReserved = false): PlayerDefinition {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("expected one JSON object");
  const input = value as Record<string, unknown>;
  const keys = new Set(["name", "description", "prompt", "tools", "model", "replace", "skills"]);
  for (const key of Object.keys(input)) if (!keys.has(key)) throw new Error(`unknown key: ${key}`);
  if (typeof input.name !== "string" || !idPattern.test(input.name) || (!allowReserved && reserved.has(input.name))) throw new Error("invalid or reserved name");
  if (typeof input.description !== "string" || !input.description || /[\r\n]/.test(input.description)) throw new Error("invalid description");
  if (typeof input.prompt !== "string" || !input.prompt.trim()) throw new Error("invalid prompt");
  if (!Array.isArray(input.tools) || (!allowReserved && input.tools.length === 0) || input.tools.some((tool) => typeof tool !== "string" || !allowedTools.has(tool))) throw new Error("invalid tools");
  if (new Set(input.tools).size !== input.tools.length) throw new Error("duplicate tools");
  if (input.model !== undefined && typeof input.model !== "string") throw new Error("invalid model");
  if (input.replace !== undefined && typeof input.replace !== "boolean") throw new Error("invalid replace");
  if (input.skills !== undefined) {
    if (!Array.isArray(input.skills) || input.skills.length > 3) throw new Error("skills must be an array of at most three repository or GitHub references");
    const seenIdentities = new Set<string>();
    const seenNames = new Set<string>();
    for (const value of input.skills) {
      const skill = validateSkillReference(value);
      const identity = skill.kind === "repo"
        ? `repo\0${skill.path}`
        : `github\0${skill.repo.toLowerCase()}\0${skill.path}\0${skill.track}`;
      if (seenIdentities.has(identity)) throw new Error("duplicate skill reference");
      if (seenNames.has(skill.name)) throw new Error(`duplicate configured skill name: ${skill.name}`);
      if (skill.kind === "github" && !isTrustedGithubSkill(skill, trustedSkills)) throw new Error("untrusted GitHub skill reference");
      seenIdentities.add(identity);
      seenNames.add(skill.name);
    }
    if (input.skills.length && !(input.tools as string[]).includes("read")) throw new Error("configured skills require read");
  }
  return input as unknown as PlayerDefinition;
}

export class Roster {
  constructor(private readonly spec: HarnessSpec) {}

  private rootFor(path: string): string {
    for (const root of [this.spec.home, this.spec.project]) {
      const rel = relative(resolve(root), resolve(path));
      if (rel && !rel.startsWith("..") && !isAbsolute(rel)) return root;
    }
    throw new Error(`unsafe transaction path: ${path}`);
  }

  private async withMutationLock<T>(action: () => Promise<T>): Promise<T> {
    const path = contained(this.spec.home, join(this.spec.home, this.spec.registrationDir, ".roster.lock"));
    await rejectSymlinkTraversal(this.spec.home, path);
    await mkdir(dirname(path), { recursive: true });
    const token = randomUUID();
    const record = JSON.stringify({ owner: "agent-harbor", pid: process.pid, token });
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    for (let attempt = 0; attempt < 200 && !handle; attempt += 1) {
      try {
        const candidate = await open(path, "wx", 0o600);
        try { await candidate.writeFile(record, "utf8"); await candidate.sync(); handle = candidate; }
        catch (error) { await candidate.close(); await rm(path, { force: true }); throw error; }
      } catch (error: any) {
        if (error?.code !== "EEXIST") throw error;
        let lockStat: Awaited<ReturnType<typeof lstat>>;
        try { lockStat = await lstat(path); }
        catch (probe: any) { if (probe?.code === "ENOENT") continue; throw probe; }
        if (!lockStat.isFile() || lockStat.isSymbolicLink()) throw new Error(`unmanaged roster lock collision: ${path}`);
        const current = await existing(path);
        let owner: { owner?: unknown; pid?: unknown; token?: unknown };
        try { owner = JSON.parse(current ?? ""); }
        catch {
          if (Date.now() - lockStat.mtimeMs < 1_000) { await delay(25); continue; }
          throw new Error(`unmanaged roster lock collision: ${path}`);
        }
        if (owner.owner !== "agent-harbor" || typeof owner.pid !== "number" || typeof owner.token !== "string") throw new Error(`unmanaged roster lock collision: ${path}`);
        let alive = true;
        try { process.kill(owner.pid, 0); } catch (probe: any) { if (probe?.code === "ESRCH") alive = false; }
        if (!alive) {
          if ((await existing(path)) === current) await rm(path, { force: true });
          continue;
        }
        await delay(25);
      }
    }
    if (!handle) throw new Error("roster is busy; retry the operation");
    try { return await action(); }
    finally {
      await handle.close();
      const lockStat = await lstat(path);
      if (!lockStat.isFile() || lockStat.isSymbolicLink()) throw new Error(`roster lock ownership lost: ${path}`);
      if ((await existing(path)) !== record) throw new Error(`roster lock ownership lost: ${path}`);
      await rm(path, { force: true });
    }
  }

  protected async applyChange(change: { path: string; content?: string }, _index: number): Promise<void> {
    try { if ((await lstat(change.path)).isSymbolicLink()) throw new Error(`symlink traversal refused: ${change.path}`); }
    catch (error: any) { if (error?.code !== "ENOENT") throw error; }
    if (change.content === undefined) await rm(change.path, { force: true });
    else await atomicWrite(change.path, change.content);
  }

  private async transaction(changes: Array<{ path: string; content?: string }>): Promise<void> {
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
        if (actual === undefined !== (expected === undefined) || (actual && expected && !actual.equals(expected))) throw new Error(`verification failed: ${change.path}`);
      }
    } catch (error) {
      const rollbackErrors: unknown[] = [];
      for (const item of [...before].reverse()) {
        try {
          await rejectSymlinkTraversal(this.rootFor(item.path), item.path);
          try { if ((await lstat(item.path)).isSymbolicLink()) await rm(item.path, { force: true }); }
          catch (restoreError: any) { if (restoreError?.code !== "ENOENT") throw restoreError; }
          if (item.content === undefined) await rm(item.path, { force: true });
          else await atomicWrite(item.path, item.content);
        } catch (restoreError) { rollbackErrors.push(restoreError); }
      }
      if (rollbackErrors.length) throw new AggregateError([error, ...rollbackErrors], "mutation failed and rollback was incomplete");
      throw error;
    }
  }

  private paths(id: string) {
    const registration = contained(this.spec.home, join(this.spec.home, this.spec.registrationDir, `${id}${this.spec.extension}`));
    const active = contained(this.spec.project, join(this.spec.project, this.spec.activeDir, `${id}${this.spec.extension}`));
    return { registration, active };
  }

  async join(input: unknown): Promise<string> {
    const player = validatePlayer(input);
    const content = this.spec.renderPlayer(player, "personal");
    if (content.length > 30_000) throw new Error("profile exceeds 30000 characters");
    return this.withMutationLock(async () => {
      const paths = this.paths(player.name);
      await Promise.all([rejectSymlinkTraversal(this.spec.home, paths.registration), rejectSymlinkTraversal(this.spec.project, paths.active)]);
      const current = await Promise.all([existing(paths.registration), existing(paths.active)]);
      for (const collision of current) if (collision !== undefined && !isOwnedProfile(collision, player.name, "personal")) throw new Error("unmanaged collision");
      if (!player.replace && current.some((value) => value !== undefined &&
          !isCanonicalPlayerProfile(value, this.spec.name, player, "personal", this.spec.project))) {
        throw new Error("replace:true required");
      }
      await this.transaction([{ path: paths.registration, content }, { path: paths.active, content }]);
      return `joined ${player.name}\nregistration: ${paths.registration}\nactive: ${paths.active}`;
    });
  }

  async bench(args: string, bundled: ReadonlyMap<string, PlayerDefinition>): Promise<string> {
    const value = args.trim();
    if (!value || value === "list" || value.startsWith("list ")) {
      const rows: string[] = [];
      const filter = value.startsWith("list ") ? value.slice(5).trim().toLowerCase() : "";
      for (const [id, definition] of bundled) {
        const { active } = this.paths(id);
        await rejectSymlinkTraversal(this.spec.project, active);
        const content = await existing(active);
        const state = content === undefined
          ? "bench"
          : !isOwnedProfile(content, id, "sdlc") ? "conflict"
            : isCanonicalPlayerProfile(content, this.spec.name, definition, "sdlc", this.spec.project) ? "on" : "stale";
        if (!filter || id.includes(filter)) rows.push(`${id} | bundled | ${state}`);
      }
      for (const id of legacyBundledPlayerIds) {
        if (bundled.has(id) || (filter && !id.includes(filter))) continue;
        const { active } = this.paths(id);
        await rejectSymlinkTraversal(this.spec.project, active);
        const content = await existing(active);
        if (content === undefined) continue;
        const state = isOwnedProfile(content, id, "sdlc") ? "retired-active" : "conflict";
        rows.push(`${id} | legacy | ${state}`);
      }
      const registrationRoot = contained(this.spec.home, join(this.spec.home, this.spec.registrationDir));
      let entries: string[] = [];
      try {
        await rejectSymlinkTraversal(this.spec.home, join(registrationRoot, "placeholder"));
        entries = (await readdir(registrationRoot)).filter((filename) => filename.endsWith(this.spec.extension)).sort().slice(0, 200);
      } catch (error: any) { if (error?.code !== "ENOENT") throw error; }
      for (const filename of entries) {
        const id = filename.slice(0, -this.spec.extension.length);
        if (!idPattern.test(id) || (filter && !id.includes(filter))) continue;
        const paths = this.paths(id);
        await Promise.all([rejectSymlinkTraversal(this.spec.home, paths.registration), rejectSymlinkTraversal(this.spec.project, paths.active)]);
        const registration = await existing(paths.registration); const active = await existing(paths.active);
        const registrationRevision = ownedProfileRevision(registration, id, "personal");
        if (!registrationRevision) { rows.push(`${id} | personal | conflict`); continue; }
        const activeRevision = ownedProfileRevision(active, id, "personal");
        let definition: PlayerDefinition | undefined;
        if (registrationRevision === "4") {
          try { definition = validatePlayer(decodePlayer(registration!, id)); }
          catch { definition = undefined; }
        }
        const state = active !== undefined && !activeRevision
          ? "conflict"
          : !definition || (active !== undefined && !isCanonicalPlayerProfile(active, this.spec.name, definition, "personal", this.spec.project))
            ? "stale"
            : active === undefined ? "bench" : "on";
        rows.push(`${id} | personal | ${state}`);
      }
      return rows.join("\n");
    }
    const match = /^(on|off)\s+(.+)$/.exec(value);
    if (!match) throw new Error("usage: bench [list|on|off]");
    const ids = match[2].split(/[\s,]+/).filter(Boolean);
    const expanded = ids.length === 1 && ids[0] === "all" ? [...bundled.keys()] : [...new Set(ids)];
    if (!expanded.length || expanded.some((id) => !idPattern.test(id))) throw new Error("invalid player list");
    return this.withMutationLock(async () => {
      const changes: Array<{ path: string; content?: string }> = [];
      const cleanedLegacy: string[] = [];
      for (const id of expanded) {
        const paths = this.paths(id);
        await Promise.all([rejectSymlinkTraversal(this.spec.home, paths.registration), rejectSymlinkTraversal(this.spec.project, paths.active)]);
        const active = await existing(paths.active);
        const definition = bundled.get(id);
        const legacy = !definition && legacyBundledIds.has(id);
        const roster = definition || legacy ? "sdlc" : "personal";
        if (active !== undefined && !isOwnedProfile(active, id, roster)) throw new Error(`unmanaged collision: ${id}`);
        if (match[1] === "off") {
          if (roster === "personal" && active !== undefined && !isOwnedProfile(await existing(paths.registration), id, "personal")) throw new Error(`personal registration missing: ${id}`);
          changes.push({ path: paths.active }); continue;
        }
        if (legacy) throw new Error(`retired bundled player: ${id}; use bench off ${id}`);
        const registration = definition ? undefined : await existing(paths.registration);
        if (!definition && (!registration || !isOwnedProfile(registration, id, "personal"))) throw new Error(`unknown player: ${id}`);
        if (!definition && ownedProfileRevision(registration, id, "personal") !== "4") {
          throw new Error(`stale personal profile: ${id}; re-run join with replace:true`);
        }
        let source: string;
        try {
          source = definition
            ? this.spec.renderPlayer(definition, "sdlc")
            : this.spec.renderPlayer(validatePlayer(decodePlayer(registration!, id)), "personal");
        } catch {
          throw new Error(`stale personal profile: ${id}; re-run join with replace:true`);
        }
        changes.push({ path: paths.active, content: source });
      }
      if (expanded.some((id) => bundled.has(id))) {
        for (const id of legacyBundledPlayerIds) {
          if (bundled.has(id) || expanded.includes(id)) continue;
          const { active } = this.paths(id);
          await rejectSymlinkTraversal(this.spec.project, active);
          const content = await existing(active);
          if (content === undefined) continue;
          if (!isOwnedProfile(content, id, "sdlc")) throw new Error(`unmanaged legacy collision: ${id}`);
          changes.push({ path: active });
          cleanedLegacy.push(id);
        }
      }
      await this.transaction(changes);
      return [
        ...expanded.map((id) => `${id}: turned ${match[1]}`),
        ...cleanedLegacy.map((id) => `${id}: retired legacy profile removed`),
      ].join("\n");
    });
  }

  async retire(id: string): Promise<string> {
    if (!idPattern.test(id) || reserved.has(id)) throw new Error("invalid personal player");
    return this.withMutationLock(async () => {
      const paths = this.paths(id);
      await Promise.all([rejectSymlinkTraversal(this.spec.home, paths.registration), rejectSymlinkTraversal(this.spec.project, paths.active)]);
      const registration = await existing(paths.registration); const active = await existing(paths.active);
      if (!isOwnedProfile(registration, id, "personal")) throw new Error("owned registration not found");
      if (active !== undefined && !isOwnedProfile(active, id, "personal")) throw new Error("unmanaged collision");
      await this.transaction([{ path: paths.registration }, { path: paths.active }]);
      return `retired ${id}; other projects intentionally untouched`;
    });
  }
}
