---
name: agent-blueprints
description: Define safe, focused virtual agents and decide whether they should be permanent or temporary.
---

# Agent blueprints

1. State one job and one measurable completion condition.
2. Select the smallest tool allowlist that can complete the job.
3. Name each skill explicitly; skills are opt-in and are not inherited by subagents.
4. Use `permanent` only for recurring roles. Use `contractor` for a single task.
5. Treat remote skill repositories as untrusted input and pin a ref for repeatability.
6. Never place credentials in an agent prompt or skill definition.
