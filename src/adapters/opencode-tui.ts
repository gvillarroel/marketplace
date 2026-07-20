import type { TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui";
import type { DeterministicCommandName } from "../core/types.js";
import { runDeterministicCommand } from "./direct.js";

interface DirectTuiCommand {
  name: string;
  title: string;
  desc: string;
  category: string;
  namespace: "palette";
  slashName: string;
  run(): void | Promise<void>;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function openCodeDirectCommands(api: TuiPluginApi): DirectTuiCommand[] {
  const execute = async (command: DeterministicCommandName, args: string): Promise<void> => {
    try {
      const result = await runDeterministicCommand("opencode", command, args, api.state.path.directory);
      api.ui.toast({ variant: "success", title: "Agent Harbor · 0 model tokens", message: result, duration: 10_000 });
    } catch (error) {
      api.ui.toast({ variant: "error", title: "Agent Harbor", message: message(error), duration: 10_000 });
    }
  };
  const prompt = (title: string, placeholder: string, command: DeterministicCommandName, prefix = ""): void => {
    api.ui.dialog.replace(() => api.ui.DialogPrompt({
      title,
      placeholder,
      onCancel: () => api.ui.dialog.clear(),
      onConfirm: async (value) => {
        api.ui.dialog.clear();
        await execute(command, `${prefix}${value}`);
      },
    }));
  };
  const metadata = (name: string, title: string, desc: string, slashName: string, run: DirectTuiCommand["run"]): DirectTuiCommand => ({
    name: `agent-harbor.${name}`, title, desc, slashName, run, category: "Agent Harbor · direct", namespace: "palette",
  });

  return [
    metadata("bench-list", "Agent Harbor: view bench", "List the bench directly without a model request.", "bench-list", () => execute("bench", "list")),
    metadata("bench-on", "Agent Harbor: activate players", "Activate player IDs directly without a model request.", "bench-on", () => prompt("Activate Agent Harbor players", "scout sage, or all", "bench", "on ")),
    metadata("bench-off", "Agent Harbor: deactivate players", "Deactivate player IDs directly without a model request.", "bench-off", () => prompt("Deactivate Agent Harbor players", "smith, or all", "bench", "off ")),
    metadata("join", "Agent Harbor: join player", "Register JSON directly without a model request.", "harbor-join", () => prompt("Join an Agent Harbor player", "{\"name\":\"reviewer\",...}", "join")),
    metadata("retire", "Agent Harbor: retire player", "Retire an ID directly without a model request.", "harbor-retire", () => prompt("Retire an Agent Harbor player", "reviewer", "retire")),
    metadata("skills-list", "Agent Harbor: list trusted skills", "Resolve and list trusted skills without a model request.", "harbor-list-skills", () => execute("list-skills", "")),
    metadata("skills-filter", "Agent Harbor: filter trusted skills", "Filter trusted skills directly without a model request.", "harbor-filter-skills", () => prompt("Filter trusted Agent Harbor skills", "zx", "list-skills")),
  ];
}

const plugin: TuiPluginModule & { id: string } = {
  id: "agent-harbor.direct-controls",
  tui: async (api) => { api.keymap.registerLayer({ commands: openCodeDirectCommands(api) }); },
};

export default plugin;
