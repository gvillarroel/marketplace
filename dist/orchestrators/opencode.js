import { GhResolver, materializeGithubSkills } from "../core/github.js";
import { trustedSkills } from "../core/defaults.js";
import { composeContractPrompt, openCodeToolPolicy } from "../core/profiles.js";
export class OpenCodeOrchestrator {
    client;
    directory;
    github;
    harness = "opencode";
    constructor(client, directory, github = new GhResolver()) {
        this.client = client;
        this.directory = directory;
        this.github = github;
    }
    async run(definition, signal) {
        signal?.throwIfAborted();
        definition = await materializeGithubSkills(definition, this.github, trustedSkills, signal);
        signal?.throwIfAborted();
        const agent = definition.tools.some((tool) => tool === "edit" || tool === "execute") ? "general" : "explore";
        const created = await this.client.session.create({
            body: { title: `Harbor contract: ${definition.name}` },
            query: { directory: this.directory },
            signal,
            throwOnError: true,
        });
        if (!created.data?.id)
            throw new Error("OpenCode SDK did not create a child session");
        const id = created.data.id;
        let failed = false;
        try {
            const result = await this.client.session.prompt({
                path: { id }, query: { directory: this.directory }, signal, throwOnError: true,
                body: {
                    agent,
                    tools: openCodeToolPolicy(definition.tools),
                    parts: [{ type: "text", text: composeContractPrompt(definition) }],
                },
            });
            return result.data.parts.filter((part) => part.type === "text").map((part) => part.text).join("\n");
        }
        catch (error) {
            failed = true;
            throw error;
        }
        finally {
            try {
                const removed = await this.client.session.delete({ path: { id }, query: { directory: this.directory }, throwOnError: true });
                if (removed.data !== true)
                    throw new Error(`OpenCode SDK did not delete child session ${id}`);
            }
            catch (cleanupError) {
                if (!failed)
                    throw cleanupError;
            }
        }
    }
}
