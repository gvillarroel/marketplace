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

Start Copilot with `copilot --experimental` after installing or updating. The
plugin extension then registers `/bench`, `/join`, `/retire`, and
`/list-skills` as direct client commands: they execute TypeScript without a
model request or model tokens. `/contract` deliberately remains model-backed
because it creates exactly one child. Use Copilot's native `/agent` selector
for `team-lead`, `repo-cartographer`, `crafter`, or players activated through
`/bench`.

For a prompt sent straight to one named player, use
`/harbor-<id> <task>`—for example `/harbor-scout map the relevant files`.
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

If experimental extensions are disabled, the same slash names remain available
as model-routed skills backed by the stable MCP server. That compatibility path
is not zero-token. The package CLI is the stable direct alternative when its
bin is installed, for example `agent-harbor copilot bench list`.

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

For a guaranteed direct execution, select one of these entries from OpenCode's
slash autocomplete: `/bench-list`, `/bench-on`, `/bench-off`, `/harbor-join`,
`/harbor-retire`, `/harbor-list-skills`, or `/harbor-filter-skills`. They run in
the TUI plugin and do not create a model session. The `on`, `off`, `join`,
`retire`, and filter entries collect their arguments in a dialog.

The canonical `/bench`, `/join`, `/retire`, `/contract`, and `/list-skills`
commands remain available for parity, but OpenCode routes that command system
through the model. For exact argument syntax without inference, use the package
CLI, for example `agent-harbor opencode bench on scout`. Select `team-lead`,
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
`/crafter <task>`, or any active personal player directly.

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
  extension executes deterministic controls directly, while lifecycle skills
  and the plugin-provided MCP server provide the stable fallback;
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

The literal, closed-schema dataset in `test-ts/fixtures/harbor-cycles.json` is independent from the runtime catalog. It defines the default map/build cycle and the opt-in six-stage SDLC cycle. The same cases feed the Copilot hooks and the real OpenCode/Pi delegation tools, while a normalized SDK test proves activation, exact target identity, sequential evidence handoff and cleanup in all three orchestrators. Optional evidence hooks store only SHA-256 hashes, UTF-8 sizes and correlation metadata—never raw tasks or responses—and are no-ops unless explicitly injected. Events label their basis as observed or inferred, so Copilot's synchronous terminal fallback is not presented as a native cleanup event. These offline tests exercise no model or network. They prove requested routing and lifecycle mechanics; the separate live smoke below proves model-driven selection.

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
six-stage cycle through the deterministic zero-model CLI, presents candidate
agents and their published roles out of workflow order, and requires the lead
to map each exclusive role to its gate as
`scout → sage → smith → probe → guard → pilot`. Every gate is bounded to three
fixture files; only implementation edits, verification runs `npm test` once,
review only reads, and delivery uses returned evidence. After inference, the
runner deterministically returns all six bundled players to the bench and
checks that the managed roster was cleaned. Listing that bench directly remains
a separate zero-token operation in every harness.

A random hidden fixture ID proves that evidence moves through immediate,
bounded handoffs: `scout` must discover it, and every later delegated prompt
must carry it between one and three times without copying the complete prior
response. Native prompt, delegation, tool-terminal, model-usage, and session
events—not model-authored text—are authoritative for agent identity and
completion. A child may emit its own handoff marker as a diagnostic; if it does,
the marker may appear only once and must not repeat or leak a predecessor's
marker. Prompts stay below 4 KiB, delegations remain sequential and unique, and
the fixture must move from a failing preflight test to a passing verification.

Before inference, the smoke confirms the exact Agent Harbor extension is running with a live process and a native `/bench` client command. It requests a fixture-only Copilot sandbox with outbound and local networking disabled and requires the SDK's successful update acknowledgement; the report derives the redacted requested policy from the same RPC object and distinguishes request attempt from acknowledgement. The permission handler permits only fixture reads, the expected source edit, the native `task` tool, and the fixture's test commands, and the run must observe at least one real runtime permission decision. The same configured callback is also exercised directly with an otherwise valid `npm test` request carrying `requestSandboxBypass: true`; this is explicitly reported as a synthetic handler canary, separately from runtime decisions, and must be rejected. The extension emits one ephemeral, redacted guard proof per accepted delegation; all six proofs must match the native `toolCallId` and prompt fingerprint. Nested Node verification names the test file explicitly and removes inherited `NODE_TEST_CONTEXT` so the fixture cannot pass without executing. The default is `gpt-5.4-mini` with reasoning `none`, selected because the acceptance checks literal six-gate compliance rather than deep implementation reasoning; the CLI receives a 60-credit shared safety ceiling while the test enforces the stricter 36-turn, 200,000-token and 180-second budgets. `AGENT_HARBOR_LIVE_MODEL` and `AGENT_HARBOR_LIVE_REASONING` may override the model settings. `COPILOT_CLI_PATH` may point to the authenticated executable when it is not discoverable on `PATH`.

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
| OpenCode | 1.18.3 | `openai/gpt-5.3-codex-spark` | `medium` | No | 103,674 ms | 19 | 18 | 44,544 | Passed / cleaned |
| Pi | 0.80.10 | `openai-codex/gpt-5.3-codex-spark` | `low` | No | 31,110 ms | 19 | 18 | 38,840 | Passed / cleaned |

The combined `all --verify-report-only` check accepted both fresh reports.

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

The inference budget is part of the executable contract:

| Operation | Required model budget |
| --- | --- |
| View or change the bench, join, retire | 0 model requests on a direct surface |
| List trusted skills | 0 model requests; authenticated `gh` network I/O is allowed |
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
/bench on scout sage
/bench off smith
/bench on all
/bench off all
```

`on` and `off` are idempotent. There is no `toggle`. `all` means only the six bundled profiles:

`scout → sage → smith → probe → guard → pilot`

The three fixed roles are active without this command. The six names above are
only included definitions until activated; discovery and direct invocation
reject them while they remain on the bench.

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

- `agent-foundry:team-lead`: derives the smallest sufficient sequence, preferring one specialist and permitting at most six sequential named delegations when distinct stages are necessary.
- `repo-cartographer:repo-cartographer`: builds compact evidence-based repository maps.
- `repo-cartographer:crafter`: refreshes the trusted external zx skill on every invocation, then creates a minimal self-contained zx or TypeScript command example.

The marketplace relies on Copilot's native Markdown agents, user-invocable skills, and subagent tools. Its policies reduce accidental scope but cannot turn model instructions into an operating-system sandbox.
