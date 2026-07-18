---
description: List current project profile state and agent-foundry personal bench registrations.
argument-hint: '"[optional-name-filter]"'
allowed-tools: ["skill", "view", "glob", "list_agents"]
disable-model-invocation: true
---

# List the team roster

The optional literal name filter is `$ARGUMENTS`.

Read without modifying:

- At most 200 `.github/agents/*.md` and `.github/agents/*.agent.md` files beneath the current working directory.
- At most 200 exact `<copilot-home>/agents/af-bench--*.agent.md` files, where `copilot-home` is non-empty `COPILOT_HOME` or otherwise `~/.copilot`.
- For each logical ID found in either set, only the two exact bare-ID personal collision paths `<copilot-home>/agents/<id>.md` and `<copilot-home>/agents/<id>.agent.md`.

Never scan other personal agents. Parse YAML frontmatter, exact `agent-foundry:managed`, bundled-bench, `agent-foundry:user-bench`, and `agent-foundry:user-lineup` markers, the personal registration's one structural `## Active profile` JSON payload before its exact `## Active instructions` heading, and its bounded active-instruction region only for silent integrity comparison. Ignore lookalike headings or fences inside that bounded region. Never return prompts, canonical GitHub references, bootstrap text, stored local skill bodies, remote bodies, or resolved SHAs.

## Recognize revision 2

A revision-2 personal registration is `ready` only when it has:

- Exact technical filename, inert flags, `tools: []`, roster/player/revision metadata, managed marker, and exact `agent-foundry:user-bench id=<id> revision=2` marker.
- One payload with only ordered keys `revision`, `id`, `description`, `tools`, `model`, and `skills`; matching revision and ID; a valid single-line description; a non-empty array of unique non-control tool strings that excludes `*`; string-or-null model; and at most three canonical, non-duplicate skill entries.
- Reapply `/agent-foundry:join`'s complete revision-2 schema: installed entries contain only valid `kind,name`; local entries only `kind,path` with a normalized workspace-relative forward-slash `SKILL.md` path and no traversal; and GitHub entries only `kind,name,repo,path,track` in that order, using the conservative ASCII repo/path/tracking-ref character rules. A GitHub reference must use `refs/heads/...`, contain no legacy `ref`, SHA, URL, body, timestamp, or cache path, require exact `execute` in payload tools, and be covered by exactly one currently loaded revision-2 trusted-policy rule. A missing, marker-mismatched, malformed, duplicate, ambiguous, or uncovered source makes the registration `broken`, never ready or eligible.
- Exactly one non-empty bounded active-instruction region followed by the mandatory bench guard and total size below 30,000 characters. Silently validate that it contains the exact instruction-precedence block and one ordered stored-skill section for every installed/local payload entry. For every GitHub entry require one canonical reference in payload order, one identical narrowed revision-2 grant, all three exact `gh api` templates and jq objects, the complete private-bootstrap protocol, and the three literal final caveat sentences defined by `/agent-foundry:join`; forbid frontmatter `skills`, a stored GitHub body section, a resolved 40-hex SHA, URL, timestamp, cache path, broad policy, or missing bootstrap. Never return the bounded contents.

For a current managed personal profile, require matching revision-2 roster/player metadata and marker. Require frontmatter `skills` to be absent because revision-2 profiles are self-contained and Copilot CLI 1.0.71 ignores that field for custom agents. Compare its description, tools, and optional model with the payload, then require its complete body after the two ownership markers to equal the bench registration's bounded active-instruction region character-for-character, allowing only one final newline. Any mismatch is `stale`, never `active` or `eligible`.

For a current managed bundled profile, load `harbor-bench-control` and `harbor-sdlc-bench` once with the native `skill` tool. Require the exact first-body markers `<!-- harbor-skill id=harbor-bench-control owner=agent-foundry revision=1 -->` and `<!-- harbor-skill id=harbor-sdlc-bench owner=agent-foundry revision=2 -->`, then reconstruct the selected role from the active roster, matching role section, shared handoff, and assigned reserved skill bodies exactly as `/agent-foundry:bench on` does. Require exact canonical frontmatter, ownership markers, and body equality. If a required component or marker cannot be validated, classify it `unverified`; never infer active status from frontmatter alone and never fetch an external body.

Recognize an otherwise valid, securely owned revision-1 user-bench or user-lineup profile by its exact revision-1 roster metadata, matching logical ID, managed marker, and expected roster marker. Recognize a revision-1 bundled profile only for one exact canonical ID/stage pair (`scout/discover`, `sage/design`, `smith/build`, `probe/verify`, `guard/review`, or `pilot/deliver`) with matching roster and bench marker. Classify either as `upgrade-required`; never treat it as active, ready, stale, external, or broken merely because it uses the frozen-body schema. Do not infer ownership from filename or one marker alone.

## Return the roster

Return one compact row per logical ID:

`ID | current folder | personal bench | description | active tools | model | delegation | ownership`

- `current folder`: `active`, `stale`, `unverified`, `upgrade-required`, `conflict`, `legacy-local`, or `absent`.
- `personal bench`: `ready`, `upgrade-required`, `broken`, or `absent`.
- `delegation`: `eligible` only for a character-for-character validated current revision-2 profile whose `disable-model-invocation` is false, whose frontmatter has no ignored `skills` dependency, and whose logical ID has no bare-ID personal collision. `stale`, `unverified`, and revision 1 are never eligible through this report.
- `ownership`: `bundled`, `agent-foundry`, or `external`.

Use `conflict` when either exact bare-ID personal path or a same-ID local `.md` sibling exists because it may hide the project profile. Use `stale` for an owned revision-2 current profile whose canonical frontmatter or full validated body differs from its valid revision-2 personal registration or reconstructed bundled definition. Use `unverified` when an owned revision-2 profile needs a reserved component that cannot be validated. Use `legacy-local` only for legacy project files not securely identified as agent-foundry revision 1. Use `broken` for a personal prefixed registration that fails revision-2 validation and is not a securely identified revision-1 registration.

Match user registrations by marker logical ID, never by technical `af-bench--` ID. Report an exact colliding path without reading or exposing its prompt. Apply a supplied filter case-insensitively only to logical ID and description. Distinguish configured profiles from active child executions returned by `list_agents`; the latter is not a definition catalog.

For every `upgrade-required` row, append one concise action: personal registrations require rerunning the desired `/agent-foundry:join` definition with `"replace":true`; a bundled current profile requires `/agent-foundry:bench off <id>` followed by `/agent-foundry:bench on <id>`. Never reconstruct or print a join command from a stored prompt.

Never fetch, resolve, cache, create, repair, activate, deactivate, or delete anything.
