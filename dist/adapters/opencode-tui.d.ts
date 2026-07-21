/** Direct OpenCode TUI palette commands for zero-model lifecycle operations. */
import type { TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui";
interface DirectTuiCommand {
    name: string;
    title: string;
    desc: string;
    category: string;
    namespace: "palette";
    slashName: string;
    run(): void | Promise<void>;
}
/** Creates palette commands that call the deterministic backend directly. */
export declare function openCodeDirectCommands(api: TuiPluginApi): DirectTuiCommand[];
declare const plugin: TuiPluginModule & {
    id: string;
};
/** OpenCode TUI plugin entrypoint. */
export default plugin;
