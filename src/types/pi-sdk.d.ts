/**
 * Narrow ambient declaration for the Pi SDK surface Agent Harbor consumes.
 * Keeping this contract explicit makes host-version assumptions reviewable
 * without duplicating Pi's complete public type model.
 */
declare module "@earendil-works/pi-coding-agent" {
  export interface Model {
    readonly id: string;
    readonly provider: string;
    readonly maxTokens?: number;
    readonly [key: string]: unknown;
  }
  export interface ProviderConfig {
    readonly [key: string]: unknown;
  }
  export interface ProviderAuthStatus {
    readonly configured: boolean;
    readonly source?: "stored" | "runtime" | "environment" | "fallback" | "models_json_key" | "models_json_command";
    readonly label?: string;
  }
  export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  export interface ExtensionContext {
    cwd: string;
    model: Model | undefined;
    modelRegistry: {
      find(provider: string, modelId: string): Model | undefined;
      getAvailable(): Model[];
      getError(): string | undefined;
      getRegisteredProviderConfig(providerId: string): ProviderConfig | undefined;
      getProviderAuthStatus(providerId: string): ProviderAuthStatus;
      getApiKeyForProvider(providerId: string): Promise<string | undefined>;
      hasConfiguredAuth?(model: Model): boolean;
    };
    mode: "tui" | "rpc" | "json" | "print";
    hasUI: boolean;
    signal: AbortSignal | undefined;
    ui: {
      notify(message: string, level?: "info" | "warning" | "error"): void;
      setStatus(key: string, text: string | undefined): void;
      setWidget(
        key: string,
        content: string[] | undefined,
        options?: { placement?: "aboveEditor" | "belowEditor" },
      ): void;
    };
  }
  export interface ToolDefinition {
    name: string;
    label: string;
    description: string;
    parameters: Record<string, unknown>;
    executionMode?: "sequential" | "parallel";
    execute(
      toolCallId: string,
      params: any,
      signal: AbortSignal | undefined,
      onUpdate: unknown,
      context: ExtensionContext,
    ): Promise<unknown>;
  }
  export interface ExtensionCommandContext extends ExtensionContext {
  }
  export interface AutocompleteItem {
    value: string;
    label: string;
    description?: string;
  }
  export interface ExtensionAPI {
    on(
      event: "session_shutdown",
      handler: (
        event: { type: "session_shutdown"; reason: "quit" | "reload" | "new" | "resume" | "fork"; targetSessionFile?: string },
        context: ExtensionContext,
      ) => Promise<void> | void,
    ): void;
    registerTool(tool: unknown): void;
    registerShortcut(shortcut: string, options: {
      description?: string;
      handler(context: ExtensionContext): Promise<void> | void;
    }): void;
    registerCommand(name: string, options: {
      description?: string;
      getArgumentCompletions?: (
        argumentPrefix: string,
      ) => AutocompleteItem[] | null | Promise<AutocompleteItem[] | null>;
      handler(args: string, context: ExtensionCommandContext): Promise<void>;
    }): void;
    getThinkingLevel(): ThinkingLevel;
  }
  export class SessionManager { static inMemory(cwd?: string): SessionManager }
  export interface ResourceDiagnostic {
    type: "warning" | "error" | "collision";
    message: string;
    path?: string;
  }
  export interface Skill {
    name: string;
    description: string;
    filePath: string;
    baseDir: string;
    sourceInfo: unknown;
    disableModelInvocation: boolean;
  }
  export interface SkillLoadResult {
    skills: Skill[];
    diagnostics: ResourceDiagnostic[];
  }
  export class DefaultResourceLoader {
    constructor(options: {
      cwd: string;
      agentDir: string;
      additionalSkillPaths?: string[];
      noExtensions?: boolean;
      noSkills?: boolean;
      noPromptTemplates?: boolean;
      noThemes?: boolean;
      noContextFiles?: boolean;
      skillsOverride?: (base: SkillLoadResult) => SkillLoadResult;
    });
    getSkills(): SkillLoadResult;
    reload(): Promise<void>;
  }
  export function getAgentDir(): string;
  export class ModelRuntime {
    static create(options?: {
      authPath?: string;
      modelsPath?: string | null;
      allowModelNetwork?: boolean;
    }): Promise<ModelRuntime>;
    registerProvider(providerId: string, config: ProviderConfig): void;
    setRuntimeApiKey(providerId: string, apiKey: string): Promise<void>;
    refresh(options?: { allowNetwork?: boolean }): Promise<unknown>;
  }
  export interface AgentSession {
    readonly model?: Model;
    readonly thinkingLevel?: ThinkingLevel;
    readonly messages: Array<{
      role: string;
      content?: Array<{ type: string; text?: string; thinking?: string }>;
      provider?: string;
      model?: string;
      responseModel?: string;
      responseId?: string;
      usage?: {
        input?: number;
        output?: number;
        reasoning?: number;
        cacheRead?: number;
        cacheWrite?: number;
        totalTokens?: number;
      };
    }>;
    subscribe(handler: (event: unknown) => void): () => void;
    prompt(text: string): Promise<void>;
    abort(): Promise<void>;
    dispose(): void;
  }
  export function createAgentSession(options?: {
    cwd?: string;
    agentDir?: string;
    sessionManager?: SessionManager;
    tools?: string[];
    customTools?: ToolDefinition[];
    resourceLoader?: DefaultResourceLoader;
    modelRuntime?: ModelRuntime;
    model?: Model;
    thinkingLevel?: ThinkingLevel;
  }): Promise<{ session: AgentSession }>;
}
