import { CopilotClient, approveAll } from "@github/copilot-sdk";
import { GhResolver, materializeGithubSkills } from "../core/github.js";
import { trustedSkills } from "../core/defaults.js";
import { composePlayerInstructions, nativeTools } from "../core/profiles.js";
export class CopilotOrchestrator {
    createClient;
    directory;
    github;
    harness = "copilot";
    constructor(createClient = () => new CopilotClient(), directory = process.cwd(), github = new GhResolver()) {
        this.createClient = createClient;
        this.directory = directory;
        this.github = github;
    }
    async run(definition, signal) {
        signal?.throwIfAborted();
        definition = await materializeGithubSkills(definition, this.github, trustedSkills, signal);
        signal?.throwIfAborted();
        const client = this.createClient();
        let session;
        let abort;
        let abortPromise;
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
            if (signal?.aborted)
                await session.abort();
            signal?.throwIfAborted();
            const response = await session.sendAndWait({ prompt: definition.task });
            signal?.throwIfAborted();
            return response?.data.content ?? "";
        }
        catch (error) {
            failed = true;
            throw error;
        }
        finally {
            const cleanupErrors = [];
            if (abort)
                signal?.removeEventListener("abort", abort);
            if (abortPromise) {
                try {
                    await abortPromise;
                }
                catch (error) {
                    cleanupErrors.push(error);
                }
            }
            if (session) {
                try {
                    await client.deleteSession(session.sessionId);
                }
                catch (error) {
                    cleanupErrors.push(error);
                }
            }
            try {
                await client.stop();
            }
            catch (error) {
                cleanupErrors.push(error);
            }
            if (!failed && cleanupErrors.length)
                throw cleanupErrors.length === 1 ? cleanupErrors[0] : new AggregateError(cleanupErrors, "Copilot child cleanup failed");
        }
    }
}
