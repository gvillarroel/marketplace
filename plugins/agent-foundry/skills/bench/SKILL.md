---
name: bench
description: User-invoked only. List, activate, or deactivate Agent Harbor players in the current project.
argument-hint: "[list [filter] | on <ids|all> | off <ids|all>]"
user-invocable: true
allowed-tools: ["agent-harbor(control)"]
---
# Bench

Call the `control` tool from the `agent-harbor` MCP server exactly once with `command` equal to `bench` and `args` equal to the complete literal `$ARGUMENTS` string. Do not reinterpret arguments, invoke another command, or call a model-selected lifecycle operation. Return the tool result faithfully.
