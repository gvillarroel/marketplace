import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  HarborError,
  createTrustedAgentController,
  runtimeToolsFor,
} from "./commands.mjs";
import {
  createManagerRunCache,
  runFrozenManagerDelegate,
} from "./opencode-manager-run.mjs";

const bundledDir = fileURLToPath(new URL("./bench/", import.meta.url));
const MANAGER_ID = "agent-harbor-manager";

async function loadToolHelper() {
  try {
    const direct = await import("@opencode-ai/plugin");
    if (typeof direct.tool === "function") return direct.tool;
  } catch {
    // A file: plugin keeps host dependencies in its OpenCode config directory.
  }

  const roots = [];
  if (process.env.OPENCODE_CONFIG_DIR) roots.push(resolve(process.env.OPENCODE_CONFIG_DIR));
  let cursor = resolve(process.cwd());
  while (true) {
    roots.push(join(cursor, ".opencode"));
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  if (process.env.XDG_CONFIG_HOME) roots.push(join(resolve(process.env.XDG_CONFIG_HOME), "opencode"));
  roots.push(join(homedir(), ".config", "opencode"));
  if (process.env.APPDATA) roots.push(join(resolve(process.env.APPDATA), "opencode"));

  for (const root of new Set(roots)) {
    try {
      const path = join(root, "node_modules", "@opencode-ai", "plugin", "dist", "index.js");
      const loaded = await import(pathToFileURL(path).href);
      if (typeof loaded.tool === "function") return loaded.tool;
    } catch {
      // Try the next standard host dependency root.
    }
  }
  throw new Error("Agent Harbor could not resolve @opencode-ai/plugin from the package or OpenCode config directory.");
}

const tool = await loadToolHelper();

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
  return [
    { permission: "*", pattern: "*", action: "deny" },
    ...runtimeToolsFor("opencode", tools).map((permission) => ({
      permission,
      pattern: "*",
      action: "allow",
    })),
  ];
}

async function runContractWithClient(client, context, { definition, prompt, task }) {
  const directory = context.directory || context.worktree || process.cwd();
  const created = await client.session.create({
    directory,
    parentID: context.sessionID,
    title: `Agent Harbor contract: ${definition.name}`,
    permission: contractPermissions(definition.tools),
  });
  if (created?.error) throw new Error(String(created.error?.message ?? created.error));
  const sessionID = created?.data?.id ?? created?.id;
  if (!sessionID) throw new Error("OpenCode did not return a contractor session ID.");

  try {
    const response = await client.session.prompt({
      sessionID,
      directory,
      system: prompt,
      parts: [{ type: "text", text: task }],
    });
    if (response?.error) throw new Error(String(response.error?.message ?? response.error));
    return responseText(response);
  } finally {
    await client.session.delete({ sessionID, directory }).catch(() => undefined);
  }
}

function managerAgent() {
  return {
    description: "Internal host for the guarded /manager command.",
    mode: "primary",
    hidden: true,
    prompt: "Follow the Agent Harbor manager policy supplied by the current session. Delegate persistent roster work only with harbor_delegate, which resolves the exact frozen profile bound to this session. Never invoke a nominal task/subagent by ID.",
    permission: { "*": "deny" },
  };
}

export function createAgentHarborServer(agents) {
  return async ({ client }) => {
    const controllers = new Map();
    const managerRuns = createManagerRunCache();

    const contextKey = (context) => `${context.sessionID}\u0000${resolve(context.directory)}`;

    const controllerFor = (context) => {
      const key = contextKey(context);
      if (!controllers.has(key)) {
        controllers.set(key, createTrustedAgentController({
          runtime: "opencode",
          cwd: context.directory,
          env: { ...process.env },
          bundledDir,
          runContract: (request) => runContractWithClient(client, context, request),
        }));
      }
      return controllers.get(key);
    };

    const authorize = async (context, operation) => {
      if (context.agent === "scouts") return;
      if (context.agent !== MANAGER_ID) {
        throw new HarborError("AGENT_TOOL_FORBIDDEN", `${operation} is available only to scouts or an active Agent Harbor manager.`);
      }
      const run = await managerRuns.get(context);
      if (operation === "harbor_join") {
        throw new HarborError("MANAGER_JOIN_FORBIDDEN", "The manager may contract disposable agents but may not join persistent ones.");
      }
      if (!run.dynamicAgents) {
        throw new HarborError("DYNAMIC_AGENTS_DISABLED", "Dynamic agents are disabled for this manager run.");
      }
    };

    return {
      config: async (config) => {
        config.agent = {
          ...(config.agent ?? {}),
          ...agents,
          [MANAGER_ID]: managerAgent(),
        };
      },
      event: async ({ event }) => {
        if (event?.type !== "session.deleted") return;
        const info = event.properties?.info;
        const sessionID = event.properties?.sessionID ?? info?.id;
        const directory = info?.directory;
        if (typeof sessionID !== "string" || typeof directory !== "string") return;
        const context = { sessionID, directory };
        managerRuns.delete(context);
        controllers.delete(contextKey(context));
      },
      tool: {
        harbor_delegate: tool({
          description: "Delegate one bounded task to a player from this manager session's exact frozen roster and profile.",
          args: {
            agent: tool.schema.string().regex(/^[a-z0-9][a-z0-9-]{0,47}$/),
            task: tool.schema.string().min(1).max(30_000),
          },
          async execute(args, context) {
            if (context.agent !== MANAGER_ID) {
              throw new HarborError("AGENT_TOOL_FORBIDDEN", "harbor_delegate is available only to an active Agent Harbor manager.");
            }
            const run = await managerRuns.get(context);
            return runFrozenManagerDelegate(client, context, run, args);
          },
        }),
        harbor_list_skills: tool({
          description: "List only allowlisted GitHub skill references and freeze their exact metadata for this guarded session.",
          args: { filter: tool.schema.string().max(200).optional() },
          async execute(args, context) {
            await authorize(context, "harbor_list_skills");
            const result = await controllerFor(context).listSkills(args.filter ?? "");
            return JSON.stringify({ message: result.message, entries: result.entries });
          },
        }),
        harbor_contract: tool({
          description: "Run one disposable agent whose GitHub skills exactly match the latest harbor_list_skills snapshot.",
          args: { definition: tool.schema.string().min(2).max(30_000) },
          async execute(args, context) {
            await authorize(context, "harbor_contract");
            const result = await controllerFor(context).contract(args.definition);
            return result.message;
          },
        }),
        harbor_join: tool({
          description: "Register an agent whose GitHub skills exactly match the latest harbor_list_skills snapshot.",
          args: { definition: tool.schema.string().min(2).max(30_000) },
          async execute(args, context) {
            await authorize(context, "harbor_join");
            const result = await controllerFor(context).join(args.definition);
            return result.message;
          },
        }),
      },
    };
  };
}
