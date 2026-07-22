/** OpenCode child-session orchestration for named agents and contracts. */
import type { PluginInput } from "@opencode-ai/plugin";
import type { ContractDefinition, GithubResolver, Orchestrator } from "../core/types.js";
import { type HarborEvidenceHook } from "../core/evidence.js";
type LegacyClient = PluginInput["client"];
type PromptBody = NonNullable<Parameters<LegacyClient["session"]["prompt"]>[0]["body"]> & {
    readonly variant?: string;
};
type CreateRequest = NonNullable<Parameters<LegacyClient["session"]["create"]>[0]>;
type DeleteRequest = Parameters<LegacyClient["session"]["delete"]>[0];
type UpdateRequest = Parameters<LegacyClient["session"]["update"]>[0];
type PromptRequest = Omit<Parameters<LegacyClient["session"]["prompt"]>[0], "body"> & {
    readonly body: PromptBody;
};
/**
 * The deliberately small client surface required by disposable OpenCode
 * children. Keeping this structural lets the server use the legacy plugin SDK
 * while the TUI supplies an explicit v2 bridge; neither side can silently
 * pretend that the two incompatible request shapes are interchangeable.
 */
export interface OpenCodeOrchestratorClient {
    readonly session: {
        create(input: CreateRequest): Promise<{
            readonly data?: {
                readonly id?: unknown;
            };
        }>;
        delete(input: DeleteRequest): Promise<{
            readonly data?: unknown;
        }>;
        update(input: UpdateRequest): Promise<{
            readonly data?: {
                readonly id?: unknown;
                readonly title?: unknown;
            };
        }>;
        prompt(input: PromptRequest): Promise<{
            readonly data?: {
                readonly info?: unknown;
                readonly parts?: unknown;
            };
        }>;
    };
}
export interface OpenCodeContractTelemetry {
    readonly model?: OpenCodeModel;
    readonly input?: number;
    readonly output?: number;
    readonly reasoning?: number;
    readonly cacheRead?: number;
    readonly cacheWrite?: number;
    readonly total?: number;
    readonly totalSource?: "native" | "observed-components";
    readonly totalLowerBound?: true;
    readonly totalConflict?: true;
    readonly cost?: number;
}
export interface OpenCodeObservedContractResult {
    readonly text: string;
    readonly telemetry: OpenCodeContractTelemetry;
}
/** Explicit OpenCode model identity inherited from the originating user turn. */
export interface OpenCodeModel {
    readonly providerID: string;
    readonly modelID: string;
    readonly variant?: string;
}
export type OpenCodeChildLifecyclePhase = "starting" | "working" | "cleaning";
/** Executes each OpenCode delegation or contract in one disposable session. */
export declare class OpenCodeOrchestrator implements Orchestrator {
    private readonly client;
    private readonly directory;
    private readonly github;
    private readonly evidenceHook?;
    private readonly cleanupTimeoutMs;
    private readonly claimHome;
    private readonly lifecyclePhaseHook?;
    readonly harness: "opencode";
    constructor(client: OpenCodeOrchestratorClient, directory: string, github?: GithubResolver, evidenceHook?: HarborEvidenceHook | undefined, cleanupTimeoutMs?: number, claimHome?: string, lifecyclePhaseHook?: ((phase: OpenCodeChildLifecyclePhase, childSessionID?: string) => void) | undefined);
    /** Runs an exact named OpenCode agent using an explicit inherited model. */
    runAgent(agent: string, task: string, parentID: string | undefined, model: OpenCodeModel, signal?: AbortSignal, lifecyclePhaseHook?: (phase: OpenCodeChildLifecyclePhase, childSessionID?: string) => void): Promise<string>;
    /** Runs one portable contract using a closed OpenCode tool policy. */
    run(definition: ContractDefinition, signal?: AbortSignal): Promise<string>;
    /** Retains bounded native prompt telemetry before the disposable child is deleted. */
    runObserved(definition: ContractDefinition, signal?: AbortSignal): Promise<OpenCodeObservedContractResult>;
    /** Owns the complete create/prompt/evidence/cleanup lifecycle for one disposable child. */
    private runChildLifecycle;
    /** Gives orphan-prevention cleanup one bounded retry before blocking the project. */
    private deleteUnclaimedChild;
    /** Reconciles malformed create replies conservatively before any provenance or prompt RPC. */
    private rejectMalformedCreatedChildID;
    private runReservedChildLifecycle;
}
export {};
