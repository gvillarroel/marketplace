# Agent Harbor

Agent Harbor is a Markdown-first agent bundle for GitHub Copilot CLI, OpenCode, and Pi. Copilot consumes the original plugin manifests directly; the generated OpenCode and Pi packages adapt the same canonical agents, commands, and skills to each runtime's native installation model.

It contains two plugins:

- `agent-foundry`: five slash controls, a user-level bench, six parked SDLC profiles, a team lead, and a trusted GitHub-skill catalog.
- `repo-cartographer`: repository orientation plus a `crafter` agent for minimal zx and TypeScript command examples.

## Install

<details>
<summary><strong>GitHub Copilot CLI</strong></summary>

### Install

```shell
copilot plugin marketplace add gvillarroel/marketplace
copilot plugin install agent-foundry@agent-harbor
copilot plugin install repo-cartographer@agent-harbor
```

### Update

```shell
copilot plugin marketplace update agent-harbor
copilot plugin update agent-foundry
copilot plugin update repo-cartographer
```

### Use

Start a new Copilot CLI session, then invoke `/bench`, `/join`, `/retire`, `/contract`, or `/list-skills`. Use Copilot's native `/agent` selector for `team-lead`, `repo-cartographer`, `crafter`, or players activated through `/bench`.

Start a new session after installing, updating, or changing project agents.

</details>

<details>
<summary><strong>OpenCode</strong></summary>

### Install

Install the package containing both repository plugins directly from this repository's GitHub tarball:

```shell
opencode plugin https://github.com/gvillarroel/marketplace/archive/refs/heads/main.tar.gz --global
```

For a project-only installation, omit `--global`:

```shell
opencode plugin https://github.com/gvillarroel/marketplace/archive/refs/heads/main.tar.gz
```

For local development from this checkout, use `opencode plugin file:. --global`.

### Update

Re-run the installation command with `--force`, then start a new OpenCode session.

### Use

Invoke `/bench`, `/join`, `/retire`, `/contract`, or `/list-skills`. Select `team-lead`, `repo-cartographer`, `crafter`, or an activated player through OpenCode's native agent interface.

OpenCode does not accept Pi's `git:github.com/…` shorthand, but its current package installer accepts the repository archive URL. The equivalent npm-ready command is `opencode plugin @gvillarroel/agent-harbor --global` once that package is published. The package registers commands and agents from both `agent-foundry` and `repo-cartographer` through OpenCode's plugin configuration hook.

OpenCode exposes the same five slash controls and named subagents through its native plugin, [command](https://opencode.ai/docs/commands), and [agent](https://opencode.ai/docs/agents) configuration. Player activation targets `.opencode/agents/` in the current project; user registrations use the standard OpenCode configuration directory.

</details>

<details>
<summary><strong>Pi</strong></summary>

### Install

Install both repository plugins directly from GitHub through Pi's package manager:

```shell
pi install git:github.com/gvillarroel/marketplace
```

For a project-only installation:

```shell
pi install --local git:github.com/gvillarroel/marketplace
```

### Update

Run `pi update --extensions`, followed by `/reload` or a new Pi session.

### Use

Invoke `/bench`, `/join`, `/retire`, `/contract`, or `/list-skills`. The named profiles are Pi prompt templates, so invoke `/team-lead`, `/repo-cartographer`, or `/crafter` directly.

The root `package.json` declares the Pi-native command and agent prompts generated from both plugins. Each command embeds only the internal contracts it needs. Because Pi intentionally has no built-in subagent tool, `/contract` and delegated agent work use one synchronous, ephemeral `pi --no-session -p` child with a mapped `--tools` allowlist. Active player profiles still live in the current project's `.pi/agents/`.

</details>

The canonical Copilot plugin files remain unchanged and are designed to run on macOS, Linux, and Windows. Agent profiles use Copilot's portable `execute` alias, while the OpenCode installer translates it to native `bash` permission. User-level storage resolves from the runtime-specific absolute config directory or the current user's home directory. Nothing assumes a shell family, path separator, platform package, or system-specific executable. The only external command used by a plugin is the cross-platform `gh` CLI expected on `PATH`.

## Tests

Run the complete, credential-free compatibility suite with Python's standard library:

```shell
python -m unittest discover -s tests -v
```

The single test module validates canonical Copilot manifests, regenerates the compact OpenCode and Pi packages, evaluates all five command contracts across the three runtimes, verifies bundled-profile ownership, idempotency, and overwrite protection, confirms Copilot/OpenCode discovery, and installs the Pi package into a temporary Pi home when those executables are available. Missing CLIs skip only their runtime assertion; no model call, API key, Docker service, third-party package download, or network access is required.

## Commands

| Command | Purpose |
| --- | --- |
| `/bench` | List players or set their current-folder state with `on` and `off`. |
| `/join` | Register a recurring player at user level and activate it here. |
| `/retire` | Remove one personal registration and its managed local copy. |
| `/contract` | Run one synchronous, invocation-scoped subagent without registration. |
| `/list-skills` | List trusted GitHub skill references; distinct from built-in `/skills`. |

These controls are native user-invocable skills, so they work as bare slash names in an interactive Copilot CLI session. In CLI 1.0.71, non-interactive `-p` treats slash text as an ordinary prompt; automation must explicitly ask Copilot to invoke the named plugin skill. `agents`, `lineup`, and `leave` are intentionally absent: Copilot provides native `/agent` selection, while `lineup` and `leave` duplicated `bench`.

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
