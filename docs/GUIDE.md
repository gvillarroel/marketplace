# Guía completa de Agent Harbor

Agent Harbor is a TypeScript library with native adapters for GitHub Copilot CLI, OpenCode, and Pi. Copilot consumes plugin manifests directly; OpenCode loads a compiled plugin and Pi loads a compiled extension. All three share the same executable command contracts.

The normative product, safety, lifecycle, and cross-runtime acceptance
requirements are consolidated in [REQUIREMENTS.md](REQUIREMENTS.md).

The current technical and operational design is documented in
[ARCHITECTURE.md](ARCHITECTURE.md).

It contains one plugin: `agent-foundry`, with five slash controls, a user-level
bench, six opt-in SDLC companion definitions, a team lead, a `crafter`, the
restricted talent scout, and a trusted GitHub-skill catalog.

## Install

<details>
<summary><strong>GitHub Copilot CLI</strong></summary>

### Install

```shell
copilot plugin marketplace add gvillarroel/marketplace
copilot plugin install agent-foundry@agent-harbor
```

### Update

```shell
copilot plugin marketplace update agent-harbor
copilot plugin update agent-foundry
```

### Use

Start Copilot with `copilot --experimental` after installing or updating. The
plugin extension then registers `/team`, `/bench`, `/join`, `/retire`, and
`/list-skills` as direct client commands: they execute TypeScript without a
model request or model tokens. `/team` shows the roster, live root and child
work, effective model/reasoning, native usage, lead capacity, and the last
mission; `/team stop <run-id|all>` cancels controlled project work. `/contract`
deliberately remains model-backed because it creates exactly one child. Use
Copilot's native `/agent` selector for `team-lead`, `crafter`, or players
activated through `/bench`.

The unfiltered Copilot overview dynamically fits within 30 wrapped lines of 96
terminal cells. It always keeps the nine factory IDs and uses any remaining
space for personal members and activity; omitted rows include a count and a
filter to retrieve them. Filtered member/run views are the richer detail path
and retain the 96-cell line bound. If Copilot does not report a current model,
the view says `no model reported (unobserved)` rather than inventing an
`unknown/default` model.

For a prompt sent straight to one named player, use
`/<id> <task>`—for example `/design design the bounded change`.
This selects that exact agent and sends one prompt without a separate routing
inference. Fixed and bundled aliases are registered at startup; an inactive
bundled player is rejected before inference. `/player <id> <task>` resolves the
currently enabled roster dynamically. A newly joined personal player can be
usable in the same session when the authoritative refresh reports it `ready`
and it needs no new skill loader. The same is possible for a skilled player
whose ID already had a bound loader in the startup tool union, as in a same-ID
replacement of a player that started with skills. Otherwise `/reload` repairs
discovery or registers the missing loader before first use. Reload also adds a new
convenience `/<id>` alias. `/team-lead` is
deliberately different: the coordinator may run the smallest necessary
sequence of one to six named children. The extension guards Copilot's native
`task` calls in code: only exact enabled Agent Harbor targets are accepted,
nested or concurrent delegation and persistent-member double-booking are
denied before native child work, and the count resets per user prompt.

Direct player runs attach native usage and terminal listeners before sending
one prompt, then restore the previous selection. A timeout requests abort and
waits for a bounded terminal event; if Copilot does not settle, the selection
stays pinned and another player cannot start until the late terminal event.
See [Copilot team observability](COPILOT-TEAM-OBSERVABILITY.md) for telemetry,
privacy, and cleanup semantics.

Copilot may request one extension-capability approval when these coordinator
hooks first attach. That host permission exchange is deterministic and does not
send a model prompt.

The five deterministic controls are deliberately **not** published as Copilot
skills, so they cannot silently fall back to a model-routed path and spend
tokens. If extensions are disabled, use the package CLI directly—for example
`agent-harbor copilot bench list`—or enable extensions with `/experimental on`
and keep `/extensions mode` on **Load Only** or **Load & Augment**. `/contract`
remains the only command published as a skill because it intentionally creates
one intelligent child.

The `agent-foundry` extension contributes native custom tools from one shared
closed-schema implementation. `/contract` receives `harbor_contract`; the
recruiter receives only its roster/filter/join trio; and every player with
configured skills receives a distinct `harbor_skill_<id>` loader whose handler
is already bound to that ID. The model never supplies a player ID to a skill
loader.
The fixed `agent-foundry:crafter` uses `harbor_skill_crafter`.

At startup the extension registers exactly those four static tools plus one
bound loader for each skilled fixed role or canonical active profile. It does
not register loaders for benched players. Copilot lead delegation remains
native guard behavior; the roster custom tool is principal-bound to the scout,
read-only and bounded. This surface uses no external server, transport
configuration, or custom-tool helper process. Roster mutations themselves use
short-lived local Node workers whose current directory is the filesystem
capability being changed; they exit before the command returns.

Start a new session after installing, updating, or changing project agents.
Copilot's public extension API fixes the registered tool set at `joinSession`,
so a skilled player whose bound loader was absent at startup is stored with its
active project copy but cannot be invoked until `/reload`. If the same bound
loader was already registered, the handler revalidates and loads the current
owned definition without another reload. Start the session from the target
folder so project-scoped registration and ownership checks use the intended
working tree.

</details>

<details>
<summary><strong>OpenCode</strong></summary>

### Install

Install the package directly from this repository's GitHub tarball:

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
slash autocomplete: `/team`, `/bench-list`, `/bench-on`, `/bench-off`, `/harbor-join`,
`/harbor-retire`, `/harbor-list-skills`, or `/harbor-filter-skills`. They run in
the TUI plugin and do not create a model session. The `on`, `off`, `join`,
`retire`, and filter entries collect their arguments in a dialog.

`/team` also opens a dialog: press Enter for the compact whole-team overview,
or enter a filter, `help`, `stop <run-id>`, or `stop all`. The overview is
dynamically bounded to 30 wrapped lines of 96 cells, always includes the nine
factory IDs, and counts any personal members or activity rows it omits while
pointing to a narrowing filter. Broad filtered views remain compact; a narrow
member/run filter exposes richer detail within the same 30-line dialog bound.
It shows only ownership-verified project activity with opaque public run IDs
and bounded native usage. See
[OpenCode team observability](OPENCODE-TEAM-OBSERVABILITY.md) for provenance,
privacy, stop, cleanup, and degradation semantics.

Roster state and loaded host discovery are intentionally separate. An active
profile that this OpenCode session already loaded is `ready · invocable`; a
successful `/bench-on` or `/harbor-join` that is not loaded yet is `enabled ·
reload required` for native selection and `/<id>`. The lead's live roster can
still discover and delegate to that enabled member before reload; its own
preflight remains authoritative. `/bench-off` and `/harbor-retire` block
invocation immediately, but their confirmations require a reload when OpenCode
still has a stale native agent or convenience alias to remove. If roster
inventory is temporarily unavailable, the overview retains all nine factory
IDs and marks the six known bundled teammates `unavailable` rather than
dropping them.

The canonical `/bench`, `/join`, `/retire`, `/contract`, and `/list-skills`
commands remain available for parity, but OpenCode routes that command system
through the model. For exact argument syntax without inference, use the package
CLI, for example `agent-harbor opencode bench on portfolio-management`. Select
`team-lead`, `crafter`, or a player that `/team` reports as `ready · invocable`
through OpenCode's native agent interface.

OpenCode also exposes `/<id> <task>`. Its command configuration uses the
exact agent, passes `$ARGUMENTS` unchanged and sets `subtask: false`, avoiding a
router turn and OpenCode's extra parent-summary inference. Invocation-time
preflight rejects an empty task or an alias whose ownership/activity changed
after configuration. Start a new session after changing the roster so newly
enabled agents and aliases are loaded. A stale deactivated or retired alias is
blocked before inference even while the old discovery entry remains visible.

Set or update a personal member's model through `/harbor-join` JSON with
`"model":"provider/model"` and, for an existing ID, `"replace":true`.
Model, token, cost, context, and max-output values in `/team` are native
observations only when OpenCode supplies them; they are not a hard Agent Harbor
token cap.

The OpenCode `team-lead` can use only the deterministic
`harbor_team_roster` lookup and `harbor_delegate`. It inspects enabled capacity
without creating a child, resolves an exact target against the live active
roster at each delegation, creates and cleans one child at a time, and enforces six calls per
originating user turn even though OpenCode creates intermediate assistant
messages. This live validation allows delegation to a player added by `/join`
during the session while still rejecting inactive or unmanaged IDs. Every generated agent policy starts
with `"*": false` before enabling its explicit least-privilege tools.

OpenCode does not accept Pi's `git:github.com/…` shorthand, but its current package installer accepts the repository archive URL. The equivalent npm-ready command is `opencode plugin @gvillarroel/agent-harbor --global` once that package is published. The package registers Agent Harbor commands and agents through OpenCode's plugin configuration hook.

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

Invoke `/team`, `/bench`, `/join`, `/retire`, or `/list-skills` directly; their
native handlers perform no model request. `/team` shows the roster, active roots
and children, effective model/thinking, native usage and last mission. It can
also stop one run or all project work. `/contract` creates exactly one child by
design. Invoke `/team-lead <task>`, `/crafter <task>`, any activated bundled SDLC
companion, or any enabled personal player directly.

Pi's unfiltered overview follows the same 30-wrapped-line, 96-cell budget: all
nine factory IDs stay visible, while personal members or active runs that do not
fit are counted and recoverable through the printed filters. Filtered views can
show richer matching details and keep the 96-cell line bound.

Pi's `/join` confirmation shows the new member's role, tools and skill names,
configured model or host inheritance, and `/<id> <task>` without exposing
managed paths. See [Pi team observability](PI-TEAM-OBSERVABILITY.md) for the
enabled-versus-active vocabulary, cancellation semantics, and native token
accounting.

`/team-lead` can delegate sequentially to as many as six enabled specialists
when the task genuinely needs multiple stages. Each delegation is
ownership-checked immediately before it creates one isolated in-memory child;
recursion and a seventh call are rejected. Pi marks the custom delegation tool
as sequential, so sibling tool calls cannot open children in parallel. The
tool schema lists the exact enabled targets captured when that team-lead session
starts. OpenCode exposes the same complete roster to its lead, reserves each
selected project/member while its child is live, and uses the specialist's
configured model when present instead of silently overriding it with the root
model.

An enabled member belongs to the available roster; an active member has a live
`starting`, `working`, or `cleaning` run. `/team` shows both dimensions, marks
enabled members with live work as busy, and blocks double-booking. A delegated
specialist with a configured `provider/model` uses that model after availability
and authentication preflight; specialists without one inherit the lead's
effective Pi model.

Pi 0.80.10 represents no active model with an `unknown/unknown` placeholder and
zero maximum, while the public context can also omit the model. `/team` combines
that state with Pi's stable usable-model snapshot: an empty healthy catalog is
`unavailable` with `/login`; available models without a selection are `not
selected` with `/model`; registry failure remains explicitly unobserved. None is
advertised as an inherited model or a real zero-token limit, and none claims the
lead can delegate. Aliases, `/contract`, and `/scout` perform the same model/auth
preflight before creating a run or child. Valid custom providers work in child
sessions because Harbor passes Pi's effective agent directory and replays only
the registered provider configurations required by the selected model or lead
roster into an isolated public `ModelRuntime`. A host key whose source is
runtime-only stays in memory; extensions are not reloaded into the child.

Pi injects these custom tools only into the isolated child that needs them. A
lead child receives delegation and roster lookup, a recruiter child receives
roster/filter/join, and an ordinary player or contractor inherits neither set.
The Pi extension does not register them globally.

The root `package.json` declares only the compiled Pi extension. Through `ExtensionAPI`, it registers the five lifecycle commands, the two fixed roles, and every ownership-verified enabled player. Role/player commands create a real in-memory `createAgentSession` child with a native tool allowlist; they are not static prompt templates. Enabled definitions live privately in the current project's `.pi/agents/`, and mutations register newly enabled names immediately (a reload removes names that were deactivated during the current session).

</details>

All three native distributions are designed to run on macOS, Linux, and Windows. Agent profiles use portable abstract tools while the adapters translate them to each SDK's native allowlist. User-level storage resolves from the runtime-specific absolute config directory or the current user's home directory. Nothing assumes a shell family, path separator, platform package, or system-specific executable. The only external command used by the lifecycle core is the cross-platform `gh` CLI expected on `PATH`.

## Shared library and native adapters

`src/core` is the shared TypeScript library. It owns validation, roster
lifecycle, transactional writes, GitHub snapshot resolution, and the five
command contracts. Harness modules contain only native translation and SDK
integration:

- Copilot consumes `plugins/` through its marketplace/plugin system; its client
  extension executes deterministic controls directly, while only the
  model-backed `/contract` keeps a skill wrapper and native extension-tool
  preflight;
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

`npm test` is one Node wrapper rather than an npm/`&&` command chain. It rebuilds generated artifacts, removes inherited `NODE_TEST_CONTEXT`, validates each child exit/signal and requires the native runner's TAP summary (`tests > 0`, `fail = 0`), preventing shell propagation quirks, nested-runner state or loaded host code from creating a false green. The suite evaluates all five command contracts across the three runtimes; verifies byte-exact rollback, mutation locking, canonical ownership, idempotency, collisions and leaf/ancestor symlinks; checks remote-body validation, closed tool policies, disposable-session cleanup and double-failure reporting; confirms Copilot/OpenCode discovery; and installs Pi into a temporary home. The agent matrix proves that only the two fixed roles start enabled and all eight roster names are available after `bench on all`.

The literal, closed-schema dataset in `test-ts/fixtures/harbor-cycles.json` is independent from the runtime catalog. It defines the default fixed-role map/build cycle and the opt-in six-companion SDLC cycle. The same cases feed the Copilot hooks and the real OpenCode/Pi delegation tools, while a normalized SDK test proves activation, exact target identity, sequential evidence handoff and cleanup in all three orchestrators. Pi and OpenCode return at most 30,000 UTF-8 bytes of child evidence, with an explicit truncation marker. Optional evidence hooks store only SHA-256 hashes, UTF-8 sizes and correlation metadata—never raw tasks or responses—and are no-ops unless explicitly injected. Events label their basis as observed or inferred, so Copilot's synchronous terminal fallback is not presented as a native cleanup event. These offline tests exercise no model or network. They prove requested routing and lifecycle mechanics; the separate live smoke below proves model-driven selection.

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

The suite also exercises exact dispatch of all eight OpenCode roster IDs, direct Pi invocation of all eight, and native Copilot discovery/selection of all eight. Coordinator tests enforce exact enabled roster targets, per-user-turn bounds, sequential execution, no recursion and cleanup across Copilot, OpenCode and Pi. A delayed-reload race test proves that stale Copilot discovery cannot overwrite a newer root selection event. The suite proves that every distribution can list the bench without a model, that Pi and OpenCode direct controls cannot enter an orchestrator, and that Copilot's lifecycle command and native agent selection emit no assistant message or usage event. The native CLI checks run concurrently in isolated directories. Missing CLIs skip only their runtime assertion; no Python runtime, live model call, API key, Docker service, or network access is required.

## Commands

| Command | Purpose |
| --- | --- |
| `/team` (Copilot, OpenCode, Pi) | Show roster, live work, observed model/usage and stop controls on each native direct surface. |
| `/player <id> <task>` (Copilot) | Run an enabled player directly, including one just joined after `/team member:<id>` reports `ready` and its bound loader is available. |
| `/bench` | List players or set their current-folder state with `on` and `off`. |
| `/join` | Register a recurring player at user level and activate it here. |
| `/retire` | Remove one personal registration and its managed local copy. |
| `/contract` | Run one synchronous, invocation-scoped subagent without registration. |
| `/list-skills` | List trusted GitHub skill references; distinct from built-in `/skills`. |
| `/scout <need>` | Use one restricted recruiter turn to reuse sufficient ready capacity or create and join one missing persistent player. |

The inference budget is part of the executable contract:

| Operation | Required model budget |
| --- | --- |
| View/filter/stop the Copilot, OpenCode, or Pi team; view or change the bench; join; retire | 0 model requests on a direct surface |
| List trusted skills | 0 model requests; authenticated `gh` network I/O is allowed |
| Scout and join a player | One recruiter model session; its roster snapshot, skill filtering and final join are deterministic scoped tools; filtering/join are skipped when a ready teammate already covers the need |
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

Both roster groups have editable Markdown sources:

- `src/core/roles/*.md` contains the two always-active fixed roles;
- `src/core/bundled/*.md` contains the opt-in companion roster shown above.

Each file declares `name`, `description`, `order`, `tools`, and `skills` in
closed JSON frontmatter, while its Markdown body is the prompt. `skills` uses
the same structured references as `/join`; string-name shortcuts are rejected:

```yaml
skills: [{"kind":"repo","name":"local-review","path":"skills/local-review/SKILL.md"}]
skills: [{"kind":"github","name":"zx-example-author","repo":"gvillarroel/zx-harness","path":"skills/zx-example-author/SKILL.md","track":"refs/heads/main"}]
```

`repo` paths are relative to the project where the player runs. GitHub
references must match an exact trusted reference or an exact path under a
trusted repository root. Add or edit a file
and rebuild to change the corresponding roster; duplicate names/orders,
symlinks, unknown fields, duplicate skill references, and untrusted GitHub
skills fail the build or startup closed. Bundled definitions remain
undiscoverable and non-invocable until activated. When activated, they are
rendered directly into the current harness's native agent directory. A batch is
serialized, fully preflighted, written file-atomically, verified, and rolled
back byte-for-byte on failure.

## Personal players

The model-assisted shortcut is:

```text
/scout alguien que escriba scripts en zx para automatizar usando sub agentes
```

`/scout` selects the fixed internal `talent-scout` agent. That agent receives
no filesystem, shell, ambient skill, delegation, contract, or general
lifecycle tools. It receives exactly three scoped tools. First it must inspect
one bounded, path-redacted snapshot of the currently enabled team. Its explicit
model policy says that, if a ready teammate already has a sufficient role, tool
and skill set, it must report that member's direct command and stop without
catalog I/O or roster mutation. The deterministic guard enforces the complete
snapshot, call order, limits, serialization, and terminal state; it does not
receive roster rows or infer semantic sufficiency. Only when the recruiter
judges capacity missing may it filter exact trusted skill references by public
frontmatter metadata, with at most three filter queries, before calling one
closed-schema `join`. A large trusted catalog must first narrow by skill name,
repository, or path to at most 64 metadata candidates; lookup concurrency is
four. The generated player is persistent and otherwise follows the same
validation, ownership, collision, and activation rules as a literal `/join`.

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

Consequently the player is enabled where it joined and remains available from every other project through `bench on reviewer`. `bench off reviewer` removes only the enabled project copy. `retire reviewer` removes the user registration and the managed copy in the current project; copies in other projects remain intentionally untouched.

The Pi and Copilot native join confirmations summarize the ID, role, effective
capacity (tools and skill names), and configured model or host inheritance
without exposing local paths. Pi also reports and registers `/<id> <task>`
immediately in the current session. Copilot reports that the roster transaction
registered the player, directs the user to verify readiness with
`/team member:<id>`, and presents `/player <id> <task>` only as the command to
use once that view says `ready`; the confirmation never treats registration as
proof of native availability. A player can become usable in the same session
after an authoritative refresh when no new bound loader is needed. A skilled
player can do so when its loader was registered at startup; a missing loader or
unverified native discovery requires `/reload`. Copilot's convenience `/<id>`
alias and OpenCode's active-profile alias appear when their configuration
reloads. No separate command file or manual registration is needed.

The canonical profile format uses revision 5 and stores the validated definition
in every harness profile so the adapter can recover and enforce that exact
player's skill group. An exact structural revision-4 profile is recognized only
as legacy owned/stale: it can be repaired explicitly but is never invocable.
Metadata that is neither exact revision 4 nor exact revision 5 is an unmanaged
collision and is never overwritten or deleted.

`skills` accepts at most three references with unique names. A repository
reference points to one exact `SKILL.md` relative to the current project root;
a GitHub reference must match an exact reference or repository root in the
built-in trust policy. A portable
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
names; persistent Copilot profiles expose one no-argument extension tool bound
to the player's complete group. At extension startup only the union required by
skilled fixed roles and canonical active profiles is registered; benched players
do not contribute loaders. Every invocation revalidates the selected agent,
project and managed profile. A skilled player added under a new ID, or under an
ID that had no startup loader, requires `/reload`; a same-ID replacement whose
bound loader already exists does not. OpenCode denies
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

Interactive Copilot `/contract` passes the literal JSON to the extension-owned
`harbor_contract` custom tool—never through shell interpolation. The handler
validates it with shared core code and authenticates the native session, call
ID, tool name and closed arguments. It then seals the exact three-field child
descriptor in the coordinator, and only that successful handler permits
Copilot's native `task` exactly once; later native output cannot authenticate a
descriptor. It never creates a second `CopilotClient`. The programmatic `agent-harbor copilot
contract` entrypoint uses `@github/copilot-sdk` and explicitly deletes its
session. OpenCode and Pi also create and dispose one SDK child. SDK-backed paths
enforce native tool maps; Copilot's built-in `task` profiles can only represent
the requested subset as child policy, not an operating-system sandbox.

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

The project catalog file is loaded only when `/list-skills` runs. A malformed
or oversized catalog therefore reports an error for that command without
blocking `/team`, `/bench`, `/join`, `/retire`, or `/contract`.

Description lookup is capped at 64 skills per command. For larger catalogs,
Agent Harbor applies a supplied name/repository/path filter before requesting
descriptions; an over-broad filter fails with an instruction to narrow it. The
default 70-skill catalog therefore supports filtered description searches
without loading every body. Terminal tables wrap at 96 terminal cells, keeping
ANSI sequences and grapheme clusters intact and counting wide CJK/emoji as two.

Project-controlled catalog visibility is separate from execution trust.
Showing a repository or folder does not authorize its skills unless the
built-in execution policy also names that exact reference or repository root.
The included policy trusts every exact `SKILL.md` on
`refs/heads/main` in the seven gvillarroel repositories that currently contain
skills: `knowledge`, `marketplace`, `pi-menton`, `sdlc`, `skills`,
`slidev-manim`, and `zx-harness`. Each player still names one exact path, and
only that file is copied for that player's invocation. List GitHub catalog
snapshots without downloading their bodies:

```text
/list-skills
/list-skills zx
/list-skills --descriptions zx
```

The unfiltered `/list-skills --descriptions` form is available when the
project-visible catalog contains at most 64 skills. Larger catalogs require a
name, repository, or path filter, as in the example above.

The command uses the developer's authenticated `gh` CLI. It resolves the
configured branch before listing but keeps commit/blob details out of the
compact table.

There are therefore two deliberately separate lists to edit:

- `.agent-harbor/skill-sources.json` in the current project controls what
  `/list-skills` shows and accepts repository, folder, or exact-skill scopes.
- `trustedSkills` and `trustedSkillRepositories` in `src/core/defaults.ts`
  control the exact references and repository roots that may be assigned to a
  player and that `/scout` may return. Changing them requires rebuilding the
  package. A project-local visible repository never becomes executable unless
  it is also one of those built-in trust roots.

## Agents

The two fixed roles are available at startup and are separate from the
opt-in SDLC companions:

- `agent-foundry:team-lead`: derives the smallest sufficient sequence, preferring one specialist and permitting at most six sequential named delegations when distinct stages are necessary.
- `agent-foundry:crafter`: loads only its player-scoped trusted zx skill group on every invocation, then creates a minimal self-contained zx or TypeScript command example.

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
