---
description: List, activate, or bench bundled and personal Copilot players in the current folder.
argument-hint: "[list [filter]|on <player...|all>|off <player...|all>]"
allowed-tools: ["skill", "view", "glob", "create", "edit", "powershell", "bash"]
disable-model-invocation: true
---

# Control the bench

Literal arguments: `$ARGUMENTS`

Load `harbor-roster` with the native `skill` tool. Ignore only Copilot's outer skill-context wrapper and base-directory preamble; require the first nonblank original body line to be `<!-- harbor-skill id=harbor-roster owner=agent-foundry revision=1 -->`. Apply its `bench` operation once with the literal arguments. Do not invoke another slash command.

Examples: `bench`, `bench on scout sage`, `bench off smith`, `bench on all`, `bench off all`.
