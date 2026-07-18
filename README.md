# Agent Harbor

Agent Harbor is a minimal GitHub Copilot CLI marketplace made only of Markdown with YAML frontmatter and JSON manifests. There is no application runtime, npm package, copied executable, SDK client, platform-specific package, or generated code in either plugin.

It contains:

- **agent-foundry**: personal bench and project-profile lifecycle, one-shot contractors, a parked SDLC team, a team lead, and a tracked GitHub-skill trust catalog.
- **repo-cartographer**: a repository-mapping agent and a dedicated `crafter` agent for zx or TypeScript command examples. `crafter` refreshes an external skill reference on every invocation without installing or copying that skill into the marketplace.

The six bundled skills are `harbor-agent-blueprints`, `harbor-bench-control`, `harbor-sdlc-bench`, `harbor-trusted-skill-sources`, `harbor-repository-map`, and the reference-only `harbor-zx-author-ref`. The last item contains source coordinates and bootstrap rules, never the upstream body.

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

Start a new `copilot` session after installing, updating, joining, or changing bench state. Use `/help` for plugin commands, Copilot's `/skills list` for installed skills, `/agent-foundry:list-skills` for trusted GitHub references, and `/agent` for selectable agents.

## Short team vocabulary

The lifecycle avoids employment metaphors:

| Command | Meaning |
| --- | --- |
| `/agent-foundry:join` | Add a recurring player to the user bench and activate it here. |
| `/agent-foundry:bench` | List the bench or turn project profiles on and off. |
| `/agent-foundry:retire` | Permanently remove one personal registration. |
| `/agent-foundry:contract` | Run one invocation-scoped specialist and forget it. |
| `/agent-foundry:agents` | List configured project and personal players. |
| `/agent-foundry:list-skills` | List trusted external skill references; distinct from `/skills`. |

`/agent-foundry:lineup [ids|all]` remains a compatibility alias for `bench on`, and `/agent-foundry:leave <id>` remains an alias for `bench off`. New examples use `bench` because its desired-state verbs are easier to read and safe to repeat.

## Personal bench and project profiles

Joining creates two Markdown profiles:

```text
/agent-foundry:join {"name":"reviewer","description":"Focused project reviewer","prompt":"Return only evidence-backed findings.","tools":["read","search"],"skills":[{"kind":"installed","name":"harbor-agent-blueprints"}]}
```

- `<copilot-home>/agents/af-bench--reviewer.agent.md` is the persistent user-level bench registration. It has `tools: []`, disables normal invocation, and stores the canonical active definition as inert data.
- `<cwd>/.github/agents/reviewer.agent.md` is the active current-folder copy. It has the requested tool allowlist and is eligible for delegation after restart.

The technical personal ID is deliberately prefixed because custom-agent precedence has changed across CLI releases. A user can still force that ID with `--agent`, so the empty tools plus mandatory bench guard are defense in depth, not a process sandbox.

From another project:

```text
/agent-foundry:bench list
/agent-foundry:bench on reviewer
```

The complete state interface is intentionally small:

```text
/agent-foundry:bench
/agent-foundry:bench list
/agent-foundry:bench on scout sage
/agent-foundry:bench off smith
/agent-foundry:bench on all
/agent-foundry:bench off all
```

Empty `bench` is the same as `bench list`. `on` and `off` are idempotent desired states; there is deliberately no `toggle`, so a retry cannot reverse an already-correct profile. `all` means only the six bundled SDLC players and never every personal registration. A multi-player operation preflights the complete selection and rolls back the batch if verification fails. Restart Copilot CLI from this folder after a successful state change.

Revision-1 registrations contained frozen skill bodies. They are now reported as `upgrade-required`; repeat the desired `join` definition with `"replace":true` to migrate to revision 2.

## External skills are references, not copies

A recurring player can refer to a GitHub skill without installing it:

```text
/agent-foundry:join {"name":"zx-maker","description":"Creates small zx and TypeScript command examples","prompt":"Make the smallest runnable example and validate it.","tools":["read","search","edit","execute"],"skills":[{"kind":"github","name":"zx-example-author","repo":"gvillarroel/zx-harness","path":"skills/zx-example-author/SKILL.md","track":"refs/heads/main"}]}
```

The personal registration and active project profile store only:

```json
{"kind":"github","name":"zx-example-author","repo":"gvillarroel/zx-harness","path":"skills/zx-example-author/SKILL.md","track":"refs/heads/main"}
```

They also store one narrowed trust grant and the bootstrap protocol. They never store the remote body, resolved commit, blob SHA, timestamp, URL, clone, or cache. `ref`, fixed SHAs, URLs, and inferred default branches are rejected. `execute` must be requested explicitly because the agent uses the developer's installed `gh`; the command never adds shell access silently.

On every invocation, before repository inspection or domain work, the agent must make these three read-only requests in order:

1. Resolve the configured tracking branch to a commit.
2. Resolve the exact `SKILL.md` path at that immutable commit to a bounded blob.
3. Fetch only that blob as raw Markdown.

The agent validates commit and blob SHAs, exact path, type, size up to 18,000 bytes, UTF-8, NUL absence, YAML frontmatter, and upstream skill name. It then uses the frontmatter-stripped body only for that invocation. The next invocation resolves the tracking branch again, so it sees the newest trusted branch state while keeping one internally consistent snapshot per run.

No sibling script, hook, package, binary, example, directory, or resource is fetched or executed. If the upstream Markdown depends on a sibling file, that portion of the skill is unavailable. A failure returns `external-skill-bootstrap: blocked` before domain work and never falls back to an old or installed copy.

This is logical per-agent isolation, not a secret store or filesystem ACL. Agent Harbor does not write the fetched body to a project, agent, skill directory, temporary file, plugin-data path, or cache, and the agent must not forward it to another agent or response. Copilot CLI may retain normal tool output in its own session history; a Markdown-only plugin cannot disable that product behavior.

Copilot CLI 1.0.71 also accepts but does not inject a custom agent's `skills:` frontmatter. Agent Harbor therefore does not depend on that field: reference, narrowed grant, and bootstrap live directly in the designated agent prompt, while the upstream body remains remote until that agent's first `gh` call.

## Trusted catalog

```text
/agent-foundry:list-skills
/agent-foundry:list-skills zx
```

The command resolves tracking refs and lists path-derived IDs, repo, path, current commit, and blob SHA without downloading any body. The policy supports:

- every `SKILL.md` in a tracked repository;
- every `SKILL.md` below one tracked subfolder;
- one or more exact `SKILL.md` paths.

The bundled active rule trusts only `skills/zx-example-author/SKILL.md` on `refs/heads/main` in `gvillarroel/zx-harness`. Tracking a branch intentionally trusts future commits to that branch; each invocation reports the immutable commit and blob it actually used.

## Dedicated zx/TypeScript crafter

Select or delegate to:

```powershell
copilot --agent repo-cartographer:crafter
```

The `crafter` profile itself contains only the external reference, narrowed trust rule, and validation protocol. Its first tool call must be the branch-resolution `gh api` request. It returns a `SmithChangeSet`-compatible handoff, so the team lead can place it in the SDLC build stage. `repo-cartographer:repo-cartographer` remains a separate maps-only agent and never receives the upstream zx instructions.

## Disposable contractor

The same reference works for a temporary specialist:

```text
/agent-foundry:contract {"name":"zx-drafter","description":"Drafts a minimal zx command","prompt":"Inspect only what the task requires and do not edit.","tools":["read","search","execute"],"skills":[{"kind":"github","name":"zx-example-author","repo":"gvillarroel/zx-harness","path":"skills/zx-example-author/SKILL.md","track":"refs/heads/main"}]} :: inspect the CLI entrypoint and propose one zx command
```

The parent validates only the reference and trust coverage. The native child makes the three `gh` calls and is instructed to return only its final result and provenance, never the body; that non-disclosure is prompt policy, not a deterministic output filter. No agent definition is registered. Because external refresh requires `execute`, this is prompt-restricted shell access, not a hard read-only sandbox. A contractor without an external reference can use Copilot's native `explore` profile for a hard read-only tool boundary.

This path uses native `task`; it never creates `CopilotClient`, launches another Copilot process, or resolves `@github/copilot-win32-x64`, so it avoids the platform-package error produced by the old SDK-client POC.

## Parked SDLC team

Six inert templates ship under `bench/`, outside the plugin's registered `agents/` directory. Activate only what this project needs:

```text
/agent-foundry:bench on scout sage smith probe guard
/agent-foundry:bench on all
/agent-foundry:bench off all
```

| ID | Stage | Output | Edit tool |
| --- | --- | --- | --- |
| `scout` | Discover | `ScoutBrief` | No |
| `sage` | Design | `SagePlan` | No |
| `smith` | Build | `SmithChangeSet` | Yes |
| `probe` | Verify | `ProbeReport` | No |
| `guard` | Review | `GuardGate` | No |
| `pilot` | Deliver | `PilotReleasePacket` | No |

The normal chain is `scout → sage → smith → probe → guard → pilot`. For zx or TypeScript command authoring, `repo-cartographer:crafter` replaces `smith` for that build unit and emits the same handoff. A failed gate permits at most one bounded build–verify–review correction loop.

`probe`, `guard`, and `pilot` have `execute` for tests or diagnostics but are prompt-restricted against commands expected to rewrite source. `pilot` never publishes. `bench on` writes only managed `.github/agents/*.agent.md` files, while `bench off` removes only ownership-validated managed copies. Both preflight the whole selection, refuse conflicts, verify every change, and attempt rollback on failure.

## Team lead

```powershell
copilot --agent agent-foundry:team-lead
```

`team-lead` is orchestration-only: it has `task`, `list_agents`, `read_agent`, and `write_agent`, but cannot inspect, edit, execute, browse, or load domain skills itself. Its mandatory routes are:

- zx or TypeScript command authoring → `repo-cartographer:crafter`;
- repository maps → `repo-cartographer:repo-cartographer`;
- agent, roster, lifecycle, or trust design → `agent-foundry:agent-architect`;
- active SDLC stages → their exact bare IDs;
- otherwise the least-privileged compatible built-in.

Parameterized slash commands remain explicit user actions because Copilot's skill tool cannot populate `$ARGUMENTS`; the lead returns ready-to-run commands instead of claiming it executed them. It inherits the session model, so leaving Copilot on `Auto` avoids pinning an unavailable or unnecessarily expensive model.

## Declarative boundary

- Plugin behavior is Markdown with YAML frontmatter; JSON is limited to manifests and inert payloads inside Markdown.
- The plugin directories contain only `.md` and `.json` files.
- There are no hooks, executables, scripts, packages, dependencies, MCP servers, copied upstream files, or SDK clients.
- Installed and local Markdown skills may be stored in a generated self-contained player. External GitHub bodies never are; only references and narrowed grants are stored.
- Runtime capabilities come from Copilot's native agents, tools, skills, and task delegation.

Marketplace-owned skill markers are collision-resistant compatibility checks, not cryptographic provenance. Copilot's normal skill precedence can let a same-named project or personal skill shadow a plugin skill; a copied marker could therefore spoof the trust catalog seen by `join`, `contract`, or `list-skills`. The active agents persist only narrowed grants, and every external body is still constrained to the exact stored repo, branch, path, size, frontmatter name, and fresh immutable blob, but this Markdown-only POC cannot prove which local skill file supplied the catalog. Inspect `/skills list` and remove same-name overrides when that distinction matters.

See GitHub's official [Copilot CLI plugin reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-plugin-reference), [Copilot CLI command reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference), and [custom agent configuration](https://docs.github.com/en/copilot/reference/custom-agents-configuration).
