import type { PluginInput } from "@opencode-ai/plugin";
import type { ContractDefinition, GithubResolver, Orchestrator } from "../core/types.js";
import { type HarborEvidenceHook } from "../core/evidence.js";
type Client = PluginInput["client"];
export interface OpenCodeModel {
    readonly providerID: string;
    readonly modelID: string;
    readonly variant?: string;
}
export declare class OpenCodeOrchestrator implements Orchestrator {
    private readonly client;
    private readonly directory;
    private readonly github;
    private readonly evidenceHook?;
    readonly harness: "opencode";
    constructor(client: Client, directory: string, github?: GithubResolver, evidenceHook?: HarborEvidenceHook | undefined);
    runAgent(agent: string, task: string, parentID: string | undefined, model: OpenCodeModel, signal?: AbortSignal): Promise<string>;
    run(definition: ContractDefinition, signal?: AbortSignal): Promise<string>;
}
export {};
