#!/usr/bin/env node

import { CopilotClient, RuntimeConnection } from "@github/copilot-sdk";
import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runCopilotControl } from "../dist/adapters/copilot.js";
import { createAgentHarborExtensionPermissionGate } from "./copilot-extension-permission-gate.mjs";

export { createAgentHarborExtensionPermissionGate };

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const plugin = join(root, "plugins", "agent-foundry");
const delay = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds));
const fastCapture = process.env.AGENT_HARBOR_DEMO_FAST === "1";
const color = {
  cyan: "\u001b[36m",
  dim: "\u001b[2m",
  green: "\u001b[32m",
  magenta: "\u001b[35m",
  red: "\u001b[31m",
  reset: "\u001b[0m",
  yellow: "\u001b[33m",
};

function paint(value, tone) {
  return process.stdout.isTTY || process.env.AGENT_HARBOR_DEMO_COLOR === "1"
    ? `${color[tone]}${value}${color.reset}`
    : value;
}

function terminalText(value) {
  return String(value ?? "")
    .replace(/\r\n?/gu, "\n")
    .replace(/[\t ]+$/gmu, "")
    .trim();
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function typeCommand(command) {
  process.stdout.write(`\n${paint("❯", "green")} `);
  for (const character of command) {
    process.stdout.write(character);
    if (!fastCapture) await delay(character === " " ? 35 : 18);
  }
  process.stdout.write("\n");
  if (!fastCapture) await delay(250);
}

function section(title, detail) {
  process.stdout.write(`\n${paint(`── ${title} `, "cyan")}${paint("─".repeat(Math.max(2, 76 - title.length)), "dim")}\n`);
  if (detail) process.stdout.write(`${paint(detail, "dim")}\n`);
}

async function readingPause(seconds) {
  process.stdout.write(`${paint(`\n⏸ ${seconds} segundos para leer antes del próximo comando`, "dim")}\n`);
  if (!fastCapture) await delay(seconds * 1000);
}

function copilotExecutable() {
  const explicit = process.env.AGENT_HARBOR_COPILOT_CLI?.trim();
  if (explicit) return explicit;
  const locator = process.platform === "win32" ? ["where.exe", ["copilot.exe"]] : ["which", ["copilot"]];
  try {
    const located = execFileSync(locator[0], locator[1], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim().split(/\r?\n/u).find(Boolean);
    if (located) return located;
  } catch { /* Use the actionable error below. */ }
  throw new Error("GitHub Copilot CLI 1.0.73 is required. Install it or set AGENT_HARBOR_COPILOT_CLI.");
}

function commandCost(name) {
  if (["team", "bench", "join", "retire", "list-skills"].includes(name)) return "0 model tokens";
  if (name === "contract") return "exactly 1 disposable child";
  if (name === "scout") return "1 recruiter model root";
  if (name === "team-lead") return "1 lead + up to 6 sequential children";
  return "1 model root";
}

function wrapped(value, width = 92) {
  const lines = [];
  let current = "";
  for (const word of String(value).split(/\s+/u).filter(Boolean)) {
    if (current && current.length + word.length + 1 > width) {
      lines.push(current);
      current = word;
    } else current += `${current ? " " : ""}${word}`;
  }
  if (current) lines.push(current);
  return lines;
}

function renderCommandCatalog(commands) {
  const order = [
    "team", "bench", "join", "retire", "list-skills", "player", "contract", "scout", "team-lead", "crafter",
    "portfolio-management", "design", "build", "manage", "consume", "dispose",
  ];
  const normalized = commands.map((command) => ({
    ...command,
    displayName: command.name === "agent-foundry:contract" ? "contract" : command.name,
  }));
  const byName = new Map(normalized.map((command) => [command.displayName, command]));
  for (const name of order) {
    const command = byName.get(name);
    if (!command) continue;
    const cost = commandCost(name);
    process.stdout.write(`  ${paint(`/${name}`, "magenta").padEnd(process.stdout.isTTY ? 35 : 27)} ${paint(cost, cost.startsWith("0 model") ? "green" : "yellow")} · ${command.kind}\n`);
    for (const line of wrapped(command.description)) process.stdout.write(`    ${paint(line, "dim")}\n`);
  }
}

function uniqueMessages(events) {
  const seen = new Set();
  const messages = [];
  for (const event of events) {
    const message = typeof event?.data?.message === "string" ? terminalText(event.data.message) : "";
    if (!message || seen.has(message)) continue;
    seen.add(message);
    messages.push(message);
  }
  return messages;
}

function errorMessage(error) {
  return terminalText(error instanceof Error ? error.message : String(error));
}

async function main() {
  await access(join(plugin, "plugin.json"));
  const executable = copilotExecutable();
  const cliVersion = execFileSync(executable, ["--version"], { encoding: "utf8" }).trim().split(/\r?\n/u)[0];
  const temporaryRoot = await mkdtemp(join(tmpdir(), "agent-harbor-copilot-asciinema-"));
  const project = join(temporaryRoot, "agent-harbor-copilot-demo");
  const copilotHome = join(temporaryRoot, "copilot-home");
  await mkdir(join(project, ".agent-harbor"), { recursive: true });
  await mkdir(copilotHome, { recursive: true });
  await writeFile(join(project, ".agent-harbor", "skill-sources.json"), `${JSON.stringify({
    version: 1,
    sources: [{
      kind: "github",
      scope: "skill",
      repo: "gvillarroel/zx-harness",
      path: "skills/zx-example-author/SKILL.md",
      track: "refs/heads/main",
      name: "zx-example-author",
    }],
  }, null, 2)}\n`, "utf8");

  const client = new CopilotClient({
    connection: RuntimeConnection.forStdio({
      path: executable,
      args: [
        "--experimental", "--no-auto-update", "--no-color", "--no-remote", "--disable-builtin-mcps",
        "--max-ai-credits", "30", "--plugin-dir", plugin,
      ],
    }),
    workingDirectory: project,
    baseDirectory: join(temporaryRoot, "sdk-home"),
    logLevel: "error",
    env: {
      ...process.env,
      CI: "1",
      COPILOT_HOME: copilotHome,
      COPILOT_PLUGIN_DIR_ONLY: "true",
      NO_COLOR: "1",
      OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT: "false",
    },
  });

  let session;
  const events = [];
  const modelEvents = [];
  const permissionGate = createAgentHarborExtensionPermissionGate("model-free demo");
  let primaryError;
  let commandCount = 0;
  try {
    await client.start();
    session = await client.createSession({
      workingDirectory: project,
      enableConfigDiscovery: true,
      requestExtensions: true,
      onPermissionRequest: permissionGate.handler,
      enableSessionTelemetry: false,
      infiniteSessions: { enabled: false },
      skipCustomInstructions: true,
      customAgentsLocalOnly: true,
      coauthorEnabled: false,
      streaming: false,
      includeSubAgentStreamingEvents: false,
    });
    session.on((event) => {
      events.push(event);
      if (event.type === "assistant.usage" || event.type === "assistant.message") modelEvents.push(event.type);
    });

    let listed;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      listed = await session.rpc.commands.list({ includeBuiltins: false, includeSkills: true, includeClientCommands: true });
      if (listed.commands.some((command) => command.name === "team" && command.kind === "client")) break;
      await delay(100);
    }
    if (!listed?.commands.some((command) => command.name === "team" && command.kind === "client")) {
      throw new Error("Agent Harbor did not register Copilot's direct /team command");
    }

    await delay(1000);
    events.length = 0;
    const usageBefore = await session.rpc.usage.getMetrics();
    const invoke = async (name, input, seconds, display = `/${name}${input ? ` ${input}` : ""}`) => {
      commandCount += 1;
      await typeCommand(display);
      const eventOffset = events.length;
      let failure;
      try {
        const result = await session.rpc.commands.invoke({ name, input });
        if (result.kind !== "completed") throw new Error(`Copilot returned ${result.kind}`);
      } catch (error) { failure = error; }
      await delay(100);
      const messages = uniqueMessages(events.slice(eventOffset));
      for (const message of messages) process.stdout.write(`${message}\n`);
      if (failure && !messages.length) {
        process.stdout.write(`${paint(errorMessage(failure), "yellow")}\n`);
      }
      if (!failure && !messages.length) process.stdout.write(`${paint("Copilot command completed.", "dim")}\n`);
      await readingPause(seconds);
    };

    process.stdout.write(`\u001b[2J\u001b[H${paint("GITHUB COPILOT CLI", "cyan")} ${paint("· Agent Harbor command tour", "dim")}\n`);
    process.stdout.write(`${cliVersion}\n`);
    process.stdout.write("Host real: copilot --experimental · extensión local agent-foundry · proyecto temporal aislado\n");
    process.stdout.write(`${paint("Los controles deterministas se invocan por el RPC nativo de Copilot y no envían prompts.", "dim")}\n`);
    await readingPause(5);

    section("Roster de Copilot", "La extensión muestra equipo y actividad directamente en la sesión de Copilot.");
    await invoke("team", "", 7);
    await invoke("bench", "on all", 7, "/bench on all");
    await invoke("bench", "list design", 5, "/bench list design");

    section("Compañero personal", "Copilot registra el jugador; /team confirma si el loader y el modelo lo dejan listo para /player.");
    const definition = JSON.stringify({
      name: "demo-reviewer",
      description: "Review a change for correctness and risk.",
      prompt: "Review the requested change and report only actionable findings.",
      tools: ["read", "search"],
    });
    await invoke("join", definition, 6, `/join ${definition}`);
    await invoke("team", "demo-reviewer", 6, "/team demo-reviewer");

    section("Todos los comandos de Copilot", "Catálogo leído de session.commands.list: comandos client y el skill /contract.");
    const catalog = await session.rpc.commands.list({ includeBuiltins: false, includeSkills: true, includeClientCommands: true });
    renderCommandCatalog(catalog.commands.filter((command) =>
      command.kind === "client" || command.name === "agent-foundry:contract"));
    await readingPause(8);

    section("Skills confiables", "La búsqueda usa el mismo resolver de snapshots que la extensión de Copilot.");
    await invoke("list-skills", "zx-example-author", 6, "/list-skills zx-example-author");
    await invoke("team", "stop all", 4, "/team stop all");
    await invoke("team", "help", 7, "/team help");

    section("Preflight sin inferencia", "Cada frontera inteligente rechaza una tarea vacía antes de crear un root o child.");
    commandCount += 1;
    await typeCommand("/contract {}");
    try { await runCopilotControl("contract", "{}", project); }
    catch (error) {
      process.stdout.write(`${paint(errorMessage(error), "yellow")}\nCopilot /contract skill preflight · no model was called · 0 model tokens.\n`);
    }
    await readingPause(5);
    await invoke("player", "", 4, "/player");
    for (const name of [
      "scout", "team-lead", "crafter", "portfolio-management", "design", "build", "manage", "consume", "dispose",
    ]) await invoke(name, "", 4, `/${name}`);

    section("Cleanup", "Copilot retira el compañero personal y devuelve los seis especialistas al bench.");
    await invoke("retire", "demo-reviewer", 5, "/retire demo-reviewer");
    process.stdout.write(`${paint("Repetimos el mismo comando: debe ser un no-op explícito.", "dim")}\n`);
    await invoke("retire", "demo-reviewer", 5, "/retire demo-reviewer");
    await invoke("bench", "off all", 7, "/bench off all");
    await invoke("team", "", 7);

    const usageAfter = await session.rpc.usage.getMetrics();
    if (stableJson(usageBefore) !== stableJson(usageAfter)) throw new Error("demo changed Copilot usage metrics");
    if (modelEvents.length) throw new Error(`demo emitted model events: ${modelEvents.join(", ")}`);
    permissionGate.assertSatisfied();
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    const cleanupErrors = [];
    if (session) {
      try { await client.deleteSession(session.sessionId); }
      catch (error) { cleanupErrors.push(error); }
    }
    try { await client.stop(); }
    catch (error) {
      cleanupErrors.push(error);
      try { await client.forceStop(); } catch (forceError) { cleanupErrors.push(forceError); }
    }
    if (!primaryError) {
      try { permissionGate.assertSatisfied(); }
      catch (error) { cleanupErrors.push(error); }
    }
    await rm(temporaryRoot, { recursive: true, force: true });
    if (!primaryError && cleanupErrors.length) throw new AggregateError(cleanupErrors, "Copilot demo cleanup failed");
  }
  process.stdout.write(`\n${paint("✓ Demo de Copilot completa", "green")} · ${commandCount} comandos · métricas sin cambios · 0 eventos de modelo.\n`);
  await readingPause(6);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error(paint(errorMessage(error), "red"));
    process.exitCode = 1;
  });
}
