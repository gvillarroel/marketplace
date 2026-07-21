/**
 * Validation and GitHub CLI resolution for allowlisted remote skill documents.
 * Mutable branch references are resolved first and every subsequent content lookup uses the resulting
 * immutable commit SHA, preventing a branch movement from changing the loaded snapshot mid-operation.
 */
import type { GithubResolver, GithubSkill, GithubSkillCatalogEntry, GithubSkillCatalogSource, TrustedGithubSkills } from "./types.js";
/** A remote `SKILL.md` that cannot safely participate in execution trust. */
export declare class InvalidSkillDocumentError extends Error {
}
/** Validates the exact schema and traversal-safe coordinates of a GitHub skill reference. */
export declare function validateGithubSkill(value: unknown): GithubSkill;
/** Validates one repository, folder, or exact-skill scope used only for visible discovery. */
export declare function validateGithubSkillCatalogSource(value: unknown): GithubSkillCatalogSource;
type GhCommand = (file: string, args: readonly string[], signal?: AbortSignal, timeoutMs?: number) => Promise<string | Uint8Array>;
/** Parses bounded public frontmatter and the private instruction body. */
export declare function parseSkillDocument(raw: string | Uint8Array, expectedName?: string, sourceLabel?: string): {
    name: string;
    description: string;
    body: string;
};
export declare function parseSkillBody(raw: string | Uint8Array, expectedName: string, sourceLabel?: string): string;
/** Returns whether all security-relevant coordinates exactly match an allowlisted skill reference. */
export declare function isTrustedGithubSkill(skill: GithubSkill, trusted: TrustedGithubSkills): boolean;
/** Validates, allowlists, pins, and loads one GitHub skill through the supplied resolver. */
export declare function loadTrustedGithubSkill(value: unknown, trusted: TrustedGithubSkills, resolver: GithubResolver, signal?: AbortSignal): Promise<{
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
    private resolveCoordinates;
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
    /** Loads only bounded frontmatter metadata for one exact allowlisted reference. */
    describe(skill: GithubSkill, signal?: AbortSignal): Promise<{
        commit: string;
        description: string;
    }>;
    private rawSkill;
    /** Enumerates only `SKILL.md` blobs within one validated catalog scope. */
    listCatalog(value: GithubSkillCatalogSource, signal?: AbortSignal): Promise<readonly GithubSkillCatalogEntry[]>;
    /** Loads a catalog row's description from the immutable commit that produced it. */
    inspectCatalog(entry: GithubSkillCatalogEntry, signal?: AbortSignal): Promise<{
        name: string;
        description: string;
    }>;
    /** Loads only the public description while preserving an optional catalog display name. */
    describeCatalog(entry: GithubSkillCatalogEntry, signal?: AbortSignal): Promise<string>;
}
export {};
