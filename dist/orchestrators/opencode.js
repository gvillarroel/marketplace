import { GhResolver } from "../core/github.js";
import { trustedSkills } from "../core/defaults.js";
import { emitHarborEvidence, fingerprintHarborEvidence } from "../core/evidence.js";
import { composeContractPrompt, openCodeToolPolicy } from "../core/profiles.js";
import { loadConfiguredSkills, withLoadedSkillGuidance } from "../core/skills.js";
/** Executes each OpenCode delegation or contract in one disposable session. */
export class OpenCodeOrchestrator {
    client;
    directory;
    github;
    evidenceHook;
    harness = "opencode";
    constructor(client, directory, github = new GhResolver(), evidenceHook) {
        this.client = client;
        this.directory = directory;
        this.github = github;
        this.evidenceHook = evidenceHook;
    }
    /** Runs an exact named OpenCode agent using an explicit inherited model. */
    async runAgent(agent, task, parentID, model, signal) {
        signal?.throwIfAborted();
        if (!agent.trim())
            throw new Error("OpenCode agent id is required");
        if (!task.trim())
            throw new Error(`OpenCode agent ${agent} requires a non-empty task`);
        if (!model?.providerID.trim() || !model.modelID.trim())
            throw new Error(`OpenCode agent ${agent} requires an explicit model`);
        return this.runChildLifecycle({
            evidenceBase: { harness: this.harness, agent, runtimeAgent: agent, parentSessionId: parentID },
            title: `Harbor agent: ${agent}`,
            task,
            buildPromptBody: () => ({
                agent,
                model: { providerID: model.providerID, modelID: model.modelID },
                ...(model.variant === undefined ? {} : { variant: model.variant }),
                parts: [{ type: "text", text: task }],
            }),
            signal,
        });
    }
    /** Runs one portable contract using a closed OpenCode tool policy. */
    async run(definition, signal) {
        signal?.throwIfAborted();
        const loaded = await loadConfiguredSkills(definition, this.directory, this.github, trustedSkills, signal);
        definition = withLoadedSkillGuidance(definition, loaded);
        signal?.throwIfAborted();
        const agent = definition.tools.some((tool) => tool === "edit" || tool === "execute") ? "general" : "explore";
        return this.runChildLifecycle({
            evidenceBase: { harness: this.harness, agent: definition.name, runtimeAgent: agent },
            title: `Harbor contract: ${definition.name}`,
            task: definition.task,
            buildPromptBody: () => ({
                agent,
                tools: openCodeToolPolicy(definition.tools),
                parts: [{ type: "text", text: composeContractPrompt(definition) }],
            }),
            signal,
        });
    }
    /** Owns the complete create/prompt/evidence/cleanup lifecycle for one disposable child. */
    async runChildLifecycle({ evidenceBase, title, task, buildPromptBody, signal, }) {
        emitHarborEvidence(this.evidenceHook, {
            ...evidenceBase,
            phase: "target.resolved",
            outcome: "ok",
            task: fingerprintHarborEvidence(task),
        });
        let id;
        try {
            const created = await this.client.session.create({
                // OpenAI Codex OAuth rejects the `metadata` OpenCode derives from parented sessions.
                // The synchronous tool call and evidence hook already provide exact correlation.
                body: { title },
                query: { directory: this.directory },
                signal,
                throwOnError: true,
            });
            if (!created.data?.id)
                throw new Error("OpenCode SDK did not create a child session");
            id = created.data.id;
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
        emitHarborEvidence(this.evidenceHook, { ...evidenceBase, phase: "child.started", outcome: "ok", childId: id });
        let failed = false;
        let failure;
        let output = "";
        try {
            emitHarborEvidence(this.evidenceHook, { ...evidenceBase, phase: "prompt.attempted", outcome: "ok", childId: id });
            const result = await this.client.session.prompt({
                path: { id }, query: { directory: this.directory }, signal, throwOnError: true,
                body: buildPromptBody(),
            });
            output = result.data.parts.filter((part) => part.type === "text").map((part) => part.text).join("\n");
            if (!output.trim())
                throw new Error(`OpenCode child ${evidenceBase.agent} returned empty evidence`);
            emitHarborEvidence(this.evidenceHook, {
                ...evidenceBase,
                phase: "evidence.returned",
                outcome: "ok",
                childId: id,
                evidence: fingerprintHarborEvidence(output),
            });
            emitHarborEvidence(this.evidenceHook, { ...evidenceBase, phase: "child.completed", outcome: "ok", childId: id });
        }
        catch (error) {
            failed = true;
            failure = error;
            emitHarborEvidence(this.evidenceHook, {
                ...evidenceBase,
                phase: "child.failed",
                outcome: "error",
                childId: id,
                error: fingerprintHarborEvidence(String(error)),
            });
        }
        finally {
            // Deleting the child is part of correctness, not best-effort telemetry;
            // execution and cleanup failures are therefore reported together.
            let cleanupError;
            try {
                const removed = await this.client.session.delete({ path: { id }, query: { directory: this.directory }, throwOnError: true });
                if (removed.data !== true)
                    throw new Error(`OpenCode SDK did not delete child session ${id}`);
            }
            catch (error) {
                cleanupError = error;
            }
            emitHarborEvidence(this.evidenceHook, {
                ...evidenceBase,
                phase: "child.cleaned",
                outcome: cleanupError === undefined ? "ok" : "error",
                childId: id,
                ...(cleanupError === undefined ? {} : { error: fingerprintHarborEvidence(String(cleanupError)) }),
            });
            if (cleanupError !== undefined) {
                if (failed)
                    throw new AggregateError([failure, cleanupError], `OpenCode child execution and cleanup failed: ${failure instanceof Error ? failure.message : String(failure)}`);
                throw cleanupError;
            }
        }
        if (failed)
            throw failure;
        return output;
    }
}
