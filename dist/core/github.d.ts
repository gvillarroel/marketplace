/**
 * Validation and GitHub CLI resolution for allowlisted remote skill documents.
 * Mutable branch references are resolved first and every subsequent content lookup uses the resulting
 * immutable commit SHA, preventing a branch movement from changing the loaded snapshot mid-operation.
 */
import type { GithubResolver, GithubSkill } from "./types.js";
/** Validates the exact schema and traversal-safe coordinates of a GitHub skill reference. */
export declare function validateGithubSkill(value: unknown): GithubSkill;
type GhCommand = (file: string, args: readonly string[], signal?: AbortSignal, timeoutMs?: number) => Promise<string | Uint8Array>;
/**
 * Validates a bounded UTF-8 `SKILL.md` document and returns its non-empty instruction body.
 * The single top-level frontmatter name must match the canonical configured reference.
 */
export declare function parseSkillBody(raw: string | Uint8Array, expectedName: string, sourceLabel?: string): string;
/** Returns whether all security-relevant coordinates exactly match an allowlisted skill reference. */
export declare function isTrustedGithubSkill(skill: GithubSkill, trusted: readonly GithubSkill[]): boolean;
/** Validates, allowlists, pins, and loads one GitHub skill through the supplied resolver. */
export declare function loadTrustedGithubSkill(value: unknown, trusted: readonly GithubSkill[], resolver: GithubResolver, signal?: AbortSignal): Promise<{
    skill: GithubSkill;
    commit: string;
    body: string;
}>;
/** GitHub CLI-backed resolver that reads skill metadata and content from pinned commits. */
export declare class GhResolver implements GithubResolver {
    private readonly run;
    private readonly timeoutMs;
    private readonly executable;
    /** Creates a resolver with a bounded command timeout and injectable runner for testing. */
    constructor(run?: GhCommand, timeoutMs?: number, executable?: string);
    /** Validates a reference and resolves its mutable branch exactly once. */
    private resolveCommit;
    /** Resolves the tracked branch to a commit, then resolves the skill blob at that exact commit. */
    resolve(skill: GithubSkill, signal?: AbortSignal): Promise<{
        commit: string;
        blob: string;
    }>;
    /** Resolves the tracked branch once and loads the validated skill body from that immutable commit. */
    load(skill: GithubSkill, signal?: AbortSignal): Promise<{
        commit: string;
        body: string;
    }>;
}
export {};
