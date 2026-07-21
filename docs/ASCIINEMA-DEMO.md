# Asciinema command demo

The checked-in recording starts GitHub Copilot CLI 1.0.73 with
`--experimental`, loads the local `agent-foundry` plugin, and invokes its
client commands through Copilot's native session RPC against an isolated
temporary roster. It covers every command registered by Agent Harbor:

- deterministic `/team`, `/bench`, `/join`, `/retire`, and `/list-skills`;
- model-backed `/contract`, `/player`, `/scout`, `/team-lead`, and `/crafter`
  boundaries;
- all six bundled SDLC aliases and the immediate `/player` path for a joined
  personal teammate.

The model-backed commands are intentionally invoked without a task. Their real
preflight rejects the request before inference, so regenerating the demo needs
no model credentials and consumes no model tokens. The deterministic lifecycle
commands run completely, including activation, join, catalog lookup, retire,
and cleanup.

## Play

Install Asciinema, then replay the checked-in asciicast:

```shell
asciinema play docs/assets/agent-harbor-commands.cast
```

Pre-rendered versions are also available:

- [animated GIF](assets/agent-harbor-commands.gif);
- [H.264 MP4](assets/agent-harbor-commands.mp4).

The recording uses asciicast v3. Asciinema CLI 3.0 or newer and Asciinema
Player 3.10 or newer can play this format.

## Regenerate

Build Agent Harbor first, then record the deterministic driver in a terminal at
least 100 columns wide:

```shell
npm run build
asciinema rec --overwrite --output-format asciicast-v3 \
  --window-size 100x42 --idle-time-limit 10 \
  --title "GitHub Copilot CLI · Agent Harbor command tour" \
  --command "node scripts/asciinema-demo.mjs" \
  docs/assets/agent-harbor-commands.cast
```

The driver requires GitHub Copilot CLI 1.0.73. If it is installed in a
nonstandard location, set `AGENT_HARBOR_COPILOT_CLI` to the executable.
`/list-skills` also requires an authenticated `gh` CLI because it validates the
public skill snapshot through the same resolver used by the plugin.

The driver creates its project, Copilot home, SDK state, and roster under the
operating-system temporary directory and removes them at exit. It never mutates
the checkout or the user's normal Copilot/Agent Harbor configuration. It also
asserts that Copilot usage metrics remain unchanged and that no assistant or
usage event was emitted.

On Windows, Asciinema needs a Unix PTY. Run the driver with Windows Node and
capture its ANSI transcript, then record that transcript from WSL with
`scripts/asciinema-replay.mjs`. This bridge preserves the output produced by the
real Windows Copilot process while Asciinema owns the recording PTY. Pause
markers are replayed for their full duration, while `AGENT_HARBOR_DEMO_FAST`
avoids waiting twice during transcript capture.

```powershell
$env:AGENT_HARBOR_DEMO_COLOR = "1"
$env:AGENT_HARBOR_DEMO_FAST = "1"
npm run demo:commands *> work/asciinema-demo.ansi
wsl --cd $PWD asciinema rec --overwrite --output-format asciicast-v3 `
  --window-size 100x42 --idle-time-limit 10 `
  --title "GitHub Copilot CLI · Agent Harbor command tour" `
  --command "node scripts/asciinema-replay.mjs work/asciinema-demo.ansi" `
  docs/assets/agent-harbor-commands.cast
```
