---
name: join
description: User-invoked only. Register one recurring Agent Harbor player and activate it in this project.
argument-hint: "<json-object>"
user-invocable: true
allowed-tools: ["agent-harbor(control)"]
---
# Join

Call the `control` tool from the `agent-harbor` MCP server exactly once with `command` equal to `join` and `args` equal to the complete literal `$ARGUMENTS` string. Do not parse, rewrite, log, or interpolate the JSON. Return the tool result faithfully.
