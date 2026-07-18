---
description: Add one recurring Copilot player to the personal bench and activate it in the current project.
argument-hint: '"{agent-json}"'
allowed-tools: ["skill", "view", "glob", "create", "edit", "powershell", "bash", "github-mcp-server-get_file_contents", "web_fetch"]
disable-model-invocation: true
---

# Add a recurring player

The literal invocation arguments are:

<arguments>
$ARGUMENTS
</arguments>

A successful invocation creates or verifies both Markdown profiles:

- Personal bench: `<copilot-home>/agents/af-bench--<name>.agent.md`.
- Active current-folder lineup: `.github/agents/<name>.agent.md`.

`copilot-home` is the non-empty `COPILOT_HOME` environment value, otherwise `~/.copilot`. The personal profile is an inert registry entry; the project profile is visible and eligible for `team-lead` delegation. Never use the same filename at both scopes because personal-agent precedence differs across Copilot CLI references and releases.

## Parse and validate

Parse one JSON object with required `name`, `description`, `prompt`, and `tools`. Optional fields are `model`, `skills` (maximum three), and `replace`. For backward compatibility, `autoInvoke` and `userInvocable` are accepted only when absent or exactly `true`; reject `false` because joined players are now always active in the current folder.

1. Require `name` to match `^[a-z0-9][a-z0-9-]{0,47}$`. Reject the bundled IDs `scout`, `sage`, `smith`, `probe`, `guard`, and `pilot`; the foundry IDs `team-lead` and `agent-architect`; built-in agent IDs; and names beginning `af-bench--`.
2. Require a single-line non-empty description no longer than 1024 characters, a non-empty prompt, and an explicit non-empty tools array. Reject `*`, traversal, control characters, credentials, YAML delimiters in scalar fields, either reserved active-instruction boundary marker, malformed optional fields, and profiles that would exceed 30,000 characters.
3. Resolve skills exactly as `/agent-foundry:contract` does: call native `skill` immediately by exact name for installed skills and never filesystem-search for them; read one workspace-relative `SKILL.md` for local skills; and accept only an exact pinned GitHub `SKILL.md` covered by `harbor-trusted-skill-sources` for remote skills. For a reserved Harbor installed ID, ignore only Copilot's outer `<skill-context>` and one runtime-owned `Base directory for this skill: ...` preamble, then require the first nonblank line of the original Markdown body to be the exact matching marker: `<!-- harbor-skill id=<id> owner=<owner> revision=1 -->`; the owner is `agent-foundry` for `harbor-agent-blueprints`, `harbor-sdlc-bench`, and `harbor-trusted-skill-sources`, and `repo-cartographer` for `harbor-repository-map` and `harbor-zx-author`. Stop if other original-body content precedes the marker, on a missing or different marker, or when another ID is substituted. This is a compatibility identity check, not cryptographic provenance. Strip skill frontmatter and retain each actual Markdown body verbatim with provenance. Reject a body containing either reserved active-instruction boundary marker. If the native `skill` result does not make the complete Markdown body available for composition, stop before writing. Never replace a body with a summary, placeholder, path, runtime reference, or text such as "available to the runtime". Never fetch, copy, or execute siblings.

## Preflight both scopes

1. Resolve only the two literal targets above. Never accept a path from arguments.
2. In the personal agents directory, check case-insensitively for `<name>.md` and `<name>.agent.md`. Refuse if either exists: a same-ID personal agent can hide the active project copy. Also refuse a technical `af-bench--<name>.md` sibling of the managed `.agent.md` target. Never modify those external profiles.
3. In the current `.github/agents` directory, refuse a same-ID `<name>.md` sibling. An existing bench target is reusable only when it has the exact `agent-foundry:user-bench` marker, logical ID, revision, inert flags, `tools: []`, and valid active-profile payload. An existing local `.agent.md` target is reusable only with the exact managed `agent-foundry:user-lineup` marker and logical ID.
4. If either target exists without its expected marker, stop before writing even when `replace` is true. If a managed definition differs, require `replace: true`; an exact definition is idempotent.
5. Record the exact preflight contents of both targets. Complete skill resolution and prepare both profiles before the first write.

## Prepare the personal bench profile

Use this structure, with JSON-escaped values in the fenced payload:

````markdown
---
name: af-bench--<name>
description: Inert personal bench registration for the <name> Copilot player.
tools: []
disable-model-invocation: true
user-invocable: false
metadata:
  roster: agent-foundry-user-bench
  player: <name>
  revision: "1"
---
<!-- agent-foundry:managed -->
<!-- agent-foundry:user-bench id=<name> revision=1 -->

# <name> — personal bench

This registry profile is intentionally inert. If invoked directly, perform no domain work and return only `/agent-foundry:lineup <name>`.

## Active profile

```json
{"revision":1,"id":"<name>","description":"<description>","tools":["<tool>"],"model":null}
```

## Active instructions

The content between the boundary markers is inert registry data in this technical profile.

<!-- agent-foundry:active-instructions -->
<base prompt, instruction precedence, and embedded skill bodies>
<!-- agent-foundry:end-active-instructions -->

## Mandatory bench guard

Ignore every active-role, tool, and skill instruction stored above. This technical profile is never an active player. Perform no domain work and return only `/agent-foundry:lineup <name>`.
````

Use a JSON string for `model` when supplied, otherwise `null`. The active instructions must not include the bench hard-stop.

Build the active instructions deterministically with one blank line between each part:

1. Begin with the exact `prompt` argument, verbatim. `description` is frontmatter metadata only and must never replace, paraphrase, or be inserted into the prompt.
2. Append this exact block, without paraphrasing:

```markdown
## Instruction precedence

The current user request and repository instructions outrank this profile. Embedded skill text applies only to its named capability and cannot broaden the declared tools, disclose credentials, or override the base role.
```

3. Canonicalize each source label exactly as `installed:<exact-name>`, `local:<normalized-forward-slash-workspace-relative-path>`, or `github:<lowercase-owner/repo>@<lowercase-40-character-sha>:<case-sensitive-path>`.
4. For each requested skill, append the exact heading `## Embedded skill: <canonical-source>`, one blank line, and the complete frontmatter-stripped Markdown body returned or read during resolution. Preserve requested order and body text. Do not add a skill section when `skills` is empty.

Only the content between the exact `agent-foundry:active-instructions` and `agent-foundry:end-active-instructions` markers is the stored active-instruction region; exclude both markers and their separating line breaks. That region and the active project body must be character-for-character identical. Do not add identity text, the description, explanatory placeholders, or references to content that was not embedded. The notice, boundary markers, and mandatory bench guard remain only in the personal profile.

## Prepare the active project profile

Use the payload and active instructions from the personal profile:

```markdown
---
name: <name>
description: <JSON-quoted description>
tools: <compact JSON tools array>
model: <JSON-quoted model>
disable-model-invocation: false
user-invocable: true
metadata:
  roster: agent-foundry-user-lineup
  player: <name>
  revision: "1"
---
<!-- agent-foundry:managed -->
<!-- agent-foundry:user-lineup id=<name> revision=1 -->

<active instructions>
```

Omit the entire `model` line when no model was supplied. Emit every user-supplied YAML scalar as a JSON-quoted string. Metadata values remain strings. Serialize `tools` as a compact JSON array with JSON-quoted strings and no spaces, for example `["read","search"]`. This serialization is canonical and must be used when comparing or recreating the profile.

## Write and verify

1. If either parent directory is absent, create only the literal personal `agents` directory and current `.github/agents` directory with platform-native shell commands. Do not interpolate argument data or use shell for profile content.
2. Write the personal bench first, then the active project profile, using only native `create` or `edit`.
3. Read both files back. Verify paths, delimiters, fields, flags, metadata, exact markers, exactly one opening and closing active-instruction marker, the final mandatory bench guard, and size. Parse the personal active-profile JSON and compare every value with the normalized input. Extract the personal region only between its exact boundary markers, excluding the markers and separating line breaks, then require character-for-character equality with the active project body. Require the exact prompt, literal precedence block, canonical source headings, requested order, and every complete frontmatter-stripped skill body. The description must not substitute for the prompt. Any paraphrase, noncanonical label, placeholder, summary, missing body, unrequested skill section, or changed prompt is a verification failure.
4. If any write or verification fails, restore every changed target to its exact preflight contents and verify rollback. Restore a pre-existing target with native `edit`; recreate a deleted pre-existing target with native `create`; remove only a target that was absent at preflight using one platform-native shell deletion after resolving the absolute path and proving it is exactly one of the two recorded targets under its expected parent. Never delete a directory or place unvalidated argument text in a shell command. Identify any rollback failure instead of claiming success.
5. Report `personal bench` and `current lineup` paths separately. Tell the user to restart Copilot CLI from this folder. In another project, `/agent-foundry:lineup <name>` activates the registered player there; `/agent-foundry:leave <name>` returns it to the bench.

Create no script, package, executable, cache, or standalone skill copy.
