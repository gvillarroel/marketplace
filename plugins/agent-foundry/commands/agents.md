---
description: List permanent project Copilot agent profiles with their tools, model, and agent-foundry ownership.
argument-hint: '"[optional-name-filter]"'
allowed-tools: ["view", "glob", "list_agents"]
disable-model-invocation: true
---

# List project agents

The optional literal name filter is `$ARGUMENTS`.

Read `.github/agents/*.md` and `.github/agents/*.agent.md` without modifying anything. Deduplicate paths, parse only YAML frontmatter and the `<!-- agent-foundry:managed -->` marker, then return a compact table with ID, display name, description, tools, model or `inherit`, user-invocable state, and `managed` or `external`. Apply a supplied filter case-insensitively. Distinguish files on disk from agents already loaded in this Copilot session. Never create, repair, or delete a profile.
