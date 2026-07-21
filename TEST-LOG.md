# Test log — 2026-07-20

Validation was completed in the working tree from base commit
`7bacf654ab3a73920bdad795a868b93ad08882cb`. This file records only bounded,
sanitized evidence. It intentionally excludes prompts, responses, hidden fixture
values, temporary paths, commands selected by a model, raw errors and
credentials.

## Final offline gate

Recorded at `2026-07-20T19:13:25-04:00`.

| Command | Result |
| --- | --- |
| `npm test` | Passed: 66 tests, 0 failed, 0 skipped, 0 cancelled; TAP duration 12,887.626 ms |
| Native CLI discovery inside `npm test` | Passed: Copilot CLI, OpenCode and Pi |
| `npm audit --audit-level=high` | Passed: 0 vulnerabilities |
| `npm pack --dry-run --json` | Passed: 69 entries, 62,886 bytes packed, 300,616 bytes unpacked |
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
