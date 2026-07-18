---
name: zx-example-author
description: Author small runnable zx examples from short implementation requests.
disable-model-invocation: true
metadata:
  source: https://github.com/gvillarroel/zx-harness/blob/181983bb58138ba3cc9aab25dd78b0557111d2bb/skills/zx-example-author/SKILL.md
  source_commit: 181983bb58138ba3cc9aab25dd78b0557111d2bb
  projection: instruction-only
---

# zx example author

This is an instruction-only projection of the external skill. It intentionally contains no sibling scripts or executable resources.

Write English only. Keep examples small and runnable. Match requested paths exactly. Use `#!/usr/bin/env zx` for zx entrypoints and set `$.quote = quote` when interpolating shell arguments. Prefer direct scripts over abstractions, validate empty input, and keep failures actionable. On Windows, prefer `bash.exe` when shell behavior matters. If the upstream workflow mentions a bundled scaffold or orchestrator that is not present here, implement the smallest self-contained example instead of fetching or recreating that executable.
