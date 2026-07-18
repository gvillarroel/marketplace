# Agent Harbor

A minimal GitHub Copilot CLI marketplace. It contains no application, package dependency, compiled output, extension process, or copied executable. Runtime behavior comes from Copilot's native agents, skills, GitHub MCP integration, and `task` delegation.

The two plugins are:

- **agent-foundry** — Markdown commands for `join`, `lineup`, `leave`, `retire`, `agents`, `contract`, and `list-skills`, plus `team-lead`, personal benches, a parked SDLC roster, agent design, and trust-policy components.
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

## Personal roster and project lineup

Adding a recurring player always creates two Markdown profiles:

```text
/agent-foundry:join {"name":"reviewer","description":"Read-only project reviewer","prompt":"Return only high-confidence findings.","tools":["read","search"],"skills":[{"kind":"installed","name":"harbor-agent-blueprints"}]}
```

- `<copilot-home>/agents/af-bench--reviewer.agent.md` is the persistent personal registration. It has `tools: []` and both normal invocation paths disabled, so it cannot inspect, edit, execute, or be selected through normal model routing or slash completion outside a project lineup. Copilot CLI still permits a developer to force the technical ID explicitly with `--agent af-bench--reviewer`; in that override, the no-tools boundary is enforced while the final bench guard remains prompt policy.
- `<cwd>/.github/agents/reviewer.agent.md` is the active copy for the folder where it joined. It has the requested tools and is immediately eligible for `team-lead` after Copilot restarts.

The technical personal ID is intentionally different from the active ID. GitHub's CLI references disagree about whether personal or project agents win a same-ID collision, so this avoids depending on precedence. The personal registration is local to this developer machine; it is not synchronized through the GitHub account.

Copilot's programmatic `--agent` resolver can still resolve the technical personal ID even when it is not user-selectable. Its empty tool list and final mandatory bench guard keep it parked, and `team-lead` explicitly refuses every `af-bench--*` ID; this is defense-in-depth prompt policy rather than a process sandbox.

From another project, list or activate the registered player:

```text
/agent-foundry:lineup
/agent-foundry:lineup reviewer
```

Lifecycle commands stay short and team-themed:

```text
/agent-foundry:agents
/agent-foundry:leave reviewer
/agent-foundry:retire reviewer
```

`leave` removes only the active copy in the current folder, returning the player to the personal bench. `retire` permanently removes the personal registration and the managed active copy in the current folder; it cannot discover copies already activated in other projects. Skill instructions remain frozen as embedded Markdown until the player is joined again with `replace: true`.

## SDLC bench

Six bundled agent templates ship on the bench outside the plugin's registered `agents/` directory. They also have `tools: []` plus both invocation flags disabled, so Copilot CLI cannot route or select them as plugin agents. Put only the roles needed for the current folder into the active lineup:

```text
/agent-foundry:lineup
/agent-foundry:lineup scout sage smith probe guard
/agent-foundry:lineup all
```

`lineup` combines the bundled SDLC roster with valid personal `af-bench--*` registrations and writes only `.github/agents/*.agent.md` below the current working directory. `all` intentionally means only the complete bundled SDLC team; personal players must be named. Shell is limited to creating the literal active directory when absent and deleting an exact newly created target during rollback; profile contents always use Copilot's native `create`/`edit` tools. Existing conflicts are never overwritten. Multi-role activation preflights and prepares the full set, verifies every write, and attempts rollback on failure. Start a new Copilot session from that folder or one of its descendants; a session started above the folder does not search downward for agents.

| ID | SDLC stage | Responsibility | Embedded skills | Direct edit tool |
| --- | --- | --- | --- | --- |
| `scout` | Discover | Repository map, constraints, acceptance criteria | `harbor-repository-map` | No |
| `sage` | Design | Bounded design, slices, test strategy | `harbor-repository-map` | No |
| `smith` | Build | Smallest approved code and test changes | `harbor-repository-map`, `harbor-zx-author` | Yes |
| `probe` | Verify | Focused tests and reproducible evidence | `harbor-repository-map` | No |
| `guard` | Review | Correctness, security, scope and provenance gate | `harbor-repository-map`, `harbor-trusted-skill-sources` | No |
| `pilot` | Deliver | Release readiness and human-controlled handoff | `harbor-repository-map` | No |

Every marketplace-owned skill uses a collision-resistant `harbor-*` ID and an exact revision marker in its injected Markdown body because project and personal skills outrank plugin skills. `harbor-zx-author` is the instruction-only projection sourced from `gvillarroel/zx-harness`; it deliberately does not reuse the upstream `zx-example-author` name. Canonical commands fail closed when the ID or body marker does not match. The marker prevents accidental shadowing but is compatibility identity, not cryptographic provenance.

The handoff chain is `ScoutBrief → SagePlan → SmithChangeSet → ProbeReport → GuardGate → PilotReleasePacket`. `pilot` runs only for delivery work; a failed gate permits at most one bounded `smith → probe → guard` correction loop. Return a role to the packaged bench from the same folder with `/agent-foundry:leave <id>`.

Only `smith` receives Copilot's direct `edit` tool. `probe`, `guard`, and `pilot` retain `execute` for tests and read-only diagnostics, so their no-mutation boundary is explicit prompt policy: they reject formatters, installers, fix modes, generators, migrations, destructive commands, and any command expected to rewrite tracked source.

## Team lead

Select `agent-foundry:team-lead` from `/agent`, or start it directly:

```powershell
copilot --agent agent-foundry:team-lead
```

The team lead is an orchestration-only agent: it receives only `task`, `list_agents`, `read_agent`, and `write_agent`, so it cannot inspect, edit, execute, browse, or load a domain skill in the parent context. It routes software work through active bare IDs from the SDLC lineup, passes compact handoffs between dependent stages, uses `repo-cartographer:repo-cartographer` for repository or zx work without a better active stage role, and uses `agent-foundry:agent-architect` for rosters, lifecycle, or trusted-skill work. When no permanent specialist fits, it uses the least-capable compatible built-in as a disposable contractor.

Parameterized plugin commands remain explicit user actions because the native `skill` tool does not populate their `$ARGUMENTS`. The team lead therefore returns ready-to-run `/agent-foundry:lineup`, `/agent-foundry:join`, `/agent-foundry:leave`, `/agent-foundry:retire`, `/agent-foundry:contract`, or `/agent-foundry:list-skills` commands when needed instead of pretending it executed them.

Active project copies created by `join` or `lineup` are eligible for team-lead delegation. Technical personal-bench profiles use `disable-model-invocation: true`, `user-invocable: false`, and `tools: []`, and must never be routed. The team lead is itself manual-only to prevent recursive orchestration and inherits the session's selected model.

The bundled domain skills are model-discoverable because Copilot CLI 1.0.71 omits `disable-model-invocation: true` skills from the native skill tool's advertised catalog, even though its exact-name resolver can technically still reach them. Narrow descriptions and the exact Harbor body markers keep each skill scoped; the orchestration-only `team-lead` has no skill tool, so skill discovery cannot replace its routing decision. Skills with `user-invocable: false` remain absent from direct slash completion.

Routing is declarative prompt policy, not an executable dispatcher: Copilot exposes the exact custom IDs to `task`, but the selected model ultimately emits the tool arguments. The team lead's final `actual task.agent_type` table makes a fallback visible instead of attributing built-in work to a custom agent.

## Trusted remote skills

```text
/agent-foundry:list-skills
/agent-foundry:list-skills zx
```

`/agent-foundry:list-skills` loads the plugin's internal `harbor-trusted-skill-sources` Markdown policy and uses its preapproved native shell tool only for the command's read-only `gh api --method GET` tree request. This restriction is declarative prompt policy, and the command validates the injected body marker plus every interpolated catalog value first. It lists paths without downloading skill bodies or executing repository content. The active example trusts only `skills/zx-example-author/SKILL.md` from `gvillarroel/zx-harness` at commit `181983bb58138ba3cc9aab25dd78b0557111d2bb`.

The policy supports three scopes: an entire pinned repository, every `SKILL.md` below one pinned subfolder, or one or more exact pinned `SKILL.md` paths. GitHub references used by `/agent-foundry:join` and `/agent-foundry:contract` must be covered by this policy.

## Disposable contractor

An equivalent pinned invocation works without starting a nested SDK client:

```text
/agent-foundry:contract {"name":"reviewer","description":"Read-only reviewer","prompt":"Review only; never edit.","tools":["read"],"skills":[{"kind":"github","repo":"gvillarroel/zx-harness","path":"skills/zx-example-author/SKILL.md","ref":"181983bb58138ba3cc9aab25dd78b0557111d2bb"}]} :: review src and return three findings
```

`/agent-foundry:contract` verifies the GitHub reference against the trusted catalog, loads only the referenced `SKILL.md`, injects its Markdown into one synchronous native `task` call, returns the result, and retains no agent ID or skill file. Copilot's native `explore` subagent provides a hard read-only boundary for the example above. Execute-only tasks use native `task`; tasks requesting edits use `general-purpose`. In those two modes the requested tool list is prompt policy, not a dynamic runtime allowlist.

Joined and bundled agents omit `model` unless explicitly configured, so they inherit Copilot's current selection. Leaving the session on `Auto` lets the account choose an available low-cost model instead of pinning an unavailable model ID.

## Declarative boundary

- Standalone JSON is used only for the required marketplace and plugin manifests. Personal registrations keep one validated active-profile JSON payload inside Markdown.
- Every behavior-bearing component is Markdown with YAML frontmatter.
- Bundled SDLC templates are inert Markdown under `bench/`, outside the registered plugin agent directory; `lineup` creates only managed `.agent.md` copies in the current folder.
- Recurring players use an inert prefixed personal `.agent.md` registration plus an eligible bare-ID project `.agent.md`; no executable registry or database is introduced.
- Trusted remote scope is declared in the internal `harbor-trusted-skill-sources` Markdown skill.
- Remote skills are instruction-only: sibling scripts and resources are neither fetched nor executed.
- Contractors use the current Copilot runtime's subagent orchestration. There is no `CopilotClient`, platform package lookup, TypeScript runtime, or experimental extension.
- One-shot `/agent-foundry:contract` definitions are unregistered and therefore map to built-in `explore`, `task`, or `general-purpose`. Active custom project profiles appear under their exact `task.agent_type`; use `/agent-foundry:join` when a durable routed player needs a hard custom `tools` allowlist.
