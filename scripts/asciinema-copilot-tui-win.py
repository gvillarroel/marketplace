#!/usr/bin/env python3
"""Capture the real Windows Copilot TUI as asciicast v3 through ConPTY.

Generation-only dependency: pywinpty==3.0.5. The runtime plugin itself does
not import or require pywinpty.
"""

from __future__ import annotations

import argparse
import ctypes
import json
import os
import re
import select
import stat
import subprocess
import sys
import time
import unicodedata
from pathlib import Path, PureWindowsPath

if str(Path(__file__).resolve().parent) not in sys.path:
    sys.path.insert(0, str(Path(__file__).resolve().parent))
import asciinema_capture_common as capture_common

PALETTE = (
    "0000/0000/0000",
    "ffff/7b7b/7272",
    "3f3f/b9b9/5050",
    "d2d2/a8a8/ffff",
    "5858/a6a6/ffff",
    "b8b8/7f7f/ffff",
    "3939/c5c5/cfcf",
    "b1b1/b8b8/c0c0",
    "6e6e/7676/8181",
    "ffff/a1a1/9898",
    "5656/d3d3/6464",
    "e3e3/b3b3/4141",
    "7979/c0c0/ffff",
    "d2d2/a8a8/ffff",
    "5656/d4d4/dddd",
    "f0f0/f6f6/fcfc",
)

ANSI_ESCAPE_RE = re.compile(
    r"(?:"
    r"\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|"  # OSC
    r"\x1bP.*?\x1b\\|"  # DCS
    r"\x1b\[[0-?]*[ -/]*[@-~]|"  # CSI
    r"\x1b[@-_]|"  # two-byte escape
    r"\x9d[^\x07\x9c]*(?:\x07|\x9c)|"  # 8-bit OSC
    r"\x90.*?\x9c|"  # 8-bit DCS
    r"\x9b[0-?]*[ -/]*[@-~]"  # 8-bit CSI
    r")",
    re.DOTALL,
)
CAST_VERSION = capture_common.CAST_VERSION
CAST_COLS = capture_common.CAST_COLS
CAST_ROWS = capture_common.CAST_ROWS
CAST_IDLE_TIME_LIMIT = capture_common.CAST_IDLE_TIME_LIMIT
CAST_COMMAND = (
    "copilot --experimental --no-remote --disable-builtin-mcps "
    "--plugin-dir <agent-foundry> -C <demo-project>"
)
CAST_TITLE_TEMPLATE = "GitHub Copilot CLI {version} · Agent Harbor · Windows TUI real"

TRUST_PROMPT_HEADING_RE = re.compile(r"\bConfirm\s+folder\s+trust\b", re.IGNORECASE)
EXTENSION_PROMPT_HEADING_RE = re.compile(
    r'\bExtension\s+"(?P<identity>[^"]+)"\s+wants\s+elevated\s+permissions\b',
    re.IGNORECASE,
)
TOOL_PERMISSION_PROMPT_RE = re.compile(
    r"\bDo\s+you\s+want\s+to\s+use\s+this\s+tool\s*\?",
    re.IGNORECASE,
)
WINDOWS_DRIVE_PATH_RE = re.compile(
    r"(?<![0-9A-Za-z])(?P<path>[A-Za-z]:[\\/][^\s\"'<>|\x00-\x1f╭╮╰╯│]*)"
)
WINDOWS_UNC_PATH_RE = re.compile(
    r"(?<![:0-9A-Za-z])(?P<path>(?:\\\\|//)[^\s\"'<>|\x00-\x1f╭╮╰╯│]+)"
)
EXPECTED_EXTENSION_IDENTITY = "plugin:agent-foundry:agent-harbor"
EXPECTED_EXTENSION_PERMISSIONS = "skip tool permission prompts, register hooks."
EXPECTED_TRUST_PATH = r"R:\team-demo"

# The shared contract is authoritative for both native PTY implementations.
TEAM_RESULT_HEADER = capture_common.TEAM_RESULT_HEADER
STOP_RESULT_HEADER = capture_common.STOP_RESULT_HEADER
TEAM_HELP_RESULT_HEADER = capture_common.TEAM_HELP_RESULT_HEADER
BENCH_LIST_RESULT_HEADER = capture_common.BENCH_LIST_RESULT_HEADER
BENCH_RESULT_HEADER = capture_common.BENCH_RESULT_HEADER
JOIN_RESULT_HEADER = capture_common.JOIN_RESULT_HEADER
RETIRE_RESULT_HEADER = capture_common.RETIRE_RESULT_HEADER
COMMAND_RESULT_EXPECTATIONS = capture_common.COMMAND_RESULT_EXPECTATIONS

CANONICAL_PUBLIC_CAPTURE_PATHS = {
    "plugin": Path(r"C:\agent-foundry-demo"),
    "project": Path(r"C:\team-demo"),
    "copilot-home": Path(r"C:\team-demo-home"),
}
CANONICAL_VISIBLE_CAPTURE_PATHS = {
    label: Path(f"R:\\{PureWindowsPath(path).name}")
    for label, path in CANONICAL_PUBLIC_CAPTURE_PATHS.items()
}

# Both names are intentionally public. R: is the visible capture alias and C:
# is the exact expanded root shown by Copilot's extension-permission dialog.
PUBLIC_WINDOWS_PATH_ROOTS = tuple(
    f"{drive}:\\{PureWindowsPath(path).name}"
    for drive in ("R", "C")
    for path in CANONICAL_PUBLIC_CAPTURE_PATHS.values()
)


def terminal_replies(data: str) -> str:
    """Answer capability probes that a graphical terminal would handle."""

    replies: list[str] = []
    if "\x1b[?u" in data:
        replies.append("\x1b[?0u")
    if "\x1b[?2026$p" in data:
        replies.append("\x1b[?2026;2$y")
    if "\x1b[?12$p" in data:
        replies.append("\x1b[?12;2$y")
    if "\x1b[>q" in data:
        replies.append("\x1bP>|asciinema 3.2.1\x1b\\")
    if "\x1b[?996n" in data:
        replies.append("\x1b[?997;2n")
    if "\x1b[6n" in data:
        replies.append("\x1b[1;1R")
    if "\x1b]10;?" in data:
        replies.append("\x1b]10;rgb:f0f0/f6f6/fcfc\x1b\\")
    if "\x1b]11;?" in data:
        replies.append("\x1b]11;rgb:0d0d/1111/1717\x1b\\")
    for index, value in enumerate(PALETTE):
        if f"\x1b]4;{index};?" in data:
            replies.append(f"\x1b]4;{index};rgb:{value}\x1b\\")
    return "".join(replies)


def command_tour(probe: bool, probe_command: str) -> list[tuple[str, float]]:
    return capture_common.command_tour(probe, probe_command)


def expanded_windows_path(path: Path) -> Path:
    """Expand a subst drive when Windows exposes its DOS-device target."""

    absolute = path.absolute()
    if os.name != "nt" or not absolute.drive:
        return absolute.resolve()
    buffer = ctypes.create_unicode_buffer(32768)
    if ctypes.windll.kernel32.QueryDosDeviceW(absolute.drive, buffer, len(buffer)):
        target = buffer.value
        if target.startswith("\\??\\"):
            return Path(target[4:]) / absolute.relative_to(absolute.anchor)
    return absolute.resolve()


def windows_path_key(path: Path) -> str:
    """Return a case-insensitive key for an expanded Windows path."""

    return str(expanded_windows_path(path)).rstrip("\\/").casefold()


def literal_windows_path_key(path: Path) -> str:
    """Return a key without resolving aliases or reparse points."""

    return str(path.absolute()).rstrip("\\/").casefold()


def canonical_capture_path_failures(
    plugin: Path,
    project: Path,
    copilot_home: Path,
) -> list[str]:
    """Require the three intentionally visible paths to use canonical public aliases."""

    actual_paths = {
        "plugin": plugin,
        "project": project,
        "copilot-home": copilot_home,
    }
    failures: list[str] = []
    for label, expected in CANONICAL_PUBLIC_CAPTURE_PATHS.items():
        actual = actual_paths[label]
        if windows_path_key(actual) != literal_windows_path_key(expected):
            failures.append(
                f"{label} must expand to the public capture alias {expected}; "
                f"found {expanded_windows_path(actual)}"
            )
    return failures


def visible_capture_path_failures(
    plugin: Path,
    project: Path,
    copilot_home: Path,
) -> list[str]:
    """Require the literal R: aliases that the privacy/prompt contract records."""

    actual_paths = {
        "plugin": plugin,
        "project": project,
        "copilot-home": copilot_home,
    }
    return [
        f"{label} must use the visible public alias {expected}; found {actual_paths[label]}"
        for label, expected in CANONICAL_VISIBLE_CAPTURE_PATHS.items()
        if literal_windows_path_key(actual_paths[label]) != literal_windows_path_key(expected)
    ]


def private_path_markers(
    *paths: Path,
    public_paths: tuple[Path, ...] = (),
) -> set[str]:
    """Return markers for every supplied path except verified public aliases."""

    home = Path.home().resolve()
    workspace = Path.cwd().resolve()
    markers = {str(home), str(workspace), os.environ.get("USERPROFILE", "")}
    canonical_public_keys = {
        literal_windows_path_key(path)
        for path in CANONICAL_PUBLIC_CAPTURE_PATHS.values()
    }
    public_keys = {
        windows_path_key(path)
        for path in public_paths
        if windows_path_key(path) in canonical_public_keys
    }
    for path in (workspace, *paths):
        absolute = path.absolute()
        resolved = expanded_windows_path(path)
        if windows_path_key(path) in public_keys:
            continue
        for candidate in {absolute, resolved}:
            markers.add(str(candidate))
            try:
                relative = candidate.relative_to(home)
            except ValueError:
                continue
            markers.add(f"~\\{relative}")
            markers.add(f"~/{relative.as_posix()}")
            if len(relative.parts) > 1:
                prefix = Path(*relative.parts[:2])
                markers.add(f"~\\{prefix}")
                markers.add(f"~/{prefix.as_posix()}")
    return {marker for marker in markers if marker}


def strip_ansi(text: str) -> str:
    """Remove complete ANSI/VT escape sequences before security validation."""

    return ANSI_ESCAPE_RE.sub("", text)


def normalize_terminal_text(text: str) -> str:
    """Return terminal output without ANSI or invisible control separators."""

    normalized: list[str] = []
    for character in strip_ansi(text):
        if character == "\r":
            normalized.append("\n")
        elif character in "\n\t":
            normalized.append(character)
        elif character == "\b" or ord(character) < 32 or ord(character) == 127:
            continue
        elif unicodedata.category(character) in {"Cc", "Cf"}:
            # C1 and format controls must not split a sensitive marker.
            continue
        else:
            normalized.append(character)
    return "".join(normalized)


def compact_prompt_text(text: str) -> str:
    """Normalize a TUI dialog into stable prose without its box-drawing frame."""

    without_frame = re.sub(r"[│╭╮╰╯─]+", " ", normalize_terminal_text(text))
    return re.sub(r"\s+", " ", without_frame).strip()


def normalize_windows_path_text(value: str) -> str:
    """Normalize slash and case variants from terminal-rendered Windows paths."""

    return value.rstrip(".,;:!?)]}").replace("/", "\\").rstrip("\\").casefold()


def absolute_windows_paths(text: str) -> list[str]:
    """Find rendered drive-absolute and UNC paths after terminal normalization."""

    normalized = normalize_terminal_text(text)
    matches = [
        (match.start(), match.group("path"))
        for expression in (WINDOWS_DRIVE_PATH_RE, WINDOWS_UNC_PATH_RE)
        for match in expression.finditer(normalized)
    ]
    return [path for _, path in sorted(matches)]


def is_public_windows_path(path: str) -> bool:
    """Return whether a rendered path is one of the exact public roots or a child."""

    normalized = normalize_windows_path_text(path)
    if normalized.startswith("\\\\"):
        return False
    return any(
        normalized == normalize_windows_path_text(root)
        or normalized.startswith(normalize_windows_path_text(root) + "\\")
        for root in PUBLIC_WINDOWS_PATH_ROOTS
    )


def privacy_failures(
    text: str,
    *private_paths: Path,
    public_paths: tuple[Path, ...] = (),
    sensitive_values: tuple[str, ...] = (),
) -> list[str]:
    """Reject paths and credentials in visible text and raw OSC/DCS payloads."""

    return capture_common.privacy_failures(
        text,
        *private_paths,
        public_paths=public_paths,
        sensitive_values=sensitive_values,
    )


def _trust_prompt_failures(output: str) -> list[str]:
    text = compact_prompt_text(output)
    headings = list(TRUST_PROMPT_HEADING_RE.finditer(text))
    failures: list[str] = []
    if len(headings) != 1:
        failures.append(f"expected exactly one folder-trust prompt, observed {len(headings)}")
        return failures

    heading = headings[0]
    next_extension = EXTENSION_PROMPT_HEADING_RE.search(text, heading.end())
    block = text[heading.start():next_extension.start() if next_extension else len(text)]
    description = re.search(
        r"Confirm\s+folder\s+trust\b(?P<path_area>.*?)"
        r"Copilot\s+can\s+read\s+files\s+in\s+this\s+folder",
        block,
        re.IGNORECASE,
    )
    shown_paths = absolute_windows_paths(description.group("path_area")) if description else []
    expected_path_key = normalize_windows_path_text(EXPECTED_TRUST_PATH)
    if description is None or [normalize_windows_path_text(path) for path in shown_paths] != [expected_path_key]:
        failures.append(f"folder-trust prompt must target exactly {EXPECTED_TRUST_PATH}")
    required_patterns = (
        r"Do\s+you\s+trust\s+the\s+files\s+in\s+this\s+folder\s*\?",
        r"❯\s*1\.\s*Yes\b",
        r"2\.\s*Yes,\s+and\s+remember\s+this\s+folder\s+for\s+future\s+sessions",
        r"3\.\s*No\s*\(Esc\)",
    )
    if any(re.search(pattern, block, re.IGNORECASE) is None for pattern in required_patterns):
        failures.append("folder-trust prompt options are incomplete or unexpected")
    return failures


def _extension_prompt_failures(output: str) -> list[str]:
    text = compact_prompt_text(output)
    headings = list(EXTENSION_PROMPT_HEADING_RE.finditer(text))
    failures: list[str] = []
    if len(headings) != 1:
        failures.append(f"expected exactly one extension-permission prompt, observed {len(headings)}")
        return failures

    heading = headings[0]
    identity = heading.group("identity")
    if identity != EXPECTED_EXTENSION_IDENTITY:
        failures.append("extension-permission prompt has an unexpected identity")
    block = text[heading.start():]
    permission_match = re.search(
        r"This\s+extension\s+wants\s+to:\s*(?P<permissions>.*?)\s*"
        r"Denying\s+will\s+prevent\s+this\s+extension\s+from\s+loading\.",
        block,
        re.IGNORECASE,
    )
    permissions = permission_match.group("permissions") if permission_match else None
    if permissions != EXPECTED_EXTENSION_PERMISSIONS:
        failures.append("extension-permission prompt has unexpected permissions")
    exact_always_allow = (
        f'2. Yes, and always allow "{EXPECTED_EXTENSION_IDENTITY}" '
        'in this repo (C:\\team-demo)'
    )
    required_literals = (
        "❯ 1. Yes",
        exact_always_allow,
        "3. No (Esc)",
    )
    if any(literal not in block for literal in required_literals):
        failures.append("extension-permission prompt options are incomplete or unexpected")
    return failures


def has_exact_trust_prompt(output: str) -> bool:
    return not _trust_prompt_failures(output)


def has_exact_extension_prompt(output: str) -> bool:
    return not _extension_prompt_failures(output)


def contains_tool_permission_prompt(output: str) -> bool:
    return TOOL_PERMISSION_PROMPT_RE.search(compact_prompt_text(output)) is not None


def validate_startup_prompts(
    output: str,
    *,
    accepted_trust: bool | None = None,
    accepted_extension: bool | None = None,
) -> list[str]:
    """Validate unique startup dialogs and the driver's acceptance postconditions."""

    failures = [*_trust_prompt_failures(output), *_extension_prompt_failures(output)]
    if contains_tool_permission_prompt(output):
        failures.append("unexpected tool permission prompt")
    text = compact_prompt_text(output)
    trust = TRUST_PROMPT_HEADING_RE.search(text)
    extension = EXTENSION_PROMPT_HEADING_RE.search(text)
    if trust and extension and trust.start() >= extension.start():
        failures.append("startup permission prompts appeared out of order")
    if accepted_trust is not None and not accepted_trust:
        failures.append("folder-trust prompt was not accepted")
    if accepted_extension is not None and not accepted_extension:
        failures.append("extension-permission prompt was not accepted")
    return failures


def parse_model_token_counts(output: str) -> list[int]:
    """Parse every case-insensitive model-token value, failing on malformed counts."""

    return capture_common.parse_model_token_counts(output)


def parse_aic_counts(output: str) -> list[int]:
    """Parse every case-insensitive ``AIC used`` value, failing on malformed counts."""

    return capture_common.parse_aic_counts(output)


def validate_full_tour(
    captured_output: str,
    *private_paths: Path,
    public_paths: tuple[Path, ...] = (),
    accepted_trust: bool | None = None,
    accepted_extension: bool | None = None,
    sensitive_values: tuple[str, ...] = (),
) -> list[str]:
    """Return actionable failures for the deterministic, zero-model tour."""

    normalized_output = normalize_terminal_text(captured_output)
    failures = capture_common.semantic_tour_failures(normalized_output)
    failures.extend(privacy_failures(
        captured_output,
        *private_paths,
        public_paths=public_paths,
        sensitive_values=sensitive_values,
    ))
    failures.extend(validate_startup_prompts(
        normalized_output,
        accepted_trust=accepted_trust,
        accepted_extension=accepted_extension,
    ))
    return list(dict.fromkeys(failures))


def expected_zero_model_marker(command: str) -> str | None:
    if command == "/exit":
        return None
    for expected_command, header, _ in COMMAND_RESULT_EXPECTATIONS:
        if command == expected_command:
            return header
    raise ValueError(f"tour command lacks a zero-model expectation: {command}")


def validate_command_results(results: list[tuple[str, str]]) -> list[str]:
    return capture_common.validate_command_results(results)


def canonical_cast_title(version: str, mode: str = "tour") -> str:
    title = CAST_TITLE_TEMPLATE.format(version=version)
    return title if mode == "tour" else f"{title} · PROBE"


def validate_cast_header(
    header: object,
    expected_version: str,
    *private_paths: Path,
    public_paths: tuple[Path, ...] = (),
    provenance: capture_common.PluginProvenance | None = None,
    mode: str = "tour",
    sensitive_values: tuple[str, ...] = (),
) -> list[str]:
    """Validate the exact redacted header plus immutable plugin provenance."""

    if provenance is None:
        provenance = capture_common.PluginProvenance(
            capture_common.EXPECTED_PLUGIN_NAME,
            capture_common.EXPECTED_PLUGIN_VERSION,
            "0" * 64,
            0,
        )
    return capture_common.validate_cast_header_common(
        header,
        expected_title=canonical_cast_title(expected_version, mode),
        expected_command=CAST_COMMAND,
        provenance=provenance,
        mode=mode,
        expected_shell="ConPTY",
        private_paths=private_paths,
        public_paths=public_paths,
        sensitive_values=sensitive_values,
    )


def write_render_cast(source: Path, target: Path, trim_leading_seconds: float = 4.0) -> None:
    """Write a locked, staged render-only cast with initial idle delay removed."""

    same_existing_file = False
    try:
        same_existing_file = source.exists() and target.exists() and source.samefile(target)
    except OSError:
        # The normalized Windows key below remains the fail-closed path check;
        # samefile only adds hard-link identity when both names are readable.
        pass
    if windows_path_key(source) == windows_path_key(target) or same_existing_file:
        raise ValueError("render cast must not replace the source evidence cast")
    lines = source.read_text(encoding="utf-8").splitlines()
    if len(lines) < 2:
        raise ValueError("source cast has no output events")
    header = json.loads(lines[0])
    events = [json.loads(line) for line in lines[1:]]
    remaining = trim_leading_seconds
    for event in events:
        if remaining <= 0:
            break
        delay = float(event[0])
        reduction = min(delay, remaining)
        event[0] = round(delay - reduction, 3)
        remaining -= reduction
    if remaining > 0.001:
        raise ValueError("source cast is shorter than the requested leading trim")

    staged = capture_common.StagedArtifact(target)
    try:
        with staged.path.open("x", encoding="utf-8", newline="\n") as stream:
            stream.write(json.dumps(header, ensure_ascii=True, separators=(",", ":")) + "\n")
            for event in events:
                stream.write(json.dumps(event, ensure_ascii=True, separators=(",", ":")) + "\n")
            stream.flush()
            os.fsync(stream.fileno())
        staged.claim_path()
        failures = capture_common.validate_cast_events(
            staged.path.read_text(encoding="utf-8").splitlines()[1:],
            public_paths=(
                *CANONICAL_PUBLIC_CAPTURE_PATHS.values(),
                *CANONICAL_VISIBLE_CAPTURE_PATHS.values(),
            ),
        )
        if failures:
            raise ValueError("invalid render cast: " + "; ".join(failures))
        staged.promote()
    except BaseException:
        staged.close()
        raise
    staged.close()


def main() -> int:
    if os.name != "nt":
        raise SystemExit("This recorder requires Windows ConPTY; use asciinema-copilot-tui.py on POSIX.")

    parser = argparse.ArgumentParser()
    parser.add_argument("--probe", action="store_true")
    parser.add_argument("--probe-command", default="")
    parser.add_argument("--copilot", required=True)
    parser.add_argument("--plugin", required=True)
    parser.add_argument("--canonical-plugin", required=True)
    parser.add_argument("--project", required=True)
    parser.add_argument("--copilot-home", required=True)
    parser.add_argument("--capture-owner", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--render-output")
    parser.add_argument("--expected-version", default="1.0.73")
    parser.add_argument("--expected-plugin-version", default=capture_common.EXPECTED_PLUGIN_VERSION)
    args = parser.parse_args()

    def existing_absolute(value: str, *, directory: bool) -> Path:
        path = Path(value).absolute()
        if not path.exists():
            raise SystemExit(f"capture path does not exist: {path}")
        if directory and not path.is_dir():
            raise SystemExit(f"capture path must be a directory: {path}")
        if not directory and not path.is_file():
            raise SystemExit(f"capture path must be a file: {path}")
        return path

    # Preserve an intentional subst drive in the visible TUI. Path.resolve()
    # expands it back to a private host path before Copilot renders trust UI.
    copilot = existing_absolute(args.copilot, directory=False)
    plugin = existing_absolute(args.plugin, directory=True)
    canonical_plugin = existing_absolute(args.canonical_plugin, directory=True)
    project = existing_absolute(args.project, directory=True)
    copilot_home = existing_absolute(args.copilot_home, directory=True)
    output = Path(args.output).absolute()
    if not re.fullmatch(r"[A-Za-z0-9_-]{16,128}", args.capture_owner):
        raise SystemExit("--capture-owner must be a 16-128 character opaque identifier")
    expected_canonical_plugin = Path(__file__).resolve().parents[1] / "plugins" / "agent-foundry"
    output_failures = capture_common.capture_output_failures(
        output,
        expected_canonical_plugin.parents[1] / "work",
        probe=args.probe,
    )
    if output_failures:
        raise SystemExit("unsafe capture output:\n- " + "\n- ".join(output_failures))
    output.parent.mkdir(parents=True, exist_ok=True)

    path_failures = [
        *canonical_capture_path_failures(plugin, project, copilot_home),
        *visible_capture_path_failures(plugin, project, copilot_home),
        *capture_common.path_component_failures(copilot, "copilot"),
        *capture_common.path_component_failures(plugin, "plugin"),
        *capture_common.path_component_failures(canonical_plugin, "canonical plugin"),
        *capture_common.path_component_failures(project, "project"),
        *capture_common.path_component_failures(copilot_home, "copilot-home"),
        *capture_common.validate_canonical_plugin(
            canonical_plugin,
            expected_canonical_plugin,
        ),
        *capture_common.validate_distinct_roots({
            "plugin": plugin,
            "canonical-plugin": canonical_plugin,
            "project": project,
            "copilot-home": copilot_home,
        }),
        *capture_common.validate_capture_owner(plugin, "plugin", args.capture_owner),
        *capture_common.validate_capture_owner(project, "project", args.capture_owner),
        *capture_common.validate_capture_owner(copilot_home, "copilot-home", args.capture_owner),
    ]
    if path_failures:
        raise SystemExit("unsafe capture paths:\n- " + "\n- ".join(path_failures))
    public_capture_paths = (
        plugin,
        project,
        copilot_home,
        *CANONICAL_PUBLIC_CAPTURE_PATHS.values(),
    )
    try:
        provenance = capture_common.verify_plugin_copy(
            plugin,
            canonical_plugin,
            args.expected_plugin_version,
        )
    except (OSError, ValueError, json.JSONDecodeError) as error:
        raise SystemExit(f"plugin provenance validation failed: {error}") from error
    sensitive_parent_values = capture_common.sensitive_environment_values()
    environment = capture_common.build_child_environment(copilot_home, copilot)

    version_result = subprocess.run(
        [str(copilot), "--version"],
        check=True,
        capture_output=True,
        text=True,
        timeout=15,
        env=environment,
    )
    version_line = version_result.stdout.strip().splitlines()[0]
    version_match = re.search(r"GitHub Copilot CLI\s+([0-9]+(?:\.[0-9]+)+)", version_line)
    if not version_match:
        raise SystemExit(f"could not parse Copilot CLI version: {version_line}")
    actual_version = version_match.group(1)
    if actual_version != args.expected_version:
        raise SystemExit(
            f"Copilot CLI {args.expected_version} is required for this capture; found {actual_version}"
        )
    capture_mode = "probe" if args.probe else "tour"
    title = canonical_cast_title(actual_version, capture_mode)

    argv = [
        str(copilot),
        "--banner",
        "--experimental",
        "--no-auto-update",
        "--no-remote",
        "--no-mouse",
        "--no-custom-instructions",
        "--disable-builtin-mcps",
        "--disable-mcp-server",
        "github-mcp-server",
        "--max-ai-credits",
        "30",
        "--plugin-dir",
        str(plugin),
        "-C",
        str(project),
    ]
    try:
        from winpty import Backend, PtyProcess
    except ImportError as error:  # pragma: no cover - actionable CLI boundary
        raise SystemExit(
            "pywinpty 3.0.5 is required: python -m pip install pywinpty==3.0.5"
        ) from error
    staged_output = capture_common.StagedArtifact(output)
    writer = capture_common.CastWriter(
        staged_output,
        title=title,
        command=CAST_COMMAND,
        provenance=provenance,
        mode=capture_mode,
        shell="ConPTY",
    )
    try:
        process = PtyProcess.spawn(
            argv,
            cwd=str(project),
            env=environment,
            dimensions=(42, 100),
            backend=Backend.ConPTY,
        )
    except BaseException:
        writer.discard()
        raise

    started = time.monotonic()
    ready_at: float | None = None
    accepted_trust = False
    accepted_extension = False
    trust_prompt_at: float | None = None
    extension_prompt_at: float | None = None
    startup_seen = False
    unexpected_tool_prompt = False
    schedule = command_tour(args.probe, args.probe_command)
    position = 0
    next_command_at: float | None = None
    typing_command: str | None = None
    typing_offset = 0
    next_key_at: float | None = None
    enter_at: float | None = None
    last_submitted_at: float | None = None
    prompt_buffer = ""
    terminal_buffer = ""
    captured_chunks: list[str] = []
    captured_length = 0
    active_result_command: str | None = None
    active_result_offset = 0
    command_results: list[tuple[str, str]] = []
    loop_error: BaseException | None = None
    forced_termination_reason: str | None = None

    try:
        while True:
            now = time.monotonic()
            if ready_at is not None and next_command_at is None and position == 0:
                next_command_at = ready_at + 6
            if (
                ready_at is not None
                and typing_command is None
                and position < len(schedule)
                and next_command_at is not None
                and now >= next_command_at
            ):
                if active_result_command is not None:
                    command_results.append((
                        active_result_command,
                        "".join(captured_chunks)[active_result_offset:],
                    ))
                    active_result_command = None
                typing_command = schedule[position][0]
                typing_offset = 0
                next_key_at = now
                enter_at = None
            if typing_command is not None and next_key_at is not None:
                if typing_offset < len(typing_command) and now >= next_key_at:
                    character = typing_command[typing_offset]
                    process.write(character)
                    typing_offset += 1
                    next_key_at = now + (0.18 if character == " " else 0.12)
                elif typing_offset == len(typing_command):
                    if enter_at is None:
                        enter_at = now + 1.5
                    elif now >= enter_at:
                        submitted_command = typing_command
                        process.write("\r")
                        reading_seconds = schedule[position][1]
                        position += 1
                        typing_command = None
                        next_key_at = None
                        enter_at = None
                        last_submitted_at = now
                        next_command_at = now + reading_seconds
                        if not args.probe and expected_zero_model_marker(submitted_command) is not None:
                            active_result_command = submitted_command
                            active_result_offset = captured_length

            readable, _, _ = select.select([process.fileobj], [], [], 0.05)
            if readable:
                try:
                    data = process.read(65536)
                except EOFError:
                    data = ""
                if data:
                    writer.output(data)
                    captured_chunks.append(data)
                    captured_length += len(data)
                    prompt_buffer = (prompt_buffer + data)[-131072:]
                    terminal_buffer = (terminal_buffer + data)[-65536:]
                    replies = terminal_replies(terminal_buffer)
                    if replies:
                        process.write(replies)
                        terminal_buffer = ""
                    if (
                        not accepted_trust
                        and trust_prompt_at is None
                        and has_exact_trust_prompt(prompt_buffer)
                    ):
                        trust_prompt_at = time.monotonic()
                    if (
                        not accepted_extension
                        and extension_prompt_at is None
                        and has_exact_extension_prompt(prompt_buffer)
                    ):
                        extension_prompt_at = time.monotonic()
                    if contains_tool_permission_prompt(prompt_buffer):
                        unexpected_tool_prompt = True
                        process.terminate(force=True)
                        break
                    if not startup_seen:
                        startup_seen = "Agent Harbor startup" in normalize_terminal_text(
                            "".join(captured_chunks[-256:])
                        )
                    if ready_at is None and accepted_trust and accepted_extension and startup_seen:
                        ready_at = time.monotonic()

            now = time.monotonic()
            if not accepted_trust and trust_prompt_at is not None and now - trust_prompt_at >= 2:
                process.write("\r")
                accepted_trust = True
                prompt_buffer = ""
            if (
                not accepted_extension
                and extension_prompt_at is not None
                and now - extension_prompt_at >= 3
            ):
                process.write("\r")
                accepted_extension = True
                prompt_buffer = ""
            if ready_at is None and accepted_trust and accepted_extension and startup_seen:
                ready_at = time.monotonic()

            if not process.isalive():
                break
            if position == len(schedule) and last_submitted_at is not None and now - last_submitted_at > 15:
                forced_termination_reason = "Copilot did not exit within 15 seconds after /exit"
                process.terminate(force=True)
                break
            if ready_at is not None and now - ready_at > 420:
                forced_termination_reason = "tour exceeded 420 seconds after startup"
                process.terminate(force=True)
                break
            if ready_at is None and time.monotonic() - started > 60:
                forced_termination_reason = "Copilot startup exceeded 60 seconds"
                process.terminate(force=True)
                break
    except BaseException as error:
        loop_error = error
    finally:
        if process.isalive():
            process.terminate(force=True)
        try:
            process.close(force=True)
        except Exception:
            pass
        try:
            writer.close()
        except BaseException as error:
            if loop_error is None:
                loop_error = error

    if loop_error is not None:
        writer.discard()
        raise loop_error.with_traceback(loop_error.__traceback__)

    failures: list[str] = []
    if unexpected_tool_prompt:
        failures.append("unexpected tool permission prompt")
    if forced_termination_reason:
        failures.append(forced_termination_reason)
    if position != len(schedule):
        failures.append(f"capture stopped after {position}/{len(schedule)} commands")
    if process.exitstatus != 0:
        failures.append(f"Copilot exited with status {process.exitstatus}")
    try:
        staged_stat = writer.path.lstat()
        staged_identity_valid = (
            (staged_stat.st_dev, staged_stat.st_ino) == writer.identity
            and staged_stat.st_nlink == 1
            and stat.S_ISREG(staged_stat.st_mode)
        )
    except OSError:
        staged_identity_valid = False
    if not staged_identity_valid:
        failures.append("capture staging identity changed before validation")
    try:
        cast_lines = writer.path.read_text(encoding="utf-8").splitlines()
        header = capture_common.strict_json_loads(cast_lines[0])
    except (IndexError, json.JSONDecodeError, ValueError, OSError) as error:
        failures.append(f"cast header could not be parsed: {error}")
    else:
        failures.extend(validate_cast_header(
            header,
            actual_version,
            copilot,
            plugin,
            canonical_plugin,
            project,
            copilot_home,
            output,
            *([Path(args.render_output).absolute()] if args.render_output else []),
            public_paths=public_capture_paths,
            provenance=provenance,
            mode=capture_mode,
            sensitive_values=sensitive_parent_values,
        ))
        failures.extend(capture_common.validate_cast_events(
            cast_lines[1:],
            private_paths=(copilot, plugin, canonical_plugin, project, copilot_home, output),
            public_paths=public_capture_paths,
            sensitive_values=sensitive_parent_values,
        ))
    captured_output = "".join(captured_chunks)
    failures.extend(capture_common.basic_capture_failures(
        captured_output,
        copilot,
        plugin,
        canonical_plugin,
        project,
        copilot_home,
        output,
        *([Path(args.render_output).absolute()] if args.render_output else []),
        public_paths=public_capture_paths,
        sensitive_values=sensitive_parent_values,
    ))
    if not args.probe:
        failures.extend(validate_full_tour(
            captured_output,
            copilot,
            plugin,
            canonical_plugin,
            project,
            copilot_home,
            output,
            *([Path(args.render_output).absolute()] if args.render_output else []),
            public_paths=public_capture_paths,
            accepted_trust=accepted_trust,
            accepted_extension=accepted_extension,
            sensitive_values=sensitive_parent_values,
        ))
        failures.extend(validate_command_results(command_results))
    else:
        failures.extend(validate_startup_prompts(
            captured_output,
            accepted_trust=accepted_trust,
            accepted_extension=accepted_extension,
        ))
    try:
        final_provenance = capture_common.verify_plugin_copy(
            plugin,
            canonical_plugin,
            args.expected_plugin_version,
        )
    except (OSError, ValueError, json.JSONDecodeError) as error:
        failures.append(f"plugin provenance changed during capture: {error}")
    else:
        if final_provenance != provenance:
            failures.append("plugin provenance changed during capture")
    if failures:
        writer.discard()
        print("capture validation failed:", file=sys.stderr)
        for failure in failures:
            print(f"- {failure}", file=sys.stderr)
        return 1
    try:
        staged_output.promote()
    except BaseException:
        staged_output.close()
        raise
    staged_output.close()
    if args.render_output:
        write_render_cast(output, Path(args.render_output).absolute())
    print(json.dumps({
        "capture": "validated",
        "mode": capture_mode,
        "plugin": provenance.name,
        "pluginVersion": provenance.version,
        "pluginSha256": provenance.digest,
        "pluginFiles": provenance.files,
        "output": str(output),
    }, ensure_ascii=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
