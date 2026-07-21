# Copilot team observability

The Agent Harbor Copilot extension exposes the roster and current work without
asking a model to summarize either one. `/team [filter]` is a native client
command and labels its output `0 model tokens`. It reads the project-local
roster, session model settings, and an in-memory run registry; it does not send
a prompt, create a child, or write activity history to disk.

## Commands

| Command | Model work | Purpose |
| --- | --- | --- |
| `/team` | None | Show lead capacity, SDLC coverage, active work, roster, and the last mission, regardless of outcome. |
| `/team help` or `/team --help` | None | Explain searchable fields, cancellation syntax, limits, redaction, and process-local history. |
| `/team <filter>` | None | Search member IDs, kind, status, capability, model, safe task label, or run ID. |
| `/team stop <run-id\|all>` | None | Abort one controlled root or every controlled root in the current project. |
| `/bench [list [filter]]` | None | Show the same enriched roster view, limited by an optional literal filter; filter text never invokes `/team stop`. |
| `/player <id> <task>` | One root | Resolve any currently active player, including one joined during this session, and run it directly. |
| `/<id> <task>` | One root | Startup alias for fixed, bundled, and already-active personal players. |
| `/contract <json>` | One wrapper root and exactly one disposable child | Validate one literal contractor definition, run one native `task`, and persist no contractor definition, profile, or roster membership. |

`/join` reports only the joined ID, role, capacity, and the two usable command
forms; it does not expose registration or active-profile paths. It activates a
personal player immediately. Use `/player <id> <task>` in the same session;
restart Copilot before using the convenience `/<id>` alias. `/retire` confirms
the project-local retirement without printing managed paths. Empty tasks,
inactive IDs, unmanaged profiles, double-booking, and capacity violations stop
during preflight, before `session.send`.

An inactive bundled or personal-but-benched player points to `/bench on <id>`.
A stale or conflicted personal player points to `/team <id>` and an owned
replacement join. A missing or retired ID points to `/join` or `/team <id>`;
it never suggests `/bench on` for an identity that no longer exists.

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
Large rosters render at most 32 rows; `/team <filter>` narrows the complete
inventory without changing it. A filter with no match still preserves global
discovery, selection-restoration, and lifecycle-identity gates. A degraded or
unscoped view preserves session-global reload guidance without exposing a
project-scoped roster, run ID, or task.

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
All correlations are process-keyed HMACs. Raw native identifiers and message,
prompt, response, tool-result, error, reasoning, path, or skill content never
enter these ledgers.

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
from the `agent-foundry` plugin. It correlates the literal MCP preflight,
structured descriptor, and one native `task` through keyed opaque hashes. A
changed descriptor, second control call, second or nested `task`, missing child,
capacity failure, or incomplete terminal sequence fails the wrapper root.
Control-call identity may first appear in either the pre-MCP hook or the native
execution event, but any later mismatch invalidates the invocation.

Native tool-completion and post-tool hook signals are buffered until the exact
`subagent.completed` or `subagent.failed` terminal arrives. This deliberately
does not assume a relative delivery order among the SDK's documented
[streaming session events](https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/streaming-events).

The skill is explicitly user-invocable and disables model invocation. Its only
`allowed-tools` entry is the exact `agent-harbor(control)` tool; `task` is
deliberately not pre-authorized. The coordinator leaves provisional control
permission unchanged instead of granting a similarly named third-party tool,
then returns `allow` for `task` only after the exact skill provenance, MCP
server, tool, arguments, execution identity, and structured descriptor have
all authenticated. A suspected contract prompt without that provenance denies
`task` fail-closed. This matches GitHub's documented
[allowed-tool behavior](https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli/allowing-tools)
and [pre-tool hook contract](https://docs.github.com/en/copilot/how-tos/copilot-sdk/hooks/pre-tool-use).

## Lifecycle and cleanup guarantees

Direct player commands serialize changes to Copilot's selected agent. The
extension captures the prior selection, attaches terminal and usage listeners,
selects the exact validated agent, and calls `session.send` once. A normal
`session.idle`, aborted idle, or `session.error` settles the run. The previous
selection is then restored and the coordinator snapshot refreshed.

Terminal events that arrive while `session.send` is still being accepted are
buffered. Errors remain terminal; an early idle is accepted only after native
activity and processing state both confirm that Copilot is idle. The same
reconciliation runs on acceptance timeout and after abort, so an already-seen
terminal cannot leave selection pinned forever. A queued stop is checked in
the same synchronous callback that invokes `session.send`, eliminating the
last pre-send scheduling gap.

If the run exceeds the configured timeout, the extension requests abort and
waits for a bounded settlement period. If Copilot still emits no terminal
event, selection remains intentionally pinned and another player command is
rejected until the late terminal event arrives. This avoids attributing an
active response to a different selected player. Execution and restoration
failures are preserved together in an `AggregateError`. If restoration cannot
be proven, `/team` marks lead delegation unverified until the Copilot session is
reloaded; it does not continue to advertise the roster as safely delegable.
An identity-ambiguous event does not by itself claim that a run is cancelling
or cleaning: `/team` retains the last verified state and shows the reload gate.
Those action states appear only after a real abort or cleanup begins.

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
cover both native task-event orders, pre-MCP identity, cross-mission replay,
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
