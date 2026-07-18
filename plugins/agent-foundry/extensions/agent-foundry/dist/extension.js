import { CopilotClient, approveAll } from "@github/copilot-sdk";
import { joinSession } from "@github/copilot-sdk/extension";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { materializeSkills, parseDefinition, removePermanentAgent, savePermanentAgent } from "./core.js";
async function listAgents() {
    try {
        return (await readdir(resolve(process.cwd(), ".github", "agents"))).filter((name) => name.endsWith(".md"));
    }
    catch {
        return [];
    }
}
async function runContractor(definition, task) {
    const skills = await materializeSkills(definition.skills ?? []);
    const client = new CopilotClient({ workingDirectory: process.cwd(), logLevel: "error" });
    try {
        await client.start();
        const session = await client.createSession({
            model: definition.model ?? process.env.AGENT_HARBOR_MODEL ?? "gpt-5-mini",
            reasoningEffort: "low",
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
        await client.stop().catch(() => undefined);
        await skills.cleanup();
    }
}
let host;
const log = (message) => host.log(message, { level: "info" });
host = await joinSession({
    commands: [
        { name: "agents", description: "List permanent project agents.", handler: async () => log((await listAgents()).join("\n") || "No permanent agents.") },
        { name: "hire", description: "Create a permanent agent from a JSON definition.", handler: async (ctx) => log(`Created ${await savePermanentAgent(parseDefinition(ctx.args ?? ""))}`) },
        { name: "fire", description: "Remove a permanent project agent by name.", handler: async (ctx) => { await removePermanentAgent(ctx.args ?? ""); await log(`Removed ${(ctx.args ?? "").trim()}`); } },
        { name: "contract", description: "Run a disposable agent. Args: JSON definition, then :: task", handler: async (ctx) => { const [raw, ...task] = (ctx.args ?? "").split("::"); await log(await runContractor(parseDefinition(raw), task.join("::").trim())); } },
    ],
    tools: [
        { name: "agent_hire", description: "Persist a focused virtual agent in this project. Input definition must include name, description, prompt, tools and optional local or GitHub skill sources.", defer: "never", parameters: { type: "object", properties: { definition: { type: "object" } }, required: ["definition"] }, handler: async ({ definition }) => `Created ${await savePermanentAgent(definition)}` },
        { name: "agent_fire", description: "Remove a permanent virtual agent from this project.", defer: "never", parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] }, handler: async ({ name }) => { await removePermanentAgent(name); return `Removed ${name}`; } },
        { name: "agent_contract", description: "Create an isolated temporary Copilot SDK agent, inject only the requested skills, execute one task, then destroy its session and forget it.", defer: "never", parameters: { type: "object", properties: { definition: { type: "object" }, task: { type: "string" } }, required: ["definition", "task"] }, handler: async ({ definition, task }) => runContractor(definition, task) },
    ],
});
