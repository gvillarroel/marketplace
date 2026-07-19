#!/usr/bin/env node

import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import {
  COMMAND_DEFINITIONS,
  executeHarborCommand,
  runtimeToolsFor,
} from "./commands.mjs";

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const localBench = join(here, "bench");
const sourceBench = join(here, "..", "bench");
const bundledDir = existsSync(localBench) ? localBench : sourceBench;
const CLI_COMMAND_DEFINITIONS = COMMAND_DEFINITIONS.filter(({ name }) => name !== "manager");

function usage() {
  const commands = CLI_COMMAND_DEFINITIONS.map((item) => `  ${item.name.padEnd(12)} ${item.description}`).join("\n");
  return `Usage: agent-harbor [--runtime copilot|opencode|pi] [--json] <command> [arguments]\n\n${commands}\n\nNative session only:\n  /manager     Orchestrate from inside Copilot, OpenCode, or Pi.`;
}

function parse(argv) {
  let runtime = process.env.AGENT_HARBOR_RUNTIME || "opencode";
  let json = false;
  const rest = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--runtime") {
      runtime = argv[++index];
      continue;
    }
    if (value === "--json") {
      json = true;
      continue;
    }
    if (value === "--help" || value === "-h") return { help: true, runtime, json, rest };
    rest.push(value);
  }
  return { runtime, json, command: rest.shift(), args: rest.join(" ") };
}

function where(name) {
  const override = process.env[`AGENT_HARBOR_${name.toUpperCase()}_PATH`];
  if (override) return { command: override, prefix: [] };
  if (process.platform !== "win32") return { command: name, prefix: [] };

  const rows = execFileSync("where.exe", [name], { encoding: "utf8", windowsHide: true })
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
  const executable = rows.find((item) => item.toLowerCase().endsWith(".exe"));
  if (executable) return { command: executable, prefix: [] };

  const shim = rows.find((item) => item.toLowerCase().endsWith(".cmd"));
  if (shim && name === "pi") {
    const entry = join(dirname(shim), "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
    if (existsSync(entry)) return { command: process.execPath, prefix: [entry] };
  }
  if (shim && name === "opencode") {
    const entry = join(dirname(shim), "node_modules", "opencode-ai", "bin", "opencode.exe");
    if (existsSync(entry)) return { command: entry, prefix: [] };
  }
  throw new Error(`Could not locate an executable for ${name}.`);
}

function toolList(runtime, tools = []) {
  return runtimeToolsFor(runtime, tools);
}

async function runContract(runtime, { definition, prompt, task }) {
  const combined = `${prompt}\n\n## Assigned task\n\n${task}`;
  let executable;
  let args;
  let env = process.env;

  if (runtime === "pi") {
    executable = where("pi");
    args = [
      ...executable.prefix,
      "--no-session",
      "--no-extensions",
      "--no-skills",
      "--tools",
      toolList("pi", definition.tools).join(","),
      ...(definition.model ? ["--model", definition.model] : []),
      "--print",
      combined,
    ];
  } else if (runtime === "copilot") {
    executable = where("copilot");
    args = [
      ...executable.prefix,
      "--silent",
      "--allow-all-tools",
      "--available-tools",
      toolList("copilot", definition.tools).join(","),
      ...(definition.model ? ["--model", definition.model] : []),
      "-p",
      combined,
    ];
  } else {
    executable = where("opencode");
    const permission = Object.fromEntries([
      ["*", "deny"],
      ...toolList("opencode", definition.tools).map((tool) => [tool, "allow"]),
    ]);
    env = {
      ...process.env,
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        agent: {
          "agent-harbor-contract": {
            mode: "primary",
            description: definition.description,
            prompt,
            permission,
          },
        },
      }),
    };
    args = [
      ...executable.prefix,
      "run",
      "--pure",
      "--agent",
      "agent-harbor-contract",
      ...(definition.model ? ["--model", definition.model] : []),
      task,
    ];
  }

  const result = await execFileAsync(executable.command, args, {
    cwd: process.cwd(),
    env,
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
    windowsHide: true,
  });
  return result.stdout.trim() || "Contractor finished without a text response.";
}

const parsed = parse(process.argv.slice(2));
let modelCalls = 0;
if (parsed.help || !parsed.command) {
  process.stdout.write(`${usage()}\n`);
  process.exitCode = parsed.help ? 0 : 2;
} else {
  try {
    if (parsed.command === "manager") {
      throw new Error("manager requires the native /manager command inside a Copilot, OpenCode, or Pi session.");
    }
    const result = await executeHarborCommand(parsed.command, parsed.args, {
      runtime: parsed.runtime,
      cwd: process.cwd(),
      env: { ...process.env },
      bundledDir,
      runContract: (request) => {
        modelCalls += 1;
        return runContract(parsed.runtime, request);
      },
    });
    process.stdout.write(parsed.json ? `${JSON.stringify(result)}\n` : `${result.message}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (parsed.json) {
      process.stdout.write(`${JSON.stringify({ ok: false, error: message, modelCalls })}\n`);
    } else {
      process.stderr.write(`Agent Harbor: ${message}\n`);
    }
    process.exitCode = 1;
  }
}
