# Harbor Evaluation Dataset Authoring Contract

This contract governs the design, deterministic planning, materialization, and
preflight audit of native Harbor tasks before a study registers them. It does
not define Harbor jobs, rewards, result aggregation, candidate selection,
dataset locks, release events, or promotion.

## Contents

- [Roles and authorities](#roles-and-authorities)
- [Population and family inventory](#population-and-family-inventory)
- [Split contract](#split-contract)
- [Deterministic authoring plan](#deterministic-authoring-plan)
- [Response profiles](#response-profiles)
- [Seeded surface variation](#seeded-surface-variation)
- [Adapter and verifier contract](#adapter-and-verifier-contract)
- [Pre-seal quality gates](#pre-seal-quality-gates)
- [Leakage and access controls](#leakage-and-access-controls)
- [Resource and hardware identity](#resource-and-hardware-identity)
- [Handoff to the study organizer](#handoff-to-the-study-organizer)
- [Interpretation limits](#interpretation-limits)
- [Research and platform basis](#research-and-platform-basis)

## Roles and Authorities

Keep four responsibilities distinct:

| Responsibility | Owner | Output |
| --- | --- | --- |
| Define task population, semantic families, response profiles, nuisance axes, and split policy | Dataset curator | Private reviewed blueprint |
| Render native Harbor task roots and test their oracles and verifiers | Dataset-specific adapter and reviewer | Separate materialized split roots |
| Register bytes, compute SHA-256 locks, order stages, and release sealed cohorts | `harbor-organize-evaluations` | Study ledger, locks, and derived indexes |
| Run and score tasks or compare baseline and candidate | The applicable Harbor evaluation or evolution skill | Native Harbor jobs and reports |

The same person may perform more than one role for a low-risk internal study,
but validation and holdout approval must remain operationally independent from
candidate generation. No authoring output grants permission to inspect a sealed
cohort during evolution.

Use explicit split names. Avoid generic directories named `eval` or `test`
without a declared role because different tools use those words for both
optimizer-visible and optimizer-invisible data.

## Population and Family Inventory

Write the evaluation claim before sampling tasks:

- target users and task population
- competency and failure modes under test
- outcome and process variables
- deployment-relevant languages, platforms, domains, and difficulty bands
- unit of statistical independence or resampling
- inclusion and exclusion rules
- resource, hardware, network, and tool envelope
- known public-source or pretraining contamination risks
- expected use, prohibited use, and retirement policy

Every planned case belongs to a semantic family. Define family membership
conservatively. Cases share a family when they derive from any common element
that could reveal the solution pattern:

- source record, document, corpus item, user, author, or organization
- repository, issue, pull request, codebase, schema, or fixture set
- task template, generator branch, transformation chain, or prompt skeleton
- gold answer, oracle derivation, reference patch, or algorithmic solution
- identical or near-identical world state with only names, values, or prose changed
- variant parent or manually recognized semantic clone

Capability tags should span splits so each split measures the intended
competency. Family, source, template, oracle, and variant-parent identities must
not span optimizer-visible and sealed splits. Split at the broadest credible
cluster: for repository tasks this may be the repository rather than the issue;
for user-authored text it may be the user rather than one prompt.

Record provenance, license, sensitivity, collection time, and source revision.
Pin mutable sources by commit or content digest. Do not use `latest`, an unpinned
branch, an unversioned remote file, or a live external state as the identity of
a sealed task.

## Split Contract

| Split | Optimizer visibility | Valid uses | Release rule |
| --- | --- | --- | --- |
| `discovery` | Visible | Baseline smoke, failure mining, taxonomy discovery | May be reused within its declared role |
| `development` | Visible | Mutation, reflection, ranking, merging, candidate selection | May be reused only within the fixed development budget |
| `validation` | Sealed | One-way evaluation of one digest-frozen development winner | Release once; any feedback-driven revision ends the study |
| `holdout` | Sealed | Optional final unchanged-baseline versus frozen-winner gate | Release only after validation; retire after detailed disclosure |

An evolution-oriented plan requires non-empty `development` and `validation`.
`discovery` and `holdout` are optional. If only two cohorts are affordable, the
second can support an unbiased test only when its outcome does not cause another
selection or mutation. If it does, reclassify it as visible evidence and create
fresh validation for a new study.

Assign families before materializing task variants. Use stratified targets at
the family level for capability, domain, difficulty, response profile, and
resource class. A family with ten variants is one independent group, not ten
independent samples. Report both family-level and task-level coverage.

Predeclare the partition seed and quotas before candidate results exist. Never
try several seeds or allocations and keep the split that makes a candidate look
best. Manual overrides require a recorded reason and must not move one family
based on observed performance.

## Deterministic Authoring Plan

The bundled planner consumes a private JSON blueprint and a private seed file.
It validates the following versioned blueprint shape:

~~~json
{
  "schemaVersion": 1,
  "datasetId": "example-skill-evaluation-v1",
  "splitWeights": {
    "development": 1,
    "validation": 1
  },
  "coverageRequirements": {
    "development": {
      "minimumFamilies": 1,
      "minimumTasks": 1,
      "responseModes": {"single_file": 1},
      "strata": {
        "capability": {"artifact-authoring": 1},
        "domain": {"data-analysis": 1},
        "difficulty": {"medium": 1},
        "resourceClass": {"cpu-standard": 1}
      }
    },
    "validation": {
      "minimumFamilies": 1,
      "minimumTasks": 1,
      "responseModes": {"single_file": 1},
      "strata": {
        "capability": {"artifact-authoring": 1},
        "domain": {"data-analysis": 1},
        "difficulty": {"medium": 1},
        "resourceClass": {"cpu-standard": 1}
      }
    }
  },
  "families": [
    {
      "familyId": "summarize-records-a",
      "sourceId": "source-batch-a-2026-09",
      "templateId": "summary-template-a-v2",
      "strata": {
        "capability": "artifact-authoring",
        "domain": "data-analysis",
        "difficulty": "medium",
        "resourceClass": "cpu-standard"
      },
      "cases": [
        {
          "taskId": "summarize-records-a-01",
          "responseMode": "single_file",
          "variantAxes": {
            "input_root": ["inputs", "fixtures/raw", "data/source"],
            "output_name": ["summary.md", "report.md", "findings.md"],
            "output_root": [".", "results", "artifacts/final"]
          }
        }
      ]
    },
    {
      "familyId": "summarize-records-b",
      "sourceId": "source-batch-b-2026-09",
      "templateId": "summary-template-b-v2",
      "strata": {
        "capability": "artifact-authoring",
        "domain": "data-analysis",
        "difficulty": "medium",
        "resourceClass": "cpu-standard"
      },
      "cases": [
        {
          "taskId": "summarize-records-b-01",
          "responseMode": "single_file",
          "variantAxes": {
            "input_root": ["inputs", "fixtures/raw", "data/source"],
            "output_name": ["summary.md", "report.md", "findings.md"],
            "output_root": ["workspace", "results", "artifacts/final"]
          }
        }
      ]
    }
  ]
}
~~~

The private seed file supplies one partition seed and an independent variation
seed for every declared split:

~~~json
{
  "schemaVersion": 1,
  "partitionSeed": "38e84efebf3b4c41e8e631ac1c860de4ce153ac6441f9c5ffce09241421b6e83",
  "variantSeeds": {
    "development": "16c8e8dbd9a8313fa8750df5f4035efafdd3526b2488219c1af237bd8cb0cb09",
    "validation": "8e1da55204cccfc2ddb5ed66c5daf73d8dc2ae13b6000b4c9f442de3388f79be"
  }
}
~~~

The shown seeds demonstrate the required 64-character lowercase hexadecimal
serialization; do not reuse them. Generate independent 32-byte values with a
cryptographically secure generator. The planner checks syntax and separation,
not whether a value was generated with adequate entropy. Store sealed-cohort
seeds outside Git and outside any workspace available to the optimizer.

`coverageRequirements` must contain exactly every declared split. Its
`minimumFamilies` and `strata` minima count semantic families;
`minimumTasks` and `responseModes` minima count task cases. Each family declares
one primary value for `capability`, `domain`, `difficulty`, and `resourceClass`.
The coverage-aware allocator uses all four dimensions plus response profiles,
then fails closed if any declared minimum is unmet. When a feasible-looking
inventory still fails the deterministic greedy allocation, revise the family
inventory, split design, or declared estimand before candidate evaluation; do
not search partition seeds using candidate performance.

The planner writes
`plan.private.json` and `summary.redacted.json` to a new output directory. The
private plan contains only domain-separated seed commitments, never raw seeds.
The redacted summary contains neither raw seeds nor individual seed-commitment
fields; its `planCoreSha256` necessarily binds the complete private plan
indirectly.
`datasetId` is deliberately retained in the redacted summary as public routing
metadata. Choose a non-sensitive collection identifier that does not encode a
task name, source lineage, hidden cohort membership, or answer detail.

The plan must satisfy these properties:

- canonical output and stable IDs for the same inputs
- independence from blueprint enumeration order and worker count
- whole-family split assignment
- deterministic, task-keyed pseudorandom selection across equivalent nuisance
  values, with the realized distribution audited before sealing
- distinct seed domains for partitioning and for each split's variations
- no runtime random choice by the verifier
- no task, answer, path, or seed detail in the redacted summary for sealed splits
- a digest binding the complete private plan and a reviewed redacted projection

The output is published by an atomic directory rename after both files are
written; an existing destination is never replaced. `verify --plan-dir` proves
canonical structure and pairwise self-consistency, not authorship or source
provenance. For strong reproducibility verification, supply the original
private inputs and compare the regenerated bytes in memory:

~~~powershell
python <skill-root>/scripts/plan_harbor_task_datasets.py verify `
  --plan-dir <private-plan-dir> `
  --blueprint <dataset-blueprint.json> `
  --seeds <private-seeds.json>
~~~

The strong form still does not provide a digital signature or prove seed
custody. Authenticate and authorize the private inputs separately when the
threat model includes deliberate tampering.

A deterministic plan is not yet a dataset. A dataset-specific adapter renders
each planned record into a native Harbor task root. Regenerate into a second
empty directory and compare canonical tree digests before sealing. Moving the
output root must not change task bytes when the root itself is not an explicit
task input.

## Response Profiles

Declare the authoritative observable for every case. The final natural-language
message is not authoritative when a file, repository, service, browser, or
other world state is the requested result.

| `responseMode` token | Response profile | Authoritative verification | Accidental shortcuts to avoid |
| --- | --- | --- | --- |
| `scalar` | Short scalar or category | Normalized exact value and an explicit set of accepted aliases | Broad substring or keyword presence |
| `numeric` | Numeric quantity | Parsed finite value, declared units, bounds, and justified absolute or relative tolerance | String equality, silent unit conversion, `NaN` or infinity acceptance |
| `structured` | Structured object | Schema plus semantic field checks and a declared extra-field policy | Byte comparison, whitespace, or JSON key order |
| `collection` | Set, multiset, or table | Parsed collection with keyed, set, multiset, or ordered semantics stated explicitly | Requiring incidental row or column order |
| `open_text` | Open text or document | Decomposed required and forbidden claims, evidence checks, and calibrated semantic review | Keyword stuffing or one uncalibrated judge score |
| `single_file` | Single file | Declared artifact identity plus parsed content or behavior | One universal filename across unrelated tasks |
| `multi_file` | Multi-file tree | Manifest of required roles, relationships, content, and allowed extras | Checking only that one directory exists |
| `in_place_edit` | In-place edit | Required change plus preservation and regression assertions | Accepting a replacement that discards unrelated state |
| `code` | Code, patch, or CLI | Build or import checks, black-box behavior, properties, and regressions | Exact gold patch, implementation text, or source layout |
| `service_state` | Service, browser, or external state | Direct inspection of the isolated changed state | Trusting stdout or the final response |
| `mixed` | Mixed outcome | Separate checks and weights for each artifact or state dimension | Collapsing correctness into one brittle proxy |
| `trajectory` | Trajectory or process | A separate process reward when process is the declared construct | Penalizing harmless implementation choices |

For outputs with several correct representations, define a semantic equivalence
class and accept all members. If a particular path, format, or filename is a real
requirement, state it in the instruction and verify that explicit contract. Do
not hide an interface requirement in a private test.

## Seeded Surface Variation

Separate three kinds of diversity:

1. **Semantic diversity** changes the underlying problem or source family and
   is necessary for broader generalization.
2. **Nuisance-surface diversity** changes a convention that a robust solution
   should read from the task contract rather than memorize.
3. **Experimental randomization** changes paired trial order or attempt seeds to
   reduce temporal drift. It is owned by the evaluation protocol, not the task
   adapter.

Safe nuisance axes, when compatible with the target population, include:

- current working directory and nesting depth
- input root, input filename, or multiple input layout
- output root, filename, extension, and flat or nested layout
- single artifact versus coordinated artifact set
- create-new versus edit-in-place workflow
- text, Markdown, JSON, JSONL, CSV, YAML, or another explicit carrier
- declared CLI argument, environment variable, or configuration-file carrier
- irrelevant ordering of JSON fields, set-like rows, or independent files
- legitimate casing, aliases, or path styles
- harmless decoys or pre-existing artifacts that do not make the task ambiguous
- paraphrased instructions reviewed for semantic equivalence

Do not vary:

- `task.toml`, the native instruction location, or the verifier entrypoint
- Harbor's reward and artifact transport protocol
- an undeclared requirement that the agent must guess
- timeout, network, CPU, GPU, memory, or tool availability unless that factor is
  an intentional stratum and is paired identically across treatment arms
- the oracle or correctness rule without classifying the result as semantic
  variation and assigning the appropriate family identity

Audit nuisance-value distributions across capabilities and difficulty. A
surface must not become a label, such as every positive task using JSON, every
hard task using a nested directory, or every development task using
`answer.txt`. The bundled planner uses split-specific keyed rendezvous hashing
over `(split, axis, taskId, option)`, not a mutable global RNG stream. Adding a
task cannot change another task's selected surface while that task's split,
axis, option set, ID, and split seed remain unchanged. A task that moves to a
different split intentionally receives that split's independently keyed
surface. Adding or removing an option may also change selections and therefore
requires a new append-only dataset version.

Independent keyed assignment is mutation-stable but gives statistical rather
than exact global balance. Inspect the realized private-plan distribution before
sealing. If exact factorial balance is part of the estimand, encode that design
in the family inventory or a reviewed frozen assignment manifest; do not search
seeds until a visually pleasing distribution appears, and never use candidate
results to select a seed.

Each axis needs a metamorphic contract:

- input or world transformation
- corresponding instruction and expected-output transformation
- invariant or directional reward expectation
- validity preconditions
- replayable counterexamples discovered during testing

Randomizing a path measures robustness to path contracts. It does not create a
new semantic family or prove transfer to unseen work.

## Adapter and Verifier Contract

A dataset-specific adapter should support Harbor's stable adapter interface and
add explicit authoring controls where relevant:

- output directory and overwrite policy
- deterministic task selection or limit
- declared split
- seed or seed-file input
- source lock or pinned revision
- plan or dry-run mode
- private manifest output
- stable adapter and generator version

For identical pinned sources, blueprint, adapter bytes, and seed material, the
adapter must produce identical task bytes regardless of source enumeration,
temporary output location, or concurrency. Prefer task-scoped keyed derivation
over a process-global PRNG. Record the algorithm and version.

Keep the instruction, fixture transformation, oracle, and verifier aligned. If
the plan changes `output_root` to `artifacts/final`, the rendered instruction
must say so and the verifier must inspect that location. If location is
irrelevant, discover the declared artifact or validate a manifest rather than
requiring a hidden path.

Use deterministic checks before semantic judgment:

1. environment and required-artifact presence
2. parsing, schema, type, and bounds
3. behavioral and state assertions
4. invariants and prohibited side effects
5. semantic rubric for irreducible judgment

Freeze a semantic judge's model, dated version, prompt, rubric, evidence window,
decoding, and ordering policy. Calibrate against blinded representative human
labels and preserve disagreements and error estimates. Prefer pass/fail or
pairwise criteria over an unconstrained holistic score.

Do not share one unchecked implementation between generator, oracle, and
verifier. Cross-check high-risk computations with an independent implementation
or review. A shared bug can give the reference solution 100% while invalidating
the construct.

## Pre-Seal Quality Gates

Run all applicable gates before any candidate evaluation:

### Solvability and contract clarity

- independent reviewer can solve the instruction using only declared inputs
- reference solution passes every materialized task
- no hidden filename, path, dependency, network, or resource requirement
- task has a justified timeout and resource envelope
- required state reset prevents cross-task and cross-arm residue

### Verifier sensitivity and specificity

- at least two structurally different valid alternatives pass where possible
- empty and malformed output fail
- correct content in a contractually wrong location fails only when location is
  an explicit requirement
- `answer.txt`-only and fixed-`/app` shortcut solutions fail on tasks whose
  explicit contracts require something else
- copied gold, decoy selection, constant output, partial output, and equivalent
  realistic cheats fail
- semantic mutants fail or move the reward in the declared direction
- incidental formatting transformations preserve reward
- parser fuzzing is deterministic and important counterexamples become fixed
  regression cases
- repeated verifier runs on fixed state return the same finite bounded reward

### Dataset coverage

- every family and task belongs to exactly one split
- development and validation are non-empty
- source, family, template, oracle, and variant-parent intersections are empty
  across the visible/sealed boundary
- response profiles meet predeclared task-level minima, while capability,
  domain, difficulty, and resource-class strata meet predeclared family-level
  minima
- exact duplicate hashes are absent across all splits
- normalized or semantic similarity candidates receive human disposition
- trigger-positive, near trigger-negative, and adverse cases are included when
  natural skill discovery is part of the estimand

### Reproducibility and provenance

- regeneration from the same inputs produces the same canonical plan and bytes
- shuffled input enumeration and changed worker count do not alter output
- source, adapter, generator, instruction, environment, verifier, oracle, task,
  and container identities are digest-bound
- reviewer, timestamp, inclusion reason, exclusion reason, and limitations are
  recorded
- no task is removed or repaired because of a candidate result

## Leakage and Access Controls

Treat validation and holdout content as confidential evaluation material. Keep
their complete blueprints, task IDs when identifying, prompts, answers,
solutions, tests, verifiers, seeds, per-case metadata, and diagnostics:

- outside tracked Git content and its accessible history
- outside the candidate and evolution workspaces
- outside agent-readable container layers and build contexts
- outside prompts, traces, logs, result artifacts, and model-judge context not
  authorized for the gate
- behind role-based access controls with access and release records

Use a verifier environment separate from the agent when the task and Harbor
runtime support it. Restrict network access when the agent could retrieve a
public issue, patch, answer, or close variant. Scan instructions, fixtures,
filenames, comments, environment variables, image layers, Git history, logs,
artifacts, and network endpoints for oracle leakage.

A digest proves byte identity, not secrecy. Short answers can be brute-forced
against individual hashes, and a seed can reconstruct every variant. Publish a
reviewed aggregate snapshot commitment rather than per-answer digests or a
reconstructable manifest. Canaries and encryption are defense in depth, not a
substitute for access control.

Detailed disclosure consumes a sealed cohort for ordinary future promotion
claims. Record it as released, retired, contaminated, invalid, or superseded;
never silently treat it as sealed again.

## Resource and Hardware Identity

When performance or feasibility depends on hardware, bind at least:

- CPU architecture, model when relevant, core quota, and concurrency
- RAM and swap limits
- GPU or accelerator model, count, driver, firmware, and runtime
- storage class, capacity, and meaningful I/O limits
- operating system, kernel, container or VM image digest
- warm or cold cache policy and preloaded model or dataset state
- network policy, provider region or locality, and external services
- wall-clock and per-process timeouts

Do not compare baseline and candidate on different resource envelopes. A changed
hardware or cache profile is a changed task world unless the estimand explicitly
models that factor. Separate capability correctness from latency, throughput,
memory, energy, or cost rewards so a resource gain cannot hide a critical
correctness regression.

## Handoff to the Study Organizer

Before registration, provide the organizer with one completed native Harbor root
per split and a private curator record containing:

- dataset ID and append-only version
- source identities, revisions, licenses, and digests
- adapter and generator identities and digests
- split policy and family-level coverage summary
- private seed custody reference and non-secret commitments
- task, instruction, environment, verifier, oracle, and container digests
- response-profile and nuisance-axis coverage
- overlap, near-duplicate, leakage, oracle, alternate-valid, mutant, and
  reproducibility audit outcomes
- curator and independent reviewer identity, time, and limitations

Do not call this record a Harbor dataset lock. `harbor-organize-evaluations`
rehashes the actual task roots and produces the authoritative locks. Register
all splits before execution, plan the downstream validation stage before
evolution, and keep the detailed curator record private.

## Aggregate Report Publication

Use the bundled consolidator only on schema-version-1 `final-report.json`
artifacts already produced by `harbor-run-results`. That native reporter owns
raw Harbor parsing, reward interpretation, completeness checks, and within-run
fairness validation. The consolidator is a sanitized presentation layer, not a
replacement evaluation or normalization runtime.

Every published comparison must surface, when available:

- requested, completed, passed, verifier-failed, and execution-error counts
- pass rate and mean primary reward with the reward coverage count
- input tokens, cached input as a subset, output tokens, optional reasoning
  tokens, and total tokens defined as input plus output
- USD cost totals and observation coverage
- summed agent-execution time, end-to-end wall time, per-trial latency, and
  throughput
- cost per trial, cost per pass, tokens per trial, and deltas from the declared
  baseline
- native fairness basis and warnings, source timestamps, and SHA-256
  commitments for every input report
- the hardware, cache, concurrency, network, model, agent, task, attempt, and
  lock identities needed to interpret the comparison, either in the source
  report or its bound study protocol

Never add cached input to total input a second time. Keep reasoning tokens
separate unless a frozen provider-specific accounting contract proves they are
exclusive. Refuse NaN, infinity, negative resource usage, inconsistent pass
counts, impossible timestamps, and totals that contradict their declared
components. A missing metric remains `n/a`; a partial total must state its
observed-trial numerator and denominator. Incomplete token, cost, or
agent-time coverage may be displayed with that fraction, but it must be
excluded from per-trial efficiency deltas and Pareto/frontier calculations.

Static SVG output must include an accessible title and description, legible
labels, units, a visible baseline, and textual tables carrying the same core
metrics. Visual encoding may not hide errors or imply that a higher reward
automatically compensates for correctness, cost, or latency regressions.
Pareto highlighting is descriptive and must not become a new selection rule
after the study protocol is frozen.

Only aggregate information authorized for the current release may enter a
consolidated report. Do not include task IDs, prompts, answers, fixture paths,
per-case results, verifier diagnostics, trajectories, or raw local paths.
Validation and holdout charts stay sealed until their one-way gate is released,
and their outcomes never return to same-study evolution.

## Interpretation Limits

- A private split does not correct pretraining contamination from public tasks.
- Different seeds from one generator estimate within-generator generalization,
  not transfer to new semantic families.
- A lexical, AST, or embedding similarity threshold cannot prove semantic
  independence; it only prioritizes review.
- A small validation or holdout gap does not prove the absence of overfitting.
  Report uncertainty for the declared task population and family clusters.
- A time split reduces some historical leakage but can confound difficulty,
  ecosystem, and distribution drift.
- A separate verifier prevents some direct leakage but cannot fix an incorrect
  oracle, weak coverage, or an unintended artifact channel.
- More sibling variants improve surface coverage but not the number of
  independent semantic groups.
- Randomness during scoring adds variance and selection opportunities. Use it
  only for an inherently stochastic construct with paired seeds, fixed attempts,
  and a predeclared aggregation rule.

## Research and Platform Basis

This local authoring contract operationalizes, but does not reproduce, the
methods or reported results in these sources:

- Harbor: [dataset adapters](https://www.harborframework.com/docs/datasets/adapters),
  [tasks and verifier isolation](https://www.harborframework.com/docs/tasks),
  [dataset publishing](https://www.harborframework.com/docs/datasets/publishing),
  and [results and artifacts](https://www.harborframework.com/docs/run-jobs/results-and-artifacts)
- Dwork et al., [Generalization in Adaptive Data Analysis and Holdout Reuse](https://papers.nips.cc/paper/5993-generalization-in-adaptive-data-analysis-and-holdout-reuse.pdf)
- Cawley and Talbot, [On Over-fitting in Model Selection and Subsequent Selection Bias in Performance Evaluation](https://www.jmlr.org/papers/volume11/cawley10a/cawley10a.pdf)
- Gebru et al., [Datasheets for Datasets](https://arxiv.org/abs/1803.09010)
- Ribeiro et al., [CheckList](https://aclanthology.org/2020.acl-main.442/)
- Cobbe et al., [Leveraging Procedural Generation to Benchmark Reinforcement Learning](https://proceedings.mlr.press/v119/cobbe20a.html)
- OpenAI, [Evaluation best practices](https://developers.openai.com/api/docs/guides/evaluation-best-practices) and [Separating signal from noise in coding evaluations](https://openai.com/index/separating-signal-from-noise-coding-evaluations/)
- The user-provided 2026-08-30 report *Modern Skill Evaluation and Evolution*,
  used for the frozen-treatment, layered-evidence, split-governance, and
  independent-promotion framing

The split-release semantics are intentionally stricter than workflows that use
validation repeatedly to filter several finalists: this repository releases
validation only after one candidate is frozen and requires fresh validation in
a new study after any feedback-driven revision.
