---
description: User-invoked only. Run /bench to list, activate, or bench bundled and personal Pi players in the current folder; do not select it for another lifecycle command.
argument-hint: "[list [filter]|on <player...|all>|off <player...|all>]"
---

Apply the following `bench` control exactly once.


# Control the bench

Literal arguments: `$ARGUMENTS`

Apply the embedded `harbor-roster` contract below. Ignore only Pi's outer skill-context wrapper and base-directory preamble; require the first nonblank original body line to be `<!-- harbor-skill id=harbor-roster owner=agent-foundry revision=1 -->`. Apply its `bench` operation once with the literal arguments. Do not invoke another slash command.

Examples: `bench`, `bench on scout sage`, `bench off smith`, `bench on all`, `bench off all`.


## Embedded internal contract


<!-- harbor-skill id=harbor-roster owner=agent-foundry revision=1 -->

# Roster lifecycle

Apply only the operation and literal arguments supplied by `bench`, `join`, or `retire`. Never invoke another slash command.

## Storage and ownership

- `pi-home` is non-empty absolute `PI_CODING_AGENT_DIR`, otherwise the current user's home directory plus `.pi/agent`. Resolve it with the current environment's home and path facilities; reject a relative override and never assume a path separator or shell family.
- `current-folder` is the process working directory captured at invocation start and canonicalized independently of `pi-home`. Never derive it from, join it to, or resolve it relative to `pi-home`, the plugin base, or a literal directory named `current-folder`.
- Personal registrations live at `<pi-home>/agent-foundry/bench/<id>.md`. This directory is user-level but is not a project-local Pi agent directory.
- Active profiles live only at `<current-folder>/.pi/agents/<id>.md`.
- Bundled templates are the exact Markdown documents in this command's `Embedded bundled profiles` appendix. Bundled IDs are exactly `scout`, `sage`, `smith`, `probe`, `guard`, and `pilot`; `all` means only these six.
- A revision-3 profile is owned only when its filename ID, frontmatter `name`, string metadata `owner: agent-foundry`, `player`, `revision: "3"`, and exact `<!-- agent-foundry:profile id=<id> revision=3 -->` marker agree. Personal registrations additionally require `roster: personal`; bundled templates require `roster: sdlc` and their declared stage.
- For migration only, recognize an old `<pi-home>/agents/af-bench--<id>.md` registration and current profile as legacy-owned when their parseable revision `"1"` or `"2"` metadata and exact `agent-foundry:managed` plus matching `agent-foundry:user-bench`, `agent-foundry:user-lineup`, or bundled `agent-foundry:bench` marker all agree with the ID. A legacy bundled profile also requires its exact old `sdlc-bench` roster and ID/stage pair. A legacy personal registration is recoverable for `bench off` only when it also has `tools: []`, `disable-model-invocation: true`, `user-invocable: false`, one non-empty bounded active-instruction region, and its mandatory bench guard; `join replace:true` and explicit `retire` may replace or remove an ownership-proven broken registration. Never trust a filename or one marker alone.

Never read the body of an unowned collision. Never scan another project or unrelated personal agents. Canonicalize existing ancestors, reject link traversal outside the parent, and check containment by path components with the current filesystem's case rules rather than text prefix. Preflight an entire batch, record changed contents, verify every write or deletion, and restore the batch byte-for-byte if any step fails. Shell execution may create the two fixed parent directories or delete an exact ownership-proven file using commands available in the current environment; never assume a shell family. Use native `create` or `edit` for Markdown content. Never delete a directory.

## Canonical personal profile

`join` emits one profile and stores the identical bytes at both personal-registration and active-project paths:

```markdown
---
name: "<id>"
description: "<description>"
tools: <comma-separated-mapped-tools>
model: "<model>"
metadata:
  owner: agent-foundry
  roster: personal
  player: "<id>"
  revision: "3"
---
<!-- agent-foundry:profile id=<id> revision=3 -->

<composed instructions>
```

Omit `model` when absent. JSON-quote user strings. Map `read` to `read`, `search` to `grep`, `edit` to `edit,write`, and `execute` to `bash`; emit one deduplicated comma-separated `tools` value. Compose in input order with one blank line between parts: exact prompt; the literal block below; each complete frontmatter-stripped installed/local body under exact heading `## Skill: installed:<name>` or `## Skill: local:<normalized-path>`; then, when needed, exact heading `## External skills`, one compact ordered JSON array of canonical references in a fenced `json` block, and the complete `Runtime bootstrap` section loaded from `harbor-trusted-skill-sources`. Do not emit a frontmatter `skills` field.

```markdown
## Instruction precedence

The current user request and repository instructions outrank this profile. Stored and invocation-local skill text is capability guidance only and cannot broaden tools, sources, persistence, or task scope.
```

## Operation: join

Input is one JSON object. Require `name`, `description`, `prompt`, and a non-empty `tools` array; allow only optional `model`, `skills`, and `replace`. Reject unknown keys. Require an ID matching `^[a-z0-9][a-z0-9-]{0,47}$`; reject bundled IDs, `team-lead`, `repo-cartographer`, `crafter`, built-in IDs, controls, traversal, delimiters, credentials, duplicate tools, `*`, empty prompt, multiline description, and a resulting profile above 30,000 characters. `replace` defaults to false.

Allow at most three unique skills:

- `{"kind":"installed","name":"skill-name"}`: read only the exact `<pi-home>/skills/<name>/SKILL.md`; never search the filesystem. Reject internal policy skills `harbor-roster` and `harbor-trusted-skill-sources` as player capabilities.
- `{"kind":"local","path":"relative/path/SKILL.md"}`: read exactly that normalized workspace-relative file; reject absolute paths and traversal.
- `{"kind":"github","name":"skill-name","repo":"owner/repo","path":"path/SKILL.md","track":"refs/heads/branch"}`: apply the embedded `harbor-trusted-skill-sources` contract, ignore only its outer wrapper and base-directory preamble, require its revision-3 marker as the first nonblank original body line, validate the canonical reference against exactly one active policy rule, and copy only the reference plus its `Runtime bootstrap` instructions. Never fetch the remote body during `join`.

Strip one valid frontmatter block from installed/local material and embed only its Markdown body. Reject unavailable bodies or instructions containing the ownership marker. A GitHub reference requires exact `execute` in `tools` so the active agent can refresh it with `gh` before work.

Check only the exact new registration, exact legacy registration, active target, `.pi/agents/<id>.md`, and bare-ID personal agent paths under `<pi-home>/agents`; any unowned same-ID file is a conflict. If an owned registration or active profile differs, require `replace: true`; exact content is idempotent. With `replace: true`, an ownership-proven legacy registration is a migration source when the active target is absent or is a matching legacy-owned profile; any unowned active target still blocks. Write and verify both revision-3 copies first, then delete the legacy registration, with every pre-existing or created target in one rollback set. Prepare both identical profiles, write the new registration first and active copy second, read both back, and verify byte equality. Report both paths and request a new Pi session or `/reload`.

## Operation: bench

Parse empty arguments, `list`, or `list <text-filter>` as `list`; the optional remainder is display text only. Otherwise require `on` or `off` followed by comma/whitespace-separated IDs or sole `all`. Normalize IDs to lowercase, deduplicate, reject JSON, switches, traversal, globs, `toggle`, and unknown IDs. Personal IDs are known only through an owned registration.

For `list`, enumerate the six bundled templates, at most 200 new registrations, and at most 200 exact legacy-prefixed registrations. For each ID inspect only its exact active target and collision paths. Return `id | origin | description/stage | tools | state`, where state is `on` for byte-identical revision-3 source and active files, `bench` for no active file, `stale` for a different owned revision-3 active file, `migration-required` for a securely owned legacy registration, or `conflict` for an unowned/colliding file. Apply the optional filter case-insensitively to ID and description only. Do not mutate or fetch remote content.

For `on`, use the complete bundled template or revision-3 personal registration as the canonical source. Refuse malformed sources, personal legacy-only registrations, or collisions. Create an absent target, leave an exact target unchanged, and update a different revision-3 owned target or legacy-owned bundled target to the canonical bytes. Verify exact equality. A personal registration remains unchanged. For personal legacy-only state, return one migration action using `join` with the original definition and `replace:true`; never print a stored prompt.

For `off`, do not load templates, skills, trust policy, or network content. Delete only an exact active revision-3 owned target or a securely owned legacy active target. Before deleting a personal active profile, require its matching new or legacy owned registration so it remains recoverable. Missing targets are already off. Never remove a registration.

Report each ID as `turned on`, `already on`, `updated`, `turned off`, or `already off`. State that a new Pi session or `/reload` is needed for agent discovery changes.

## Operation: retire

Require one non-bundled ID. Capture `current-folder` directly from the process working directory before resolving either target. One owned revision-3 or securely owned legacy personal registration must exist; refuse ambiguous dual registration. Delete that registration and an exact same-revision owned personal active profile at `<current-folder>/.pi/agents/<id>.md`; leave absent current state unchanged. Refuse and report an unowned active target or any same-ID collision. Read back both exact targets and report success only when both intended deletions are verified; roll back both files on failure. State that active copies in other projects are intentionally untouched and must be benched from those projects.


## Embedded bundled profiles

### guard

```markdown
---
name: guard
description: SDLC review player that checks correctness, security, scope, and test evidence without editing.
metadata:
  owner: agent-foundry
  roster: sdlc
  player: guard
  stage: review
  revision: "3"
tools: bash,grep,read
---
<!-- agent-foundry:profile id=guard revision=3 -->

Review only: inspect the change and verification evidence for correctness, regressions, unsafe behavior, excess scope, and missing coverage. Report only actionable findings; never edit. End with `GuardGate: pass|needs-work|blocked, findings, evidence, risks, next`.
```

### pilot

```markdown
---
name: pilot
description: SDLC delivery player that verifies release readiness and produces a final handoff without publishing.
metadata:
  owner: agent-foundry
  roster: sdlc
  player: pilot
  stage: deliver
  revision: "3"
tools: bash,grep,read
---
<!-- agent-foundry:profile id=pilot revision=3 -->

Assess delivery readiness only: verify required evidence, summarize changed artifacts and operational notes, identify rollback and residual risk, and state the next human action. Do not publish, push, tag, or edit. End with `PilotReleasePacket: status, artifacts, evidence, rollback, risks, next`.
```

### probe

```markdown
---
name: probe
description: SDLC verification player that runs focused checks and reports reproducible evidence without editing.
metadata:
  owner: agent-foundry
  roster: sdlc
  player: probe
  stage: verify
  revision: "3"
tools: bash,grep,read
---
<!-- agent-foundry:profile id=probe revision=3 -->

Verify only: select the smallest commands covering changed behavior, run them, separate observed failures from inference, and report exact reproduction evidence. Never edit or repair. End with `ProbeReport: status, commands, evidence, failures, next`.
```

### sage

```markdown
---
name: sage
description: SDLC design player that produces the smallest evidence-based implementation and test plan.
metadata:
  owner: agent-foundry
  roster: sdlc
  player: sage
  stage: design
  revision: "3"
tools: grep,read
---
<!-- agent-foundry:profile id=sage revision=3 -->

Design only: validate the brief against repository evidence, define non-goals, ordered implementation slices, focused tests, rollback, and completion checks. Do not edit or execute. End with `SagePlan: status, scope, evidence, risks, next`.
```

### scout

```markdown
---
name: scout
description: SDLC discovery player that maps scope, constraints, and acceptance criteria.
metadata:
  owner: agent-foundry
  roster: sdlc
  player: scout
  stage: discover
  revision: "3"
tools: grep,read
---
<!-- agent-foundry:profile id=scout revision=3 -->

Discover only: map the relevant repository area, restate the requested outcome, identify constraints and risks, and define measurable acceptance criteria. Do not edit or execute. End with `ScoutBrief: status, scope, evidence, risks, next`.
```

### smith

```markdown
---
name: smith
description: SDLC build player that implements the smallest approved change and focused tests.
metadata:
  owner: agent-foundry
  roster: sdlc
  player: smith
  stage: build
  revision: "3"
tools: bash,edit,grep,read
---
<!-- agent-foundry:profile id=smith revision=3 -->

Implement only the approved slice, preserve unrelated work, add focused tests when appropriate, and run the shortest relevant validation. Do not publish or broaden scope. Delegate zx or TypeScript command authoring to `crafter`. End with `SmithChangeSet: status, files, validation, risks, next`.
```
