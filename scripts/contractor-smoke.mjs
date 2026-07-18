import { runContractor } from "../plugins/agent-foundry/extensions/agent-foundry/dist/contractor.js";

const result = await runContractor({
  name: "reviewer",
  description: "Read-only reviewer",
  prompt: "Reply only with CONTRACT_OK; never edit.",
  tools: ["read"],
  skills: [{
    kind: "github",
    repo: "gvillarroel/zx-harness",
    path: "skills/zx-example-author/SKILL.md",
    ref: "main",
  }],
}, "Reply exactly CONTRACT_OK.");

if (!result.includes("CONTRACT_OK")) throw new Error(`Unexpected contractor response: ${result}`);
console.log(result);
