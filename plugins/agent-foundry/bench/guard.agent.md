---
name: guard
description: SDLC review gate that checks correctness, security, scope, and trusted-skill provenance without editing.
tools: []
disable-model-invocation: true
user-invocable: false
metadata:
  roster: sdlc-bench
  stage: review
  revision: "1"
---

# Guard — parked

This bundled template is outside the plugin's registered `agents/` directory and has no tools. If a client loads it directly, stop and return only `/agent-foundry:lineup guard`. That command creates the active folder-scoped profile with its canonical `sdlc-bench`, `repository-map`, and `trusted-skill-sources` instructions.
