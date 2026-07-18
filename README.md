# Agent Harbor

Agent Harbor is a small GitHub Copilot CLI marketplace made only of Markdown with YAML frontmatter and JSON manifests. It ships no runtime, package, executable, or copied external skill.

It contains two plugins:

- `agent-foundry`: five slash controls, a user-level bench, six parked SDLC profiles, a team lead, and a trusted GitHub-skill catalog.
- `repo-cartographer`: repository orientation plus a `crafter` agent for minimal zx and TypeScript command examples.

## Install

```shell
copilot plugin marketplace add gvillarroel/marketplace
copilot plugin install agent-foundry@agent-harbor
copilot plugin install repo-cartographer@agent-harbor
```

Update an existing installation:

```shell
copilot plugin marketplace update agent-harbor
copilot plugin update agent-foundry
copilot plugin update repo-cartographer
```

Start a new Copilot CLI session after installing, updating, or changing project agents.

The same plugin files are designed to run unchanged on macOS, Linux, and Windows. Agent profiles use Copilot's portable `execute` alias, while skill actions request Copilot's portable shell permission. User-level storage resolves from an absolute `COPILOT_HOME` or the current user's home directory. Nothing assumes a shell family, path separator, platform package, or system-specific executable. The only external command used by a plugin is the cross-platform `gh` CLI expected on `PATH`.

## Commands

| Command | Purpose |
| --- | --- |
| `/bench` | List players or set their current-folder state with `on` and `off`. |
| `/join` | Register a recurring player at user level and activate it here. |
| `/retire` | Remove one personal registration and its managed local copy. |
| `/contract` | Run one synchronous, invocation-scoped subagent without registration. |
| `/list-skills` | List trusted GitHub skill references; distinct from built-in `/skills`. |

These controls are native user-invocable skills, so they work as bare slash names in Copilot CLI. `agents`, `lineup`, and `leave` are intentionally absent: Copilot provides native `/agent` selection, while `lineup` and `leave` duplicated `bench`.

Copilot CLI 1.0.71 does not expand an explicit slash skill when `disable-model-invocation: true`, contrary to the documented combination. The five controls therefore remain model-visible in this POC, label themselves user-invoked, and reject any mutating input outside their exact syntax and ownership preflight. Recheck this workaround after a CLI update.

## Bench

```text
/bench
/bench on scout sage
/bench off smith
/bench on all
/bench off all
```

`on` and `off` are idempotent. There is no `toggle`. `all` means only the six bundled profiles:

`scout → sage → smith → probe → guard → pilot`

They remain parked under the plugin's `bench/` directory until copied to the current `.github/agents/` directory. A batch is fully preflighted and rolled back on failure.

## Personal players

```text
/join {"name":"reviewer","description":"Read-only reviewer","prompt":"Return three evidence-backed findings.","tools":["read","search"],"skills":[]}
```

The canonical profile is stored at:

```text
<copilot-home>/agent-foundry/bench/reviewer.agent.md
```

That folder is user-level but is not a Copilot agent discovery directory. The identical active copy is written to:

```text
<current-folder>/.github/agents/reviewer.agent.md
```

Here `current-folder` is the Copilot process working directory, resolved independently of `COPILOT_HOME`.

Consequently the player is active where it joined and remains available from every other project through `bench on reviewer`. `bench off reviewer` removes only the active project copy. `retire reviewer` removes the user registration and the managed copy in the current project; copies in other projects remain intentionally untouched.

Profiles created by `agent-foundry 0.8` are reported as `migration-required`. Repeat their original `join` definition with `"replace":true`; the command verifies ownership, writes the revision-3 registration and active copy, then removes the old inert registration with rollback protection. Legacy `bench off` and `retire` remain supported during migration.

Installed and local skill bodies can be injected into a joined profile. GitHub skills remain canonical references:

```text
/join {"name":"zx-maker","description":"Minimal zx author","prompt":"Create the smallest runnable example.","tools":["read","search","edit","execute"],"skills":[{"kind":"github","name":"zx-example-author","repo":"gvillarroel/zx-harness","path":"skills/zx-example-author/SKILL.md","track":"refs/heads/main"}]}
```

Before each active-agent invocation, the generated profile resolves the moving branch again with authenticated `gh api`, fetches the immutable `SKILL.md` for that commit into the agent's context, validates its frontmatter, and uses only its self-contained guidance. It does not install, cache, clone, persist, or fetch sibling resources.

## Disposable players

```text
/contract {"name":"reviewer","description":"Read-only reviewer","prompt":"Review only; never edit.","tools":["read","search"],"skills":[],"task":"Review src and return three findings."}
```

`contract` uses Copilot's native `task` tool and never creates a `CopilotClient` or resolves a platform package. The requested tool subset is prompt policy for built-in child profiles, not a hard sandbox; use `join` when a persistent custom-agent tool allowlist is required.

## Trusted skills

`harbor-trusted-skill-sources` supports three allowlist scopes:

- a complete repository;
- one repository folder;
- one or more exact `SKILL.md` paths.

The included policy trusts `gvillarroel/zx-harness/skills/zx-example-author/SKILL.md` on `refs/heads/main`. List current covered snapshots without downloading bodies:

```text
/list-skills
/list-skills zx
```

The command uses the developer's authenticated `gh` CLI and reports repository, path, tracking ref, resolved commit, and blob SHA.

## Agents

- `agent-foundry:team-lead`: delegates to the smallest matching active specialist. Full SDLC simulation is opt-in rather than mandatory.
- `repo-cartographer:repo-cartographer`: builds compact evidence-based repository maps.
- `repo-cartographer:crafter`: refreshes the trusted external zx skill on every invocation, then creates a minimal self-contained zx or TypeScript command example.

The marketplace relies on Copilot's native Markdown agents, user-invocable skills, and subagent tools. Its policies reduce accidental scope but cannot turn model instructions into an operating-system sandbox.
