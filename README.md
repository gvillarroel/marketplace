# Agent Harbor

A minimal GitHub Copilot CLI marketplace. It contains no application, package dependency, compiled output, extension process, or copied executable. Runtime behavior comes from Copilot's native agents, skills, GitHub MCP integration, and `task` delegation.

The two plugins are:

- **agent-foundry** — Markdown commands for `join`, `leave`, `agents`, `contract`, and `list-skills`, plus declarative agent and trust-policy skills.
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

Start a new interactive `copilot` session after installing or updating. Plugin commands are namespaced as `/agent-foundry:<command>`. Use `/help` to inspect commands, Copilot's built-in `/skills list` to confirm loaded skills, `/agent-foundry:list-skills` to inspect agent-foundry's trusted remote catalog, and `/agent` to inspect agents.

## Trusted remote skills

```text
/agent-foundry:list-skills
/agent-foundry:list-skills zx
```

`/agent-foundry:list-skills` loads the plugin's internal Markdown trust policy and makes read-only `gh api` calls. It lists paths without downloading skill bodies or executing repository content. Shell access is not preapproved, so Copilot may ask once before running the exact read-only `gh` request. The active example trusts only `skills/zx-example-author/SKILL.md` from `gvillarroel/zx-harness` at commit `181983bb58138ba3cc9aab25dd78b0557111d2bb`.

The policy supports three scopes: an entire pinned repository, every `SKILL.md` below one pinned subfolder, or one or more exact pinned `SKILL.md` paths. GitHub references used by `/agent-foundry:join` and `/agent-foundry:contract` must be covered by this policy.

## Disposable contractor

The original invocation now works without starting a nested SDK client:

```text
/agent-foundry:contract {"name":"reviewer","description":"Read-only reviewer","prompt":"Review only; never edit.","tools":["read"],"skills":[{"kind":"github","repo":"gvillarroel/zx-harness","path":"skills/zx-example-author/SKILL.md","ref":"181983bb58138ba3cc9aab25dd78b0557111d2bb"}]} :: review src and return three findings
```

`/agent-foundry:contract` verifies the GitHub reference against the trusted catalog, loads only the referenced `SKILL.md`, injects its Markdown into one synchronous native `task` call, returns the result, and retains no agent ID or skill file. Copilot's native `explore` subagent provides a hard read-only boundary for the example above. Execute-only tasks use native `task`; tasks requesting edits use `general-purpose`. In those two modes the requested tool list is prompt policy, not a dynamic runtime allowlist.

## Permanent agents

```text
/agent-foundry:join {"name":"reviewer","description":"Read-only project reviewer","prompt":"Return only high-confidence findings.","tools":["read","search"],"skills":[{"kind":"installed","name":"agent-blueprints"}]}
```

This creates `.github/agents/reviewer.agent.md`. Skill bodies are embedded with provenance because Copilot CLI agent frontmatter does not dynamically resolve a `skills` array. Start a new session, run `/agent`, and select `reviewer`.

The bundled agents omit `model`, so they inherit Copilot's current selection. Leaving the session on `Auto` lets the account choose an available low-cost model instead of pinning an unavailable model ID.

```text
/agent-foundry:agents
/agent-foundry:leave reviewer
```

`/agent-foundry:leave` lets an agent leave the project team by removing only its managed Markdown profile unless `force: true` is explicit.

## Declarative boundary

- JSON is used only for the required marketplace and plugin manifests.
- Every behavior-bearing component is Markdown with YAML frontmatter.
- Trusted remote scope is declared in the internal `trusted-skill-sources` Markdown skill.
- Remote skills are instruction-only: sibling scripts and resources are neither fetched nor executed.
- Contractors use the current Copilot runtime's subagent orchestration. There is no `CopilotClient`, platform package lookup, TypeScript runtime, or experimental extension.
- Copilot CLI 1.0.71 accepts only its built-in `explore`, `task`, and `general-purpose` values in `task.agent_type`; use `/agent-foundry:join` when a durable agent needs a hard custom `tools` allowlist.
