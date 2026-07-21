import { GhResolver } from "../core/github.js";
import { trustedSkills } from "../core/defaults.js";
import { emitHarborEvidence, fingerprintHarborEvidence } from "../core/evidence.js";
import { composeContractPrompt, openCodeToolPolicy } from "../core/profiles.js";
import { loadConfiguredSkills, withLoadedSkillGuidance } from "../core/skills.js";
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
    async runAgent(agent, task, parentID, model, signal) {
        signal?.throwIfAborted();
        if (!agent.trim())
            throw new Error("OpenCode agent id is required");
        if (!task.trim())
            throw new Error(`OpenCode agent ${agent} requires a non-empty task`);
        if (!model?.providerID.trim() || !model.modelID.trim())
            throw new Error(`OpenCode agent ${agent} requires an explicit model`);
        const evidenceBase = { harness: this.harness, agent, runtimeAgent: agent, parentSessionId: parentID };
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
                body: { title: `Harbor agent: ${agent}` },
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
                body: {
                    agent,
                    model: { providerID: model.providerID, modelID: model.modelID },
                    ...(model.variant === undefined ? {} : { variant: model.variant }),
                    parts: [{ type: "text", text: task }],
                },
            });
            output = result.data.parts.filter((part) => part.type === "text").map((part) => part.text).join("\n");
            if (!output.trim())
                throw new Error(`OpenCode child ${agent} returned empty evidence`);
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
    async run(definition, signal) {
        signal?.throwIfAborted();
        const loaded = await loadConfiguredSkills(definition, this.directory, this.github, trustedSkills, signal);
        definition = withLoadedSkillGuidance(definition, loaded);
        signal?.throwIfAborted();
        const agent = definition.tools.some((tool) => tool === "edit" || tool === "execute") ? "general" : "explore";
        const evidenceBase = { harness: this.harness, agent: definition.name, runtimeAgent: agent };
        emitHarborEvidence(this.evidenceHook, {
            ...evidenceBase,
            phase: "target.resolved",
            outcome: "ok",
            task: fingerprintHarborEvidence(definition.task),
        });
        let id;
        try {
            const created = await this.client.session.create({
                body: { title: `Harbor contract: ${definition.name}` },
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
                body: {
                    agent,
                    tools: openCodeToolPolicy(definition.tools),
                    parts: [{ type: "text", text: composeContractPrompt(definition) }],
                },
            });
            output = result.data.parts.filter((part) => part.type === "text").map((part) => part.text).join("\n");
            if (!output.trim())
                throw new Error(`OpenCode child ${definition.name} returned empty evidence`);
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
