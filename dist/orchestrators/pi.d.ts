import type { ContractDefinition, GithubResolver, Orchestrator } from "../core/types.js";
import { type HarborEvidenceHook } from "../core/evidence.js";
import type { PiRunObserver } from "../core/pi-observability.js";
type PiSdk = typeof import("@earendil-works/pi-coding-agent");
type PiModel = import("@earendil-works/pi-coding-agent").Model;
type PiToolDefinition = import("@earendil-works/pi-coding-agent").ToolDefinition;
type PiThinkingLevel = import("@earendil-works/pi-coding-agent").ThinkingLevel;
type PiProviderConfig = import("@earendil-works/pi-coding-agent").ProviderConfig;
/** Optional host model and reasoning settings inherited by a Pi child. */
export interface PiProviderProjection {
    readonly id: string;
    readonly config?: PiProviderConfig;
    /** Present only for a host credential whose public auth status source is runtime. */
    readonly runtimeKey?: string;
}
export interface PiSessionOptions {
    readonly model?: PiModel;
    readonly thinkingLevel?: PiThinkingLevel;
    readonly providerProjections?: readonly PiProviderProjection[];
}
/** Executes each contract in one isolated, in-memory Pi SDK session. */
export declare class PiOrchestrator implements Orchestrator {
    private readonly directory;
    private readonly loadSdk;
    private readonly additionalTools;
    private readonly github;
    private readonly customTools;
    private readonly evidenceHook?;
    private readonly sessionOptions;
    private readonly runObserver?;
    readonly harness: "pi";
    constructor(directory?: string, loadSdk?: () => Promise<PiSdk>, additionalTools?: readonly string[], github?: GithubResolver, customTools?: readonly PiToolDefinition[], evidenceHook?: HarborEvidenceHook | undefined, sessionOptions?: PiSessionOptions, runObserver?: PiRunObserver | undefined);
    /**
     * Loads only the invocation capsule, creates one child, captures text
     * evidence, and disposes every session/capsule resource on all exit paths.
     */
    run(definition: ContractDefinition, signal?: AbortSignal): Promise<string>;
}
export {};
