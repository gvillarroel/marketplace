import { CopilotClient, RuntimeConnection, approveAll } from "@github/copilot-sdk";
import { materializeSkills, resolveCopilotCliPath } from "./core.js";
export async function runContractor(definition, task) {
    const skills = await materializeSkills(definition.skills ?? []);
    let client;
    try {
        client = new CopilotClient({
            connection: RuntimeConnection.forStdio({ path: resolveCopilotCliPath() }),
            workingDirectory: process.cwd(),
            logLevel: "error",
        });
        await client.start();
        const model = definition.model ?? process.env.AGENT_HARBOR_MODEL ?? "auto";
        const session = await client.createSession({
            model,
            ...(model === "auto" ? {} : { reasoningEffort: "low" }),
            agent: definition.name,
            customAgents: [{
                    name: definition.name,
                    description: definition.description,
                    prompt: definition.prompt,
                    tools: definition.tools ?? [],
                    skills: skills.names,
                }],
            skillDirectories: [skills.root],
            onPermissionRequest: approveAll,
            infiniteSessions: { enabled: false },
            memory: { enabled: false },
            embeddingCacheStorage: "in-memory",
        });
        const response = await session.sendAndWait(task, 120_000);
        await session.disconnect();
        return response?.data?.content ?? "Contractor finished without a text response.";
    }
    finally {
        if (client)
            await client.stop().catch(() => undefined);
        await skills.cleanup();
    }
}
