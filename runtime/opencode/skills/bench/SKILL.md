---
name: bench
description: User-invoked only. Run /bench to list, activate, or bench bundled and personal OpenCode players in the current folder; do not select it for another lifecycle command.
compatibility: opencode
---

# Control the bench

Literal arguments: `$ARGUMENTS`

Load `harbor-roster` with the native `skill` tool. Ignore only OpenCode's outer skill-context wrapper and base-directory preamble; require the first nonblank original body line to be `<!-- harbor-skill id=harbor-roster owner=agent-foundry revision=1 -->`. Apply its `bench` operation once with the literal arguments. Do not invoke another slash command.

Examples: `bench`, `bench on scout sage`, `bench off smith`, `bench on all`, `bench off all`.
