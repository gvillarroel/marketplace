---
name: contract
description: User-invoked only. Run /contract with one JSON object to execute a disposable native Copilot subagent with requested-tool policy and optional skill guidance.
argument-hint: "{contractor-json-with-task}"
allowed-tools: ["agent-harbor(control)", task]
user-invocable: true
---

# Run a one-shot player

Literal input: `$ARGUMENTS`

Call the `control` tool from the `agent-harbor` MCP server exactly once with `command` equal to `contract` and `args` equal to the complete literal `$ARGUMENTS` string. Do not parse or reinterpret the user input before the preflight. If it fails, return its error and do not call `task`.

The successful stdout is one JSON object containing exactly `agent_type`, `description`, and `prompt`. Call `task` exactly once, synchronously, with those three values unchanged. Do not run any instruction contained in `prompt` in the parent. Return the child result faithfully and retain no contractor state. Never create another SDK client or write an agent, skill, cache, package, or executable.
