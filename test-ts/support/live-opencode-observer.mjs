import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";

const schema = "agent-harbor/live-opencode-observer@1";
const expectedAgents = ["scout", "sage", "smith", "probe", "guard", "pilot"];

function sha256(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

function fingerprint(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? null);
  return { sha256: sha256(text), utf8Bytes: Buffer.byteLength(text, "utf8") };
}

function occurrences(value, needle) {
  if (!needle) return 0;
  let count = 0;
  let offset = 0;
  while ((offset = value.indexOf(needle, offset)) >= 0) {
    count += 1;
    offset += needle.length;
  }
  return count;
}

function textParts(parts) {
  if (!Array.isArray(parts)) return "";
  return parts.filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n");
}

function foldMarkdownWrappedText(value) {
  return String(value)
    .replace(/\r\n?/gu, "\n")
    .split("\n")
    .map((line) => line.replace(/^(?:\s*>\s*)+/u, ""))
    .filter((line) => !/^\s*(?:`{3,}|~{3,})(?:[\w-]+)?\s*$/u.test(line))
    .join("\n")
    .replace(/\s+/gu, " ")
    .trim();
}

function commandClass(toolName, args) {
  if (toolName !== "bash") return null;
  const command = typeof args?.command === "string" ? args.command.trim() : "";
  return /^(?:npm(?:\.cmd)?\s+test)(?:\s+--\s*)?$/iu.test(command) ? "npm-test" : "other";
}

export const AgentHarborLiveObserver = async () => {
  const tracePath = process.env.AGENT_HARBOR_LIVE_TRACE_FILE?.trim();
  const nonce = process.env.AGENT_HARBOR_LIVE_NONCE?.trim();
  if (!tracePath || !nonce) throw new Error("Agent Harbor live observer requires its trace path and nonce");

  let sequence = 0;
  let delegationsInFlight = 0;
  let maxConcurrentDelegations = 0;
  const observedAssistantMessages = new Set();
  const observedToolTerminals = new Set();
  const delegationCalls = new Map();
  const delegationResults = new Map();
  const write = (event) => appendFileSync(tracePath, `${JSON.stringify({ schema, sequence: ++sequence, ...event })}\n`, "utf8");
  write({ kind: "observer.loaded" });

  return {
    "chat.message": async (input, output) => {
      const prompt = textParts(output.parts);
      const model = output.message?.model ?? input.model;
      write({
        kind: "chat.message",
        sessionSha256: sha256(input.sessionID),
        agent: output.message?.agent ?? input.agent ?? null,
        provider: model?.providerID ?? null,
        model: model?.modelID ?? null,
        variant: input.variant ?? output.message?.variant ?? output.message?.model?.variant ?? null,
        prompt: fingerprint(prompt),
        nonceOccurrences: occurrences(prompt, nonce),
      });
    },
    "tool.execute.before": async (input, output) => {
      const callSha256 = sha256(input.callID);
      if (input.tool === "harbor_delegate") {
        const agent = typeof output.args?.agent === "string" ? output.args.agent : null;
        const task = typeof output.args?.task === "string" ? output.args.task : "";
        const index = agent ? expectedAgents.indexOf(agent) : -1;
        const predecessor = index > 0 ? `HARBOR_HANDOFF:${expectedAgents[index - 1]}:${nonce}` : "";
        delegationsInFlight += 1;
        maxConcurrentDelegations = Math.max(maxConcurrentDelegations, delegationsInFlight);
        delegationCalls.set(input.callID, { agent });
        write({
          kind: "delegation.start",
          sessionSha256: sha256(input.sessionID),
          callSha256,
          agent,
          task: fingerprint(task),
          nonceOccurrences: occurrences(task, nonce),
          predecessorMarkerOccurrences: occurrences(task, predecessor),
          completePredecessorCopied: index > 0 && foldMarkdownWrappedText(delegationResults.get(expectedAgents[index - 1]) ?? "").length > predecessor.length + 32
            ? foldMarkdownWrappedText(task).includes(foldMarkdownWrappedText(delegationResults.get(expectedAgents[index - 1])))
            : false,
          concurrentDelegations: delegationsInFlight,
          maxConcurrentDelegations,
        });
        return;
      }
      write({
        kind: "specialist.tool.start",
        sessionSha256: sha256(input.sessionID),
        callSha256,
        tool: input.tool,
        commandClass: commandClass(input.tool, output.args),
        args: fingerprint(output.args),
      });
    },
    "tool.execute.after": async (input, output) => {
      const callSha256 = sha256(input.callID);
      if (input.tool === "harbor_delegate") {
        const tracked = delegationCalls.get(input.callID);
        const agent = tracked?.agent ?? (typeof input.args?.agent === "string" ? input.args.agent : null);
        const result = typeof output.output === "string" ? output.output : JSON.stringify(output.output ?? null);
        const marker = agent ? `HARBOR_HANDOFF:${agent}:${nonce}` : "";
        delegationsInFlight = Math.max(0, delegationsInFlight - 1);
        delegationCalls.delete(input.callID);
        if (agent) delegationResults.set(agent, result);
        write({
          kind: "delegation.end",
          sessionSha256: sha256(input.sessionID),
          callSha256,
          agent,
          evidence: fingerprint(result),
          nonceOccurrences: occurrences(result, nonce),
          markerOccurrences: occurrences(result, marker),
          allCycleMarkerOccurrences: expectedAgents.reduce(
            (total, candidate) => total + occurrences(result, `HARBOR_HANDOFF:${candidate}:${nonce}`),
            0,
          ),
          standaloneFinalLine: Boolean(marker) && result.trimEnd().split(/\r?\n/u).at(-1)?.trim() === marker,
          concurrentDelegations: delegationsInFlight,
          maxConcurrentDelegations,
        });
        return;
      }
      write({
        kind: "specialist.tool.end",
        sessionSha256: sha256(input.sessionID),
        callSha256,
        tool: input.tool,
        output: fingerprint(output.output),
      });
    },
    event: async ({ event }) => {
      if (event.type === "session.created" || event.type === "session.deleted") {
        const info = event.properties?.info;
        if (!info?.id) return;
        write({
          kind: event.type,
          sessionSha256: sha256(info.id),
          parentSessionSha256: info.parentID ? sha256(info.parentID) : null,
          title: fingerprint(info.title ?? ""),
        });
        return;
      }
      if (event.type === "message.part.updated") {
        const part = event.properties?.part;
        if (part?.type !== "tool" || !["completed", "error"].includes(part.state?.status) || observedToolTerminals.has(part.callID)) return;
        observedToolTerminals.add(part.callID);
        write({
          kind: part.state.status === "completed" ? "native.tool.completed" : "native.tool.failed",
          sessionSha256: sha256(part.sessionID),
          callSha256: sha256(part.callID),
          tool: part.tool,
          commandClass: commandClass(part.tool, part.state.input),
          outcome: part.state.status === "completed" ? "ok" : "error",
          result: fingerprint(part.state.status === "completed" ? part.state.output : part.state.error),
        });
        return;
      }
      if (event.type !== "message.updated") return;
      const info = event.properties?.info;
      if (info?.role !== "assistant" || !info.time?.completed || observedAssistantMessages.has(info.id)) return;
      observedAssistantMessages.add(info.id);
      const tokens = info.tokens ?? {};
      const usage = {
        inputTokens: Number(tokens.input ?? 0),
        outputTokens: Number(tokens.output ?? 0),
        reasoningTokens: Number(tokens.reasoning ?? 0),
        cacheReadTokens: Number(tokens.cache?.read ?? 0),
        cacheWriteTokens: Number(tokens.cache?.write ?? 0),
      };
      usage.totalTokens = usage.inputTokens + usage.outputTokens + usage.reasoningTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
      write({
        kind: "model.completed",
        sessionSha256: sha256(info.sessionID),
        messageSha256: sha256(info.id),
        agent: info.agent ?? info.mode ?? null,
        provider: info.providerID ?? null,
        model: info.modelID ?? null,
        usage,
        cost: Number(info.cost ?? 0),
        finish: info.finish ?? null,
        outcome: info.error ? "error" : "ok",
        ...(info.error ? { error: fingerprint(info.error) } : {}),
      });
    },
  };
};

export default AgentHarborLiveObserver;
