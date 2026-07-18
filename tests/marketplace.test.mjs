import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";

const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));

test("marketplace exposes two valid local plugins", async () => {
  const market = await readJson(".github/plugin/marketplace.json");
  assert.equal(market.plugins.length, 2);
  assert.deepEqual(market.plugins.map((plugin) => plugin.name), ["agent-foundry", "repo-cartographer"]);
  for (const plugin of market.plugins) {
    const manifest = await readJson(`${plugin.source}/plugin.json`);
    assert.equal(manifest.name, plugin.name);
  }
});

test("agent-foundry ships a compiled Copilot extension", async () => {
  await access("plugins/agent-foundry/extensions/agent-foundry/extension.mjs");
  await access("plugins/agent-foundry/extensions/agent-foundry/dist/extension.js");
});

test("all declared agents and skills exist", async () => {
  for (const id of ["agent-foundry", "repo-cartographer"]) {
    const manifest = await readJson(`plugins/${id}/plugin.json`);
    await access(`plugins/${id}/${manifest.agents}`);
    await access(`plugins/${id}/${manifest.skills}`);
  }
});
