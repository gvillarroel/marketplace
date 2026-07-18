# Agent Harbor

A focused GitHub Copilot CLI plugin marketplace containing two installable plugins:

- **agent-foundry** — agents, a local skill, and a TypeScript-authored Copilot CLI extension for hiring permanent agents, firing them, listing them, and executing disposable contractors through `@github/copilot-sdk`.
- **repo-cartographer** — a repository agent that mixes a local mapping skill with a skill sourced from [`gvillarroel/zx-harness`](https://github.com/gvillarroel/zx-harness).

## Install from the marketplace

```powershell
copilot plugin marketplace add gvillarroel/marketplace
copilot plugin marketplace browse agent-harbor
copilot plugin install agent-foundry@agent-harbor
copilot plugin install repo-cartographer@agent-harbor
```

For local development, replace `gvillarroel/marketplace` with this repository's absolute path.

Extensions are experimental in Copilot CLI. Start with:

```powershell
copilot --experimental --plugin-dir ./plugins/agent-foundry
```

Available extension commands are `/agents`, `/hire`, `/fire`, and `/contract`. The equivalent model-callable tools are `agent_hire`, `agent_fire`, and `agent_contract`.

Contractor format:

```text
/contract {"name":"reviewer","description":"Read-only reviewer","prompt":"Review only; never edit.","tools":["read"],"skills":[{"kind":"github","repo":"gvillarroel/zx-harness","path":"skills/zx-example-author/SKILL.md","ref":"main"}]} :: review src and return three findings
```

The contractor resolves skills into a temporary directory, opens an isolated SDK session with minimal reasoning and no memory, runs one task, destroys the session, and deletes the temporary skills. Permanent agents are written to `.github/agents/NAME.agent.md`.

The extension resolves the installed native `copilot` executable explicitly because the injected SDK cannot resolve the optional platform package needed by a nested `CopilotClient`. For a custom installation that is not on `PATH`, set `AGENT_HARBOR_CLI_PATH` to its absolute path.

## Validate

```powershell
npm test
npm run build
npm run test:copilot
npm run test:contractor
```

The last command consumes a small amount of Copilot quota; it installs both plugins and performs a single capped `gpt-5-mini` extension discovery check.
