import { CopilotClient } from "@github/copilot-sdk";
import type { ContractDefinition, GithubResolver, Orchestrator } from "../core/types.js";
import { type HarborEvidenceHook } from "../core/evidence.js";
export declare class CopilotOrchestrator implements Orchestrator {
    private readonly createClient;
    private readonly directory;
    private readonly github;
    private readonly evidenceHook?;
    readonly harness: "copilot";
    constructor(createClient?: () => CopilotClient, directory?: string, github?: GithubResolver, evidenceHook?: HarborEvidenceHook | undefined);
    run(definition: ContractDefinition, signal?: AbortSignal): Promise<string>;
}
