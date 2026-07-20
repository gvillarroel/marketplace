import { CopilotClient, approveAll } from "@github/copilot-sdk";
import type { CopilotSession } from "@github/copilot-sdk";
import type { ContractDefinition, GithubResolver, Orchestrator } from "../core/types.js";
import { GhResolver, materializeGithubSkills } from "../core/github.js";
import { trustedSkills } from "../core/defaults.js";
import { composePlayerInstructions, nativeTools } from "../core/profiles.js";

export class CopilotOrchestrator implements Orchestrator {
  readonly harness = "copilot" as const;
  constructor(
    private readonly createClient: () => CopilotClient = () => new CopilotClient(),
    private readonly directory = process.cwd(),
    private readonly github: GithubResolver = new GhResolver(),
  ) {}
  async run(definition: ContractDefinition, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    definition = await materializeGithubSkills(definition, this.github, trustedSkills, signal);
    signal?.throwIfAborted();
    const client = this.createClient();
    let session: CopilotSession | undefined;
    let abort: (() => void) | undefined;
    let abortPromise: Promise<void> | undefined;
    let failed = false;
    try {
      session = await client.createSession({
        model: definition.model ?? "auto",
        workingDirectory: this.directory,
        customAgents: [{
          name: definition.name,
          displayName: definition.name,
          description: definition.description,
          prompt: composePlayerInstructions(definition),
          tools: nativeTools("copilot", definition.tools),
        }],
        agent: definition.name,
        onPermissionRequest: approveAll,
      });
      abort = () => { abortPromise ??= session?.abort(); };
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) await session.abort();
      signal?.throwIfAborted();
      const response = await session.sendAndWait({ prompt: definition.task });
      signal?.throwIfAborted();
      return response?.data.content ?? "";
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      const cleanupErrors: unknown[] = [];
      if (abort) signal?.removeEventListener("abort", abort);
      if (abortPromise) {
        try { await abortPromise; } catch (error) { cleanupErrors.push(error); }
      }
      if (session) {
        try { await client.deleteSession(session.sessionId); } catch (error) { cleanupErrors.push(error); }
      }
      try { await client.stop(); } catch (error) { cleanupErrors.push(error); }
      if (!failed && cleanupErrors.length) throw cleanupErrors.length === 1 ? cleanupErrors[0] : new AggregateError(cleanupErrors, "Copilot child cleanup failed");
    }
  }
}
