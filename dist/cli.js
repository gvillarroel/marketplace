#!/usr/bin/env node
/**
 * Portable command-line entrypoint for Agent Harbor.
 *
 * Lifecycle commands use the deterministic core directly. A programmatic
 * contract is allowed only for Copilot, whose SDK can be constructed without
 * an enclosing host; OpenCode and Pi contracts must inherit their host model.
 */
import { executeCommand } from "./core/commands.js";
import { deterministicCommandNames } from "./core/types.js";
import { runDeterministicCommandResult } from "./adapters/direct.js";
import { harborContext } from "./adapters/shared.js";
const [, , harnessRaw, commandRaw, ...rest] = process.argv;
const harnesses = ["copilot", "opencode", "pi"];
const commands = ["bench", "join", "retire", "contract", "list-skills"];
if (!harnesses.includes(harnessRaw) || !commands.includes(commandRaw)) {
    console.error([
        "usage: agent-harbor <copilot|opencode|pi> <bench|join|retire|list-skills> [arguments]",
        "       agent-harbor copilot contract <json>",
    ].join("\n"));
    process.exitCode = 2;
}
else {
    const harness = harnessRaw;
    const command = commandRaw;
    const args = rest.join(" ");
    try {
        if (deterministicCommandNames.includes(command)) {
            const deterministic = command;
            const invoke = () => runDeterministicCommandResult(harness, deterministic, args, process.cwd(), undefined, process.stdout.isTTY ? "ansi" : "plain");
            if (harness === "opencode") {
                const { runOpenCodeRosterMutationGate } = await import("./adapters/opencode-agent-activity.js");
                const { assertOpenCodeLifecycleMutationTruth } = await import("./adapters/opencode-lifecycle-result.js");
                const result = await runOpenCodeRosterMutationGate(command, args, process.cwd(), invoke);
                assertOpenCodeLifecycleMutationTruth(command, args, result);
                console.log(result.text);
            }
            else {
                console.log((await invoke()).text);
            }
        }
        else if (harness === "copilot") {
            const { CopilotOrchestrator } = await import("./orchestrators/copilot.js");
            console.log(await executeCommand(command, args, await harborContext(harness, process.cwd(), new CopilotOrchestrator())));
        }
        else {
            throw new Error(`/contract must run inside ${harness}; the direct CLI never starts a hidden model session`);
        }
    }
    catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}
