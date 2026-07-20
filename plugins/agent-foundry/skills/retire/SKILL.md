---
name: retire
description: User-invoked only. Retire one personal Agent Harbor player.
argument-hint: "<player-id>"
user-invocable: true
allowed-tools: ["agent-harbor(control)"]
---
# Retire

Call the `control` tool from the `agent-harbor` MCP server exactly once with `command` equal to `retire` and `args` equal to the complete literal `$ARGUMENTS` string. Do not invoke another lifecycle command. Return the tool result faithfully.
