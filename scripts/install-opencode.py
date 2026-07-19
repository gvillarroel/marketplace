#!/usr/bin/env python3
"""Build and optionally install Agent Harbor as a native OpenCode plugin package."""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PLUGINS = ROOT / "plugins"
PUBLIC_COMMANDS = {"bench", "join", "retire", "contract", "list-skills"}
PACKAGE_NAME = "agent-harbor-opencode"
PACKAGE_VERSION = "0.10.0"
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


def embedded_command(skill: Path) -> str:
    values, body = frontmatter(skill.read_text(encoding="utf-8"))
    result = adapt_text(body)
    dependencies = []
    if values["name"] in {"bench", "join", "retire"}:
        dependencies.append(PLUGINS / "agent-foundry" / "skills" / "harbor-roster" / "SKILL.md")
        result = result.replace(
            "Load `harbor-roster` with the native `skill` tool.",
            "Apply the embedded `harbor-roster` contract below.",
        )
    elif values["name"] == "list-skills":
        dependencies.append(PLUGINS / "agent-foundry" / "skills" / "harbor-trusted-skill-sources" / "SKILL.md")
        result = result.replace("Load `harbor-trusted-skill-sources`;", "Apply the embedded trust contract below;")
    if values["name"] == "join":
        dependencies.append(PLUGINS / "agent-foundry" / "skills" / "harbor-trusted-skill-sources" / "SKILL.md")
    for dependency in dependencies:
        _, dependency_body = frontmatter(dependency.read_text(encoding="utf-8"))
        result += "\n\n## Embedded internal contract\n\n" + adapt_text(dependency_body)
    return result


def write_package(target: Path) -> None:
    commands = {}
    agents = {}
    for plugin in PLUGINS.iterdir():
        for skill in (plugin / "skills").glob("*/SKILL.md"):
            values, _ = frontmatter(skill.read_text(encoding="utf-8"))
            if values["name"] in PUBLIC_COMMANDS:
                commands[values["name"]] = {
                    "description": adapt_text(values["description"]),
                    "template": embedded_command(skill),
                }
        for source in (plugin / "agents").glob("*.agent.md"):
            values, body = frontmatter(source.read_text(encoding="utf-8"))
            name = values["name"]
            prompt = adapt_text(body)
            if name == "repo-cartographer":
                internal = PLUGINS / "repo-cartographer" / "skills" / "harbor-repository-map" / "SKILL.md"
                _, internal_body = frontmatter(internal.read_text(encoding="utf-8"))
                prompt = prompt.replace(
                    "Load `harbor-repository-map` by exact name with the native skill tool and apply it.",
                    "Apply the embedded repository-map contract below.",
                ) + "\n\n## Embedded internal contract\n\n" + adapt_text(internal_body)
            agents[name] = {
                "description": adapt_text(values["description"]),
                "mode": "subagent",
                "prompt": prompt,
                "permission": {item: "allow" for item in permissions(values.get("tools", ""))},
            }
    manifest = {
        "name": PACKAGE_NAME,
        "version": PACKAGE_VERSION,
        "private": True,
        "type": "module",
        "main": "./index.js",
        "description": "Agent Harbor commands and agents for OpenCode.",
        "keywords": ["opencode", "plugin", "agents", "skills"],
    }
    (target / "package.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    source = (
        "const commands = " + json.dumps(commands, indent=2) + ";\n"
        "const agents = " + json.dumps(agents, indent=2) + ";\n\n"
        "export const AgentHarborPlugin = async () => ({\n"
        "  config: async (config) => {\n"
        "    config.command = { ...(config.command ?? {}), ...commands };\n"
        "    config.agent = { ...(config.agent ?? {}), ...agents };\n"
        "  },\n"
        "});\n\nexport default AgentHarborPlugin;\n"
    )
    (target / "index.js").write_text(source, encoding="utf-8")


def install_package(target: Path, global_install: bool) -> None:
    executable = shutil.which("opencode")
    if not executable:
        raise SystemExit("OpenCode CLI is not installed or is not on PATH")
    command = [executable, "plugin", f"file:{target.resolve()}"]
    if global_install:
        command.append("--global")
    result = subprocess.run(command)
    if result.returncode:
        raise SystemExit(result.returncode)


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
    write_package(target)
    marker.write_text("managed-by=agent-harbor\n", encoding="utf-8")
    print(f"Installed Agent Harbor for OpenCode in {target}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("target", type=Path, help="output directory for the generated OpenCode plugin package")
    parser.add_argument("--force", action="store_true", help="replace pre-existing unmanaged agents, commands, and skills")
    parser.add_argument("--install", action="store_true", help="install the generated package with `opencode plugin`")
    parser.add_argument("--global", dest="global_install", action="store_true", help="with --install, update global OpenCode config")
    args = parser.parse_args()
    install(args.target, args.force)
    if args.install:
        install_package(args.target, args.global_install)


if __name__ == "__main__":
    main()
