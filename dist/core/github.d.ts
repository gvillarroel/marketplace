import type { GithubResolver, GithubSkill } from "./types.js";
export declare function validateGithubSkill(value: unknown): GithubSkill;
type GhCommand = (file: string, args: readonly string[], signal?: AbortSignal, timeoutMs?: number) => Promise<string | Uint8Array>;
export declare function parseSkillBody(raw: string | Uint8Array, expectedName: string, sourceLabel?: string): string;
export declare function isTrustedGithubSkill(skill: GithubSkill, trusted: readonly GithubSkill[]): boolean;
export declare function loadTrustedGithubSkill(value: unknown, trusted: readonly GithubSkill[], resolver: GithubResolver, signal?: AbortSignal): Promise<{
    skill: GithubSkill;
    commit: string;
    body: string;
}>;
export declare class GhResolver implements GithubResolver {
    private readonly run;
    private readonly timeoutMs;
    private readonly executable;
    constructor(run?: GhCommand, timeoutMs?: number, executable?: string);
    resolve(skill: GithubSkill, signal?: AbortSignal): Promise<{
        commit: string;
        blob: string;
    }>;
    load(skill: GithubSkill, signal?: AbortSignal): Promise<{
        commit: string;
        body: string;
    }>;
}
export {};
