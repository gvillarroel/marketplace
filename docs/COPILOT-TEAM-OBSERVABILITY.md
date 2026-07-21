# Copilot team observability

The Agent Harbor Copilot extension exposes the roster and current work without
asking a model to summarize either one. `/team [filter]` is a native client
command and labels its output `0 model tokens`. It reads the project-local
roster, session model settings, and an in-memory run registry; it does not send
a prompt, create a child, or write activity history to disk. While work is
active it shows that live hierarchy; only when the project is idle does it add
the most recent mission, regardless of its terminal outcome.

## Commands

| Command | Model work | Purpose |
| --- | --- | --- |
| `/team` | None (`0 model tokens`) | Show lead capacity, SDLC coverage, roster, and live work; when idle, show the last mission. |
| `/team help` or `/team --help` | None (`0 model tokens`) | Explain searchable fields, cancellation syntax, limits, redaction, and process-local history. |
| `/team <filter>` | None (`0 model tokens`) | Search member IDs, descriptions, kind/status, capabilities, tools, skills, model/reasoning, safe task label, or run ID. |
| `/team stop <run-id\|all>` | None (`0 model tokens`) | Request cancellation of one controlled root, the root that owns a supplied child ID, or every controlled root in the current project. |
| `/bench list [filter]` | None (`0 model tokens`) | Show the same enriched roster view, limited by an optional filter; filter text never invokes `/team stop`. |
| `/bench on <id...>` | None (`0 model tokens`) | Activate owned bundled or personal teammates in the current project. |
| `/bench off <id...>` | None (`0 model tokens`) | Deactivate owned bundled or personal teammates in the current project without deleting personal registration. |
| `/join <json>` | None (`0 model tokens`) | Validate and register one personal teammate, write its active project copy, then direct readiness verification to `/team member:<id>`. |
| `/retire <id>` | None (`0 model tokens`) | Remove one owned personal registration and its active copy in the current project; leave active copies in other projects untouched. |
| `/list-skills [--descriptions\|-d] [filter]` | None (`0 model tokens`) | Search trusted, pinned skill snapshots; optionally fetch bounded public descriptions. |
| `/player <id> <task>` | One root | Resolve any currently enabled player whose startup-bound dependencies are available, including a compatible player joined during this session, and run it directly. |
| `/<id> <task>` | One root | Startup alias for fixed, bundled, and already-active personal players. |
| `/scout <capability-needed>` | One recruiter root | Reuse a sufficient ready teammate or, only when capacity is missing, find and join one persistent teammate. |
| `/contract <json>` | One wrapper root and exactly one disposable child | Validate one literal contractor definition, run one native `task`, and persist no contractor definition, profile, or roster membership. |

`/join` reports the registered ID, role, effective capacity (tools and skill
names), configured model or host inheritance, and conditional command forms; it
does not expose registration or active-profile paths. Registration and native
readiness are separate facts. The confirmation directs the user to
`/team member:<id>` and says to run `/player <id> <task>` only when that
authoritative view reports `ready`; it does not claim `ready` or `Run now`
merely because the roster transaction committed. A player can become usable in
the same session when the authoritative roster refresh succeeds and the
definition needs no new native skill loader. The same applies to a skilled
player whose bound `harbor_skill_<id>` loader was already registered at session
startup—for example, a same-ID replacement of a player that started with
skills. Reload is required when that bound loader was absent from the startup
tool union or native discovery cannot establish readiness; `/player` then stops
before model use and says so. A newly introduced convenience `/<id>` alias still
appears after reload. `/retire` removes the owned persistent registration and
active copy in the current project, without printing either managed path.
Active copies previously made in other projects are deliberately outside that
transaction and remain there.
Empty tasks, inactive IDs, unmanaged profiles, double-booking, and capacity
violations stop during preflight, before `session.send`.

The scout's first native tool call is exactly one bounded, path-redacted roster
snapshot. Its explicit recruiter policy requires an enabled ready teammate that
already covers the need to be reported with its direct command, without catalog
filtering or a join; only a model judgment that capacity is missing permits
recruitment. The deterministic guard does not infer that semantic judgment: it
enforces the complete snapshot, ordering, serialization, call budgets, and
terminal state. Queries rank matches but the snapshot remains complete; if more
than 32 specialists or 16 KiB would require truncation, no partial rows are
disclosed and filtering/joining remain fail-closed for that run. Catalogs larger
than 64 metadata candidates must first be narrowed by skill name, repository,
or path, and metadata lookup runs with at most four concurrent requests.
`/player` IDs must be 1–48 characters, start with a lowercase ASCII letter or
digit, and then contain only lowercase letters, digits, or hyphens. The UTF-8
task payload must be at most 30000 bytes. Either limit fails in preflight with
no model call.

An inactive bundled or personal-but-benched player points to `/bench on <id>`.
The repair paths deliberately distinguish three cases:

- `personal-active` stale means that the persistent registration is valid but
  the Agent Harbor-owned active copy in this project needs regeneration;
  `/bench on <id>` repairs that owned copy, followed by a Copilot reload.
- `personal-registration` stale means that the managed registration is missing
  canonical definition data; re-run `/join` with the complete definition and
  `"replace": true`, then reload. Replacement is valid only for Agent
  Harbor-owned files.
- `conflict` is an unmanaged path collision. Inspect and resolve it outside the
  Agent Harbor mutation; Agent Harbor never overwrites or deletes that file.

A missing or retired ID points to `/join` or `/team <id>`; it never suggests
`/bench on` for an identity that no longer exists.

The reload instructions on stale-profile repairs refresh Copilot's native
agent discovery. They are separate from the skill-loader rule above: a roster
mutation by itself does not require a new loader when `harbor_skill_<id>` was
already part of the startup union.

In this document, `enabled`/`ready` describes roster availability. `active`
work means a live root or child in `starting`, `working`, or `cleaning`; an
enabled teammate can be idle, and an enabled teammate with active work is busy.

## What `/team` reports

The roster distinguishes managers, fixed roles, bundled SDLC companions,
personal players, and the recruiter utility. Each row includes readiness,
public description, capabilities, and configured-model information. Lead access
shows which specialists are delegable, busy, benched, stale, or conflicted,
plus the real budget of at most six sequential delegations per mission.
Readiness is cross-checked against Copilot's native agent registry and the
coordinator snapshot. A missing, non-invocable, ambiguous, or unverified native
identity is `unavailable`, never delegable, and includes a reload repair hint.
The first `/team` performs a bounded authoritative refresh and retry when the
startup registry is incomplete. It reports degraded discovery only if that
retry still cannot establish native readiness.
The unfiltered overview is assembled against a dynamic budget of at most 30
wrapped lines and 96 terminal cells per line. It always keeps all nine factory
member IDs with kind and effective state, then spends remaining space on
personal members and activity. Omitted personal members and active runs are
reported with exact counts and actionable `kind:personal`, `member:<id>`, or
`run:<id>` filters. This overview budget is distinct from a filtered view:
`/team <filter>` can retain richer matching detail while every line remains
bounded to 96 cells. The inventory itself is unchanged and remains capped at 32
visible roster rows. A filter with no match still preserves global discovery,
selection-restoration, and lifecycle-identity gates. A degraded or unscoped
view preserves session-global reload guidance without exposing a project-scoped
roster, run ID, or task.

Filters are case-insensitive and field-aware. Unprefixed text uses substring
matching for member/agent ID, description, capacity, configured or observed
model, safe task label, and run ID; kind, roster availability, run state, and
reasoning effort require an exact value. Prefixes make the target explicit:
`tool:`, `capability:`, `skill:`, `model:`, `task:`, `run:`, `id:`/`member:`,
and `description:` use substring matching, while `status:`/`state:`,
`reasoning:`, and `kind:`/`role:` use exact matching. Tool, capability, skill,
and description fields search roster metadata; task, run, and reasoning search
activity; status, model, member, and kind can match either surface.

Lead access separates enabled specialists from those callable at this instant.
`Can delegate now` becomes `none` while a sequential child is active, a direct
non-manager owns the Copilot session, a run is still settling, or selection
restoration is unverified. The view includes the blocking run and repair or wait
action instead of advertising theoretical eligibility as immediate capacity.

Activity is grouped by root mission and child. A run includes a process-local
ID, parent ID when applicable, member, kind, state, elapsed time, a redacted
task label, configured/inherited/currently observed model and reasoning effort,
native usage-event count, token fields, child duration, and child tool-call
count when Copilot provides them. Historical observations are rendered as
additional evidence, never mixed into the current model or reasoning value.
Before native response evidence, `configured` means Copilot's agent registry
declared the model and `inherited` means the run uses the current host setting.
An event emitted by the native run can then establish `observed`; Agent Harbor
does not relabel an unobserved provider/model as observed.
If Copilot's current-model API returns no model, an empty value, `unknown`,
`unknown/default`, or `default`, `/team` renders `no model reported
(unobserved)`. It does not invent `unknown/default` as an effective model.
When no native usage event has arrived, the view says that telemetry has not
been observed yet. When usage events exist without counters, it reports the
event count and that token counters are unavailable. Partial aggregates are
lower bounds rather than invented exact totals.

Usage belongs to the run whose native event produced it. A direct-player root
observes the original `assistant.usage` event once; the extension does not add
the derived coordinator event a second time. Delegated usage belongs to the
child, with root totals computed from the hierarchy only at render time.

A session-wide, saturating ownership ledger retains keyed aliases for native
event, request, provider, upstream-interaction, message, hook, tool-call, and
child identities. It runs before the smaller general replay cache, so cache
rotation, equal or future-skewed timestamps, and delayed events cannot move
model, reasoning, selection, lifecycle, or usage evidence to a later mission.
A separate content-free semantic shape detects events whose stable identity or
optional scope appears, disappears, or changes. Exact proven replays are
ignored; ambiguous identity, owner, scope, or payload transitions fail closed.
The coordinator's ownership and semantic ledgers store only process-keyed
HMACs; raw native identifiers and message, prompt, response, tool-result,
error, reasoning, path, or skill content never enter those ledgers.

The direct `/player` runner has a narrower continuity mechanism: while that one
mission is open, it keeps a bounded in-memory set of namespace-separated
SHA-256 digests of the host's opaque event IDs so only descendants of the
accepted native chain can update or finish the run. Raw event IDs never enter
that ledger. The digests are not rendered, logged, persisted, or shared with
another mission, and the mission-local set becomes unreachable after terminal
settlement. No message, prompt, response, tool result, error body, reasoning,
path, or skill content is retained there.

If ownership cannot be proven or a saturating ledger reaches capacity, the
event is not attributed: no usage call, counter, model, or lifecycle state is
invented. `/team` says that native usage attribution or lifecycle identity is
unverified, marks mission counters incomplete, preserves the last verified run
state, and exposes a selection gate that requires reloading Copilot before more
delegation. A disposable contract with ambiguous native lifecycle evidence
cannot finish successfully. The per-run usage store is separately bounded; at
its capacity, later uncorrelatable events are omitted, retained counts and
counters become explicit `≥` lower bounds, and no old identity is evicted into
a later mission. A usage event with no stable event, request, or provider
identity is also a lower bound: an exact same-run replay is deduplicated, while
cross-run or identity-enriched ambiguity is omitted and triggers the reload
gate instead of being assigned to either member.

The registry is process-local and project-scoped. Project identity is admitted
only after native metadata or lifecycle evidence verifies it. Until then,
`/team` renders an unscoped degraded view and `/team stop` fails closed rather
than reading or cancelling work in `process.cwd()` by assumption. It never
stores prompt, response, tool-result, error-body, or reasoning content. Task
labels are lossy, bounded to 72 Unicode code points, strip terminal controls,
and redact common path, URL, credential, bearer, JWT, and secret patterns. This
is a display safeguard, not a universal secret detector.

## Disposable `/contract` visibility

A valid `/contract` appears as a `utility` root with exactly one `contractor`
child. The root keeps the wrapper's model and usage; the child keeps its native
model, reasoning, usage, duration, and tool-call evidence. Completion, failure,
or cancellation is visible as one mission, but the validated contractor prompt,
descriptor, tool results, and child response are never copied into the
observability registry. Even a prompt containing `/contract` in the middle is
given a generic private task label before the skill event arrives. This also
covers the qualified `/agent-foundry/contract` spelling supported when skill
names collide; a mere textual mention gets the same conservative label but
does not reserve a root or child.

The coordinator accepts only the exact user-invoked `contract` skill provenance
from the `agent-foundry` plugin. It correlates the literal `harbor_contract`
preflight, authenticated structured descriptor, and one native `task` through
keyed opaque hashes. A
changed descriptor, second control call, second or nested `task`, missing child,
capacity failure, or incomplete terminal sequence fails the wrapper root.
Tool-call identity may first appear in either the pre-tool hook or the native
handler invocation, but any later mismatch invalidates the invocation.

Native tool-completion and post-tool hook signals are buffered until the exact
`subagent.completed` or `subagent.failed` terminal arrives. This deliberately
does not assume a relative delivery order among the SDK's documented
[streaming session events](https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/streaming-events).

The skill is explicitly user-invocable and disables model invocation. Its only
`allowed-tools` entry is the exact `harbor_contract` tool; `task` is deliberately
not pre-authorized. The pre-tool hook accepts at most once and only the closed
object `{definition:string}`. The extension handler then authenticates the
session ID, call ID, tool name and arguments before sealing the exact
three-field descriptor. The coordinator returns `allow` for `task` only after
both that hook and handler success; a native completion/result cannot
authenticate the descriptor, and a similarly named third-party tool cannot
claim it. A suspected contract prompt without that provenance denies `task`
fail-closed. This matches GitHub's documented
[allowed-tool behavior](https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli/allowing-tools)
and [pre-tool hook contract](https://docs.github.com/en/copilot/how-tos/copilot-sdk/hooks/pre-tool-use).

## Lifecycle and cleanup guarantees

Direct player commands serialize changes to Copilot's selected agent. The
extension captures the prior selection, attaches terminal and usage listeners,
selects the exact validated agent, and calls `session.send` once. A normal
`session.idle` completes the run, an aborted idle cancels it, and
`session.error` fails it. `session.shutdown` with `shutdownType: "error"` also
fails; every other shutdown type cancels. The previous selection is then
restored and the coordinator snapshot refreshed.

Terminal events that arrive while `session.send` is still being accepted wake
the terminal wait and are reconciled immediately after acceptance. Errors and
shutdowns remain strong terminal evidence; an early idle is accepted only
after native activity and processing state both confirm that Copilot is idle.
The same reconciliation runs on acceptance timeout and after abort, so an
already-seen terminal cannot leave selection pinned forever. A queued stop is
checked in the same synchronous callback that invokes `session.send`,
eliminating the last pre-send scheduling gap.

If the run exceeds the configured timeout, the extension requests abort and
waits for a bounded settlement period. If Copilot still emits no terminal
event, selection remains intentionally pinned and another player command is
rejected until the late terminal event arrives. This avoids attributing an
active response to a different selected player. Execution and restoration
failures are preserved together in an `AggregateError`. If restoration cannot
be proven, `/team` marks lead delegation unverified until the Copilot session is
reloaded; it does not continue to advertise the roster as safely delegable.
`cancelling` is not a visible `/team` state. The coordinator may receive that
native lifecycle value, but the extension normalizes it to the single visible
`cleaning` state. An identity-ambiguous event does not by itself move a run to
`cleaning`: `/team` retains the last verified state and shows the reload gate.
`cleaning` appears only after a real abort, terminal teardown, or restoration
begins.

`/team stop` requests cancellation; it does not claim that Copilot has already
stopped. Supplying a child run ID resolves and aborts its owning root. The root
and descendants remain active as `cleaning` until a verified terminal event
produces `completed`, `failed`, `cancelled`, or `cleanup-error`; selection stays
gated throughout that interval.

For `team-lead`, the coordinator emits content-minimized, redacted lifecycle
metadata correlated to native session, turn, tool-call, and child IDs. The
extension admits a child against the same project registry before Copilot starts
the native `task`, so a persistent player cannot be double-booked through direct
and delegated paths. Observer failures never change the delegation decision.

Before every native `task` decision, the guard reads Copilot's current agent.
Third-party agents remain untouched. A manually selected `team-lead` is guarded
even when its selection event is delayed; its registry is refreshed and the
exact selection revalidated before delegation. An unverifiable current agent
fails closed for that task. Overlapping registry refreshes use a generation so
an older completion cannot overwrite a newer snapshot. Contiguous successful
tool completion and session-idle events finalize the child before the root.
The interactive `/team` handler shares one bounded deadline across discovery,
refresh, rendering, and display; a late host call produces a useful degraded
snapshot instead of extending the command indefinitely.

## Validation

The offline suite covers redaction, private usage deduplication, lower-bound
accounting, project isolation and fail-closed scope discovery, hierarchy,
cancellation, 32-root capacity, double-booking, lifecycle correlation,
admission recovery, terminal races, bounded rendering, first-discovery
recovery, literal `/bench list` filters, selection-restore hazards, delayed
model/reasoning events, session-wide replay ownership, cache rotation, clock
skew, identity enrichment/loss, optional-scope drift, truthful no-match gates,
zero-token help, and generated-runtime byte equality. `/contract` regressions
cover both native task-event orders, pre-tool identity, cross-mission replay,
privacy, exact-one child admission, second-child ambiguity, nested-task denial,
terminal outcomes, selected-root relabeling, and extension-to-render behavior.
The native Copilot SDK smoke starts the
installed CLI with `--plugin-dir`, exercises `/team`, `/team <filter>`,
`/bench list <filter>`, `/join`, `/retire`, and invalid `/player` preflight, and
compares usage counters before and after; it performs no model call.

Installed-copy drift is an opt-in release check:

```shell
npm run test:installed:copilot
npm run test:installed:copilot:smoke
```

The first command compares the installed plugin against this checkout. The
second also exercises native discovery. A drift failure means the installed
copy must be updated before its behavior can be treated as release evidence.
