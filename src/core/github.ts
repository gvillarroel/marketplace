/**
 * Validation and GitHub CLI resolution for allowlisted remote skill documents.
 * Mutable branch references are resolved first and every subsequent content lookup uses the resulting
 * immutable commit SHA, preventing a branch movement from changing the loaded snapshot mid-operation.
 */

import { execFile } from "node:child_process";
import { Buffer } from "node:buffer";
import { promisify } from "node:util";
import { posix } from "node:path";
import { isHarborId } from "./identity.js";
import type { GithubResolver, GithubSkill, GithubSkillCatalogEntry, GithubSkillCatalogSource, TrustedGithubSkills } from "./types.js";

const execute = promisify(execFile);
const segmentPattern = /^[A-Za-z0-9._-]+$/;

/** A remote `SKILL.md` that cannot safely participate in execution trust. */
export class InvalidSkillDocumentError extends Error {}

function safeSegments(value: string, firstAlphanumeric: boolean): boolean {
  if (!value || value.length > 240 || value.includes("..")) return false;
  const segments = value.split("/");
  return segments.every((segment) => segment !== "" && segment !== "." && segment !== ".." &&
    segmentPattern.test(segment) && !segment.toLowerCase().endsWith(".lock") &&
    (!firstAlphanumeric || /^[A-Za-z0-9]/.test(segment)));
}

function safeRepo(value: unknown): value is string {
  return typeof value === "string" && value.length <= 240 &&
    /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/.test(value) &&
    !value.includes("..") && !value.toLowerCase().endsWith(".lock");
}

function safeTrack(value: unknown): value is string {
  return typeof value === "string" && value.length <= 240 && value.startsWith("refs/heads/") &&
    safeSegments(value.slice("refs/heads/".length), true);
}

/** Validates the exact schema and traversal-safe coordinates of a GitHub skill reference. */
export function validateGithubSkill(value: unknown): GithubSkill {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid GitHub skill reference");
  const skill = value as Record<string, unknown>;
  const keys = Object.keys(skill);
  if (keys.length !== 5 || keys.some((key) => !["kind", "name", "repo", "path", "track"].includes(key)) ||
      skill.kind !== "github" || !isHarborId(skill.name) ||
      !safeRepo(skill.repo) ||
      typeof skill.path !== "string" || !safeSegments(skill.path, false) || !(skill.path === "SKILL.md" || skill.path.endsWith("/SKILL.md")) ||
      !safeTrack(skill.track)) {
    throw new Error("invalid GitHub skill reference");
  }
  return skill as unknown as GithubSkill;
}

/** Validates one repository, folder, or exact-skill scope used only for visible discovery. */
export function validateGithubSkillCatalogSource(value: unknown): GithubSkillCatalogSource {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid GitHub skill catalog source");
  const source = value as Record<string, unknown>;
  const keys = Object.keys(source);
  if (keys.some((key) => !["kind", "scope", "repo", "track", "path", "name"].includes(key)) ||
      source.kind !== "github" || !["repository", "folder", "skill"].includes(String(source.scope)) ||
      !safeRepo(source.repo) || !safeTrack(source.track)) throw new Error("invalid GitHub skill catalog source");
  if (source.scope === "repository") {
    if (keys.length !== 4 || "path" in source || "name" in source) throw new Error("repository catalog source cannot define path or name");
  } else {
    if (typeof source.path !== "string" || !safeSegments(source.path, false)) throw new Error("folder and skill catalog sources require a safe path");
    if (source.scope === "folder" && (source.path === "SKILL.md" || source.path.endsWith("/SKILL.md") || "name" in source)) {
      throw new Error("folder catalog source requires a directory path and cannot define name");
    }
    if (source.scope === "skill" && !(source.path === "SKILL.md" || source.path.endsWith("/SKILL.md"))) {
      throw new Error("skill catalog source must point to SKILL.md");
    }
    if ("name" in source && !isHarborId(source.name)) throw new Error("invalid catalog skill name");
  }
  return source as unknown as GithubSkillCatalogSource;
}

type GhCommand = (file: string, args: readonly string[], signal?: AbortSignal, timeoutMs?: number) => Promise<string | Uint8Array>;
const runGh: GhCommand = async (file, args, signal, timeoutMs = 20_000) => (await execute(file, [...args], {
  encoding: "buffer",
  maxBuffer: 256 * 1024,
  signal,
  timeout: timeoutMs,
})).stdout;

function bytes(value: string | Uint8Array): Buffer {
  return typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value);
}

function text(value: string | Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes(value));
}

/**
 * Validates a bounded UTF-8 `SKILL.md` document and returns its non-empty instruction body.
 * The single top-level frontmatter name must match the canonical configured reference.
 */
function parseScalar(value: string, field: string, sourceLabel: string): string {
  try {
    const parsed = value.startsWith('"') ? JSON.parse(value) : value.startsWith("'") && value.endsWith("'")
      ? value.slice(1, -1).replace(/''/g, "'") : value;
    if (typeof parsed !== "string" || parsed.includes("\0") || parsed.includes("\n")) throw new Error();
    return parsed;
  } catch { throw new InvalidSkillDocumentError(`${sourceLabel} skill has invalid ${field} frontmatter`); }
}

/** Parses bounded public frontmatter and the private instruction body. */
export function parseSkillDocument(raw: string | Uint8Array, expectedName?: string, sourceLabel = "GitHub"): { name: string; description: string; body: string } {
  const source = bytes(raw);
  if (source.length === 0 || source.length > 18_000) throw new InvalidSkillDocumentError(`${sourceLabel} skill body must be 1..18000 UTF-8 bytes`);
  let document: string;
  try { document = text(source).replace(/\r\n/g, "\n"); }
  catch { throw new InvalidSkillDocumentError(`${sourceLabel} skill body must be valid UTF-8`); }
  if (!document.startsWith("---\n") || document.includes("\0")) throw new InvalidSkillDocumentError(`${sourceLabel} skill requires first-line YAML frontmatter`);
  const end = document.indexOf("\n---\n", 4);
  if (end < 0 || end > 4_096) throw new InvalidSkillDocumentError(`${sourceLabel} skill has invalid frontmatter`);
  const names = document.slice(4, end).split("\n").filter((line) => line.startsWith("name:"));
  if (names.length !== 1) throw new InvalidSkillDocumentError(`${sourceLabel} skill must declare exactly one top-level name`);
  const name = parseScalar(names[0].slice("name:".length).trim(), "name", sourceLabel);
  if (!isHarborId(name)) throw new InvalidSkillDocumentError(`${sourceLabel} skill has invalid name frontmatter`);
  if (expectedName !== undefined && name !== expectedName) throw new InvalidSkillDocumentError(`${sourceLabel} skill name does not match its canonical reference`);
  const descriptions = document.slice(4, end).split("\n").filter((line) => line.startsWith("description:"));
  if (descriptions.length > 1) throw new InvalidSkillDocumentError(`${sourceLabel} skill must declare at most one top-level description`);
  const description = descriptions.length
    ? parseScalar(descriptions[0].slice("description:".length).trim(), "description", sourceLabel).trim()
    : "";
  if (description.length > 1_000) throw new InvalidSkillDocumentError(`${sourceLabel} skill description exceeds 1000 characters`);
  const body = document.slice(end + 5).trim();
  if (!body) throw new InvalidSkillDocumentError(`${sourceLabel} skill body is empty`);
  return { name, description, body };
}

export function parseSkillBody(raw: string | Uint8Array, expectedName: string, sourceLabel = "GitHub"): string {
  return parseSkillDocument(raw, expectedName, sourceLabel).body;
}

/** Returns whether all security-relevant coordinates exactly match an allowlisted skill reference. */
export function isTrustedGithubSkill(skill: GithubSkill, trusted: TrustedGithubSkills): boolean {
  return trusted.some((candidate) => candidate.name === skill.name && candidate.repo.toLowerCase() === skill.repo.toLowerCase() &&
    candidate.path === skill.path && candidate.track === skill.track) ||
    (trusted.repositories ?? []).some((repository) => repository.repo.toLowerCase() === skill.repo.toLowerCase() &&
      repository.track === skill.track);
}

/** Validates, allowlists, pins, and loads one GitHub skill through the supplied resolver. */
export async function loadTrustedGithubSkill(value: unknown, trusted: TrustedGithubSkills, resolver: GithubResolver, signal?: AbortSignal): Promise<{ skill: GithubSkill; commit: string; body: string }> {
  const skill = validateGithubSkill(value);
  if (!isTrustedGithubSkill(skill, trusted)) throw new Error("untrusted GitHub skill reference");
  signal?.throwIfAborted();
  return { skill, ...(await resolver.load(skill, signal)) };
}

/** GitHub CLI-backed resolver that reads skill metadata and content from pinned commits. */
export class GhResolver implements GithubResolver {
  /** Creates a resolver with a bounded command timeout and injectable runner for testing. */
  constructor(private readonly run: GhCommand = runGh, private readonly timeoutMs = 20_000, private readonly executable = "gh") {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw new Error("invalid gh timeout");
    if (typeof executable !== "string" || !executable) throw new Error("invalid gh executable");
  }

  /** Validates a reference and resolves its mutable branch exactly once. */
  private async resolveCoordinates(repo: string, track: string, signal?: AbortSignal): Promise<string> {
    if (!safeRepo(repo) || !safeTrack(track)) throw new Error("invalid GitHub coordinates");
    const branch = track.slice("refs/heads/".length);
    const commit = text(await this.run(this.executable, [
      "api", "--hostname", "github.com", "--method", "GET",
      `repos/${repo}/git/ref/heads/${branch}`, "--jq", ".object.sha",
    ], signal, this.timeoutMs)).trim();
    if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("invalid commit SHA from gh");
    return commit;
  }

  /** Resolves the tracked branch to a commit, then resolves the skill blob at that exact commit. */
  async resolve(skill: GithubSkill, signal?: AbortSignal): Promise<{ commit: string; blob: string }> {
    validateGithubSkill(skill);
    const commit = await this.resolveCoordinates(skill.repo, skill.track, signal);
    const blob = text(await this.run(this.executable, ["api", "--hostname", "github.com", "--method", "GET", `repos/${skill.repo}/contents/${skill.path}`, "-f", `ref=${commit}`, "--jq", ".sha"], signal, this.timeoutMs)).trim();
    if (!/^[a-f0-9]{40}$/.test(blob)) throw new Error("invalid blob SHA from gh");
    return { commit, blob };
  }

  /** Resolves the tracked branch once and loads the validated skill body from that immutable commit. */
  async load(skill: GithubSkill, signal?: AbortSignal): Promise<{ commit: string; body: string }> {
    validateGithubSkill(skill);
    const commit = await this.resolveCoordinates(skill.repo, skill.track, signal);
    const raw = await this.run(this.executable, [
      "api", "--hostname", "github.com", "--method", "GET", "-H", "Accept: application/vnd.github.raw+json",
      `repos/${skill.repo}/contents/${skill.path}`, "-f", `ref=${commit}`,
    ], signal, this.timeoutMs);
    return { commit, body: parseSkillBody(raw, skill.name) };
  }

  /** Loads only bounded frontmatter metadata for one exact allowlisted reference. */
  async describe(skill: GithubSkill, signal?: AbortSignal): Promise<{ commit: string; description: string }> {
    validateGithubSkill(skill);
    const commit = await this.resolveCoordinates(skill.repo, skill.track, signal);
    const raw = await this.rawSkill(skill.repo, skill.path, commit, signal);
    return { commit, description: parseSkillDocument(raw, skill.name).description };
  }

  private async rawSkill(repo: string, path: string, commit: string, signal?: AbortSignal): Promise<string | Uint8Array> {
    if (!safeRepo(repo) || !safeSegments(path, false) || !/^[a-f0-9]{40}$/.test(commit)) throw new Error("invalid GitHub catalog coordinates");
    return this.run(this.executable, [
      "api", "--hostname", "github.com", "--method", "GET", "-H", "Accept: application/vnd.github.raw+json",
      `repos/${repo}/contents/${path}`, "-f", `ref=${commit}`,
    ], signal, this.timeoutMs);
  }

  /** Enumerates only `SKILL.md` blobs within one validated catalog scope. */
  async listCatalog(value: GithubSkillCatalogSource, signal?: AbortSignal): Promise<readonly GithubSkillCatalogEntry[]> {
    const source = validateGithubSkillCatalogSource(value);
    const commit = await this.resolveCoordinates(source.repo, source.track, signal);
    if (source.scope === "skill") {
      const blob = text(await this.run(this.executable, [
        "api", "--hostname", "github.com", "--method", "GET",
        `repos/${source.repo}/contents/${source.path}`, "-f", `ref=${commit}`, "--jq", ".sha",
      ], signal, this.timeoutMs)).trim();
      if (!/^[a-f0-9]{40}$/.test(blob)) throw new Error("invalid blob SHA from gh");
      const inferred = source.path === "SKILL.md" ? source.repo.slice(source.repo.indexOf("/") + 1) : posix.basename(posix.dirname(source.path!));
      return [{ repo: source.repo, path: source.path!, name: source.name ?? inferred, track: source.track, commit }];
    }
    const raw = text(await this.run(this.executable, [
      "api", "--hostname", "github.com", "--method", "GET",
      `repos/${source.repo}/git/trees/${commit}?recursive=1`,
      "--jq", 'if .truncated then error("repository tree is truncated; choose a narrower folder") else .tree[] | select(.type == "blob" and (.path == "SKILL.md" or (.path | endswith("/SKILL.md")))) | [.path, .sha] | @tsv end',
    ], signal, this.timeoutMs));
    const entries: GithubSkillCatalogEntry[] = [];
    const seen = new Set<string>();
    for (const line of raw.split(/\r?\n/u).filter(Boolean)) {
      const [path, blob, ...extra] = line.split("\t");
      if (extra.length || !path || !blob || !/^[a-f0-9]{40}$/.test(blob) || !safeSegments(path, false)) {
        throw new Error("invalid repository tree entry from gh");
      }
      if (!(path === "SKILL.md" || path.endsWith("/SKILL.md"))) continue;
      if (source.scope === "folder" && !(path === `${source.path}/SKILL.md` || path.startsWith(`${source.path}/`))) continue;
      if (seen.has(path)) throw new Error("duplicate skill path in repository tree");
      seen.add(path);
      const inferred = path === "SKILL.md" ? source.repo.slice(source.repo.indexOf("/") + 1) : posix.basename(posix.dirname(path));
      entries.push({ repo: source.repo, path, name: inferred, track: source.track, commit });
      if (entries.length > 500) throw new Error("skill catalog scope exceeds 500 entries; choose a narrower folder");
    }
    return entries;
  }

  /** Loads a catalog row's description from the immutable commit that produced it. */
  async inspectCatalog(entry: GithubSkillCatalogEntry, signal?: AbortSignal): Promise<{ name: string; description: string }> {
    if (!entry.commit || !entry.track) throw new Error("catalog row lacks pinned metadata");
    const raw = await this.rawSkill(entry.repo, entry.path, entry.commit, signal);
    const { name, description } = parseSkillDocument(raw);
    return { name, description };
  }

  /** Loads only the public description while preserving an optional catalog display name. */
  async describeCatalog(entry: GithubSkillCatalogEntry, signal?: AbortSignal): Promise<string> {
    return (await this.inspectCatalog(entry, signal)).description;
  }
}
