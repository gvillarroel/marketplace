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
export declare function openCodeDirectCommands(api: TuiPluginApi): DirectTuiCommand[];
declare const plugin: TuiPluginModule & {
    id: string;
};
export default plugin;
