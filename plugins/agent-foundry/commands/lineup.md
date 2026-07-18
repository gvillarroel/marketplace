---
description: Compatibility alias that lists the bench or activates bundled and personal players in the current project.
argument-hint: "[list|all|player ...]"
allowed-tools: ["skill", "view", "glob", "create", "powershell", "bash"]
disable-model-invocation: true
---

# Lineup compatibility alias

The literal invocation arguments are:

<arguments>
$ARGUMENTS
</arguments>

Load `harbor-bench-control` with the native `skill` tool. Ignore only Copilot's outer `<skill-context>` wrapper and one runtime-owned `Base directory for this skill: ...` preamble. Require the first nonblank original-body line to be exactly `<!-- harbor-skill id=harbor-bench-control owner=agent-foundry revision=1 -->`; stop if content precedes it or the marker differs.

Map empty arguments or the sole token `list` to operation `list`. Map `all` or one or more legacy player IDs to operation `on` with those literal selection tokens. Reject `on`, `off`, `toggle`, or any syntax outside this compatibility shape. Apply the complete loaded contract exactly once. This command never invokes another slash command.

Prefer `/agent-foundry:bench list` and `/agent-foundry:bench on <players|all>` for new usage.
