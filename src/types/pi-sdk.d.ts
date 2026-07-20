declare module "@earendil-works/pi-coding-agent" {
  export interface ExtensionCommandContext {
    cwd: string;
    ui: { notify(message: string, level: "info" | "warning" | "error"): void };
  }
  export interface ExtensionAPI {
    registerTool(tool: unknown): void;
    registerCommand(name: string, options: {
      description?: string;
      handler(args: string, context: ExtensionCommandContext): Promise<void>;
    }): void;
  }
  export class SessionManager { static inMemory(cwd?: string): SessionManager }
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
  }): Promise<{ session: AgentSession }>;
}
