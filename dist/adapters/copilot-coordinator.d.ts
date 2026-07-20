import { type HarborEvidenceHook } from "../core/evidence.js";
export interface CopilotAgentIdentity {
    id: string;
    path?: string;
    userInvocable?: boolean;
}
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
export interface CopilotCoordinatorHooks {
    onUserPromptSubmitted(input: UserPromptHookInput, invocation: HookInvocation): Promise<void>;
    onPreToolUse(input: ToolHookInput, invocation: HookInvocation): Promise<PreToolDecision | void>;
    onPostToolUse(input: PostToolHookInput, invocation: HookInvocation): Promise<void>;
    onPostToolUseFailure(input: PostToolFailureHookInput, invocation: HookInvocation): Promise<void>;
}
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
export declare const copilotFixedAgentIds: ReadonlyMap<string, string>;
export declare function listCopilotActiveProfileIds(project: string): string[];
/** Resolve one logical Harbor ID to the exact Copilot agent exposed by the host. */
export declare function resolveCopilotPlayer(id: string, agents: readonly CopilotAgentIdentity[], project: string): CopilotAgentIdentity;
/**
 * Enforce the team-lead contract around Copilot's native synchronous `task`
 * tool. The host remains responsible for the child lifecycle and result.
 */
export declare function createCopilotCoordinatorGuard(getSession: () => CopilotCoordinatorSession, evidenceHook?: HarborEvidenceHook): CopilotCoordinatorGuard;
export {};
