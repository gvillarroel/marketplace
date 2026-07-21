/** OpenCode child-session orchestration for named agents and contracts. */
import type { PluginInput } from "@opencode-ai/plugin";
import type { ContractDefinition, GithubResolver, Orchestrator } from "../core/types.js";
import { type HarborEvidenceHook } from "../core/evidence.js";
type Client = PluginInput["client"];
/** Explicit OpenCode model identity inherited from the originating user turn. */
export interface OpenCodeModel {
    readonly providerID: string;
    readonly modelID: string;
    readonly variant?: string;
}
/** Executes each OpenCode delegation or contract in one disposable session. */
export declare class OpenCodeOrchestrator implements Orchestrator {
    private readonly client;
    private readonly directory;
    private readonly github;
    private readonly evidenceHook?;
    readonly harness: "opencode";
    constructor(client: Client, directory: string, github?: GithubResolver, evidenceHook?: HarborEvidenceHook | undefined);
    /** Runs an exact named OpenCode agent using an explicit inherited model. */
    runAgent(agent: string, task: string, parentID: string | undefined, model: OpenCodeModel, signal?: AbortSignal): Promise<string>;
    /** Runs one portable contract using a closed OpenCode tool policy. */
    run(definition: ContractDefinition, signal?: AbortSignal): Promise<string>;
}
export {};
