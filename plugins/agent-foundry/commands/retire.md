---
description: Permanently remove one agent-foundry player from the personal bench and current folder lineup.
argument-hint: '"<player-name>"'
allowed-tools: ["view", "glob", "create", "powershell", "bash"]
disable-model-invocation: true
---

# Retire a personal player

The literal player name is:

<arguments>
$ARGUMENTS
</arguments>

Use this only for explicit permanent-removal intent.

`copilot-home` is the non-empty `COPILOT_HOME` environment value, otherwise `~/.copilot`.

1. Require one name matching `^[a-z0-9][a-z0-9-]{0,47}$`; reject bundled SDLC IDs, JSON, separators, traversal, switches, globs, and technical bench IDs.
2. Resolve exactly `<copilot-home>/agents/af-bench--<name>.agent.md` and current `.github/agents/<name>.agent.md`. Refuse a technical personal `.md` sibling that would share the bench ID. Also inspect only the exact bare-ID personal paths `<copilot-home>/agents/<name>.md` and `<copilot-home>/agents/<name>.agent.md` so any external same-ID agent can be reported, never removed. Never scan other projects or unrelated personal agents.
3. Prove ownership without requiring the stored active payload to be healthy: require parseable frontmatter with exact technical `name`, matching string metadata `roster`, `player`, and revision, plus exact managed and `agent-foundry:user-bench` markers. This permits safe cleanup of a `broken-registry`. Refuse an absent or externally owned registration.
4. Read both targets and record exact contents before deletion. Delete the local target only when it has the matching managed `agent-foundry:user-lineup` marker. Leave bundled, legacy, or external local files unchanged and report them. For every deletion, resolve the absolute path and prove it is exactly a recorded target under its expected parent; use one platform-native `Remove-Item -LiteralPath` or `rm --` command with no wildcard, recursion, pipeline, command substitution, or directory deletion.
5. Delete the ownership-validated personal registration. If any required deletion or verification fails, recreate every deleted file from its exact preflight contents using native `create`, verify rollback, and identify any rollback failure instead of claiming success.
6. Verify absence and report `personal bench`, `current lineup`, and any external bare-ID personal collision separately. State that the external profile and active copies in other projects cannot be removed by this command; run `/agent-foundry:leave <name>` in each such project.

Never remove a directory, bundled template, skill, script, package, executable, or unrelated agent. Restart Copilot CLI to refresh the roster.
