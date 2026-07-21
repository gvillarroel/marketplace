/** Pi in-memory child orchestration with a fail-closed skill registry. */
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { GhResolver } from "../core/github.js";
import { trustedSkills } from "../core/defaults.js";
import { emitHarborEvidence, fingerprintHarborEvidence, HarborEvidenceAccumulator, } from "../core/evidence.js";
import { composeContractPrompt, nativeTools } from "../core/profiles.js";
import { createSkillCapsule } from "../core/skills.js";
const piCleanupTimeoutMs = 1_000;
function pathKey(path) {
    const absolute = resolve(path);
    return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}
function latestAssistantEvidence(messages) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (!message || typeof message !== "object" || message.role !== "assistant")
            continue;
        const content = message.content;
        if (!Array.isArray(content))
            continue;
        const evidence = new HarborEvidenceAccumulator();
        for (const part of content) {
            if (part?.type === "text" && typeof part.text === "string")
                evidence.append(part.text);
        }
        const result = evidence.result();
        if (result.text.trim())
            return result;
    }
    return undefined;
}
function emptyEvidenceDiagnostic(messages) {
    const assistants = messages.filter((message) => message?.role === "assistant");
    const last = assistants.at(-1);
    const contentTypes = Array.isArray(last?.content)
        ? last.content.map((part) => typeof part?.type === "string" ? part.type : "unknown")
        : [];
    return JSON.stringify({
        messages: messages.length,
        assistants: assistants.length,
        stopReason: typeof last?.stopReason === "string" ? last.stopReason : undefined,
        error: typeof last?.errorMessage === "string" ? last.errorMessage.slice(0, 500) : undefined,
        contentTypes,
    });
}
function assertIsolatedSkills(result, expectedSkills) {
    // Pi's loader remains the parser of record, but every discovered name and
    // physical file must exactly match the invocation capsule allowlist.
    if (result.diagnostics.length) {
        const details = result.diagnostics.map((diagnostic) => `${diagnostic.type}: ${diagnostic.message}${diagnostic.path ? ` (${diagnostic.path})` : ""}`).join("; ");
        throw new Error(`Pi rejected the isolated skill capsule diagnostics: ${details}`);
    }
    const expectedByName = new Map(expectedSkills.map((skill) => [skill.reference.name, pathKey(skill.filePath)]));
    if (expectedByName.size !== expectedSkills.length)
        throw new Error("Pi isolated skill capsule contains duplicate names");
    if (result.skills.length !== expectedByName.size) {
        throw new Error(`Pi isolated skill allowlist mismatch: expected ${expectedByName.size}, discovered ${result.skills.length}`);
    }
    const seen = new Set();
    const isolated = result.skills.map((skill) => {
        const expectedPath = expectedByName.get(skill.name);
        if (expectedPath === undefined || pathKey(skill.filePath) !== expectedPath || seen.has(skill.name)) {
            throw new Error(`Pi discovered a skill outside the configured allowlist: ${skill.name}`);
        }
        seen.add(skill.name);
        return { ...skill, disableModelInvocation: false };
    });
    if (seen.size !== expectedByName.size)
        throw new Error("Pi did not discover every configured skill");
    return isolated;
}
async function boundedPiCleanup(label, promise) {
    let timer;
    try {
        await Promise.race([
            promise,
            new Promise((_resolve, reject) => {
                timer = setTimeout(() => reject(new Error(`${label} timed out after ${piCleanupTimeoutMs}ms`)), piCleanupTimeoutMs);
            }),
        ]);
    }
    finally {
        if (timer)
            clearTimeout(timer);
    }
}
async function cleanupCapsuleAfterPreparationFailure(capsule, failure) {
    try {
        await boundedPiCleanup("Pi skill capsule cleanup", capsule.cleanup());
    }
    catch (cleanupError) {
        throw new AggregateError([failure, cleanupError], `Pi child preparation and skill capsule cleanup failed: ${failure instanceof Error ? failure.message : String(failure)}`);
    }
    throw failure;
}
function isCancellation(error, signal) {
    return signal?.aborted === true || (error instanceof Error && error.name === "AbortError");
}
async function promptWithAbort(promise, signal) {
    if (!signal)
        return promise;
    signal.throwIfAborted();
    let abortListener;
    const aborted = new Promise((_resolve, reject) => {
        const fail = () => reject(signal.reason instanceof Error
            ? signal.reason
            : new DOMException("Pi child prompt cancelled", "AbortError"));
        abortListener = fail;
        signal.addEventListener("abort", fail, { once: true });
    });
    try {
        return await Promise.race([promise, aborted]);
    }
    finally {
        if (abortListener)
            signal.removeEventListener("abort", abortListener);
    }
}
function observe(observer, action) {
    if (!observer)
        return;
    try {
        action(observer);
    }
    catch { /* Telemetry must never alter child execution. */ }
}
/** Executes each contract in one isolated, in-memory Pi SDK session. */
export class PiOrchestrator {
    directory;
    loadSdk;
    additionalTools;
    github;
    customTools;
    evidenceHook;
    sessionOptions;
    runObserver;
    harness = "pi";
    constructor(directory = process.cwd(), loadSdk = () => import("@earendil-works/pi-coding-agent"), additionalTools = [], github = new GhResolver(), customTools = [], evidenceHook, sessionOptions = {}, runObserver) {
        this.directory = directory;
        this.loadSdk = loadSdk;
        this.additionalTools = additionalTools;
        this.github = github;
        this.customTools = customTools;
        this.evidenceHook = evidenceHook;
        this.sessionOptions = sessionOptions;
        this.runObserver = runObserver;
    }
    /**
     * Loads only the invocation capsule, creates one child, captures text
     * evidence, and disposes every session/capsule resource on all exit paths.
     */
    async run(definition, signal) {
        let capsule;
        try {
            signal?.throwIfAborted();
            capsule = await createSkillCapsule(definition, this.directory, this.github, trustedSkills, signal);
        }
        catch (error) {
            observe(this.runObserver, (observer) => observer.state(isCancellation(error, signal) ? "cancelled" : "failed"));
            throw error;
        }
        const evidenceBase = { harness: this.harness, agent: definition.name, runtimeAgent: definition.name };
        emitHarborEvidence(this.evidenceHook, {
            ...evidenceBase,
            phase: "target.resolved",
            outcome: "ok",
            task: fingerprintHarborEvidence(definition.task),
        });
        let session;
        try {
            signal?.throwIfAborted();
            const sdk = await this.loadSdk();
            signal?.throwIfAborted();
            const agentDir = sdk.getAgentDir();
            const skillPaths = capsule.skills.map((skill) => skill.filePath);
            const resourceLoader = new sdk.DefaultResourceLoader({
                cwd: this.directory,
                agentDir,
                additionalSkillPaths: skillPaths,
                noExtensions: true,
                noSkills: true,
                noPromptTemplates: true,
                noThemes: true,
                noContextFiles: true,
                skillsOverride: (base) => ({
                    skills: assertIsolatedSkills(base, capsule.skills),
                    diagnostics: [],
                }),
            });
            await resourceLoader.reload();
            signal?.throwIfAborted();
            assertIsolatedSkills(resourceLoader.getSkills(), capsule.skills);
            const providerProjections = this.sessionOptions.providerProjections ?? [];
            const modelRuntime = providerProjections.length
                ? await sdk.ModelRuntime.create({
                    authPath: join(agentDir, "auth.json"),
                    modelsPath: join(agentDir, "models.json"),
                    allowModelNetwork: false,
                })
                : undefined;
            if (modelRuntime) {
                for (const projection of providerProjections) {
                    if (!projection.config)
                        continue;
                    try {
                        modelRuntime.registerProvider(projection.id, projection.config);
                    }
                    catch {
                        throw new Error(`Pi child could not replay registered provider ${projection.id}`);
                    }
                }
                for (const projection of providerProjections) {
                    if (projection.runtimeKey === undefined)
                        continue;
                    try {
                        await modelRuntime.setRuntimeApiKey(projection.id, projection.runtimeKey);
                    }
                    catch {
                        throw new Error(`Pi child could not apply runtime authentication for ${projection.id}`);
                    }
                }
                await modelRuntime.refresh({ allowNetwork: false });
                signal?.throwIfAborted();
            }
            const created = await sdk.createAgentSession({
                cwd: this.directory,
                agentDir,
                sessionManager: sdk.SessionManager.inMemory(this.directory),
                tools: [...new Set([...nativeTools("pi", definition.tools), ...this.additionalTools, ...this.customTools.map((tool) => tool.name)])],
                customTools: [...this.customTools],
                ...(this.sessionOptions.model === undefined ? {} : { model: this.sessionOptions.model }),
                ...(this.sessionOptions.thinkingLevel === undefined ? {} : { thinkingLevel: this.sessionOptions.thinkingLevel }),
                ...(modelRuntime === undefined ? {} : { modelRuntime }),
                resourceLoader,
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
            observe(this.runObserver, (observer) => observer.state("cleaning"));
            try {
                return await cleanupCapsuleAfterPreparationFailure(capsule, error);
            }
            catch (finalError) {
                const cleanupFailed = finalError instanceof AggregateError && finalError.message.startsWith("Pi child preparation and skill capsule cleanup failed:");
                observe(this.runObserver, (observer) => observer.state(cleanupFailed ? "cleanup-error" : isCancellation(error, signal) ? "cancelled" : "failed"));
                throw finalError;
            }
        }
        const sessionIdentity = session;
        const childId = typeof sessionIdentity.sessionId === "string"
            ? sessionIdentity.sessionId
            : this.evidenceHook ? `pi-hook:${randomUUID()}` : undefined;
        const effectiveSessionModel = session.model ?? this.sessionOptions.model;
        const effectiveThinking = session.thinkingLevel ?? this.sessionOptions.thinkingLevel;
        observe(this.runObserver, (observer) => observer.sessionStarted({
            ...(childId === undefined ? {} : { sessionId: childId }),
            ...(effectiveSessionModel === undefined ? {} : {
                model: { provider: effectiveSessionModel.provider, id: effectiveSessionModel.id },
            }),
            ...(effectiveThinking === undefined ? {} : { thinking: effectiveThinking }),
        }));
        emitHarborEvidence(this.evidenceHook, { ...evidenceBase, phase: "child.started", outcome: "ok", childId });
        let streamedEvidence = new HarborEvidenceAccumulator();
        let output = "";
        let unsubscribe;
        let abortPromise;
        let failed = false;
        let failure;
        let executionState = "completed";
        const abort = () => { abortPromise ??= Promise.resolve().then(() => session.abort()); };
        signal?.addEventListener("abort", abort, { once: true });
        try {
            unsubscribe = session.subscribe((event) => {
                if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
                    streamedEvidence.append(event.assistantMessageEvent.delta);
                }
                if (event.type === "message_end" && event.message?.role === "assistant") {
                    observe(this.runObserver, (observer) => observer.messageEnd(event.message));
                }
            });
            // A signal can fire while the SDK is creating the session, before the
            // listener above exists. Start the same bounded cleanup path without
            // awaiting a provider abort that may never resolve.
            if (signal?.aborted)
                abort();
            signal?.throwIfAborted();
            emitHarborEvidence(this.evidenceHook, { ...evidenceBase, phase: "prompt.attempted", outcome: "ok", childId });
            await promptWithAbort(session.prompt(composeContractPrompt(definition, this.additionalTools)), signal);
            signal?.throwIfAborted();
            // A few providers settle the transcript without emitting a complete
            // message_end stream. Observe the authoritative transcript as a fallback;
            // PiTeamRuntime deduplicates messages already seen through subscribe().
            for (const message of Array.isArray(session.messages) ? session.messages : []) {
                if (message?.role === "assistant")
                    observe(this.runObserver, (observer) => observer.messageEnd(message));
            }
            // Some Pi providers deliver the completed assistant message without
            // emitting text_delta updates. The settled in-memory transcript is the
            // authoritative fallback and remains inside this disposable child.
            const settledEvidence = latestAssistantEvidence(Array.isArray(session.messages) ? session.messages : []);
            output = settledEvidence?.text ?? streamedEvidence.result().text;
            if (!output.trim())
                throw new Error(`Pi child ${definition.name} returned empty evidence: ${emptyEvidenceDiagnostic(session.messages)}`);
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
            executionState = isCancellation(error, signal) ? "cancelled" : "failed";
            emitHarborEvidence(this.evidenceHook, {
                ...evidenceBase,
                phase: "child.failed",
                outcome: "error",
                childId,
                error: fingerprintHarborEvidence(String(error)),
            });
        }
        finally {
            // Preserve all cleanup failures, and combine them with a prompt failure
            // when both occur so callers never receive a misleading single cause.
            // Failure and cancellation paths may still have settled native telemetry
            // even when the provider omitted message_end; capture it before dispose.
            for (const message of Array.isArray(session.messages) ? session.messages : []) {
                if (message?.role === "assistant")
                    observe(this.runObserver, (observer) => observer.messageEnd(message));
            }
            observe(this.runObserver, (observer) => observer.state("cleaning"));
            const cleanupErrors = [];
            signal?.removeEventListener("abort", abort);
            if (abortPromise) {
                try {
                    await boundedPiCleanup("Pi child abort", abortPromise);
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
            try {
                await boundedPiCleanup("Pi skill capsule cleanup", capsule.cleanup());
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
            observe(this.runObserver, (observer) => observer.state(cleanupError === undefined ? executionState : "cleanup-error"));
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
