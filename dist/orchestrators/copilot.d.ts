import { CopilotClient } from "@github/copilot-sdk";
import type { ContractDefinition, GithubResolver, Orchestrator } from "../core/types.js";
export declare class CopilotOrchestrator implements Orchestrator {
    private readonly createClient;
    private readonly directory;
    private readonly github;
    readonly harness: "copilot";
    constructor(createClient?: () => CopilotClient, directory?: string, github?: GithubResolver);
    run(definition: ContractDefinition, signal?: AbortSignal): Promise<string>;
}
