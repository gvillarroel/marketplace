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
2. Resolve exactly `.github/agents/<name>.agent.md` beneath the current working directory and inspect only the existence of its exact `.github/agents/<name>.md` sibling. The `.md` sibling is collision-only: never read its body, delete it, or include it in rollback. Never ascend or inspect another project.
3. Read and parse the target first. Ownership requires parseable frontmatter with exact `name: <name>`, the exact managed marker, and exactly one matching roster proof. A personal copy must have string metadata `roster: agent-foundry-user-lineup`, `player: <name>`, revision `"1"` or `"2"`, plus `<!-- agent-foundry:user-lineup id=<name> revision=<same-revision> -->`. A bundled copy must use one canonical bundled ID and stage (`scout/discover`, `sage/design`, `smith/build`, `probe/verify`, `guard/review`, or `pilot/deliver`), string metadata `roster: sdlc-bench`, that exact stage, revision `"1"` or `"2"`, plus `<!-- agent-foundry:bench id=<name> revision=<same-revision> -->`. Refuse a generic managed marker, unsupported or mismatched revision, wrong ID, malformed metadata, another roster, or a lookalike; there is no force mode.
4. Before deleting a proven personal lineup copy, preflight the exact `<copilot-home>/agents/af-bench--<name>.agent.md` registration. It is `ready` only with the exact inert revision-2 frontmatter, ownership markers, ordered active-profile payload, bounded active-instruction region, and final bench guard defined by `/agent-foundry:join`. It is `upgrade-required` only when it passes the same otherwise-valid revision-1 registration checks as `/agent-foundry:agents` and `/agent-foundry:lineup`: exact technical name; inert flags and `tools: []`; string metadata `roster: agent-foundry-user-bench`, `player: <name>`, revision `"1"`; matching managed/user-bench revision-1 markers; one valid ordered revision-1 active-profile payload; exactly one non-empty frozen active-instruction region; the mandatory final bench guard; and total size below 30,000 characters. If the registration is absent, truncated, externally owned, or otherwise broken, stop before deletion so the current profile remains the recoverable definition. Never expose its prompt or frozen body.
5. Resolve the proven target to an absolute path and prove it remains beneath the current working directory's literal `.github/agents` directory with the exact validated filename. Delete only that Markdown file with one platform-native shell command: `Remove-Item -LiteralPath` on Windows or `rm --` elsewhere. Quote the resolved literal path; use no wildcard, recursion, pipeline, command substitution, or directory deletion. Never remove a personal registration, bundled template, skill, executable, or unrelated profile.
6. Verify absence and report the path. For a personal target also report the preflight `personal bench: ready` or `upgrade-required` status. For `upgrade-required`, direct the user to repeat the desired `/agent-foundry:join` definition with `"replace":true`; never reconstruct a join command from stored data.
7. Report the exact current `.github/agents/<name>.md` sibling and bare-ID personal paths `<copilot-home>/agents/<name>.md` and `<copilot-home>/agents/<name>.agent.md` separately when they exist. State that the logical ID can remain visible after restart; never read their prompts or modify them.
8. For a proven bundled marker, report that the packaged player remains available. Every other managed or legacy-looking profile was refused in step 3 and remains untouched.

The managed current-folder `.agent.md` copy disappears after Copilot CLI restarts from this folder. Never claim the logical ID disappeared while a reported current `.md` sibling or bare-ID personal agent remains. Reactivate a ready bench player with `/agent-foundry:lineup <name>` after resolving any collision.
