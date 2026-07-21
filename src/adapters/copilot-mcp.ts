/**
 * Bounded stdio MCP server used by the Copilot plugins.
 *
 * With no arguments it exposes only the global `control` tool. With
 * `--skills-player <id>` it exposes only that player's no-argument `skills`
 * tool. `--scout` exposes only allowlist filtering and one deterministic join.
 */
import { Buffer } from "node:buffer";
import { createInterface } from "node:readline";
import { runCopilotControl } from "./copilot.js";
import { requireInvocablePlayer } from "../core/active.js";
import { trustedSkills } from "../core/defaults.js";
import { GhResolver } from "../core/github.js";
import { isHarborId } from "../core/identity.js";
import { formatLoadedSkillGroup, loadConfiguredSkills } from "../core/skills.js";
import { filterTrustedSkills, formatScoutSkillMatches } from "../core/scout.js";
import { commandNames, type CommandName } from "../core/types.js";

type JsonRpcId = number | string;

interface JsonRpcRequest {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

const maximumMessageBytes = 1_000_000;
const serverName = "agent-harbor";
const serverVersion = "0.12.0";
const supportedProtocolVersions = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"] as const;
const activeRequests = new Map<JsonRpcId, AbortController>();
let initializeSeen = false;
let initialized = false;
function scopedMode(args: readonly string[]): { kind: "control" } | { kind: "skills"; player: string } | { kind: "scout" } {
  if (!args.length) return { kind: "control" };
  if (args.length === 1 && args[0] === "--scout") return { kind: "scout" };
  if (args.length !== 2 || args[0] !== "--skills-player" || !isHarborId(args[1])) {
    throw new Error("usage: copilot-mcp.js [--skills-player <player-id>|--scout]");
  }
  return { kind: "skills", player: args[1] };
}

const mode = scopedMode(process.argv.slice(2));

const controlTool = {
  name: "control",
  description: "Execute one deterministic Agent Harbor lifecycle control or prepare one validated Copilot contract.",
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string", enum: commandNames },
      args: { type: "string", description: "Complete literal command arguments" },
    },
    required: ["command", "args"],
    additionalProperties: false,
  },
} as const;

const isolatedSkillTool = {
  name: "skills",
  description: "Load only the complete configured skill group bound to this Agent Harbor player server.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
} as const;

const scoutFilterTool = {
  name: "filter_skills",
  description: "Search only the exact Agent Harbor execution allowlist by name, coordinates, and bounded frontmatter description.",
  inputSchema: {
    type: "object", properties: { query: { type: "string", minLength: 1, maxLength: 500 } },
    required: ["query"], additionalProperties: false,
  },
} as const;

const scoutJoinTool = {
  name: "join_player",
  description: "Validate, register, and activate exactly one persistent Agent Harbor player.",
  inputSchema: {
    type: "object",
    properties: { definition: { type: "object", description: "Complete closed-schema Agent Harbor player definition" } },
    required: ["definition"], additionalProperties: false,
  },
} as const;

function listedTools() {
  if (mode.kind === "skills") return [isolatedSkillTool];
  if (mode.kind === "scout") return [scoutFilterTool, scoutJoinTool];
  return [controlTool];
}

function write(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function response(id: JsonRpcId, result: unknown): void {
  write({ jsonrpc: "2.0", id, result });
}

function protocolError(id: JsonRpcId | null, code: number, message: string): void {
  write({ jsonrpc: "2.0", id, error: { code, message } });
}

function toolError(error: unknown): { content: Array<{ type: "text"; text: string }>; isError: true } {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: "text", text: message }], isError: true };
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("tool arguments must be one object");
  return value as Record<string, unknown>;
}

function requireKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (actual.length !== canonical.length || actual.some((key, index) => key !== canonical[index])) throw new Error("tool arguments do not match the closed schema");
}

async function callTool(params: unknown, signal: AbortSignal): Promise<unknown> {
  const request = object(params);
  if (typeof request.name !== "string") throw new Error("tool name must be a string");
  const args = request.arguments === undefined ? {} : object(request.arguments);
  if (mode.kind === "control" && request.name === "control") {
    requireKeys(args, ["command", "args"]);
    if (!commandNames.includes(args.command as CommandName) || typeof args.args !== "string") throw new Error("invalid Agent Harbor control input");
    const text = await runCopilotControl(args.command as CommandName, args.args, process.cwd(), signal);
    return { content: [{ type: "text", text }], isError: false };
  }
  const playerId = mode.kind === "skills" && request.name === "skills"
    ? mode.player
    : undefined;
  if (playerId) {
    requireKeys(args, []);
    try {
      const player = requireInvocablePlayer("copilot", process.cwd(), playerId).definition;
      const loaded = await loadConfiguredSkills(player, process.cwd(), new GhResolver(), trustedSkills, signal);
      const text = formatLoadedSkillGroup(loaded);
      return { content: [{ type: "text", text }], isError: false };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`configured-skill-bootstrap: blocked (${message})`);
    }
  }
  if (mode.kind === "scout" && request.name === "filter_skills") {
    requireKeys(args, ["query"]);
    if (typeof args.query !== "string") throw new Error("skill filter query must be a string");
    const matches = await filterTrustedSkills(args.query, trustedSkills, new GhResolver(), signal);
    return { content: [{ type: "text", text: formatScoutSkillMatches(matches) }], isError: false };
  }
  if (mode.kind === "scout" && request.name === "join_player") {
    requireKeys(args, ["definition"]);
    const definition = object(args.definition);
    const joined = await runCopilotControl("join", JSON.stringify(definition), process.cwd(), signal);
    return { content: [{ type: "text", text: joined }], isError: false };
  }
  throw new Error(`unknown Agent Harbor tool: ${request.name}`);
}

async function handle(request: JsonRpcRequest): Promise<void> {
  const hasId = Object.hasOwn(request, "id");
  const id = request.id as JsonRpcId;
  if (request.jsonrpc !== "2.0" || typeof request.method !== "string" || (hasId && !(typeof id === "string" || typeof id === "number"))) {
    if (hasId) protocolError(id ?? null, -32600, "Invalid Request");
    return;
  }
  if (!hasId) {
    if (request.method === "notifications/initialized" && initializeSeen) initialized = true;
    if (request.method === "notifications/cancelled" && request.params && typeof request.params === "object") {
      // Cancellation is keyed to the JSON-RPC request so it reaches any active
      // gh subprocess through the shared AbortSignal.
      const requestId = (request.params as Record<string, unknown>).requestId;
      if (typeof requestId === "string" || typeof requestId === "number") activeRequests.get(requestId)?.abort();
    }
    return;
  }
  if (request.method === "initialize") {
    if (initializeSeen) {
      protocolError(id, -32600, "Already initialized");
      return;
    }
    const params = request.params && typeof request.params === "object" ? request.params as Record<string, unknown> : {};
    if (typeof params.protocolVersion !== "string") {
      protocolError(id, -32602, "initialize requires protocolVersion");
      return;
    }
    const protocolVersion = (supportedProtocolVersions as readonly string[]).includes(params.protocolVersion)
      ? params.protocolVersion : supportedProtocolVersions[0];
    initializeSeen = true;
    response(id, {
      protocolVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: serverName, version: serverVersion },
    });
    return;
  }
  if (request.method === "ping") {
    response(id, {});
    return;
  }
  if (!initialized) {
    protocolError(id, -32002, "Server not initialized");
    return;
  }
  if (request.method === "tools/list") {
    response(id, { tools: listedTools() });
    return;
  }
  if (request.method === "tools/call") {
    if (activeRequests.has(id)) {
      protocolError(id, -32600, "Duplicate active request id");
      return;
    }
    const controller = new AbortController();
    activeRequests.set(id, controller);
    try {
      response(id, await callTool(request.params, controller.signal));
    } catch (error) {
      response(id, toolError(error));
    } finally {
      if (activeRequests.get(id) === controller) activeRequests.delete(id);
    }
    return;
  }
  protocolError(id, -32601, "Method not found");
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
input.on("line", (line) => {
  if (!line.trim()) return;
  if (Buffer.byteLength(line, "utf8") > maximumMessageBytes) {
    protocolError(null, -32600, "Message too large");
    return;
  }
  try {
    const parsed = JSON.parse(line) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      protocolError(null, -32600, "Invalid Request");
      return;
    }
    void handle(parsed as JsonRpcRequest).catch(() => {
      const id = (parsed as JsonRpcRequest).id;
      protocolError(typeof id === "string" || typeof id === "number" ? id : null, -32603, "Internal error");
    });
  } catch {
    protocolError(null, -32700, "Parse error");
  }
});
