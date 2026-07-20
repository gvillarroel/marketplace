---
name: list-skills
description: User-invoked only. Resolve trusted GitHub skill snapshots through authenticated gh.
argument-hint: "[filter]"
user-invocable: true
allowed-tools: ["agent-harbor(control)"]
---
# List skills

Call the `control` tool from the `agent-harbor` MCP server exactly once with `command` equal to `list-skills` and `args` equal to the complete literal `$ARGUMENTS` string. Do not reproduce fetched skill bodies. Return the tool result faithfully.
