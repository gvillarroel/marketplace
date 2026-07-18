---
description: List permanent project Copilot agent profiles with their tools, model, and agent-foundry ownership.
argument-hint: '"[optional-name-filter]"'
allowed-tools: ["view", "glob", "list_agents"]
disable-model-invocation: true
---

# List project agents

The optional literal name filter is `$ARGUMENTS`.

Read `.github/agents/*.md` and `.github/agents/*.agent.md` beneath the current working directory without modifying anything. Deduplicate paths, parse only YAML frontmatter plus the `<!-- agent-foundry:managed -->` and optional `<!-- agent-foundry:bench ... -->` markers, then return a compact table with ID, display name, description, tools, model or `inherit`, user-invocable state, delegation state (`eligible` unless `disable-model-invocation: true` or `infer: false`), roster stage or `custom`, and `managed` or `external`. Apply a supplied filter case-insensitively. Distinguish configured profiles on disk from active child executions returned by `list_agents`; the latter is not a definition catalog. Never create, repair, or delete a profile.
