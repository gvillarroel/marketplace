# GitHub Copilot CLI TUI command demo

The checked-in recording is captured directly from the interactive GitHub
Copilot CLI 1.0.73 TUI. It shows Copilot's own startup animation, folder-trust
dialog, extension permission dialog, command autocomplete, input editor,
scrolling, status bar, model label, and AIC counter while the local
`agent-foundry` plugin is loaded.

The PTY driver only answers terminal capability probes, accepts the two local
startup permissions, types commands, and waits between them. It does not
reconstruct Copilot output or draw a replacement interface.

The tour concentrates on the zero-model team-management surface:

- `/team` before and after the roster changes;
- `/bench on all`, a filtered `/bench list`, and `/bench off all`;
- path-free `/join`, the new member's enriched `/team` row, and `/retire`;
- `/team stop all` while idle and `/team help`, including search, cancellation,
  concurrency, model and token-accounting guidance.

Every command in the recording is deterministic and reports zero model tokens.
The tour deliberately does not invoke `/player`, `/scout`, `/team-lead`, a
specialist alias, or `/contract`, because those surfaces create model work by
design; the checked-in recording therefore exercises the real TUI without
consuming AIC.

## Play

Install Asciinema, then replay the checked-in asciicast:

```shell
asciinema play docs/assets/agent-harbor-commands.cast
```

Pre-rendered versions are also available:

- [animated GIF](assets/agent-harbor-commands.gif);
- [H.264 MP4](assets/agent-harbor-commands.mp4).

The asciicast is 100×42 cells and 184.95 seconds long. The checked-in GIF is
168.85 seconds and the MP4 is 168.87 seconds because the renderer caps idle
gaps at five seconds. It uses asciicast v3, which requires Asciinema CLI 3.0 or
newer or Asciinema Player 3.10 or newer.

## How the real TUI is captured

The Windows Copilot executable does not recognize a WSL PTY as an interactive
Windows console. The recording therefore installs the official Linux build of
the same Copilot CLI version inside WSL and runs it in a nested Linux PTY owned
by Asciinema.

`scripts/asciinema-copilot-tui.py` supplies the terminal capability responses
that a graphical terminal normally provides and sends literal keystrokes to
Copilot. All screen drawing remains Copilot's native ANSI output.

## Regenerate on Windows with WSL

Build Agent Harbor and install the official Copilot CLI 1.0.73 npm package in
an ignored working directory:

```powershell
npm run build
wsl --cd $PWD bash -lc `
  'mkdir -p work/copilot-linux && npm install --prefix work/copilot-linux --no-audit --no-fund @github/copilot@1.0.73'
```

Prepare isolated temporary plugin and project directories:

```powershell
wsl --cd $PWD bash -lc `
  'mkdir -p /tmp/agent-foundry-tui /tmp/agent-harbor-demo; `
   cp -a plugins/agent-foundry/. /tmp/agent-foundry-tui/'
```

Record the native TUI with Asciinema 3:

```powershell
wsl --cd $PWD bash -lc `
  'asciinema record --headless --return --overwrite --output-format asciicast-v3 `
   --window-size 100x42 --idle-time-limit 10 `
   --title "GitHub Copilot CLI 1.0.73 · Agent Harbor · TUI real" `
   --command "env PATH=/usr/local/bin:/usr/bin:/bin `
   python3 scripts/asciinema-copilot-tui.py `
   --copilot work/copilot-linux/node_modules/.bin/copilot `
   --plugin /tmp/agent-foundry-tui --project /tmp/agent-harbor-demo" `
   docs/assets/agent-harbor-commands.cast'
```

Render the same compact, readable 798×671 GIF and a browser-compatible 30 fps
H.264 MP4 padded to 798×672:

```powershell
agg --font-size 13 --line-height 1.2 `
  docs/assets/agent-harbor-commands.cast `
  docs/assets/agent-harbor-commands.gif
ffmpeg -y -i docs/assets/agent-harbor-commands.gif `
  -vf "fps=30,pad=ceil(iw/2)*2:ceil(ih/2)*2" `
  -movflags +faststart -pix_fmt yuv420p -c:v libx264 `
  docs/assets/agent-harbor-commands.mp4
```

The driver interleaves every keystroke with PTY reads, types characters slowly,
holds each completed command for 1.5 seconds before Enter, and leaves 8–18
seconds around command results. It uses temporary project and plugin copies,
retires the demonstration player, returns all six SDLC agents to the bench, and
exits Copilot normally.

## Headless regression driver

`npm run demo:commands` remains a faster zero-model SDK/RPC regression driver.
It is useful for validating command registration and output, but it is not the
source of the checked-in GIF, MP4, or asciicast.
