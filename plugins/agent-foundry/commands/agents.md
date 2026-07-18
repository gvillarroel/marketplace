---
description: List the current project lineup and agent-foundry personal bench registrations.
argument-hint: '"[optional-name-filter]"'
allowed-tools: ["view", "glob", "list_agents"]
disable-model-invocation: true
---

# List the team roster

The optional literal name filter is `$ARGUMENTS`.

Read without modifying:

- At most 200 `.github/agents/*.md` and `.github/agents/*.agent.md` files beneath the current working directory.
- At most 200 exact `<copilot-home>/agents/af-bench--*.agent.md` files, where `copilot-home` is non-empty `COPILOT_HOME` or otherwise `~/.copilot`.
- For each logical ID found in either set, only the two exact bare-ID personal collision paths `<copilot-home>/agents/<id>.md` and `<copilot-home>/agents/<id>.agent.md`.

Never scan other personal agents. Parse only YAML frontmatter, the `agent-foundry:managed`, bundled-bench, `agent-foundry:user-bench`, and `agent-foundry:user-lineup` markers, plus the personal registration's one structural `## Active profile` JSON payload located before its exact `## Active instructions` heading. Ignore lookalike headings or fences inside the bounded active-instruction data region. Never return prompts or embedded skill bodies.

Return one compact row per logical ID with:

`ID | current folder | personal bench | description | active tools | model | delegation | ownership`

- `current folder`: `active`, `stale`, `conflict`, `legacy-local`, or `absent`; use `conflict` when either exact bare-ID personal path exists because it may hide the project profile.
- `personal bench`: `ready`, `broken`, or `absent`.
- `delegation`: `eligible` only for a current profile whose `disable-model-invocation` is false and whose logical ID has no bare-ID personal collision.
- `ownership`: `bundled`, `agent-foundry`, or `external`.

Match user registrations by their marker's logical ID, never by the technical `af-bench--` ID. Report the exact colliding personal path without reading or exposing its prompt. Apply a supplied filter case-insensitively to logical ID and description. Distinguish configured profiles from active child executions returned by `list_agents`; the latter is not a definition catalog. Never create, repair, activate, deactivate, or delete a profile.
