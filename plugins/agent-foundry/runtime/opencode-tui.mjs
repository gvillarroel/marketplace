import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  COMMAND_DEFINITIONS,
  executeHarborCommand,
  runtimeToolsFor,
} from "./commands.mjs";
import {
  deleteManagerRun,
  managerPermissions,
  writeManagerRun,
} from "./opencode-manager-run.mjs";

const packagedBench = fileURLToPath(new URL("./bench/", import.meta.url));
const sourceBench = fileURLToPath(new URL("../bench/", import.meta.url));
const bundledDir = existsSync(packagedBench) ? packagedBench : sourceBench;

const ARGUMENT_UI = {
  bench: {
    title: "Agent Harbor bench",
    placeholder: "list | on scout sage | off all | dynamic on",
    value: "list",
  },
  join: {
    title: "Join a recurring player",
    placeholder: '{"name":"reviewer",...}',
    value: "",
  },
  retire: {
    title: "Retire a personal player",
    placeholder: "player-id",
    value: "",
  },
  "list-skills": {
    title: "List trusted skill references",
    placeholder: "optional filter",
    value: "",
  },
  contract: {
    title: "Run a disposable player (uses one model call)",
    placeholder: '{"name":"reviewer",...,"task":"..."}',
    value: "",
  },
  manager: {
    title: "Agent Harbor manager",
    placeholder: "Objective to complete with the exact active roster",
    value: "",
  },
};

function promptForArguments(api, command) {
  const input = ARGUMENT_UI[command];
  return new Promise((resolve) => {
    api.ui.dialog.replace(() => api.ui.DialogPrompt({
      title: input.title,
      placeholder: input.placeholder,
      value: input.value,
      onConfirm(value) {
        api.ui.dialog.clear();
        resolve(value);
      },
      onCancel() {
        api.ui.dialog.clear();
        resolve(undefined);
      },
    }));
  });
}

function showResult(api, title, message) {
  api.ui.dialog.replace(() => api.ui.DialogAlert({
    title,
    message,
    onConfirm() {
      api.ui.dialog.clear();
    },
  }));
}

function responseText(response) {
  const parts = response?.data?.parts ?? response?.parts ?? [];
  const text = parts
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
  return text || response?.data?.info?.content || "Contractor finished without a text response.";
}

function contractPermissions(tools = []) {
  const allowed = runtimeToolsFor("opencode", tools);
  return [
    { permission: "*", pattern: "*", action: "deny" },
    ...allowed.map((permission) => ({ permission, pattern: "*", action: "allow" })),
  ];
}

async function runContractWithClient(api, { definition, prompt, task }) {
  const current = api.route.current;
  const parentID = current.name === "session" ? current.params?.sessionID : undefined;
  const directory = api.state.path.directory || api.state.path.worktree || process.cwd();
  const created = await api.client.session.create({
    directory,
    ...(parentID ? { parentID } : {}),
    title: `Agent Harbor contract: ${definition.name}`,
    permission: contractPermissions(definition.tools),
  });
  if (created?.error) throw new Error(String(created.error?.message ?? created.error));
  const sessionID = created?.data?.id ?? created?.id;
  if (!sessionID) throw new Error("OpenCode did not return a contractor session ID.");

  try {
    const response = await api.client.session.prompt({
      sessionID,
      directory,
      system: prompt,
      parts: [{
        type: "text",
        text: task,
      }],
    });
    if (response?.error) throw new Error(String(response.error?.message ?? response.error));
    return responseText(response);
  } finally {
    await api.client.session.delete({ sessionID, directory }).catch(() => undefined);
  }
}

async function runManagerWithClient(api, request) {
  const current = api.route.current;
  const parentID = current.name === "session" ? current.params?.sessionID : undefined;
  const directory = api.state.path.directory || api.state.path.worktree || process.cwd();
  const created = await api.client.session.create({
    directory,
    ...(parentID ? { parentID } : {}),
    title: "Agent Harbor manager",
    permission: managerPermissions(request),
  });
  if (created?.error) throw new Error(String(created.error?.message ?? created.error));
  const sessionID = created?.data?.id ?? created?.id;
  if (!sessionID) throw new Error("OpenCode did not return a manager session ID.");

  let runWritten = false;
  try {
    await writeManagerRun(directory, sessionID, request);
    runWritten = true;
    const response = await api.client.session.prompt({
      sessionID,
      directory,
      agent: "agent-harbor-manager",
      system: `${request.prompt}\n\nDelegate every persistent roster task through harbor_delegate. The host resolves that tool against this session's frozen profiles; never call OpenCode's nominal task/subagent mechanism.`,
      parts: [{ type: "text", text: request.task }],
    });
    if (response?.error) throw new Error(String(response.error?.message ?? response.error));
    return responseText(response);
  } finally {
    if (runWritten) await deleteManagerRun(directory, sessionID).catch(() => undefined);
    await api.client.session.delete({ sessionID, directory }).catch(() => undefined);
  }
}

async function execute(api, definition) {
  const args = await promptForArguments(api, definition.name);
  if (args === undefined) return;

  try {
    const cwd = api.state.path.directory || api.state.path.worktree || process.cwd();
    const result = await executeHarborCommand(definition.name, args, {
      runtime: "opencode",
      cwd,
      env: { ...process.env },
      bundledDir,
      runContract: (request) => runContractWithClient(api, request),
      runManager: (request) => runManagerWithClient(api, request),
    });
    showResult(api, `Agent Harbor · ${definition.name}`, result.message);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    showResult(api, `Agent Harbor · ${definition.name} failed`, message);
  }
}

export default {
  id: "agent-harbor",
  tui: async (api) => {
    api.keymap.registerLayer({
      commands: COMMAND_DEFINITIONS.map((definition) => ({
        namespace: "palette",
        name: `agent-harbor.${definition.name}`,
        title: `Agent Harbor: ${definition.name}`,
        desc: definition.description,
        slashName: definition.name,
        run: () => execute(api, definition),
      })),
      bindings: [],
    });
  },
};
