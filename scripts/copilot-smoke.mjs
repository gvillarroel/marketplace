import { spawnSync } from "node:child_process";

const run = (args, env = {}) => {
  const result = spawnSync("copilot", args, { encoding: "utf8", env: { ...process.env, ...env } });
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  if (result.status !== 0) process.exit(result.status ?? 1);
};

run(["plugin", "marketplace", "add", process.cwd()]);
run(["plugin", "install", "agent-foundry@agent-harbor"]);
run(["plugin", "install", "repo-cartographer@agent-harbor"]);
run(["plugin", "list"]);
run(["-p", "Reply with only EXTENSION_OK after confirming the agent_hire tool is available. Do not call it.", "--experimental", "--plugin-dir", "./plugins/agent-foundry", "--model", process.env.AGENT_HARBOR_MODEL ?? "auto", "--max-ai-credits", "30", "--allow-all-tools", "--no-custom-instructions", "--silent"], { GITHUB_COPILOT_PROMPT_MODE_EXTENSIONS: "true" });
