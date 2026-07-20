# Test log — 2026-07-20

Validation was completed on branch `agent/harbor-live-orchestration` from base
commit `287bcd120eff887ec6e23f35411670e2af1cc435`. This file records only bounded,
sanitized evidence. It intentionally excludes prompts, responses, hidden fixture
values, temporary paths, commands selected by a model, raw errors and
credentials.

## Final offline gate

Recorded at `2026-07-20T17:25:57-04:00`.

| Command | Result |
| --- | --- |
| `npm test` | Passed: 61 tests, 0 failed, 0 skipped, 0 cancelled; TAP duration 21,351.585 ms |
| Native CLI discovery inside `npm test` | Passed: Copilot CLI, OpenCode and Pi |
| `npm audit --audit-level=high` | Passed: 0 vulnerabilities |
| `npm pack --dry-run --json` | Passed: 69 entries, 59,219 bytes packed, 284,391 bytes unpacked |
| `node scripts/run-live-codex-leads.mjs all --verify-report-only` | Passed: both Codex live reports have the expected schema, status and freshness |
| `git diff --check` | Passed |

The offline suite covers the three fixed roles and six opt-in SDLC players,
direct zero-model lifecycle controls, all nine direct agent identities,
sequential orchestration, evidence handoff, failure cleanup, ownership,
collisions and native discovery in Copilot, OpenCode and Pi.

## Authenticated live acceptance evidence

The live tests require positive model usage from the root lead and every child,
the exact sequence `scout -> sage -> smith -> probe -> guard -> pilot`, maximum
delegation concurrency of one, positive fixture verification and deterministic
roster/session cleanup.

| Harness | Runtime | Provider / model | Reasoning | Luna fallback | Duration | Turns | Tools | Observed tokens | Result |
| --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | --- |
| Copilot | 1.0.71 | `copilot/gpt-5.4-mini` | `none` | N/A | 44,422 ms | 20 | 23 | 110,982 | Passed |
| OpenCode | 1.18.3 | `openai/gpt-5.3-codex-spark` | `medium` | No | 103,674 ms | 19 | 18 | 44,544 | Passed |
| Pi | 0.80.10 | `openai-codex/gpt-5.3-codex-spark` | `low` | No | 31,110 ms | 19 | 18 | 38,840 | Passed |

The OpenCode and Pi reports were generated through the user's OpenAI Codex OAuth
session. `gpt-5.3-codex-spark` was present in both catalogs, so
`gpt-5.6-luna` was not selected. The final publication gate verified these
existing reports without repeating paid inference.

### Sanitized report digests

The detailed reports remain local under ignored `work/` paths. Their digests at
the time of this log were:

| Report | Generated at (UTC) | SHA-256 |
| --- | --- | --- |
| Copilot `live-team-lead-report.json` | `2026-07-20T17:23:46.132Z` | `5935141cf01c83f9e99c86d2f6abbf8d9493f8e1af1b783290871918e4325769` |
| OpenCode `live-opencode-team-lead-report.json` | `2026-07-20T21:07:52.752Z` | `ffa4fcab47b25aea1475dabf387027013fb02284162f29da8db434c76e55df5b` |
| Pi `live-pi-team-lead-report.json` | `2026-07-20T21:09:17.076Z` | `4824ff6971a46e79b62e91419e9c7e0bf9f5e6769ccf88ab82476beae5bd5c0e` |
