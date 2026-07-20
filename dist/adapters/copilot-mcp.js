import { Buffer } from "node:buffer";
import { createInterface } from "node:readline";
import { runCopilotControl } from "./copilot.js";
import { trustedSkills } from "../core/defaults.js";
import { GhResolver, loadTrustedGithubSkill } from "../core/github.js";
import { commandNames } from "../core/types.js";
const maximumMessageBytes = 1_000_000;
const serverName = "agent-harbor";
const serverVersion = "0.11.0";
const supportedProtocolVersions = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const activeRequests = new Map();
let initializeSeen = false;
let initialized = false;
const tools = [{
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
    }, {
        name: "skill",
        description: "Resolve one exact allowlisted GitHub SKILL.md snapshot and return validated invocation-local guidance.",
        inputSchema: {
            type: "object",
            properties: {
                reference: { type: "string", description: "Complete canonical GitHub skill reference JSON" },
            },
            required: ["reference"],
            additionalProperties: false,
        },
    }];
function write(message) {
    process.stdout.write(`${JSON.stringify(message)}\n`);
}
function response(id, result) {
    write({ jsonrpc: "2.0", id, result });
}
function protocolError(id, code, message) {
    write({ jsonrpc: "2.0", id, error: { code, message } });
}
function toolError(error) {
    const message = error instanceof Error ? error.message : String(error);
    return { content: [{ type: "text", text: message }], isError: true };
}
function object(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("tool arguments must be one object");
    return value;
}
function requireKeys(value, expected) {
    const actual = Object.keys(value).sort();
    const canonical = [...expected].sort();
    if (actual.length !== canonical.length || actual.some((key, index) => key !== canonical[index]))
        throw new Error("tool arguments do not match the closed schema");
}
async function callTool(params, signal) {
    const request = object(params);
    if (typeof request.name !== "string")
        throw new Error("tool name must be a string");
    const args = object(request.arguments);
    if (request.name === "control") {
        requireKeys(args, ["command", "args"]);
        if (!commandNames.includes(args.command) || typeof args.args !== "string")
            throw new Error("invalid Agent Harbor control input");
        const text = await runCopilotControl(args.command, args.args, process.cwd(), signal);
        return { content: [{ type: "text", text }], isError: false };
    }
    if (request.name === "skill") {
        requireKeys(args, ["reference"]);
        if (typeof args.reference !== "string")
            throw new Error("reference must be one JSON string");
        try {
            const loaded = await loadTrustedGithubSkill(JSON.parse(args.reference), trustedSkills, new GhResolver(), signal);
            const text = `HARBOR-COMMIT ${loaded.commit}\nHARBOR-SKILL ${loaded.skill.name}\n${loaded.body}`;
            return { content: [{ type: "text", text }], isError: false };
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`external-skill-bootstrap: blocked (${message})`);
        }
    }
    throw new Error(`unknown Agent Harbor tool: ${request.name}`);
}
async function handle(request) {
    const hasId = Object.hasOwn(request, "id");
    const id = request.id;
    if (request.jsonrpc !== "2.0" || typeof request.method !== "string" || (hasId && !(typeof id === "string" || typeof id === "number"))) {
        if (hasId)
            protocolError(id ?? null, -32600, "Invalid Request");
        return;
    }
    if (!hasId) {
        if (request.method === "notifications/initialized" && initializeSeen)
            initialized = true;
        if (request.method === "notifications/cancelled" && request.params && typeof request.params === "object") {
            const requestId = request.params.requestId;
            if (typeof requestId === "string" || typeof requestId === "number")
                activeRequests.get(requestId)?.abort();
        }
        return;
    }
    if (request.method === "initialize") {
        if (initializeSeen) {
            protocolError(id, -32600, "Already initialized");
            return;
        }
        const params = request.params && typeof request.params === "object" ? request.params : {};
        if (typeof params.protocolVersion !== "string") {
            protocolError(id, -32602, "initialize requires protocolVersion");
            return;
        }
        const protocolVersion = supportedProtocolVersions.includes(params.protocolVersion)
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
        response(id, { tools });
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
        }
        catch (error) {
            response(id, toolError(error));
        }
        finally {
            if (activeRequests.get(id) === controller)
                activeRequests.delete(id);
        }
        return;
    }
    protocolError(id, -32601, "Method not found");
}
const input = createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
input.on("line", (line) => {
    if (!line.trim())
        return;
    if (Buffer.byteLength(line, "utf8") > maximumMessageBytes) {
        protocolError(null, -32600, "Message too large");
        return;
    }
    try {
        const parsed = JSON.parse(line);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            protocolError(null, -32600, "Invalid Request");
            return;
        }
        void handle(parsed).catch(() => {
            const id = parsed.id;
            protocolError(typeof id === "string" || typeof id === "number" ? id : null, -32603, "Internal error");
        });
    }
    catch {
        protocolError(null, -32700, "Parse error");
    }
});
