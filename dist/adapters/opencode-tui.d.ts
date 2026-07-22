/** Direct OpenCode TUI palette commands for zero-model lifecycle operations. */
import type { TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui";
import { type OpenCodeOrchestratorClient } from "../orchestrators/opencode.js";
import { type OpenCodeTeamRuntimeOptions } from "./opencode-team-runtime.js";
interface DirectTuiCommand {
    name: string;
    title: string;
    desc: string;
    category: string;
    namespace: "palette";
    slashName: string;
    run(): void | Promise<void>;
}
/** Bridges the TUI's v2 SDK request shape to the narrow legacy-shaped child API. */
export declare function openCodeTuiOrchestratorClient(client: TuiPluginApi["client"]): OpenCodeOrchestratorClient;
/** Bounds requested child evidence without applying metadata path/URL redaction. */
export declare function boundedContractEvidence(value: string, maximumCodePoints?: number): string | undefined;
/** Executes one `/team` prompt value without routing through an OpenCode model session. */
export declare function runOpenCodeTeamQuery(api: TuiPluginApi, input: string, options?: OpenCodeTeamRuntimeOptions): Promise<void>;
/** Creates palette commands that call the deterministic backend directly. */
export declare function openCodeDirectCommands(api: TuiPluginApi): DirectTuiCommand[];
declare const plugin: TuiPluginModule & {
    id: string;
};
/** OpenCode TUI plugin entrypoint. */
export default plugin;
