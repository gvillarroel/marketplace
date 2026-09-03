---
name: harbor-author-evaluation-datasets
description: Author and audit leakage-resistant native Harbor task datasets before study registration. Use when Codex needs to define semantic task families, partition discovery, development, sealed validation, and holdout cohorts, generate deterministic seeded response-surface variants, diversify artifact contracts, test adapters and verifiers against shortcuts, or hand completed dataset roots to harbor-organize-evaluations. Do not use to run or score Harbor jobs or to manage study releases.
---

# Harbor Author Evaluation Datasets

Create native Harbor task roots whose split membership, response contracts, and
verifiers support a credible skill-evolution claim. This bundle owns dataset
authoring and preflight only. `harbor-organize-evaluations` remains the owner of
dataset locks, stage ordering, validation and holdout release, and publication.
In commands, `<skill-root>` means this installed skill directory.

## Workflow

1. Read
   [references/dataset-authoring-contract.md](references/dataset-authoring-contract.md)
   completely before designing, generating, or changing a dataset.
2. Declare the target task population, competency, unit of independence,
   resource or hardware profile, primary outcome, hard gates, budgets, and
   known exclusions. Treat model, harness, tools, network, verifier, and
   environment identity as frozen study inputs, not incidental metadata.
3. Inventory sources and semantic families before generating variants. One
   family includes every case derived from the same source, template, fixture,
   repository or issue, oracle derivation, solution skeleton, or semantic
   clone. Assign a whole family to one split; a renamed path or a new seed does
   not create an independent family.
   Declare `capability`, `domain`, `difficulty`, and `resourceClass` for every
   family, plus task-level `responseMode` values. Predeclare minimum family,
   task, stratum, and response-mode coverage for every split; the planner must
   fail if the realized allocation misses a minimum.
4. Predeclare split roles before observing candidate results:

   - `discovery` is optional and optimizer-visible for smoke runs or failure
     mining.
   - `development` is mandatory and is the only split available to mutation,
     diagnosis, ranking, merging, or selection.
   - `validation` is mandatory, sealed, and released once for one frozen
     development winner.
   - `holdout` is optional and remains sealed until validation succeeds; use it
     for a higher-consequence final promotion claim.

   If a nominal test result informs another candidate change, that cohort is
   no longer an independent test. End the study and create fresh validation in
   a new study.
5. Define response profiles and nuisance axes. Vary agent-facing conventions
   such as input and output paths, filenames, nesting, artifact count, or
   serialization only when the instruction and verifier change together.
   Preserve native Harbor control paths such as `task.toml`, `instruction.md`,
   the verifier entrypoint, and `/logs/verifier/reward.json` or its supported
   fallback. Harbor does not require the agent to write `answer.txt`.
6. Create a deterministic private authoring plan. Keep the seed file outside
   Git and outside the evolution workspace for sealed splits:

   ~~~powershell
   python <skill-root>/scripts/plan_harbor_task_datasets.py plan `
     --blueprint <dataset-blueprint.json> `
     --seeds <private-seeds.json> `
     --output <private-plan-dir>
   ~~~

   Split families before assigning variants. Materialize variation at authoring
   time, not inside a trial or verifier. The same blueprint, seed inputs, and
   adapter version must reproduce the same plan independently of input order.
   Task-keyed rendezvous selection keeps an unchanged task's nuisance surface
   stable when its split, axis name, ID, option set, and split seed remain
   unchanged;
   inspect the realized distribution because mutation stability provides
   statistical, not exact, balance.
   Baseline and candidate must receive the exact same materialized task and
   variant.
7. Have dataset-specific adapters consume the private plan and emit separate
   native Harbor roots for each split. Keep stable task IDs for the same
   materialized configuration, avoid mutable source references such as
   `latest`, and record adapter, generator, source, instruction, environment,
   verifier, oracle, and task digests in the private provenance record.
8. Test every adapter and verifier before sealing:

   - the reference solution passes every task;
   - at least two materially different valid solutions pass where alternatives
     exist;
   - empty, malformed, copied-gold, fixed-path, wrong-directory, and other
     realistic shortcut solutions fail when they violate the declared contract;
   - nuisance transformations preserve the expected outcome;
   - semantic mutations fail or change the score in the predeclared direction;
   - repeated verifier runs are deterministic and return finite bounded rewards;
   - the authoritative artifact or world state is checked instead of trusting
     the agent's final message.

9. Audit cross-split leakage by task, source, family, variant parent, exact
   content, oracle lineage, and normalized near-duplicate signals. Similarity
   tooling creates a human-review queue; it cannot prove semantic independence.
   Review validation and holdout with an authority independent from evolution.
10. Verify the generated plan without modifying it:

    ~~~powershell
    python <skill-root>/scripts/plan_harbor_task_datasets.py verify `
      --plan-dir <private-plan-dir>
    ~~~

    This form checks canonical structure and self-consistency. Before sealing,
    also reproduce the plan from its private source inputs:

    ~~~powershell
    python <skill-root>/scripts/plan_harbor_task_datasets.py verify `
      --plan-dir <private-plan-dir> `
      --blueprint <dataset-blueprint.json> `
      --seeds <private-seeds.json>
    ~~~

    Neither form authenticates authorship; use separate access controls and
    signed provenance when deliberate tampering is in scope.

11. Freeze the materialized task bytes, move validation and holdout prompts,
    solutions, tests, full manifests, and seeds behind their declared access
    boundary, and register each completed split root with
    `harbor-organize-evaluations`. Let that skill create the authoritative
    SHA-256 dataset locks and govern release.

12. After authorized Harbor runs have already been normalized by
    `harbor-run-results`, optionally create a publication-safe comparison from
    one or more native `final-report.json` files:

    ~~~powershell
    python <skill-root>/scripts/consolidate_harbor_reports.py `
      <reports/run-a/final-report.json> `
      <reports/run-b/final-report.json> `
      --baseline <run-label-or-id> `
      --output-dir <publication/comparison-id>
    ~~~

    This companion does not read raw jobs, recompute rewards, or establish
    comparability. It emits aggregate-only Markdown and SVG views; use it only
    after the native reporter's task, model, agent, attempt, lock, and hardware
    checks have been preserved.

## Response and Verifier Routing

- Normalize exact scalar or categorical responses only according to declared
  aliases; do not use permissive substring checks.
- Check numeric results with declared units, finite-value rules, and justified
  absolute or relative tolerances.
- Parse structured outputs and compare schemas and semantics; ignore byte order,
  whitespace, field order, or row order when they are not part of the task.
- Verify single-file, multi-file, repository, CLI, service, browser, or other
  stateful outcomes through their authoritative artifacts and behavior.
- Use decomposed rubrics for open text or documents, freeze judge identity and
  prompt, and calibrate semantic judgment against blinded human review.
- Score process or trajectory requirements separately and only when the process
  itself is part of the construct.

The reference contract contains the complete response-profile and variation
catalog. Do not choose one valid representation randomly and reject other
semantically valid representations. Either accept the full equivalence class or
make a different representation an explicit task requirement.

## Aggregate Execution Comparison

`scripts/consolidate_harbor_reports.py` consumes only schema-version-1
`final-report.json` artifacts produced by `harbor-run-results`. It writes:

~~~text
<output>/
├── comparison-report.json
├── comparison-report.md
├── quality-comparison.svg
├── resource-comparison.svg
└── efficiency-frontier.svg
~~~

The report compares pass rate, mean reward, verifier and execution failures,
input, cached-input, output, optional reasoning, and total tokens, reported USD
cost, summed agent time, wall time, throughput, per-trial efficiency, and
baseline deltas. Cached input is already part of Harbor input tokens and is
never added twice. Reasoning tokens are shown separately because provider
accounting may overlap output tokens.

The SVGs are static, self-contained, accessible, and dependency-free. The
consolidator omits task names, prompts, answers, per-case diagnostics, raw
paths, trajectories, and skill contents. It records input SHA-256 commitments
and native fairness metadata, refuses invalid or inconsistent accounting, and
does not claim cross-report fairness. Missing metrics remain visibly missing;
observed partial totals are labeled with their coverage instead of being
silently treated as complete. Incomplete token, cost, or agent-time coverage
must not produce per-trial efficiency deltas or participate in Pareto/frontier
calculations.

Never expose sealed validation or holdout aggregates before their declared
release. Never feed the resulting charts or gate outcomes back into candidate
selection in the same study. A comparison across different hardware, task
locks, agents, models, attempts, or cache policies is descriptive unless the
study explicitly models and controls that difference.

## Boundaries

- Do not create another Harbor `JobConfig`, result, reward, ledger, dataset lock,
  optimizer, or promotion implementation in this bundle.
- Do not expose validation or holdout task names, prompts, answers, solutions,
  verifiers, seeds, paths, or case-level diagnostics to candidate generation.
- Do not randomize during scoring unless runtime randomness is the declared
  construct and its paired seed and attempt policy were fixed in advance.
- Do not interpret a secret split, a new seed from one generator, or a small
  generalization gap as proof of no overfitting. State the population and
  uncertainty the dataset can actually support.
- Do not overwrite a sealed task or silently exclude it after observing a
  candidate. Correct a defect through a new append-only dataset version with
  explicit provenance.
- Treat a split seed as reproducibility material, not as a security boundary.
  Generate independent 32-byte seeds with a cryptographically secure generator;
  the planner validates their 64-character lowercase hexadecimal encoding but
  cannot prove their entropy. Keep validation and holdout roots private and
  publish only a reviewed snapshot commitment and aggregate metadata.

## Validation

After changing this copied bundle, run:

~~~powershell
python <skill-creator-root>/scripts/quick_validate.py <skill-root>
python -m py_compile <skill-root>/scripts/plan_harbor_task_datasets.py
python -m py_compile <skill-root>/scripts/consolidate_harbor_reports.py
python <skill-root>/scripts/plan_harbor_task_datasets.py --help
python <skill-root>/scripts/consolidate_harbor_reports.py --help
~~~
