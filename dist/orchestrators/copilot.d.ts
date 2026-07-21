/** One-child Copilot SDK orchestration with isolated skills and full cleanup. */
import { CopilotClient } from "@github/copilot-sdk";
import type { ContractDefinition, GithubResolver, Orchestrator } from "../core/types.js";
import { type HarborEvidenceHook } from "../core/evidence.js";
/** Executes invocation-scoped contracts through the Copilot SDK. */
export declare class CopilotOrchestrator implements Orchestrator {
    private readonly createClient;
    private readonly directory;
    private readonly github;
    private readonly evidenceHook?;
    readonly harness: "copilot";
    constructor(createClient?: () => CopilotClient, directory?: string, github?: GithubResolver, evidenceHook?: HarborEvidenceHook | undefined);
    /**
     * Creates exactly one custom-agent session, returns its non-empty evidence,
     * and always deletes the session, stops the client, and removes its capsule.
     */
    run(definition: ContractDefinition, signal?: AbortSignal): Promise<string>;
}
