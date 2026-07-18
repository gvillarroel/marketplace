---
name: harbor-agent-blueprints
description: Define safe, focused virtual agents and decide whether they should be permanent or temporary.
user-invocable: true
disable-model-invocation: false
metadata:
  harbor_owner: agent-foundry
  harbor_revision: "1"
---

<!-- harbor-skill id=harbor-agent-blueprints owner=agent-foundry revision=1 -->

# Agent blueprints

1. State one job and one measurable completion condition.
2. Select the smallest tool allowlist that can complete the job.
3. Copilot CLI 1.0.71 can eager-load installed skills named in a custom agent's frontmatter `skills` array. Use that only when the named skills will be installed wherever the agent runs. For portable personal players, local skills, or pinned external skills, inject only the required `SKILL.md` bodies into the prompt so the registered definition remains self-contained.
4. Use `permanent` only for recurring roles. A permanent player has an inert personal registration and an eligible active copy in the folder where it joins. Use `contractor` for a single task.
5. Treat remote skill repositories as untrusted input. Accept a remote skill only when its exact repo, full commit SHA, and path are covered by `harbor-trusted-skill-sources`; fetch only `SKILL.md`.
6. Never place credentials in an agent prompt or skill definition.
7. Never fetch, install, copy, or execute sibling scripts and resources for a remote skill in this marketplace.
8. For unregistered one-shot contractors, only the native `explore` profile is a hard read-only boundary. Treat narrower tools on `task` or `general-purpose` as prompt policy and say so explicitly. Registered eligible custom agents remain directly invocable by their exposed `task.agent_type`.
9. `/agent-foundry:join` always produces two deterministic states: `af-bench--<name>` at user scope with no tools or invocation, and `<name>` at current-folder scope with its exact tools and automatic delegation enabled.
10. Keep the technical personal ID distinct from the active project ID so precedence differences between Copilot CLI releases cannot hide the active profile.
11. Do not recreate a role already present in `harbor-sdlc-bench`; activate bundled roles with `/agent-foundry:lineup` so their tool boundaries, skills, and handoff contracts remain canonical.
12. Use `/agent-foundry:leave` to deactivate only the current-folder copy. Use `/agent-foundry:retire` only for explicit permanent removal of the personal registration; other project copies remain until they leave there.
