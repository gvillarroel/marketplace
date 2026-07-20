import type { ContractDefinition, GithubResolver, Orchestrator } from "../core/types.js";
type PiSdk = typeof import("@earendil-works/pi-coding-agent");
export declare class PiOrchestrator implements Orchestrator {
    private readonly directory;
    private readonly loadSdk;
    private readonly additionalTools;
    private readonly github;
    readonly harness: "pi";
    constructor(directory?: string, loadSdk?: () => Promise<PiSdk>, additionalTools?: readonly string[], github?: GithubResolver);
    run(definition: ContractDefinition, signal?: AbortSignal): Promise<string>;
}
export {};
