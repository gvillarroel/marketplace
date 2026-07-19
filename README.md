# Agent Harbor

Agent Harbor is one shared agent roster and orchestration layer for GitHub Copilot CLI, OpenCode, and Pi. The lifecycle implementation lives in local JavaScript, not in command-shaped skills or Markdown prompts, so routine roster operations do not spend model tokens.

The repository contains two plugins:

- `agent-foundry`: six parked SDLC players, six direct commands, an exact-active-roster manager, a `scouts` agent for designing agents from a trusted catalog, and cross-runtime adapters.
- `repo-cartographer`: repository orientation plus a `crafter` agent for minimal zx and TypeScript command examples.

## Model usage

“Zero model calls” means zero requests to an AI provider. These commands can still perform bounded filesystem or network I/O.

| Command or path | Model calls | Other I/O |
| --- | ---: | --- |
| `/bench list`, `on`, `off`, or `dynamic` | 0 | Local filesystem |
| `/list-skills` | 0 | Two read-only `gh api` calls per repository/ref snapshot |
| `/join` | 0 | Local filesystem |
| `/retire` | 0 | Local filesystem |
| Invalid `/contract` or failed local preflight | 0 | Validation and permitted local reads |
| Valid `/contract` | 1 | One disposable child agent; no retained profile |
| Invalid `/manager`, or no eligible active roster | 0 | Local roster/settings preflight |
| Valid `/manager` | Variable | Manager model work plus only the delegates it actually invokes; each optional dynamic contract adds one disposable child |

The four deterministic controls are `/bench`, `/list-skills`, `/join`, and `/retire`. They are native command handlers backed by the shared core; they are not public skills and are never converted into model prompts. `scouts`, the manager, activated players, and the `repo-cartographer` agents do use a model when they perform agent work.

## Architecture

[`plugins/agent-foundry/runtime/commands.mjs`](plugins/agent-foundry/runtime/commands.mjs) is the canonical command core. It owns parsing, validation, ownership checks, transactions, profile rendering, project settings, exact-roster discovery, trusted-source resolution, catalog gating, and model-runner preflight.

Each host contributes only a thin native adapter:

- GitHub Copilot CLI registers extension commands and tools with its extension API.
- OpenCode 1.18.3+ registers agents and tools in its server plugin, direct slash handlers in its TUI plugin, and exposes `agent-harbor` as a CLI fallback.
- Pi registers commands and tools in a package extension and emits native prompt templates for named players.

`runtime/opencode/` and `runtime/pi/` are generated package trees copied from the canonical plugin sources. Do not edit generated runtime files manually: make changes under `plugins/agent-foundry/` or the installer generators, then run:

```shell
npm run build:runtimes
```

This keeps validation, security decisions, and command behavior in one implementation while preserving the native user experience of each host.

## Install

All three hosts expose the same six commands after installation:

```text
/bench
/list-skills
/join
/retire
/contract
/manager
```

Restart or reload the host after installation or an update, then invoke the same command names. Host-specific installation and agent selection are described below.

<details>
<summary><strong>GitHub Copilot CLI</strong></summary>

```shell
copilot plugin marketplace add gvillarroel/marketplace
copilot plugin install agent-foundry@agent-harbor
copilot plugin install repo-cartographer@agent-harbor
```

Copilot extensions are currently experimental. Agent Harbor's three guarded
extension tools deliberately request permission to bypass a second generic host
prompt when they run. Approve that extension-scoped request in the TUI, or grant
only the installed extension identity at startup:

```shell
copilot --experimental --allow-tool='extension-permission-access(plugin:agent-foundry:agent-foundry)'
```

This startup grant does not invoke a model and is narrower than `--allow-all`.
The zero-token slash commands still execute locally. The same identity grant
normally works when testing the source checkout with `--plugin-dir`:

```shell
copilot --experimental --allow-tool='extension-permission-access(plugin:agent-foundry:agent-foundry)' --plugin-dir ./plugins/agent-foundry
```

If that checkout collides with an already installed copy, Copilot 1.0.71 may
label the extra development extension `unknown`. In that development-only case,
approve the displayed prompt or replace the identity in the grant with
`unknown`; do not use that fallback for the installed plugin.

Update with:

```shell
copilot plugin marketplace update agent-harbor
copilot plugin update agent-foundry
copilot plugin update repo-cartographer
```

Start a new session after installing, updating, or changing project agents. Use Copilot's native agent selector for a named active player or `scouts`; use `/manager <objective>` for managed orchestration.

</details>

<details>
<summary><strong>OpenCode 1.18.3+</strong></summary>

Install both repository plugins from the GitHub archive:

```shell
opencode plugin https://github.com/gvillarroel/marketplace/archive/refs/heads/main.tar.gz --global
```

For a project-only installation, omit `--global`. For local development:

```shell
opencode plugin file:. --global
```

The server entrypoint registers agents and guarded tools; the TUI entrypoint registers the six local slash handlers. The TUI opens a small argument dialog for commands that need input instead of turning their arguments into a model prompt.

The universal CLI fallback accepts inline arguments:

```shell
agent-harbor --runtime opencode bench on scout sage
agent-harbor --runtime opencode bench dynamic status
agent-harbor --runtime opencode bench list
```

`manager` is intentionally native-session only because its frozen delegates are
host tools, not subprocess arguments. Invoke `/manager` inside Copilot,
OpenCode, or Pi; the fallback help lists only the five operations it can run.

From this checkout, the equivalent is:

```shell
node runtime/opencode/cli.mjs --runtime opencode bench list
```

The TUI deletes disposable contractor and manager sessions after returning their results. The CLI fallback uses normal OpenCode runs, so OpenCode may retain its usual run history, but Agent Harbor does not save a contractor profile. Re-run installation with `--force`, then start a new OpenCode session, to update.

</details>

<details>
<summary><strong>Pi</strong></summary>

```shell
pi install git:github.com/gvillarroel/marketplace
```

For a project-only installation:

```shell
pi install --local git:github.com/gvillarroel/marketplace
```

For local development before publication:

```shell
pi install .
```

The root package declares a Pi extension for all six commands and guarded tools, plus prompt templates for named roles. Activated players live in `.pi/prompts` and use the current session model. The manager delegates through isolated child runs with each player's tool allowlist. Run `/reload` or start a new session after updating.

`pi list` confirms that a source is registered. The installed checkout must contain `package.json`, `runtime/pi/extensions/`, and `runtime/pi/agents/`.

</details>

## Commands

### Bench and project settings

```text
/bench
/bench list
/bench on scout sage
/bench off smith
/bench on all
/bench off all
/bench dynamic status
/bench dynamic on
/bench dynamic off
```

In OpenCode, invoke `/bench` and enter `list`, `on scout sage`, `dynamic on`, or another argument string in the dialog. The CLI form accepts the same argument text.

`on` and `off` are idempotent. `all` means only the six bundled SDLC profiles:

`scout → sage → smith → probe → guard → pilot`

Their stages are discovery, design, build, verification, review, and delivery. Profiles remain parked under the plugin's `bench/` directory until the project activates them. Batch writes are preflighted, verified, and rolled back on failure.

Project state is stored in `.agent-harbor/bench.json`. Dynamic agents are off by default. `dynamic status`, `dynamic on`, and `dynamic off` only update or read local state and make no model request.

### Manager

```text
/manager Ship the requested change and prove it with the relevant tests.
```

On the first manager invocation in an untouched project, Agent Harbor activates the six bundled SDLC players once and marks the roster initialized. This supplies the default software-development lifecycle without requiring setup commands. An explicit `/bench on ...`, `/bench off ...`, or `/join ...` initializes the roster instead and therefore preserves the user's chosen lineup; the manager will not silently reactivate profiles after they have been explicitly benched.

The manager is an orchestration role. It receives a frozen roster containing only exact, currently active Agent Harbor profiles and delegates substantive work to those players. A bundled profile must byte-match its current generated source; a personal player must byte-match its user registration. Stale, edited, unowned, conflicting, parked, and retired files never become manager delegates. If an initialized project has no eligible active player, manager preflight stops before any model call.

By default, the manager cannot invent or persist new agents. With `/bench dynamic on`, it may list the trusted catalog and create disposable contracts when the active roster cannot cover a necessary role. A dynamic skill is accepted only when it is the exact commit/blob/size entry returned by that manager's latest `/list-skills` operation. Installed skills, local skills, arbitrary repositories, and unlisted GitHub references are rejected by code, not merely discouraged by a prompt. Dynamic contracts do not join the roster.

### Personal players

```text
/join {"name":"reviewer","description":"Read-only reviewer","prompt":"Return three evidence-backed findings.","tools":["read","search"],"skills":[]}
```

The canonical registration is stored at the runtime's user-level Agent Harbor bench:

```text
<runtime-home>/agent-foundry/bench/<player>.<runtime-extension>
```

An identical active copy is written to the current project:

- Copilot: `.github/agents/<player>.agent.md`
- OpenCode: `.opencode/agents/<player>.md`
- Pi: `.pi/prompts/<player>.md` (invoke it as `/<player> <task>`)

`bench off <player>` removes only the current project copy. `retire <player>` removes the user registration and its owned current-project copy; other projects are intentionally untouched.

Installed and local skill bodies can be embedded into a manually joined profile. A GitHub skill must match the trusted policy:

```text
/join {"name":"zx-maker","description":"Minimal zx author","prompt":"Create the smallest runnable example.","tools":["read","search","edit","execute"],"skills":[{"kind":"github","name":"zx-example-author","repo":"gvillarroel/zx-harness","path":"skills/zx-example-author/SKILL.md","track":"refs/heads/main"}]}
```

Remote bodies are not fetched during `join`. The active player resolves or verifies the canonical snapshot at invocation time and applies its validated body only in memory.

### Disposable players

```text
/contract {"name":"reviewer","description":"Read-only reviewer","prompt":"Review only; never edit.","tools":["read","search"],"skills":[],"task":"Review src and return three findings."}
```

Parsing, validation, skill resolution, and prompt composition are local. Only a valid request starts one child model call. The child is disposable and no contractor profile is retained. Requested tools are a hard allowlist where the host supports one and otherwise remain explicit child policy.

### Trusted skills

```text
/list-skills
/list-skills zx
```

The command reads `plugins/agent-foundry/runtime/trusted-sources.json`, resolves each configured branch once, reads each immutable Git tree once, applies the local allowlist, and displays:

```text
skill-id | repository | path | tracking ref | commit | blob | trusted by
```

It is display-only: it never downloads a skill body, clones a repository, installs content, writes project files, or calls a model. The developer's authenticated `gh` CLI must be on `PATH`.

Every rule has one of three scopes. The following are independent examples; choose the narrowest appropriate form. Overlapping rules for the same repository and tracking ref are rejected as ambiguous.

Trust every `SKILL.md` in one repository:

```json
{
  "trustedSources": [
    {
      "repo": "acme/engineering-skills",
      "track": "refs/heads/main",
      "scope": { "kind": "repo" }
    }
  ]
}
```

Trust every `SKILL.md` below one folder:

```json
{
  "trustedSources": [
    {
      "repo": "acme/engineering-skills",
      "track": "refs/heads/main",
      "scope": { "kind": "folder", "path": "skills/review" }
    }
  ]
}
```

Trust only exact skill paths:

```json
{
  "trustedSources": [
    {
      "repo": "acme/engineering-skills",
      "track": "refs/heads/main",
      "scope": {
        "kind": "skills",
        "paths": [
          "skills/security-review/SKILL.md",
          "skills/release-notes/SKILL.md"
        ]
      }
    }
  ]
}
```

### Scouts

`scouts` helps design a focused personal or disposable player. It starts from the objective and completion evidence, calls the zero-model `/list-skills` implementation to discover eligible skills, chooses the smallest tool allowlist, and produces a self-contained prompt.

When evidence would materially improve a choice, `scouts` may contract temporary candidates on the same bounded task and compare their results. It calls guarded `/join` only when the user explicitly asks to register the winner. Its controller rejects installed/local skills and any GitHub skill absent from its latest catalog snapshot, so recommendation and activation share the same trusted-source boundary.

Use the host's native agent selector for `scouts` in Copilot or OpenCode. In Pi, invoke its prompt template as `/scouts <objective>` after `/reload`.

## Agents

The default SDLC roster is:

- `scout`: discover the repository, constraints, and unknowns.
- `sage`: turn evidence into a minimal implementation design.
- `smith`: implement the scoped change.
- `probe`: run focused and regression verification.
- `guard`: review correctness, security, and maintainability.
- `pilot`: prepare delivery evidence and handoff.

Additional specialists are:

- `agent-foundry:scouts`: designs least-privileged agents from the trusted catalog, with optional disposable comparisons.
- `repo-cartographer:repo-cartographer`: builds compact evidence-based repository maps.
- `repo-cartographer:crafter`: refreshes the trusted zx skill reference per invocation and creates a minimal self-contained zx or TypeScript command example.

Use Copilot or OpenCode's native agent selector for direct work. In Pi, activated players are native prompt templates: invoke `/<player> <task>` after `/reload`. Use `/manager <objective>` when the active players should collaborate as one managed roster.

## Tests

Run the local behavioral and cross-runtime compatibility suites:

```shell
npm test
```

Or run them separately:

```shell
node --test tests/*.test.mjs
python -m unittest discover -s tests -v
```

The Harbor conformance job uses a `nop` agent and treats the verifier as the source of truth, so the evaluation itself needs no model credentials or model tokens. Run the repository-pinned Harbor 0.20.0 interface with:

```shell
uvx --from harbor==0.20.0 harbor exec --config evals/harbor/conformance.yaml
```

This command requires a running Docker engine because the conformance environment builds and executes in a container. The container pins the supported Copilot, OpenCode, and Pi CLIs and sets `AGENT_HARBOR_REQUIRE_CLIS=1`, turning missing-host discovery into a failure instead of a skip.

The suites exercise real roster operations in temporary homes and projects, verify deterministic zero-model paths, check contract and manager preflight boundaries, cover exact-active-only orchestration and catalog gating, regenerate both runtime packages, and run credential-free host discovery checks. The README does not substitute for running either the local suite or the Harbor job.

An opt-in PTY probe also starts Copilot with an isolated home, grants the exact
plugin identity, waits for all tools and commands to register, executes
`/bench list`, and exits without submitting a model message:

```shell
AGENT_HARBOR_LIVE_COPILOT_EXTENSION=1 python -m unittest tests.test_compatibility.CompatibilityTests.test_copilot_cli_loads_extension_without_a_model_turn -v
```

On Windows, run that probe in an isolated environment with `pywinpty`, for
example by prefixing the Python command with `uv run --with pywinpty`.
