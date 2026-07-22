#!/usr/bin/env python3
"""Render, validate, manifest, and transactionally publish Asciinema assets."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import math
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
from pathlib import Path

if str(Path(__file__).resolve().parent) not in sys.path:
    sys.path.insert(0, str(Path(__file__).resolve().parent))
import asciinema_capture_common as capture_common


DEFAULT_BASE_NAME = "agent-harbor-commands"


def public_capture_paths() -> tuple[Path, ...]:
    # Construct Windows-looking paths lazily: on POSIX Path.absolute() would
    # otherwise prefix the current directory and weaken lexical matching.
    values = [
        r"R:\agent-foundry-demo", r"R:\team-demo", r"R:\team-demo-home",
        r"C:\agent-foundry-demo", r"C:\team-demo", r"C:\team-demo-home",
        "/tmp/agent-harbor-capture/agent-foundry-demo",
        "/tmp/agent-harbor-capture/team-demo",
        "/tmp/agent-harbor-capture/team-demo-home",
    ]
    return tuple(Path(value) for value in values)


def exact_tool(value: str, label: str) -> Path:
    candidate = Path(value).expanduser()
    if candidate.parent != Path(".") or candidate.is_absolute():
        path = candidate.resolve(strict=True)
    else:
        located = shutil.which(value)
        if located is None:
            raise ValueError(f"{label} executable was not found: {value}")
        path = Path(located).resolve(strict=True)
    if not path.is_file():
        raise ValueError(f"{label} must be a file: {path}")
    path_stat = path.lstat()
    if not stat.S_ISREG(path_stat.st_mode) or path_stat.st_nlink != 1:
        raise ValueError(f"{label} must be one regular file with one link: {path}")
    failures = capture_common.path_component_failures(path, label)
    if failures:
        raise ValueError("; ".join(failures))
    return path


def tool_environment(*tools: Path) -> dict[str, str]:
    directories = tuple(dict.fromkeys((str(tool.parent) for tool in tools)))
    environment = {
        "PATH": os.pathsep.join(directories),
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
    }
    if os.name == "nt":
        system_root = os.environ.get("SystemRoot", r"C:\Windows")
        environment.update({
            "SystemRoot": system_root,
            "WINDIR": os.environ.get("WINDIR", system_root),
            "ComSpec": os.environ.get("ComSpec", str(Path(system_root) / "System32" / "cmd.exe")),
            "PATHEXT": os.environ.get("PATHEXT", ".COM;.EXE;.BAT;.CMD"),
            "PATH": os.pathsep.join((*directories, str(Path(system_root) / "System32"), system_root)),
        })
    return environment


def run_checked(argv: list[str], *, environment: dict[str, str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        argv,
        check=True,
        capture_output=True,
        text=True,
        timeout=300,
        env=environment,
    )


def tool_version(executable: Path, environment: dict[str, str]) -> str:
    try:
        result = run_checked([str(executable), "--version"], environment=environment)
    except subprocess.CalledProcessError:
        result = run_checked([str(executable), "-version"], environment=environment)
    rendered = (result.stdout or result.stderr).strip().splitlines()
    return rendered[0] if rendered else executable.name


def read_cast(path: Path) -> tuple[dict[str, object], list[list[object]], str]:
    lines = path.read_text(encoding="utf-8").splitlines()
    if len(lines) < 2:
        raise ValueError("source cast has no events")
    header = capture_common.strict_json_loads(lines[0])
    events = [capture_common.strict_json_loads(line) for line in lines[1:]]
    if not isinstance(header, dict):
        raise ValueError("source cast header must be an object")
    output = "".join(
        event[2] for event in events
        if isinstance(event, list) and len(event) == 3 and event[1] == "o" and isinstance(event[2], str)
    )
    return header, events, output


def parse_provenance(header: dict[str, object]) -> tuple[str, str]:
    tags = header.get("tags")
    if not isinstance(tags, list) or any(not isinstance(tag, str) for tag in tags):
        raise ValueError("cast lacks provenance tags")
    values = dict(tag.split("=", 1) for tag in tags if "=" in tag)
    if values.get("agent-harbor-mode") != "tour":
        raise ValueError("only a validated full tour may be published")
    version = values.get("agent-harbor-version")
    digest = values.get("agent-harbor-sha256")
    if version != capture_common.EXPECTED_PLUGIN_VERSION:
        raise ValueError(f"cast plugin version must be {capture_common.EXPECTED_PLUGIN_VERSION}")
    if digest is None or re.fullmatch(r"[0-9a-f]{64}", digest) is None:
        raise ValueError("cast plugin digest is missing or malformed")
    return version, digest


def write_trimmed_cast(
    header: dict[str, object],
    events: list[list[object]],
    target: Path,
    trim_seconds: float,
) -> None:
    if not math.isfinite(trim_seconds) or trim_seconds < 0:
        raise ValueError("leading trim must be a finite non-negative number")
    remaining = trim_seconds
    adjusted = json.loads(json.dumps(events))
    for event in adjusted:
        if remaining <= 0:
            break
        if not isinstance(event, list) or len(event) != 3 or not isinstance(event[0], (int, float)):
            raise ValueError("source cast contains an invalid event")
        reduction = min(float(event[0]), remaining)
        event[0] = round(float(event[0]) - reduction, 3)
        remaining -= reduction
    if remaining > 0.001:
        raise ValueError("source cast is shorter than requested leading trim")
    with target.open("x", encoding="utf-8", newline="\n") as stream:
        stream.write(json.dumps(header, ensure_ascii=True, separators=(",", ":")) + "\n")
        for event in adjusted:
            stream.write(json.dumps(event, ensure_ascii=True, separators=(",", ":")) + "\n")
        stream.flush()
        os.fsync(stream.fileno())


def ffprobe(executable: Path, media: Path, environment: dict[str, str]) -> dict[str, object]:
    result = run_checked([
        str(executable), "-v", "error", "-show_entries",
        "format=duration:stream=codec_name,width,height,r_frame_rate,pix_fmt",
        "-of", "json", str(media),
    ], environment=environment)
    parsed = json.loads(result.stdout)
    if not isinstance(parsed, dict):
        raise ValueError(f"ffprobe returned invalid JSON for {media}")
    return parsed


def primary_stream(probe: dict[str, object]) -> dict[str, object]:
    streams = probe.get("streams")
    if not isinstance(streams, list) or not streams or not isinstance(streams[0], dict):
        raise ValueError("ffprobe output has no primary stream")
    return streams[0]


def media_duration(probe: dict[str, object]) -> float:
    format_data = probe.get("format")
    if not isinstance(format_data, dict):
        raise ValueError("ffprobe output has no format data")
    duration = float(format_data.get("duration", 0))
    if not math.isfinite(duration) or duration <= 0:
        raise ValueError("rendered media duration must be positive")
    return duration


def mp4_top_level_boxes(data: bytes) -> list[bytes]:
    """Parse ISO-BMFF top-level boxes without trusting payload substring matches."""

    boxes: list[bytes] = []
    offset = 0
    while offset < len(data):
        if len(data) - offset < 8:
            raise ValueError("MP4 has a truncated top-level box header")
        size = int.from_bytes(data[offset:offset + 4], "big")
        kind = data[offset + 4:offset + 8]
        header_size = 8
        if size == 1:
            if len(data) - offset < 16:
                raise ValueError("MP4 has a truncated extended-size box")
            size = int.from_bytes(data[offset + 8:offset + 16], "big")
            header_size = 16
        elif size == 0:
            size = len(data) - offset
        if size < header_size or offset + size > len(data):
            raise ValueError("MP4 has an invalid top-level box size")
        boxes.append(kind)
        offset += size
    return boxes


def validate_media(gif: Path, mp4: Path, ffprobe_path: Path, environment: dict[str, str]) -> dict[str, object]:
    if gif.read_bytes()[:6] not in {b"GIF87a", b"GIF89a"}:
        raise ValueError("rendered GIF has an invalid signature")
    mp4_bytes = mp4.read_bytes()
    boxes = mp4_top_level_boxes(mp4_bytes)
    if b"moov" not in boxes or b"mdat" not in boxes or boxes.index(b"moov") >= boxes.index(b"mdat"):
        raise ValueError("MP4 must contain a faststart moov atom before mdat")
    gif_probe = ffprobe(ffprobe_path, gif, environment)
    mp4_probe = ffprobe(ffprobe_path, mp4, environment)
    gif_stream = primary_stream(gif_probe)
    mp4_stream = primary_stream(mp4_probe)
    if gif_stream.get("codec_name") != "gif":
        raise ValueError("GIF ffprobe codec must be gif")
    if mp4_stream.get("codec_name") != "h264" or mp4_stream.get("pix_fmt") != "yuv420p":
        raise ValueError("MP4 must be H.264 yuv420p")
    width = int(mp4_stream.get("width", 0))
    height = int(mp4_stream.get("height", 0))
    if width <= 0 or height <= 0 or width % 2 or height % 2:
        raise ValueError("MP4 dimensions must be positive and even")
    if mp4_stream.get("r_frame_rate") != "30/1":
        raise ValueError("MP4 frame rate must be exactly 30 fps")
    gif_width = int(gif_stream.get("width", 0))
    gif_height = int(gif_stream.get("height", 0))
    if gif_width <= 0 or gif_height <= 0:
        raise ValueError("GIF dimensions must be positive")
    if width not in {gif_width, gif_width + 1} or height not in {gif_height, gif_height + 1}:
        raise ValueError("MP4 dimensions must equal the GIF dimensions plus at most one padding pixel")
    gif_duration = media_duration(gif_probe)
    mp4_duration = media_duration(mp4_probe)
    if abs(gif_duration - mp4_duration) > 0.1:
        raise ValueError("GIF and MP4 durations differ by more than 0.1 seconds")
    return {
        "gif": {"width": gif_width, "height": gif_height, "duration": gif_duration},
        "mp4": {"width": width, "height": height, "duration": mp4_duration,
                "codec": "h264", "pixelFormat": "yuv420p"},
    }


def file_record(path: Path, media_type: str) -> dict[str, object]:
    return {
        "file": path.name,
        "mediaType": media_type,
        "bytes": path.stat().st_size,
        "sha256": capture_common.sha256_file(path),
    }


def tool_record(path: Path, environment: dict[str, str]) -> dict[str, str]:
    return {
        "version": tool_version(path, environment),
        "sha256": capture_common.sha256_file(path),
    }


def cleanup_stage(directory: Path, identity: tuple[int, int], known: tuple[Path, ...]) -> None:
    try:
        current = directory.lstat()
    except FileNotFoundError:
        return
    if (current.st_dev, current.st_ino) != identity or not stat.S_ISDIR(current.st_mode):
        return
    for path in known:
        try:
            item = path.lstat()
        except FileNotFoundError:
            continue
        if stat.S_ISREG(item.st_mode) and item.st_nlink == 1 and not path.is_symlink():
            path.unlink()
    try:
        directory.rmdir()
    except OSError:
        print(f"publisher left non-empty staging for manual inspection: {directory}", file=sys.stderr)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-cast", required=True)
    parser.add_argument("--canonical-plugin", required=True)
    parser.add_argument("--asset-dir", required=True)
    parser.add_argument("--base-name", default=DEFAULT_BASE_NAME)
    parser.add_argument("--agg", default="agg")
    parser.add_argument("--ffmpeg", default="ffmpeg")
    parser.add_argument("--ffprobe", default="ffprobe")
    parser.add_argument("--font-dir", required=True)
    parser.add_argument("--font-family", default="Cascadia Code,Segoe UI Symbol,Segoe UI Emoji")
    parser.add_argument("--trim-leading-seconds", type=float, default=4.0)
    args = parser.parse_args()

    if not math.isfinite(args.trim_leading_seconds) or args.trim_leading_seconds < 0:
        raise SystemExit("--trim-leading-seconds must be a finite non-negative number")

    source = Path(args.source_cast).expanduser().resolve(strict=True)
    source_failures = capture_common.path_component_failures(source, "source cast")
    if source_failures:
        raise SystemExit("unsafe source cast:\n- " + "\n- ".join(source_failures))
    source_stat = source.lstat()
    if not stat.S_ISREG(source_stat.st_mode) or source_stat.st_nlink != 1:
        raise SystemExit("source cast must be one regular file with one link")
    source_snapshot = capture_common.regular_file_snapshot(source)
    if source_snapshot is None:
        raise SystemExit("source cast disappeared before validation")
    asset_dir = Path(args.asset_dir).expanduser().absolute()
    asset_dir.mkdir(parents=True, exist_ok=True)
    asset_failures = capture_common.path_component_failures(asset_dir, "asset directory")
    if asset_failures:
        raise SystemExit("unsafe asset directory:\n- " + "\n- ".join(asset_failures))
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{1,80}", args.base_name):
        raise SystemExit("--base-name must be a lowercase safe asset stem")
    agg = exact_tool(args.agg, "agg")
    ffmpeg = exact_tool(args.ffmpeg, "ffmpeg")
    ffprobe_path = exact_tool(args.ffprobe, "ffprobe")
    font_dir = Path(args.font_dir).expanduser().resolve(strict=True)
    if not font_dir.is_dir():
        raise SystemExit(f"font directory must exist: {font_dir}")
    font_failures = capture_common.path_component_failures(font_dir, "font directory")
    if font_failures:
        raise SystemExit("unsafe font directory:\n- " + "\n- ".join(font_failures))
    environment = tool_environment(agg, ffmpeg, ffprobe_path)
    sensitive_values = capture_common.sensitive_environment_values()

    header, events, output = read_cast(source)
    version, plugin_digest = parse_provenance(header)
    canonical_plugin = Path(args.canonical_plugin).expanduser().resolve(strict=True)
    expected_canonical_plugin = Path(__file__).resolve().parents[1] / "plugins" / "agent-foundry"
    canonical_failures = capture_common.validate_canonical_plugin(
        canonical_plugin,
        expected_canonical_plugin,
    )
    if canonical_failures:
        raise SystemExit("unsafe canonical plugin:\n- " + "\n- ".join(canonical_failures))
    try:
        current_provenance = capture_common.plugin_provenance(canonical_plugin, version)
    except (OSError, ValueError, json.JSONDecodeError) as error:
        raise SystemExit(f"canonical plugin provenance failed: {error}") from error
    if current_provenance.digest != plugin_digest:
        raise SystemExit(
            "source cast plugin digest no longer matches the canonical built plugin "
            f"({plugin_digest} != {current_provenance.digest})"
        )
    title = header.get("title")
    title_match = re.fullmatch(
        r"GitHub Copilot CLI (?P<cli>[0-9]+(?:\.[0-9]+)+) · Agent Harbor · "
        r"(?P<host>Windows|POSIX) TUI real",
        title if isinstance(title, str) else "",
    )
    if title_match is None:
        raise SystemExit("source cast title is not an exact non-probe Agent Harbor title")
    expected_shell = "ConPTY" if title_match.group("host") == "Windows" else "PTY"
    provenance = capture_common.PluginProvenance(
        capture_common.EXPECTED_PLUGIN_NAME,
        version,
        plugin_digest,
        0,
    )
    security_failures = capture_common.validate_cast_file_security(
        source,
        private_paths=(source, Path.cwd(), Path.home()),
        public_paths=public_capture_paths(),
        sensitive_values=sensitive_values,
    )
    security_failures.extend(capture_common.validate_cast_header_common(
        header,
        expected_title=title,
        expected_command=(
            "copilot --experimental --no-remote --disable-builtin-mcps "
            "--plugin-dir <agent-foundry> -C <demo-project>"
        ),
        provenance=provenance,
        mode="tour",
        expected_shell=expected_shell,
        private_paths=(source, Path.cwd(), Path.home()),
        public_paths=public_capture_paths(),
        sensitive_values=sensitive_values,
    ))
    security_failures.extend(capture_common.semantic_tour_failures(output))
    if security_failures:
        raise SystemExit("source cast validation failed:\n- " + "\n- ".join(dict.fromkeys(security_failures)))

    stage = Path(tempfile.mkdtemp(prefix=f".{args.base_name}.publish-", dir=asset_dir))
    try:
        stage.chmod(0o700)
    except OSError:
        pass
    stage_identity = (stage.lstat().st_dev, stage.lstat().st_ino)
    staged_cast = stage / f"{args.base_name}.cast"
    render_cast = stage / f"{args.base_name}.render.cast"
    staged_gif = stage / f"{args.base_name}.gif"
    staged_mp4 = stage / f"{args.base_name}.mp4"
    staged_manifest = stage / f"{args.base_name}.manifest.json"
    known = (staged_cast, render_cast, staged_gif, staged_mp4, staged_manifest)
    try:
        shutil.copyfile(source, staged_cast)
        with staged_cast.open("r+b") as stream:
            stream.flush()
            os.fsync(stream.fileno())
        if capture_common.sha256_file(staged_cast) != source_snapshot[-1]:
            raise RuntimeError("staged cast differs from the validated source cast")
        if capture_common.regular_file_snapshot(source) != source_snapshot:
            raise RuntimeError("source cast changed while it was staged")
        write_trimmed_cast(header, events, render_cast, args.trim_leading_seconds)
        run_checked([
            str(agg), "--font-dir", str(font_dir), "--font-family", args.font_family,
            "--font-size", "13", "--line-height", "1.2", "--fps-cap", "30",
            "--last-frame-duration", "0.25", str(render_cast), str(staged_gif),
        ], environment=environment)
        run_checked([
            str(ffmpeg), "-y", "-i", str(staged_gif),
            "-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2,fps=30",
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
            str(staged_mp4),
        ], environment=environment)
        media = validate_media(staged_gif, staged_mp4, ffprobe_path, environment)
        refreshed_provenance = capture_common.plugin_provenance(canonical_plugin, version)
        if refreshed_provenance != current_provenance:
            raise RuntimeError("canonical plugin changed while assets were rendered")
        if capture_common.regular_file_snapshot(source) != source_snapshot:
            raise RuntimeError("source cast changed while assets were rendered")
        manifest = {
            "schema": 1,
            "createdAt": dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z"),
            "sourceCastTimestamp": header.get("timestamp"),
            "plugin": {"name": capture_common.EXPECTED_PLUGIN_NAME, "version": version,
                       "sha256": plugin_digest},
            "tools": {
                "agg": tool_record(agg, environment),
                "ffmpeg": tool_record(ffmpeg, environment),
                "ffprobe": tool_record(ffprobe_path, environment),
            },
            "media": media,
            "artifacts": [
                file_record(staged_cast, "application/x-asciicast"),
                file_record(staged_gif, "image/gif"),
                file_record(staged_mp4, "video/mp4"),
            ],
        }
        serialized_manifest = json.dumps(manifest, ensure_ascii=True, indent=2, sort_keys=True) + "\n"
        manifest_failures = capture_common.privacy_failures(
            serialized_manifest,
            source,
            canonical_plugin,
            asset_dir,
            agg,
            ffmpeg,
            ffprobe_path,
            font_dir,
            sensitive_values=sensitive_values,
        )
        if manifest_failures:
            raise RuntimeError("manifest privacy validation failed: " + "; ".join(manifest_failures))
        with staged_manifest.open("x", encoding="utf-8", newline="\n") as stream:
            stream.write(serialized_manifest)
            stream.flush()
            os.fsync(stream.fileno())
        targets = {
            asset_dir / staged_cast.name: staged_cast,
            asset_dir / staged_gif.name: staged_gif,
            asset_dir / staged_mp4.name: staged_mp4,
            asset_dir / staged_manifest.name: staged_manifest,
        }
        capture_common.publish_artifact_group(targets)
    except BaseException:
        cleanup_stage(stage, stage_identity, known)
        raise
    cleanup_stage(stage, stage_identity, known)
    print(json.dumps(manifest, ensure_ascii=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
