/** One-child Copilot SDK orchestration with isolated skills and full cleanup. */
import { CopilotClient } from "@github/copilot-sdk";
import type { ContractDefinition, GithubResolver, Orchestrator } from "../core/types.js";
import { type HarborEvidenceHook } from "../core/evidence.js";
export interface CopilotOrchestratorOptions {
    /** Maximum time allowed for a single SDK setup or prompt operation. */
    operationTimeoutMs?: number;
    /** Maximum time allowed for each independent cleanup operation. */
    cleanupTimeoutMs?: number;
    /** Maximum time allowed for a requested SDK abort to settle. */
    abortTimeoutMs?: number;
}
/** Executes invocation-scoped contracts through the Copilot SDK. */
export declare class CopilotOrchestrator implements Orchestrator {
    private readonly createClient;
    private readonly directory;
    private readonly github;
    private readonly evidenceHook?;
    private readonly options;
    readonly harness: "copilot";
    private readonly lateCleanupLedger;
    constructor(createClient?: () => CopilotClient, directory?: string, github?: GithubResolver, evidenceHook?: HarborEvidenceHook | undefined, options?: CopilotOrchestratorOptions);
    private observeLateCleanup;
    /**
     * Creates exactly one custom-agent session, returns its non-empty evidence,
     * and always deletes the session, stops the client, and removes its capsule.
     */
    run(definition: ContractDefinition, signal?: AbortSignal): Promise<string>;
}
