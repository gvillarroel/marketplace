declare module "@earendil-works/pi-coding-agent" {
  export interface Model {
    readonly id: string;
    readonly provider: string;
    readonly [key: string]: unknown;
  }
  export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  export interface ExtensionContext {
    cwd: string;
    model: Model | undefined;
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
    ui: { notify(message: string, level: "info" | "warning" | "error"): void };
  }
  export interface ExtensionAPI {
    registerTool(tool: unknown): void;
    registerCommand(name: string, options: {
      description?: string;
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
  export interface AgentSession {
    subscribe(handler: (event: unknown) => void): () => void;
    prompt(text: string): Promise<void>;
    abort(): Promise<void>;
    dispose(): void;
  }
  export function createAgentSession(options?: {
    cwd?: string;
    sessionManager?: SessionManager;
    tools?: string[];
    customTools?: ToolDefinition[];
    resourceLoader?: DefaultResourceLoader;
    model?: Model;
    thinkingLevel?: ThinkingLevel;
  }): Promise<{ session: AgentSession }>;
}
