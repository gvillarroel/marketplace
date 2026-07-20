# Agent Harbor

Agent Harbor is a TypeScript library with native adapters for GitHub Copilot CLI, OpenCode, and Pi. Copilot consumes plugin manifests directly; OpenCode loads a compiled plugin and Pi loads a compiled extension. All three share the same executable command contracts.

The normative product, safety, lifecycle, and cross-runtime acceptance
requirements are consolidated in [REQUIREMENTS.md](REQUIREMENTS.md).

It contains two plugins:

- `agent-foundry`: five slash controls, a user-level bench, six canonical SDLC definitions rendered on activation, a team lead, and a trusted GitHub-skill catalog.
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

The `agent-foundry` plugin also contributes the `agent-harbor` MCP server with two bounded tools: `control` for deterministic lifecycle preflight and `skill` for allowlisted remote-skill materialization. The latter performs snapshot validation in code before returning invocation-local guidance.
`repo-cartographer:crafter` therefore requires `agent-foundry` to remain enabled, as in the installation sequence above.

Start a new session after installing, updating, or changing project agents.
The MCP process inherits the folder from which the Copilot session starts; start
a new session from the target folder after changing projects.

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

Install a published revision that contains the root `package.json` and compiled Pi extension:

```shell
pi install git:github.com/gvillarroel/marketplace
```

For a project-only installation:

```shell
pi install --local git:github.com/gvillarroel/marketplace
```

The GitHub revision must already include `package.json` and `dist/adapters/pi.js`. `pi list` only confirms that Pi registered a source; it does not prove that the checked-out revision contains the compiled extension. Run `npm run build` before publishing a revision.

### Local development before publication

Use the current checkout directly until its changes have been pushed to the GitHub revision being installed:

```shell
cd path/to/marketplace
pi install .
```

For a project-only local installation:

```shell
cd path/to/marketplace
pi install --local .
```

Remove an older GitHub-only registration first if you do not want both sources loaded:

```shell
pi remove git:github.com/gvillarroel/marketplace
```

### Update

After publishing a new Git revision, install that revision again (or run `pi install git:github.com/gvillarroel/marketplace@<tag-or-commit>`), followed by `/reload` or a new Pi session. `pi update --extensions` reconciles an existing pinned revision; it does not move it to a newer commit.

### Use

Invoke `/bench`, `/join`, `/retire`, `/contract`, or `/list-skills`. Invoke `/team-lead <task>`, `/repo-cartographer <task>`, `/crafter <task>`, or any active personal player directly.

The root `package.json` declares only the compiled Pi extension. Through `ExtensionAPI`, it registers the five lifecycle commands, the three fixed roles, and every ownership-verified active player. Role/player commands create a real in-memory `createAgentSession` child with a native tool allowlist; they are not static prompt templates. Active definitions live privately in the current project's `.pi/agents/`, and mutations register newly active names immediately (a reload removes names that were deactivated during the current session).

</details>

All three native distributions are designed to run on macOS, Linux, and Windows. Agent profiles use portable abstract tools while the adapters translate them to each SDK's native allowlist. User-level storage resolves from the runtime-specific absolute config directory or the current user's home directory. Nothing assumes a shell family, path separator, platform package, or system-specific executable. The only external command used by the lifecycle core is the cross-platform `gh` CLI expected on `PATH`.

## Shared library and native adapters

`src/core` is the shared TypeScript library. It owns validation, roster
lifecycle, transactional writes, GitHub snapshot resolution, and the five
command contracts. Harness modules contain only native translation and SDK
integration:

- Copilot consumes `plugins/` through its marketplace/plugin system; lifecycle
  skills and the plugin-provided MCP server invoke the compiled `src/core`
  runtime shipped inside the plugin;
- `src/adapters/opencode.ts` exposes commands and the deterministic `harbor`
  tool through `@opencode-ai/plugin`;
- `src/adapters/pi.ts` registers native commands through Pi `ExtensionAPI`;
- `src/orchestrators/` uses the Copilot, OpenCode, and Pi SDKs for disposable
  child sessions.

Build every native distribution with:

```shell
npm run build
```

The npm package exposes the compiled OpenCode plugin as its main entrypoint,
the Pi extension in its `pi` manifest, and `agent-harbor` as the programmatic
Copilot SDK CLI. Copilot plugin users execute the packaged MCP runtime directly
through the host. Users still install through each harness's native mechanism.

## Tests

Run a clean TypeScript build, the contract/security suite, and native discovery tests:

```shell
npm test
```

`npm test` first removes and rebuilds every generated artifact, then runs one Node/TypeScript suite. It evaluates all five command contracts across the three runtimes; verifies byte-exact rollback, mutation locking, canonical ownership, idempotency, collisions and leaf/ancestor symlinks; checks remote-body validation, disposable-session cleanup and tool mappings; confirms Copilot/OpenCode discovery; and installs Pi into a temporary home. The native CLI checks run concurrently in isolated directories. Missing CLIs skip only their runtime assertion; no Python runtime, model call, API key, Docker service, or network access is required.

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

Their canonical definitions live once in `src/core/defaults.ts` and are rendered directly into the current harness's native agent directory when activated. A batch is serialized, fully preflighted, written file-atomically, verified, and rolled back byte-for-byte on failure.

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

The TypeScript implementation preserves canonical revision 3, so adopting it
does not force a schema migration. Revisions 1 and 2 are not implicitly
migrated; re-register their original definition explicitly. Agent Harbor never
uses an unverifiable legacy marker as permission to overwrite or delete.

Version 0.11 accepts up to three validated GitHub skill references. Installed
and local skill embedding is deliberately excluded to keep one portable,
verifiable acquisition path:

```text
/join {"name":"zx-maker","description":"Minimal zx author","prompt":"Create the smallest runnable example.","tools":["read","search","edit","execute"],"skills":[{"kind":"github","name":"zx-example-author","repo":"gvillarroel/zx-harness","path":"skills/zx-example-author/SKILL.md","track":"refs/heads/main"}]}
```

Before each active-agent invocation, the profile calls the harness-native Agent Harbor loader. Copilot supplies `agent-harbor/skill` through its plugin-provided MCP server, OpenCode supplies `agent_harbor_skill` through its plugin API, and Pi materializes guidance before creating the child session. The shared loader makes exactly two authenticated read-only `gh api` calls, bounds each call to 20 seconds and propagates host cancellation, pins the moving branch to one commit, fetches only the immutable path, validates UTF-8 size/frontmatter/name, strips frontmatter, and returns the body only to that invocation. It never installs, caches, clones, persists, executes, or fetches sibling resources.

## Disposable players

```text
/contract {"name":"reviewer","description":"Read-only reviewer","prompt":"Review only; never edit.","tools":["read","search"],"skills":[],"task":"Review src and return three findings."}
```

Interactive Copilot `/contract` passes the literal JSON through the structured `control` tool of the plugin-provided `agent-harbor` MCP server—never through shell interpolation—then calls Copilot's native `task` exactly once with the validated payload; it never creates a second `CopilotClient`. The programmatic `agent-harbor copilot contract` entrypoint uses `@github/copilot-sdk` and explicitly deletes its session. OpenCode and Pi also create and dispose one SDK child. SDK-backed paths enforce native tool maps; Copilot's built-in `task` profiles can only represent the requested subset as child policy, not an operating-system sandbox.

## Trusted skills

Version 0.11 deliberately uses one explicit exact-reference allowlist in `src/core/defaults.ts`; it does not add repository-wide, folder-wide, installed, or local skill scopes. The included policy trusts `gvillarroel/zx-harness/skills/zx-example-author/SKILL.md` on `refs/heads/main`. List its current snapshot without downloading the body:

```text
/list-skills
/list-skills zx
```

The command uses the developer's authenticated `gh` CLI and reports repository, path, tracking ref, resolved commit, and blob SHA.

## Agents

- `agent-foundry:team-lead`: derives one least-privilege contractor and performs one bounded delegation through the closest native mechanism.
- `repo-cartographer:repo-cartographer`: builds compact evidence-based repository maps.
- `repo-cartographer:crafter`: refreshes the trusted external zx skill on every invocation, then creates a minimal self-contained zx or TypeScript command example.

The marketplace relies on Copilot's native Markdown agents, user-invocable skills, and subagent tools. Its policies reduce accidental scope but cannot turn model instructions into an operating-system sandbox.
