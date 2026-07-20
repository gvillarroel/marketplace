import { GhResolver, materializeGithubSkills } from "../core/github.js";
import { trustedSkills } from "../core/defaults.js";
import { composeContractPrompt, nativeTools } from "../core/profiles.js";
export class PiOrchestrator {
    directory;
    loadSdk;
    additionalTools;
    github;
    harness = "pi";
    constructor(directory = process.cwd(), loadSdk = () => import("@earendil-works/pi-coding-agent"), additionalTools = [], github = new GhResolver()) {
        this.directory = directory;
        this.loadSdk = loadSdk;
        this.additionalTools = additionalTools;
        this.github = github;
    }
    async run(definition, signal) {
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
        let unsubscribe;
        let abortPromise;
        const abort = () => { abortPromise ??= session.abort(); };
        signal?.addEventListener("abort", abort, { once: true });
        try {
            unsubscribe = session.subscribe((event) => {
                if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta")
                    output += event.assistantMessageEvent.delta;
            });
            if (signal?.aborted)
                await session.abort();
            signal?.throwIfAborted();
            await session.prompt(composeContractPrompt(definition, this.additionalTools));
            signal?.throwIfAborted();
            return output;
        }
        finally {
            signal?.removeEventListener("abort", abort);
            if (abortPromise)
                await abortPromise.catch(() => undefined);
            unsubscribe?.();
            session.dispose();
        }
    }
}
