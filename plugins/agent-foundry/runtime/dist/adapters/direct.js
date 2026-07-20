import { executeCommand } from "../core/commands.js";
import { harborContext } from "./shared.js";
function noModelOrchestrator(harness) {
    return {
        harness,
        run: async () => { throw new Error("deterministic controls cannot invoke a model"); },
    };
}
/** Execute a lifecycle control without creating a model session or child. */
export function runDeterministicCommand(harness, command, args, project = process.cwd(), signal) {
    return executeCommand(command, args, harborContext(harness, project, noModelOrchestrator(harness)), signal);
}
