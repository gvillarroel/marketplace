# Copilot team observability

The Agent Harbor Copilot extension exposes the roster and current work without
asking a model to summarize either one. `/team [filter]` is a native client
command and labels its output `0 model tokens`. It combines the project-local
roster and session model settings with two activity layers: rich run telemetry
and history held by this Copilot process, plus private filesystem claims for
named persistent players shared project-wide with Pi and other Copilot
processes. `/team` itself does not send a prompt, create a child, or write
activity history. Copilot CLI 1.0.73
marks extension SDK commands unavailable while an agent turn is active. During
that interval Agent Harbor instead posts bounded, debounced, content-free live
progress to the session timeline. `Esc` is the native live interrupt/stop
control; `/team` becomes available again after settlement. When callable,
`/team` shows the current hierarchy; only when the project is idle does it add
the most recent mission, regardless of its terminal outcome.

## Commands

| Command | Model work | Purpose |
| --- | --- | --- |
| `/team` | None (`0 model tokens`) | After an active TUI turn settles, show lead capacity, SDLC coverage, roster, work, and the last mission. |
| `/team help` or `/team --help` | None (`0 model tokens`) | Explain searchable fields, host command gating, native Escape control, limits, redaction, and process-local history. |
| `/team <filter>` | None (`0 model tokens`) | Search member IDs, descriptions, kind/status, capabilities, tools, skills, model/reasoning, safe task label, run ID, or the disclosed owner runtime/PID of a shared row. |
| `/team stop <run-id\|all>` | None (`0 model tokens`) | Idle/RPC control that requests cancellation of one controlled root, the root owning a supplied child ID, or every controlled project root. The active TUI uses `Esc`. |
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
transaction and remain there. A startup alias is blocked immediately but can
remain visible in slash-command completion/autocomplete until `/reload`.
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
work means a live root or child in `starting`, `working`, `waiting`, or
`cleaning`; an
enabled teammate can be idle, and an enabled teammate with active work is busy.

## Live TUI progress

The extension consumes native lifecycle, model, reasoning, usage, and billing
events while Copilot is working. It emits root and child starts immediately,
coalesces prompt acceptance and the matching native root-start into one startup
record, debounces subsequent event bursts to one per configured interval, and
never emits more than twelve live progress records per root. Each record uses
only the public process-local root/run IDs, agent, state, elapsed time, and
model, reasoning, native-token, or nano-AIU fields that Copilot has actually
reported. It never includes the prompt, task label, response, reasoning body,
tool input/output, error body, native IDs, paths, URLs, or credentials.

The first record explains the native controls in full: progress is automatic,
`Esc` interrupts or stops agents, and `/team` returns after settlement. Later
records use only a compact one-line `Esc`/`/team` reminder. Terminal child/root
messages remain prioritized in the bounded notification queue. This timeline
is observability only; it does not send an assistant message, prompt a model,
or consume model tokens.

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
Every visible `/team` result is assembled against a total budget of at most 30
wrapped lines and 96 terminal cells per line. The unfiltered overview always
keeps all nine factory member IDs with kind and effective state, then spends
remaining space on personal members and activity. Omitted personal members and
active runs are reported with exact counts and actionable `kind:personal`,
`member:<id>`, or `run:<id>` filters. SDK, host, degraded-authority, and repair
blocks appended by the extension consume that same total 30-line budget rather
than expanding it.
A filtered view spends the same total budget differently: each compact locally
owned activity row retains the full public agent/run IDs, elapsed time, safe
task label, complete effective model and reasoning provenance, and token total.
A row imported from the shared persistent-player registry deliberately omits
those process-local fields while retaining elapsed time and owner routing.
`/team <filter>` can retain richer matching detail within the same 30×96 bound.
The inventory itself is unchanged and remains capped at 32 visible roster rows.
A filter with no match still preserves global discovery,
selection-restoration, and lifecycle-identity gates. A degraded or unscoped
view preserves session-global reload guidance without exposing a project-scoped
roster, run ID, or task.

Footer commands are grouped by purpose before wrapping, so no continuation line
starts with an orphan `·` separator. Help consistently uses `—` between each
primary `/team` form and its explanation.

Filters are case-insensitive and field-aware. Unprefixed text uses substring
matching for member/agent ID, description, capacity, configured or observed
model, safe task label, and run ID; kind, roster availability, run state, and
reasoning effort require an exact value. Prefixes make the target explicit:
`tool:`, `capability:`, `skill:`, `model:`, `task:`, `run:`, `id:`/`member:`,
and `description:` use substring matching, while `status:`/`state:`,
`reasoning:`, `kind:`/`role:`, `owner:`, and `pid:` use exact matching. Tool, capability, skill,
and description fields search roster metadata; task, run, and reasoning search
activity; status, model, member, and kind can match either surface. `owner:pi`,
`owner:copilot`, and `pid:<pid>` search only the public routing fields of an
external shared row and do not trigger an “undisclosed telemetry” warning.
An external `shared-*` row is searchable only through fields it actually
discloses (player/run alias, kind, state, shared activity kind, and owner
runtime/PID routing). Task, model, and reasoning filters never match “not disclosed”
placeholders. The result instead counts external active rows that could not be
evaluated and explicitly says that matching covered disclosed fields only.

Lead access separates enabled specialists from those callable at this instant.
`Can delegate now` becomes `none` while a sequential child is active, a direct
non-manager owns the Copilot session, a run is still settling, or selection
restoration is unverified. The view includes the blocking run and repair or wait
action instead of advertising theoretical eligibility as immediate capacity.

Locally owned activity is grouped by root mission and child. A local run
includes a process-local ID, parent ID when applicable, member, kind, state,
elapsed time, a redacted task label, configured/inherited/currently observed
model and reasoning effort, native usage-event count, token fields, child
duration, and child tool-call count when Copilot provides them. Historical
observations are process-local and rendered as additional evidence, never mixed
into the current model or reasoning value.

Named persistent-player roots and children also hold one project-shared claim.
A version-2 claim exposes only the player, direct/delegated kind, phase, start
time, owner runtime `pi|copilot`/PID, and an opaque public `shared-<player>` row
to another Pi or Copilot process. Version-1 claims remain readable and retain a
known PID, but identify the owner runtime as unverified because that field is
absent. The other process does not receive the task label, model,
reasoning, usage, native IDs, hierarchy, claim token/path, or stop capability.
The compact row retains the full player ID, elapsed time, and the exact owner
routing hint. It marks the claimed player busy while
leaving unrelated specialists eligible; a remote claim does not falsely claim
Copilot's single-session selection gate.
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

The rich runtime and its terminal history remain process-local and
project-scoped. Persistent-player claims use the canonical physical project
identity under the stable per-user Agent Harbor activity root, in a namespace
shared only by Pi and Copilot activity. A capacity lock serializes admission up
to 32 active persistent claims per project. Publication, phase changes, and
release are verified against the exact filesystem generation; this coordination
is not a privilege boundary against hostile code running as the same OS user.
A v2 `opencode` owner in this namespace is malformed and degrades authority;
OpenCode activity uses its separate native namespace.

If exact ownership or release fails, Copilot retains a project-scoped hazard
after the local run settles. Aliases, native-selected work, coordinator roots
and children, and late lifecycle observations all fail before another model
lookup or prompt send. The hazard clears only when release of that exact claim
generation succeeds (or the extension reloads into clean state); `/team` keeps
the gate and repair visible meanwhile.

A heartbeat-overdue claim remains visible, busy, and capacity-counted while its
owner PID is not definitely absent. It therefore continues to block admission;
the owning process must recover or restart. A later admission may reclaim it
only after the PID is definitely absent and a second exact identity/token/mtime
read still matches. Malformed, ambiguous, or unreadable claim state makes
activity authority unavailable. `/team` then reports only a `≥` lower bound of
process-visible activity, marks persistent availability unverified, preserves
the warning on a filter miss, and closes selection/delegation instead of turning
missing rows into `ready` or “nobody is working.”

Inventory reads and admission sweep definitely-dead overdue generations under
the same capacity lock, after validating the bounded directory inventory. The
capacity-lock file is transient metadata rather than one of the 64 bounded
claim/foreign entries, so a full 64-claim dead inventory can be reclaimed but a
sixty-fifth non-lock entry still fails closed. Dead overdue locks use the same
exact double-read recovery; live, ambiguous, or possible PID-reuse owners remain
busy/unavailable and are never reclaimed automatically.

Project identity is admitted only after native metadata or lifecycle evidence
verifies it. Until then, `/team` renders an unscoped degraded view and `/team
stop` fails closed rather than reading or cancelling work in `process.cwd()` by
assumption. Neither activity layer stores prompt, response, tool-result,
error-body, or reasoning content. Local task labels are lossy, bounded to 72
Unicode code points, strip terminal controls, and redact common path, URL,
credential, bearer, JWT, and secret patterns. This is a display safeguard, not
a universal secret detector.

## Disposable `/contract` visibility

A valid `/contract` appears as a `utility` root with exactly one `contractor`
child. The root keeps the wrapper's model and usage; the child keeps its native
model, reasoning, usage, duration, and tool-call evidence. Completion, failure,
or cancellation is visible as one mission, but the validated contractor prompt,
descriptor, tool results, and child response are never copied into the
observability registry. Both wrapper and anonymous child telemetry are
process-local and never enter the shared persistent-player claim count. Even a
prompt containing `/contract` in the middle is
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

`/team stop` is retained for idle and programmatic/RPC use; Copilot CLI 1.0.73
does not let the TUI invoke that SDK command during an active agent turn. The
native live control is `Esc`. When `/team stop` is callable, it requests
cancellation and does not claim that Copilot has already stopped. Supplying a
child run ID resolves and aborts its owning root. The root
and descendants remain active as `cleaning` until a verified terminal event
produces `completed`, `failed`, `cancelled`, or `cleanup-error`; selection stays
gated throughout that interval.

Rows named `shared-<player>` are ownership notices, not remote control handles.
Only the Pi or Copilot process holding the exact claim and native abort handle
can stop that work. A targeted or `all` stop reports remote matches as owned by
the exact displayed runtime/PID; a legacy claim keeps its known PID and marks
only the runtime as unverified. If the shared claim inventory cannot be read
authoritatively, Copilot's `/team stop` fails closed before claiming that all
project work was inspected. Mass-stop output remains inside the same
30-line/96-cell budget, counts omitted detail, and points back to `/team` for
inspection. `Esc` likewise controls only work owned by this Copilot session.

For `team-lead`, the coordinator emits content-minimized, redacted lifecycle
metadata correlated to native session, turn, tool-call, and child IDs. The
extension admits a child against the same project registry before Copilot starts
the native `task`, so a persistent player cannot be double-booked through direct
and delegated paths, including work owned by another Pi or Copilot process.
Non-authoritative telemetry observer failures never change the delegation
decision; shared activity admission and ownership checks are safety gates and
fail closed.

The direct `/player`/`<id>` runner publishes a `starting` claim only after a
final live player-definition check—and, for manager/recruiter roots, a final
roster-snapshot check—under the cross-process capacity gate. Coordinator
admission also claims a named root or child before its native `task` and
revalidates the current persistent definition. The exact generation is verified
again when work becomes `working` or `cleaning` and on later local runtime
updates. Losing it after admission marks the run `cleanup-error` and requests a
native root abort; failure to remove the exact claim at settlement is reported
as unverified cleanup and leaves future admission fail-closed.

Destructive roster changes (`bench off`, `retire`, and same-ID replacement)
share that cross-process gate with new admissions. A specialist claim protects
that specialist; a `team-lead` or `talent-scout` claim protects the roster
snapshot it may be using. A scout may exclude only its own exact claim token
while committing its scoped mutation. Store or gate ambiguity rejects the
mutation rather than racing it against persistent work.

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
Cross-process coverage in `test-ts/shared-runtime-activity.test.ts` exercises Pi
and Copilot physical-project convergence, double-booking, destructive-mutation
gates, heartbeat-overdue visibility, owner-only stop guidance, release, and
truthful degraded authority.
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
