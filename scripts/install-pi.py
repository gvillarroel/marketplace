#!/usr/bin/env python3
"""Build and optionally install Agent Harbor as a native Pi package."""

from __future__ import annotations

import argparse
import importlib.util
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PLUGINS = ROOT / "plugins"
PUBLIC_COMMANDS = {"bench", "join", "retire", "contract", "list-skills"}
PACKAGE_NAME = "agent-harbor-pi"
PACKAGE_VERSION = "0.10.0"

spec = importlib.util.spec_from_file_location("agent_harbor_opencode", Path(__file__).with_name("install-opencode.py"))
common = importlib.util.module_from_spec(spec)
assert spec and spec.loader
sys.dont_write_bytecode = True
spec.loader.exec_module(common)


def adapt(text: str) -> str:
    replacements = (
        ("COPILOT_HOME", "PI_CODING_AGENT_DIR"),
        ("<copilot-home>", "<pi-home>"),
        ("copilot-home", "pi-home"),
        ("home directory plus `.copilot`", "home directory plus `.pi/agent`"),
        (".github/agents/", ".pi/agents/"),
        ("`../../bench/<id>.agent.md`", "`../../agent-foundry/bench/<id>.md`"),
        (".agent.md", ".md"),
        ("Copilot's outer skill-context wrapper", "Pi's outer skill-context wrapper"),
        ("Copilot's outer wrapper", "Pi's outer wrapper"),
        ("Copilot's native", "Pi's native"),
        ("native Copilot subagent", "isolated Pi child process"),
        ("launch Copilot", "launch an interactive Pi session"),
        ("new Copilot session", "new Pi session or `/reload`"),
        ("Copilot session", "Pi session"),
        ("Copilot specialist", "Pi specialist"),
        ("Copilot players", "Pi players"),
        ("Copilot player", "Pi player"),
        ("Copilot's built-in", "Pi's built-in"),
        ("Copilot CLI", "Pi"),
        ("not a Copilot agent discovery directory", "not a project-local Pi agent directory"),
        ("repo-cartographer:crafter", "crafter"),
        ("repo-cartographer:repo-cartographer", "repo-cartographer"),
    )
    for old, new in replacements:
        text = text.replace(old, new)
    text = text.replace(
        "Use the current runtime's native `task` tool.",
        "Use one synchronous ephemeral child via `pi --no-session -p`, passing the composed prompt as one argument and a mapped `--tools` allowlist.",
    )
    text = text.replace(
        "The task tool's `agent_type` must be exactly `explore` when tools are read-only and no GitHub reference exists, exactly `task` when `execute` but not `edit` is requested, and exactly `general-purpose` when `edit` is requested. Call `task` exactly once, synchronously, and return its actual result",
        "Map requested tools as `read` to `read,grep,find,ls`, `search` to `grep,find,ls`, `execute` to `bash`, and `edit` to `edit,write`. Run `pi --no-session -p --tools <deduplicated-list> <composed-prompt>` exactly once, synchronously, and return its stdout",
    )
    text = text.replace("with the native `task` tool", "with one synchronous `pi --no-session -p` child process")
    text = text.replace(
        "load by exact name with the native `skill` tool; never search the filesystem",
        "read only the exact `<pi-home>/skills/<name>/SKILL.md`; never search the filesystem",
    )
    text = text.replace(
        "load `harbor-trusted-skill-sources`, ignore only Pi's outer wrapper",
        "apply the embedded `harbor-trusted-skill-sources` contract, ignore only its outer wrapper",
    )
    text = text.replace(
        'tools: ["<tool>"]\nmodel: "<model>"\ndisable-model-invocation: false\nuser-invocable: true',
        'tools: <comma-separated-mapped-tools>\nmodel: "<model>"',
    )
    text = text.replace(
        "JSON-quote user strings and emit tools as compact JSON.",
        "JSON-quote user strings. Map `read` to `read`, `search` to `grep`, `edit` to `edit,write`, and `execute` to `bash`; emit one deduplicated comma-separated `tools` value.",
    )
    text = text.replace(
        "Default to one bounded synchronous child with the task, repository scope, constraints, evidence, and completion condition. Run independent children concurrently only when useful, at most three. Synthesize only returned evidence and name the actual `agent_type`; if no task call succeeds, say so.",
        "Default to one bounded synchronous `pi --no-session -p` child with the selected profile body appended as system guidance plus the task, repository scope, constraints, evidence, and completion condition. Map its declared tools to Pi's `--tools` allowlist. Run independent children concurrently only when useful, at most three. Synthesize only returned evidence and name the selected profile; if no child process succeeds, say so.",
    )
    return text


def composed_body(source: Path) -> str:
    values, body = common.frontmatter(source.read_text(encoding="utf-8"))
    result = adapt(body)
    dependencies = []
    if values["name"] in {"bench", "join", "retire"}:
        dependencies.append(PLUGINS / "agent-foundry" / "skills" / "harbor-roster" / "SKILL.md")
        result = result.replace(
            "Load `harbor-roster` with the native `skill` tool.",
            "Apply the embedded `harbor-roster` contract below.",
        )
    elif values["name"] == "list-skills":
        dependencies.append(PLUGINS / "agent-foundry" / "skills" / "harbor-trusted-skill-sources" / "SKILL.md")
        result = result.replace(
            "Load `harbor-trusted-skill-sources`;",
            "Apply the embedded `harbor-trusted-skill-sources` contract below;",
        )
    if values["name"] == "join":
        dependencies.append(PLUGINS / "agent-foundry" / "skills" / "harbor-trusted-skill-sources" / "SKILL.md")
    for dependency in dependencies:
        _, dependency_body = common.frontmatter(dependency.read_text(encoding="utf-8"))
        result += "\n\n## Embedded internal contract\n\n" + adapt(dependency_body)
    return result


def write_skill(source: Path, root: Path) -> None:
    values, _ = common.frontmatter(source.read_text(encoding="utf-8"))
    target = root / values["name"]
    target.mkdir(parents=True, exist_ok=True)
    target.joinpath("SKILL.md").write_text(
        f"---\nname: {values['name']}\ndescription: {adapt(values['description'])}\ncompatibility: pi\n---\n" + composed_body(source),
        encoding="utf-8",
    )


def write_prompt(source: Path, root: Path) -> None:
    values, _ = common.frontmatter(source.read_text(encoding="utf-8"))
    hint = values.get("argument-hint")
    lines = ["---", f"description: {adapt(values['description'])}"]
    if hint:
        lines.append(f"argument-hint: {hint}")
    lines += ["---", "", f"Apply the following `{values['name']}` control exactly once.", "", composed_body(source), ""]
    root.mkdir(parents=True, exist_ok=True)
    root.joinpath(f"{values['name']}.md").write_text("\n".join(lines), encoding="utf-8")


def write_agent(source: Path, root: Path) -> None:
    document = source.read_text(encoding="utf-8")
    values, body = common.frontmatter(document)
    name = values.get("name", source.name.removesuffix(".agent.md"))
    tools = re.findall(r'"([A-Za-z0-9_-]+)', values.get("tools", ""))
    mapping = {"read": "read", "search": "grep", "edit": "edit", "execute": "bash", "skill": "read", "task": "bash", "list_agents": "read"}
    mapped = sorted({mapping[x] for x in tools if x in mapping})
    raw_header = re.match(r"\A---\r?\n(.*?)\r?\n---", document, re.S).group(1)
    kept = []
    for line in raw_header.splitlines():
        if line.startswith(("tools:", "disable-model-invocation:", "user-invocable:")):
            continue
        kept.append(adapt(line))
    lines = ["---", *kept]
    if mapped:
        lines.append(f"tools: {','.join(mapped)}")
    lines += ["---", ""]
    root.mkdir(parents=True, exist_ok=True)
    adapted_body = adapt(body)
    if name == "repo-cartographer":
        internal = PLUGINS / "repo-cartographer" / "skills" / "harbor-repository-map" / "SKILL.md"
        _, internal_body = common.frontmatter(internal.read_text(encoding="utf-8"))
        adapted_body = adapted_body.replace(
            "Load `harbor-repository-map` by exact name with the native skill tool and apply it.",
            "Apply the embedded `harbor-repository-map` contract below.",
        )
        adapted_body += "\n\n## Embedded internal contract\n\n" + adapt(internal_body)
    root.joinpath(f"{name}.md").write_text("\n".join(lines) + adapted_body, encoding="utf-8")


def install(target: Path, force: bool) -> None:
    target = target.expanduser().resolve()
    marker = target / ".agent-harbor-pi"
    managed = (target / "agents", target / "prompts", target / "skills", target / "agent-foundry" / "bench")
    if any(path.exists() for path in managed) and not marker.exists() and not force:
        raise SystemExit(f"Refusing to overwrite unmanaged Pi content in {target}; use --force explicitly")
    for path in managed:
        if path.exists():
            shutil.rmtree(path)
    for plugin in PLUGINS.iterdir():
        for skill in (plugin / "skills").glob("*/SKILL.md"):
            write_skill(skill, target / "skills")
            if skill.parent.name in PUBLIC_COMMANDS:
                write_prompt(skill, target / "prompts")
        for agent in (plugin / "agents").glob("*.agent.md"):
            write_agent(agent, target / "agents")
        for agent in (plugin / "bench").glob("*.agent.md"):
            write_agent(agent, target / "agent-foundry" / "bench")
    manifest = {
        "name": PACKAGE_NAME,
        "version": PACKAGE_VERSION,
        "private": True,
        "description": "Agent Harbor commands, skills, and agent profiles for Pi.",
        "keywords": ["pi-package", "agents", "skills", "orchestration"],
        "pi": {
            "skills": ["./skills"],
            "prompts": ["./prompts", "./agents"],
        },
    }
    (target / "package.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    marker.write_text("managed-by=agent-harbor\n", encoding="utf-8")
    print(f"Built Agent Harbor Pi package in {target}")


def install_package(target: Path, local: bool) -> None:
    executable = shutil.which("pi")
    if not executable:
        raise SystemExit("Pi CLI is not installed or is not on PATH")
    command = [executable, "install", str(target.resolve())]
    if local:
        command.append("--local")
    result = subprocess.run(command)
    if result.returncode:
        raise SystemExit(result.returncode)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("target", type=Path, help="output directory for the generated Pi package")
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--install", action="store_true", help="install the generated package with `pi install`")
    parser.add_argument("--local", action="store_true", help="with --install, install into project-local Pi settings")
    args = parser.parse_args()
    install(args.target, args.force)
    if args.install:
        install_package(args.target, args.local)


if __name__ == "__main__":
    main()
