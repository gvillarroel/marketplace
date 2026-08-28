# Agent Harbor

A shared agent-team lifecycle for GitHub Copilot CLI, OpenCode, and Pi. Agent Harbor provides a persistent roster, opt-in specialists, disposable contractors, and deterministic team controls with explicit ownership of managed profiles.

Unmanaged profiles must never be overwritten or deleted. Runtime installation and reload behavior differ; follow the guide for the runtime you use.

## Get started

Install into the runtime you use, then start a new session from your project.

```sh
# GitHub Copilot CLI
copilot plugin marketplace add gvillarroel/marketplace
copilot plugin install agent-foundry@agent-harbor
copilot --experimental

# OpenCode (global installation)
opencode plugin https://github.com/gvillarroel/marketplace/archive/refs/heads/main.tar.gz --global

# Pi
pi install git:github.com/gvillarroel/marketplace
```

Start with `/team`. See the [first-task guide](docs/getting-started.md) for specialist activation, runtime differences, and project-local installation.

## Documentation

- [Documentation index](docs/README.md)
- [Usage and operations](docs/getting-started.md)
- [Repository layout and validation](docs/repository-guide.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Commands and advanced use](docs/GUIDE.md)
- [Copilot demo](docs/ASCIINEMA-DEMO.md)
- [AGENTS.md](AGENTS.md)
