import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import {
  COMMAND_DEFINITIONS,
  HarborError,
  createTrustedAgentController,
  executeHarborCommand,
  runtimeToolsFor,
} from "../commands.mjs";

const execFileAsync = promisify(execFile);
const bundledDir = fileURLToPath(new URL("../bench/", import.meta.url));

function mappedTools(tools = []) {
  return runtimeToolsFor("pi", tools);
}

async function runContract({ definition, prompt, task }, cwd, signal) {
  const entrypoint = process.argv[1];
  if (!entrypoint) throw new Error("Could not locate the current Pi entrypoint.");

  const args = [
    entrypoint,
    "--no-session",
    "--no-extensions",
    "--no-skills",
    "--append-system-prompt",
    prompt,
    "--tools",
    mappedTools(definition.tools).join(","),
  ];
  if (definition.model) args.push("--model", definition.model);
  args.push("--print", task);

  try {
    const result = await execFileAsync(process.execPath, args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true,
      env: process.env,
      signal,
    });
    return result.stdout.trim() || "Contractor finished without a text response.";
  } catch (error) {
    const stderr = typeof error?.stderr === "string" ? error.stderr.trim() : "";
    throw new Error(stderr || error?.message || String(error));
  }
}

const FILTER_SCHEMA = Object.freeze({
  type: "object",
  properties: { filter: { type: "string", maxLength: 200 } },
  additionalProperties: false,
});
const DEFINITION_SCHEMA = Object.freeze({
  type: "object",
  properties: { definition: { type: "string", minLength: 2, maxLength: 30_000 } },
  required: ["definition"],
  additionalProperties: false,
});
const DELEGATE_SCHEMA = Object.freeze({
  type: "object",
  properties: {
    agent: { type: "string", minLength: 1, maxLength: 48 },
    task: { type: "string", minLength: 1, maxLength: 30_000 },
  },
  required: ["agent", "task"],
  additionalProperties: false,
});

function toolResult(result) {
  const text = result?.entries
    ? JSON.stringify({ message: result.message, entries: result.entries })
    : String(result?.message ?? result ?? "Completed without a text response.");
  return { content: [{ type: "text", text }], details: result };
}

export default function agentHarborExtension(pi) {
  const scoutControllers = new Map();
  let pendingManager = null;

  const optionsFor = (cwd) => ({
    runtime: "pi",
    cwd,
    env: { ...process.env },
    bundledDir,
    runContract: (request) => runContract(request, cwd),
  });

  const scoutController = (cwd) => {
    if (!scoutControllers.has(cwd)) {
      scoutControllers.set(cwd, createTrustedAgentController(optionsFor(cwd)));
    }
    return scoutControllers.get(cwd);
  };

  const guardedController = (toolName, cwd) => {
    if (pendingManager?.cwd === cwd) {
      if (!pendingManager.request.dynamicAgents || !pendingManager.request.controller) {
        throw new HarborError("DYNAMIC_AGENTS_DISABLED", "Dynamic agents are disabled for this manager run.");
      }
      return pendingManager.request.controller;
    }
    return scoutController(cwd);
  };

  pi.registerTool?.({
    name: "harbor_list_skills",
    label: "List trusted Agent Harbor skills",
    description: "List only allowlisted GitHub skill references and freeze their exact metadata for this guarded session.",
    promptSnippet: "List trusted Agent Harbor skill references",
    parameters: FILTER_SCHEMA,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return toolResult(await guardedController("harbor_list_skills", ctx.cwd).listSkills(params.filter ?? ""));
    },
  });

  pi.registerTool?.({
    name: "harbor_contract",
    label: "Contract a trusted disposable agent",
    description: "Run one disposable agent whose GitHub skills exactly match the latest harbor_list_skills snapshot.",
    promptSnippet: "Contract one catalog-guarded disposable agent",
    parameters: DEFINITION_SCHEMA,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return toolResult(await guardedController("harbor_contract", ctx.cwd).contract(params.definition));
    },
  });

  pi.registerTool?.({
    name: "harbor_join",
    label: "Join a trusted recurring agent",
    description: "Register and activate an agent whose GitHub skills exactly match the latest harbor_list_skills snapshot.",
    promptSnippet: "Join one catalog-guarded recurring agent",
    parameters: DEFINITION_SCHEMA,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (pendingManager?.cwd === ctx.cwd) {
        throw new HarborError("MANAGER_JOIN_FORBIDDEN", "The manager may contract disposable agents but may not join persistent ones.");
      }
      return toolResult(await scoutController(ctx.cwd).join(params.definition));
    },
  });

  pi.registerTool?.({
    name: "harbor_delegate",
    label: "Delegate to an active Agent Harbor player",
    description: "Delegate one bounded task to an exact player from the manager's frozen active roster.",
    promptSnippet: "Delegate work to one exact active Agent Harbor player",
    parameters: DELEGATE_SCHEMA,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const pending = pendingManager;
      if (!pending || pending.cwd !== ctx.cwd) {
        throw new HarborError("MANAGER_NOT_ACTIVE", "harbor_delegate is available only during an active manager run.");
      }
      const profile = pending.request.roster.find(({ id }) => id === params.agent);
      if (!profile) {
        throw new HarborError("INACTIVE_PLAYER", `The manager cannot delegate to inactive player ${JSON.stringify(params.agent)}.`);
      }
      const output = await runContract({
        definition: {
          name: profile.id,
          description: profile.description,
          prompt: profile.prompt,
          tools: profile.tools,
          ...(profile.model ? { model: profile.model } : {}),
        },
        prompt: profile.prompt,
        task: params.task,
      }, ctx.cwd, signal);
      return toolResult({ message: output, agent: profile.id });
    },
  });

  if (typeof pi.on === "function") {
    pi.on("before_agent_start", async (event) => {
      if (!pendingManager || pendingManager.promptInjected) return undefined;
      pendingManager.promptInjected = true;
      return { systemPrompt: `${event.systemPrompt}\n\n${pendingManager.request.prompt}` };
    });
    pi.on("agent_settled", async () => {
      if (!pendingManager) return;
      const previous = pendingManager.previousTools;
      pendingManager = null;
      pi.setActiveTools(previous);
    });
  }

  const runManager = async (request, cwd) => {
    if (pendingManager) throw new HarborError("MANAGER_BUSY", "An Agent Harbor manager run is already active.");
    if (typeof pi.getActiveTools !== "function" || typeof pi.setActiveTools !== "function" || typeof pi.sendUserMessage !== "function" || typeof pi.on !== "function") {
      throw new HarborError("MANAGER_UNSUPPORTED", "This Pi host does not expose the session APIs required by manager.");
    }
    const previousTools = [...pi.getActiveTools()];
    pendingManager = { request, cwd, previousTools, promptInjected: false };
    const managerTools = [
      "harbor_delegate",
      ...(request.dynamicAgents ? ["harbor_list_skills", "harbor_contract"] : []),
    ];
    try {
      pi.setActiveTools(managerTools);
      pi.sendUserMessage(request.task);
    } catch (error) {
      pendingManager = null;
      pi.setActiveTools(previousTools);
      throw error;
    }
    return "Manager started in this Pi session.";
  };

  for (const definition of COMMAND_DEFINITIONS) {
    pi.registerCommand(definition.name, {
      description: definition.description,
      handler: async (args, ctx) => {
        try {
          const result = await executeHarborCommand(definition.name, args ?? "", {
            runtime: "pi",
            cwd: ctx.cwd,
            env: { ...process.env },
            bundledDir,
            runContract: (request) => runContract(request, ctx.cwd),
            runManager: (request) => runManager(request, ctx.cwd),
          });
          ctx.ui.notify(result.message, "info");
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          ctx.ui.notify(`Agent Harbor: ${message}`, "error");
        }
      },
    });
  }
}
