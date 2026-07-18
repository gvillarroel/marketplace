---
description: List permanent project Copilot agent profiles with their tools, model, and agent-foundry ownership.
argument-hint: '"[optional-name-filter]"'
allowed-tools: ["view", "glob", "list_agents"]
disable-model-invocation: true
---

# List project agents

The optional literal name filter is `$ARGUMENTS`.

Read `.github/agents/*.md` and `.github/agents/*.agent.md` without modifying anything. Deduplicate paths, parse only YAML frontmatter and the `<!-- agent-foundry:managed -->` marker, then return a compact table with ID, display name, description, tools, model or `inherit`, user-invocable state, delegation state (`eligible` unless `disable-model-invocation: true` or `infer: false`), and `managed` or `external`. Apply a supplied filter case-insensitively. Distinguish configured profiles on disk from active child executions returned by `list_agents`; the latter is not a definition catalog. Never create, repair, or delete a profile.
