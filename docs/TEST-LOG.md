# Test log

This append-only log records bounded, sanitized validation evidence; individual
sections identify their date and relevant baseline. It intentionally excludes
prompts, responses, hidden fixture values, temporary paths, commands selected by
a model, raw errors, and credentials.

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
agents, invocation-scoped in Pi, and isolated to the Copilot scout principal.
That historical transport was replaced by extension-owned native custom tools
in the no-server gate recorded below. Its join still passes
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
`agent-foundry:crafter` with a player-bound skill loader, and the startup roster
now contains exactly `team-lead` and `crafter` plus the six opt-in SDLC peers.

## Current-profile-only roster gate

Recorded at `2026-07-20T23:55:10-04:00`.

| Command | Result |
| --- | --- |
| `npm test` | Passed: 91 tests, 0 failed, 0 skipped, 0 cancelled; TAP duration 13,020.698 ms |
| `npm run typecheck` | Passed |
| `npm audit --audit-level=high` | Passed: 0 vulnerabilities |
| `npm pack --dry-run --json` | Passed: 87 entries, 102,472 bytes packed, 469,555 bytes unpacked; contains only `agent-foundry` |
| Removed-reference scan across source, generated runtime, tests, scripts, plugin and documentation | Passed |
| `git diff --check` | Passed |

Ownership now recognizes only the canonical revision-4 structure. Other
metadata fails closed as an unmanaged collision: it is neither activated,
overwritten nor deleted. Bench inventory and mutation planning contain no
retired-roster discovery, reservation, cleanup or reporting paths.

## Markdown bundled-roster gate

Recorded at `2026-07-21T00:01:41-04:00`.

| Command | Result |
| --- | --- |
| `npm test` | Passed: 91 tests, 0 failed, 0 skipped, 0 cancelled; TAP duration 18,968.116 ms |
| `npm run typecheck` | Passed |
| `npm audit --audit-level=high` | Passed: 0 vulnerabilities |
| `npm pack --dry-run --json` | Passed: 102 entries, 107,134 bytes packed, 481,655 bytes unpacked; contains both Markdown roster directories in the package and Copilot runtime |
| `git diff --check` | Passed |

The six bundled definitions load from closed-frontmatter Markdown under
`src/core/bundled/`. Tests verify their canonical order and tools, parser
failure modes, source-to-dist copies, and byte-identical Copilot runtime copies.

## Direct joined-player command gate

Recorded at `2026-07-21T00:09:02-04:00`.

| Command | Result |
| --- | --- |
| `npm test` | Passed: 91 tests, 0 failed, 0 skipped, 0 cancelled; TAP duration 18,623.291 ms; installed Copilot, OpenCode and Pi smokes passed |
| `npm run typecheck` | Passed |
| `npm audit --audit-level=high` | Passed: 0 vulnerabilities |
| `npm pack --dry-run --json` | Passed: 102 entries, 107,782 bytes packed, 483,329 bytes unpacked |
| `git diff --check` | Passed |

`join` now reports `/<id> <request>`. Copilot and OpenCode register that exact
ID instead of a `harbor-`-prefixed alias, Pi registers a joined ID immediately,
and OpenCode delegation revalidates its target against the live roster so a
player joined during the session can be invoked without weakening ownership
checks.

## Empirical joined-player command gate

Recorded at `2026-07-21T00:22:00-04:00`.

| Check | Result |
| --- | --- |
| Copilot 1.0.73 | Joined personal command and agent discovered in project A; `/new-player` returned `LOCAL-COPILOT-PLAYER-OK`; both absent in project B |
| OpenCode 1.18.3 | Exact command/agent discovered only in project A; direct invocation returned `LOCAL-OPENCODE-PLAYER-OK`; `team-lead` delegated to it and returned `LOCAL-OPENCODE-DELEGATED-OK` |
| Pi 0.80.10 | Same RPC process changed from no command to `/new-player` source `extension`; authenticated invocation returned `LOCAL-PI-PLAYER-OK` |
| Filesystem | Registration and project-A active bytes matched for all runtimes; project B and real user-home registrations remained absent |
| Offline lifecycle | `join offline-player` passed in 92 ms with all HTTP proxies directed to an unreachable local port |
| Regression | `npm test` passed 93 tests; typecheck and `git diff --check` passed |

The empirical run also exposed that Pi can settle with a terminal provider error
without emitting `text_delta`. `PiOrchestrator` now recovers successful text
from the disposable child's settled transcript and includes bounded terminal
diagnostics when evidence is truly empty. Reproduction scripts and complete
local evidence remain under the ignored `work/empirical-join-20260721-0012/`.

## Default gvillarroel repository trust gate

Recorded at `2026-07-21T00:24:14-04:00`.

| Command | Result |
| --- | --- |
| `npm test` | Passed: 93 tests, 0 failed, 0 skipped, 0 cancelled; TAP duration 23,738.994 ms |
| `npm run build` and `npm run typecheck` | Passed |
| Authenticated `node dist/cli.js pi list-skills` | Passed: 70 rows across 7 gvillarroel repositories |
| Authenticated trusted-skill filter for `zx scripts automation` | Passed: returned 5 validated exact references; an oversized remote skill was excluded fail-closed |
| `git diff --check` | Passed |

The built-in trust roots and the project fixture now cover `knowledge`,
`marketplace`, `pi-menton`, `sdlc`, `skills`, `slidev-manim`, and `zx-harness`
on `refs/heads/main`. Each selected player still receives only its declared
exact `SKILL.md`, pinned to one commit and isolated from sibling files.

## Pi team observability adversarial gate

Recorded at `2026-07-21T02:41:08-04:00` after four bounded critique/correction
passes. The final pass reported no actionable high- or medium-severity finding.

| Command or check | Result |
| --- | --- |
| `npm run typecheck` | Passed |
| Focused adapters, contracts and Pi-team suite | Passed: 93 tests, 0 failed, 0 skipped, 0 cancelled |
| `npm run test:ts` | Passed: 124 tests, 0 failed, 0 skipped, 0 cancelled; TAP duration 20,504.530 ms |
| `npm test` clean-build canonical gate | Passed: 124 tests, 0 failed, 0 skipped, 0 cancelled; TAP duration 24,639.153 ms; installed Copilot, OpenCode and Pi smokes passed |
| Native Pi 0.80.10 RPC | Passed: real command discovery exposed `/team`; canonical smoke rendered its roster; manual `/team stop all` returned an informational zero-token success while idle |
| `npm pack --dry-run --json` | Passed: 113 entries, including compiled Pi team runtime/view and terminal-layout modules |
| `git diff --check` | Passed |

The gate covers searchable roster and live mission views, root/child hierarchy,
native model/thinking/usage with truthful lower bounds, per-root and stop-all
cancellation, stale repair, bounded history/concurrency, double-booking,
post-commit scout reconciliation, no-ghost preflight, metadata/task privacy,
lazy catalog isolation, wide Unicode and ANSI-safe 96-cell wrapping, and
privacy-safe event/transcript usage deduplication. Deterministic controls remain
zero-model paths.

## Copilot team observability adversarial gate

Recorded at `2026-07-21T04:18:29-04:00` after iterative manual review and an
independent bounded critic pass. The final critic verdict was `CLEAN` for the
three last reproduced race families.

| Command or check | Result |
| --- | --- |
| `npm run typecheck` | Passed |
| Copilot runtime, view, lifecycle, extension-contract, and behavioral focal | Passed: 22 tests; the runner grouped 19 host-race scenarios |
| Independent final re-audit | Passed: manual-selection event lag, pre-timeout terminal reconciliation, and contiguous tool-complete/session-idle ordering; no remaining reproduction in scope |
| `npm test` clean-build canonical gate | Passed: 154 tests, 0 failed, 0 skipped, 0 cancelled; TAP duration 23,414.160 ms; installed Copilot, OpenCode, and Pi smokes passed without a model request |
| `npm audit --audit-level=high` | Passed: 0 vulnerabilities |
| `npm pack --dry-run --json` | Passed: 120 entries, including generated Copilot runtime/view adapters and observability documentation |
| `git diff --check` | Passed |

The gate covers a zero-model `/team` view, native-registry readiness, truthful
starting/working/waiting/cleaning states, searchable roster and hierarchy,
32-row bounded rendering, concurrent personal-profile reads, model/reasoning
provenance, native usage lower bounds, task redaction, project isolation,
double-booking and root capacity, child admission reservation, stop-by-root or
child ID, selection restoration, refresh generations, third-party guard
compatibility, terminal buffering, and synchronous child-before-root terminal
ordering. Interactive output failures are surfaced; notification backlog and
host RPC hangs remain bounded.

### Copilot control-surface corrective pass

Recorded at `2026-07-21T04:34:55-04:00` after a fresh installed-SDK reproduction
and one bounded critic/fix/re-audit loop.

| Command or check | Result |
| --- | --- |
| `npm run typecheck` and `npm run build` | Passed |
| Copilot runtime, view, lifecycle, extension-contract, and behavioral focal | Passed: 23 tests; the runner grouped 21 host/UX scenarios |
| Fresh real Copilot SDK sequence | Passed: first `/team`, `/team design`, `/bench list design`, `/join`, `/retire`, and retired `/player`; usage stayed byte-identical with no assistant events |
| Active-work `/bench` safety regression | Passed: literal filters `stop` and `stop all` rendered enriched zero-model views with `abort=0`; the following explicit `/team stop <child-id>` produced the sole expected abort |
| Independent bounded re-audit | `CLEAN` after the `/bench` parser separation |
| `npm test` clean-build canonical gate | Passed: 155 tests, 0 failed, 0 skipped, 0 cancelled; TAP duration 24,609.251 ms; installed Copilot, OpenCode, and Pi discovery passed |
| `npm audit --audit-level=high` | Passed: 0 vulnerabilities |
| `npm pack --dry-run --json --silent` | Passed: 120 entries, 176,725 bytes packed, 802,591 bytes unpacked |
| `git diff --check` | Passed |

The corrective pass also verifies bounded authoritative recovery on the first
`/team`, enriched `/bench list <filter>` output, path-free immediate/restart
guidance after `/join`, concise `/retire`, and class-specific inactive-player
remediation for bundled benched, personal benched, stale/conflicted, and
missing/retired identities.

## Installed three-runtime team-management convergence gate

Recorded at `2026-07-22T07:47:12-04:00` after repeated command-by-command TUI
review. The final manual pass produced no new product criticism.

| Command or check | Result |
| --- | --- |
| Pi 0.81.1 real RPC tour with a loopback provider | Passed: live widget and `/team` exposed member, task, state, exact run route, configured/observed model, thinking, 18 native tokens, and `$0.00005`; provider cancellation, pre-model bench rejection, and idempotent retire all passed |
| Copilot CLI 1.0.73 real Linux TUI at 120×45 and 100×42 | Passed without login: roster, lead availability, SDLC coverage, shared activity scope, host telemetry provenance, join/reload guidance, retire, and idle stop remained visible and client-side |
| OpenCode 1.18.4 real Linux TUI at 140×82 and 140×45 | Passed: nine-row roster and activity fit without scrolling; filtered bench results expose exact ranges and the next route; help and stop views remained zero-model |
| OpenCode persistence/accounting comparison | Passed: sessions, database row counts, statistics, tokens, and cost were byte-identical before and after the tour |
| Focused regressions from manual criticism | Passed: Pi provider decimal-tail normalization, bounded project widget, Pi stop text scope, and idempotent Copilot native abort |
| `npm test` clean-build canonical gate | Passed: 498 tests, 0 failed, 0 skipped, 0 cancelled; 73 capture-hardening tests also passed; total wall time 78.5 s |
| `npm run typecheck` and `git diff --check` | Passed |
| `npm audit --audit-level=high` | Passed: 0 vulnerabilities |
| `npm pack --dry-run --json --silent` | Passed: 6,896,133 bytes packed; 9,153,396 bytes unpacked |
| MCP implementation scan | Passed: no MCP registration, server, daemon, or transport; matches are only disable flags, absence tests, and explanatory documentation |

Manual review found and corrected two visible defects: Pi displayed the provider's
IEEE-754 tail (`$0.000049999999999999996`) instead of the useful native decimal
amount, and Copilot clipped its idle shared-activity explanation. The final
clean-build stress gate then exposed and fixed a duplicate Copilot abort race:
ownership loss and timeout now share one idempotent host-abort promise per run.

Local ignored evidence is retained under
`work/pi-local-provider-tour/runs/2026-07-22T112620-221Z/`,
`work/copilot-real-final-20260722-0731/`, and
`work/opencode-real-final-20260722-0744/`.

## Independent subagent follow-up and final active-work gate

Recorded at `2026-07-22T08:26:42-04:00`. The requested independent subagent
first returned `NOT CLEAN` with four reproducible gaps: unnecessary Pi model
abbreviation, an out-of-range OpenCode help example, missing catalog pagination
syntax in Pi/Copilot help, and installed tours whose hashes or idle-only scope
did not prove the final active-work experience. All four were corrected and the
same subagent's bounded re-audit returned `CLEAN`.

| Command or check | Result |
| --- | --- |
| Pi 0.81.1 final active RPC tour | Passed: complete `harbor-local/known-usage (observed)` identity, thinking, 18 tokens, `$0.00005`, task, exact run route, active provider cancellation, bench preflight, and idempotent retire |
| Copilot CLI 1.0.73 final-hash active TUI tour | Passed: a real shared claim rendered `crafter/shared-crafter · working`, owner Pi/PID and `stop there`; exact owner release changed the next view to `0 active`; the complete tour remained client-side with 0 model tokens |
| OpenCode 1.18.4 final-hash localhost lifecycle tour | Passed: joined/reloaded personal reviewer rendered working task, owner, observed `harbor-local/harbor-zero`, tokens and `$0`; active stop closed the provider connection after 99 ms and rendered `Stop confirmed` after 228 ms; benched alias made no provider request |
| OpenCode 1.18.4 final-hash zero-model TUI tour | Passed: help contains the valid `/team status:bench page:2` example, filtered output exposes its next-page route, and sessions/database/statistics/tokens/cost remain byte-identical |
| Catalog help and executable pagination | Passed: Pi and Copilot advertise `[--page N]`; the shared parser rejects invalid/duplicate pages and emits exact next/previous routes |
| Shared custom-tool/no-MCP focal | Passed: 2 tests prove a minimal dynamic principal-bound tool union, common closed schemas, and no MCP surface |
| Independent re-audit | `CLEAN` for all four findings; final Copilot and OpenCode artifact hashes match the current worktree/builds |
| `npm test` clean-build canonical gate | Passed: 498 tests, 0 failed, 0 skipped, 0 cancelled; 73 capture-hardening tests passed; total wall time 79.5 s |

Final ignored evidence is retained under
`work/pi-local-provider-tour/runs/2026-07-22T120238-869Z/`,
`work/copilot-real-final-20260722-0813-active/`,
`work/opencode-lifecycle-20260722-081729-80f3b1a3a506/`, and
`work/opencode-real-final-20260722-0822/`.

## Prek repository quality gate

Recorded at `2026-07-22T15:46:16-04:00` after installing the pinned npm binary,
registering both Git shims, and exercising the local and CI-equivalent paths.

| Command or check | Result |
| --- | --- |
| `npm ci` | Passed: 41 packages installed from the lockfile; 0 vulnerabilities |
| `prek validate-config prek.toml` | Passed |
| `npm run quality` | Passed: all 14 whole-tree builtin hooks |
| Explicit `prek.toml` and workflow check | Passed: TOML and YAML validation included the new untracked files |
| `actionlint` 1.7.12 | Passed: `.github/workflows/quality.yml` |
| Pre-push stage | Passed: repository checks and `typescript-typecheck` |
| `npm test` clean-build canonical gate | Passed: 498 tests, 0 failed, 0 skipped, 0 cancelled; 73 capture-hardening tests passed; TypeScript TAP duration 123,123.834 ms |
| Installed-CLI compatibility retry | Passed: 14/14 focused tests, including Copilot, OpenCode, and Pi |
| `npm audit --audit-level=high` | Passed: 0 vulnerabilities |
| `npm pack --dry-run --json --silent` | Passed: 165 entries, 6,899,252 bytes packed, 9,163,628 bytes unpacked |

The first concurrent full-suite attempt reported the three installed-CLI
discovery subtests as failures. The focused compatibility file then passed all
14 tests, and a subsequent complete clean-build run passed all 498 tests. No
product change was needed for that transient local integration result.
