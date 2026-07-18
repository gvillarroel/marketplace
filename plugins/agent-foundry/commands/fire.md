---
description: Remove one permanent project agent previously created by agent-foundry.
argument-hint: '"<agent-name>" or "{\"name\":\"agent-name\",\"force\":false}"'
allowed-tools: ["view", "glob", "edit", "apply_patch"]
disable-model-invocation: true
---

# Remove a permanent agent

The literal invocation arguments are:

<arguments>
$ARGUMENTS
</arguments>

Accept a kebab-case name or a JSON object with `name` and optional `force`.

1. Require `name` to match `^[a-z0-9][a-z0-9-]{0,47}$`.
2. Resolve exactly `.github/agents/<name>.agent.md`; reject separators, traversal, globs, and every other target.
3. Read it first. If it lacks `<!-- agent-foundry:managed -->`, refuse unless `force` is exactly `true`.
4. Delete only that Markdown file. Never remove a directory, skill, executable, or unrelated agent.
5. Verify absence and report the path. If it did not exist, change nothing.

Do not run shell commands.
