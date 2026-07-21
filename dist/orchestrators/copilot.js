/** One-child Copilot SDK orchestration with isolated skills and full cleanup. */
import { CopilotClient, approveAll } from "@github/copilot-sdk";
import { GhResolver } from "../core/github.js";
import { trustedSkills } from "../core/defaults.js";
import { boundHarborEvidence, emitHarborEvidence, fingerprintHarborEvidence, } from "../core/evidence.js";
import { composePlayerInstructions, nativeTools } from "../core/profiles.js";
import { createSkillCapsule } from "../core/skills.js";
function boundedTimeout(value, fallback) {
    return typeof value === "number" && Number.isFinite(value) && value >= 1
        ? Math.min(600_000, Math.floor(value))
        : fallback;
}
class CopilotOperationDeadlineError extends Error {
    operation;
    timeoutMs;
    constructor(operation, timeoutMs) {
        super(`${operation} exceeded its ${timeoutMs}ms deadline`);
        this.operation = operation;
        this.timeoutMs = timeoutMs;
        this.name = "CopilotOperationDeadlineError";
    }
}
function withDeadline(label, operation, timeoutMs) {
    return new Promise((resolvePromise, reject) => {
        const timer = setTimeout(() => {
            reject(new CopilotOperationDeadlineError(label, timeoutMs));
        }, timeoutMs);
        timer.unref?.();
        operation.then((value) => { clearTimeout(timer); resolvePromise(value); }, (error) => { clearTimeout(timer); reject(error); });
    });
}
function withAbortSignal(operation, signal) {
    if (!signal)
        return operation;
    signal.throwIfAborted();
    return new Promise((resolvePromise, reject) => {
        const aborted = () => reject(signal.reason ?? new Error("Copilot child was aborted"));
        signal.addEventListener("abort", aborted, { once: true });
        operation.then((value) => { signal.removeEventListener("abort", aborted); resolvePromise(value); }, (error) => { signal.removeEventListener("abort", aborted); reject(error); });
    });
}
async function attemptBoundedCleanup(errors, label, operation, timeoutMs) {
    try {
        await withDeadline(label, Promise.resolve().then(operation), timeoutMs);
    }
    catch (error) {
        errors.push(error);
    }
}
/** Executes invocation-scoped contracts through the Copilot SDK. */
export class CopilotOrchestrator {
    createClient;
    directory;
    github;
    evidenceHook;
    options;
    harness = "copilot";
    lateCleanupLedger = new Set();
    constructor(createClient = () => new CopilotClient(), directory = process.cwd(), github = new GhResolver(), evidenceHook, options = {}) {
        this.createClient = createClient;
        this.directory = directory;
        this.github = github;
        this.evidenceHook = evidenceHook;
        this.options = options;
    }
    observeLateCleanup(operation) {
        let observed;
        observed = operation
            .catch(() => undefined)
            .finally(() => { this.lateCleanupLedger.delete(observed); });
        if (this.lateCleanupLedger.size >= 32) {
            const oldest = this.lateCleanupLedger.values().next().value;
            if (oldest)
                this.lateCleanupLedger.delete(oldest);
        }
        this.lateCleanupLedger.add(observed);
        void observed;
    }
    /**
     * Creates exactly one custom-agent session, returns its non-empty evidence,
     * and always deletes the session, stops the client, and removes its capsule.
     */
    async run(definition, signal) {
        const operationTimeoutMs = boundedTimeout(this.options.operationTimeoutMs, 180_000);
        const cleanupTimeoutMs = boundedTimeout(this.options.cleanupTimeoutMs, 10_000);
        const abortTimeoutMs = boundedTimeout(this.options.abortTimeoutMs, cleanupTimeoutMs);
        signal?.throwIfAborted();
        const capsule = await createSkillCapsule(definition, this.directory, this.github, trustedSkills, signal);
        const evidenceBase = { harness: this.harness, agent: definition.name, runtimeAgent: definition.name };
        emitHarborEvidence(this.evidenceHook, {
            ...evidenceBase,
            phase: "target.resolved",
            outcome: "ok",
            task: fingerprintHarborEvidence(definition.task),
        });
        let client;
        let session;
        let createSessionPromise;
        let abort;
        let abortPromise;
        let failed = false;
        let failure;
        let output = "";
        try {
            signal?.throwIfAborted();
            client = this.createClient();
            createSessionPromise = Promise.resolve().then(() => client.createSession({
                model: definition.model ?? "auto",
                workingDirectory: this.directory,
                enableConfigDiscovery: false,
                enableSkills: capsule.skills.length > 0,
                skillDirectories: capsule.root ? [capsule.root] : [],
                customAgents: [{
                        name: definition.name,
                        displayName: definition.name,
                        description: definition.description,
                        prompt: composePlayerInstructions(definition),
                        tools: nativeTools("copilot", definition.tools),
                        skills: capsule.skills.map((skill) => skill.reference.name),
                    }],
                agent: definition.name,
                onPermissionRequest: approveAll,
            }));
            session = await withAbortSignal(withDeadline("Copilot child session creation", createSessionPromise, operationTimeoutMs), signal);
            emitHarborEvidence(this.evidenceHook, {
                ...evidenceBase,
                phase: "child.started",
                outcome: "ok",
                childId: session.sessionId,
            });
            abort = () => {
                if (!session || abortPromise)
                    return;
                abortPromise = Promise.resolve().then(() => session.abort());
                // The bounded cleanup path observes this rejection. Attach an early
                // handler so an immediate SDK rejection is never reported unhandled.
                void abortPromise.catch(() => undefined);
            };
            signal?.addEventListener("abort", abort, { once: true });
            if (signal?.aborted)
                abort();
            signal?.throwIfAborted();
            emitHarborEvidence(this.evidenceHook, {
                ...evidenceBase,
                phase: "prompt.attempted",
                outcome: "ok",
                childId: session.sessionId,
            });
            const response = await withAbortSignal(withDeadline("Copilot child prompt", session.sendAndWait({ prompt: definition.task }), operationTimeoutMs), signal);
            signal?.throwIfAborted();
            output = boundHarborEvidence(response?.data.content ?? "").text;
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
            abort?.();
            emitHarborEvidence(this.evidenceHook, {
                ...evidenceBase,
                phase: "child.failed",
                outcome: "error",
                childId: session?.sessionId,
                error: fingerprintHarborEvidence(String(error)),
            });
        }
        finally {
            // Cleanup errors remain observable. If execution also failed, preserve
            // both causes in one AggregateError instead of masking either failure.
            const cleanupErrors = [];
            if (abort)
                signal?.removeEventListener("abort", abort);
            // A local deadline/abort can win while the SDK is still creating a
            // session. Give that raw promise one bounded cleanup grace period so a
            // late child can be claimed and deleted before the transport is stopped.
            if (!session && createSessionPromise) {
                try {
                    session = await withDeadline("Copilot late child session settlement", createSessionPromise, cleanupTimeoutMs);
                    abortPromise = Promise.resolve().then(() => session.abort());
                    void abortPromise.catch(() => undefined);
                }
                catch (error) {
                    if (error instanceof CopilotOperationDeadlineError) {
                        cleanupErrors.push(error);
                        const lateClient = client;
                        const lateCreation = createSessionPromise;
                        this.observeLateCleanup(lateCreation.then(async (lateSession) => {
                            const lateErrors = [];
                            await attemptBoundedCleanup(lateErrors, "Copilot late child abort", () => lateSession.abort(), abortTimeoutMs);
                            await attemptBoundedCleanup(lateErrors, "Copilot late child session deletion", () => lateClient.deleteSession(lateSession.sessionId), cleanupTimeoutMs);
                            await attemptBoundedCleanup(lateErrors, "Copilot late client stop", () => lateClient.stop(), cleanupTimeoutMs);
                            const lateCleanupError = lateErrors.length === 0
                                ? undefined
                                : lateErrors.length === 1
                                    ? lateErrors[0]
                                    : new AggregateError(lateErrors, "Copilot late child cleanup failed");
                            emitHarborEvidence(this.evidenceHook, {
                                ...evidenceBase,
                                phase: "child.cleaned",
                                outcome: lateCleanupError === undefined ? "ok" : "error",
                                childId: lateSession.sessionId,
                                ...(lateCleanupError === undefined
                                    ? {}
                                    : { error: fingerprintHarborEvidence(String(lateCleanupError)) }),
                            });
                        }));
                    }
                    // A provider rejection creates no session and is already represented
                    // by the primary execution failure; do not relabel it as cleanup.
                }
            }
            // Keep transport teardown ordered. Each phase has its own deadline, and
            // a failed phase never prevents the following one from being attempted.
            if (abortPromise) {
                await attemptBoundedCleanup(cleanupErrors, "Copilot child abort", () => abortPromise, abortTimeoutMs);
            }
            if (session) {
                await attemptBoundedCleanup(cleanupErrors, "Copilot child session deletion", () => client.deleteSession(session.sessionId), cleanupTimeoutMs);
            }
            if (client) {
                await attemptBoundedCleanup(cleanupErrors, "Copilot client stop", () => client.stop(), cleanupTimeoutMs);
            }
            await attemptBoundedCleanup(cleanupErrors, "Copilot skill capsule cleanup", () => capsule.cleanup(), cleanupTimeoutMs);
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
