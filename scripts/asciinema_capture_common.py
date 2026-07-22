#!/usr/bin/env python3
"""Shared security, provenance, validation, and publication primitives for captures."""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
import stat
import tempfile
import time
import unicodedata
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, TextIO


CAST_VERSION = 3
CAST_COLS = 100
CAST_ROWS = 42
CAST_IDLE_TIME_LIMIT = 10.0
EXPECTED_PLUGIN_NAME = "agent-foundry"
EXPECTED_PLUGIN_VERSION = "0.12.1"
CAPTURE_OWNER_FILE = ".agent-harbor-capture-owner.json"

TEAM_RESULT_HEADER = "Agent Harbor Copilot team · team-demo · 0 model tokens"
STOP_RESULT_HEADER = "Agent Harbor Copilot stop · 0 model tokens"
TEAM_HELP_RESULT_HEADER = "Agent Harbor Copilot team help · 0 model tokens"
BENCH_LIST_RESULT_HEADER = "Agent Harbor Copilot bench · team-demo · 0 model tokens"
BENCH_RESULT_HEADER = "Agent Harbor /bench · 0 model tokens"
JOIN_RESULT_HEADER = "Agent Harbor /join · 0 model tokens"
RETIRE_RESULT_HEADER = "Agent Harbor /retire · 0 model tokens"

COMMAND_RESULT_EXPECTATIONS: tuple[tuple[str, str, tuple[str, ...]], ...] = (
    ("/team", TEAM_RESULT_HEADER, (
        "Team: 3 ready · 0 active · 6 benched · 0 unhealthy",
        "SDLC coverage: 0/6 enabled · 6 benched",
    )),
    ("/bench on all", BENCH_RESULT_HEADER, (
        "✓ portfolio-management enabled in this project.",
        "✓ design enabled in this project.", "✓ build enabled in this project.",
        "✓ manage enabled in this project.", "✓ consume enabled in this project.",
        "✓ dispose enabled in this project.",
    )),
    ("/bench list design", BENCH_LIST_RESULT_HEADER, (
        "Overall Team: 9 ready · 0 active · 0 benched · 0 unhealthy",
        "design · bundled · ready", "Solution design",
    )),
    ('/join {"name":"demo-reviewer","description":"Review risk.",'
     '"prompt":"Report findings.","tools":["read","search"]}', JOIN_RESULT_HEADER, (
        "demo-reviewer joined · personal · registered in this project",
        "Role: Review risk.", "Capacity: read, search",
    )),
    ("/team demo-reviewer", TEAM_RESULT_HEADER, (
        "Overall Team: 10 ready · 0 active · 0 benched · 0 unhealthy",
        "demo-reviewer · personal · ready", "Review risk.",
    )),
    ("/team stop all", STOP_RESULT_HEADER, (
        "No Agent Harbor work is active in this project.",
    )),
    ("/team help", TEAM_HELP_RESULT_HEADER, (
        "/team — Show roster/current work",
        "/team stop <run-id|all> — Idle/RPC control",
    )),
    ("/retire demo-reviewer", RETIRE_RESULT_HEADER, (
        "retired demo-reviewer; other projects intentionally untouched",
        "The retired player is blocked immediately",
    )),
    ("/retire demo-reviewer", RETIRE_RESULT_HEADER, (
        "demo-reviewer was already retired here · no roster files changed.",
        "Other project copies, if any, remain intentionally untouched.",
    )),
    ("/bench off all", BENCH_RESULT_HEADER, (
        "✓ portfolio-management moved to the bench in this project.",
        "✓ design moved to the bench in this project.",
        "✓ build moved to the bench in this project.",
        "✓ manage moved to the bench in this project.",
        "✓ consume moved to the bench in this project.",
        "✓ dispose moved to the bench in this project.",
    )),
    ("/team status:bench", TEAM_RESULT_HEADER, (
        "Overall Team: 3 ready · 0 active · 6 benched · 0 unhealthy",
        "LEAD ACCESS · OVERALL", "○ portfolio-management · bundled · bench",
        "○ dispose · bundled · bench",
    )),
)

KNOWN_RESULT_HEADERS = tuple(dict.fromkeys(item[1] for item in COMMAND_RESULT_EXPECTATIONS))
READING_DELAYS = (15.0, 10.0, 10.0, 12.0, 12.0, 8.0, 12.0, 10.0, 8.0, 10.0, 18.0)

ANSI_ESCAPE_RE = re.compile(
    r"(?:\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1bP.*?\x1b\\|"
    r"\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-_]|"
    r"\x9d[^\x07\x9c]*(?:\x07|\x9c)|\x90.*?\x9c|"
    r"\x9b[0-?]*[ -/]*[@-~]|"
    r"\udc9d[^\x07\udc9c]*(?:\x07|\udc9c)|\udc90.*?\udc9c|"
    r"\udc9b[0-?]*[ -/]*[@-~])",
    re.DOTALL,
)
CONTROL_PAYLOAD_RE = re.compile(
    r"(?:\x1b\](?P<osc7>[^\x07\x1b]*)(?:\x07|\x1b\\)|"
    r"\x9d(?P<osc8>[^\x07\x9c]*)(?:\x07|\x9c)|"
    r"\x1bP(?P<dcs7>.*?)\x1b\\|\x90(?P<dcs8>.*?)\x9c|"
    r"\udc9d(?P<osc_surrogate>[^\x07\udc9c]*)(?:\x07|\udc9c)|"
    r"\udc90(?P<dcs_surrogate>.*?)\udc9c)",
    re.DOTALL,
)
MODEL_TOKEN_LABEL_RE = re.compile(r"\bmodel\s+tokens?\b", re.IGNORECASE)
AIC_LABEL_RE = re.compile(r"\bAIC\s+used\b", re.IGNORECASE)
COUNT_BEFORE_LABEL_RE = re.compile(r"(?P<value>[0-9][0-9 ,._]*?)\s*$")
WINDOWS_DRIVE_PATH_RE = re.compile(
    r"(?<![0-9A-Za-z])(?P<path>[A-Za-z]:[\\/][^\s\"'<>|\x00-\x1f╭╮╰╯│]*)"
)
WINDOWS_UNC_PATH_RE = re.compile(
    r"(?<![:0-9A-Za-z])(?P<path>(?:\\\\|//)[^\s\"'<>|\x00-\x1f╭╮╰╯│]+)"
)
SENSITIVE_POSIX_PATH_RE = re.compile(
    r"(?<![:0-9A-Za-z])(?P<path>/(?:home|root|Users|private|mnt/[A-Za-z]|"
    r"var/(?:home|folders)|tmp)/[^\s\"'<>|\x00-\x1f]+)"
)
CREDENTIAL_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("GitHub token", re.compile(r"\b(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]{20,}\b")),
    ("OpenAI-style key", re.compile(r"\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}\b")),
    ("Slack token", re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{20,}\b")),
    ("AWS access key", re.compile(r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b")),
    ("JWT", re.compile(r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b")),
    ("private key", re.compile(r"-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----")),
    ("credential assignment", re.compile(
        r"(?i)\b(?:api[_-]?key|auth(?:orization)?|cookie|password|passwd|secret|token)"
        r"\s*[:=]\s*[^\s,;]{8,}"
    )),
    ("credential-bearing URL", re.compile(r"\b[a-z][a-z0-9+.-]*://[^\s/:@]+:[^\s/@]+@", re.I)),
)
SENSITIVE_ENV_NAME_RE = re.compile(
    r"(?:TOKEN|SECRET|PASS(?:WORD|WD)?|CREDENTIAL|COOKIE|AUTH|API[_-]?KEY|PRIVATE[_-]?KEY)",
    re.IGNORECASE,
)


def strict_json_loads(text: str) -> object:
    """Parse JSON while rejecting duplicate keys and non-standard constants."""

    def unique_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
        result: dict[str, object] = {}
        for key, value in pairs:
            if key in result:
                raise ValueError(f"duplicate JSON object key: {key}")
            result[key] = value
        return result

    def reject_constant(value: str) -> object:
        raise ValueError(f"non-finite JSON constant: {value}")

    return json.loads(
        text,
        object_pairs_hook=unique_object,
        parse_constant=reject_constant,
    )


def command_tour(probe: bool, probe_command: str) -> list[tuple[str, float]]:
    if probe:
        return [(probe_command or "/team", 12.0), ("/exit", 3.0)]
    return [
        *((expectation[0], delay) for expectation, delay in zip(
            COMMAND_RESULT_EXPECTATIONS, READING_DELAYS, strict=True
        )),
        ("/exit", 3.0),
    ]


def strip_ansi(text: str) -> str:
    return ANSI_ESCAPE_RE.sub("", text)


def normalize_terminal_text(text: str) -> str:
    normalized: list[str] = []
    for character in strip_ansi(text):
        if character == "\r":
            normalized.append("\n")
        elif character in "\n\t":
            normalized.append(character)
        elif character == "\b" or ord(character) < 32 or ord(character) == 127:
            continue
        elif unicodedata.category(character) in {"Cc", "Cf", "Cs"}:
            continue
        else:
            normalized.append(character)
    return "".join(normalized)


def raw_security_views(text: str) -> tuple[str, ...]:
    """Return visible text and raw control payloads; never discard hidden OSC/DCS data."""

    views = [normalize_terminal_text(text)]
    payloads: list[str] = []
    for match in CONTROL_PAYLOAD_RE.finditer(text):
        payload = next((value for value in match.groupdict().values() if value is not None), "")
        payloads.append(payload)
    # Also retain payload text in its original position. This detects a secret
    # deliberately split across visible text and an OSC/DCS payload while still
    # removing CSI cursor coordinates that can resemble path suffixes.
    payload_preserving = CONTROL_PAYLOAD_RE.sub(
        lambda match: next(
            (value for value in match.groupdict().values() if value is not None),
            "",
        ),
        text,
    )
    views.append(normalize_terminal_text(payload_preserving))
    # The visible view joins text split by CSI escapes; explicit payload views
    # retain the hidden data carried by OSC/DCS in both 7-bit and C1 framing.
    views.extend(payloads)
    return tuple(dict.fromkeys(views))


def sensitive_environment_values(environment: dict[str, str] | None = None) -> tuple[str, ...]:
    source = os.environ if environment is None else environment
    return tuple(dict.fromkeys(
        value for key, value in source.items()
        if SENSITIVE_ENV_NAME_RE.search(key) and isinstance(value, str) and len(value) >= 8
    ))


def credential_failures(
    text: str,
    *,
    sensitive_values: Iterable[str] = (),
) -> list[str]:
    failures: list[str] = []
    views = raw_security_views(text)
    for label, pattern in CREDENTIAL_PATTERNS:
        if any(pattern.search(view) for view in views):
            failures.append(f"possible {label} present in capture")
    for value in sensitive_values:
        if value and any(value in view for view in views):
            failures.append("value from a sensitive parent environment variable present in capture")
            break
    return list(dict.fromkeys(failures))


def normalize_windows_path_text(value: str) -> str:
    return value.rstrip(".,;:!?)]}").replace("/", "\\").rstrip("\\").casefold()


def absolute_windows_paths(text: str) -> list[str]:
    matches = [
        (match.start(), match.group("path"))
        for expression in (WINDOWS_DRIVE_PATH_RE, WINDOWS_UNC_PATH_RE)
        for match in expression.finditer(text)
    ]
    return [path for _, path in sorted(matches)]


def _path_key(value: str | Path) -> str:
    rendered = os.path.normcase(os.path.abspath(os.fspath(value))).rstrip("\\/")
    return rendered.casefold()


def _path_is_within(rendered: str, root: str) -> bool:
    if re.match(r"^[A-Za-z]:[\\/]", rendered) or rendered.startswith(("\\\\", "//")):
        value = normalize_windows_path_text(rendered)
        base = normalize_windows_path_text(root)
        return value == base or value.startswith(base + "\\")
    value = rendered.rstrip("/")
    base = root.rstrip("/")
    return value == base or value.startswith(base + "/")


def privacy_failures(
    text: str,
    *private_paths: Path,
    public_paths: tuple[Path, ...] = (),
    sensitive_values: Iterable[str] = (),
) -> list[str]:
    """Inspect visible and hidden terminal data for private paths and credentials."""

    failures: list[str] = []
    def rendered_path(path: Path) -> str:
        literal = str(path)
        if re.match(r"^[A-Za-z]:[\\/]", literal) or literal.startswith(("\\\\", "//")):
            return literal
        return str(path.absolute())

    public_roots = tuple(rendered_path(path) for path in public_paths)
    private_markers = {
        variant
        for path in private_paths
        for variant in (str(path.absolute()), str(path.resolve(strict=False)))
        if variant and not any(_path_is_within(variant, root) for root in public_roots)
    }
    home = str(Path.home().resolve())
    if not any(_path_is_within(home, root) for root in public_roots):
        private_markers.add(home)

    for view in raw_security_views(text):
        mixed = view.replace("/", "\\").casefold()
        if any(marker.replace("/", "\\").casefold() in mixed for marker in private_markers):
            failures.append("private home or workspace path present")
        if re.search(r"(?<!\w)~[\\/]", view):
            failures.append("private home or workspace path present")
        for path in absolute_windows_paths(view):
            if not any(_path_is_within(path, root) for root in public_roots):
                failures.append("non-public absolute Windows or UNC path present")
                break
        for match in SENSITIVE_POSIX_PATH_RE.finditer(view):
            path = match.group("path").rstrip(".,;:!?)]}")
            if not any(_path_is_within(path, root) for root in public_roots):
                failures.append("non-public absolute POSIX path present")
                break
    failures.extend(credential_failures(text, sensitive_values=sensitive_values))
    return list(dict.fromkeys(failures))


def _parse_grouped_count(rendered: str, label: str) -> int:
    value = rendered.strip()
    if value.isdecimal():
        return int(value)
    separators = [character for character in value if character in " ,._"]
    if not separators or len(set(separators)) != 1:
        raise ValueError(f"invalid {label} count: {rendered}")
    groups = value.split(separators[0])
    if (not 1 <= len(groups[0]) <= 3 or not groups[0].isdecimal()
            or any(len(group) != 3 or not group.isdecimal() for group in groups[1:])):
        raise ValueError(f"invalid {label} count: {rendered}")
    return int("".join(groups))


def _parse_metric_counts(output: str, label_re: re.Pattern[str], label: str) -> list[int]:
    normalized = normalize_terminal_text(output)
    counts: list[int] = []
    for match in label_re.finditer(normalized):
        value_match = COUNT_BEFORE_LABEL_RE.search(normalized[:match.start()])
        if value_match is None:
            raise ValueError(f"unparseable {label} count before {match.group(0)!r}")
        counts.append(_parse_grouped_count(value_match.group("value"), label))
    return counts


def parse_model_token_counts(output: str) -> list[int]:
    return _parse_metric_counts(output, MODEL_TOKEN_LABEL_RE, "model-token")


def parse_aic_counts(output: str) -> list[int]:
    return _parse_metric_counts(output, AIC_LABEL_RE, "AIC")


def model_token_failures(output: str, scope: str) -> list[str]:
    try:
        counts = parse_model_token_counts(output)
    except ValueError as error:
        return [f"{scope} has {error}"]
    return [f"{scope} reported non-zero model tokens: {count}" for count in counts if count]


def aic_failures(output: str, scope: str) -> list[str]:
    try:
        counts = parse_aic_counts(output)
    except ValueError as error:
        return [f"{scope} has {error}"]
    if not counts:
        return [f"{scope} has no parseable AIC status"]
    return [f"{scope} reported non-zero AIC: {count}" for count in counts if count]


def markers_in_order(output: str, markers: tuple[str, ...]) -> bool:
    output = normalize_terminal_text(output)
    offset = 0
    for marker in markers:
        position = output.find(marker, offset)
        if position < 0:
            return False
        offset = position + len(marker)
    return True


def last_result_block(output: str) -> tuple[str | None, str]:
    output = normalize_terminal_text(output)
    matches = [(output.rfind(header), header) for header in KNOWN_RESULT_HEADERS if header in output]
    if not matches:
        return None, ""
    position, header = max(matches)
    return header, output[position:]


def validate_command_results(results: list[tuple[str, str]]) -> list[str]:
    failures: list[str] = []
    if len(results) != len(COMMAND_RESULT_EXPECTATIONS):
        failures.append(
            f"expected {len(COMMAND_RESULT_EXPECTATIONS)} Agent Harbor results, observed {len(results)}"
        )
    for index, expectation in enumerate(COMMAND_RESULT_EXPECTATIONS, start=1):
        if index > len(results):
            break
        expected_command, expected_header, evidence = expectation
        command, output = results[index - 1]
        if command != expected_command:
            failures.append(f"result {index} expected {expected_command}, observed command {command}")
            continue
        failures.extend(model_token_failures(output, f"result {index} for {command}"))
        actual_header, result_block = last_result_block(output)
        if actual_header != expected_header:
            failures.append(f"result {index} for {command} lacks a fresh {expected_header} result")
        elif not markers_in_order(result_block, evidence):
            failures.append(f"result {index} for {command} lacks its ordered transition evidence")
    return failures


def semantic_tour_failures(output: str) -> list[str]:
    normalized = normalize_terminal_text(output)
    required = {
        "three bundled agents loaded": "Loading: 2 skills, 1 plugin, 3 agents",
        "initial healthy roster": "Team: 3 ready · 0 active · 6 benched · 0 unhealthy",
        "all specialists enabled": "Overall Team: 9 ready · 0 active · 0 benched · 0 unhealthy",
        "personal member ready": "demo-reviewer · personal · ready",
        "idle stop result": "No Agent Harbor work is active in this project.",
        "team help": "/team — Show roster/current work",
        "idempotent second retire": "demo-reviewer was already retired here · no roster files changed.",
    }
    failures = [label for label, marker in required.items() if marker not in normalized]
    if normalized.count(required["initial healthy roster"]) < 2:
        failures.append("original roster restored after cleanup")
    failures.extend(model_token_failures(normalized, "tour"))
    failures.extend(aic_failures(normalized, "tour"))
    if re.search(r"fatal|traceback", normalized, re.IGNORECASE):
        failures.append("fatal output present")
    return failures


def basic_capture_failures(
    output: str,
    *private_paths: Path,
    public_paths: tuple[Path, ...] = (),
    sensitive_values: Iterable[str] = (),
) -> list[str]:
    failures = privacy_failures(
        output, *private_paths, public_paths=public_paths, sensitive_values=sensitive_values
    )
    if re.search(r"fatal|traceback", normalize_terminal_text(output), re.I):
        failures.append("fatal output present")
    return list(dict.fromkeys(failures))


def build_child_environment(copilot_home: Path, copilot: Path) -> dict[str, str]:
    """Return an explicit environment allowlist; authentication tokens never cross."""

    temporary = copilot_home / "tmp"
    temporary.mkdir(parents=True, exist_ok=True)
    if os.name == "nt":
        system_root = os.environ.get("SystemRoot", r"C:\Windows")
        path_entries = [copilot.parent, Path(system_root) / "System32", Path(system_root)]
        environment = {
            "SystemRoot": system_root,
            "WINDIR": os.environ.get("WINDIR", system_root),
            "ComSpec": os.environ.get("ComSpec", str(Path(system_root) / "System32" / "cmd.exe")),
            "PATHEXT": os.environ.get("PATHEXT", ".COM;.EXE;.BAT;.CMD"),
            "PATH": os.pathsep.join(str(path) for path in path_entries),
            "TEMP": str(temporary),
            "TMP": str(temporary),
            "USERPROFILE": str(copilot_home),
            "HOME": str(copilot_home),
        }
    else:
        system_path = ("/usr/local/bin", "/usr/bin", "/bin")
        path_entries = tuple(dict.fromkeys((str(copilot.parent), *system_path)))
        environment = {
            "PATH": os.pathsep.join(path_entries),
            "HOME": str(copilot_home),
            "TMPDIR": str(temporary),
            "LANG": "C.UTF-8",
            "LC_ALL": "C.UTF-8",
        }
    environment.update({
        "CI": "",
        "COPILOT_HOME": str(copilot_home),
        "COPILOT_PLUGIN_DIR_ONLY": "true",
        "NO_COLOR": "",
        "TERM": "xterm-256color",
    })
    return environment


def _is_reparse(path: Path, file_stat: os.stat_result | None = None) -> bool:
    current = path.lstat() if file_stat is None else file_stat
    attributes = getattr(current, "st_file_attributes", 0)
    reparse_flag = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
    return stat.S_ISLNK(current.st_mode) or bool(attributes & reparse_flag)


def path_component_failures(path: Path, label: str) -> list[str]:
    """Reject symlink/reparse traversal in every existing path component."""

    absolute = path.absolute()
    failures: list[str] = []
    current = Path(absolute.anchor)
    try:
        anchor_stat = current.lstat()
    except OSError as error:
        return [f"{label} component is unavailable: {current}: {error}"]
    if _is_reparse(current, anchor_stat):
        return [f"{label} must not traverse a symlink, junction, or reparse point: {current}"]
    for part in absolute.parts[1:]:
        current /= part
        try:
            current_stat = current.lstat()
        except OSError as error:
            failures.append(f"{label} component is unavailable: {current}: {error}")
            break
        if _is_reparse(current, current_stat):
            failures.append(f"{label} must not traverse a symlink, junction, or reparse point: {current}")
            break
    return failures


def validate_distinct_roots(paths: dict[str, Path]) -> list[str]:
    failures: list[str] = []
    resolved = {label: path.resolve(strict=True) for label, path in paths.items()}
    labels = list(resolved)
    for index, left_label in enumerate(labels):
        left = resolved[left_label]
        for right_label in labels[index + 1:]:
            right = resolved[right_label]
            same = False
            try:
                same = left.samefile(right)
            except OSError:
                pass
            if same or left == right or left in right.parents or right in left.parents:
                failures.append(f"{left_label} and {right_label} must have distinct, non-overlapping physical roots")
    return failures


def validate_canonical_plugin(path: Path, expected: Path) -> list[str]:
    """Require the explicit canonical plugin to be this script bundle's plugin."""

    failures = [
        *path_component_failures(path, "canonical plugin"),
        *path_component_failures(expected, "expected canonical plugin"),
    ]
    if failures:
        return failures
    try:
        if not path.samefile(expected):
            failures.append(
                f"canonical plugin must be the bundled repository plugin {expected}; found {path}"
            )
    except OSError as error:
        failures.append(f"canonical plugin identity could not be verified: {error}")
    return failures


def capture_output_failures(output: Path, canonical_work: Path, *, probe: bool) -> list[str]:
    """Keep both probes and release candidates in the canonical work tree."""

    failures: list[str] = []
    resolved_output = output.resolve(strict=False)
    resolved_work = canonical_work.resolve(strict=False)
    if not resolved_output.is_relative_to(resolved_work):
        failures.append(f"capture output must live under canonical work: {resolved_work}")
    folded_parts = {part.casefold() for part in resolved_output.parts}
    if "docs" in folded_parts and "assets" in folded_parts:
        failures.append("capture drivers must never write directly to docs/assets")
    if probe:
        if not resolved_output.name.endswith(".probe.cast"):
            failures.append("probe output must end in .probe.cast")
    elif not resolved_output.name.endswith(".cast") or resolved_output.name.endswith(".probe.cast"):
        failures.append("tour output must end in .cast but not .probe.cast")
    return list(dict.fromkeys(failures))


def validate_capture_owner(path: Path, label: str, owner: str) -> list[str]:
    marker = path / CAPTURE_OWNER_FILE
    failures = path_component_failures(marker, f"{label} ownership marker")
    if failures:
        return failures
    try:
        marker_stat = marker.lstat()
        payload = strict_json_loads(marker.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError, ValueError) as error:
        return [f"{label} lacks a readable capture ownership marker: {error}"]
    if not stat.S_ISREG(marker_stat.st_mode) or marker_stat.st_nlink != 1:
        failures.append(f"{label} ownership marker must be one regular file with one link")
    if payload != {"owner": owner, "root": label, "schema": 1}:
        failures.append(f"{label} ownership marker does not match this capture run")
    return failures


@dataclass(frozen=True)
class PluginProvenance:
    name: str
    version: str
    digest: str
    files: int


def plugin_provenance(path: Path, expected_version: str = EXPECTED_PLUGIN_VERSION) -> PluginProvenance:
    failures = path_component_failures(path, "plugin")
    if failures:
        raise ValueError("; ".join(failures))
    manifest_path = path / "plugin.json"
    manifest = strict_json_loads(manifest_path.read_text(encoding="utf-8"))
    if not isinstance(manifest, dict):
        raise ValueError("plugin manifest must be a JSON object")
    if manifest.get("name") != EXPECTED_PLUGIN_NAME:
        raise ValueError(f"plugin name must be {EXPECTED_PLUGIN_NAME}")
    if manifest.get("version") != expected_version:
        raise ValueError(f"plugin version must be {expected_version}; found {manifest.get('version')}")
    digest = hashlib.sha256()
    count = 0
    for candidate in sorted(path.rglob("*"), key=lambda item: item.relative_to(path).as_posix()):
        relative = candidate.relative_to(path).as_posix()
        if relative == CAPTURE_OWNER_FILE:
            continue
        candidate_stat = candidate.lstat()
        if _is_reparse(candidate, candidate_stat):
            raise ValueError(f"plugin tree contains a symlink, junction, or reparse point: {relative}")
        if candidate.is_dir():
            continue
        if not stat.S_ISREG(candidate_stat.st_mode) or candidate_stat.st_nlink != 1:
            raise ValueError(f"plugin tree entry must be one regular file with one link: {relative}")
        content = candidate.read_bytes()
        encoded = relative.encode("utf-8")
        digest.update(len(encoded).to_bytes(4, "big"))
        digest.update(encoded)
        digest.update(len(content).to_bytes(8, "big"))
        digest.update(hashlib.sha256(content).digest())
        count += 1
    return PluginProvenance(EXPECTED_PLUGIN_NAME, expected_version, digest.hexdigest(), count)


def verify_plugin_copy(
    plugin: Path,
    canonical_plugin: Path,
    expected_version: str = EXPECTED_PLUGIN_VERSION,
) -> PluginProvenance:
    captured = plugin_provenance(plugin, expected_version)
    canonical = plugin_provenance(canonical_plugin, expected_version)
    if captured != canonical:
        raise ValueError(
            "capture plugin does not match the canonical built plugin "
            f"(capture {captured.digest}, canonical {canonical.digest})"
        )
    return captured


def cast_tags(provenance: PluginProvenance, mode: str) -> list[str]:
    if mode not in {"tour", "probe"}:
        raise ValueError(f"unsupported capture mode: {mode}")
    return [
        f"agent-harbor-mode={mode}",
        f"agent-harbor-version={provenance.version}",
        f"agent-harbor-sha256={provenance.digest}",
    ]


def validate_cast_header_common(
    header: object,
    *,
    expected_title: str,
    expected_command: str,
    provenance: PluginProvenance,
    mode: str,
    expected_shell: str,
    private_paths: tuple[Path, ...] = (),
    public_paths: tuple[Path, ...] = (),
    sensitive_values: Iterable[str] = (),
) -> list[str]:
    if not isinstance(header, dict):
        return ["cast header must be a JSON object"]
    failures: list[str] = []
    expected_keys = {"version", "term", "timestamp", "idle_time_limit", "command", "title", "env", "tags"}
    if set(header) != expected_keys:
        failures.append("cast header fields differ from the exact redacted contract")
    if header.get("version") != CAST_VERSION:
        failures.append(f"cast header version must be {CAST_VERSION}")
    if header.get("term") != {"cols": CAST_COLS, "rows": CAST_ROWS}:
        failures.append(f"cast terminal must be exactly {CAST_COLS}x{CAST_ROWS}")
    timestamp = header.get("timestamp")
    if isinstance(timestamp, bool) or not isinstance(timestamp, int) or timestamp <= 0:
        failures.append("cast timestamp must be a positive integer")
    if isinstance(header.get("idle_time_limit"), bool) or header.get("idle_time_limit") != CAST_IDLE_TIME_LIMIT:
        failures.append(f"cast idle_time_limit must be exactly {CAST_IDLE_TIME_LIMIT}")
    if header.get("command") != expected_command:
        failures.append("cast command must use the exact redacted command")
    if header.get("title") != expected_title:
        failures.append("cast title must contain the exact verified CLI version and capture mode")
    if header.get("env") != {"SHELL": expected_shell}:
        failures.append("cast env must contain only the redacted shell marker")
    if header.get("tags") != cast_tags(provenance, mode):
        failures.append("cast tags must contain exact mode and plugin provenance")
    serialized = json.dumps(header, ensure_ascii=True, sort_keys=True)
    failures.extend(privacy_failures(
        serialized, *private_paths, public_paths=public_paths, sensitive_values=sensitive_values
    ))
    return list(dict.fromkeys(failures))


def validate_cast_events(
    lines: list[str],
    *,
    private_paths: tuple[Path, ...] = (),
    public_paths: tuple[Path, ...] = (),
    sensitive_values: Iterable[str] = (),
) -> list[str]:
    failures: list[str] = []
    if not lines:
        return ["cast has no output events"]
    for index, line in enumerate(lines, start=1):
        try:
            event = strict_json_loads(line)
        except (json.JSONDecodeError, ValueError) as error:
            failures.append(f"cast event {index} is invalid JSON: {error}")
            continue
        if (not isinstance(event, list) or len(event) != 3
                or isinstance(event[0], bool) or not isinstance(event[0], (int, float))
                or not math.isfinite(event[0]) or event[0] < 0
                or event[1] not in {"o", "i", "m", "r", "x"}
                or not isinstance(event[2], str)):
            failures.append(f"cast event {index} violates the asciicast v3 event contract")
            continue
        failures.extend(privacy_failures(
            event[2], *private_paths, public_paths=public_paths, sensitive_values=sensitive_values
        ))
    return list(dict.fromkeys(failures))


def validate_cast_file_security(
    path: Path,
    *,
    private_paths: tuple[Path, ...] = (),
    public_paths: tuple[Path, ...] = (),
    sensitive_values: Iterable[str] = (),
) -> list[str]:
    try:
        raw = path.read_text(encoding="utf-8")
        lines = raw.splitlines()
        header = strict_json_loads(lines[0])
    except (OSError, UnicodeError, IndexError, json.JSONDecodeError, ValueError) as error:
        return [f"cast could not be parsed: {error}"]
    failures = privacy_failures(
        raw, *private_paths,
        public_paths=public_paths, sensitive_values=sensitive_values,
    )
    failures.extend(validate_cast_events(
        lines[1:], private_paths=private_paths, public_paths=public_paths,
        sensitive_values=sensitive_values,
    ))
    return list(dict.fromkeys(failures))


def _file_identity(file_stat: os.stat_result) -> tuple[int, int]:
    return file_stat.st_dev, file_stat.st_ino


def regular_file_snapshot(path: Path) -> tuple[int, int, int, int, int, str] | None:
    try:
        current = path.lstat()
    except FileNotFoundError:
        return None
    if _is_reparse(path, current) or not stat.S_ISREG(current.st_mode) or current.st_nlink != 1:
        raise RuntimeError(f"artifact target must be one regular non-reparse file: {path}")
    return (
        current.st_dev,
        current.st_ino,
        current.st_size,
        current.st_mtime_ns,
        current.st_ctime_ns,
        sha256_file(path),
    )


class ArtifactLock:
    """Cooperative cross-process lock held by an open OS handle."""

    def __init__(self, target: Path) -> None:
        lock_root = Path(tempfile.gettempdir()) / "agent-harbor-capture-locks"
        lock_root.mkdir(mode=0o700, parents=True, exist_ok=True)
        lock_failures = path_component_failures(lock_root, "artifact lock directory")
        if lock_failures:
            raise RuntimeError("; ".join(lock_failures))
        try:
            lock_root.chmod(0o700)
        except OSError:
            pass
        key = hashlib.sha256(str(target.absolute()).casefold().encode("utf-8")).hexdigest()
        self.path = lock_root / f"{key}.lock"
        flags = os.O_RDWR | os.O_CREAT
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        self.descriptor = os.open(self.path, flags, 0o600)
        current = os.fstat(self.descriptor)
        if not stat.S_ISREG(current.st_mode) or current.st_nlink != 1:
            os.close(self.descriptor)
            raise RuntimeError("artifact lock must be one regular file with one link")
        try:
            if os.name == "nt":
                import msvcrt
                os.lseek(self.descriptor, 0, os.SEEK_SET)
                if current.st_size == 0:
                    os.write(self.descriptor, b"0")
                    os.fsync(self.descriptor)
                os.lseek(self.descriptor, 0, os.SEEK_SET)
                msvcrt.locking(self.descriptor, msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BaseException:
            os.close(self.descriptor)
            raise RuntimeError(f"another capture publisher holds the artifact lock for {target}")

    def close(self) -> None:
        if self.descriptor < 0:
            return
        try:
            if os.name == "nt":
                import msvcrt
                os.lseek(self.descriptor, 0, os.SEEK_SET)
                msvcrt.locking(self.descriptor, msvcrt.LK_UNLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.descriptor, fcntl.LOCK_UN)
        finally:
            os.close(self.descriptor)
            self.descriptor = -1


class StagedArtifact:
    """One private, unpredictable same-filesystem staging area and locked target."""

    def __init__(self, target: Path) -> None:
        self.target = target.absolute()
        self.target.parent.mkdir(parents=True, exist_ok=True)
        parent_failures = path_component_failures(self.target.parent, "artifact parent")
        if parent_failures:
            raise RuntimeError("; ".join(parent_failures))
        self.lock = ArtifactLock(self.target)
        self.directory: Path | None = None
        try:
            self.initial = regular_file_snapshot(self.target)
            self.directory = Path(tempfile.mkdtemp(
                prefix=f".{self.target.name}.agent-harbor-", dir=self.target.parent
            ))
            try:
                self.directory.chmod(0o700)
            except OSError:
                pass
            self.directory_identity = _file_identity(self.directory.lstat())
        except BaseException:
            if self.directory is not None:
                try:
                    self.directory.rmdir()
                except OSError:
                    pass
            self.lock.close()
            raise
        assert self.directory is not None
        self.path = self.directory / self.target.name
        self.owned_identity: tuple[int, int] | None = None
        self.promoted = False

    def claim_path(self) -> tuple[int, int]:
        current = self.path.lstat()
        if (_is_reparse(self.path, current) or not stat.S_ISREG(current.st_mode)
                or current.st_nlink != 1):
            raise RuntimeError("staged artifact must be one regular non-reparse file")
        identity = _file_identity(current)
        if self.owned_identity is not None and self.owned_identity != identity:
            raise RuntimeError("staged artifact identity changed")
        self.owned_identity = identity
        return identity

    def assert_private_directory(self) -> None:
        current = self.directory.lstat()
        if (_is_reparse(self.directory, current) or not stat.S_ISDIR(current.st_mode)
                or _file_identity(current) != self.directory_identity):
            raise RuntimeError("capture staging directory identity changed")

    def promote(self) -> None:
        self.assert_private_directory()
        if regular_file_snapshot(self.target) != self.initial:
            raise RuntimeError("artifact target changed during capture; refusing publication")
        staged_identity = self.claim_path()
        os.replace(self.path, self.target)
        published = self.target.lstat()
        if _file_identity(published) != staged_identity or published.st_nlink != 1:
            raise RuntimeError("published artifact identity differs from validated staging file")
        self.promoted = True

    def close(self) -> None:
        try:
            self.assert_private_directory()
            if self.owned_identity is not None:
                try:
                    current = self.path.lstat()
                except FileNotFoundError:
                    current = None
                if (current is not None and _file_identity(current) == self.owned_identity
                        and stat.S_ISREG(current.st_mode) and current.st_nlink == 1
                        and not _is_reparse(self.path, current)):
                    self.path.unlink()
            self.directory.rmdir()
        except (FileNotFoundError, OSError):
            # Never recurse into a staging path whose identity is uncertain.
            pass
        finally:
            self.lock.close()


class CastWriter:
    def __init__(
        self,
        staged: StagedArtifact,
        *,
        title: str,
        command: str,
        provenance: PluginProvenance,
        mode: str,
        shell: str,
    ) -> None:
        self.staged = staged
        self.path = staged.path
        self.started = time.monotonic()
        self.previous = self.started
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        descriptor = os.open(self.path, flags, 0o600)
        created = os.fstat(descriptor)
        if not stat.S_ISREG(created.st_mode) or created.st_nlink != 1:
            os.close(descriptor)
            raise RuntimeError("cast staging file must be one regular file with one link")
        self.identity = _file_identity(created)
        self.staged.owned_identity = self.identity
        self.stream: TextIO = os.fdopen(descriptor, "w", encoding="utf-8", newline="\n")
        header = {
            "version": CAST_VERSION,
            "term": {"cols": CAST_COLS, "rows": CAST_ROWS},
            "timestamp": int(time.time()),
            "idle_time_limit": CAST_IDLE_TIME_LIMIT,
            "command": command,
            "title": title,
            "env": {"SHELL": shell},
            "tags": cast_tags(provenance, mode),
        }
        self.stream.write(json.dumps(header, ensure_ascii=True, separators=(",", ":")) + "\n")
        self.stream.flush()

    def output(self, data: str) -> None:
        if not data:
            return
        now = time.monotonic()
        delay = round(max(0.0, now - self.previous), 3)
        self.previous = now
        self.stream.write(json.dumps([delay, "o", data], ensure_ascii=True, separators=(",", ":")) + "\n")
        self.stream.flush()

    def close(self) -> None:
        if self.stream.closed:
            return
        self.stream.flush()
        os.fsync(self.stream.fileno())
        self.stream.close()
        current = self.path.lstat()
        if (_file_identity(current) != self.identity or current.st_nlink != 1
                or _is_reparse(self.path, current)):
            raise RuntimeError("cast staging file identity changed")

    def discard(self) -> None:
        try:
            self.close()
        finally:
            self.staged.close()


def probe_output_failures(output: Path) -> list[str]:
    absolute = output.absolute()
    failures: list[str] = []
    if not absolute.name.endswith(".probe.cast"):
        failures.append("probe output must end in .probe.cast")
    folded_parts = {part.casefold() for part in absolute.parts}
    if "docs" in folded_parts and "assets" in folded_parts:
        failures.append("probe output must never be placed in docs/assets")
    if "work" not in folded_parts and not any(part.startswith(".agent-harbor-probe") for part in folded_parts):
        failures.append("probe output must live under work or an .agent-harbor-probe staging directory")
    return failures


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def publish_artifact_group(files: dict[Path, Path]) -> None:
    """Promote a validated same-directory set with locks and exact error rollback.

    No mainstream filesystem offers an atomic multi-name transaction. This
    routine therefore holds every cooperative lock, backs up every old inode,
    promotes the complete set, and restores the exact old set on any ordinary
    exception. A manifest lets release verification detect a host crash.
    """

    if not files:
        raise ValueError("artifact group must not be empty")
    normalized = {target.absolute(): staged.absolute() for target, staged in files.items()}
    parents = {target.parent for target in normalized}
    if len(parents) != 1:
        raise ValueError("artifact group targets must share one directory")
    parent = next(iter(parents))
    parent_failures = path_component_failures(parent, "artifact group parent")
    if parent_failures:
        raise RuntimeError("; ".join(parent_failures))
    locks: list[ArtifactLock] = []
    backup_directory: Path | None = None
    backup_identity: tuple[int, int] | None = None
    snapshots: dict[Path, tuple[int, int, int, int, int, str] | None] = {}
    staged_identities: dict[Path, tuple[int, int]] = {}
    backups: dict[Path, Path] = {}
    promoted: list[Path] = []
    succeeded = False
    try:
        for target in sorted(normalized, key=lambda item: str(item).casefold()):
            locks.append(ArtifactLock(target))
        snapshots = {target: regular_file_snapshot(target) for target in normalized}
        for target, staged in normalized.items():
            staged_parent_failures = path_component_failures(staged.parent, "staged group parent")
            if staged_parent_failures:
                raise RuntimeError("; ".join(staged_parent_failures))
            current = staged.lstat()
            if (_is_reparse(staged, current) or not stat.S_ISREG(current.st_mode)
                    or current.st_nlink != 1):
                raise RuntimeError(f"staged group member must be one regular file: {staged}")
            if current.st_dev != parent.lstat().st_dev:
                raise RuntimeError("staged group members must share the target filesystem")
            staged_identities[target] = _file_identity(current)
        backup_directory = Path(tempfile.mkdtemp(prefix=".agent-harbor-assets-backup-", dir=parent))
        try:
            backup_directory.chmod(0o700)
        except OSError:
            pass
        backup_identity = _file_identity(backup_directory.lstat())
        for index, target in enumerate(sorted(normalized, key=lambda item: str(item).casefold())):
            if regular_file_snapshot(target) != snapshots[target]:
                raise RuntimeError(f"artifact target changed before group promotion: {target}")
            if snapshots[target] is not None:
                backup = backup_directory / f"{index}-{target.name}"
                os.replace(target, backup)
                backups[target] = backup
            os.replace(normalized[target], target)
            promoted.append(target)
            published = target.lstat()
            if _file_identity(published) != staged_identities[target] or published.st_nlink != 1:
                raise RuntimeError(f"published group member changed identity: {target}")
        succeeded = True
    except BaseException:
        # Roll back only entries whose identities still match what we promoted.
        for target in reversed(promoted):
            try:
                current = target.lstat()
            except FileNotFoundError:
                current = None
            if current is not None and _file_identity(current) == staged_identities[target]:
                target.unlink()
        for target, backup in backups.items():
            if backup.exists() and not target.exists():
                os.replace(backup, target)
        raise
    finally:
        if backup_directory is not None:
            try:
                current_directory = backup_directory.lstat()
                if backup_identity == _file_identity(current_directory) and stat.S_ISDIR(current_directory.st_mode):
                    if succeeded:
                        for backup in backups.values():
                            if backup.exists() and not backup.is_symlink():
                                backup.unlink()
                    backup_directory.rmdir()
            except OSError:
                pass
        for lock in reversed(locks):
            lock.close()
