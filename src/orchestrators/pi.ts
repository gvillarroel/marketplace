import type { ContractDefinition, GithubResolver, Orchestrator } from "../core/types.js";
import { GhResolver, materializeGithubSkills } from "../core/github.js";
import { trustedSkills } from "../core/defaults.js";
import { composeContractPrompt, nativeTools } from "../core/profiles.js";

type PiSdk = typeof import("@earendil-works/pi-coding-agent");

export class PiOrchestrator implements Orchestrator {
  readonly harness = "pi" as const;
  constructor(
    private readonly directory = process.cwd(),
    private readonly loadSdk: () => Promise<PiSdk> = () => import("@earendil-works/pi-coding-agent"),
    private readonly additionalTools: readonly string[] = [],
    private readonly github: GithubResolver = new GhResolver(),
  ) {}
  async run(definition: ContractDefinition, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    definition = await materializeGithubSkills(definition, this.github, trustedSkills, signal);
    signal?.throwIfAborted();
    const sdk = await this.loadSdk();
    const { session } = await sdk.createAgentSession({
      cwd: this.directory,
      sessionManager: sdk.SessionManager.inMemory(this.directory),
      tools: [...new Set([...nativeTools("pi", definition.tools), ...this.additionalTools])],
    });
    let output = "";
    let unsubscribe: (() => void) | undefined;
    let abortPromise: Promise<void> | undefined;
    const abort = () => { abortPromise ??= session.abort(); };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      unsubscribe = session.subscribe((event: any) => {
        if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") output += event.assistantMessageEvent.delta;
      });
      if (signal?.aborted) await session.abort();
      signal?.throwIfAborted();
      await session.prompt(composeContractPrompt(definition, this.additionalTools));
      signal?.throwIfAborted();
      return output;
    } finally {
      signal?.removeEventListener("abort", abort);
      if (abortPromise) await abortPromise.catch(() => undefined);
      unsubscribe?.();
      session.dispose();
    }
  }
}
