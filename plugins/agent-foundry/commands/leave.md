---
description: Return one managed Copilot player from the current folder lineup to its bench.
argument-hint: '"<player-name>"'
allowed-tools: ["view", "glob", "powershell", "bash"]
disable-model-invocation: true
---

# Return a player to the bench

The literal player name is:

<arguments>
$ARGUMENTS
</arguments>

`copilot-home` is the non-empty `COPILOT_HOME` environment value, otherwise `~/.copilot`.

1. Require one name matching `^[a-z0-9][a-z0-9-]{0,47}$`; reject JSON, separators, traversal, switches, globs, and every other target.
2. Resolve exactly `.github/agents/<name>.agent.md` beneath the current working directory. Never ascend or inspect another project.
3. Read the target first. Refuse any file without `<!-- agent-foundry:managed -->`; there is no force mode for external profiles.
4. Resolve the target to an absolute path and prove it remains beneath the current working directory's literal `.github/agents` directory with the exact validated filename. Delete only that Markdown file with one platform-native shell command: `Remove-Item -LiteralPath` on Windows or `rm --` elsewhere. Quote the resolved literal path; use no wildcard, recursion, pipeline, command substitution, or directory deletion. Never remove a personal registration, bundled template, skill, executable, or unrelated profile.
5. Verify absence and report the path.
6. For an `agent-foundry:user-lineup` marker, verify only whether the exact `<copilot-home>/agents/af-bench--<name>.agent.md` registration exists and report `personal bench: ready`, `missing`, or `broken`; never modify it.
7. Inspect only the exact bare-ID personal paths `<copilot-home>/agents/<name>.md` and `<copilot-home>/agents/<name>.agent.md`. If either exists, report that the external personal agent remains visible under the same ID after restart; never read its prompt or modify it.
8. For a bundled bench marker, report that the packaged player remains available. For a legacy managed profile without either roster marker, report that no persistent bench was created by this operation.

The managed current-folder copy disappears after Copilot CLI restarts from this folder. A reported external bare-ID personal agent does not disappear. Reactivate a ready bench player with `/agent-foundry:lineup <name>` after resolving any collision.
