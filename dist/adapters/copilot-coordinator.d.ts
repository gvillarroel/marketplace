import { type HarborEvidenceHook } from "../core/evidence.js";
/** Minimal host identity needed to resolve a logical Harbor player. */
export interface CopilotAgentIdentity {
    id: string;
    path?: string;
    userInvocable?: boolean;
}
/** Narrow RPC surface used to refresh Copilot's selected and available agents. */
export interface CopilotCoordinatorSession {
    rpc: {
        agent: {
            getCurrent(): Promise<{
                agent?: CopilotAgentIdentity | null;
            }>;
            reload(): Promise<{
                agents: CopilotAgentIdentity[];
            }>;
        };
    };
}
interface HookInvocation {
    sessionId: string;
}
interface HookBaseInput {
    sessionId: string;
    workingDirectory: string;
}
interface ToolHookInput extends HookBaseInput {
    toolName: string;
    toolArgs: unknown;
}
interface PostToolHookInput extends ToolHookInput {
    toolResult?: unknown;
}
interface PostToolFailureHookInput extends ToolHookInput {
    error?: string;
}
interface UserPromptHookInput extends HookBaseInput {
    prompt?: string;
}
interface PreToolDecision {
    permissionDecision: "allow" | "deny";
    permissionDecisionReason?: string;
}
/** Hook callbacks installed into the Copilot extension session. */
export interface CopilotCoordinatorHooks {
    onUserPromptSubmitted(input: UserPromptHookInput, invocation: HookInvocation): Promise<void>;
    onPreToolUse(input: ToolHookInput, invocation: HookInvocation): Promise<PreToolDecision | void>;
    onPostToolUse(input: PostToolHookInput, invocation: HookInvocation): Promise<void>;
    onPostToolUseFailure(input: PostToolFailureHookInput, invocation: HookInvocation): Promise<void>;
}
/** Stateful guard plus host-event observer used by the Copilot extension. */
export interface CopilotCoordinatorGuard {
    hooks: CopilotCoordinatorHooks;
    refresh(): Promise<void>;
    observeEvent(event: {
        type?: string;
        agentId?: string;
        data?: {
            agentName?: string;
            error?: unknown;
            result?: unknown;
            success?: boolean;
            toolCallId?: string;
            toolName?: string;
            toolDescription?: {
                name?: string;
            };
            tools?: string[] | null;
        };
    }): void;
}
/** Maps stable Harbor role IDs to Copilot's plugin-qualified runtime IDs. */
export declare const copilotFixedAgentIds: ReadonlyMap<string, string>;
/** Lists canonical active project profile IDs without trusting arbitrary files. */
export declare function listCopilotActiveProfileIds(project: string): string[];
/** Resolves one logical ID to exactly one currently invocable Copilot identity. */
export declare function resolveCopilotPlayer(id: string, agents: readonly CopilotAgentIdentity[], project: string): CopilotAgentIdentity;
/**
 * Enforce the team-lead contract around Copilot's native synchronous `task`
 * tool. The host remains responsible for the child lifecycle and result.
 */
export declare function createCopilotCoordinatorGuard(getSession: () => CopilotCoordinatorSession, evidenceHook?: HarborEvidenceHook): CopilotCoordinatorGuard;
export {};
