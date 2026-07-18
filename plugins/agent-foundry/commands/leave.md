---
description: Let one permanent project Copilot agent leave the team by removing its managed Markdown profile.
argument-hint: '"<agent-name>" or "{\"name\":\"agent-name\",\"force\":false}"'
allowed-tools: ["view", "glob", "edit"]
disable-model-invocation: true
---

# Let a permanent agent leave the team

The literal invocation arguments are:

<arguments>
$ARGUMENTS
</arguments>

Accept a kebab-case name or a JSON object with `name` and optional `force`.

1. Require `name` to match `^[a-z0-9][a-z0-9-]{0,47}$`.
2. Resolve exactly `.github/agents/<name>.agent.md`; reject separators, traversal, globs, and every other target.
3. Read it first. If it lacks `<!-- agent-foundry:managed -->`, refuse unless `force` is exactly `true`.
4. Delete only that Markdown file. Never remove a directory, skill, executable, or unrelated agent.
5. Verify absence and report the path. If it had an `<!-- agent-foundry:bench ... -->` marker, say that its bundled template remains parked and can be reactivated with `/agent-foundry:lineup <name>`. If it did not exist, change nothing.

Do not run shell commands.
