---
name: list-skills
description: User-invoked only. Run /list-skills to list GitHub SKILL.md references covered by agent-foundry trust rules without downloading their bodies.
compatibility: opencode
---

# List trusted skill references

Literal optional display filter: `$ARGUMENTS`

This is intentionally distinct from OpenCode's built-in `/skills` manager.

1. Load `harbor-trusted-skill-sources`; ignore only OpenCode's outer skill-context wrapper and base-directory preamble, require its first nonblank original body line to be `<!-- harbor-skill id=harbor-trusted-skill-sources owner=agent-foundry revision=3 -->`, and validate the complete active policy before any request.
2. For each unique repo/ref, strip only `refs/heads/` and resolve the commit with `gh api --hostname github.com --method GET "repos/OWNER/REPO/git/ref/heads/BRANCH" --jq '.object.sha'`. Require one lowercase 40-hex SHA.
3. Read that immutable tree once with `gh api --hostname github.com --method GET "repos/OWNER/REPO/git/trees/COMMIT_SHA" -f recursive=1 --jq '{truncated: .truncated, skills: [.tree[] | select(.type == "blob" and (.path == "SKILL.md" or (.path | endswith("/SKILL.md")))) | {path: .path, blob: .sha, size: .size}]}'`. Stop if truncated or malformed.
4. Apply `repo`, `folder`, or `skills` scope in memory. Require configured exact paths to exist, every selected path to pass the policy's canonical path grammar, and every result to have a lowercase 40-hex blob and size 1..18,000. Apply the optional filter only after validation.
5. Derive `skill-id` from the directory containing `SKILL.md` (use `<repo>-root` for a root file). Return `skill-id | repository | path | tracking ref | commit | blob | trusted by`, sorted by repo/path, plus totals.

Use only those two read-only `gh` requests per repo/ref. Never download a body, clone, install, cache, redirect, write, execute repository content, or return partial results.
