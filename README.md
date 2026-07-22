# Agent Harbor

Agent Harbor turns GitHub Copilot CLI, OpenCode, and Pi into a manageable agent
team. All three runtimes share the same roster and lifecycle rules.

It includes:

- `team-lead` and `crafter`, available from startup;
- `talent-scout`, the startup utility available as `/scout`;
- six opt-in SDLC specialists: `portfolio-management`, `design`, `build`,
  `manage`, `consume`, and `dispose`;
- deterministic `/team`, `/bench`, `/join`, `/retire`, and `/list-skills` controls that
  use no inference through each runtime's direct surface;
- `/contract` for exactly one disposable agent;
- safe ownership: unmanaged profiles are never overwritten or deleted.

## Installation

Choose the runtime where you will use Agent Harbor. After installing or
updating, start a new session from your project directory.

### GitHub Copilot CLI

```shell
copilot plugin marketplace add gvillarroel/marketplace
copilot plugin install agent-foundry@agent-harbor
copilot --experimental
```

### OpenCode

Global installation from GitHub:

```shell
opencode plugin https://github.com/gvillarroel/marketplace/archive/refs/heads/main.tar.gz --global
```

Omit `--global` to install it only in the current project.

### Pi

```shell
pi install git:github.com/gvillarroel/marketplace
```

To install it only in the current project:

```shell
pi install --local git:github.com/gvillarroel/marketplace
```

## Getting started

1. See the team and any active work:

   ```text
   /team
   ```

   In OpenCode, select `/team` and press Enter in its prompt. Use `/bench-list`
   there when you only need lifecycle state.

2. Activate only the specialists you need:

   ```text
   /bench on design build consume
   ```

   In OpenCode, use `/bench-on`, which prompts for the names, then start a new
   OpenCode session. Until that reload, `/team` reports newly enabled members as
   `enabled · reload required`, not `ready · invocable`.

3. Run a task:

   - In Copilot and OpenCode, select `team-lead`, `crafter`, or a specialist
     that `/team` reports as ready through the native agent selector.
   - In Pi, invoke it directly, for example:

     ```text
     /team-lead Design and implement this change, then validate the result.
     ```

To send work to one exact agent in any runtime, use `/<id> <task>`, for example:

```text
/design Design the smallest change that supports this feature.
```

To watch every command inside the real GitHub Copilot CLI TUI, replay the
[Asciinema demo](docs/ASCIINEMA-DEMO.md).

You can also manage the roster without depending on the host interface:

```shell
agent-harbor <copilot|opencode|pi> bench list
agent-harbor <copilot|opencode|pi> bench on design build
agent-harbor <copilot|opencode|pi> list-skills
```

## Documentation

Detailed documentation is available in [`docs/`](docs/README.md): advanced
usage, commands, agents, architecture, requirements, design decisions, and test
evidence.
