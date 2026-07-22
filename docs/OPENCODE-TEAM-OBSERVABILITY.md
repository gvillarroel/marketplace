# OpenCode team observability

Agent Harbor's OpenCode TUI target provides a native `/team` control. It reads
OpenCode state directly and does not send a prompt, create a model session, or
create a child. Every view and stop result therefore declares `0 model tokens`.
The TUI registers nine direct palette entries: `/team`, three bench controls,
join, retire, two skill-catalog controls, and `/contract`. The first eight are
deterministic and zero-model; `/contract` performs deterministic preflight and
then creates exactly one disposable model child. The server configuration does
not publish model-routed lifecycle fallbacks or an ambient generic `harbor`
tool. During upgrade it removes only exact legacy fallback aliases and
preserves foreign commands.

These host behaviors were source- and manually revalidated against OpenCode
1.18.4 (`v1.18.4`, commit `49c69c5ed3ccf706b61b3febb43c8aaff7f8325e`).
Agent Harbor remains compiled against the exact `@opencode-ai/plugin@1.18.3`
SDK; the relevant routes, run engines, generated client shapes, and TUI
transport did not change between those versions.

## Using `/team`

Choose `/team` from OpenCode's slash palette. Because the TUI callback does not
receive slash arguments, Agent Harbor opens a prompt. There is no separate
`/team stop ...` slash form; enter one of the following in that prompt:

- nothing, to show a compact whole-team overview and active work; the nine
  factory IDs, kinds, and effective states always fit, while additional
  personal members are bounded with an explicit narrowing notice;
- a filter such as `status:working`, `kind:personal`, `member:crafter`,
  `tool:read`, `skill:<name>`, `model:<text>`, `task:<text>`, or a public run ID;
- `help` for the command and safety contract;
- `diagnostics` or `warnings`, optionally followed by a page number, for every
  current sanitized degradation reason and its repair action;
- `stop <run-id>` to stop one displayed run, or `stop all` to stop
  every verified Agent Harbor run in the current project.

The result is a persistent, wrapped dialog rather than a short-lived toast.
Because OpenCode 1.18.4 alerts do not scroll, every `/team` result—including
filters, diagnostics, help, and mass stop—uses a 30-wrapped-line budget at 96
columns that fits the actual dialog viewport. Broad matches use compact rows;
narrow `member:<id>` and `run:<run-id>` filters retain rich details. Any omission
includes its count and an actionable narrower filter. Roster and skill tables
use the same path-free, control-free projection.
Static help reserves its final footer for the privacy contract even when foreign
slash-command collisions expand the safety guidance. If topics must be omitted,
the notice is help-specific and never suggests a member/run filter that cannot
recover static help text.

## What the view means

The roster separates a member's class (`manager`, fixed, bundled, personal, or
utility) from its availability. `ready · invocable` means both the managed
roster and this session's loaded OpenCode configuration expose the agent.
`enabled · reload required` means the roster commit succeeded but this session
has not loaded it for native selection or its `/<id>` convenience alias. The
lead's live roster can still discover and delegate to that enabled member before
reload, subject to its normal authoritative activity/model preflight. Other
states are `bench`, `stale`, `conflict`, and `unavailable`; the last is used for
the six statically known bundled identities when a degraded inventory read
cannot prove their effective lifecycle state. A member with verified active
work is shown as busy in the activity section. Personal members and enabled
bundled specialists are read from the same ownership-checked lifecycle backend
used by the CLI.

Availability is asserted only while active discovery is authoritative. If
either activity registry, claim inventory, ownership proof, or roster authority
is degraded, the summary reports visible activity as a lower bound with `≥`,
marks inactive roster rows as activity/availability unverified, and blocks lead
delegation. An empty activity section does not claim that nobody is working,
and a filtered no-match does not prove absence or idleness. The overview shows
one bounded warning plus a count. Open `/team` and enter `diagnostics [page]` or
`warnings [page]` to expose every current sanitized reason and repair action
within the same 30-line/96-column safety boundary.

The lead receives a complete roster only up to 32 enabled specialists. A larger
roster is never truncated into apparent authority: lead access is blocked, the
excess is reported, and `/bench-off <id...>` is the direct repair before retrying
delegation.

Cross-isolate filesystem claims bridge the server plugin and TUI without
publishing session IDs, claim tokens, filesystem paths, tasks, or provider
metadata. A direct invocation publishes `starting` and then `working`. It uses
`cleaning` only while fail-closed reconciliation cannot tie a session-scoped
terminal to the current message generation; a later native busy event restores
`working`. A delegated invocation publishes `starting` against its
owner session, but that phase has no public run ID and is not stoppable. Only
after the disposable child identity is published and read back does it become
`working` and stoppable; `cleaning` is reserved for that delegated child while
its deletion is in progress. Delegated lifecycle phases are monotonic, and the
child identity cannot be retargeted after `starting`. If a direct run cannot publish
and read back `working`, the hook rejects it and verifies claim release instead
of continuing with misleading activity. Claims owned by another OpenCode OS
process are visible as busy but can be stopped only from that process.

If a direct turn loses its exact claim after admission, the server first
re-establishes a `cleaning` recovery generation when possible and requests a
native abort. A competing generation remains the fence if it already won the
slot. Unknown abort outcome keeps recovery blocked instead of allowing two
processes to use the same persistent teammate.

The server/plugin preflight uses OpenCode's injected v1 client: bounded
`session.status` first, then `session.messages` only for non-idle sessions. It
accepts `busy` and valid `retry` states, excludes the caller session, inspects at
most 32 activities and eight messages per session with concurrency four, a
750 ms per-RPC deadline, and a 1.8 s total deadline. The TUI joins that scoped
legacy status registry with v2 `session.list` and global `session.active`, then
uses the GET/message API owned by each observed runner. Current Harbor direct
commands and disposable children are legacy `SessionRunState`; work observed
only in v2 remains v2-owned. Missing or malformed telemetry fails closed
instead of permitting double-booking.

Active work is grouped as direct, delegated, or contract work. An observed
native parent is used when available; otherwise a disposable child may be
shown under the only active direct `team-lead`, explicitly marked as inferred.
Every compact activity entry keeps the public run ID, current state, redacted
task label, observed model, labelled token total, and observed cost; narrow
filters expose the component breakdown and provenance. If an observed model
identity would consume the overview budget, the compact row marks it
`(abbreviated)` and gives the exact `/team run:<run-id>` route; the run detail
retains the complete sanitized provider/model/variant identity. The formatter
never silently truncates it.
OpenCode does not provide Agent Harbor with a reliable terminal history, so the
view reports active work rather than inventing completed missions.

The host's configured default model is shown when it can be parsed safely,
including matching context/output limits. A run model and variant are shown
only after native telemetry observes them. Missing model, usage, or cost fields
remain `unobserved`; an explicit native zero remains zero, while any finite
nonzero observed cost keeps enough precision that it cannot be rendered as
`$0`. Reported context or
max-output values are observations, not an Agent Harbor hard token cap.

For a direct run, tokens and cost cover only assistant messages after the
current user/agent-switch boundary. For a signed disposable child, they cover
the observed child session. Truncated or numerically bounded data is marked as
a lower bound with `≥`; it is never presented as an exact total. OpenCode v2
assistant messages can publish a native `tokens.total`, which takes precedence
and is labelled `native total`. The session aggregate has no native total, so
Agent Harbor labels its own addition as `observed component sum`; a mixture is
labelled `combined native/component total`. Because reasoning may be included
inside output or reported beside it, a native total is contradictory only when
it falls outside both interpretations, and the view marks that component
conflict instead of silently replacing the host value. If one assistant omits
a field that another reports, that field is a lower bound; explicit zero still
counts as an observation. A reused direct session never supplies a stale
session-level model when the current turn has not observed one.

## Ownership and privacy boundary

Agent Harbor proves a disposable child with a title signed by a private
per-user HMAC key. The title claim binds invocation kind, agent, exact native
session ID, and normalized project. The key is published atomically with
private file permissions and read through a bounded, no-follow identity check.
A copied, tampered, legacy, or cross-project title proves nothing and is
omitted.

The separate activity claim is stored below a stable per-user Agent Harbor
runtime root (`~/.agent-harbor` by default, or `AGENT_HARBOR_ACTIVITY_HOME` when
explicitly set), not below `OPENCODE_CONFIG_DIR`. Its private project directory
is keyed by the canonical physical-project identity, so the same repository
shares claims across symlink spellings and OpenCode processes with different
configuration homes. Publication writes and syncs a complete
private temporary file, links it atomically into place, verifies directory and
file device/inode identity plus the exact token and generation, and then removes
the temporary link. Heartbeats keep a live claim fresh; TTL alone never permits
reclamation. A stale claim is removed only after the owner PID is definitely
absent and an exact token/inode/mtime re-read still matches. Directory swaps,
symlinks, unexpected entries, extra hardlinks, malformed data, or an abandoned
publication artifact fail closed and require explicit inspection.
A bounded inventory read takes the same capacity lock before reclaiming dead
claims. It validates at most 64 non-lock entries first, then removes only
heartbeat-overdue generations whose PID is definitely absent and whose second
PID/token/inode/mtime read is unchanged. The transient exact capacity-lock file
does not consume one of those 64 inventory slots, so 64 dead claims cannot wedge
admission or `/team`; a sixty-fifth claim/foreign entry still fails closed.
A heartbeat-overdue claim whose PID is not definitely absent remains visible
as busy and counts against admission. `/team` marks it degraded and disables
claim-based stop until the owning OpenCode process recovers or restarts; it
never advertises the teammate as ready merely because freshness expired.

Admission to the 32-run project limit is serialized by a second private,
atomically published capacity lock, so simultaneous isolates cannot each pass a
stale count. Contenders wait only to a bounded deadline. Its stale recovery also
requires an absent owner PID and an unchanged token/inode/mtime generation.
Ordinary inventory reads recover an overdue lock owned by a definitely exited
PID through that same exact cleanup; a live, ambiguous, or possibly reused PID
is never stolen.
Claim release is verified: if the exact canonical generation cannot be removed,
the server reports a filesystem-recovery failure instead of pretending cleanup
succeeded. The private stop/recovery inventory retains every generation within
the 64-entry directory bound rather than slicing at the 32-live-claim cap, so a
terminal check cannot mistake a still-present exact generation for absence.
More than 32 claims that still count as live fails closed.

This protects cooperation between OpenCode isolates and ordinary processes of
the same account; it is not a privilege boundary against a hostile process
running as that same OS user. The implementation depends on Node filesystem
path and identity operations, and Windows does not expose the same Unix mode
semantics. Do not share that account with mutually hostile workloads; the
stable runtime root is user state, not a security boundary. No MCP server,
transport, helper daemon, or network service participates in these claims.

A direct run normally binds the exact filesystem claim to its session; stop
separately re-proves the current turn boundary. For a discovered direct session
that has no such claim, the fallback proof
requires the raw `SessionV2Info.agent` to match an ownership-verified,
non-conflicting roster member exactly. This distinction matters because
OpenCode can leave that raw field on its base agent while a custom slash command
is streaming. Historical assistant messages never establish ownership. Agent
Harbor reads messages only after one of these session-level proofs succeeds.

The message parser projects only IDs, time, agent/model identity, numeric usage,
cost, and bounded user text needed for a safe task label. Legacy text parts must
also bind their own bounded ID, session ID, and message ID to the authorized
`info` record before any text is retained. It never retains or
renders assistant prose, reasoning, tool input/output, snapshots, or native
errors. Paths, URLs, common credentials, and token shapes are redacted from
public labels. Redaction is heuristic, so source text is neither persisted nor
treated as safe merely because it was filtered.

Native OpenCode session IDs are always private. `/team` publishes a stable
`run-<digest>` alias with no native prefix; filters and stop results use that
alias. The exact direct-turn boundary is also represented only by a SHA-256
digest. Configuration provider keys, environment variables, and options are
never copied into the view.

The server tools used by the lead, scout, and skill loader apply the same
bounded public-error boundary. SDK, GitHub, and loader failures keep actionable
redacted text and `AbortError` cancellation semantics, but never expose the raw
error name, `cause`, path, credential, or provider payload to the model/host.
Successful evidence is unchanged.

## Stop semantics

Stop is fail-closed. Agent Harbor first collects a bounded active snapshot,
then refreshes both engine registries. Before each stop request it gets that
exact session, rechecks the message boundary, gets it again, and re-proves:

- the exact activity claim plus a current-turn boundary for a claim-backed
  direct run, or the exact raw agent plus the same observed boundary for the
  fallback direct run without a claim; or
- the signed session-bound title claim for delegated and contract work, plus
  the exact activity-claim generation when one is present.

Each target is accounted as stop-confirmed, already idle, pending, blocked by
engine/ownership/lifecycle state, or not confirmed. OpenCode has no atomic
compare-and-abort primitive, so a small residual race remains
between the final proof and the native abort; the UI states this limit.
`stop all` is disabled when global discovery is incomplete. A displayed exact
run can remain stoppable after its own final recheck when only unrelated global
activity exceeded the bound. Starting/cleaning, pending-child, other-process,
ambiguous-identity, changed-claim/ownership, pending-stop, engine-authority,
and overdue-heartbeat states are reported as distinct no-stop-attempt outcomes,
not collapsed into a generic timeout or false success.

OpenCode 1.18.4's `/api/session/{id}/interrupt` does not reach a direct custom
command or Harbor child running in legacy `SessionRunState`. Claim-backed work
and signed children observed in scoped legacy status therefore use legacy
`session.get`, chronological `{info,parts}` messages, and the boolean
project-scoped `session.abort({sessionID,directory})` route. A run observed only
in v2 uses v2 GET/messages/interrupt. Any appearance of the same ID in the
non-owning engine blocks stop, even with an exact Harbor claim: a claim proves
origin, not which independent engine owns the executing generation. Agent
Harbor never calls both stop routes.

A response other than legacy boolean `true` is rejected, and even an ACK is not
yet success. Agent Harbor polls until the exact ID is authoritatively absent in
both engines and the claim boundary is terminal: the exact generation must be
gone for a claim-backed target, and no relevant claim may have appeared for an
initially unclaimed target. If those conditions are not confirmed before the
deadline, success is not claimed. A selector-bearing one-shot ledger is
published before dispatch and deduplicates by project, public alias, native ID,
and owning authority. Timeout, disposal, transport rejection, or a malformed
response remains pending until a later `/team` proves both engines and claims
terminal while no stop call is active; the user is told not to retry. If the
best-effort team refresh afterward fails, the dialog preserves the recorded
outcome and distinguishes final stops from unconfirmed work. The stop dialog
reports only that outcome and refresh status, stays inside the 30-line/96-column
budget with a clipped-detail count when necessary, then directs the user to
`/team`; it never appends another long roster.

## Bounds and degraded operation

One view asks v2 for 65 project sessions and retains at most 64, so only a real
65th item marks session history as truncated. OpenCode 1.18.4 can emit both
cursor directions even when following either cursor yields an empty page;
cursor presence alone therefore never produces a false truncation warning.
Message pages likewise request 17 and retain 16; their always-present cursors
do not invent a lower bound. All known v2 message variants must carry unique,
bounded native IDs and creation times, including the single over-read item,
before the safe user/assistant/switch projection is accepted. The same view
reads at most 32 active IDs across the joined registries, messages from 24
verified candidates, and 16 messages per candidate, with concurrency four,
per-RPC deadlines, and a total collection deadline. Foreign-project
active sessions are inspected only
enough to establish scope and then omitted. Unknown or malformed status,
ownership, scope, model, or numeric telemetry degrades the view and disables
the affected stop authority instead of being guessed.

When active discovery is non-authoritative, every displayed activity count is
only a lower bound and teammate availability/delegability remains unverified.
Lead access is blocked, ready/idle totals are withheld, and zero visible work is
not rendered as “nobody is working.” A degraded filtered no-match retains the
authority warning and points to paged diagnostics rather than static help.

An exact local working claim is processed before candidate filtering, so it can
correct a lagging base `SessionV2Info.agent` such as `build` and authorize only
its legacy message projection. Other-process, overdue-heartbeat, non-working,
and ambiguous claims remain visible as busy but authorize neither messages nor
stop. Claim boundaries for every candidate are rechecked once after all message
fanout; non-claim agent/title ownership is re-fetched after messages. A change
discards content and stop authority. Failure of either registry, claim
inventory, roster, provenance, or an active-session GET disables stop-all even
if no target was recognized.

Fifty concurrent filters share one in-flight snapshot. Mutations are serialized
one at a time; a view started during a mutation waits for post-mutation truth.
Input is rejected before backend work above 4 KiB for team, bench, and filters,
256 bytes for a retire/stop selector, or 30 KiB for a join definition.

At most 32 disposable OpenCode child lifecycles may be live or awaiting
cleanup. One lead can delegate to at most six teammates sequentially per
originating user turn. Creation, provenance update, and deletion are
deadline-bounded. Normal, unclaimed, and late-created children each receive two
bounded deletion attempts. If both fail, Agent Harbor records a process-local
project hazard, reports cleanup failure, and blocks new delegated/contract
children before create.

Recovery is deliberately explicit: inspect OpenCode's native sessions, delete
the session titled `Agent Harbor child · provenance pending` or the signed
Harbor child left behind, and only then reload OpenCode. Reloading merely
releases the process-local safety guard; it does not delete the orphan.

## Roster mutation safety

OpenCode configuration collisions are bridged into `/team` as `conflict` and
cannot establish direct-session ownership. Repair the foreign configuration
entry and reload OpenCode; a later authoritative config refresh clears the
conflict state.

Personal registrations are global to the OpenCode home and deliberately carry
`permission.external_directory: deny`. Their enabled
`.opencode/agents/<id>.md` copies are separate canonical artifacts whose
external-directory allowlist names only the current project. Therefore a
member joined in project A can be enabled in project B without retaining A's
path: `/bench-on <id>` atomically verifies or migrates the registration and
publishes B's active copy, after which `/bench-list <id>` reports `on` and the
managed loader can resolve the member in B. A project-bound revision-5
registration from an older release is compatible only when its complete bytes
match the legacy renderer for the embedded path. It remains `stale` before
migration; altered owned files fail closed and require an explicit inspected
`/harbor-join` with `replace:true`.

`/harbor-retire` refuses to remove a personal member while any verified direct
or delegated run or lifecycle reservation remains active. It takes a second
authoritative snapshot immediately before mutation, so newly appearing work
fails closed. `/harbor-join` confirms only the public role, capabilities,
configured/inherited model, and discovery state; it never displays the managed
registration paths or private player prompt. A new or replaced definition is
`enabled · reload required` until a fresh OpenCode session loads it. An
idempotent join of an already loaded definition can remain `ready · invocable`.
Likewise, `/bench-on` distinguishes enabled-pending-reload from already loaded,
while `/bench-off` and `/harbor-retire` say when reload is still required to
remove stale native discovery. Invocation is blocked immediately after either
removal. To set or change a personal model, submit its join JSON with
`"model":"provider/model"`; updating an existing ID also requires
`"replace":true`.

The loaded direct alias also captures a digest of the exact managed definition.
Every invocation re-reads the ownership-verified active definition and compares
that digest before inference. A changed definition therefore fails with an
explicit reload requirement instead of silently running stale instructions or
tools. A direct preflight rejection also publishes a bounded, redacted error
toast before returning the failure because OpenCode 1.18.4 does not reliably
render a rejected command-hook promise. This best-effort notification has a
500 ms local deadline and never contacts a model or includes the task, native
session identity, provider, or model. `/team` reports roster truth separately
from loaded-host truth: live delegation may use a newly enabled canonical
definition, while native selection and `/<id>` remain pending until reload.

A contract's optional `model` is enforced through the pinned 1.18.3 SDK's
`session.prompt.body.model`, revalidated against host OpenCode 1.18.4: bounded
`provider/model` syntax is validated before skill loading or child creation,
then that exact pair is sent. Originating host provider, model, and variant
values are type-, code-unit-, UTF-8-, and control-bounded before trim, ledger,
reservation, or create.

All Harbor prompts and result dialogs are ownership-tracked. Unloading the TUI
target cancels in-flight reads and removes only the dialog Agent Harbor still
owns, leaving a newer host or third-party dialog untouched.
