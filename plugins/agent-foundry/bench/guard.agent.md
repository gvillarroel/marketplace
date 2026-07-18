---
name: guard
description: SDLC review gate that checks correctness, security, scope, and trusted-skill provenance without editing.
tools: []
disable-model-invocation: true
user-invocable: false
metadata:
  roster: sdlc-bench
  stage: review
  revision: "2"
---

# Guard — parked

This bundled template is outside the plugin's registered `agents/` directory and has no tools. If loaded directly, stop and return only `/agent-foundry:bench on guard`. That command creates the active folder profile with canonical revision-2 SDLC instructions plus the local repository-map and trust-policy skills.
