# Agent Harbor

Agent Harbor is a TypeScript library with native adapters for GitHub Copilot CLI, OpenCode, and Pi. Copilot consumes plugin manifests directly; OpenCode loads a compiled plugin and Pi loads a compiled extension. All three share the same executable command contracts.

The normative product, safety, lifecycle, and cross-runtime acceptance
requirements are consolidated in [REQUIREMENTS.md](REQUIREMENTS.md).

The current technical and operational design is documented in
[ARCHITECTURE.md](ARCHITECTURE.md).

It contains two plugins:

- `agent-foundry`: five slash controls, a user-level bench, six opt-in SDLC companion definitions rendered on activation, a team lead, and a trusted GitHub-skill catalog.
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

Start Copilot with `copilot --experimental` after installing or updating. The
plugin extension then registers `/bench`, `/join`, `/retire`, and
`/list-skills` as direct client commands: they execute TypeScript without a
model request or model tokens. `/contract` deliberately remains model-backed
because it creates exactly one child. Use Copilot's native `/agent` selector
for `team-lead`, `repo-cartographer`, `crafter`, or players activated through
`/bench`.

For a prompt sent straight to one named player, use
`/harbor-<id> <task>`—for example `/harbor-design design the bounded change`.
This selects that exact agent and sends one prompt without a separate routing
inference. Fixed and bundled aliases are registered at startup; an inactive
bundled player is rejected before inference. Restart the session after adding
a personal player so its alias can be discovered. `/harbor-team-lead` is
deliberately different: the coordinator may run the smallest necessary
sequence of one to six named children. The extension guards Copilot's native
`task` calls in code: only exact active Agent Harbor targets are accepted,
nested or concurrent delegation is denied, and the count resets per user
prompt.

Copilot may request one extension-capability approval when these coordinator
hooks first attach. That host permission exchange is deterministic and does not
send a model prompt.

The four deterministic controls are deliberately **not** published as Copilot
skills, so they cannot silently fall back to a model-routed path and spend
tokens. If extensions are disabled, use the package CLI directly—for example
`agent-harbor copilot bench list`—or enable extensions with `/experimental on`
and keep `/extensions mode` on **Load Only** or **Load & Augment**. `/contract`
remains the only command published as a skill because it intentionally creates
one intelligent child.

The `agent-foundry` plugin also contributes the global `agent-harbor` MCP
server with only the bounded `control` tool. A player that has configured
skills receives a separate player-scoped `skills` tool; it performs snapshot
validation in code before returning invocation-local guidance.
`repo-cartographer:crafter` therefore requires `agent-foundry` to remain
enabled, as in the installation sequence above.

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

For a guaranteed direct execution, select one of these entries from OpenCode's
slash autocomplete: `/bench-list`, `/bench-on`, `/bench-off`, `/harbor-join`,
`/harbor-retire`, `/harbor-list-skills`, or `/harbor-filter-skills`. They run in
the TUI plugin and do not create a model session. The `on`, `off`, `join`,
`retire`, and filter entries collect their arguments in a dialog.

The canonical `/bench`, `/join`, `/retire`, `/contract`, and `/list-skills`
commands remain available for parity, but OpenCode routes that command system
through the model. For exact argument syntax without inference, use the package
CLI, for example `agent-harbor opencode bench on portfolio-management`. Select `team-lead`,
`repo-cartographer`, `crafter`, or an activated player through OpenCode's native
agent interface.

OpenCode also exposes `/harbor-<id> <task>`. Its command configuration uses the
exact agent, passes `$ARGUMENTS` unchanged and sets `subtask: false`, avoiding a
router turn and OpenCode's extra parent-summary inference. Invocation-time
preflight rejects an empty task or an alias whose ownership/activity changed
after configuration. Start a new session after changing the roster so newly
active aliases are added; a stale deactivated alias is blocked before inference.

The OpenCode `team-lead` can use only `harbor_delegate`. It resolves an exact
active target, creates and cleans one child at a time, and enforces six calls per
originating user turn even though OpenCode creates intermediate assistant
messages. Its tool enum and description expose the exact startup-active targets,
so the model does not have to guess the roster. Every generated agent policy starts
with `"*": false` before enabling its explicit least-privilege tools.

OpenCode does not accept Pi's `git:github.com/…` shorthand, but its current package installer accepts the repository archive URL. The equivalent npm-ready command is `opencode plugin @gvillarroel/agent-harbor --global` once that package is published. The package registers commands and agents from both `agent-foundry` and `repo-cartographer` through OpenCode's plugin configuration hook.

The package installs both an OpenCode server target and a TUI target. The server
provides the five canonical [commands](https://opencode.ai/docs/commands), tools,
and named [agents](https://opencode.ai/docs/agents); the TUI target provides the
direct controls above. Player activation targets `.opencode/agents/` in the
current project; user registrations use the standard OpenCode configuration
directory.

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

Invoke `/bench`, `/join`, `/retire`, or `/list-skills` directly; their native
handlers perform no model request. `/contract` creates exactly one child by
design. Invoke `/team-lead <task>`, `/repo-cartographer <task>`,
`/crafter <task>`, any activated bundled SDLC companion, or any active personal
player directly.

`/team-lead` can delegate sequentially to as many as six active specialists
when the task genuinely needs multiple stages. Each delegation is
ownership-checked immediately before it creates one isolated in-memory child;
recursion and a seventh call are rejected. Pi marks the custom delegation tool
as sequential, so sibling tool calls cannot open children in parallel. The
tool schema lists the exact active targets captured when that team-lead session
starts.

The root `package.json` declares only the compiled Pi extension. Through `ExtensionAPI`, it registers the five lifecycle commands, the three fixed roles, and every ownership-verified active player. Role/player commands create a real in-memory `createAgentSession` child with a native tool allowlist; they are not static prompt templates. Active definitions live privately in the current project's `.pi/agents/`, and mutations register newly active names immediately (a reload removes names that were deactivated during the current session).

</details>

All three native distributions are designed to run on macOS, Linux, and Windows. Agent profiles use portable abstract tools while the adapters translate them to each SDK's native allowlist. User-level storage resolves from the runtime-specific absolute config directory or the current user's home directory. Nothing assumes a shell family, path separator, platform package, or system-specific executable. The only external command used by the lifecycle core is the cross-platform `gh` CLI expected on `PATH`.

## Shared library and native adapters

`src/core` is the shared TypeScript library. It owns validation, roster
lifecycle, transactional writes, GitHub snapshot resolution, and the five
command contracts. Harness modules contain only native translation and SDK
integration:

- Copilot consumes `plugins/` through its marketplace/plugin system; its client
  extension executes deterministic controls directly, while only the
  model-backed `/contract` keeps a skill wrapper and MCP preflight;
- `src/adapters/opencode.ts` exposes server commands and tools, while
  `src/adapters/opencode-tui.ts` exposes direct TUI controls;
- `src/adapters/pi.ts` registers native commands through Pi `ExtensionAPI`;
- `src/orchestrators/` uses the Copilot, OpenCode, and Pi SDKs for disposable
  child sessions.

Build every native distribution with:

```shell
npm run build
```

The npm package exposes separate compiled OpenCode server and TUI entrypoints,
the Pi extension in its `pi` manifest, and `agent-harbor` as a universal direct
CLI for deterministic controls. Its Copilot `/contract` entrypoint is the only
CLI path that starts an SDK model session; OpenCode and Pi contracts must run in
their hosts. Users still install through each harness's native mechanism.

## Tests

Run a clean TypeScript build, the contract/security suite, and native discovery tests:

```shell
npm test
```

`npm test` is one Node wrapper rather than an npm/`&&` command chain. It rebuilds generated artifacts, removes inherited `NODE_TEST_CONTEXT`, validates each child exit/signal and requires the native runner's TAP summary (`tests > 0`, `fail = 0`), preventing shell propagation quirks, nested-runner state or loaded host code from creating a false green. The suite evaluates all five command contracts across the three runtimes; verifies byte-exact rollback, mutation locking, canonical ownership, idempotency, collisions and leaf/ancestor symlinks; checks remote-body validation, closed tool policies, disposable-session cleanup and double-failure reporting; confirms Copilot/OpenCode discovery; and installs Pi into a temporary home. The agent matrix proves that only the three fixed roles start active and all nine names are available after `bench on all`.

The literal, closed-schema dataset in `test-ts/fixtures/harbor-cycles.json` is independent from the runtime catalog. It defines the default fixed-role map/build cycle and the opt-in six-companion SDLC cycle. The same cases feed the Copilot hooks and the real OpenCode/Pi delegation tools, while a normalized SDK test proves activation, exact target identity, sequential evidence handoff and cleanup in all three orchestrators. Optional evidence hooks store only SHA-256 hashes, UTF-8 sizes and correlation metadata—never raw tasks or responses—and are no-ops unless explicitly injected. Events label their basis as observed or inferred, so Copilot's synchronous terminal fallback is not presented as a native cleanup event. These offline tests exercise no model or network. They prove requested routing and lifecycle mechanics; the separate live smoke below proves model-driven selection.

Run the authenticated live acceptance explicitly when changing lead selection,
handoff, or native orchestration hooks:

```shell
# GitHub Copilot CLI
npm run test:live:lead

# OpenCode or Pi independently
npm run test:live:opencode
npm run test:live:pi

# OpenCode and Pi in one verified run
npm run test:live:codex
```

These commands deliberately consume model tokens and are never part of
`npm test`. Each selects the real `team-lead`, activates the dataset's
six-companion cycle through the deterministic zero-model CLI, presents candidate
agents and their published roles out of workflow order, and requires the lead
to map each exclusive role to its gate as
`portfolio-management → design → build → manage → consume → dispose`. Every
gate is bounded to three fixture files: portfolio management frames value,
scope, risk and acceptance evidence; design produces the smallest supported
plan; build alone edits and does not run tests; manage runs `npm test` exactly
once without editing; consume performs the read-only consumer acceptance,
correctness, safety and coverage review; and dispose plans safe closure, EOL,
retention, decommissioning and rollback solely from returned evidence. Dispose
never deletes or undoes the build. After inference, the
runner deterministically returns all six bundled companions to the bench and
checks that the managed roster was cleaned. Listing that bench directly remains
a separate zero-token operation in every harness.

A random hidden fixture ID proves that evidence moves through immediate,
bounded handoffs: `portfolio-management` must discover it, and every later
delegated prompt must carry it between one and three times without copying the
complete prior response. Native prompt, delegation, tool-terminal, model-usage,
and session events—not model-authored text—are authoritative for agent identity and
completion. A child may emit its own handoff marker as a diagnostic; if it does,
the marker may appear only once and must not repeat or leak a predecessor's
marker. Prompts stay below 4 KiB, delegations remain sequential and unique, and
the fixture must move from a failing preflight test to a passing verification.

Before inference, the smoke confirms the exact Agent Harbor extension is running with a live process and a native `/bench` client command. It requests a fixture-only Copilot sandbox with outbound and local networking disabled and requires the SDK's successful update acknowledgement; the report derives the redacted requested policy from the same object and distinguishes request attempt from acknowledgement. The permission handler permits only fixture reads, the expected source edit, the native `task` tool, and the fixture's test command, and the run must observe at least one real runtime permission decision. The same configured callback is also exercised directly with an otherwise valid `npm test` request carrying `requestSandboxBypass: true`; this is reported as a synthetic handler canary, separately from runtime decisions, and must be rejected. The extension emits one ephemeral, redacted guard proof per accepted delegation; all six proofs must match the native `toolCallId` and prompt fingerprint. Nested Node verification names the test file explicitly and removes inherited `NODE_TEST_CONTEXT` so the fixture cannot pass without executing. The default is `gpt-5.4-mini` with reasoning `low`: the small reasoning allowance makes the six-state lifecycle reliable while the CLI's 60-credit ceiling and the test's stricter 36-turn, 200,000-token, and 180-second budgets remain authoritative. `AGENT_HARBOR_LIVE_MODEL` and `AGENT_HARBOR_LIVE_REASONING` may override these settings. `COPILOT_CLI_PATH` may point to the authenticated executable when it is not discoverable on `PATH`.

The Copilot report is written to `work/live-team-lead-report.json`. Its v2
schema contains hashes, byte counts, order, duration, root/child/total token
metrics, requested resource budgets and observed totals, extension status,
requested sandbox policy plus request/acknowledgement state, guard-proof count,
and separate runtime-permission/synthetic-canary totals—never prompts,
responses, the hidden ID, paths, commands or raw errors.

The OpenCode and Pi runs use Codex OAuth and write
`work/live-opencode-team-lead-report.json` and
`work/live-pi-team-lead-report.json`, respectively. Both use the shared
`agent-harbor/live-codex-team-lead@1` envelope. Their preload observers and
hooks retain only hashes, byte counts, bounded occurrence counts, correlation
metadata, model usage, runtime identity and terminal status; raw prompts,
responses, nonce values, paths, commands and errors are excluded from the
persistent reports. OpenCode uses provider `openai` with reasoning `medium`;
Pi uses provider `openai-codex` with reasoning `low`. The preferred model is
exactly `gpt-5.3-codex-spark`. `gpt-5.6-luna` is selected only as a catalog
fallback before any inference starts; a provider or functional failure never
triggers a second-model retry that could double spend or hide the failure.

The authenticated results recorded on 2026-07-20 are:

| Harness | Runtime | Provider / model | Reasoning | Luna fallback | Wall time | Model turns | Tool calls | Observed tokens | Verification / cleanup |
| --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | --- |
| Copilot | 1.0.71 | `copilot/gpt-5.4-mini` | `low` | N/A | 36,439 ms | 18 | 15 | 115,434 | Passed / cleaned |
| OpenCode | 1.18.3 | `openai/gpt-5.3-codex-spark` | `medium` | No | 113,318 ms | 18 | 17 | 57,847 | Passed / cleaned |
| Pi | 0.80.10 | `openai-codex/gpt-5.3-codex-spark` | `low` | No | 32,605 ms | 18 | 15 | 50,272 | Passed / cleaned |

The combined Codex `all --verify-report-only` check accepted both fresh Codex
reports, and the Copilot `--verify-report-only` gate accepted its fresh v2
report.

Every live script removes inherited runner state and its prior report, then
requires a newly written `status: passed` report with the expected schema and a
finite timestamp that is neither stale nor future-dated. “Efficient” here is
executable: root turns are capped at stages + 2; the complete run is capped at
36 model turns, 60 tool calls, 180 seconds and 200,000 conservatively observed
tokens; each child is capped at 35,000 tokens and 12 tools; prompt, evidence and
final-response byte budgets are also enforced. The tests account for native
root and child usage without gaps. These bounds measure routing, immediate
handoff and run resources, not universal model quality or cost.

The suite also exercises exact dispatch of all nine OpenCode IDs, direct Pi invocation of all nine, and native Copilot discovery/selection of all nine. Coordinator tests enforce exact active targets, per-user-turn bounds, sequential execution, no recursion and cleanup across Copilot, OpenCode and Pi. A delayed-reload race test proves that stale Copilot discovery cannot overwrite a newer root selection event. The suite proves that every distribution can list the bench without a model, that Pi and OpenCode direct controls cannot enter an orchestrator, and that Copilot's lifecycle command and native agent selection emit no assistant message or usage event. The native CLI checks run concurrently in isolated directories. Missing CLIs skip only their runtime assertion; no Python runtime, live model call, API key, Docker service, or network access is required.

## Commands

| Command | Purpose |
| --- | --- |
| `/bench` | List players or set their current-folder state with `on` and `off`. |
| `/join` | Register a recurring player at user level and activate it here. |
| `/retire` | Remove one personal registration and its managed local copy. |
| `/contract` | Run one synchronous, invocation-scoped subagent without registration. |
| `/list-skills` | List trusted GitHub skill references; distinct from built-in `/skills`. |
| `/scout <need>` | Use one restricted recruiter turn to create and join a persistent player from the execution-trusted skill group. |

The inference budget is part of the executable contract:

| Operation | Required model budget |
| --- | --- |
| View or change the bench, join, retire | 0 model requests on a direct surface |
| List trusted skills | 0 model requests; authenticated `gh` network I/O is allowed |
| Scout and join a player | One recruiter model session; skill filtering and the final join are deterministic scoped tools |
| Valid contract | Exactly one child model session |
| Explicit non-coordinator player command | One prompt to the exact player; 0 routing prompts |
| Coordinated mission | One coordinator prompt plus 1..6 sequential named children |
| Invalid contract preflight | 0 children |

“Zero model” means no provider prompt, inference, model session, or child; an
already-running host and deterministic filesystem, lock, or `gh` work do not
count. A wrapper that merely avoids creating a child is not zero-model if the
parent model still routes it.

The portable package form is:

```shell
agent-harbor <copilot|opencode|pi> <bench|join|retire|list-skills> [arguments]
```

`agents`, `lineup`, and `leave` are intentionally absent: each harness already
has native agent selection, while `lineup` and `leave` duplicated `bench`.

## Bench

The zero-model way to view it is `/bench` in experimental Copilot and in Pi,
`/bench-list` selected from OpenCode autocomplete, or the universal
`agent-harbor <harness> bench list` command.

```text
/bench
/bench on portfolio-management design
/bench off build
/bench on all
/bench off all
```

`on` and `off` are idempotent. There is no `toggle`. `all` means only the six
bundled companion profiles:

`portfolio-management → design → build → manage → consume → dispose`

The three fixed roles are active without this command. Their editable source is
`src/core/roles/*.md`: each file declares `name`, `description`, `order`,
`tools`, and trusted skill names in closed JSON frontmatter, while its Markdown
body is the prompt. Add a file and rebuild to include another fixed definition;
duplicate names/orders, symlinks, unknown fields, and untrusted skills fail the
build or startup closed. The six companion names
above are only included definitions until activated; discovery and direct
invocation reject them while they remain on the bench.

Their canonical definitions live once in `src/core/defaults.ts` and are rendered directly into the current harness's native agent directory when activated. A batch is serialized, fully preflighted, written file-atomically, verified, and rolled back byte-for-byte on failure.

For upgrades, the former IDs `scout`, `sage`, `smith`, `probe`, `guard`, and
`pilot` remain reserved and Agent Harbor will not route or register them. A
native harness can still discover their old project files until they are
cleaned and the session is restarted. Run this explicit cleanup before relying
on the exact six-companion roster:

```text
/bench off scout sage smith probe guard pilot
```

It removes only legacy profiles with complete Agent Harbor ownership. Any
mutation of the new bundled companions, including `/bench on all`, performs the
same legacy cleanup in its transaction. An unmanaged legacy collision aborts
the whole mutation and is never overwritten or deleted.

## Personal players

The model-assisted shortcut is:

```text
/scout alguien que escriba scripts en zx para automatizar usando sub agentes
```

`/scout` selects the fixed internal `talent-scout` agent. That agent receives
no filesystem, shell, ambient skill, delegation, contract, or general
lifecycle tools. It can only filter the exact `trustedSkills` group by public
frontmatter metadata and call one closed-schema `join`. It may issue at most
three filter queries and one join. The generated player is persistent and
otherwise follows the same validation, ownership, collision, and activation
rules as a literal `/join`.

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

Version 0.12 renders canonical revision 4 profiles. Revision 4 stores the
validated definition in every harness profile so the adapter can recover and
enforce that exact player's skill group. Owned revision 3 profiles remain safe
to replace or remove, but are not invocable under the new isolation guarantee;
run `bench on <id>` for bundled players or re-run `join` with `replace:true` for
personal players. Revisions 1 and 2 are never treated as ownership.

`skills` accepts at most three references with unique names. A repository
reference points to one exact `SKILL.md` relative to the current project root;
a GitHub reference must match the trusted exact-reference catalog. A portable
player with skills must explicitly include `read`, but does not receive
`execute` merely to load them. Omitted `skills` and `skills: []` both mean an
empty skill group:

```text
/join {"name":"reviewer","description":"Repository-guided reviewer","prompt":"Review the requested scope.","tools":["read","search"],"skills":[{"kind":"repo","name":"review-checklist","path":"skills/review-checklist/SKILL.md"}]}
/join {"name":"zx-maker","description":"Minimal zx author","prompt":"Create the smallest runnable example.","tools":["read","search","edit","execute"],"skills":[{"kind":"repo","name":"project-conventions","path":".agents/skills/project-conventions/SKILL.md"},{"kind":"github","name":"zx-example-author","repo":"gvillarroel/zx-harness","path":"skills/zx-example-author/SKILL.md","track":"refs/heads/main"}]}
```

Every source is revalidated before a child can start: 1..18,000 UTF-8 bytes,
first-line YAML frontmatter, one matching top-level `name`, an exact contained
repository path with no symlink traversal, or a trusted GitHub branch pinned to
one commit. Only the instruction body is copied into an invocation-scoped
capsule; sibling files are unavailable.

Enforcement is harness-specific. Copilot SDK sessions disable config discovery,
point `skillDirectories` at only that capsule, and preload only the configured
names; persistent Copilot profiles expose one no-argument MCP tool bound to the
player's complete group through a separate player-scoped server process; the
global MCP server never lists any player skill group. OpenCode denies
its ambient `skill` tool and exposes one no-argument group loader whose handler
derives the exact managed definition from `execution.agent`; `/contract`
injects only the prevalidated group while keeping `skill` disabled. Pi uses
`noSkills: true`, exact `additionalSkillPaths`, and a fail-closed
`skillsOverride`, so global and project-discovered skills never enter the child
registry. A failure in any member creates zero children.

## Disposable players

```text
/contract {"name":"reviewer","description":"Read-only reviewer","prompt":"Review only; never edit.","tools":["read","search"],"skills":[],"task":"Review src and return three findings."}
```

Interactive Copilot `/contract` passes the literal JSON through the structured `control` tool of the plugin-provided `agent-harbor` MCP server—never through shell interpolation—then calls Copilot's native `task` exactly once with the validated payload; it never creates a second `CopilotClient`. The programmatic `agent-harbor copilot contract` entrypoint uses `@github/copilot-sdk` and explicitly deletes its session. OpenCode and Pi also create and dispose one SDK child. SDK-backed paths enforce native tool maps; Copilot's built-in `task` profiles can only represent the requested subset as child policy, not an operating-system sandbox.

## Trusted skills

The visible catalog is controlled per project by
`.agent-harbor/skill-sources.json`. A present file replaces the built-in list,
so you can show a whole repository, one folder, or one exact skill:

```json
{
  "version": 1,
  "sources": [
    {
      "kind": "github",
      "scope": "repository",
      "repo": "owner/all-skills",
      "track": "refs/heads/main"
    },
    {
      "kind": "github",
      "scope": "folder",
      "repo": "owner/team-skills",
      "path": "skills/frontend",
      "track": "refs/heads/main"
    },
    {
      "kind": "github",
      "scope": "skill",
      "repo": "gvillarroel/zx-harness",
      "path": "skills/zx-example-author/SKILL.md",
      "name": "zx-example-author",
      "track": "refs/heads/main"
    }
  ]
}
```

`/list-skills [filter]` displays only `REPOSITORY`, `PATH`, and `SKILL`. Add
`--descriptions` (or `-d`) to append `DESCRIPTION`; description text comes
only from bounded `SKILL.md` frontmatter and the instruction body remains
private. Copilot
uses a dedicated bordered table with aligned colored cells and a zero-token
heading; Pi, the OpenCode TUI, and an interactive package CLI use the compact
colored table. Repository and folder scopes enumerate `SKILL.md` paths from one
immutable branch snapshot without downloading their bodies. The optional
`name` field overrides the folder-derived name only for an exact `skill` scope.
Use `"sources": []` to display an empty catalog.

Catalog visibility is intentionally separate from execution trust. Showing a
repository or folder does not authorize every discovered skill for a player.
The execution allowlist remains a set of explicit exact references in
`src/core/defaults.ts`. The included policy trusts
`gvillarroel/zx-harness/skills/zx-example-author/SKILL.md` on
`refs/heads/main`. Repository references are not global or folder-wide: each
player names one project-relative `SKILL.md`, and that file is copied only for
that player's invocation. List GitHub catalog snapshots without downloading
their bodies:

```text
/list-skills
/list-skills zx
/list-skills --descriptions
/list-skills --descriptions automation
```

The command uses the developer's authenticated `gh` CLI. It resolves the
configured branch before listing but keeps commit/blob details out of the
compact table.

There are therefore two deliberately separate lists to edit:

- `.agent-harbor/skill-sources.json` in the current project controls what
  `/list-skills` shows and accepts repository, folder, or exact-skill scopes.
- `trustedSkills` in `src/core/defaults.ts` controls the exact skills that may
  be assigned to a player and that `/scout` is allowed to return. It accepts
  only exact `SKILL.md` references; changing it requires rebuilding the
  package. A broad visible repository never becomes executable implicitly.

## Agents

The three fixed roles are available at startup and are separate from the
opt-in SDLC companions:

- `agent-foundry:team-lead`: derives the smallest sufficient sequence, preferring one specialist and permitting at most six sequential named delegations when distinct stages are necessary.
- `repo-cartographer:repo-cartographer`: builds compact evidence-based repository maps.
- `repo-cartographer:crafter`: loads only its player-scoped trusted zx skill group on every invocation, then creates a minimal self-contained zx or TypeScript command example.

The six bundled companions start on the bench and represent the ordered SDLC
when the full cycle is explicitly required. For ordinary work, `team-lead`
still selects only the smallest sufficient subset:

- `portfolio-management`: frames portfolio value, priority, scope, acceptance criteria, dependencies, and risk from repository evidence.
- `design`: turns approved scope into the smallest evidence-backed design and explicit completion criteria.
- `build`: implements the approved design with a bounded change and leaves execution to lifecycle management.
- `manage`: verifies and operates the built change, producing reproducible operational evidence without editing it.
- `consume`: validates correctness, safety, coverage, usability, and value from the consumer's perspective.
- `dispose`: performs a non-destructive disposition review covering keep, evolve, eventual retirement, retention, rollback, and decommissioning; it never removes or undoes the delivered change.

The isolation guarantee applies to the skill registry and Agent Harbor loaders:
only references configured for that player are revealed or materialized as
skills. It is not a filesystem or network ACL. A player that already has
`read` can still open another ordinary repository file if it knows the path,
and a player explicitly granted `execute` can run authorized shell/network
commands. Strong information isolation requires a separate harness sandbox.
