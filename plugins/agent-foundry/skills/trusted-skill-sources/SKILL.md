---
name: trusted-skill-sources
description: Internal agent-foundry policy defining which pinned GitHub skill paths are trusted. Load only when listing or validating remote skills.
user-invocable: false
disable-model-invocation: true
---

# Trusted skill sources

Only entries in the active policy below grant trust. Schema examples elsewhere in this file are documentation and grant nothing.

## Active policy

```yaml
trusted-sources:
  - repo: gvillarroel/zx-harness
    ref: 181983bb58138ba3cc9aab25dd78b0557111d2bb
    scope:
      kind: skills
      paths:
        - skills/zx-example-author/SKILL.md
```

## Supported scopes

Each source has exactly one `scope`:

- `kind: repo` trusts every `SKILL.md` in the pinned repository tree.
- `kind: folder` adds one normalized relative `path` and trusts every `SKILL.md` at or below that folder.
- `kind: skills` adds a non-empty, unique `paths` array and trusts only those exact `SKILL.md` paths.

Require `repo` to be an exact `owner/name`, `ref` to be a full 40-character commit SHA, and every path to be relative, forward-slash-separated, traversal-free, and end in `SKILL.md`. Repository matching is case-insensitive; path matching is case-sensitive. A folder match requires the candidate path to start with `<folder>/`; a skills match is exact. Reject malformed, duplicate, ambiguous, branch-based, or uncovered references.

Trust permits loading the Markdown instructions only. It never permits fetching or executing sibling scripts, hooks, binaries, packages, or resources.
