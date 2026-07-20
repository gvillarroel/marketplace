import type { ContractDefinition, GithubResolver, Orchestrator } from "../core/types.js";
import { type HarborEvidenceHook } from "../core/evidence.js";
type PiSdk = typeof import("@earendil-works/pi-coding-agent");
type PiModel = import("@earendil-works/pi-coding-agent").Model;
type PiToolDefinition = import("@earendil-works/pi-coding-agent").ToolDefinition;
type PiThinkingLevel = import("@earendil-works/pi-coding-agent").ThinkingLevel;
export interface PiSessionOptions {
    readonly model?: PiModel;
    readonly thinkingLevel?: PiThinkingLevel;
}
export declare class PiOrchestrator implements Orchestrator {
    private readonly directory;
    private readonly loadSdk;
    private readonly additionalTools;
    private readonly github;
    private readonly customTools;
    private readonly evidenceHook?;
    private readonly sessionOptions;
    readonly harness: "pi";
    constructor(directory?: string, loadSdk?: () => Promise<PiSdk>, additionalTools?: readonly string[], github?: GithubResolver, customTools?: readonly PiToolDefinition[], evidenceHook?: HarborEvidenceHook | undefined, sessionOptions?: PiSessionOptions);
    run(definition: ContractDefinition, signal?: AbortSignal): Promise<string>;
}
export {};
