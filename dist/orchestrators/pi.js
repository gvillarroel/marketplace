import { randomUUID } from "node:crypto";
import { GhResolver, materializeGithubSkills } from "../core/github.js";
import { trustedSkills } from "../core/defaults.js";
import { emitHarborEvidence, fingerprintHarborEvidence } from "../core/evidence.js";
import { composeContractPrompt, nativeTools } from "../core/profiles.js";
export class PiOrchestrator {
    directory;
    loadSdk;
    additionalTools;
    github;
    customTools;
    evidenceHook;
    sessionOptions;
    harness = "pi";
    constructor(directory = process.cwd(), loadSdk = () => import("@earendil-works/pi-coding-agent"), additionalTools = [], github = new GhResolver(), customTools = [], evidenceHook, sessionOptions = {}) {
        this.directory = directory;
        this.loadSdk = loadSdk;
        this.additionalTools = additionalTools;
        this.github = github;
        this.customTools = customTools;
        this.evidenceHook = evidenceHook;
        this.sessionOptions = sessionOptions;
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
        let session;
        try {
            const sdk = await this.loadSdk();
            const resourceLoader = sdk.DefaultResourceLoader && sdk.getAgentDir
                ? new sdk.DefaultResourceLoader({
                    cwd: this.directory,
                    agentDir: sdk.getAgentDir(),
                    noExtensions: true,
                    noSkills: true,
                    noPromptTemplates: true,
                    noThemes: true,
                    noContextFiles: true,
                })
                : undefined;
            await resourceLoader?.reload();
            const created = await sdk.createAgentSession({
                cwd: this.directory,
                sessionManager: sdk.SessionManager.inMemory(this.directory),
                tools: [...new Set([...nativeTools("pi", definition.tools), ...this.additionalTools, ...this.customTools.map((tool) => tool.name)])],
                customTools: [...this.customTools],
                ...(this.sessionOptions.model === undefined ? {} : { model: this.sessionOptions.model }),
                ...(this.sessionOptions.thinkingLevel === undefined ? {} : { thinkingLevel: this.sessionOptions.thinkingLevel }),
                ...(resourceLoader ? { resourceLoader } : {}),
            });
            if (!created?.session)
                throw new Error("Pi SDK did not create a child session");
            session = created.session;
        }
        catch (error) {
            emitHarborEvidence(this.evidenceHook, {
                ...evidenceBase,
                phase: "child.failed",
                outcome: "error",
                error: fingerprintHarborEvidence(String(error)),
            });
            throw error;
        }
        const sessionIdentity = session;
        const childId = typeof sessionIdentity.sessionId === "string"
            ? sessionIdentity.sessionId
            : this.evidenceHook ? `pi-hook:${randomUUID()}` : undefined;
        emitHarborEvidence(this.evidenceHook, { ...evidenceBase, phase: "child.started", outcome: "ok", childId });
        let output = "";
        let unsubscribe;
        let abortPromise;
        let failed = false;
        let failure;
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
            emitHarborEvidence(this.evidenceHook, { ...evidenceBase, phase: "prompt.attempted", outcome: "ok", childId });
            await session.prompt(composeContractPrompt(definition, this.additionalTools));
            signal?.throwIfAborted();
            if (!output.trim())
                throw new Error(`Pi child ${definition.name} returned empty evidence`);
            emitHarborEvidence(this.evidenceHook, {
                ...evidenceBase,
                phase: "evidence.returned",
                outcome: "ok",
                childId,
                evidence: fingerprintHarborEvidence(output),
            });
            emitHarborEvidence(this.evidenceHook, { ...evidenceBase, phase: "child.completed", outcome: "ok", childId });
        }
        catch (error) {
            failed = true;
            failure = error;
            emitHarborEvidence(this.evidenceHook, {
                ...evidenceBase,
                phase: "child.failed",
                outcome: "error",
                childId,
                error: fingerprintHarborEvidence(String(error)),
            });
        }
        finally {
            const cleanupErrors = [];
            signal?.removeEventListener("abort", abort);
            if (abortPromise) {
                try {
                    await abortPromise;
                }
                catch (error) {
                    cleanupErrors.push(error);
                }
            }
            try {
                unsubscribe?.();
            }
            catch (error) {
                cleanupErrors.push(error);
            }
            try {
                session.dispose();
            }
            catch (error) {
                cleanupErrors.push(error);
            }
            const cleanupError = cleanupErrors.length === 0
                ? undefined
                : cleanupErrors.length === 1 ? cleanupErrors[0] : new AggregateError(cleanupErrors, "Pi child cleanup failed");
            emitHarborEvidence(this.evidenceHook, {
                ...evidenceBase,
                phase: "child.cleaned",
                outcome: cleanupError === undefined ? "ok" : "error",
                childId,
                ...(cleanupError === undefined ? {} : { error: fingerprintHarborEvidence(String(cleanupError)) }),
            });
            if (failed && cleanupErrors.length) {
                throw new AggregateError([failure, ...cleanupErrors], `Pi child execution and cleanup failed: ${failure instanceof Error ? failure.message : String(failure)}`);
            }
            if (!failed && cleanupErrors.length)
                throw cleanupErrors.length === 1 ? cleanupErrors[0] : new AggregateError(cleanupErrors, "Pi child cleanup failed");
        }
        if (failed)
            throw failure;
        return output;
    }
}
