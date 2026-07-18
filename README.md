# Agent Harbor

A minimal GitHub Copilot CLI marketplace. It contains no application, package dependency, compiled output, extension process, or copied executable. Runtime behavior comes from Copilot's native agents, skills, GitHub MCP integration, and `task` delegation.

The two plugins are:

- **agent-foundry** — Markdown commands for `/join`, `/leave`, `/agents`, and `/contract`, plus one design agent and skill.
- **repo-cartographer** — a repository agent that combines a local mapping skill with an instruction-only Markdown projection from [`gvillarroel/zx-harness`](https://github.com/gvillarroel/zx-harness).

## Install

```powershell
copilot plugin marketplace add gvillarroel/marketplace
copilot plugin marketplace browse agent-harbor
copilot plugin install agent-foundry@agent-harbor
copilot plugin install repo-cartographer@agent-harbor
```

To refresh an existing installation:

```powershell
copilot plugin marketplace update agent-harbor
copilot plugin update agent-foundry
copilot plugin update repo-cartographer
```

Start a new interactive `copilot` session after installing or updating. Use `/help` to inspect commands, `/skills list` to confirm skills, and `/agent` to inspect agents.

## Disposable contractor

The original invocation now works without starting a nested SDK client:

```text
/contract {"name":"reviewer","description":"Read-only reviewer","prompt":"Review only; never edit.","tools":["read"],"skills":[{"kind":"github","repo":"gvillarroel/zx-harness","path":"skills/zx-example-author/SKILL.md","ref":"main"}]} :: review src and return three findings
```

`/contract` loads only the referenced `SKILL.md`, injects its Markdown into one synchronous native `task` call, returns the result, and retains no agent ID or skill file. Prefer a full commit SHA instead of `main` for reproducible runs. Copilot's native `explore` subagent provides a hard read-only boundary for the example above. Execute-only tasks use native `task`; tasks requesting edits use `general-purpose`. In those two modes the requested tool list is prompt policy, not a dynamic runtime allowlist.

## Permanent agents

```text
/join {"name":"reviewer","description":"Read-only project reviewer","prompt":"Return only high-confidence findings.","tools":["read","search"],"skills":[{"kind":"installed","name":"agent-blueprints"}]}
```

This creates `.github/agents/reviewer.agent.md`. Skill bodies are embedded with provenance because Copilot CLI agent frontmatter does not dynamically resolve a `skills` array. Start a new session, run `/agent`, and select `reviewer`.

The bundled agents omit `model`, so they inherit Copilot's current selection. Leaving the session on `Auto` lets the account choose an available low-cost model instead of pinning an unavailable model ID.

```text
/agents
/leave reviewer
```

`/leave` lets an agent leave the project team by removing only its managed Markdown profile unless `force: true` is explicit.

## Declarative boundary

- JSON is used only for the required marketplace and plugin manifests.
- Every behavior-bearing component is Markdown with YAML frontmatter.
- Remote skills are instruction-only: sibling scripts and resources are neither fetched nor executed.
- Contractors use the current Copilot runtime's subagent orchestration. There is no `CopilotClient`, platform package lookup, TypeScript runtime, or experimental extension.
- Copilot CLI 1.0.71 accepts only its built-in `explore`, `task`, and `general-purpose` values in `task.agent_type`; use `/join` when a durable agent needs a hard custom `tools` allowlist.
