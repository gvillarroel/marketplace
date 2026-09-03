#!/usr/bin/env python3
"""Plan and verify group-disjoint, seeded Harbor dataset authoring work."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import tempfile
from collections import Counter, defaultdict
from contextlib import suppress
from pathlib import Path
from typing import Any


SCHEMA_VERSION = 1
TOOL_VERSION = "1.1.0"
PARTITION_ALGORITHM = "multistratum-coverage-greedy-sha256-v2"
VARIATION_ALGORITHM = "per-task-rendezvous-sha256-v2"
SUPPORTED_SPLITS = ("discovery", "development", "validation", "holdout")
MANDATORY_SPLITS = frozenset(("development", "validation"))
STRATA_DIMENSIONS = ("capability", "domain", "difficulty", "resourceClass")
RESPONSE_MODES = frozenset(
    (
        "scalar",
        "numeric",
        "structured",
        "collection",
        "open_text",
        "single_file",
        "multi_file",
        "in_place_edit",
        "code",
        "service_state",
        "mixed",
        "trajectory",
    )
)
ID_PATTERN = re.compile(r"^[a-z0-9][a-z0-9._-]{0,126}[a-z0-9]$|^[a-z0-9]$")
SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")
SEED_PATTERN = re.compile(r"^[0-9a-f]{64}$")
DOMAIN = "harbor-author-evaluation-datasets/v1"


class PlanError(ValueError):
    """A safe, user-facing plan validation failure."""


def canonical_bytes(value: Any) -> bytes:
    return (
        json.dumps(
            value,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        )
        + "\n"
    ).encode("utf-8")


def digest_value(value: Any) -> str:
    return hashlib.sha256(canonical_bytes(value)).hexdigest()


def keyed_digest(secret: str, *parts: str) -> str:
    payload = [DOMAIN, secret, *parts]
    return digest_value(payload)


def seed_commitment(role: str, secret: str) -> str:
    return digest_value([DOMAIN, "seed-commitment", role, secret])


def reject_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise PlanError(f"duplicate JSON key: {key}")
        result[key] = value
    return result


def read_json(path: Path, label: str) -> tuple[Any, bytes]:
    try:
        raw = path.read_bytes()
    except OSError as error:
        raise PlanError(f"cannot read {label}: {error}") from error
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError as error:
        raise PlanError(f"{label} must be UTF-8") from error
    try:
        value = json.loads(text, object_pairs_hook=reject_duplicate_keys)
    except PlanError:
        raise
    except (json.JSONDecodeError, ValueError) as error:
        raise PlanError(f"invalid {label} JSON: {error}") from error
    return value, raw


def require_object(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise PlanError(f"{label} must be an object")
    return value


def require_list(value: Any, label: str) -> list[Any]:
    if not isinstance(value, list):
        raise PlanError(f"{label} must be an array")
    return value


def require_exact_keys(
    value: dict[str, Any], required: set[str], label: str, optional: set[str] | None = None
) -> None:
    allowed = required | (optional or set())
    missing = sorted(required - value.keys())
    extra = sorted(value.keys() - allowed)
    if missing:
        raise PlanError(f"{label} is missing keys: {', '.join(missing)}")
    if extra:
        raise PlanError(f"{label} has unknown keys: {', '.join(extra)}")


def require_id(value: Any, label: str) -> str:
    if not isinstance(value, str) or not ID_PATTERN.fullmatch(value):
        raise PlanError(
            f"{label} must be a lowercase identifier using letters, digits, '.', '_', or '-'"
        )
    return value


def require_text(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value.strip() or "\x00" in value:
        raise PlanError(f"{label} must be a non-empty string without NUL bytes")
    return value


def normalize_split_weights(value: Any) -> dict[str, int]:
    weights = require_object(value, "splitWeights")
    unknown = sorted(set(weights) - set(SUPPORTED_SPLITS))
    if unknown:
        raise PlanError(f"splitWeights has unsupported splits: {', '.join(unknown)}")
    missing = sorted(MANDATORY_SPLITS - weights.keys())
    if missing:
        raise PlanError(f"splitWeights is missing mandatory splits: {', '.join(missing)}")
    normalized: dict[str, int] = {}
    for split in SUPPORTED_SPLITS:
        if split not in weights:
            continue
        weight = weights[split]
        if isinstance(weight, bool) or not isinstance(weight, int) or weight <= 0:
            raise PlanError(f"splitWeights.{split} must be a positive integer")
        normalized[split] = weight
    return normalized


def require_positive_integer(value: Any, label: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise PlanError(f"{label} must be a positive integer")
    return value


def normalize_minimum_map(
    value: Any, label: str, *, allowed_keys: set[str] | None = None
) -> dict[str, int]:
    raw = require_object(value, label)
    normalized: dict[str, int] = {}
    for raw_key, raw_minimum in sorted(raw.items()):
        key = require_id(raw_key, f"{label} key")
        if allowed_keys is not None and key not in allowed_keys:
            raise PlanError(f"{label} has unsupported key: {key}")
        normalized[key] = require_positive_integer(raw_minimum, f"{label}.{key}")
    return normalized


def normalize_coverage_requirements(
    value: Any, split_weights: dict[str, int]
) -> dict[str, Any]:
    raw_requirements = require_object(value, "coverageRequirements")
    if set(raw_requirements) != set(split_weights):
        missing = sorted(set(split_weights) - raw_requirements.keys())
        extra = sorted(raw_requirements.keys() - set(split_weights))
        details = []
        if missing:
            details.append(f"missing {', '.join(missing)}")
        if extra:
            details.append(f"unexpected {', '.join(extra)}")
        raise PlanError(
            "coverageRequirements must match declared splits: " + "; ".join(details)
        )

    normalized: dict[str, Any] = {}
    for split in split_weights:
        label = f"coverageRequirements.{split}"
        requirement = require_object(raw_requirements[split], label)
        require_exact_keys(
            requirement,
            {"minimumFamilies", "minimumTasks", "responseModes", "strata"},
            label,
        )
        raw_strata = require_object(requirement["strata"], f"{label}.strata")
        require_exact_keys(raw_strata, set(STRATA_DIMENSIONS), f"{label}.strata")
        normalized[split] = {
            "minimumFamilies": require_positive_integer(
                requirement["minimumFamilies"], f"{label}.minimumFamilies"
            ),
            "minimumTasks": require_positive_integer(
                requirement["minimumTasks"], f"{label}.minimumTasks"
            ),
            "responseModes": normalize_minimum_map(
                requirement["responseModes"],
                f"{label}.responseModes",
                allowed_keys=set(RESPONSE_MODES),
            ),
            "strata": {
                dimension: normalize_minimum_map(
                    raw_strata[dimension], f"{label}.strata.{dimension}"
                )
                for dimension in STRATA_DIMENSIONS
            },
        }
    return normalized


def validate_coverage_feasibility(
    families: list[dict[str, Any]], coverage: dict[str, Any]
) -> None:
    available_families = len(families)
    available_tasks = sum(len(family["cases"]) for family in families)
    if sum(item["minimumFamilies"] for item in coverage.values()) > available_families:
        raise PlanError("coverage minimumFamilies exceed the available semantic families")
    if sum(item["minimumTasks"] for item in coverage.values()) > available_tasks:
        raise PlanError("coverage minimumTasks exceed the available tasks")

    available_modes = Counter(
        case["responseMode"] for family in families for case in family["cases"]
    )
    required_modes = Counter()
    for requirement in coverage.values():
        required_modes.update(requirement["responseModes"])
    for mode, minimum in sorted(required_modes.items()):
        if minimum > available_modes[mode]:
            raise PlanError(
                f"coverage requires {minimum} {mode} tasks but only {available_modes[mode]} exist"
            )

    for dimension in STRATA_DIMENSIONS:
        available_values = Counter(family["strata"][dimension] for family in families)
        required_values = Counter()
        for requirement in coverage.values():
            required_values.update(requirement["strata"][dimension])
        for value_id, minimum in sorted(required_values.items()):
            if minimum > available_values[value_id]:
                raise PlanError(
                    f"coverage requires {minimum} families with {dimension}={value_id} "
                    f"but only {available_values[value_id]} exist"
                )


def normalize_blueprint(value: Any) -> dict[str, Any]:
    blueprint = require_object(value, "blueprint")
    require_exact_keys(
        blueprint,
        {
            "schemaVersion",
            "datasetId",
            "splitWeights",
            "coverageRequirements",
            "families",
        },
        "blueprint",
    )
    if blueprint["schemaVersion"] != SCHEMA_VERSION:
        raise PlanError(f"blueprint.schemaVersion must be {SCHEMA_VERSION}")
    dataset_id = require_id(blueprint["datasetId"], "blueprint.datasetId")
    split_weights = normalize_split_weights(blueprint["splitWeights"])
    family_values = require_list(blueprint["families"], "blueprint.families")
    if not family_values:
        raise PlanError("blueprint.families must not be empty")

    family_ids: set[str] = set()
    folded_family_ids: set[str] = set()
    task_ids: set[str] = set()
    folded_task_ids: set[str] = set()
    source_owners: dict[str, str] = {}
    template_owners: dict[str, str] = {}
    normalized_families: list[dict[str, Any]] = []

    for family_index, raw_family in enumerate(family_values):
        label = f"blueprint.families[{family_index}]"
        family = require_object(raw_family, label)
        require_exact_keys(
            family,
            {"familyId", "sourceId", "templateId", "strata", "cases"},
            label,
        )
        family_id = require_id(family["familyId"], f"{label}.familyId")
        source_id = require_id(family["sourceId"], f"{label}.sourceId")
        template_id = require_id(family["templateId"], f"{label}.templateId")
        raw_strata = require_object(family["strata"], f"{label}.strata")
        require_exact_keys(raw_strata, set(STRATA_DIMENSIONS), f"{label}.strata")
        strata = {
            dimension: require_id(
                raw_strata[dimension], f"{label}.strata.{dimension}"
            )
            for dimension in STRATA_DIMENSIONS
        }
        folded_family = family_id.casefold()
        if family_id in family_ids or folded_family in folded_family_ids:
            raise PlanError(f"duplicate familyId: {family_id}")
        family_ids.add(family_id)
        folded_family_ids.add(folded_family)
        for shared_id, owners, kind in (
            (source_id, source_owners, "sourceId"),
            (template_id, template_owners, "templateId"),
        ):
            owner = owners.get(shared_id.casefold())
            if owner is not None and owner != family_id:
                raise PlanError(
                    f"{kind} {shared_id} spans families {owner} and {family_id}; merge the semantic family"
                )
            owners[shared_id.casefold()] = family_id

        case_values = require_list(family["cases"], f"{label}.cases")
        if not case_values:
            raise PlanError(f"{label}.cases must not be empty")
        normalized_cases: list[dict[str, Any]] = []
        for case_index, raw_case in enumerate(case_values):
            case_label = f"{label}.cases[{case_index}]"
            case = require_object(raw_case, case_label)
            require_exact_keys(
                case,
                {"taskId", "responseMode", "variantAxes"},
                case_label,
            )
            task_id = require_id(case["taskId"], f"{case_label}.taskId")
            folded_task = task_id.casefold()
            if task_id in task_ids or folded_task in folded_task_ids:
                raise PlanError(f"duplicate taskId: {task_id}")
            task_ids.add(task_id)
            folded_task_ids.add(folded_task)
            response_mode = require_text(
                case["responseMode"], f"{case_label}.responseMode"
            )
            if response_mode not in RESPONSE_MODES:
                raise PlanError(
                    f"{case_label}.responseMode must be one of: {', '.join(sorted(RESPONSE_MODES))}"
                )
            raw_axes = require_object(case["variantAxes"], f"{case_label}.variantAxes")
            normalized_axes: dict[str, list[str]] = {}
            for axis, raw_options in sorted(raw_axes.items()):
                axis_id = require_id(axis, f"{case_label}.variantAxes axis")
                options = require_list(
                    raw_options, f"{case_label}.variantAxes.{axis_id}"
                )
                if not options:
                    raise PlanError(
                        f"{case_label}.variantAxes.{axis_id} must not be empty"
                    )
                normalized_options = sorted(
                    require_text(option, f"{case_label}.variantAxes.{axis_id} option")
                    for option in options
                )
                if len(normalized_options) != len(set(normalized_options)):
                    raise PlanError(
                        f"{case_label}.variantAxes.{axis_id} contains duplicate options"
                    )
                normalized_axes[axis_id] = normalized_options
            normalized_cases.append(
                {
                    "taskId": task_id,
                    "responseMode": response_mode,
                    "variantAxes": normalized_axes,
                }
            )
        normalized_families.append(
            {
                "familyId": family_id,
                "sourceId": source_id,
                "templateId": template_id,
                "strata": strata,
                "cases": sorted(normalized_cases, key=lambda item: item["taskId"]),
            }
        )

    if len(normalized_families) < len(split_weights):
        raise PlanError(
            "the blueprint needs at least one semantic family for every declared split"
        )
    normalized_families.sort(key=lambda item: item["familyId"])
    coverage = normalize_coverage_requirements(
        blueprint["coverageRequirements"], split_weights
    )
    validate_coverage_feasibility(normalized_families, coverage)
    return {
        "schemaVersion": SCHEMA_VERSION,
        "datasetId": dataset_id,
        "splitWeights": split_weights,
        "coverageRequirements": coverage,
        "families": normalized_families,
    }


def normalize_seeds(value: Any, declared_splits: set[str]) -> dict[str, Any]:
    seeds = require_object(value, "seeds")
    require_exact_keys(
        seeds, {"schemaVersion", "partitionSeed", "variantSeeds"}, "seeds"
    )
    if seeds["schemaVersion"] != SCHEMA_VERSION:
        raise PlanError(f"seeds.schemaVersion must be {SCHEMA_VERSION}")
    partition_seed = require_text(seeds["partitionSeed"], "seeds.partitionSeed")
    raw_variant_seeds = require_object(seeds["variantSeeds"], "seeds.variantSeeds")
    if set(raw_variant_seeds) != declared_splits:
        missing = sorted(declared_splits - raw_variant_seeds.keys())
        extra = sorted(raw_variant_seeds.keys() - declared_splits)
        details = []
        if missing:
            details.append(f"missing {', '.join(missing)}")
        if extra:
            details.append(f"unexpected {', '.join(extra)}")
        raise PlanError("seeds.variantSeeds must match declared splits: " + "; ".join(details))
    variant_seeds = {
        split: require_text(raw_variant_seeds[split], f"seeds.variantSeeds.{split}")
        for split in sorted(declared_splits)
    }
    all_seeds = [partition_seed, *variant_seeds.values()]
    if any(not SEED_PATTERN.fullmatch(seed) for seed in all_seeds):
        raise PlanError(
            "every seed must be exactly 64 lowercase hexadecimal characters; "
            "use a cryptographically secure generator"
        )
    if len(set(all_seeds)) != len(all_seeds):
        raise PlanError("partition and split variation seeds must be distinct")
    return {
        "schemaVersion": SCHEMA_VERSION,
        "partitionSeed": partition_seed,
        "variantSeeds": variant_seeds,
    }


def assign_families(
    families: list[dict[str, Any]],
    split_weights: dict[str, int],
    coverage: dict[str, Any],
    partition_seed: str,
) -> dict[str, str]:
    family_order = sorted(
        families,
        key=lambda family: (
            keyed_digest(partition_seed, "bootstrap-family", family["familyId"]),
            family["familyId"],
        ),
    )
    split_order = sorted(split_weights, key=lambda split: (-split_weights[split], split))
    assignments: dict[str, str] = {}
    family_counts = Counter()
    task_counts = Counter()
    strata_counts: dict[str, dict[str, Counter[str]]] = {
        dimension: defaultdict(Counter) for dimension in STRATA_DIMENSIONS
    }
    response_counts: dict[str, Counter[str]] = defaultdict(Counter)

    def response_profile(family: dict[str, Any]) -> Counter[str]:
        return Counter(case["responseMode"] for case in family["cases"])

    def coverage_gain(family: dict[str, Any], split: str) -> float:
        requirement = coverage[split]
        case_count = len(family["cases"])
        profile = response_profile(family)
        gain = 0.0
        family_shortfall = max(0, requirement["minimumFamilies"] - family_counts[split])
        task_shortfall = max(0, requirement["minimumTasks"] - task_counts[split])
        gain += min(1, family_shortfall) / requirement["minimumFamilies"]
        gain += min(case_count, task_shortfall) / requirement["minimumTasks"]
        for mode, minimum in requirement["responseModes"].items():
            shortfall = max(0, minimum - response_counts[mode][split])
            gain += min(profile[mode], shortfall) / minimum
        for dimension in STRATA_DIMENSIONS:
            value_id = family["strata"][dimension]
            minimum = requirement["strata"][dimension].get(value_id)
            if minimum:
                shortfall = max(
                    0, minimum - strata_counts[dimension][value_id][split]
                )
                gain += min(1, shortfall) / minimum
        return gain

    def allocation_key(
        family: dict[str, Any], split: str
    ) -> tuple[float, float, float, float, str, str]:
        weight = split_weights[split]
        profile = response_profile(family)
        strata_pressure = sum(
            (strata_counts[dimension][family["strata"][dimension]][split] + 1)
            / weight
            for dimension in STRATA_DIMENSIONS
        )
        response_pressure = sum(
            (response_counts[mode][split] + count) / weight
            for mode, count in profile.items()
        )
        return (
            -coverage_gain(family, split),
            strata_pressure + response_pressure,
            (family_counts[split] + 1) / weight,
            (task_counts[split] + len(family["cases"])) / weight,
            keyed_digest(partition_seed, "allocation-tie", family["familyId"], split),
            split,
        )

    def record(family: dict[str, Any], split: str) -> None:
        assignments[family["familyId"]] = split
        family_counts[split] += 1
        task_counts[split] += len(family["cases"])
        for dimension in STRATA_DIMENSIONS:
            strata_counts[dimension][family["strata"][dimension]][split] += 1
        for mode, count in response_profile(family).items():
            response_counts[mode][split] += count

    remaining = list(family_order)
    for split in split_order:
        family = min(remaining, key=lambda candidate: allocation_key(candidate, split))
        remaining.remove(family)
        record(family, split)

    remaining.sort(
        key=lambda family: (
            -len(family["cases"]),
            keyed_digest(partition_seed, "remaining-family", family["familyId"]),
            family["familyId"],
        )
    )
    for family in remaining:
        selected_split = min(
            split_weights, key=lambda split: allocation_key(family, split)
        )
        record(family, selected_split)
    return assignments


def select_variants(
    families: list[dict[str, Any]],
    assignments: dict[str, str],
    variant_seeds: dict[str, str],
) -> dict[str, dict[str, str]]:
    selected: dict[str, dict[str, str]] = {}
    for family in families:
        split = assignments[family["familyId"]]
        seed = variant_seeds[split]
        for case in family["cases"]:
            task_id = case["taskId"]
            selected[task_id] = {}
            for axis, options in case["variantAxes"].items():
                selected[task_id][axis] = max(
                    options,
                    key=lambda option: (
                        keyed_digest(
                            seed, "axis-choice", split, axis, task_id, option
                        ),
                        option,
                    ),
                )
    return selected


def validate_observed_coverage(
    families: list[dict[str, Any]],
    tasks: list[dict[str, Any]],
    coverage: dict[str, Any],
) -> None:
    family_counts = Counter(family["split"] for family in families)
    task_counts = Counter(task["split"] for task in tasks)
    response_counts: dict[str, Counter[str]] = defaultdict(Counter)
    strata_counts: dict[str, dict[str, Counter[str]]] = {
        dimension: defaultdict(Counter) for dimension in STRATA_DIMENSIONS
    }
    for task in tasks:
        response_counts[task["responseMode"]][task["split"]] += 1
    for family in families:
        for dimension in STRATA_DIMENSIONS:
            strata_counts[dimension][family["strata"][dimension]][
                family["split"]
            ] += 1

    failures: list[str] = []
    for split, requirement in coverage.items():
        if family_counts[split] < requirement["minimumFamilies"]:
            failures.append(
                f"{split} has {family_counts[split]} families; "
                f"requires {requirement['minimumFamilies']}"
            )
        if task_counts[split] < requirement["minimumTasks"]:
            failures.append(
                f"{split} has {task_counts[split]} tasks; "
                f"requires {requirement['minimumTasks']}"
            )
        for mode, minimum in requirement["responseModes"].items():
            observed = response_counts[mode][split]
            if observed < minimum:
                failures.append(
                    f"{split} has {observed} {mode} tasks; requires {minimum}"
                )
        for dimension in STRATA_DIMENSIONS:
            for value_id, minimum in requirement["strata"][dimension].items():
                observed = strata_counts[dimension][value_id][split]
                if observed < minimum:
                    failures.append(
                        f"{split} has {observed} families with "
                        f"{dimension}={value_id}; requires {minimum}"
                    )
    if failures:
        raise PlanError("planned split coverage is unmet: " + "; ".join(failures))


def build_plan(
    blueprint: dict[str, Any], seeds: dict[str, Any]
) -> tuple[dict[str, Any], dict[str, Any]]:
    families = blueprint["families"]
    split_weights = blueprint["splitWeights"]
    coverage = blueprint["coverageRequirements"]
    assignments = assign_families(
        families, split_weights, coverage, seeds["partitionSeed"]
    )
    selections = select_variants(families, assignments, seeds["variantSeeds"])

    family_records: list[dict[str, Any]] = []
    task_records: list[dict[str, Any]] = []
    for family in families:
        family_id = family["familyId"]
        split = assignments[family_id]
        family_records.append(
            {
                "familyId": family_id,
                "sourceId": family["sourceId"],
                "templateId": family["templateId"],
                "strata": family["strata"],
                "split": split,
                "taskIds": [case["taskId"] for case in family["cases"]],
            }
        )
        for case in family["cases"]:
            task_id = case["taskId"]
            selected_axes = dict(sorted(selections[task_id].items()))
            variant_id = digest_value(
                {"split": split, "taskId": task_id, "variantAxes": selected_axes}
            )[:16]
            task_records.append(
                {
                    "taskId": task_id,
                    "materializedTaskId": f"{task_id}--{variant_id}",
                    "familyId": family_id,
                    "sourceId": family["sourceId"],
                    "templateId": family["templateId"],
                    "strata": family["strata"],
                    "split": split,
                    "responseMode": case["responseMode"],
                    "variantId": variant_id,
                    "variantAxes": selected_axes,
                }
            )

    family_records.sort(key=lambda item: item["familyId"])
    task_records.sort(key=lambda item: item["taskId"])
    validate_observed_coverage(family_records, task_records, coverage)
    plan_core = {
        "schemaVersion": SCHEMA_VERSION,
        "datasetId": blueprint["datasetId"],
        "tool": {
            "name": "plan_harbor_task_datasets.py",
            "version": TOOL_VERSION,
            "partitionAlgorithm": PARTITION_ALGORITHM,
            "variationAlgorithm": VARIATION_ALGORITHM,
        },
        "blueprintSha256": digest_value(blueprint),
        "splitWeights": split_weights,
        "coverageRequirements": coverage,
        "seedCommitments": {
            "partition": seed_commitment("partition", seeds["partitionSeed"]),
            "variants": {
                split: seed_commitment(f"variant:{split}", secret)
                for split, secret in sorted(seeds["variantSeeds"].items())
            },
        },
        "families": family_records,
        "tasks": task_records,
    }
    plan_digest = digest_value(plan_core)
    plan = {
        **plan_core,
        "integrity": {"algorithm": "sha256", "planCoreSha256": plan_digest},
    }
    summary_core = build_summary_core(plan_core, plan_digest)
    summary = {
        **summary_core,
        "integrity": {
            "algorithm": "sha256",
            "summaryCoreSha256": digest_value(summary_core),
        },
    }
    return plan, summary


def build_summary_core(plan_core: dict[str, Any], plan_digest: str) -> dict[str, Any]:
    split_counts: dict[str, dict[str, Any]] = {}
    tasks_by_split: dict[str, list[dict[str, Any]]] = defaultdict(list)
    families_by_split: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for family in plan_core["families"]:
        families_by_split[family["split"]].append(family)
    for task in plan_core["tasks"]:
        tasks_by_split[task["split"]].append(task)
    for split in plan_core["splitWeights"]:
        tasks = tasks_by_split[split]
        response_counts = Counter(task["responseMode"] for task in tasks)
        axis_counts = Counter(
            axis for task in tasks for axis in task["variantAxes"]
        )
        split_counts[split] = {
            "families": len(families_by_split[split]),
            "tasks": len(tasks),
            "strata": {
                dimension: len(
                    {
                        family["strata"][dimension]
                        for family in families_by_split[split]
                    }
                )
                for dimension in STRATA_DIMENSIONS
            },
            "responseModes": dict(sorted(response_counts.items())),
            "variantAxes": dict(sorted(axis_counts.items())),
        }
    return {
        "schemaVersion": SCHEMA_VERSION,
        "datasetId": plan_core["datasetId"],
        "toolVersion": TOOL_VERSION,
        "planCoreSha256": plan_digest,
        "coverageSatisfied": True,
        "splitCounts": split_counts,
        "redaction": {
            "containsTaskOrFamilyIdentifiers": False,
            "containsPathsOrVariantValues": False,
            "containsDirectSeedsOrSeedCommitments": False,
            "reviewRequiredBeforePublication": True,
        },
    }


def validate_integrity(value: dict[str, Any], digest_key: str, label: str) -> str:
    integrity = require_object(value.get("integrity"), f"{label}.integrity")
    require_exact_keys(integrity, {"algorithm", digest_key}, f"{label}.integrity")
    if integrity["algorithm"] != "sha256":
        raise PlanError(f"{label}.integrity.algorithm must be sha256")
    expected = integrity[digest_key]
    if not isinstance(expected, str) or not SHA256_PATTERN.fullmatch(expected):
        raise PlanError(f"{label}.integrity.{digest_key} must be a SHA-256 digest")
    core = {key: item for key, item in value.items() if key != "integrity"}
    observed = digest_value(core)
    if observed != expected:
        raise PlanError(f"{label} integrity digest does not match its content")
    return observed


def validate_generated_plan(plan: Any) -> dict[str, Any]:
    value = require_object(plan, "plan.private.json")
    require_exact_keys(
        value,
        {
            "schemaVersion",
            "datasetId",
            "tool",
            "blueprintSha256",
            "splitWeights",
            "coverageRequirements",
            "seedCommitments",
            "families",
            "tasks",
            "integrity",
        },
        "plan.private.json",
    )
    if value["schemaVersion"] != SCHEMA_VERSION:
        raise PlanError(f"plan.private.json.schemaVersion must be {SCHEMA_VERSION}")
    require_id(value["datasetId"], "plan.private.json.datasetId")
    split_weights = normalize_split_weights(value["splitWeights"])
    coverage = normalize_coverage_requirements(
        value["coverageRequirements"], split_weights
    )

    tool = require_object(value["tool"], "plan.private.json.tool")
    require_exact_keys(
        tool,
        {"name", "version", "partitionAlgorithm", "variationAlgorithm"},
        "plan.private.json.tool",
    )
    expected_tool = {
        "name": "plan_harbor_task_datasets.py",
        "version": TOOL_VERSION,
        "partitionAlgorithm": PARTITION_ALGORITHM,
        "variationAlgorithm": VARIATION_ALGORITHM,
    }
    if tool != expected_tool:
        raise PlanError("plan.private.json uses an unsupported tool or algorithm version")
    if not isinstance(value["blueprintSha256"], str) or not SHA256_PATTERN.fullmatch(
        value["blueprintSha256"]
    ):
        raise PlanError("plan.private.json.blueprintSha256 must be a SHA-256 digest")

    commitments = require_object(
        value["seedCommitments"], "plan.private.json.seedCommitments"
    )
    require_exact_keys(
        commitments, {"partition", "variants"}, "plan.private.json.seedCommitments"
    )
    if not isinstance(commitments["partition"], str) or not SHA256_PATTERN.fullmatch(
        commitments["partition"]
    ):
        raise PlanError("partition seed commitment must be a SHA-256 digest")
    variant_commitments = require_object(
        commitments["variants"], "plan.private.json.seedCommitments.variants"
    )
    if set(variant_commitments) != set(split_weights):
        raise PlanError("variant seed commitments must match declared splits")
    if any(
        not isinstance(digest, str) or not SHA256_PATTERN.fullmatch(digest)
        for digest in variant_commitments.values()
    ):
        raise PlanError("every variant seed commitment must be a SHA-256 digest")

    family_values = require_list(value["families"], "plan.private.json.families")
    task_values = require_list(value["tasks"], "plan.private.json.tasks")
    if not family_values or not task_values:
        raise PlanError("generated plan families and tasks must not be empty")
    if family_values != sorted(family_values, key=lambda item: item.get("familyId", "")):
        raise PlanError("generated plan families must be in canonical familyId order")
    if task_values != sorted(task_values, key=lambda item: item.get("taskId", "")):
        raise PlanError("generated plan tasks must be in canonical taskId order")

    families: dict[str, dict[str, Any]] = {}
    source_owners: dict[str, str] = {}
    template_owners: dict[str, str] = {}
    split_family_counts = Counter()
    declared_task_owners: dict[str, str] = {}
    for index, raw_family in enumerate(family_values):
        label = f"plan.private.json.families[{index}]"
        family = require_object(raw_family, label)
        require_exact_keys(
            family,
            {"familyId", "sourceId", "templateId", "strata", "split", "taskIds"},
            label,
        )
        family_id = require_id(family["familyId"], f"{label}.familyId")
        if family_id in families:
            raise PlanError(f"duplicate generated familyId: {family_id}")
        source_id = require_id(family["sourceId"], f"{label}.sourceId")
        template_id = require_id(family["templateId"], f"{label}.templateId")
        raw_strata = require_object(family["strata"], f"{label}.strata")
        require_exact_keys(raw_strata, set(STRATA_DIMENSIONS), f"{label}.strata")
        normalized_strata = {
            dimension: require_id(
                raw_strata[dimension], f"{label}.strata.{dimension}"
            )
            for dimension in STRATA_DIMENSIONS
        }
        if raw_strata != normalized_strata:
            raise PlanError(f"{label}.strata must be in canonical order")
        split = family["split"]
        if split not in split_weights:
            raise PlanError(f"{label}.split is not declared")
        task_ids = require_list(family["taskIds"], f"{label}.taskIds")
        if not task_ids or task_ids != sorted(task_ids):
            raise PlanError(f"{label}.taskIds must be a non-empty canonical array")
        for task_id_value in task_ids:
            task_id = require_id(task_id_value, f"{label}.taskIds entry")
            if task_id in declared_task_owners:
                raise PlanError(f"taskId {task_id} is declared by multiple families")
            declared_task_owners[task_id] = family_id
        for identity, owners, kind in (
            (source_id, source_owners, "sourceId"),
            (template_id, template_owners, "templateId"),
        ):
            owner = owners.get(identity.casefold())
            if owner is not None and owner != family_id:
                raise PlanError(f"generated {kind} spans multiple families")
            owners[identity.casefold()] = family_id
        families[family_id] = family
        split_family_counts[split] += 1

    if set(declared_task_owners) != {
        require_id(task.get("taskId"), "generated taskId")
        for task in task_values
        if isinstance(task, dict)
    }:
        raise PlanError("family taskIds do not match generated task records")

    observed_task_ids: set[str] = set()
    observed_materialized_ids: set[str] = set()
    split_task_counts = Counter()
    for index, raw_task in enumerate(task_values):
        label = f"plan.private.json.tasks[{index}]"
        task = require_object(raw_task, label)
        require_exact_keys(
            task,
            {
                "taskId",
                "materializedTaskId",
                "familyId",
                "sourceId",
                "templateId",
                "strata",
                "split",
                "responseMode",
                "variantId",
                "variantAxes",
            },
            label,
        )
        task_id = require_id(task["taskId"], f"{label}.taskId")
        if task_id in observed_task_ids:
            raise PlanError(f"duplicate generated taskId: {task_id}")
        observed_task_ids.add(task_id)
        family_id = require_id(task["familyId"], f"{label}.familyId")
        family = families.get(family_id)
        if family is None or declared_task_owners.get(task_id) != family_id:
            raise PlanError(f"{label} has an invalid family assignment")
        for key in ("sourceId", "templateId", "strata", "split"):
            if task[key] != family[key]:
                raise PlanError(f"{label}.{key} differs from its family")
        response_mode = task["responseMode"]
        if response_mode not in RESPONSE_MODES:
            raise PlanError(f"{label}.responseMode is unsupported")
        axes = require_object(task["variantAxes"], f"{label}.variantAxes")
        normalized_axes: dict[str, str] = {}
        for axis, option in sorted(axes.items()):
            normalized_axes[require_id(axis, f"{label}.variantAxes axis")] = require_text(
                option, f"{label}.variantAxes.{axis}"
            )
        if axes != normalized_axes:
            raise PlanError(f"{label}.variantAxes must be in canonical order")
        expected_variant_id = digest_value(
            {"split": task["split"], "taskId": task_id, "variantAxes": axes}
        )[:16]
        if task["variantId"] != expected_variant_id:
            raise PlanError(f"{label}.variantId does not bind its selected axes")
        expected_materialized_id = f"{task_id}--{expected_variant_id}"
        if task["materializedTaskId"] != expected_materialized_id:
            raise PlanError(f"{label}.materializedTaskId is invalid")
        if expected_materialized_id in observed_materialized_ids:
            raise PlanError("duplicate materializedTaskId")
        observed_materialized_ids.add(expected_materialized_id)
        split_task_counts[task["split"]] += 1

    for split in split_weights:
        if split_family_counts[split] == 0 or split_task_counts[split] == 0:
            raise PlanError(f"declared split {split} must contain a family and a task")
    validate_observed_coverage(list(families.values()), task_values, coverage)
    return value


def command_plan(args: argparse.Namespace) -> int:
    raw_blueprint, _ = read_json(args.blueprint, "blueprint")
    blueprint = normalize_blueprint(raw_blueprint)
    raw_seeds, _ = read_json(args.seeds, "seeds")
    seeds = normalize_seeds(raw_seeds, set(blueprint["splitWeights"]))
    plan, summary = build_plan(blueprint, seeds)

    output = args.output.resolve()
    if output.exists():
        raise PlanError("output already exists; choose a new path")
    temporary: Path | None = None
    try:
        output.parent.mkdir(parents=True, exist_ok=True)
        temporary = Path(
            tempfile.mkdtemp(prefix=f".{output.name}.tmp-", dir=output.parent)
        )
        (temporary / "plan.private.json").write_bytes(canonical_bytes(plan))
        (temporary / "summary.redacted.json").write_bytes(canonical_bytes(summary))
        if output.exists():
            raise PlanError("output appeared while planning; no files were replaced")
        temporary.replace(output)
    except OSError as error:
        raise PlanError(f"cannot write plan output: {error}") from error
    finally:
        if temporary is not None and temporary.exists():
            for filename in ("plan.private.json", "summary.redacted.json"):
                (temporary / filename).unlink(missing_ok=True)
            with suppress(OSError):
                temporary.rmdir()
    result = {
        "ok": True,
        "datasetId": blueprint["datasetId"],
        "familyCount": len(plan["families"]),
        "taskCount": len(plan["tasks"]),
        "planCoreSha256": plan["integrity"]["planCoreSha256"],
        "outputFiles": ["plan.private.json", "summary.redacted.json"],
    }
    sys.stdout.buffer.write(canonical_bytes(result))
    return 0


def command_verify(args: argparse.Namespace) -> int:
    plan_path = args.plan_dir.resolve() / "plan.private.json"
    summary_path = args.plan_dir.resolve() / "summary.redacted.json"
    raw_plan, plan_bytes = read_json(plan_path, "plan.private.json")
    raw_summary, summary_bytes = read_json(summary_path, "summary.redacted.json")
    if plan_bytes != canonical_bytes(raw_plan):
        raise PlanError("plan.private.json is not canonical JSON")
    if summary_bytes != canonical_bytes(raw_summary):
        raise PlanError("summary.redacted.json is not canonical JSON")
    plan = validate_generated_plan(raw_plan)
    plan_digest = validate_integrity(plan, "planCoreSha256", "plan.private.json")
    summary = require_object(raw_summary, "summary.redacted.json")
    require_exact_keys(
        summary,
        {
            "schemaVersion",
            "datasetId",
            "toolVersion",
            "planCoreSha256",
            "coverageSatisfied",
            "splitCounts",
            "redaction",
            "integrity",
        },
        "summary.redacted.json",
    )
    validate_integrity(summary, "summaryCoreSha256", "summary.redacted.json")
    plan_core = {key: value for key, value in plan.items() if key != "integrity"}
    expected_summary_core = build_summary_core(plan_core, plan_digest)
    expected_summary = {
        **expected_summary_core,
        "integrity": {
            "algorithm": "sha256",
            "summaryCoreSha256": digest_value(expected_summary_core),
        },
    }
    if summary != expected_summary:
        raise PlanError(
            "summary.redacted.json is not the exact redacted projection of the private plan"
        )
    source_inputs_reproduced = False
    if (args.blueprint is None) != (args.seeds is None):
        raise PlanError("--blueprint and --seeds must be supplied together")
    if args.blueprint is not None and args.seeds is not None:
        raw_blueprint, _ = read_json(args.blueprint, "blueprint")
        blueprint = normalize_blueprint(raw_blueprint)
        raw_seeds, _ = read_json(args.seeds, "seeds")
        seeds = normalize_seeds(raw_seeds, set(blueprint["splitWeights"]))
        reproduced_plan, reproduced_summary = build_plan(blueprint, seeds)
        if plan_bytes != canonical_bytes(reproduced_plan):
            raise PlanError(
                "plan.private.json does not reproduce from the supplied blueprint and seeds"
            )
        if summary_bytes != canonical_bytes(reproduced_summary):
            raise PlanError(
                "summary.redacted.json does not reproduce from the supplied blueprint and seeds"
            )
        source_inputs_reproduced = True
    result = {
        "ok": True,
        "datasetId": plan["datasetId"],
        "familyCount": len(plan["families"]),
        "taskCount": len(plan["tasks"]),
        "planCoreSha256": plan_digest,
        "sourceInputsReproduced": source_inputs_reproduced,
        "splitCounts": summary["splitCounts"],
    }
    sys.stdout.buffer.write(canonical_bytes(result))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Create and verify deterministic, group-disjoint private plans for "
            "authoring native Harbor evaluation datasets."
        )
    )
    subparsers = parser.add_subparsers(dest="command", required=True)
    plan_parser = subparsers.add_parser(
        "plan", help="assign semantic families and stable per-task seeded variants"
    )
    plan_parser.add_argument("--blueprint", type=Path, required=True)
    plan_parser.add_argument("--seeds", type=Path, required=True)
    plan_parser.add_argument("--output", type=Path, required=True)
    plan_parser.set_defaults(handler=command_plan)

    verify_parser = subparsers.add_parser(
        "verify",
        help="verify canonical plan integrity or reproduce it from inputs",
        description=(
            "With only --plan-dir, verify canonical structure and self-consistency. "
            "With --blueprint and --seeds, also regenerate in memory and compare "
            "exact bytes. Neither mode authenticates authorship."
        ),
    )
    verify_parser.add_argument("--plan-dir", type=Path, required=True)
    verify_parser.add_argument(
        "--blueprint", type=Path, help="private blueprint; requires --seeds"
    )
    verify_parser.add_argument(
        "--seeds", type=Path, help="private seed file; requires --blueprint"
    )
    verify_parser.set_defaults(handler=command_verify)
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return args.handler(args)
    except PlanError as error:
        print(f"error: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
