# Test log — 2026-07-20

Validation was completed in the working tree from the published baseline
commit `b3f6923e16f5e5de22065945850d4c2e0da63b77`. This file records only bounded,
sanitized evidence. It intentionally excludes prompts, responses, hidden fixture
values, temporary paths, commands selected by a model, raw errors and
credentials.

## Final offline gate

Recorded at `2026-07-20T22:38:11-04:00`.

| Command | Result |
| --- | --- |
| `npm test` | Passed: 82 tests, 0 failed, 0 skipped, 0 cancelled; TAP duration 19,661.454 ms |
| Native CLI discovery inside `npm test` | Passed: Copilot CLI, OpenCode and Pi |
| `npm run typecheck` | Passed |
| `npm audit --audit-level=high` | Passed: 0 vulnerabilities |
| `npm pack --dry-run --json` | Passed: 85 entries, 91,359 bytes packed, 490,268 bytes unpacked; includes `ARCHITECTURE.md` |
| `node scripts/run-live-codex-leads.mjs all --verify-report-only` | Passed: both Codex live reports have the expected schema, status and freshness |
| `node scripts/run-live-lead.mjs --verify-report-only` | Passed: the Copilot v2 live report has the expected schema, status and freshness |
| `git diff --check` | Passed |

The offline suite covers the three fixed roles and six opt-in SDLC players,
direct zero-model lifecycle controls, all nine direct agent identities,
sequential orchestration, evidence handoff, failure cleanup, ownership,
collisions and native discovery in Copilot, OpenCode and Pi.

## Authenticated live acceptance evidence

The live tests require positive model usage from the root lead and every child,
the exact sequence
`portfolio-management -> design -> build -> manage -> consume -> dispose`,
maximum delegation concurrency of one, positive fixture verification and
deterministic roster/session cleanup.

| Harness | Runtime | Provider / model | Reasoning | Luna fallback | Duration | Turns | Tools | Observed tokens | Result |
| --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | --- |
| Copilot | 1.0.71 | `copilot/gpt-5.4-mini` | `low` | N/A | 36,439 ms | 18 | 15 | 115,434 | Passed |
| OpenCode | 1.18.3 | `openai/gpt-5.3-codex-spark` | `medium` | No | 113,318 ms | 18 | 17 | 57,847 | Passed |
| Pi | 0.80.10 | `openai-codex/gpt-5.3-codex-spark` | `low` | No | 32,605 ms | 18 | 15 | 50,272 | Passed |

The OpenCode and Pi reports were generated through the user's OpenAI Codex OAuth
session. `gpt-5.3-codex-spark` was present in both catalogs, so
`gpt-5.6-luna` was not selected. The final publication gate verified these
existing reports without repeating paid inference.

### Sanitized report digests

The detailed reports remain local under ignored `work/` paths. Their digests at
the time of this log were:

| Report | Generated at (UTC) | SHA-256 |
| --- | --- | --- |
| Copilot `live-team-lead-report.json` | `2026-07-20T23:12:09.416Z` | `14098d642edd018d56bf6410d935e98d53cc9ab6cd279327a68cc710fe92ae83` |
| OpenCode `live-opencode-team-lead-report.json` | `2026-07-20T23:05:59.546Z` | `b3a7409908891b2e8443884ae5a4efda62639e41cdf8ddd34736bbe5f43f91bb` |
| Pi `live-pi-team-lead-report.json` | `2026-07-20T23:06:42.592Z` | `d3d8f8048916752a657161466d2174565c891a0117376ef79c057d9ce2b8988` |

## Skill catalog and zero-token control gate

Recorded at `2026-07-20T23:21:04-04:00` from `main` working tree commit
`33246d0a2a9a2d9b978cdfaab838a340ad2f7b1d` plus the catalog changes under
review.

| Command | Result |
| --- | --- |
| `npm test` | Passed: 90 tests, 0 failed, 0 skipped, 0 cancelled; TAP duration 17,524.575 ms |
| Authenticated `node dist/cli.js pi list-skills` | Passed; compact `REPOSITORY`, `PATH`, `SKILL` output |
| Authenticated `node dist/cli.js copilot list-skills zx` | Passed; same compact filtered output |
| `npm audit --audit-level=high` | Passed: 0 vulnerabilities |
| `npm pack --dry-run --json` | Passed: 94 entries, 99,403 bytes packed, 535,127 bytes unpacked; `/contract` is the only packaged `agent-foundry` skill |
| `git diff --check` | Passed |

The offline suite verifies project-local catalog replacement, repository/folder/
exact-skill discovery, immutable GitHub branch resolution, no remote body
download during listing, ANSI presentation in native terminal surfaces, and the
absence of model-routed Copilot skill wrappers for all four deterministic
controls.

## Copilot catalog presentation gate

Recorded at `2026-07-20T23:26:14-04:00` from published commit `557f103` plus
the presentation changes under review.

| Command | Result |
| --- | --- |
| `npm test` | Passed: 91 tests, 0 failed, 0 skipped, 0 cancelled; TAP duration 17,210.488 ms |
| Authenticated Copilot-style catalog preview | Passed; bordered Unicode table with exactly `REPOSITORY`, `PATH`, and `SKILL` |
| `git diff --check` | Passed |

The Copilot extension selects its dedicated `copilot` presentation in the
zero-model command handler and labels the ephemeral timeline entry with
`0 model tokens`. ANSI color remains adaptive through `NO_COLOR` and `TERM`.

## Talent scout and description-filter gate

Recorded at `2026-07-20T23:42:21-04:00` from published commit `557f103` plus
the scout, catalog-description, editable-role, and presentation changes under
review.

| Command | Result |
| --- | --- |
| `npm test` | Passed: 95 tests, 0 failed, 0 skipped, 0 cancelled; TAP duration 21,110.807 ms |
| `npm run typecheck` | Passed |
| Authenticated `node dist/cli.js copilot list-skills --descriptions` | Passed; four-column metadata-only output with the real `zx-example-author` description |
| Authenticated trusted-skill filter for `scripts zx automatizar` | Passed; returned only the exact allowlisted `zx-example-author` coordinates and public description |
| Native CLI discovery inside `npm test` | Passed: Copilot CLI, OpenCode and Pi; Copilot discovered `/scout` and `agent-foundry:talent-scout` |
| `npm audit --audit-level=high` | Passed: 0 vulnerabilities |
| `npm pack --dry-run --json` | Passed: 112 entries, 107,453 bytes packed, 595,391 bytes unpacked; includes the scout agent, generated scout core, and fixed role Markdown |
| `git diff --check` | Passed |

The suite proves that the scout tools are unavailable to ordinary OpenCode
agents, invocation-scoped in Pi, and isolated in a Copilot `--scout` MCP
process that rejects the general lifecycle control. Its join still passes
through the shared validation and ownership transaction. Catalog description
tests verify opt-in rendering and filtering without exposing instruction
bodies, commits, or blobs.

## Retired repo-cartographer plugin gate

Recorded at `2026-07-20T23:49:48-04:00`.

| Command | Result |
| --- | --- |
| `npm test` | Passed: 95 tests, 0 failed, 0 skipped, 0 cancelled; TAP duration 13,800.407 ms |
| `npm run typecheck` | Passed |
| `npm audit --audit-level=high` | Passed: 0 vulnerabilities |
| `npm pack --dry-run --json` | Passed: 87 entries, 104,200 bytes packed, 479,467 bytes unpacked; contains only `agent-foundry` |
| `copilot plugin list` after uninstall | Passed: only `agent-foundry@agent-harbor` remains installed |
| `git diff --check` | Passed |

The retired plugin directory, manifest, duplicated runtime, agents, and
repository-mapping skill are absent. `crafter` remains functional as
`agent-foundry:crafter` with its player-scoped skill MCP, and the startup roster
now contains exactly `team-lead` and `crafter` plus the six opt-in SDLC peers.
