/** Copilot MCP-facing command adapter and native `/contract` preflight. */
import { harborContext } from "./shared.js";
import { executeCommand, parseContractDefinition } from "../core/commands.js";
import { trustedSkills } from "../core/defaults.js";
import { GhResolver } from "../core/github.js";
import { composeContractPrompt } from "../core/profiles.js";
import { loadConfiguredSkills, withLoadedSkillGuidance } from "../core/skills.js";
const unavailable = {
    harness: "copilot",
    run: async () => { throw new Error("use Copilot native task after contract preflight"); },
};
/**
 * Runs one Copilot control request.
 *
 * Deterministic controls execute immediately. `/contract` performs all local
 * and remote skill validation, then returns a closed task descriptor for the
 * Copilot extension to invoke exactly once through its native `task` tool.
 */
export async function runCopilotControl(command, args, cwd = process.cwd(), signal) {
    if (command !== "contract")
        return executeCommand(command, args, await harborContext("copilot", cwd, unavailable), signal);
    let definition = parseContractDefinition(args);
    const loaded = await loadConfiguredSkills(definition, cwd, new GhResolver(), trustedSkills, signal);
    definition = withLoadedSkillGuidance(definition, loaded);
    const agentType = definition.tools.includes("edit") ? "general-purpose" : definition.tools.includes("execute") ? "task" : "explore";
    return JSON.stringify({ agent_type: agentType, description: definition.description, prompt: composeContractPrompt(definition) });
}
