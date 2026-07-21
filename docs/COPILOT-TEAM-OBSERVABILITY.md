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
| `/team <filter>` | None | Search member IDs, kind, status, capability, model, safe task label, or run ID. |
| `/team stop <run-id\|all>` | None | Abort one controlled root or every controlled root in the current project. |
| `/bench [list [filter]]` | None | Show the same enriched roster view, limited by an optional literal filter; filter text never invokes `/team stop`. |
| `/player <id> <task>` | One root | Resolve any currently active player, including one joined during this session, and run it directly. |
| `/<id> <task>` | One root | Startup alias for fixed, bundled, and already-active personal players. |

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
inventory without changing it.

Activity is grouped by root mission and child. A run includes a process-local
ID, parent ID when applicable, member, kind, state, elapsed time, a redacted
task label, configured/inherited/observed model and reasoning effort, native
usage-event count, and token fields. Missing native fields display as unknown; partial
aggregates are lower bounds rather than invented exact totals.

The registry is process-local and project-scoped. It never stores prompt,
response, tool-result, error-body, or reasoning content. Task labels are lossy,
bounded to 72 Unicode code points, strip terminal controls, and redact common
path, URL, credential, bearer, JWT, and secret patterns. This is a display
safeguard, not a universal secret detector.

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
failures are preserved together in an `AggregateError`.

For `team-lead`, the coordinator emits content-minimized, redacted lifecycle
metadata correlated to native session, turn, tool-call, and child IDs. The extension admits a child
against the same project registry before Copilot starts the native `task`, so a
persistent player cannot be double-booked through direct and delegated paths.
Observer failures never change the delegation decision.

Before every native `task` decision, the guard reads Copilot's current agent.
Third-party agents remain untouched. A manually selected `team-lead` is guarded
even when its selection event is delayed; its registry is refreshed and the
exact selection revalidated before delegation. An unverifiable current agent
fails closed for that task. Overlapping registry refreshes use a generation so
an older completion cannot overwrite a newer snapshot. Contiguous successful
tool completion and session-idle events finalize the child before the root.

## Validation

The offline suite covers redaction, private usage deduplication, lower-bound
accounting, project isolation, hierarchy, cancellation, 32-root capacity,
double-booking, lifecycle correlation, admission recovery, terminal races,
bounded rendering, first-discovery recovery, literal `/bench list` filters, and
generated-runtime byte equality. The native Copilot SDK smoke starts the
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
