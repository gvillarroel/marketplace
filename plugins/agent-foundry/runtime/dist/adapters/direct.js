/** Zero-model adapter shared by CLI and native deterministic controls. */
import { executeCommand } from "../core/commands.js";
import { harborContext } from "./shared.js";
function noModelOrchestrator(harness) {
    return {
        harness,
        run: async () => { throw new Error("deterministic controls cannot invoke a model"); },
    };
}
/**
 * Executes a lifecycle control without creating a model session or child.
 * The injected orchestrator is a tripwire: deterministic commands must never
 * cross the inference boundary, even if command routing regresses.
 */
export function runDeterministicCommand(harness, command, args, project = process.cwd(), signal, color = false) {
    return harborContext(harness, project, noModelOrchestrator(harness), color)
        .then((context) => executeCommand(command, args, context, signal));
}
