import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDefinition, renderAgentMarkdown, resolveCopilotCliPath, savePermanentAgent, removePermanentAgent } from "../plugins/agent-foundry/extensions/agent-foundry/dist/core.js";

const definition = { name: "Review Agent", description: "Read-only reviewer", prompt: "Review the requested files.", tools: ["read"], skills: [{ kind: "local", path: "skills/review/SKILL.md", name: "review" }] };

test("normalizes and renders Copilot-compatible agent frontmatter", () => {
  const parsed = parseDefinition(JSON.stringify(definition));
  assert.equal(parsed.name, "review-agent");
  const markdown = renderAgentMarkdown(parsed);
  assert.match(markdown, /name: review-agent/);
  assert.match(markdown, /skills: \["review"\]/);
});

test("permanent agents can be hired and fired", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-harbor-test-"));
  try {
    const path = await savePermanentAgent(definition, root);
    assert.match(await readFile(path, "utf8"), /Read-only reviewer/);
    await removePermanentAgent("review-agent", root);
    await assert.rejects(readFile(path, "utf8"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("nested SDK sessions resolve the installed Copilot CLI", () => {
  const path = resolveCopilotCliPath();
  assert.match(path, /copilot(?:\.exe)?$/i);
});

test("prefers the runtime distribution injected by the extension host", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-harbor-runtime-"));
  try {
    const runtime = join(root, "index.js");
    await import("node:fs/promises").then(({ writeFile }) => writeFile(runtime, "// fixture\n", "utf8"));
    assert.equal(resolveCopilotCliPath({ COPILOT_CLI_DIST_DIR: root }), runtime);
  } finally { await rm(root, { recursive: true, force: true }); }
});
