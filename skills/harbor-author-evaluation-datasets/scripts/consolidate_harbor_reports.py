#!/usr/bin/env python3
"""Consolidate sanitized Harbor final reports into Markdown and static SVGs."""

# Ruff cannot wrap complete SVG element literals without making the templates harder to audit.
# ruff: noqa: E501

from __future__ import annotations

import argparse
import hashlib
import html
import json
import math
import os
import re
import sys
import tempfile
from collections import Counter
from collections.abc import Iterable
from contextlib import suppress
from datetime import datetime
from pathlib import Path
from typing import Any

SCHEMA_VERSION = 1
MAX_INPUT_BYTES = 32 * 1024 * 1024
MAX_RUNS = 24
OUTPUT_FILES = (
    "comparison-report.json",
    "comparison-report.md",
    "quality-comparison.svg",
    "resource-comparison.svg",
    "efficiency-frontier.svg",
)
PALETTE = (
    "#38BDF8",
    "#A78BFA",
    "#34D399",
    "#FBBF24",
    "#FB7185",
    "#22D3EE",
    "#C084FC",
    "#A3E635",
    "#F97316",
    "#60A5FA",
    "#F472B6",
    "#2DD4BF",
)
ID_PATTERN = re.compile(r"[^a-zA-Z0-9._-]+")


class ReportError(ValueError):
    """Raised for invalid or unsafe report input."""


def canonical_json(value: Any) -> bytes:
    return (
        json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        + "\n"
    ).encode("utf-8")


def sha256_bytes(value: bytes) -> str:
    return "sha256:" + hashlib.sha256(value).hexdigest()


def require_object(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ReportError(f"{label} must be an object")
    return value


def require_list(value: Any, label: str) -> list[Any]:
    if not isinstance(value, list):
        raise ReportError(f"{label} must be an array")
    return value


def require_text(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ReportError(f"{label} must be a non-empty string")
    if any(ord(character) < 32 and character not in "\t" for character in value):
        raise ReportError(f"{label} contains control characters")
    return value.strip()


def require_number(
    value: Any,
    label: str,
    *,
    minimum: float | None = None,
    maximum: float | None = None,
    integer: bool = False,
) -> float | int:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ReportError(f"{label} must be a finite number")
    try:
        numeric = float(value)
    except (OverflowError, ValueError) as error:
        raise ReportError(f"{label} must be a finite number") from error
    if not math.isfinite(numeric):
        raise ReportError(f"{label} must be a finite number")
    if minimum is not None and numeric < minimum:
        raise ReportError(f"{label} must be >= {minimum}")
    if maximum is not None and numeric > maximum:
        raise ReportError(f"{label} must be <= {maximum}")
    if integer:
        if not numeric.is_integer():
            raise ReportError(f"{label} must be an integer")
        return int(numeric)
    return numeric


def parse_iso_timestamp(
    value: Any, label: str, *, require_timezone: bool
) -> tuple[str, datetime]:
    text = require_text(value, label)
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
        is_aware = parsed.utcoffset() is not None
    except (OverflowError, TypeError, ValueError) as error:
        raise ReportError(f"{label} must be an ISO 8601 timestamp: {error}") from error
    if require_timezone and not is_aware:
        raise ReportError(f"{label} must include a timezone")
    return text, parsed


def optional_number(
    value: Any,
    label: str,
    *,
    minimum: float | None = None,
    maximum: float | None = None,
) -> float | None:
    if value is None:
        return None
    return float(
        require_number(value, label, minimum=minimum, maximum=maximum)
    )


def read_report(path: Path, input_index: int) -> dict[str, Any]:
    source = path.resolve()
    if not source.is_file():
        raise ReportError(f"report does not exist or is not a file: {source}")
    size = source.stat().st_size
    if size > MAX_INPUT_BYTES:
        raise ReportError(
            f"report exceeds the {MAX_INPUT_BYTES}-byte input limit: {source}"
        )
    raw = source.read_bytes()
    try:
        decoded = raw.decode("utf-8")
        value = json.loads(decoded)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ReportError(f"invalid UTF-8 JSON report {source}: {error}") from error
    report = require_object(value, f"report[{input_index}]")
    if report.get("schemaVersion") != 1 or report.get("source") != "harbor":
        raise ReportError(
            f"report[{input_index}] must be a schemaVersion 1 Harbor final-report.json"
        )
    title = require_text(report.get("title"), f"report[{input_index}].title")
    generated_at, generated_at_value = parse_iso_timestamp(
        report.get("generatedAt"),
        f"report[{input_index}].generatedAt",
        require_timezone=True,
    )
    jobs = require_list(report.get("jobs"), f"report[{input_index}].jobs")
    if not jobs:
        raise ReportError(f"report[{input_index}].jobs must not be empty")
    comparison = require_object(
        report.get("comparison", {}), f"report[{input_index}].comparison"
    )
    source_tag = f"input-{input_index + 1}"
    return {
        "index": input_index,
        "path": source,
        "tag": source_tag,
        "sha256": sha256_bytes(raw),
        "title": title,
        "generatedAt": generated_at,
        "generatedAtValue": generated_at_value,
        "fairnessBasis": comparison.get("fairnessBasis"),
        "comparisonEnabled": comparison.get("enabled") is True,
        "comparisonWarning": comparison.get("warning"),
        "jobs": jobs,
    }


def normalize_metric_summary(
    value: Any,
    label: str,
    *,
    nonnegative: bool,
) -> dict[str, float | int] | None:
    if value is None:
        return None
    metric = require_object(value, label)
    count = require_number(metric.get("count"), f"{label}.count", minimum=0, integer=True)
    total = require_number(
        metric.get("total"),
        f"{label}.total",
        minimum=0 if nonnegative else None,
    )
    average = require_number(
        metric.get("average"),
        f"{label}.average",
        minimum=0 if nonnegative else None,
    )
    if count == 0:
        raise ReportError(f"{label}.count must be positive when the metric is present")
    if not math.isclose(float(total), float(average) * count, rel_tol=1e-6, abs_tol=1e-6):
        raise ReportError(f"{label}.total and average are inconsistent")
    return {"count": count, "total": float(total), "average": float(average)}


def trial_metric(
    trials: list[Any], field: str, label: str
) -> dict[str, Any] | None:
    values: list[float] = []
    for index, raw_trial in enumerate(trials):
        trial = require_object(raw_trial, f"{label}.trials[{index}]")
        tokens = trial.get("tokens")
        if tokens is None:
            continue
        token_map = require_object(tokens, f"{label}.trials[{index}].tokens")
        aliases = {
            "cache": ("cachedInput", "cache"),
            "reasoning": ("reasoning", "reasoningTokens"),
        }.get(field, (field,))
        present = [alias for alias in aliases if token_map.get(alias) is not None]
        if len(present) > 1:
            values_by_alias = {token_map[alias] for alias in present}
            if len(values_by_alias) != 1:
                raise ReportError(
                    f"{label}.trials[{index}].tokens has conflicting aliases for {field}"
                )
        raw_value = token_map.get(present[0]) if present else None
        if raw_value is not None:
            values.append(
                float(
                    require_number(
                        raw_value,
                        f"{label}.trials[{index}].tokens.{field}",
                        minimum=0,
                    )
                )
            )
    if not values:
        return None
    total_trials = len(trials)
    return {
        "total": sum(values),
        "average": sum(values) / len(values),
        "observedTrials": len(values),
        "totalTrials": total_trials,
        "complete": len(values) == total_trials,
    }


def parse_wall_seconds(started: Any, finished: Any, label: str) -> float | None:
    if finished is None:
        return None
    start_text = require_text(started, f"{label}.startedAt")
    finish_text = require_text(finished, f"{label}.finishedAt")
    try:
        start = datetime.fromisoformat(start_text.replace("Z", "+00:00"))
        finish = datetime.fromisoformat(finish_text.replace("Z", "+00:00"))
        start_is_aware = start.utcoffset() is not None
        finish_is_aware = finish.utcoffset() is not None
        if start_is_aware != finish_is_aware:
            raise ValueError(
                "startedAt and finishedAt must either both include a timezone or both omit it"
            )
        elapsed = (finish - start).total_seconds()
    except (TypeError, ValueError) as error:
        raise ReportError(f"{label} has invalid timestamps: {error}") from error
    if elapsed < 0:
        raise ReportError(f"{label}.finishedAt precedes startedAt")
    return elapsed


def normalize_job(source: dict[str, Any], raw_job: Any, job_index: int) -> dict[str, Any]:
    label = f"report[{source['index']}].jobs[{job_index}]"
    job = require_object(raw_job, label)
    original_label = require_text(job.get("label"), f"{label}.label")
    summary = require_object(job.get("summary"), f"{label}.summary")
    requested = require_number(
        summary.get("requestedTrials"),
        f"{label}.summary.requestedTrials",
        minimum=0,
        integer=True,
    )
    completed = require_number(
        summary.get("completedTrials"),
        f"{label}.summary.completedTrials",
        minimum=0,
        integer=True,
    )
    passed = require_number(
        summary.get("passedTrials"),
        f"{label}.summary.passedTrials",
        minimum=0,
        integer=True,
    )
    verifier_failed = require_number(
        summary.get("verifierFailedTrials"),
        f"{label}.summary.verifierFailedTrials",
        minimum=0,
        integer=True,
    )
    errored = require_number(
        summary.get("erroredTrials"),
        f"{label}.summary.erroredTrials",
        minimum=0,
        integer=True,
    )
    if requested < completed:
        raise ReportError(f"{label} completed more trials than requested")
    if passed + verifier_failed + errored != completed:
        raise ReportError(
            f"{label} pass, verifier-failure, and error counts must sum to completed trials"
        )
    pass_rate = require_number(
        summary.get("passRate"),
        f"{label}.summary.passRate",
        minimum=0,
        maximum=1,
    )
    expected_rate = passed / completed if completed else 0
    if not math.isclose(float(pass_rate), expected_rate, rel_tol=1e-9, abs_tol=1e-9):
        raise ReportError(f"{label}.summary.passRate is inconsistent with pass counts")

    reward = normalize_metric_summary(
        summary.get("reward"), f"{label}.summary.reward", nonnegative=False
    )
    total_tokens = normalize_metric_summary(
        summary.get("totalTokens"),
        f"{label}.summary.totalTokens",
        nonnegative=True,
    )
    latency_ms = normalize_metric_summary(
        summary.get("agentLatencyMs"),
        f"{label}.summary.agentLatencyMs",
        nonnegative=True,
    )
    cost = normalize_metric_summary(
        summary.get("costUsd"), f"{label}.summary.costUsd", nonnegative=True
    )
    for metric_name, metric in (
        ("reward", reward),
        ("totalTokens", total_tokens),
        ("agentLatencyMs", latency_ms),
        ("costUsd", cost),
    ):
        if metric is not None and metric["count"] > completed:
            raise ReportError(
                f"{label}.summary.{metric_name}.count exceeds completedTrials"
            )
    trials = require_list(job.get("trials", []), f"{label}.trials")
    if trials and len(trials) != completed:
        raise ReportError(f"{label}.trials must match completedTrials when present")
    token_metrics = {
        field: trial_metric(trials, field, label)
        for field in ("input", "cache", "output", "reasoning")
    }
    if (
        token_metrics["input"]
        and token_metrics["cache"]
        and token_metrics["input"]["complete"]
        and token_metrics["cache"]["complete"]
        and token_metrics["cache"]["total"]
        > token_metrics["input"]["total"] + 1e-9
    ):
        raise ReportError(f"{label} cached input exceeds total input tokens")
    if (
        total_tokens
        and token_metrics["input"]
        and token_metrics["output"]
        and total_tokens["count"] == completed
        and token_metrics["input"]["complete"]
        and token_metrics["output"]["complete"]
    ):
        derived_total = (
            token_metrics["input"]["total"] + token_metrics["output"]["total"]
        )
        if not math.isclose(
            total_tokens["total"], derived_total, rel_tol=1e-6, abs_tol=1e-6
        ):
            raise ReportError(
                f"{label} total tokens must equal input plus output; cache is already included in input"
            )

    wall_seconds = parse_wall_seconds(job.get("startedAt"), job.get("finishedAt"), label)
    complete = job.get("complete")
    if not isinstance(complete, bool):
        raise ReportError(f"{label}.complete must be a boolean")
    job_identity = str(job.get("jobId") or original_label)
    run_id = hashlib.sha256(
        f"{source['sha256']}\0{job_identity}\0{original_label}".encode()
    ).hexdigest()[:16]
    total_cost = cost["total"] if cost else None
    agent_seconds = latency_ms["total"] / 1000 if latency_ms else None
    total_token_value = total_tokens["total"] if total_tokens else None
    total_tokens_coverage_complete = bool(
        total_tokens and total_tokens["count"] == completed
    )
    cost_coverage_complete = bool(cost and cost["count"] == completed)
    agent_time_coverage_complete = bool(
        latency_ms and latency_ms["count"] == completed
    )
    return {
        "runId": run_id,
        "label": original_label,
        "originalLabel": original_label,
        "sourceIndex": source["index"],
        "sourceTag": source["tag"],
        "sourceReportSha256": source["sha256"],
        "complete": complete,
        "requestedTrials": requested,
        "completedTrials": completed,
        "passedTrials": passed,
        "verifierFailedTrials": verifier_failed,
        "erroredTrials": errored,
        "passRate": float(pass_rate),
        "averageReward": reward["average"] if reward else None,
        "rewardObservedTrials": reward["count"] if reward else 0,
        "rewardCoverageComplete": bool(reward and reward["count"] == completed),
        "tokens": {
            "input": token_metrics["input"],
            "cache": token_metrics["cache"],
            "output": token_metrics["output"],
            "reasoning": token_metrics["reasoning"],
            "total": total_tokens,
            "semantics": "total=input+output; cache is a subset of input and is not added again; reasoning is reported separately",
        },
        "totalTokensCoverageComplete": total_tokens_coverage_complete,
        "costUsd": total_cost,
        "costObservedTrials": cost["count"] if cost else 0,
        "costCoverageComplete": cost_coverage_complete,
        "agentTimeSeconds": agent_seconds,
        "agentTimeObservedTrials": latency_ms["count"] if latency_ms else 0,
        "agentTimeCoverageComplete": agent_time_coverage_complete,
        "wallTimeSeconds": wall_seconds,
        "tasksPerMinute": completed * 60 / wall_seconds
        if wall_seconds and wall_seconds > 0
        else None,
        "tokensPerTrial": total_token_value / completed
        if total_tokens_coverage_complete and completed
        else None,
        "costPerTrialUsd": total_cost / completed
        if cost_coverage_complete and completed
        else None,
        "costPerPassUsd": total_cost / passed
        if cost_coverage_complete and passed
        else None,
        "agentSecondsPerTrial": agent_seconds / completed
        if agent_time_coverage_complete and completed
        else None,
    }


def assign_display_labels(runs: list[dict[str, Any]]) -> None:
    original_counts = Counter(run["originalLabel"] for run in runs)
    preliminary = []
    for run in runs:
        if original_counts[run["originalLabel"]] == 1:
            preliminary.append(run["originalLabel"])
        else:
            preliminary.append(f"{run['sourceTag']} / {run['originalLabel']}")
    display_counts = Counter(preliminary)
    for index, (run, display) in enumerate(
        zip(runs, preliminary, strict=True), start=1
    ):
        run["label"] = (
            display if display_counts[display] == 1 else f"{display} [{index}]"
        )


def choose_baseline(runs: list[dict[str, Any]], requested: str | None) -> dict[str, Any]:
    if requested is None:
        return runs[0]
    matches = [
        run
        for run in runs
        if requested in {run["runId"], run["label"], run["originalLabel"]}
    ]
    if len(matches) != 1:
        raise ReportError(
            f"--baseline must identify exactly one run by display label, unique original label, or runId; matched {len(matches)}"
        )
    return matches[0]


def numeric_delta(current: float | None, baseline: float | None) -> dict[str, float | None]:
    if current is None or baseline is None:
        return {"absolute": None, "percent": None}
    absolute = current - baseline
    percent = absolute / abs(baseline) * 100 if baseline != 0 else None
    return {"absolute": absolute, "percent": percent}


def build_deltas(runs: list[dict[str, Any]], baseline: dict[str, Any]) -> list[dict[str, Any]]:
    fields = {
        "passRate": "higher-is-better",
        "averageReward": "higher-is-better",
        "tokensPerTrial": "lower-is-better",
        "costPerTrialUsd": "lower-is-better",
        "agentSecondsPerTrial": "lower-is-better",
        "wallTimeSeconds": "lower-is-better",
        "tasksPerMinute": "higher-is-better",
    }
    rows = []
    for run in runs:
        if run is baseline:
            continue
        metrics = {}
        for field, direction in fields.items():
            change = numeric_delta(run.get(field), baseline.get(field))
            improvement = change["absolute"]
            if improvement is not None and direction == "lower-is-better":
                improvement = -improvement
            metrics[field] = {
                **change,
                "direction": direction,
                "signedImprovement": improvement,
            }
        rows.append(
            {
                "baselineRunId": baseline["runId"],
                "candidateRunId": run["runId"],
                "candidateLabel": run["label"],
                "metrics": metrics,
            }
        )
    return rows


def build_report(
    sources: list[dict[str, Any]],
    *,
    title: str,
    baseline_selector: str | None,
    generated_at: str | None,
) -> dict[str, Any]:
    runs = [
        normalize_job(source, raw_job, index)
        for source in sources
        for index, raw_job in enumerate(source["jobs"])
    ]
    if len(runs) > MAX_RUNS:
        raise ReportError(f"at most {MAX_RUNS} runs can be rendered in one report")
    run_ids = [run["runId"] for run in runs]
    if len(run_ids) != len(set(run_ids)):
        raise ReportError("input reports contain duplicate run identities")
    assign_display_labels(runs)
    baseline = choose_baseline(runs, baseline_selector)
    if generated_at is None:
        resolved_generated_at = max(
            sources, key=lambda source: source["generatedAtValue"]
        )["generatedAt"]
    else:
        resolved_generated_at, _ = parse_iso_timestamp(
            generated_at, "--generated-at", require_timezone=True
        )
    source_records = [
        {
            "inputIndex": source["index"],
            "locator": source["tag"],
            "sha256": source["sha256"],
            "title": source["title"],
            "generatedAt": source["generatedAt"],
            "comparisonEnabled": source["comparisonEnabled"],
            "fairnessBasis": source["fairnessBasis"],
            "comparisonWarning": source["comparisonWarning"],
        }
        for source in sources
    ]
    return {
        "schemaVersion": SCHEMA_VERSION,
        "source": "harbor-final-report-consolidation",
        "title": title,
        "generatedAt": resolved_generated_at,
        "baselineRunId": baseline["runId"],
        "baselineLabel": baseline["label"],
        "sourceReports": source_records,
        "runs": runs,
        "deltas": build_deltas(runs, baseline),
        "metricSemantics": {
            "passRate": "passedTrials divided by completedTrials",
            "totalTokens": "Harbor input tokens plus output tokens; cached input is already part of input and is never added twice",
            "reasoningTokens": "shown separately when present because provider accounting may overlap output tokens",
            "agentTime": "sum of complete Harbor agent_execution timings; excludes environment setup and verifier time",
            "wallTime": "finishedAt minus startedAt for the Harbor job",
            "cost": "sum of Harbor-reported USD cost values for observed trials",
            "efficiencyCoverage": "per-trial token, cost, and agent-time values and their deltas are emitted only when the corresponding aggregate covers every completed trial",
            "privacy": "only aggregate metrics, input report commitments, and run labels are emitted; task and trial details are omitted",
        },
        "outputFiles": list(OUTPUT_FILES),
    }


def markdown_text(value: Any) -> str:
    text = str(value).replace("\r", " ").replace("\n", " ")
    special = frozenset("\\`*_[]<>|")
    return "".join(f"\\{character}" if character in special else character for character in text)


def md_cell(value: Any) -> str:
    return markdown_text(value)


def format_number(value: float | int | None, digits: int = 2) -> str:
    if value is None:
        return "n/a"
    return f"{value:,.{digits}f}"


def format_integer(value: float | int | None) -> str:
    if value is None:
        return "n/a"
    return f"{value:,.0f}"


def format_percent(value: float | None, digits: int = 1) -> str:
    if value is None:
        return "n/a"
    return f"{value * 100:.{digits}f}%"


def token_total(run: dict[str, Any], field: str) -> float | None:
    metric = run["tokens"].get(field)
    return metric.get("total") if metric else None


def token_coverage(run: dict[str, Any], field: str) -> str:
    metric = run["tokens"].get(field)
    if not metric:
        return "n/a"
    suffix = "" if metric["complete"] else f" ({metric['observedTrials']}/{metric['totalTrials']})"
    return format_integer(metric["total"]) + suffix


def summary_coverage(
    value: float | int | None,
    observed: int,
    completed: int,
    formatter: Any,
    *,
    always: bool = False,
) -> str:
    if value is None:
        return "n/a"
    suffix = f" ({observed}/{completed})" if always or observed != completed else ""
    return formatter(value) + suffix


def render_markdown(report: dict[str, Any]) -> str:
    lines = [
        f"# {markdown_text(report['title'])}",
        "",
        f"Generated from reviewed Harbor reports: {markdown_text(report['generatedAt'])}. "
        f"Baseline: {md_cell(report['baselineLabel'])}.",
        "",
        "The charts and tables contain aggregate metrics only. Cached input is a subset "
        "of input tokens and is not added a second time; reasoning tokens are shown "
        "separately when a provider reports them.",
        "",
        "## Visual comparison",
        "",
        "- [Quality comparison](quality-comparison.svg)",
        "- [Token, cost, and time comparison](resource-comparison.svg)",
        "- [Cost-quality efficiency frontier](efficiency-frontier.svg)",
        "",
        "## Runs",
        "",
        "| Run | Complete | Passed / completed | Pass rate | Mean reward (coverage) | Errors | Input tokens | Cached subset | Output tokens | Reasoning tokens | Total tokens | Cost USD | Agent time | Wall time | Tasks/min |",
        "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ]
    for run in report["runs"]:
        total_metric = run["tokens"]["total"]
        lines.append(
            "| "
            + " | ".join(
                [
                    md_cell(run["label"]),
                    "yes" if run["complete"] else "no",
                    f"{run['passedTrials']} / {run['completedTrials']}",
                    format_percent(run["passRate"]),
                    summary_coverage(
                        run["averageReward"],
                        run["rewardObservedTrials"],
                        run["completedTrials"],
                        lambda value: format_number(value, 3),
                        always=True,
                    ),
                    str(run["erroredTrials"]),
                    token_coverage(run, "input"),
                    token_coverage(run, "cache"),
                    token_coverage(run, "output"),
                    token_coverage(run, "reasoning"),
                    summary_coverage(
                        total_metric["total"] if total_metric else None,
                        total_metric["count"] if total_metric else 0,
                        run["completedTrials"],
                        format_integer,
                    ),
                    summary_coverage(
                        run["costUsd"],
                        run["costObservedTrials"],
                        run["completedTrials"],
                        lambda value: format_number(value, 4),
                    ),
                    summary_coverage(
                        run["agentTimeSeconds"],
                        run["agentTimeObservedTrials"],
                        run["completedTrials"],
                        lambda value: format_number(value, 1) + " s",
                    ),
                    format_number(run["wallTimeSeconds"], 1) + " s"
                    if run["wallTimeSeconds"] is not None
                    else "n/a",
                    format_number(run["tasksPerMinute"], 2),
                ]
            )
            + " |"
        )
    lines.extend(
        [
            "",
            "A parenthesized coverage fraction such as `(3/4)` means only three "
            "of four completed trials reported that metric; it is not a complete total.",
            "",
            "## Deltas from baseline",
            "",
            "| Candidate | Pass-rate delta | Reward delta | Tokens/trial delta | Cost/trial delta | Agent sec/trial delta | Wall-time delta | Throughput delta |",
            "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
        ]
    )
    for row in report["deltas"]:
        metrics = row["metrics"]
        lines.append(
            "| "
            + " | ".join(
                [
                    md_cell(row["candidateLabel"]),
                    format_number(metrics["passRate"]["absolute"] * 100, 1) + " pp"
                    if metrics["passRate"]["absolute"] is not None
                    else "n/a",
                    format_number(metrics["averageReward"]["absolute"], 3),
                    format_integer(metrics["tokensPerTrial"]["absolute"]),
                    format_number(metrics["costPerTrialUsd"]["absolute"], 4),
                    format_number(metrics["agentSecondsPerTrial"]["absolute"], 2),
                    format_number(metrics["wallTimeSeconds"]["absolute"], 1) + " s"
                    if metrics["wallTimeSeconds"]["absolute"] is not None
                    else "n/a",
                    format_number(metrics["tasksPerMinute"]["absolute"], 2),
                ]
            )
            + " |"
        )
    lines.extend(
        [
            "",
            "Positive deltas mean the candidate is numerically higher; consult the "
            "metric rather than assuming that every positive delta is desirable.",
            "",
            "## Source commitments and comparability",
            "",
            "| Input | SHA-256 | Native comparison | Fairness basis | Warning |",
            "| --- | --- | --- | --- | --- |",
        ]
    )
    for source in report["sourceReports"]:
        lines.append(
            "| "
            + " | ".join(
                [
                    md_cell(source["locator"]),
                    f"`{source['sha256']}`",
                    "enabled" if source["comparisonEnabled"] else "not declared",
                    md_cell(source["fairnessBasis"] or "not declared"),
                    md_cell(source["comparisonWarning"] or "none"),
                ]
            )
            + " |"
        )
    lines.extend(
        [
            "",
            "This consolidation does not establish cross-report fairness. Preserve the "
            "native report's task, model, agent, attempt, lock, and hardware checks when "
            "making a comparative claim.",
            "",
        ]
    )
    return "\n".join(lines)


def esc(value: Any) -> str:
    return html.escape(str(value), quote=True)


def compact(value: float | int | None, *, money: bool = False) -> str:
    if value is None:
        return "n/a"
    numeric = float(value)
    prefix = "$" if money else ""
    absolute = abs(numeric)
    for divisor, suffix in ((1_000_000_000, "B"), (1_000_000, "M"), (1_000, "K")):
        if absolute >= divisor:
            return f"{prefix}{numeric / divisor:.2f}{suffix}"
    digits = 4 if money and absolute < 1 else 2
    return f"{prefix}{numeric:.{digits}f}"


def truncate(value: str, limit: int) -> str:
    return value if len(value) <= limit else value[: max(1, limit - 1)] + "…"


def nice_max(value: float, floor: float = 1.0) -> float:
    value = max(value, floor)
    exponent = math.floor(math.log10(value))
    fraction = value / (10**exponent)
    nice_fraction = 1 if fraction <= 1 else 2 if fraction <= 2 else 5 if fraction <= 5 else 10
    return nice_fraction * 10**exponent


def svg_document(title: str, description: str, width: int, height: int, body: str) -> str:
    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}" role="img" aria-labelledby="chart-title chart-desc">
  <title id="chart-title">{esc(title)}</title>
  <desc id="chart-desc">{esc(description)}</desc>
  <defs>
    <linearGradient id="background" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#070B18"/>
      <stop offset="0.55" stop-color="#10172A"/>
      <stop offset="1" stop-color="#071827"/>
    </linearGradient>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="8" stdDeviation="14" flood-color="#000000" flood-opacity="0.28"/>
    </filter>
    <style>
      text {{ font-family: Inter, Segoe UI, Arial, sans-serif; fill: #E5EEF9; }}
      .eyebrow {{ font-size: 14px; font-weight: 700; letter-spacing: 2px; fill: #7DD3FC; }}
      .title {{ font-size: 34px; font-weight: 750; }}
      .subtitle {{ font-size: 15px; fill: #94A3B8; }}
      .section {{ font-size: 18px; font-weight: 700; }}
      .label {{ font-size: 14px; font-weight: 650; }}
      .small {{ font-size: 12px; fill: #94A3B8; }}
      .value {{ font-size: 14px; font-variant-numeric: tabular-nums; }}
      .grid {{ stroke: #334155; stroke-width: 1; opacity: 0.55; }}
      .panel {{ fill: #111827; stroke: #263247; stroke-width: 1; filter: url(#shadow); }}
    </style>
  </defs>
  <rect width="{width}" height="{height}" rx="24" fill="url(#background)"/>
{body}
</svg>
'''


def svg_header(report: dict[str, Any], width: int, subtitle: str) -> str:
    return "\n".join(
        [
            '<rect x="56" y="44" width="248" height="30" rx="15" fill="#0C4A6E" opacity="0.72"/>',
            '<text x="74" y="65" class="eyebrow">HARBOR · RUN COMPARISON</text>',
            f'<text x="56" y="119" class="title">{esc(truncate(report["title"], 66))}</text>',
            f'<text x="56" y="151" class="subtitle">{esc(subtitle)}</text>',
            f'<rect x="{width - 340}" y="62" width="284" height="64" rx="14" fill="#0F2234" stroke="#155E75"/>',
            f'<text x="{width - 320}" y="87" class="small">BASELINE</text>',
            f'<text x="{width - 320}" y="111" class="label">{esc(truncate(report["baselineLabel"], 34))}</text>',
        ]
    )


def render_quality_svg(report: dict[str, Any]) -> str:
    runs = report["runs"]
    width = 1480
    row_height = 54
    height = max(620, 290 + len(runs) * row_height)
    panel_y = 196
    panel_h = len(runs) * row_height + 100
    left_x, right_x, panel_w = 48, 752, 680
    body = [
        svg_header(
            report,
            width,
            "Correctness first: pass rate and mean reward, with failures kept visible.",
        ),
        f'<rect x="{left_x}" y="{panel_y}" width="{panel_w}" height="{panel_h}" rx="20" class="panel"/>',
        f'<rect x="{right_x}" y="{panel_y}" width="{panel_w}" height="{panel_h}" rx="20" class="panel"/>',
        f'<text x="{left_x + 28}" y="{panel_y + 38}" class="section">Pass rate</text>',
        f'<text x="{right_x + 28}" y="{panel_y + 38}" class="section">Mean reward</text>',
    ]
    reward_values = [run["averageReward"] for run in runs if run["averageReward"] is not None]
    reward_ceiling = nice_max(max([abs(value) for value in reward_values] or [1.0]))
    for panel_x, maximum, percentage in ((left_x, 1.0, True), (right_x, reward_ceiling, False)):
        bar_x = panel_x + 190
        bar_w = panel_w - 250
        for tick in range(5):
            x = bar_x + bar_w * tick / 4
            label = f"{tick * 25}%" if percentage else compact(maximum * tick / 4)
            body.append(f'<line x1="{x:.1f}" y1="{panel_y + 60}" x2="{x:.1f}" y2="{panel_y + panel_h - 30}" class="grid"/>')
            body.append(f'<text x="{x:.1f}" y="{panel_y + panel_h - 12}" text-anchor="middle" class="small">{esc(label)}</text>')
    for index, run in enumerate(runs):
        color = PALETTE[index % len(PALETTE)]
        y = panel_y + 78 + index * row_height
        is_baseline = run["runId"] == report["baselineRunId"]
        baseline_mark = "● " if is_baseline else ""
        for panel_x in (left_x, right_x):
            body.append(f'<text x="{panel_x + 28}" y="{y + 18}" class="label">{esc(baseline_mark + truncate(run["label"], 20))}</text>')
        pass_width = (panel_w - 250) * run["passRate"]
        body.append(f'<rect x="{left_x + 190}" y="{y}" width="{panel_w - 250}" height="24" rx="12" fill="#1E293B"/>')
        body.append(f'<rect x="{left_x + 190}" y="{y}" width="{pass_width:.1f}" height="24" rx="12" fill="{color}"/>')
        body.append(f'<text x="{left_x + panel_w - 24}" y="{y + 18}" text-anchor="end" class="value">{format_percent(run["passRate"])}</text>')
        reward = run["averageReward"]
        reward_width = (panel_w - 250) * max(0, reward or 0) / reward_ceiling
        body.append(f'<rect x="{right_x + 190}" y="{y}" width="{panel_w - 250}" height="24" rx="12" fill="#1E293B"/>')
        if reward is not None:
            body.append(f'<rect x="{right_x + 190}" y="{y}" width="{reward_width:.1f}" height="24" rx="12" fill="{color}"/>')
        reward_label = summary_coverage(
            reward,
            run["rewardObservedTrials"],
            run["completedTrials"],
            lambda value: format_number(value, 3),
            always=True,
        )
        body.append(f'<text x="{right_x + panel_w - 24}" y="{y + 18}" text-anchor="end" class="value">{esc(reward_label)}</text>')
        if run["erroredTrials"]:
            body.append(f'<circle cx="{left_x + 171}" cy="{y + 12}" r="9" fill="#FB7185"/>')
            body.append(f'<text x="{left_x + 171}" y="{y + 16}" text-anchor="middle" font-size="10" fill="#111827">{run["erroredTrials"]}</text>')
    body.append(f'<text x="56" y="{height - 34}" class="small">A red badge is the number of execution errors. A dot marks the selected baseline. Aggregate views do not replace native fairness checks.</text>')
    return svg_document(
        f"{report['title']} — quality comparison",
        "Horizontal bars compare pass rate and mean reward for each Harbor execution.",
        width,
        height,
        "\n".join(body),
    )


def render_resource_svg(report: dict[str, Any]) -> str:
    runs = report["runs"]
    width = 1640
    row_height = 86
    height = max(680, 302 + len(runs) * row_height)
    panel_y = 196
    panel_h = len(runs) * row_height + 128
    body = [
        svg_header(
            report,
            width,
            "Resource accounting: token composition, reported cost, agent time, and wall time.",
        ),
        f'<rect x="48" y="{panel_y}" width="1544" height="{panel_h}" rx="20" class="panel"/>',
        f'<text x="72" y="{panel_y + 42}" class="section">Run</text>',
        f'<text x="318" y="{panel_y + 42}" class="section">Tokens · input includes cache</text>',
        f'<text x="1030" y="{panel_y + 42}" class="section">Cost USD</text>',
        f'<text x="1280" y="{panel_y + 42}" class="section">Time</text>',
    ]
    total_values = [
        run["tokens"]["total"]["total"]
        for run in runs
        if run["tokens"]["total"] is not None
    ]
    cost_values = [run["costUsd"] for run in runs if run["costUsd"] is not None]
    time_values = [
        value
        for run in runs
        for value in (run["agentTimeSeconds"], run["wallTimeSeconds"])
        if value is not None
    ]
    token_max = nice_max(max(total_values or [1]))
    cost_max = nice_max(max(cost_values or [1]), floor=0.01)
    time_max = nice_max(max(time_values or [1]))
    token_x, token_w = 318, 610
    cost_x, cost_w = 1030, 180
    time_x, time_w = 1280, 260
    legend_y = panel_y + panel_h - 42
    body.extend(
        [
            f'<rect x="{token_x}" y="{legend_y - 10}" width="12" height="12" rx="3" fill="#38BDF8"/><text x="{token_x + 18}" y="{legend_y}" class="small">fresh input</text>',
            f'<rect x="{token_x + 112}" y="{legend_y - 10}" width="12" height="12" rx="3" fill="#A78BFA"/><text x="{token_x + 130}" y="{legend_y}" class="small">cached input</text>',
            f'<rect x="{token_x + 238}" y="{legend_y - 10}" width="12" height="12" rx="3" fill="#34D399"/><text x="{token_x + 256}" y="{legend_y}" class="small">output</text>',
            f'<rect x="{time_x}" y="{legend_y - 10}" width="12" height="12" rx="3" fill="#FBBF24"/><text x="{time_x + 18}" y="{legend_y}" class="small">agent</text>',
            f'<rect x="{time_x + 86}" y="{legend_y - 10}" width="12" height="12" rx="3" fill="#FB7185"/><text x="{time_x + 104}" y="{legend_y}" class="small">wall</text>',
        ]
    )
    for index, run in enumerate(runs):
        y = panel_y + 72 + index * row_height
        label = ("● " if run["runId"] == report["baselineRunId"] else "") + truncate(run["label"], 25)
        body.append(f'<text x="72" y="{y + 22}" class="label">{esc(label)}</text>')
        input_tokens = token_total(run, "input")
        cache_tokens = token_total(run, "cache")
        output_tokens = token_total(run, "output")
        total_metric = run["tokens"]["total"]
        total_tokens = total_metric["total"] if total_metric else None
        body.append(f'<rect x="{token_x}" y="{y}" width="{token_w}" height="26" rx="8" fill="#1E293B"/>')
        if input_tokens is not None and output_tokens is not None:
            cache = min(cache_tokens or 0, input_tokens)
            fresh = max(0, input_tokens - cache)
            cursor = token_x
            for value, color in ((fresh, "#38BDF8"), (cache, "#A78BFA"), (output_tokens, "#34D399")):
                segment = token_w * value / token_max
                if segment > 0:
                    body.append(f'<rect x="{cursor:.1f}" y="{y}" width="{segment:.1f}" height="26" rx="5" fill="{color}"/>')
                    cursor += segment
        elif total_tokens is not None:
            segment = token_w * total_tokens / token_max
            body.append(f'<rect x="{token_x}" y="{y}" width="{segment:.1f}" height="26" rx="8" fill="#64748B"/>')
        reasoning = token_total(run, "reasoning")
        total_label = summary_coverage(
            total_tokens,
            total_metric["count"] if total_metric else 0,
            run["completedTrials"],
            compact,
        )
        body.append(f'<text x="{token_x}" y="{y + 48}" class="small">total {esc(total_label)} · reasoning {esc(compact(reasoning))}</text>')
        body.append(f'<rect x="{cost_x}" y="{y}" width="{cost_w}" height="18" rx="9" fill="#1E293B"/>')
        if run["costUsd"] is not None:
            cost_width = cost_w * run["costUsd"] / cost_max
            body.append(f'<rect x="{cost_x}" y="{y}" width="{cost_width:.1f}" height="18" rx="9" fill="#22D3EE"/>')
        cost_label = summary_coverage(
            run["costUsd"],
            run["costObservedTrials"],
            run["completedTrials"],
            lambda value: compact(value, money=True),
        )
        body.append(f'<text x="{cost_x}" y="{y + 43}" class="value">{esc(cost_label)}</text>')
        for offset, value, color, prefix in (
            (0, run["agentTimeSeconds"], "#FBBF24", "A"),
            (24, run["wallTimeSeconds"], "#FB7185", "W"),
        ):
            body.append(f'<text x="{time_x - 20}" y="{y + offset + 13}" text-anchor="end" class="small">{prefix}</text>')
            body.append(f'<rect x="{time_x}" y="{y + offset}" width="{time_w}" height="15" rx="7.5" fill="#1E293B"/>')
            if value is not None:
                bar_width = time_w * value / time_max
                body.append(f'<rect x="{time_x}" y="{y + offset}" width="{bar_width:.1f}" height="15" rx="7.5" fill="{color}"/>')
        agent_label = summary_coverage(
            run["agentTimeSeconds"],
            run["agentTimeObservedTrials"],
            run["completedTrials"],
            lambda value: compact(value) + "s",
        )
        body.append(f'<text x="{time_x}" y="{y + 62}" class="small">{esc(agent_label)} agent · {esc(compact(run["wallTimeSeconds"]))}s wall</text>')
    body.append(f'<text x="56" y="{height - 32}" class="small">Token scale: {esc(compact(token_max))}. Cost scale: {esc(compact(cost_max, money=True))}. Time scale: {esc(compact(time_max))} seconds. Reasoning is supplemental and never silently added to total.</text>')
    return svg_document(
        f"{report['title']} — token, cost, and time comparison",
        "Stacked token bars distinguish fresh input, cached input, and output. Separate bars compare cost, agent time, and wall time.",
        width,
        height,
        "\n".join(body),
    )


def pareto_runs(points: list[tuple[dict[str, Any], float, float]]) -> set[str]:
    frontier: set[str] = set()
    for run, cost, quality in points:
        dominated = any(
            other_cost <= cost
            and other_quality >= quality
            and (other_cost < cost or other_quality > quality)
            for other, other_cost, other_quality in points
            if other is not run
        )
        if not dominated:
            frontier.add(run["runId"])
    return frontier


def render_efficiency_svg(report: dict[str, Any]) -> str:
    runs = report["runs"]
    width = 1540
    height = max(860, 300 + len(runs) * 52)
    chart_x, chart_y, chart_w, chart_h = 104, 250, 910, 490
    points = [
        (run, run["costPerTrialUsd"], run["passRate"])
        for run in runs
        if run["costPerTrialUsd"] is not None
    ]
    cost_max = nice_max(max([point[1] for point in points] or [1]), floor=0.001)
    frontier = pareto_runs(points)
    body = [
        svg_header(
            report,
            width,
            "Higher quality and lower cost define the aggregate Pareto frontier; bubble area reflects tokens per trial.",
        ),
        '<rect x="48" y="190" width="1000" height="600" rx="20" class="panel"/>',
        f'<rect x="1076" y="190" width="416" height="{max(600, 110 + len(runs) * 52)}" rx="20" class="panel"/>',
        f'<text x="{chart_x}" y="{chart_y - 14}" class="section">Pass rate vs. cost per completed trial</text>',
        '<text x="1104" y="232" class="section">Efficiency details</text>',
    ]
    for tick in range(5):
        x = chart_x + chart_w * tick / 4
        y = chart_y + chart_h - chart_h * tick / 4
        body.append(f'<line x1="{x:.1f}" y1="{chart_y}" x2="{x:.1f}" y2="{chart_y + chart_h}" class="grid"/>')
        body.append(f'<line x1="{chart_x}" y1="{y:.1f}" x2="{chart_x + chart_w}" y2="{y:.1f}" class="grid"/>')
        body.append(f'<text x="{x:.1f}" y="{chart_y + chart_h + 26}" text-anchor="middle" class="small">{esc(compact(cost_max * tick / 4, money=True))}</text>')
        body.append(f'<text x="{chart_x - 16}" y="{y + 4:.1f}" text-anchor="end" class="small">{tick * 25}%</text>')
    body.append(f'<text x="{chart_x + chart_w / 2}" y="{chart_y + chart_h + 58}" text-anchor="middle" class="small">cost per completed trial (USD) →</text>')
    body.append(f'<text x="28" y="{chart_y + chart_h / 2}" transform="rotate(-90 28 {chart_y + chart_h / 2})" text-anchor="middle" class="small">pass rate →</text>')
    frontier_points = sorted(
        [point for point in points if point[0]["runId"] in frontier], key=lambda item: item[1]
    )
    if len(frontier_points) > 1:
        path_data = " ".join(
            ("M" if index == 0 else "L")
            + f" {chart_x + chart_w * cost / cost_max:.1f} {chart_y + chart_h * (1 - quality):.1f}"
            for index, (_, cost, quality) in enumerate(frontier_points)
        )
        body.append(f'<path d="{path_data}" fill="none" stroke="#FBBF24" stroke-width="2" stroke-dasharray="7 7" opacity="0.8"/>')
    token_values = [run["tokensPerTrial"] for run, _, _ in points if run["tokensPerTrial"] is not None]
    token_max = max(token_values or [1])
    for index, (run, cost, quality) in enumerate(points):
        color = PALETTE[runs.index(run) % len(PALETTE)]
        x = chart_x + chart_w * cost / cost_max
        y = chart_y + chart_h * (1 - quality)
        token_value = run["tokensPerTrial"] or 0
        radius = 10 + 17 * math.sqrt(token_value / token_max) if token_max else 12
        if run["runId"] in frontier:
            body.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="{radius + 7:.1f}" fill="none" stroke="#FBBF24" stroke-width="2"/>')
        if run["runId"] == report["baselineRunId"]:
            body.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="{radius + 12:.1f}" fill="none" stroke="#E2E8F0" stroke-width="2" stroke-dasharray="4 5"/>')
        body.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="{radius:.1f}" fill="{color}" fill-opacity="0.86" stroke="#F8FAFC" stroke-width="1.5"/>')
        label_y = y - radius - 18 if index % 2 == 0 else y + radius + 28
        body.append(f'<text x="{x:.1f}" y="{label_y:.1f}" text-anchor="middle" class="label">{esc(truncate(run["label"], 22))}</text>')
    if not points:
        body.append(f'<text x="{chart_x + chart_w / 2}" y="{chart_y + chart_h / 2}" text-anchor="middle" class="subtitle">No complete cost metric is available for a frontier.</text>')
    for index, run in enumerate(runs):
        y = 274 + index * 52
        color = PALETTE[index % len(PALETTE)]
        body.append(f'<circle cx="1108" cy="{y - 5}" r="7" fill="{color}"/>')
        body.append(f'<text x="1126" y="{y}" class="label">{esc(truncate(run["label"], 28))}</text>')
        body.append(f'<text x="1126" y="{y + 19}" class="small">{esc(compact(run["tokensPerTrial"]))} tok/trial · {esc(compact(run["costPerPassUsd"], money=True))}/pass · {esc(compact(run["agentSecondsPerTrial"]))}s agent/trial</text>')
    footer_y = height - 30
    body.append(f'<text x="56" y="{footer_y}" class="small">Gold rings mark non-dominated aggregate points; dashed white marks the baseline. Missing or partial cost values are omitted from the frontier; partial resource totals never drive efficiency deltas.</text>')
    return svg_document(
        f"{report['title']} — efficiency frontier",
        "A scatter plot compares pass rate with cost per completed trial. Bubble size represents total tokens per trial.",
        width,
        height,
        "\n".join(body),
    )


def output_payloads(report: dict[str, Any]) -> dict[str, bytes]:
    return {
        "comparison-report.json": canonical_json(report),
        "comparison-report.md": render_markdown(report).encode("utf-8"),
        "quality-comparison.svg": render_quality_svg(report).encode("utf-8"),
        "resource-comparison.svg": render_resource_svg(report).encode("utf-8"),
        "efficiency-frontier.svg": render_efficiency_svg(report).encode("utf-8"),
    }


def write_outputs(output: Path, payloads: dict[str, bytes], overwrite: bool) -> None:
    target = output.resolve()
    if target.exists() and not target.is_dir():
        raise ReportError(f"output exists and is not a directory: {target}")
    existing = [target / name for name in OUTPUT_FILES if (target / name).exists()]
    if existing and not overwrite:
        raise ReportError(
            "refusing to overwrite existing report artifacts: "
            + ", ".join(path.name for path in existing)
        )
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = Path(tempfile.mkdtemp(prefix=f".{target.name}.tmp-", dir=target.parent))
    try:
        for name in OUTPUT_FILES:
            (temporary / name).write_bytes(payloads[name])
        if not target.exists():
            temporary.replace(target)
            temporary = None
        else:
            for name in OUTPUT_FILES:
                os.replace(temporary / name, target / name)
    except OSError as error:
        raise ReportError(f"cannot write consolidated report: {error}") from error
    finally:
        if temporary is not None and temporary.exists():
            for name in OUTPUT_FILES:
                (temporary / name).unlink(missing_ok=True)
            with suppress(OSError):
                temporary.rmdir()


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Consolidate one or more Harbor final-report.json files into a sanitized "
            "Markdown comparison and three self-contained SVG charts."
        )
    )
    parser.add_argument("reports", nargs="+", type=Path)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--title", default="Harbor execution comparison")
    parser.add_argument(
        "--baseline",
        help="display label, unique original label, or runId; defaults to the first run",
    )
    parser.add_argument(
        "--generated-at",
        help="deterministic report timestamp; defaults to the latest source report timestamp",
    )
    parser.add_argument("--overwrite", action="store_true")
    return parser


def main(argv: Iterable[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        sources = [read_report(path, index) for index, path in enumerate(args.reports)]
        report = build_report(
            sources,
            title=require_text(args.title, "--title"),
            baseline_selector=args.baseline,
            generated_at=args.generated_at,
        )
        write_outputs(args.output_dir, output_payloads(report), args.overwrite)
        sys.stdout.buffer.write(
            canonical_json(
                {
                    "ok": True,
                    "baselineRunId": report["baselineRunId"],
                    "runCount": len(report["runs"]),
                    "outputDirectory": str(args.output_dir.resolve()),
                    "outputFiles": list(OUTPUT_FILES),
                }
            )
        )
        return 0
    except (OSError, ReportError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
