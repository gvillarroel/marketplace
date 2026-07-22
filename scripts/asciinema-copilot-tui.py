#!/usr/bin/env python3
"""Drive the real GitHub Copilot CLI TUI inside an Asciinema-owned PTY."""

from __future__ import annotations

import argparse
import codecs
import json
import os
import re
import select
import stat
import subprocess
import sys
import time
import unicodedata
from pathlib import Path

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
    rb"(?:"
    rb"\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|"
    rb"\x1bP.*?\x1b\\|"
    rb"\x1b\[[0-?]*[ -/]*[@-~]|"
    rb"\x1b[@-_]"
    rb")",
    re.DOTALL,
)
C1_ESCAPE_RE = re.compile(
    r"(?:"
    r"\udc9d[^\x07\udc9c]*(?:\x07|\udc9c)|"
    r"\udc90.*?\udc9c|"
    r"\udc9b[0-?]*[ -/]*[@-~]"
    r")",
    re.DOTALL,
)
TOOL_PERMISSION_PROMPT = b"do you want to use this tool?"
TRUST_PROMPT_HEADING_RE = re.compile(r"\bConfirm\s+folder\s+trust\b", re.IGNORECASE)
EXTENSION_PROMPT_HEADING_RE = re.compile(
    r'\bExtension\s+"(?P<identity>[^"]+)"\s+wants\s+elevated\s+permissions\b',
    re.IGNORECASE,
)
EXPECTED_EXTENSION_IDENTITY = "plugin:agent-foundry:agent-harbor"
EXPECTED_EXTENSION_PERMISSIONS = "skip tool permission prompts, register hooks."
POSIX_CAST_COMMAND = (
    "copilot --experimental --no-remote --disable-builtin-mcps "
    "--plugin-dir <agent-foundry> -C <demo-project>"
)
POSIX_CAST_TITLE = "GitHub Copilot CLI {version} · Agent Harbor · POSIX TUI real"
POSIX_PUBLIC_CAPTURE_PATHS = {
    "plugin": Path("/tmp/agent-harbor-capture/agent-foundry-demo"),
    "project": Path("/tmp/agent-harbor-capture/team-demo"),
    "copilot-home": Path("/tmp/agent-harbor-capture/team-demo-home"),
}


def decoded_terminal_text(data: bytes) -> str:
    """Decode UTF-8 while distinguishing raw C1 bytes from valid continuations."""

    without_ansi = ANSI_ESCAPE_RE.sub(b"", data)
    decoded = without_ansi.decode("utf-8", errors="surrogateescape")
    return C1_ESCAPE_RE.sub("", decoded)


def normalized_terminal_bytes(data: bytes) -> bytes:
    """Strip ANSI and controls so prompts cannot hide behind VT formatting."""

    decoded = decoded_terminal_text(data)
    printable = "".join(
        character
        for character in decoded
        if character in "\r\n\t"
        or unicodedata.category(character) not in {"Cc", "Cf", "Cs"}
    )
    return re.sub(r"\s+", " ", printable).strip().casefold().encode("utf-8")


def contains_terminal_phrase(data: bytes, phrase: bytes) -> bool:
    return phrase.lower() in normalized_terminal_bytes(data)


def contains_tool_permission_prompt(data: bytes) -> bool:
    return contains_terminal_phrase(data, TOOL_PERMISSION_PROMPT)


def compact_terminal_text(data: bytes) -> str:
    """Normalize one UTF-8 TUI dialog without ANSI or box-drawing layout."""

    decoded = decoded_terminal_text(data)
    decoded = "".join(
        character
        for character in decoded
        if character in "\r\n\t"
        or unicodedata.category(character) not in {"Cc", "Cf", "Cs"}
    )
    without_frame = re.sub(r"[│┃╭╮╰╯─━]+", " ", decoded)
    return re.sub(r"\s+", " ", without_frame).strip()


def trust_prompt_failures(data: bytes, expected_project: Path) -> list[str]:
    text = compact_terminal_text(data)
    headings = list(TRUST_PROMPT_HEADING_RE.finditer(text))
    failures: list[str] = []
    if len(headings) != 1:
        return [f"expected exactly one folder-trust prompt, observed {len(headings)}"]
    heading = headings[0]
    next_extension = EXTENSION_PROMPT_HEADING_RE.search(text, heading.end())
    block = text[heading.start():next_extension.start() if next_extension else len(text)]
    description = re.search(
        r"Confirm\s+folder\s+trust\b(?P<path_area>.*?)"
        r"Copilot\s+can\s+read\s+files\s+in\s+this\s+folder",
        block,
        re.IGNORECASE,
    )
    shown_path = description.group("path_area").strip() if description else None
    if shown_path != str(expected_project):
        failures.append("folder-trust prompt must target exactly --project")
    required_patterns = (
        r"Do\s+you\s+trust\s+the\s+files\s+in\s+this\s+folder\s*\?",
        r"❯\s*1\.\s*Yes\b",
        r"2\.\s*Yes,\s+and\s+remember\s+this\s+folder\s+for\s+future\s+sessions",
        r"3\.\s*No\s*\(Esc\)",
    )
    if any(re.search(pattern, block, re.IGNORECASE) is None for pattern in required_patterns):
        failures.append("folder-trust prompt options are incomplete or unexpected")
    return failures


def extension_prompt_failures(data: bytes, expected_project: Path) -> list[str]:
    text = compact_terminal_text(data)
    headings = list(EXTENSION_PROMPT_HEADING_RE.finditer(text))
    failures: list[str] = []
    if len(headings) != 1:
        return [f"expected exactly one extension-permission prompt, observed {len(headings)}"]
    heading = headings[0]
    if heading.group("identity") != EXPECTED_EXTENSION_IDENTITY:
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
        f"in this repo ({expected_project})"
    )
    if any(literal not in block for literal in ("❯ 1. Yes", exact_always_allow, "3. No (Esc)")):
        failures.append("extension-permission prompt options are incomplete or unexpected")
    return failures


def has_exact_trust_prompt(data: bytes, expected_project: Path) -> bool:
    return not trust_prompt_failures(data, expected_project)


def has_exact_extension_prompt(data: bytes, expected_project: Path) -> bool:
    return not extension_prompt_failures(data, expected_project)


def validate_startup_prompts(
    data: bytes,
    expected_project: Path,
    *,
    accepted_trust: bool,
    accepted_extension: bool,
) -> list[str]:
    failures = [
        *trust_prompt_failures(data, expected_project),
        *extension_prompt_failures(data, expected_project),
    ]
    if contains_tool_permission_prompt(data):
        failures.append("unexpected tool permission prompt")
    text = compact_terminal_text(data)
    trust = TRUST_PROMPT_HEADING_RE.search(text)
    extension = EXTENSION_PROMPT_HEADING_RE.search(text)
    if trust and extension and trust.start() >= extension.start():
        failures.append("startup permission prompts appeared out of order")
    if not accepted_trust:
        failures.append("folder-trust prompt was not accepted")
    if not accepted_extension:
        failures.append("extension-permission prompt was not accepted")
    return failures


def completed_invalid_startup_prompt(data: bytes, expected_project: Path) -> str | None:
    """Name a completed startup dialog that is unsafe to accept, if present."""

    text = compact_terminal_text(data)
    lowered = text.casefold()
    if "enter to select" not in lowered or "esc to cancel" not in lowered:
        return None
    if TRUST_PROMPT_HEADING_RE.search(text) and trust_prompt_failures(data, expected_project):
        return "folder-trust prompt did not match the exact project/options contract"
    if "wants elevated permissions" in lowered and extension_prompt_failures(data, expected_project):
        return "extension-permission prompt did not match the exact identity/permissions contract"
    return None


def existing_capture_path(value: str, label: str, *, directory: bool) -> Path:
    """Resolve one required capture input and reject missing/wrong-kind paths."""

    literal = Path(value).expanduser().absolute()
    component_failures = capture_common.path_component_failures(literal, label)
    if component_failures:
        raise ValueError("; ".join(component_failures))
    try:
        path = literal.resolve(strict=True)
    except OSError as error:
        raise ValueError(f"{label} path does not exist: {value}") from error
    if directory and not path.is_dir():
        raise ValueError(f"{label} path must be a directory: {path}")
    if not directory and not path.is_file():
        raise ValueError(f"{label} path must be a file: {path}")
    return path


def isolated_copilot_home_failures(
    copilot_home: Path,
    *,
    plugin: Path | None = None,
    project: Path | None = None,
) -> list[str]:
    """Keep demo roster mutations away from the user's normal Copilot state."""

    home = Path.home().resolve()
    candidate = copilot_home.resolve()
    failures: list[str] = []

    def overlaps(left: Path, right: Path) -> bool:
        return left == right or left in right.parents or right in left.parents

    default_copilot_home = (home / ".copilot").resolve()
    if candidate == home or overlaps(candidate, default_copilot_home):
        failures.append(
            "--copilot-home must not overlap the user's real home or default .copilot directory"
        )
    if plugin is not None and overlaps(candidate, plugin.resolve()):
        failures.append("--copilot-home must not overlap --plugin")
    if project is not None and overlaps(candidate, project.resolve()):
        failures.append("--copilot-home must not overlap --project")
    return failures


def build_environment(copilot_home: Path, copilot: Path | None = None) -> dict[str, str]:
    executable = copilot or Path("/usr/bin/copilot")
    return capture_common.build_child_environment(copilot_home, executable)


def capture_exit_failures(
    *,
    position: int,
    expected_commands: int,
    exit_status: int | None,
    forced_termination_reason: str | None,
    unexpected_tool_prompt: bool,
    accepted_trust: bool,
    accepted_extension: bool,
) -> list[str]:
    """Require the complete tour and a clean child exit; timeouts never pass."""

    failures: list[str] = []
    if unexpected_tool_prompt:
        failures.append("unexpected tool permission prompt")
    if forced_termination_reason:
        failures.append(forced_termination_reason)
    if position != expected_commands:
        failures.append(f"capture stopped after {position}/{expected_commands} commands")
    if exit_status != 0:
        failures.append(f"Copilot exited with status {exit_status}")
    if not accepted_trust:
        failures.append("folder-trust prompt was not accepted")
    if not accepted_extension:
        failures.append("extension-permission prompt was not accepted")
    return failures


def validate_tour_postconditions(
    output: str,
    command_results: list[tuple[str, str]],
    *,
    probe: bool,
    private_paths: tuple[Path, ...] = (),
    public_paths: tuple[Path, ...] = (),
    sensitive_values: tuple[str, ...] = (),
) -> list[str]:
    """Apply the shared Windows/POSIX semantic and raw-security contract."""

    failures = capture_common.basic_capture_failures(
        output,
        *private_paths,
        public_paths=public_paths,
        sensitive_values=sensitive_values,
    )
    if not probe:
        failures.extend(capture_common.semantic_tour_failures(output))
        failures.extend(capture_common.validate_command_results(command_results))
    return list(dict.fromkeys(failures))


def terminal_replies(data: bytes) -> bytes:
    """Answer the capability probes a real terminal emulator would handle."""

    replies = bytearray()
    if b"\x1b[?u" in data:
        replies.extend(b"\x1b[?0u")
    if b"\x1b[?2026$p" in data:
        replies.extend(b"\x1b[?2026;2$y")
    if b"\x1b[?12$p" in data:
        replies.extend(b"\x1b[?12;2$y")
    if b"\x1b[>q" in data:
        replies.extend(b"\x1bP>|asciinema 3.2.1\x1b\\")
    if b"\x1b[?996n" in data:
        replies.extend(b"\x1b[?997;2n")
    if b"\x1b[6n" in data:
        replies.extend(b"\x1b[1;1R")
    if b"\x1b]10;?" in data:
        replies.extend(b"\x1b]10;rgb:f0f0/f6f6/fcfc\x1b\\")
    if b"\x1b]11;?" in data:
        replies.extend(b"\x1b]11;rgb:0d0d/1111/1717\x1b\\")
    for index, value in enumerate(PALETTE):
        if f"\x1b]4;{index};?".encode() in data:
            replies.extend(f"\x1b]4;{index};rgb:{value}\x1b\\".encode())
    return bytes(replies)


def command_tour(probe: bool, probe_command: str) -> list[tuple[str, float]]:
    return capture_common.command_tour(probe, probe_command)


def main() -> int:
    try:
        import fcntl
        import pty
        import signal
        import struct
        import termios
    except ImportError as error:  # pragma: no cover - platform boundary
        raise SystemExit("This recorder requires a POSIX PTY host.") from error

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
    parser.add_argument("--expected-version", default="1.0.73")
    parser.add_argument("--expected-plugin-version", default=capture_common.EXPECTED_PLUGIN_VERSION)
    args = parser.parse_args()

    try:
        copilot_path = existing_capture_path(args.copilot, "copilot", directory=False)
        plugin_path = existing_capture_path(args.plugin, "plugin", directory=True)
        canonical_plugin_path = existing_capture_path(
            args.canonical_plugin,
            "canonical-plugin",
            directory=True,
        )
        project_path = existing_capture_path(args.project, "project", directory=True)
        copilot_home_path = existing_capture_path(
            args.copilot_home,
            "copilot-home",
            directory=True,
        )
    except ValueError as error:
        raise SystemExit(str(error)) from error
    output_path = Path(args.output).expanduser().absolute()
    if not re.fullmatch(r"[A-Za-z0-9_-]{16,128}", args.capture_owner):
        raise SystemExit("--capture-owner must be a 16-128 character opaque identifier")
    expected_canonical_plugin = Path(__file__).resolve().parents[1] / "plugins" / "agent-foundry"
    output_failures = capture_common.capture_output_failures(
        output_path,
        expected_canonical_plugin.parents[1] / "work",
        probe=args.probe,
    )
    if output_failures:
        raise SystemExit("unsafe capture output:\n- " + "\n- ".join(output_failures))
    output_path.parent.mkdir(parents=True, exist_ok=True)
    home_failures = isolated_copilot_home_failures(
        copilot_home_path,
        plugin=plugin_path,
        project=project_path,
    )
    if home_failures:
        raise SystemExit("unsafe Copilot home:\n- " + "\n- ".join(home_failures))
    actual_roots = {
        "plugin": plugin_path,
        "project": project_path,
        "copilot-home": copilot_home_path,
    }
    path_failures = [
        *capture_common.validate_distinct_roots({
            **actual_roots,
            "canonical-plugin": canonical_plugin_path,
        }),
        *capture_common.validate_canonical_plugin(
            canonical_plugin_path,
            expected_canonical_plugin,
        ),
        *(
            f"{label} must be the exact public capture root {expected}; found {actual_roots[label]}"
            for label, expected in POSIX_PUBLIC_CAPTURE_PATHS.items()
            if actual_roots[label] != expected
        ),
        *capture_common.validate_capture_owner(plugin_path, "plugin", args.capture_owner),
        *capture_common.validate_capture_owner(project_path, "project", args.capture_owner),
        *capture_common.validate_capture_owner(copilot_home_path, "copilot-home", args.capture_owner),
    ]
    if path_failures:
        raise SystemExit("unsafe capture paths:\n- " + "\n- ".join(path_failures))
    try:
        provenance = capture_common.verify_plugin_copy(
            plugin_path,
            canonical_plugin_path,
            args.expected_plugin_version,
        )
    except (OSError, ValueError, json.JSONDecodeError) as error:
        raise SystemExit(f"plugin provenance validation failed: {error}") from error
    sensitive_parent_values = capture_common.sensitive_environment_values()
    copilot = str(copilot_path)
    plugin = str(plugin_path)
    project = str(project_path)
    argv = [
        copilot,
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
        plugin,
        "-C",
        project,
    ]
    environment = build_environment(copilot_home_path, copilot_path)
    version_result = subprocess.run(
        [copilot, "--version"],
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
    title = POSIX_CAST_TITLE.format(version=actual_version)
    if args.probe:
        title += " · PROBE"
    staged_output = capture_common.StagedArtifact(output_path)
    writer = capture_common.CastWriter(
        staged_output,
        title=title,
        command=POSIX_CAST_COMMAND,
        provenance=provenance,
        mode=capture_mode,
        shell="PTY",
    )

    try:
        child, master = pty.fork()
    except BaseException:
        writer.discard()
        raise
    if child == 0:
        try:
            os.execvpe(copilot, argv, environment)
        except BaseException as error:  # pragma: no cover - child process boundary
            print(f"could not start Copilot: {error}", file=sys.stderr)
            os._exit(127)

    def terminate_and_reap() -> int | None:
        try:
            os.kill(child, signal.SIGTERM)
        except ProcessLookupError:
            pass
        deadline = time.monotonic() + 2.0
        while time.monotonic() < deadline:
            try:
                waited, status = os.waitpid(child, os.WNOHANG)
            except ChildProcessError:
                return None
            if waited == child:
                return os.waitstatus_to_exitcode(status)
            time.sleep(0.05)
        try:
            os.kill(child, signal.SIGKILL)
        except ProcessLookupError:
            pass
        try:
            _, status = os.waitpid(child, 0)
        except ChildProcessError:
            return None
        return os.waitstatus_to_exitcode(status)

    try:
        fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 42, 100, 0, 0))
    except BaseException:
        try:
            terminate_and_reap()
        finally:
            try:
                os.close(master)
            except OSError:
                pass
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
    forced_termination_reason: str | None = None
    schedule = command_tour(args.probe, args.probe_command)
    position = 0
    next_command_at: float | None = None
    typing_command: str | None = None
    typing_offset = 0
    next_key_at: float | None = None
    enter_at: float | None = None
    last_submitted_at: float | None = None
    prompt_buffer = bytearray()
    terminal_buffer = bytearray()
    captured_output = bytearray()
    captured_length = 0
    active_result_command: str | None = None
    active_result_offset = 0
    command_results: list[tuple[str, str]] = []
    decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
    exit_status: int | None = None
    loop_error: BaseException | None = None
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
                    segment = bytes(captured_output[active_result_offset:]).decode(
                        "utf-8", errors="replace"
                    )
                    command_results.append((active_result_command, segment))
                    active_result_command = None
                typing_command = schedule[position][0]
                typing_offset = 0
                next_key_at = now
                enter_at = None
            if typing_command is not None and next_key_at is not None:
                if typing_offset < len(typing_command) and now >= next_key_at:
                    character = typing_command[typing_offset]
                    os.write(master, character.encode())
                    typing_offset += 1
                    next_key_at = now + (0.18 if character == " " else 0.12)
                elif typing_offset == len(typing_command):
                    if enter_at is None:
                        enter_at = now + 1.5
                    elif now >= enter_at:
                        submitted_command = typing_command
                        os.write(master, b"\r")
                        reading_seconds = schedule[position][1]
                        position += 1
                        typing_command = None
                        next_key_at = None
                        enter_at = None
                        last_submitted_at = now
                        next_command_at = now + reading_seconds
                        if not args.probe and submitted_command != "/exit":
                            active_result_command = submitted_command
                            active_result_offset = captured_length

            ready, _, _ = select.select([master], [], [], 0.05)
            if ready:
                try:
                    data = os.read(master, 65536)
                except OSError:
                    data = b""
                if not data:
                    waited, status = os.waitpid(child, os.WNOHANG)
                    if waited == child:
                        exit_status = os.waitstatus_to_exitcode(status)
                    else:
                        forced_termination_reason = "Copilot PTY closed before a clean child exit"
                    break
                os.write(sys.stdout.fileno(), data)
                writer.output(decoder.decode(data))
                prompt_buffer.extend(data)
                terminal_buffer.extend(data)
                captured_output.extend(data)
                captured_length += len(data)
                if len(prompt_buffer) > 131072:
                    del prompt_buffer[:-65536]
                if len(terminal_buffer) > 65536:
                    del terminal_buffer[:-32768]
                if (
                    not accepted_trust
                    and trust_prompt_at is None
                    and has_exact_trust_prompt(bytes(prompt_buffer), project_path)
                ):
                    trust_prompt_at = time.monotonic()
                if (
                    not accepted_extension
                    and extension_prompt_at is None
                    and has_exact_extension_prompt(bytes(prompt_buffer), project_path)
                ):
                    extension_prompt_at = time.monotonic()
                if contains_tool_permission_prompt(bytes(prompt_buffer)):
                    unexpected_tool_prompt = True
                    forced_termination_reason = "capture aborted before approving a tool prompt"
                    break
                invalid_prompt = completed_invalid_startup_prompt(
                    bytes(prompt_buffer),
                    project_path,
                )
                if invalid_prompt is not None:
                    forced_termination_reason = invalid_prompt
                    break
                replies = terminal_replies(bytes(terminal_buffer))
                if replies:
                    os.write(master, replies)
                    terminal_buffer.clear()
                if not startup_seen:
                    startup_seen = contains_terminal_phrase(
                        bytes(captured_output[-131072:]),
                        b"Agent Harbor startup",
                    )
                if ready_at is None and accepted_trust and accepted_extension and startup_seen:
                    ready_at = time.monotonic()

            if unexpected_tool_prompt or (
                forced_termination_reason is not None
                and "prompt did not match" in forced_termination_reason
            ):
                break

            now = time.monotonic()
            if not accepted_trust and trust_prompt_at is not None and now - trust_prompt_at >= 2:
                os.write(master, b"\r")
                accepted_trust = True
                prompt_buffer.clear()
            if not accepted_extension and extension_prompt_at is not None and now - extension_prompt_at >= 3:
                os.write(master, b"\r")
                accepted_extension = True
                prompt_buffer.clear()
            if ready_at is None and accepted_trust and accepted_extension and startup_seen:
                ready_at = time.monotonic()

            waited, status = os.waitpid(child, os.WNOHANG)
            if waited == child:
                exit_status = os.waitstatus_to_exitcode(status)
                break
            if position == len(schedule) and last_submitted_at is not None and now - last_submitted_at > 15:
                forced_termination_reason = "Copilot did not exit within 15 seconds after /exit"
                break
            if ready_at is not None and now - ready_at > 420:
                forced_termination_reason = "tour exceeded 420 seconds after startup"
                break
            if ready_at is None and time.monotonic() - started > 45:
                forced_termination_reason = "Copilot startup exceeded 45 seconds"
                break
    except BaseException as error:
        loop_error = error
    finally:
        if exit_status is None:
            exit_status = terminate_and_reap()
        os.close(master)
        try:
            writer.output(decoder.decode(b"", final=True))
            writer.close()
        except BaseException as error:
            if loop_error is None:
                loop_error = error

    if loop_error is not None:
        writer.discard()
        raise loop_error.with_traceback(loop_error.__traceback__)
    failures = capture_exit_failures(
        position=position,
        expected_commands=len(schedule),
        exit_status=exit_status,
        forced_termination_reason=forced_termination_reason,
        unexpected_tool_prompt=unexpected_tool_prompt,
        accepted_trust=accepted_trust,
        accepted_extension=accepted_extension,
    )
    failures.extend(validate_startup_prompts(
        bytes(captured_output),
        project_path,
        accepted_trust=accepted_trust,
        accepted_extension=accepted_extension,
    ))
    captured_security_text = bytes(captured_output).decode("utf-8", errors="surrogateescape")
    public_paths = (plugin_path, project_path, copilot_home_path)
    failures.extend(validate_tour_postconditions(
        captured_security_text,
        command_results,
        probe=args.probe,
        private_paths=(copilot_path, canonical_plugin_path, output_path),
        public_paths=public_paths,
        sensitive_values=sensitive_parent_values,
    ))
    try:
        cast_lines = writer.path.read_text(encoding="utf-8").splitlines()
        header = capture_common.strict_json_loads(cast_lines[0])
    except (OSError, IndexError, json.JSONDecodeError, ValueError) as error:
        failures.append(f"cast could not be parsed: {error}")
    else:
        failures.extend(capture_common.validate_cast_header_common(
            header,
            expected_title=title,
            expected_command=POSIX_CAST_COMMAND,
            provenance=provenance,
            mode=capture_mode,
            expected_shell="PTY",
            private_paths=(copilot_path, canonical_plugin_path, output_path),
            public_paths=public_paths,
            sensitive_values=sensitive_parent_values,
        ))
        failures.extend(capture_common.validate_cast_events(
            cast_lines[1:],
            private_paths=(copilot_path, canonical_plugin_path, output_path),
            public_paths=public_paths,
            sensitive_values=sensitive_parent_values,
        ))
    try:
        final_provenance = capture_common.verify_plugin_copy(
            plugin_path,
            canonical_plugin_path,
            args.expected_plugin_version,
        )
    except (OSError, ValueError, json.JSONDecodeError) as error:
        failures.append(f"plugin provenance changed during capture: {error}")
    else:
        if final_provenance != provenance:
            failures.append("plugin provenance changed during capture")
    failures = list(dict.fromkeys(failures))
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
    print(json.dumps({
        "capture": "validated",
        "mode": capture_mode,
        "plugin": provenance.name,
        "pluginVersion": provenance.version,
        "pluginSha256": provenance.digest,
        "pluginFiles": provenance.files,
        "output": str(output_path),
    }, ensure_ascii=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
