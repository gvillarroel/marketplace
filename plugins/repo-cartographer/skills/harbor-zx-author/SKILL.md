---
name: harbor-zx-author
description: Author small runnable zx examples from a collision-resistant, instruction-only projection of gvillarroel/zx-harness.
disable-model-invocation: false
metadata:
  harbor_owner: repo-cartographer
  harbor_revision: "1"
  upstream_name: zx-example-author
  source: https://github.com/gvillarroel/zx-harness/blob/181983bb58138ba3cc9aab25dd78b0557111d2bb/skills/zx-example-author/SKILL.md
  source_commit: 181983bb58138ba3cc9aab25dd78b0557111d2bb
  projection: instruction-only
---

<!-- harbor-skill id=harbor-zx-author owner=repo-cartographer revision=1 -->

# Harbor zx author

This is an instruction-only projection of the external skill. Its unique local name prevents a project or personal `zx-example-author` skill from silently replacing it. It intentionally contains no sibling scripts or executable resources.

Write English only. Keep examples small and runnable. Match requested paths exactly. Use `#!/usr/bin/env zx` for zx entrypoints and set `$.quote = quote` when interpolating shell arguments. Prefer direct scripts over abstractions, validate empty input, and keep failures actionable. On Windows, prefer `bash.exe` when shell behavior matters. If the upstream workflow mentions a bundled scaffold or orchestrator that is not present here, implement the smallest self-contained example instead of fetching or recreating that executable.
