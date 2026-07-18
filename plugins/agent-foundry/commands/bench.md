---
description: List, activate, or bench one or more bundled or personal Copilot players in the current project.
argument-hint: "[list|on <player...|all>|off <player...|all>]"
allowed-tools: ["skill", "view", "glob", "create", "powershell", "bash"]
disable-model-invocation: true
---

# Control the bench

The literal invocation arguments are:

<arguments>
$ARGUMENTS
</arguments>

Load `harbor-bench-control` with the native `skill` tool. Ignore only Copilot's outer `<skill-context>` wrapper and one runtime-owned `Base directory for this skill: ...` preamble. Require the first nonblank original-body line to be exactly `<!-- harbor-skill id=harbor-bench-control owner=agent-foundry revision=1 -->`; stop if content precedes it or the marker differs.

Map empty arguments or the sole token `list` to operation `list`. Otherwise require the first token to be exactly `on` or `off` and pass only the remaining literal selection to that operation. Reject `toggle`, implicit state changes, extra operation tokens, or an empty selection. Apply the complete loaded contract exactly once. This command never invokes another slash command.

Examples:

```text
/agent-foundry:bench
/agent-foundry:bench on scout sage
/agent-foundry:bench off smith
/agent-foundry:bench on all
/agent-foundry:bench off all
```
