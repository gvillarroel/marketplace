import type { GithubResolver, GithubSkill, PlayerDefinition } from "./types.js";
export declare function validateGithubSkill(value: unknown): GithubSkill;
type GhCommand = (file: string, args: readonly string[], signal?: AbortSignal, timeoutMs?: number) => Promise<string | Uint8Array>;
export declare function isTrustedGithubSkill(skill: GithubSkill, trusted: readonly GithubSkill[]): boolean;
export declare function loadTrustedGithubSkill(value: unknown, trusted: readonly GithubSkill[], resolver: GithubResolver, signal?: AbortSignal): Promise<{
    skill: GithubSkill;
    commit: string;
    body: string;
}>;
export declare function materializeGithubSkills<T extends PlayerDefinition>(definition: T, resolver: GithubResolver, trusted: readonly GithubSkill[], signal?: AbortSignal): Promise<T>;
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
