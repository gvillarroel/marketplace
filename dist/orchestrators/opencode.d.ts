import type { PluginInput } from "@opencode-ai/plugin";
import type { ContractDefinition, GithubResolver, Orchestrator } from "../core/types.js";
type Client = PluginInput["client"];
export declare class OpenCodeOrchestrator implements Orchestrator {
    private readonly client;
    private readonly directory;
    private readonly github;
    readonly harness: "opencode";
    constructor(client: Client, directory: string, github?: GithubResolver);
    run(definition: ContractDefinition, signal?: AbortSignal): Promise<string>;
}
export {};
