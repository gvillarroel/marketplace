---
description: List GitHub skills covered by agent-foundry's explicit trusted-source policy using the installed gh CLI.
argument-hint: "[optional text filter]"
allowed-tools: ["skill", "powershell", "bash"]
disable-model-invocation: true
---

# List trusted skills

The optional literal filter is:

<arguments>
$ARGUMENTS
</arguments>

List remote skills covered by the plugin's active trust policy. This is distinct from Copilot's built-in `/skills`, which manages loaded skills.

1. Load `harbor-trusted-skill-sources` with the native `skill` tool. Copilot may wrap the result in `<skill-context>` and prepend one runtime-owned `Base directory for this skill: ...` line; ignore only that wrapper and preamble. Require the first nonblank line of the original Markdown body after it to be exactly `<!-- harbor-skill id=harbor-trusted-skill-sources owner=agent-foundry revision=1 -->`; if other body content precedes it or the marker is missing or different, stop. The marker is a compatibility identity check, not cryptographic provenance. Parse only its `Active policy` YAML block as configuration; schema examples grant no trust. Never locate or read the policy through shell or filesystem discovery.
2. Validate every source exactly as that policy requires before making a network call. Stop on an invalid source rather than guessing.
3. Use the developer's installed `gh` executable through the current shell. For each unique trusted repo and ref, run exactly one read-only request shaped as:

   `gh api --method GET "repos/OWNER/REPO/git/trees/FULL_SHA?recursive=1" --jq '{truncated: .truncated, paths: [.tree[] | select(.type == "blob" and (.path == "SKILL.md" or (.path | endswith("/SKILL.md")))) | .path]}'`

   Substitute only validated catalog values. Never put `$ARGUMENTS`, API output, or remote content into a shell command. Do not use `gh repo clone`, GraphQL, mutation methods, shell evaluation, a fallback HTTP client, or a generated script.
4. If `gh` is unavailable, authentication fails, GitHub returns an error, or `truncated` is true, report the exact source and failure; do not silently return a partial catalog.
5. Apply the configured scope in memory: all returned paths for `repo`, paths beginning with `<folder>/` for `folder`, or exact configured paths for `skills`. Report a configured exact path that is absent at the pinned ref as a policy error. Fail closed if one source covers more than 200 skills.
6. Derive each display ID from the directory immediately containing `SKILL.md`; do not claim it is the file's parsed `name`. Sort by repository and path. Apply the optional filter case-insensitively to the final ID, repo, and path only; never pass it to `gh`.
7. Return a compact table with `Skill ID (path-derived)`, `Repository`, `Path`, `Pinned ref`, and `Trusted by`. Finish with totals for sources and skills.

This command is read-only. Do not fetch skill bodies, install anything, write files, or execute repository content.
