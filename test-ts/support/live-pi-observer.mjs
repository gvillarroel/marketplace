import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const schema = "agent-harbor/live-pi-observer@1";
const expectedAgents = ["scout", "sage", "smith", "probe", "guard", "pilot"];
const packageRoot = process.env.AGENT_HARBOR_PI_PACKAGE_ROOT?.trim();
const tracePath = process.env.AGENT_HARBOR_LIVE_TRACE_FILE?.trim();
const nonce = process.env.AGENT_HARBOR_LIVE_NONCE?.trim();
if (!packageRoot || !tracePath || !nonce) throw new Error("Agent Harbor Pi observer requires package root, trace path, and nonce");

const sdk = await import(pathToFileURL(join(packageRoot, "dist", "index.js")).href);
const originalPrompt = sdk.AgentSession.prototype.prompt;
const patched = Symbol.for("agent-harbor.live-pi-observer.patched");
let sequence = 0;
let delegationsInFlight = 0;
let maxConcurrentDelegations = 0;
const delegationResults = new Map();

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

function resultText(value) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  if (Array.isArray(value)) return value.map(resultText).filter(Boolean).join("\n");
  if (Array.isArray(value.content)) return resultText(value.content);
  if (typeof value.text === "string") return value.text;
  return "";
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

function write(event) {
  appendFileSync(tracePath, `${JSON.stringify({ schema, sequence: ++sequence, ...event })}\n`, "utf8");
}

if (!sdk.AgentSession.prototype[patched]) {
  Object.defineProperty(sdk.AgentSession.prototype, patched, { value: true });
  sdk.AgentSession.prototype.prompt = async function agentHarborObservedPrompt(prompt, ...rest) {
    const promptText = typeof prompt === "string" ? prompt : JSON.stringify(prompt ?? null);
    const identity = /^Identity:\s*([a-z0-9-]+)\s*$/mu.exec(promptText)?.[1];
    if (!identity) return originalPrompt.call(this, prompt, ...rest);

    const statsBefore = this.getSessionStats();
    const sessionSha256 = sha256(statsBefore.sessionId);
    let output = "";
    let turnStarts = 0;
    let turnEnds = 0;
    let toolStarts = 0;
    let toolEnds = 0;
    let settled = 0;
    const openDelegations = new Map();
    write({
      kind: "session.prompt",
      sessionSha256,
      agent: identity,
      prompt: fingerprint(promptText),
      nonceOccurrences: occurrences(promptText, nonce),
    });

    const unsubscribe = this.subscribe((event) => {
      try {
        if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
          output += event.assistantMessageEvent.delta ?? "";
          return;
        }
        if (event.type === "turn_start") {
          turnStarts += 1;
          write({ kind: "turn.start", sessionSha256, agent: identity, turnIndex: event.turnIndex ?? null });
          return;
        }
        if (event.type === "turn_end") {
          turnEnds += 1;
          write({ kind: "turn.end", sessionSha256, agent: identity, turnIndex: event.turnIndex ?? null });
          return;
        }
        if (event.type === "tool_execution_start") {
          toolStarts += 1;
          const callSha256 = sha256(event.toolCallId);
          if (event.toolName === "harbor_delegate") {
            const agent = typeof event.args?.agent === "string" ? event.args.agent : null;
            const task = typeof event.args?.task === "string" ? event.args.task : "";
            const index = agent ? expectedAgents.indexOf(agent) : -1;
            const predecessor = index > 0 ? `HARBOR_HANDOFF:${expectedAgents[index - 1]}:${nonce}` : "";
            delegationsInFlight += 1;
            maxConcurrentDelegations = Math.max(maxConcurrentDelegations, delegationsInFlight);
            openDelegations.set(event.toolCallId, agent);
            write({
              kind: "delegation.start",
              sessionSha256,
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
          } else {
            write({
              kind: "specialist.tool.start",
              sessionSha256,
              agent: identity,
              callSha256,
              tool: event.toolName,
              commandClass: commandClass(event.toolName, event.args),
              args: fingerprint(event.args),
            });
          }
          return;
        }
        if (event.type === "tool_execution_end") {
          toolEnds += 1;
          const callSha256 = sha256(event.toolCallId);
          if (event.toolName === "harbor_delegate") {
            const agent = openDelegations.get(event.toolCallId) ?? null;
            const text = resultText(event.result);
            const marker = agent ? `HARBOR_HANDOFF:${agent}:${nonce}` : "";
            delegationsInFlight = Math.max(0, delegationsInFlight - 1);
            openDelegations.delete(event.toolCallId);
            if (agent) delegationResults.set(agent, text);
            write({
              kind: "delegation.end",
              sessionSha256,
              callSha256,
              agent,
              evidence: fingerprint(text),
              nonceOccurrences: occurrences(text, nonce),
              markerOccurrences: occurrences(text, marker),
              allCycleMarkerOccurrences: expectedAgents.reduce(
                (total, candidate) => total + occurrences(text, `HARBOR_HANDOFF:${candidate}:${nonce}`),
                0,
              ),
              standaloneFinalLine: Boolean(marker) && text.trimEnd().split(/\r?\n/u).at(-1)?.trim() === marker,
              isError: Boolean(event.isError),
              concurrentDelegations: delegationsInFlight,
              maxConcurrentDelegations,
            });
          } else {
            write({ kind: "specialist.tool.end", sessionSha256, agent: identity, callSha256, tool: event.toolName, result: fingerprint(event.result), isError: Boolean(event.isError) });
          }
          return;
        }
        if (event.type === "message_end" && event.message?.role === "assistant") {
          const usage = event.message.usage ?? {};
          write({
            kind: "model.completed",
            sessionSha256,
            agent: identity,
            provider: event.message.provider ?? null,
            model: event.message.model ?? null,
            usage: {
              inputTokens: Number(usage.input ?? 0),
              outputTokens: Number(usage.output ?? 0),
              reasoningTokens: Number(usage.reasoning ?? 0),
              cacheReadTokens: Number(usage.cacheRead ?? 0),
              cacheWriteTokens: Number(usage.cacheWrite ?? 0),
              totalTokens: Number(usage.totalTokens ?? 0),
            },
            cost: Number(usage.cost?.total ?? 0),
            stopReason: event.message.stopReason ?? null,
          });
          return;
        }
        if (event.type === "agent_settled") {
          settled += 1;
          write({ kind: "agent.settled", sessionSha256, agent: identity });
        }
      } catch {
        // The acceptance test will reject a missing or incomplete trace; observation never changes the model run.
      }
    });

    let failure;
    try {
      return await originalPrompt.call(this, prompt, ...rest);
    } catch (error) {
      failure = error;
      write({ kind: "session.error", sessionSha256, agent: identity, error: fingerprint(error instanceof Error ? error.message : String(error)) });
      throw error;
    } finally {
      unsubscribe();
      const stats = this.getSessionStats();
      const marker = `HARBOR_HANDOFF:${identity}:${nonce}`;
      write({
        kind: "session.completed",
        sessionSha256,
        agent: identity,
        outcome: failure ? "error" : "ok",
        output: fingerprint(output),
        markerOccurrences: occurrences(output, marker),
        standaloneFinalLine: output.trimEnd().split(/\r?\n/u).at(-1)?.trim() === marker,
        turnStarts,
        turnEnds,
        toolStarts,
        toolEnds,
        settled,
        stats: {
          userMessages: Number(stats.userMessages ?? 0),
          assistantMessages: Number(stats.assistantMessages ?? 0),
          toolCalls: Number(stats.toolCalls ?? 0),
          toolResults: Number(stats.toolResults ?? 0),
          totalMessages: Number(stats.totalMessages ?? 0),
          tokens: {
            inputTokens: Number(stats.tokens?.input ?? 0),
            outputTokens: Number(stats.tokens?.output ?? 0),
            cacheReadTokens: Number(stats.tokens?.cacheRead ?? 0),
            cacheWriteTokens: Number(stats.tokens?.cacheWrite ?? 0),
            totalTokens: Number(stats.tokens?.total ?? 0),
          },
          cost: Number(stats.cost ?? 0),
        },
      });
    }
  };
}
