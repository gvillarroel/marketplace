import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { joinSession } from "@github/copilot-sdk/extension";
import { approveAll, defineTool } from "@github/copilot-sdk";

import {
  COMMAND_DEFINITIONS,
  HarborError,
  createTrustedAgentController,
  executeHarborCommand,
  runtimeToolsFor,
} from "../../runtime/commands.mjs";

const pluginRoot = fileURLToPath(new URL("../../", import.meta.url));
const bundledDir = fileURLToPath(new URL("../../bench/", import.meta.url));

function resolveCopilotCliPath(env = process.env) {
  for (const candidate of [env.AGENT_HARBOR_CLI_PATH, env.COPILOT_CLI_PATH]) {
    if (candidate && existsSync(candidate)) return resolve(candidate);
  }

  try {
    const output = process.platform === "win32"
      ? execFileSync("where.exe", ["copilot"], { encoding: "utf8", windowsHide: true })
      : execFileSync("sh", ["-lc", "command -v copilot"], { encoding: "utf8" });
    const candidate = output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line && existsSync(line));
    if (candidate) return resolve(candidate);
  } catch {
    // The command below includes the actionable override.
  }

  throw new HarborError(
    "COPILOT_CLI_NOT_FOUND",
    "Could not locate GitHub Copilot CLI. Set AGENT_HARBOR_CLI_PATH to its absolute path.",
  );
}

async function createClient() {
  const { CopilotClient, RuntimeConnection } = await import("@github/copilot-sdk");
  const client = new CopilotClient({
    connection: RuntimeConnection.forStdio({ path: resolveCopilotCliPath() }),
    workingDirectory: process.cwd(),
    logLevel: "error",
  });
  await client.start();
  return client;
}

async function runChildWithClient(client, { definition, prompt, task }) {
  const model = definition.model ?? process.env.AGENT_HARBOR_MODEL ?? "auto";
  const tools = runtimeToolsFor("copilot", definition.tools);
  const child = await client.createSession({
    model,
    ...(model === "auto" ? {} : { reasoningEffort: "low" }),
    agent: definition.name,
    customAgents: [{
      name: definition.name,
      description: definition.description,
      prompt,
      tools,
    }],
    customAgentsLocalOnly: true,
    enableConfigDiscovery: false,
    enableSkills: false,
    onPermissionRequest: approveAll,
    infiniteSessions: { enabled: false },
    memory: { enabled: false },
    embeddingCacheStorage: "in-memory",
  });
  try {
    const response = await child.sendAndWait(task, 120_000);
    return response?.data?.content ?? "Contractor finished without a text response.";
  } finally {
    await child.disconnect().catch(() => undefined);
  }
}

async function runContract(request) {
  const client = await createClient();
  try {
    return await runChildWithClient(client, request);
  } finally {
    await client.stop().catch(() => undefined);
  }
}

const FILTER_PARAMETERS = Object.freeze({
  type: "object",
  properties: { filter: { type: "string", maxLength: 200 } },
  additionalProperties: false,
});
const DEFINITION_PARAMETERS = Object.freeze({
  type: "object",
  properties: { definition: { type: "string", minLength: 2, maxLength: 30_000 } },
  required: ["definition"],
  additionalProperties: false,
});
const DELEGATE_PARAMETERS = Object.freeze({
  type: "object",
  properties: {
    agent: { type: "string", minLength: 1, maxLength: 48 },
    task: { type: "string", minLength: 1, maxLength: 30_000 },
  },
  required: ["agent", "task"],
  additionalProperties: false,
});

function controllerTools(controller, { includeJoin = false } = {}) {
  const tools = [
    defineTool("harbor_list_skills", {
      description: "List only allowlisted GitHub skill references and freeze their exact metadata for this guarded session.",
      parameters: FILTER_PARAMETERS,
      skipPermission: true,
      defer: "never",
      handler: async ({ filter = "" }) => {
        const result = await controller.listSkills(filter);
        return JSON.stringify({ message: result.message, entries: result.entries });
      },
    }),
    defineTool("harbor_contract", {
      description: "Run one disposable agent whose GitHub skills exactly match the latest harbor_list_skills snapshot.",
      parameters: DEFINITION_PARAMETERS,
      skipPermission: true,
      defer: "never",
      handler: async ({ definition }) => (await controller.contract(definition)).message,
    }),
  ];
  if (includeJoin) {
    tools.push(defineTool("harbor_join", {
      description: "Register an agent whose GitHub skills exactly match the latest harbor_list_skills snapshot.",
      parameters: DEFINITION_PARAMETERS,
      skipPermission: true,
      defer: "never",
      handler: async ({ definition }) => (await controller.join(definition)).message,
    }));
  }
  return tools;
}

async function runManager(request) {
  const client = await createClient();
  try {
    const roster = new Map(request.roster.map((profile) => [profile.id, profile]));
    const delegate = defineTool("harbor_delegate", {
      description: "Delegate one bounded task to an exact player from the manager's frozen active roster.",
      parameters: DELEGATE_PARAMETERS,
      skipPermission: true,
      defer: "never",
      handler: async ({ agent, task }) => {
        const profile = roster.get(agent);
        if (!profile) {
          throw new HarborError("INACTIVE_PLAYER", `The manager cannot delegate to inactive player ${JSON.stringify(agent)}.`);
        }
        return runChildWithClient(client, {
          definition: {
            name: profile.id,
            description: profile.description,
            prompt: profile.prompt,
            tools: profile.tools,
            ...(profile.model ? { model: profile.model } : {}),
          },
          prompt: profile.prompt,
          task,
        });
      },
    });
    const tools = [delegate, ...(request.controller ? controllerTools(request.controller) : [])];
    const manager = await client.createSession({
      model: process.env.AGENT_HARBOR_MODEL ?? "auto",
      agent: "agent-harbor-manager",
      customAgents: [{
        name: "agent-harbor-manager",
        description: "Orchestrates only the exact frozen active Agent Harbor roster.",
        prompt: request.prompt,
        tools: tools.map(({ name }) => name),
      }],
      tools,
      customAgentsLocalOnly: true,
      enableConfigDiscovery: false,
      enableSkills: false,
      onPermissionRequest: approveAll,
      infiniteSessions: { enabled: false },
      memory: { enabled: false },
      embeddingCacheStorage: "in-memory",
    });
    try {
      const response = await manager.sendAndWait(request.task, 300_000);
      return response?.data?.content ?? "Manager finished without a text response.";
    } finally {
      await manager.disconnect().catch(() => undefined);
    }
  } finally {
    await client.stop().catch(() => undefined);
  }
}

const scoutsController = createTrustedAgentController({
  runtime: "copilot",
  cwd: process.cwd(),
  env: { ...process.env },
  pluginRoot,
  bundledDir,
  runContract,
});

let host;

host = await joinSession({
  tools: controllerTools(scoutsController, { includeJoin: true }),
  commands: COMMAND_DEFINITIONS.map((command) => ({
    name: command.name,
    description: command.description,
    handler: async (ctx) => {
      try {
        const result = await executeHarborCommand(command.name, ctx.args ?? "", {
          runtime: "copilot",
          cwd: process.cwd(),
          env: { ...process.env },
          pluginRoot,
          bundledDir,
          runContract,
          runManager,
        });
        await host.log(result.message, { level: "info" });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await host.log(`Agent Harbor: ${message}`, { level: "error" });
      }
    },
  })),
});
