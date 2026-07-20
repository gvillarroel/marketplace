import { harborContext } from "./shared.js";
import { executeCommand, parseContractDefinition } from "../core/commands.js";
import { trustedSkills } from "../core/defaults.js";
import { GhResolver, materializeGithubSkills } from "../core/github.js";
import { composeContractPrompt } from "../core/profiles.js";
const unavailable = {
    harness: "copilot",
    run: async () => { throw new Error("use Copilot native task after contract preflight"); },
};
export async function runCopilotControl(command, args, cwd = process.cwd(), signal) {
    if (command !== "contract")
        return executeCommand(command, args, harborContext("copilot", cwd, unavailable), signal);
    const definition = await materializeGithubSkills(parseContractDefinition(args), new GhResolver(), trustedSkills, signal);
    const agentType = definition.tools.includes("edit") ? "general-purpose" : definition.tools.includes("execute") ? "task" : "explore";
    return JSON.stringify({ agent_type: agentType, description: definition.description, prompt: composeContractPrompt(definition) });
}
