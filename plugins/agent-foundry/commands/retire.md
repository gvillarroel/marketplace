---
description: Permanently remove one personal player registration and its managed current-folder profile.
argument-hint: "<player>"
allowed-tools: ["skill", "view", "glob", "create", "powershell", "bash"]
disable-model-invocation: true
---

# Retire a personal player

Literal player ID: `$ARGUMENTS`

Load `harbor-roster` with the native `skill` tool. Ignore only Copilot's outer skill-context wrapper and base-directory preamble; require the first nonblank original body line to be `<!-- harbor-skill id=harbor-roster owner=agent-foundry revision=1 -->`. Apply its `retire` operation once. Do not invoke another slash command.
