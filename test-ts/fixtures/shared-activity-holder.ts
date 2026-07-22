import { claimSharedAgentActivity } from "../../src/adapters/opencode-agent-activity.js";

const [project, agent = "crafter"] = process.argv.slice(2);
if (!project) throw new Error("usage: shared-activity-holder <project> [agent]");
const claim = claimSharedAgentActivity(project, agent, "direct", `holder:${process.pid}:${agent}`, "pi");
process.stdout.write(`${JSON.stringify({ ready: true })}\n`);
await new Promise<void>((resolve) => process.stdin.once("data", () => resolve()));
if (!claim.release()) throw new Error("shared activity holder could not release its exact claim");
process.stdout.write(`${JSON.stringify({ released: true })}\n`);
