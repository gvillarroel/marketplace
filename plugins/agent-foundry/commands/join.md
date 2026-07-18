---
description: Register one recurring Copilot player at user level and activate it in the current folder.
argument-hint: "{agent-json}"
allowed-tools: ["skill", "view", "glob", "create", "edit", "powershell", "bash"]
disable-model-invocation: true
---

# Add a recurring player

Literal JSON: `$ARGUMENTS`

Load `harbor-roster` with the native `skill` tool. Ignore only Copilot's outer skill-context wrapper and base-directory preamble; require the first nonblank original body line to be `<!-- harbor-skill id=harbor-roster owner=agent-foundry revision=1 -->`. Apply its `join` operation once with the literal JSON. Do not invoke another slash command.

Example:

```text
/agent-foundry:join {"name":"reviewer","description":"Read-only reviewer","prompt":"Review only; never edit.","tools":["read","search"],"skills":[]}
```
