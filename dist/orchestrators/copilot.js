import { CopilotClient, approveAll } from "@github/copilot-sdk";
import { GhResolver, materializeGithubSkills } from "../core/github.js";
import { trustedSkills } from "../core/defaults.js";
import { emitHarborEvidence, fingerprintHarborEvidence } from "../core/evidence.js";
import { composePlayerInstructions, nativeTools } from "../core/profiles.js";
export class CopilotOrchestrator {
    createClient;
    directory;
    github;
    evidenceHook;
    harness = "copilot";
    constructor(createClient = () => new CopilotClient(), directory = process.cwd(), github = new GhResolver(), evidenceHook) {
        this.createClient = createClient;
        this.directory = directory;
        this.github = github;
        this.evidenceHook = evidenceHook;
    }
    async run(definition, signal) {
        signal?.throwIfAborted();
        definition = await materializeGithubSkills(definition, this.github, trustedSkills, signal);
        signal?.throwIfAborted();
        const evidenceBase = { harness: this.harness, agent: definition.name, runtimeAgent: definition.name };
        emitHarborEvidence(this.evidenceHook, {
            ...evidenceBase,
            phase: "target.resolved",
            outcome: "ok",
            task: fingerprintHarborEvidence(definition.task),
        });
        let client;
        let session;
        let abort;
        let abortPromise;
        let failed = false;
        let failure;
        let output = "";
        try {
            client = this.createClient();
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
            emitHarborEvidence(this.evidenceHook, {
                ...evidenceBase,
                phase: "child.started",
                outcome: "ok",
                childId: session.sessionId,
            });
            abort = () => { abortPromise ??= session?.abort(); };
            signal?.addEventListener("abort", abort, { once: true });
            if (signal?.aborted)
                await session.abort();
            signal?.throwIfAborted();
            emitHarborEvidence(this.evidenceHook, {
                ...evidenceBase,
                phase: "prompt.attempted",
                outcome: "ok",
                childId: session.sessionId,
            });
            const response = await session.sendAndWait({ prompt: definition.task });
            signal?.throwIfAborted();
            output = response?.data.content ?? "";
            if (!output.trim())
                throw new Error(`Copilot child ${definition.name} returned empty evidence`);
            emitHarborEvidence(this.evidenceHook, {
                ...evidenceBase,
                phase: "evidence.returned",
                outcome: "ok",
                childId: session.sessionId,
                evidence: fingerprintHarborEvidence(output),
            });
            emitHarborEvidence(this.evidenceHook, {
                ...evidenceBase,
                phase: "child.completed",
                outcome: "ok",
                childId: session.sessionId,
            });
        }
        catch (error) {
            failed = true;
            failure = error;
            emitHarborEvidence(this.evidenceHook, {
                ...evidenceBase,
                phase: "child.failed",
                outcome: "error",
                childId: session?.sessionId,
                error: fingerprintHarborEvidence(String(error)),
            });
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
            if (client) {
                try {
                    await client.stop();
                }
                catch (error) {
                    cleanupErrors.push(error);
                }
            }
            if (session) {
                const cleanupError = cleanupErrors.length === 0
                    ? undefined
                    : cleanupErrors.length === 1 ? cleanupErrors[0] : new AggregateError(cleanupErrors, "Copilot child cleanup failed");
                emitHarborEvidence(this.evidenceHook, {
                    ...evidenceBase,
                    phase: "child.cleaned",
                    outcome: cleanupError === undefined ? "ok" : "error",
                    childId: session.sessionId,
                    ...(cleanupError === undefined ? {} : { error: fingerprintHarborEvidence(String(cleanupError)) }),
                });
            }
            if (failed && cleanupErrors.length) {
                throw new AggregateError([failure, ...cleanupErrors], `Copilot child execution and cleanup failed: ${failure instanceof Error ? failure.message : String(failure)}`);
            }
            if (!failed && cleanupErrors.length)
                throw cleanupErrors.length === 1 ? cleanupErrors[0] : new AggregateError(cleanupErrors, "Copilot child cleanup failed");
        }
        if (failed)
            throw failure;
        return output;
    }
}
