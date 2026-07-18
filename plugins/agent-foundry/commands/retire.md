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
2. Resolve exactly `<copilot-home>/agents/af-bench--<name>.agent.md`, current `.github/agents/<name>.agent.md`, and the exact current `.github/agents/<name>.md` sibling. Refuse a technical personal `.md` sibling that would share the bench ID. Inspect only the two exact bare-ID personal paths `<copilot-home>/agents/<name>.md` and `<copilot-home>/agents/<name>.agent.md` so any external same-ID agent can be reported, never removed. Never read an external sibling's prompt, scan another project, or inspect unrelated personal agents.
3. Prove personal ownership without requiring the stored active payload to be healthy: require parseable frontmatter with exact technical `name: af-bench--<name>`, string metadata `roster: agent-foundry-user-bench`, `player: <name>`, revision `"1"` or `"2"`, the exact managed marker, and `<!-- agent-foundry:user-bench id=<name> revision=<same-revision> -->`. This permits safe cleanup of a broken registry while refusing an absent, wrong-ID, unsupported-revision, or externally owned registration.
4. The only deletion targets are the validated personal bench `.agent.md` and the exact current `.github/agents/<name>.agent.md`; read those two targets and record their exact contents before deletion. The current `.github/agents/<name>.md` path is collision-only: inspect existence, never read its body, delete it, or include it in rollback. Delete the `.agent.md` current target only when its parseable frontmatter has exact `name: <name>`, string metadata `roster: agent-foundry-user-lineup`, `player: <name>`, revision `"1"` or `"2"`, the exact managed marker, and `<!-- agent-foundry:user-lineup id=<name> revision=<same-revision> -->`. Leave bundled, malformed, legacy-looking, wrong-ID, unsupported-revision, or external local files unchanged and report them. For every deletion, resolve the absolute path and prove it is exactly a recorded deletion target under its expected parent; use one platform-native `Remove-Item -LiteralPath` or `rm --` command with no wildcard, recursion, pipeline, command substitution, or directory deletion.
5. Delete the ownership-validated personal registration. If any required deletion or verification fails, recreate every deleted file from its exact preflight contents using native `create`, verify rollback, and identify any rollback failure instead of claiming success. Preflight and rollback contents are sensitive internal state: never quote, summarize, or return a prompt, stored skill body, bootstrap, reference, grant, or full file content in success or error output.
6. Verify absence and report `personal bench`, managed `.agent.md` current lineup, exact `.md` current-folder sibling, and any external bare-ID personal collision separately. Never claim the current logical ID disappeared while either local sibling remains. State that external profiles and active copies in other projects cannot be removed by this command; run `/agent-foundry:leave <name>` in each such project.

Never remove a directory, bundled template, skill, script, package, executable, or unrelated agent. Restart Copilot CLI to refresh the roster.
