import type { GithubResolver, GithubSkill, PlayerDefinition, RepositorySkill, SkillReference } from "./types.js";
export interface LoadedConfiguredSkill {
    readonly reference: SkillReference;
    readonly body: string;
    readonly commit?: string;
}
export interface MaterializedConfiguredSkill extends LoadedConfiguredSkill {
    readonly filePath: string;
}
export interface SkillCapsule {
    readonly root?: string;
    readonly skills: readonly MaterializedConfiguredSkill[];
    cleanup(): Promise<void>;
}
export declare function validateRepositorySkill(value: unknown): RepositorySkill;
export declare function validateSkillReference(value: unknown): SkillReference;
export declare function loadConfiguredSkills(definition: PlayerDefinition, project: string, github: GithubResolver, trusted: readonly GithubSkill[], signal?: AbortSignal): Promise<readonly LoadedConfiguredSkill[]>;
export declare function createSkillCapsule(definition: PlayerDefinition, project: string, github: GithubResolver, trusted: readonly GithubSkill[], signal?: AbortSignal): Promise<SkillCapsule>;
export declare function withLoadedSkillGuidance<T extends PlayerDefinition>(definition: T, loaded: readonly LoadedConfiguredSkill[]): T;
export declare function formatLoadedSkillGroup(loaded: readonly LoadedConfiguredSkill[]): string;
