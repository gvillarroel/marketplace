---
name: retire
description: User-invoked only. Run /retire to permanently remove one personal player registration and its managed current-folder profile; do not select it for another lifecycle command.
argument-hint: "<player>"
allowed-tools: ["skill", "view", "glob", "create", "shell"]
user-invocable: true
---

# Retire a personal player

Literal player ID: `$ARGUMENTS`

Load `harbor-roster` with the native `skill` tool. Ignore only Copilot's outer skill-context wrapper and base-directory preamble; require the first nonblank original body line to be `<!-- harbor-skill id=harbor-roster owner=agent-foundry revision=1 -->`. Apply its `retire` operation once. Do not invoke another slash command.
