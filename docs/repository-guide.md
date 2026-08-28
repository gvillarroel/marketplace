# Agent Harbor: repository guide

A shared agent-team lifecycle for GitHub Copilot CLI, OpenCode, and Pi. Agent Harbor provides a persistent roster, opt-in specialists, disposable contractors, and deterministic team controls with explicit ownership of managed profiles.

## Layout

| Path | Responsibility |
| --- | --- |
| `src/core/` | Roster, lifecycle, ownership, evidence, and shared rules. |
| `src/adapters/` | Runtime-specific Copilot, OpenCode, and Pi integration. |
| `plugins/` | Installable plugin definitions. |
| `dist/` | Tracked runtime package output; regenerate through the build script. |
| `test-ts/` | Runtime and lifecycle contract tests. |
| `tests/` | Capture and replay tests. |
| `docs/` | Installation, architecture, requirements, and validation records. |

## Documentation policy

- Keep the root `README.md` focused on purpose, critical constraints, and the first useful action. Put detailed procedures in `docs/`.
- Maintain `docs/README.md` as the navigation index whenever a guide is added or moved.
- Preserve existing specification, ADR, skill-contract, and evidence locations. Link to their owners instead of copying authoritative content.
- Keep implementation, configuration, source data, and generated output separate. Do not create empty folder hierarchies without a concrete need.
- Use portable relative links. Update both outgoing links and inbound references when moving a document.
- Document prerequisites, commands, expected outcomes, and limitations. Never describe an unrun check as verified.

## Change workflow

1. Read `AGENTS.md`, this index, and the relevant source contract.
2. Inspect `git status` and preserve pre-existing changes and staged files.
3. Make a focused change and update affected documentation in the same change.
4. Run the applicable checks below, inspect the diff, and record any unavailable prerequisite.
5. Stage explicit paths. Publish only when authorized; do not force-push or merge unrelated work.

## Validation

```sh
npm run typecheck
npm test
```

Run capture, packaging, and runtime-specific checks when the corresponding behavior changes. Live tests invoke models or installed agents; documentation changes do not require paid live runs.

## Data and operating boundaries

Preserve ownership and collision checks, private-definition boundaries, and unmanaged profiles. Do not add local runtime state or private capture artifacts. Python bytecode is generated and must not be tracked.

[Back to the documentation index](README.md).
