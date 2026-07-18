---
description: Compatibility alias that returns one managed Copilot player to the bench in the current project.
argument-hint: '"<player-name>"'
allowed-tools: ["skill", "view", "glob", "create", "powershell", "bash"]
disable-model-invocation: true
---

# Leave compatibility alias

The literal player name is:

<arguments>
$ARGUMENTS
</arguments>

Load `harbor-bench-control` with the native `skill` tool. Ignore only Copilot's outer `<skill-context>` wrapper and one runtime-owned `Base directory for this skill: ...` preamble. Require the first nonblank original-body line to be exactly `<!-- harbor-skill id=harbor-bench-control owner=agent-foundry revision=1 -->`; stop if content precedes it or the marker differs.

Require exactly one legacy player ID and map it to operation `off`. Apply the complete loaded contract exactly once. This command never invokes another slash command.

Prefer `/agent-foundry:bench off <player>` for new usage.
