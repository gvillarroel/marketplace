/**
 * Validation and GitHub CLI resolution for allowlisted remote skill documents.
 * Mutable branch references are resolved first and every subsequent content lookup uses the resulting
 * immutable commit SHA, preventing a branch movement from changing the loaded snapshot mid-operation.
 */
import { execFile } from "node:child_process";
import { Buffer } from "node:buffer";
import { promisify } from "node:util";
import { isHarborId } from "./identity.js";
const execute = promisify(execFile);
const segmentPattern = /^[A-Za-z0-9._-]+$/;
function safeSegments(value, firstAlphanumeric) {
    if (!value || value.length > 240 || value.includes(".."))
        return false;
    const segments = value.split("/");
    return segments.every((segment) => segment !== "" && segment !== "." && segment !== ".." &&
        segmentPattern.test(segment) && !segment.toLowerCase().endsWith(".lock") &&
        (!firstAlphanumeric || /^[A-Za-z0-9]/.test(segment)));
}
/** Validates the exact schema and traversal-safe coordinates of a GitHub skill reference. */
export function validateGithubSkill(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("invalid GitHub skill reference");
    const skill = value;
    const keys = Object.keys(skill);
    if (keys.length !== 5 || keys.some((key) => !["kind", "name", "repo", "path", "track"].includes(key)) ||
        skill.kind !== "github" || !isHarborId(skill.name) ||
        typeof skill.repo !== "string" || skill.repo.length > 240 || !/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/.test(skill.repo) || skill.repo.includes("..") || skill.repo.toLowerCase().endsWith(".lock") ||
        typeof skill.path !== "string" || !safeSegments(skill.path, false) || !(skill.path === "SKILL.md" || skill.path.endsWith("/SKILL.md")) ||
        typeof skill.track !== "string" || skill.track.length > 240 || !skill.track.startsWith("refs/heads/") || !safeSegments(skill.track.slice("refs/heads/".length), true)) {
        throw new Error("invalid GitHub skill reference");
    }
    return skill;
}
const runGh = async (file, args, signal, timeoutMs = 20_000) => (await execute(file, [...args], {
    encoding: "buffer",
    maxBuffer: 64 * 1024,
    signal,
    timeout: timeoutMs,
})).stdout;
function bytes(value) {
    return typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value);
}
function text(value) {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes(value));
}
/**
 * Validates a bounded UTF-8 `SKILL.md` document and returns its non-empty instruction body.
 * The single top-level frontmatter name must match the canonical configured reference.
 */
export function parseSkillBody(raw, expectedName, sourceLabel = "GitHub") {
    const source = bytes(raw);
    if (source.length === 0 || source.length > 18_000)
        throw new Error(`${sourceLabel} skill body must be 1..18000 UTF-8 bytes`);
    const document = text(source).replace(/\r\n/g, "\n");
    if (!document.startsWith("---\n") || document.includes("\0"))
        throw new Error(`${sourceLabel} skill requires first-line YAML frontmatter`);
    const end = document.indexOf("\n---\n", 4);
    if (end < 0 || end > 4_096)
        throw new Error(`${sourceLabel} skill has invalid frontmatter`);
    const names = document.slice(4, end).split("\n").filter((line) => line.startsWith("name:"));
    if (names.length !== 1)
        throw new Error(`${sourceLabel} skill must declare exactly one top-level name`);
    const scalar = names[0].slice("name:".length).trim();
    let name;
    try {
        name = scalar.startsWith('"') ? JSON.parse(scalar) : scalar.startsWith("'") && scalar.endsWith("'")
            ? scalar.slice(1, -1).replace(/''/g, "'") : scalar;
    }
    catch {
        throw new Error(`${sourceLabel} skill has invalid name frontmatter`);
    }
    if (name !== expectedName)
        throw new Error(`${sourceLabel} skill name does not match its canonical reference`);
    const body = document.slice(end + 5).trim();
    if (!body)
        throw new Error(`${sourceLabel} skill body is empty`);
    return body;
}
/** Returns whether all security-relevant coordinates exactly match an allowlisted skill reference. */
export function isTrustedGithubSkill(skill, trusted) {
    return trusted.some((candidate) => candidate.name === skill.name && candidate.repo.toLowerCase() === skill.repo.toLowerCase() &&
        candidate.path === skill.path && candidate.track === skill.track);
}
/** Validates, allowlists, pins, and loads one GitHub skill through the supplied resolver. */
export async function loadTrustedGithubSkill(value, trusted, resolver, signal) {
    const skill = validateGithubSkill(value);
    if (!isTrustedGithubSkill(skill, trusted))
        throw new Error("untrusted GitHub skill reference");
    signal?.throwIfAborted();
    return { skill, ...(await resolver.load(skill, signal)) };
}
/** GitHub CLI-backed resolver that reads skill metadata and content from pinned commits. */
export class GhResolver {
    run;
    timeoutMs;
    executable;
    /** Creates a resolver with a bounded command timeout and injectable runner for testing. */
    constructor(run = runGh, timeoutMs = 20_000, executable = "gh") {
        this.run = run;
        this.timeoutMs = timeoutMs;
        this.executable = executable;
        if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000)
            throw new Error("invalid gh timeout");
        if (typeof executable !== "string" || !executable)
            throw new Error("invalid gh executable");
    }
    /** Validates a reference and resolves its mutable branch exactly once. */
    async resolveCommit(skill, signal) {
        validateGithubSkill(skill);
        const branch = skill.track.slice("refs/heads/".length);
        const commit = text(await this.run(this.executable, [
            "api", "--hostname", "github.com", "--method", "GET",
            `repos/${skill.repo}/git/ref/heads/${branch}`, "--jq", ".object.sha",
        ], signal, this.timeoutMs)).trim();
        if (!/^[a-f0-9]{40}$/.test(commit))
            throw new Error("invalid commit SHA from gh");
        return commit;
    }
    /** Resolves the tracked branch to a commit, then resolves the skill blob at that exact commit. */
    async resolve(skill, signal) {
        const commit = await this.resolveCommit(skill, signal);
        const blob = text(await this.run(this.executable, ["api", "--hostname", "github.com", "--method", "GET", `repos/${skill.repo}/contents/${skill.path}`, "-f", `ref=${commit}`, "--jq", ".sha"], signal, this.timeoutMs)).trim();
        if (!/^[a-f0-9]{40}$/.test(blob))
            throw new Error("invalid blob SHA from gh");
        return { commit, blob };
    }
    /** Resolves the tracked branch once and loads the validated skill body from that immutable commit. */
    async load(skill, signal) {
        const commit = await this.resolveCommit(skill, signal);
        const raw = await this.run(this.executable, [
            "api", "--hostname", "github.com", "--method", "GET", "-H", "Accept: application/vnd.github.raw+json",
            `repos/${skill.repo}/contents/${skill.path}`, "-f", `ref=${commit}`,
        ], signal, this.timeoutMs);
        return { commit, body: parseSkillBody(raw, skill.name) };
    }
}
