/**
 * Persistent roster lifecycle with ownership-aware collision handling and transactional updates.
 * Registration lives under the user's harness home while active profiles live in one project;
 * mutations coordinate both locations without overwriting or deleting unmanaged files.
 */

import { lstat, mkdir, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { HarnessSpec, PlayerDefinition } from "./types.js";
import { bundledPlayers, trustedSkills } from "./defaults.js";
import { isHarborId } from "./identity.js";
import { decodePlayer, isCanonicalPlayerProfile } from "./profiles.js";
import { validateConfiguredSkillReferences } from "./skills.js";

const reserved = new Set([...bundledPlayers.keys(), "team-lead", "crafter", "talent-scout", "bench", "join", "retire", "contract", "list-skills", "scout"]);
const allowedTools = new Set(["read", "search", "edit", "execute"]);

type BenchAction = "on" | "off";
type BenchCommand =
  | { kind: "list"; filter: string }
  | { kind: "mutate"; action: BenchAction; ids: string[] };
type BenchChange = { path: string; content?: string };
type BenchInventoryRow = { id: string; roster: "bundled" | "personal"; state: string };

/** Parses bench syntax without touching roster state or the filesystem. */
function parseBenchCommand(args: string, bundled: ReadonlyMap<string, PlayerDefinition>): BenchCommand {
  const value = args.trim();
  if (!value || value === "list" || value.startsWith("list ")) {
    return { kind: "list", filter: value.startsWith("list ") ? value.slice(5).trim().toLowerCase() : "" };
  }
  const match = /^(on|off)\s+(.+)$/.exec(value);
  if (!match) throw new Error("usage: bench [list|on|off]");
  const requested = match[2].split(/[\s,]+/).filter(Boolean);
  const ids = requested.length === 1 && requested[0] === "all" ? [...bundled.keys()] : [...new Set(requested)];
  if (!ids.length || ids.some((id) => !isHarborId(id))) throw new Error("invalid player list");
  return { kind: "mutate", action: match[1] as BenchAction, ids };
}

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

// Ownership is intentionally narrower than validity: this recognizes only the current structural
// marker and trailing metadata emitted by Agent Harbor.
export function isOwnedProfile(content: string | undefined, id: string, expectedRoster?: "personal" | "sdlc"): boolean {
  if (!content?.startsWith("---\n")) return false;
  const end = content.indexOf("\n---\n", 4);
  if (end < 0) return false;
  const marker = /^<!-- agent-foundry:profile id=([a-z0-9-]+) revision=4 -->\n/.exec(content.slice(end + 5));
  if (!marker || marker[1] !== id) return false;
  const lines = content.slice(4, end).split("\n");
  if (lines.filter((line) => line === `name: ${JSON.stringify(id)}`).length !== 1) return false;
  const roster = expectedRoster ?? (lines.includes("  roster: personal") ? "personal" : lines.includes("  roster: sdlc") ? "sdlc" : undefined);
  if (!roster) return false;
  const metadata = [
    "metadata:",
    "  owner: agent-foundry",
    `  roster: ${roster}`,
    `  player: ${JSON.stringify(id)}`,
    '  revision: "4"',
  ];
  if (lines.slice(-metadata.length).join("\n") !== metadata.join("\n")) return false;
  return metadata.every((expected) => lines.filter((line) => line === expected).length === 1) &&
    lines.filter((line) => line === "  roster: personal" || line === "  roster: sdlc").length === 1;
}

/**
 * Strictly validates an external player definition and returns its typed form.
 * Unknown keys, duplicate capabilities, reserved names, untrusted GitHub skills, and skill-bearing
 * definitions without read access are rejected before any filesystem mutation occurs.
 */
export function validatePlayer(value: unknown, allowReserved = false): PlayerDefinition {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("expected one JSON object");
  const input = value as Record<string, unknown>;
  const keys = new Set(["name", "description", "prompt", "tools", "model", "replace", "skills"]);
  for (const key of Object.keys(input)) if (!keys.has(key)) throw new Error(`unknown key: ${key}`);
  if (!isHarborId(input.name) || (!allowReserved && reserved.has(input.name))) throw new Error("invalid or reserved name");
  if (typeof input.description !== "string" || !input.description || /[\r\n]/.test(input.description)) throw new Error("invalid description");
  if (typeof input.prompt !== "string" || !input.prompt.trim()) throw new Error("invalid prompt");
  if (!Array.isArray(input.tools) || (!allowReserved && input.tools.length === 0) || input.tools.some((tool) => typeof tool !== "string" || !allowedTools.has(tool))) throw new Error("invalid tools");
  if (new Set(input.tools).size !== input.tools.length) throw new Error("duplicate tools");
  if (input.model !== undefined && typeof input.model !== "string") throw new Error("invalid model");
  if (input.replace !== undefined && typeof input.replace !== "boolean") throw new Error("invalid replace");
  if (input.skills !== undefined) validateConfiguredSkillReferences(input.skills, input.tools as string[], trustedSkills);
  return input as unknown as PlayerDefinition;
}

/**
 * Owns deterministic join, bench, and retire operations for one harness/project pair.
 * Every mutation is serialized by the home-scoped roster lock and committed across registration
 * and active paths as a verified transaction with best-effort full rollback.
 */
export class Roster {
  /** Binds lifecycle operations to one harness's home, project, layout, and renderer. */
  constructor(private readonly spec: HarnessSpec) {}

  private rootFor(path: string): string {
    for (const root of [this.spec.home, this.spec.project]) {
      const rel = relative(resolve(root), resolve(path));
      if (rel && !rel.startsWith("..") && !isAbsolute(rel)) return root;
    }
    throw new Error(`unsafe transaction path: ${path}`);
  }

  // The lock is shared through the harness home, so concurrent projects cannot race updates to the
  // same persistent registration. `wx` provides exclusive acquisition. A dead owner's lock is removed
  // only after its structured ownership record is re-read unchanged; foreign or malformed locks are
  // collisions, never cleanup candidates. Release likewise verifies the token before deleting the file.
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
        catch (lockError: any) { if (lockError?.code === "ENOENT") continue; throw lockError; }
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
        try { process.kill(owner.pid, 0); } catch (signalError: any) { if (signalError?.code === "ESRCH") alive = false; }
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

  /** Applies one transaction step; protected to support failure injection without weakening checks. */
  protected async applyChange(change: { path: string; content?: string }, _index: number): Promise<void> {
    try { if ((await lstat(change.path)).isSymbolicLink()) throw new Error(`symlink traversal refused: ${change.path}`); }
    catch (error: any) { if (error?.code !== "ENOENT") throw error; }
    if (change.content === undefined) await rm(change.path, { force: true });
    else await atomicWrite(change.path, change.content);
  }

  // Snapshot exact bytes before writing, apply in declared order, then verify every destination byte.
  // Any failure restores snapshots in reverse order. Rollback failures are retained alongside the
  // original error so callers are never told that an incomplete restoration succeeded.
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

  /**
   * Validates and joins a personal player by writing identical registration and active profiles.
   * Unmanaged collisions are never replaced. A differing owned profile requires `replace: true`,
   * and both files either verify successfully or are restored to their prior exact bytes.
   */
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
      return `joined ${player.name}\ncommand: /${player.name} <request>\nregistration: ${paths.registration}\nactive: ${paths.active}`;
    });
  }

  private async bundledBenchInventory(
    bundled: ReadonlyMap<string, PlayerDefinition>,
    filter: string,
  ): Promise<BenchInventoryRow[]> {
    const rows: BenchInventoryRow[] = [];
    for (const [id, definition] of bundled) {
      const { active } = this.paths(id);
      await rejectSymlinkTraversal(this.spec.project, active);
      const content = await existing(active);
      const state = content === undefined
        ? "bench"
        : !isOwnedProfile(content, id, "sdlc") ? "conflict"
          : isCanonicalPlayerProfile(content, this.spec.name, definition, "sdlc", this.spec.project) ? "on" : "stale";
      if (!filter || id.includes(filter)) rows.push({ id, roster: "bundled", state });
    }
    return rows;
  }

  private async registrationEntries(): Promise<string[]> {
    const registrationRoot = contained(this.spec.home, join(this.spec.home, this.spec.registrationDir));
    try {
      await rejectSymlinkTraversal(this.spec.home, join(registrationRoot, "placeholder"));
      return (await readdir(registrationRoot))
        .filter((filename) => filename.endsWith(this.spec.extension))
        .sort()
        .slice(0, 200);
    } catch (error: any) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
  }

  private personalBenchState(
    active: string | undefined,
    activeOwned: boolean,
    definition: PlayerDefinition | undefined,
  ): string {
    if (active !== undefined && !activeOwned) return "conflict";
    if (!definition) return "stale";
    if (active !== undefined && !isCanonicalPlayerProfile(active, this.spec.name, definition, "personal", this.spec.project)) return "stale";
    return active === undefined ? "bench" : "on";
  }

  private async personalBenchInventory(filter: string): Promise<BenchInventoryRow[]> {
    const rows: BenchInventoryRow[] = [];
    for (const filename of await this.registrationEntries()) {
      const id = filename.slice(0, -this.spec.extension.length);
      if (!isHarborId(id) || (filter && !id.includes(filter))) continue;
      const paths = this.paths(id);
      await Promise.all([
        rejectSymlinkTraversal(this.spec.home, paths.registration),
        rejectSymlinkTraversal(this.spec.project, paths.active),
      ]);
      const registration = await existing(paths.registration);
      const active = await existing(paths.active);
      if (!isOwnedProfile(registration, id, "personal")) {
        rows.push({ id, roster: "personal", state: "conflict" });
        continue;
      }
      let definition: PlayerDefinition | undefined;
      try { definition = validatePlayer(decodePlayer(registration!, id)); }
      catch { definition = undefined; }
      rows.push({ id, roster: "personal", state: this.personalBenchState(active, isOwnedProfile(active, id, "personal"), definition) });
    }
    return rows;
  }

  private async listBench(
    filter: string,
    bundled: ReadonlyMap<string, PlayerDefinition>,
  ): Promise<string> {
    const rows: BenchInventoryRow[] = [];
    rows.push(...await this.bundledBenchInventory(bundled, filter));
    rows.push(...await this.personalBenchInventory(filter));
    return rows.map(({ id, roster, state }) => `${id} | ${roster} | ${state}`).join("\n");
  }

  private async planBenchPlayer(
    id: string,
    action: BenchAction,
    bundled: ReadonlyMap<string, PlayerDefinition>,
  ): Promise<BenchChange> {
    const paths = this.paths(id);
    await Promise.all([
      rejectSymlinkTraversal(this.spec.home, paths.registration),
      rejectSymlinkTraversal(this.spec.project, paths.active),
    ]);
    const active = await existing(paths.active);
    const definition = bundled.get(id);
    const roster = definition ? "sdlc" : "personal";
    if (active !== undefined && !isOwnedProfile(active, id, roster)) throw new Error(`unmanaged collision: ${id}`);
    if (action === "off") {
      if (roster === "personal" && active !== undefined && !isOwnedProfile(await existing(paths.registration), id, "personal")) {
        throw new Error(`personal registration missing: ${id}`);
      }
      return { path: paths.active };
    }
    const registration = definition ? undefined : await existing(paths.registration);
    if (!definition && (!registration || !isOwnedProfile(registration, id, "personal"))) throw new Error(`unknown player: ${id}`);
    try {
      return {
        path: paths.active,
        content: definition
          ? this.spec.renderPlayer(definition, "sdlc")
          : this.spec.renderPlayer(validatePlayer(decodePlayer(registration!, id)), "personal"),
      };
    } catch {
      throw new Error(`stale personal profile: ${id}; re-run join with replace:true`);
    }
  }

  /** Completes every collision/read/render preflight before returning transaction input. */
  private async planBenchMutation(
    command: Extract<BenchCommand, { kind: "mutate" }>,
    bundled: ReadonlyMap<string, PlayerDefinition>,
  ): Promise<BenchChange[]> {
    const changes: BenchChange[] = [];
    for (const id of command.ids) changes.push(await this.planBenchPlayer(id, command.action, bundled));
    return changes;
  }

  /**
   * Lists roster state or deterministically turns bundled/personal players on and off.
   * Turning a personal player off removes only its owned active copy; its registration remains the
   * source of truth. Turning it on requires a recoverable current registration.
   */
  async bench(args: string, bundled: ReadonlyMap<string, PlayerDefinition>): Promise<string> {
    const command = parseBenchCommand(args, bundled);
    if (command.kind === "list") return this.listBench(command.filter, bundled);
    return this.withMutationLock(async () => {
      const changes = await this.planBenchMutation(command, bundled);
      await this.transaction(changes);
      return command.ids.map((id) => `${id}: turned ${command.action}`).join("\n");
    });
  }

  /**
   * Removes an owned personal registration and this project's owned active copy transactionally.
   * Active copies in other projects are intentionally outside the transaction and remain untouched.
   */
  async retire(id: string): Promise<string> {
    if (!isHarborId(id) || reserved.has(id)) throw new Error("invalid personal player");
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
