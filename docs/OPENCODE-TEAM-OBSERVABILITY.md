# OpenCode team observability

Agent Harbor's OpenCode TUI target provides a native `/team` control. It reads
OpenCode state directly and does not send a prompt, create a model session, or
create a child. Every view and stop result therefore declares `0 model tokens`.

## Using `/team`

Choose `/team` from OpenCode's slash palette. Because the TUI callback does not
receive slash arguments, Agent Harbor opens a prompt. Enter one of:

- nothing, to show a compact whole-team overview and active work; the nine
  factory IDs, kinds, and effective states always fit, while additional
  personal members are bounded with an explicit narrowing notice;
- a filter such as `status:working`, `kind:personal`, `member:crafter`,
  `tool:read`, `skill:<name>`, `model:<text>`, `task:<text>`, or a public run ID;
- `help` for the command and safety contract;
- `stop <run-id>` to interrupt one displayed run, or `stop all` to interrupt
  every verified Agent Harbor run in the current project.

The result is a persistent, wrapped dialog rather than a short-lived toast.
Because OpenCode 1.18.3 alerts do not scroll, `/team` uses a 30-wrapped-line
budget at 96 columns that fits a 45-row terminal. Broad matches use compact
rows; narrow `member:<id>` and `run:<run-id>` filters retain rich details. Any
omission includes its count and an actionable narrower filter. Roster and skill
tables use the same path-free, control-free projection.

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

Process-local reservations are bridged into the TUI without session IDs,
tasks, or provider metadata, so `starting`, `working`, and `cleaning` lifecycle
phases remain visibly busy. Native activity started outside a Harbor alias is
checked with bounded authoritative v2 `active → get` calls before roster
availability, direct reservation, or lead delegation is announced. Missing or
malformed activity telemetry fails closed instead of permitting double-booking.

Active work is grouped as direct, delegated, or contract work. An observed
native parent is used when available; otherwise a disposable child may be
shown under the only active direct `team-lead`, explicitly marked as inferred.
OpenCode does not provide Agent Harbor with a reliable terminal history, so the
view reports active work rather than inventing completed missions.

The host's configured default model is shown when it can be parsed safely,
including matching context/output limits. A run model and variant are shown
only after native telemetry observes them. Missing model, usage, or cost fields
remain `unobserved`; an explicit native zero remains zero. Reported context or
max-output values are observations, not an Agent Harbor hard token cap.

For a direct run, tokens and cost cover only assistant messages after the
current user/agent-switch boundary. For a signed disposable child, they cover
the observed child session. Truncated or numerically bounded data is marked as
a lower bound with `≥`; it is never presented as an exact total.

## Ownership and privacy boundary

Agent Harbor proves a disposable child with a title signed by a private
per-user HMAC key. The claim binds invocation kind, agent, exact native session
ID, and normalized project. The key is published atomically with private file
permissions and read through a bounded, no-follow identity check. A copied,
tampered, legacy, or cross-project title proves nothing and is omitted.

A direct session is accepted only when its exact raw `SessionV2Info.agent`
matches an ownership-verified, non-conflicting roster member. Historical
assistant messages never establish ownership. Agent Harbor reads messages only
after one of these session-level proofs succeeds.

The message parser projects only IDs, time, agent/model identity, numeric usage,
cost, and bounded user text needed for a safe task label. It never retains or
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
then refreshes global active state. Immediately before each interrupt it gets
that exact session again and re-proves:

- the exact raw agent plus the same current-turn boundary for direct work; or
- the signed session-bound claim for delegated and contract work.

Each target is accounted as interrupted, already idle, or failed. OpenCode has
no atomic compare-and-interrupt primitive, so a small residual race remains
between the final proof and the native interrupt; the UI states this limit.
`stop all` is disabled when global discovery is incomplete. A displayed exact
run can remain stoppable after its own final recheck when only unrelated global
activity exceeded the bound.

A successful interrupt is a committed result. If the best-effort team refresh
afterward fails, the dialog keeps the successful stop result and separately
marks the refresh unavailable; it never relabels the interrupt as failed. The
stop dialog reports only that result and refresh status, then directs the user
to `/team`; it never appends another long roster.

## Bounds and degraded operation

One view reads at most 64 project sessions, 32 active IDs, messages from 24
verified candidates, and 16 messages per candidate, with concurrency four,
per-RPC deadlines, and a total collection deadline. Foreign-project active
sessions are inspected only enough to establish scope and then omitted. Unknown
or malformed status, ownership, scope, model, or numeric telemetry degrades the
view and disables the affected stop authority instead of being guessed.

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

A contract's optional `model` is enforced through OpenCode 1.18.3's
`session.prompt.body.model`: bounded `provider/model` syntax is validated before
skill loading or child creation, then that exact pair is sent. Originating host
provider, model, and variant values are type-, code-unit-, UTF-8-, and
control-bounded before trim, ledger, reservation, or create.

All Harbor prompts and result dialogs are ownership-tracked. Unloading the TUI
target cancels in-flight reads and removes only the dialog Agent Harbor still
owns, leaving a newer host or third-party dialog untouched.
