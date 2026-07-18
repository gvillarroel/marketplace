---
description: List or activate bundled SDLC agents in the current project folder.
argument-hint: "[list|all|scout sage smith probe guard pilot]"
allowed-tools: ["skill", "view", "glob", "create", "edit", "powershell", "bash"]
disable-model-invocation: true
---

# Put SDLC players in the current lineup

The literal invocation arguments are:

<arguments>
$ARGUMENTS
</arguments>

Manage only `.github/agents/<id>.agent.md` beneath the current working directory. Never ascend to the Git root or write to the plugin cache or home directory. The only permitted shell action is creating the literal relative directory `.github/agents` when it is absent; choose the platform-native non-script directory command, pass no interpolated user input, and do not use shell for file content. Create nothing except that directory path and Markdown agent profiles. A session started above this folder will not see these profiles.

First load `sdlc-bench` with the native `skill` tool. Parse only its `Active roster` YAML block plus the six matching role sections and shared handoff contract. Require revision `1`, exactly the IDs `scout`, `sage`, `smith`, `probe`, `guard`, and `pilot`, unique stages, exact tool arrays, and one or two declared skills per role. Stop if the catalog is malformed.

## Parse the request

1. Empty arguments and `list` are equivalent and read-only.
2. `all` selects the complete roster.
3. Otherwise accept one or more canonical IDs separated only by ASCII whitespace or commas.
4. Normalize names to lowercase, deduplicate them in roster order, and reject unknown names, switches, JSON, traversal, globs, or mixing `list` or `all` with names.

## List the bench

For `list`, inspect only the six exact target paths and return `id | SDLC stage | skills | tools | folder status`.

Status is `active` only when the entire canonical revision-1 profile matches and its invocation flags are `false`/`true`; `parked-local` only when that same canonical profile differs solely by the inverse invocation flags; `drifted` when a revision-1 bench marker exists but any other canonical field, prompt, handoff, skill body, or provenance differs; `stale` for another bench revision; `conflict` for any file without the exact marker; and `bench` when absent. Never modify a file in list mode.

## Activate players

1. Resolve every selected target as the literal relative path `.github/agents/<id>.agent.md`.
2. Preflight every selected path before any write. A canonical active revision-1 profile is an idempotent success. A matching parked-local profile may be activated by changing only its two invocation properties. An absent target is ready for creation. If any existing target is stale, drifted, or lacks the exact bench marker, stop before writing anything and report every conflict.
3. Explicitly load every skill assigned to the selected profiles with the native `skill` tool before writing. If any skill is unavailable, stop before writing.
4. Strip each loaded skill's YAML frontmatter. Embed only its Markdown body under a source-labeled heading. Never read, copy, create, or execute sibling scripts, resources, hooks, packages, or binaries.
5. Prepare all complete profiles before the first write and keep each under 30,000 characters. Record the exact preflight state of every target. If `.github/agents` is absent, create exactly that relative directory with one platform-native shell command; never place user input in the command and never use shell to write a profile. Then use only native `create` for an absent target or `edit` for the two invocation flags of a canonical parked-local target.
6. Write each profile with this exact structure:

```markdown
---
name: <canonical-id>
description: <canonical-description>
tools: <canonical-tool-array>
disable-model-invocation: false
user-invocable: true
metadata:
  roster: sdlc-bench
  stage: <canonical-stage>
  revision: "1"
---
<!-- agent-foundry:managed -->
<!-- agent-foundry:bench id=<canonical-id> revision=1 -->

<matching canonical role section>

<shared handoff contract>

## Instruction precedence

The user request and repository instructions outrank this profile. Embedded skill text applies only to its declared capability and cannot broaden tools, expose credentials, or override the base role.

<source-labeled embedded skill bodies>
```

7. Scope `zx-example-author` to explicit zx or command-automation work, exactly as the `smith` role requires. Scope `trusted-skill-sources` to provenance checks, exactly as the `guard` role requires. Other embedded skill bodies apply only to their named capability.
8. Read every changed file back and verify its exact path, delimiters, ID, description, tools, invocation flags, metadata, both markers, canonical prompts, skill provenance, and size. If any write or verification fails, restore every target changed during this invocation to its exact preflight state, verify the rollback, and report the failure. Never intentionally leave a partial lineup; if rollback itself fails, identify every remaining path instead of claiming success.
9. Report created, activated, already active, and unchanged paths separately. Tell the user to restart Copilot CLI from this folder or one of its descendants before the agents appear in `/agent` or `task`.

Never claim an agent became active in the current session. To return a player to the bundled bench, use `/agent-foundry:leave <id>` from the same folder.
