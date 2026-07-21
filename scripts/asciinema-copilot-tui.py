#!/usr/bin/env python3
"""Drive the real GitHub Copilot CLI TUI inside an Asciinema-owned PTY."""

from __future__ import annotations

import argparse
import fcntl
import os
import pty
import select
import signal
import struct
import sys
import termios
import time
from pathlib import Path


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
    if probe:
        return [(probe_command or "/team", 12.0), ("/exit", 3.0)]
    return [
        ("/team", 15.0),
        ("/bench on all", 10.0),
        ("/bench list design", 10.0),
        ('/join {"name":"demo-reviewer","description":"Review risk.","prompt":"Report findings.","tools":["read","search"]}', 12.0),
        ("/team demo-reviewer", 12.0),
        ("/team stop all", 8.0),
        ("/team help", 12.0),
        ("/retire demo-reviewer", 10.0),
        ("/bench off all", 10.0),
        ("/team", 18.0),
        ("/exit", 3.0),
    ]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--probe", action="store_true")
    parser.add_argument("--probe-command", default="")
    parser.add_argument("--copilot", required=True)
    parser.add_argument("--plugin", required=True)
    parser.add_argument("--project", required=True)
    args = parser.parse_args()

    copilot = str(Path(args.copilot).resolve())
    plugin = str(Path(args.plugin).resolve())
    project = str(Path(args.project).resolve())
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
    environment = {
        **os.environ,
        "CI": "",
        "COPILOT_PLUGIN_DIR_ONLY": "true",
        "NO_COLOR": "",
        "TERM": "xterm-256color",
    }

    child, master = pty.fork()
    if child == 0:
        os.execvpe(copilot, argv, environment)

    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 42, 100, 0, 0))
    started = time.monotonic()
    ready_at: float | None = None
    accepted_trust = False
    accepted_extension = False
    trust_prompt_at: float | None = None
    extension_prompt_at: float | None = None
    extension_accepted_at: float | None = None
    tool_prompt_at: float | None = None
    schedule = command_tour(args.probe, args.probe_command)
    position = 0
    next_command_at: float | None = None
    typing_command: str | None = None
    typing_offset = 0
    next_key_at: float | None = None
    enter_at: float | None = None
    last_submitted_at: float | None = None
    buffer = bytearray()
    exit_status = 1
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
                        os.write(master, b"\r")
                        reading_seconds = schedule[position][1]
                        position += 1
                        typing_command = None
                        next_key_at = None
                        enter_at = None
                        last_submitted_at = now
                        next_command_at = now + reading_seconds

            ready, _, _ = select.select([master], [], [], 0.05)
            if ready:
                try:
                    data = os.read(master, 65536)
                except OSError:
                    data = b""
                if not data:
                    break
                os.write(sys.stdout.fileno(), data)
                buffer.extend(data)
                if len(buffer) > 131072:
                    del buffer[:-65536]
                if not accepted_trust and trust_prompt_at is None and b"Confirm folder trust" in buffer:
                    trust_prompt_at = time.monotonic()
                if not accepted_extension and extension_prompt_at is None and b'wants elevated permissions' in buffer:
                    extension_prompt_at = time.monotonic()
                if tool_prompt_at is None and b"Do you want to use this tool?" in buffer:
                    tool_prompt_at = time.monotonic()
                replies = terminal_replies(bytes(buffer))
                if replies:
                    os.write(master, replies)
                    buffer.clear()
                if ready_at is None and accepted_trust and accepted_extension and b"Agent Harbor startup" in data:
                    ready_at = time.monotonic()

            now = time.monotonic()
            if not accepted_trust and trust_prompt_at is not None and now - trust_prompt_at >= 2:
                os.write(master, b"\r")
                accepted_trust = True
                buffer.clear()
            if not accepted_extension and extension_prompt_at is not None and now - extension_prompt_at >= 3:
                os.write(master, b"\r")
                accepted_extension = True
                extension_accepted_at = now
                buffer.clear()
            if tool_prompt_at is not None and now - tool_prompt_at >= 4:
                os.write(master, b"\r")
                tool_prompt_at = None
                buffer.clear()
            if ready_at is None and extension_accepted_at is not None and time.monotonic() - extension_accepted_at >= 4:
                ready_at = time.monotonic()

            waited, status = os.waitpid(child, os.WNOHANG)
            if waited == child:
                exit_status = os.waitstatus_to_exitcode(status)
                break
            if position == len(schedule) and last_submitted_at is not None and now - last_submitted_at > 15:
                os.kill(child, signal.SIGTERM)
                break
            if ready_at is not None and now - ready_at > 420:
                os.kill(child, signal.SIGTERM)
                break
            if ready_at is None and time.monotonic() - started > 45:
                os.kill(child, signal.SIGTERM)
                break
    finally:
        os.close(master)

    return 0 if position == len(schedule) else exit_status


if __name__ == "__main__":
    raise SystemExit(main())
