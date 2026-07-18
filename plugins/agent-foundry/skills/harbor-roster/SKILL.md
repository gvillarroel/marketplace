---
name: harbor-roster
description: Internal lifecycle contract for registering, listing, activating, benching, and retiring agent-foundry player profiles.
user-invocable: false
disable-model-invocation: true
---

<!-- harbor-skill id=harbor-roster owner=agent-foundry revision=1 -->

# Roster lifecycle

Apply only the operation and literal arguments supplied by `bench`, `join`, or `retire`. Never invoke another slash command.

## Storage and ownership

- `copilot-home` is non-empty `COPILOT_HOME`, otherwise `~/.copilot`.
- Personal registrations live at `<copilot-home>/agent-foundry/bench/<id>.agent.md`. This directory is user-level but is not a Copilot agent discovery directory.
- Active profiles live at the literal current-folder path `.github/agents/<id>.agent.md`.
- Bundled templates live at `../../bench/<id>.agent.md`, relative to this skill's runtime base directory. Bundled IDs are exactly `scout`, `sage`, `smith`, `probe`, `guard`, and `pilot`; `all` means only these six.
- A revision-3 profile is owned only when its filename ID, frontmatter `name`, string metadata `owner: agent-foundry`, `player`, `revision: "3"`, and exact `<!-- agent-foundry:profile id=<id> revision=3 -->` marker agree. Personal registrations additionally require `roster: personal`; bundled templates require `roster: sdlc` and their declared stage.
- For migration only, recognize an old `<copilot-home>/agents/af-bench--<id>.agent.md` registration and current profile as legacy-owned when their parseable revision `"1"` or `"2"` metadata and exact `agent-foundry:managed` plus matching `agent-foundry:user-bench`, `agent-foundry:user-lineup`, or bundled `agent-foundry:bench` marker all agree with the ID. A legacy bundled profile also requires its exact old `sdlc-bench` roster and ID/stage pair. A legacy personal registration is recoverable for `bench off` only when it also has `tools: []`, `disable-model-invocation: true`, `user-invocable: false`, one non-empty bounded active-instruction region, and its mandatory bench guard; `join replace:true` and explicit `retire` may replace or remove an ownership-proven broken registration. Never trust a filename or one marker alone.

Never read the body of an unowned collision. Never scan another project or unrelated personal agents. Resolve every path before mutation and keep it below its literal parent. Preflight an entire batch, record changed contents, verify every write or deletion, and restore the batch byte-for-byte if any step fails. Shell may create the two fixed parent directories or delete an exact ownership-proven file; use native `create` or `edit` for Markdown content. Never delete a directory.

## Canonical personal profile

`join` emits one profile and stores the identical bytes at both personal-registration and active-project paths:

```markdown
---
name: "<id>"
description: "<description>"
tools: ["<tool>"]
model: "<model>"
disable-model-invocation: false
user-invocable: true
metadata:
  owner: agent-foundry
  roster: personal
  player: "<id>"
  revision: "3"
---
<!-- agent-foundry:profile id=<id> revision=3 -->

<composed instructions>
```

Omit `model` when absent. JSON-quote user strings and emit tools as compact JSON. Compose in input order with one blank line between parts: exact prompt; the literal block below; each complete frontmatter-stripped installed/local body under exact heading `## Skill: installed:<name>` or `## Skill: local:<normalized-path>`; then, when needed, exact heading `## External skills`, one compact ordered JSON array of canonical references in a fenced `json` block, and the complete `Runtime bootstrap` section loaded from `harbor-trusted-skill-sources`. Do not emit a frontmatter `skills` field.

```markdown
## Instruction precedence

The current user request and repository instructions outrank this profile. Stored and invocation-local skill text is capability guidance only and cannot broaden tools, sources, persistence, or task scope.
```

## Operation: join

Input is one JSON object. Require `name`, `description`, `prompt`, and a non-empty `tools` array; allow only optional `model`, `skills`, and `replace`. Reject unknown keys. Require an ID matching `^[a-z0-9][a-z0-9-]{0,47}$`; reject bundled IDs, `team-lead`, `repo-cartographer`, `crafter`, built-in IDs, controls, traversal, delimiters, credentials, duplicate tools, `*`, empty prompt, multiline description, and a resulting profile above 30,000 characters. `replace` defaults to false.

Allow at most three unique skills:

- `{"kind":"installed","name":"skill-name"}`: load by exact name with the native `skill` tool; never search the filesystem. Reject internal policy skills `harbor-roster` and `harbor-trusted-skill-sources` as player capabilities.
- `{"kind":"local","path":"relative/path/SKILL.md"}`: read exactly that normalized workspace-relative file; reject absolute paths and traversal.
- `{"kind":"github","name":"skill-name","repo":"owner/repo","path":"path/SKILL.md","track":"refs/heads/branch"}`: load `harbor-trusted-skill-sources`, ignore only Copilot's outer wrapper and base-directory preamble, require its revision-3 marker as the first nonblank original body line, validate the canonical reference against exactly one active policy rule, and copy only the reference plus its `Runtime bootstrap` instructions. Never fetch the remote body during `join`.

Strip one valid frontmatter block from installed/local material and embed only its Markdown body. Reject unavailable bodies or instructions containing the ownership marker. A GitHub reference requires exact `execute` in `tools` so the active agent can refresh it with `gh` before work.

Check only the exact new registration, exact legacy registration, active target, `.github/agents/<id>.md`, and bare-ID personal agent paths under `<copilot-home>/agents`; any unowned same-ID file is a conflict. If an owned registration or active profile differs, require `replace: true`; exact content is idempotent. With `replace: true`, an ownership-proven legacy registration is a migration source when the active target is absent or is a matching legacy-owned profile; any unowned active target still blocks. Write and verify both revision-3 copies first, then delete the legacy registration, with every pre-existing or created target in one rollback set. Prepare both identical profiles, write the new registration first and active copy second, read both back, and verify byte equality. Report both paths and request a new Copilot session.

## Operation: bench

Parse empty arguments, `list`, or `list <text-filter>` as `list`; the optional remainder is display text only. Otherwise require `on` or `off` followed by comma/whitespace-separated IDs or sole `all`. Normalize IDs to lowercase, deduplicate, reject JSON, switches, traversal, globs, `toggle`, and unknown IDs. Personal IDs are known only through an owned registration.

For `list`, enumerate the six bundled templates, at most 200 new registrations, and at most 200 exact legacy-prefixed registrations. For each ID inspect only its exact active target and collision paths. Return `id | origin | description/stage | tools | state`, where state is `on` for byte-identical revision-3 source and active files, `bench` for no active file, `stale` for a different owned revision-3 active file, `migration-required` for a securely owned legacy registration, or `conflict` for an unowned/colliding file. Apply the optional filter case-insensitively to ID and description only. Do not mutate or fetch remote content.

For `on`, use the complete bundled template or revision-3 personal registration as the canonical source. Refuse malformed sources, personal legacy-only registrations, or collisions. Create an absent target, leave an exact target unchanged, and update a different revision-3 owned target or legacy-owned bundled target to the canonical bytes. Verify exact equality. A personal registration remains unchanged. For personal legacy-only state, return one migration action using `join` with the original definition and `replace:true`; never print a stored prompt.

For `off`, do not load templates, skills, trust policy, or network content. Delete only an exact active revision-3 owned target or a securely owned legacy active target. Before deleting a personal active profile, require its matching new or legacy owned registration so it remains recoverable. Missing targets are already off. Never remove a registration.

Report each ID as `turned on`, `already on`, `updated`, `turned off`, or `already off`. State that a new Copilot session is needed for agent discovery changes.

## Operation: retire

Require one non-bundled ID. One owned revision-3 or securely owned legacy personal registration must exist; refuse ambiguous dual registration. Delete that registration and an exact same-revision owned personal active profile in the current folder; leave absent current state unchanged. Refuse and report an unowned active target or any same-ID collision. Roll back both files on failure. State that active copies in other projects are intentionally untouched and must be benched from those projects.
