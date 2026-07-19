#!/usr/bin/env python3
"""Install Agent Harbor into an OpenCode config directory without touching Copilot files."""

from __future__ import annotations

import argparse
import re
import shutil
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PLUGINS = ROOT / "plugins"
PUBLIC_COMMANDS = {"bench", "join", "retire", "contract", "list-skills"}
TOOL_PERMISSIONS = {
    "read": "read",
    "view": "read",
    "search": "grep",
    "glob": "glob",
    "edit": "edit",
    "create": "edit",
    "execute": "bash",
    "shell": "bash",
    "task": "task",
    "list_agents": "task",
    "skill": "skill",
}


def frontmatter(document: str) -> tuple[dict[str, str], str]:
    match = re.match(r"\A---\r?\n(.*?)\r?\n---\r?\n(.*)\Z", document, re.S)
    if not match:
        raise ValueError("Markdown file has no complete YAML frontmatter")
    values: dict[str, str] = {}
    for line in match.group(1).splitlines():
        if ":" in line and not line.startswith((" ", "\t")):
            key, value = line.split(":", 1)
            values[key.strip()] = value.strip()
    return values, match.group(2)


def adapt_text(text: str) -> str:
    replacements = (
        ("COPILOT_HOME", "OPENCODE_CONFIG_DIR"),
        ("home directory plus `.copilot`", "home directory plus `.config/opencode`"),
        ("<copilot-home>", "<opencode-home>"),
        ("copilot-home", "opencode-home"),
        (".github/agents/", ".opencode/agents/"),
        ("`../../bench/<id>.agent.md`", "`../../agent-foundry/bench/<id>.md`"),
        (".agent.md", ".md"),
        ("Copilot's outer skill-context wrapper", "OpenCode's outer skill-context wrapper"),
        ("Copilot's native", "OpenCode's native"),
        ("native Copilot subagent", "native OpenCode subagent"),
        ("launch Copilot", "launch OpenCode"),
        ("new Copilot session", "new OpenCode session"),
        ("Copilot session", "OpenCode session"),
        ("Copilot specialist", "OpenCode specialist"),
        ("Copilot players", "OpenCode players"),
        ("Copilot player", "OpenCode player"),
        ("Copilot's built-in", "OpenCode's built-in"),
        ("Copilot CLI", "OpenCode"),
        ("not a Copilot agent discovery directory", "not an OpenCode agent discovery directory"),
        ("Copilot's outer wrapper", "OpenCode's outer wrapper"),
        ("`repo-cartographer:crafter`", "`crafter`"),
        ("`repo-cartographer:repo-cartographer`", "`repo-cartographer`"),
        ("repo-cartographer:crafter", "crafter"),
        ("use `execute` for", "use `bash` for"),
        ("exactly `task` when `execute` but not `edit` is requested", "exactly `general` when `execute` but not `edit` is requested"),
        ("exactly `general-purpose` when `edit` is requested", "exactly `general` when `edit` is requested"),
    )
    for old, new in replacements:
        text = text.replace(old, new)
    text = text.replace(
        'tools: ["<tool>"]\nmodel: "<model>"\ndisable-model-invocation: false\nuser-invocable: true',
        'mode: subagent\nmodel: "<model>"\npermission:\n  <mapped-tool>: allow',
    )
    text = text.replace(
        "JSON-quote user strings and emit tools as compact JSON.",
        "JSON-quote user strings. Convert each requested tool to an OpenCode permission entry: "
        "`read` to `read`, `search` to `grep`, `edit` to `edit`, and `execute` to `bash`; emit each as `allow`.",
    )
    return text


def permissions(raw_tools: str) -> list[str]:
    names = re.findall(r'"([A-Za-z0-9_-]+)', raw_tools)
    return sorted({TOOL_PERMISSIONS[name] for name in names if name in TOOL_PERMISSIONS})


def install_agent(source: Path, destination: Path) -> None:
    values, body = frontmatter(source.read_text(encoding="utf-8"))
    name = values.get("name", source.name.removesuffix(".agent.md"))
    allowed = permissions(values.get("tools", ""))
    header = ["---", f"description: {adapt_text(values['description'])}", "mode: subagent"]
    if allowed:
        header.extend(["permission:", *[f"  {item}: allow" for item in allowed]])
    header.extend(["---", ""])
    destination.mkdir(parents=True, exist_ok=True)
    (destination / f"{name}.md").write_text("\n".join(header) + adapt_text(body), encoding="utf-8")


def install_skill(source: Path, destination: Path) -> None:
    values, body = frontmatter(source.read_text(encoding="utf-8"))
    name = values["name"]
    description = adapt_text(values["description"])
    target = destination / name
    target.mkdir(parents=True, exist_ok=True)
    content = f"---\nname: {name}\ndescription: {description}\ncompatibility: opencode\n---\n" + adapt_text(body)
    (target / "SKILL.md").write_text(content, encoding="utf-8")


def install_command(skill: Path, destination: Path) -> None:
    values, _ = frontmatter(skill.read_text(encoding="utf-8"))
    name = values["name"]
    destination.mkdir(parents=True, exist_ok=True)
    content = (
        "---\n"
        f"description: {adapt_text(values['description'])}\n"
        "---\n\n"
        f"Load the `{name}` skill with the native `skill` tool, then apply it exactly once "
        "using these literal command arguments:\n\n$ARGUMENTS\n"
    )
    (destination / f"{name}.md").write_text(content, encoding="utf-8")


def install(target: Path, force: bool) -> None:
    target = target.expanduser().resolve()
    marker = target / ".agent-harbor-opencode"
    managed = (target / "agents", target / "commands", target / "skills", target / "agent-foundry" / "bench")
    if any(path.exists() for path in managed) and not marker.exists() and not force:
        raise SystemExit(f"Refusing to overwrite unmanaged OpenCode content in {target}; use --force explicitly")
    for path in managed:
        if path.exists():
            shutil.rmtree(path)
    for plugin in PLUGINS.iterdir():
        for skill in (plugin / "skills").glob("*/SKILL.md"):
            install_skill(skill, target / "skills")
            if skill.parent.name in PUBLIC_COMMANDS:
                install_command(skill, target / "commands")
        for agent in (plugin / "agents").glob("*.agent.md"):
            install_agent(agent, target / "agents")
        for agent in (plugin / "bench").glob("*.agent.md"):
            install_agent(agent, target / "agent-foundry" / "bench")
    marker.write_text("managed-by=agent-harbor\n", encoding="utf-8")
    print(f"Installed Agent Harbor for OpenCode in {target}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("target", type=Path, help="OpenCode config directory (for example ~/.config/opencode)")
    parser.add_argument("--force", action="store_true", help="replace pre-existing unmanaged agents, commands, and skills")
    args = parser.parse_args()
    install(args.target, args.force)


if __name__ == "__main__":
    main()
