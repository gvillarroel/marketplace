# GitHub Copilot CLI TUI command demo

The checked-in recording comes directly from the interactive Windows GitHub
Copilot CLI 1.0.73 TUI. It preserves Copilot's startup animation, folder-trust
and extension-permission dialogs, command editor, scrolling, status bar, model
label, and AIC counter while the local `agent-foundry` plugin is loaded.

The ConPTY driver only answers terminal capability probes, accepts the two
local startup permissions, types commands, and waits between them. Any tool
permission prompt aborts the capture instead of being approved. The driver
neither reconstructs Copilot output nor draws a replacement interface. Its
asciicast header redacts the executable, plugin, and host paths, and the
capture uses the public aliases `R:\team-demo` and `C:\team-demo`, so the
rendered terminal contains no private workspace or home path.
Visible output and hidden OSC/DCS payloads are inspected before ANSI stripping,
credential-shaped values and sensitive parent-environment values are rejected,
and the child receives an explicit environment allowlist rather than inherited
tokens. The cast tags bind the capture mode, Agent Harbor version, and exact
SHA-256 digest of the canonical plugin tree.

The 12-command tour concentrates on the zero-model team-management surface:

- `/team` initially and `/team status:bench` after cleanup, so the final proof
  cannot be satisfied by replaying the initial result;
- `/bench on all`, filtered `/bench list design`, and `/bench off all`;
- path-free `/join` and the new member's enriched `/team` row;
- `/team stop all` while idle and `/team help`;
- `/retire` twice, proving that repeated cleanup is an explicit no-op; and
- `/exit` after the original roster and bench state have been restored.

Every Agent Harbor management command reports zero model tokens and the
session remains at `0 AIC used`; `/exit` is a Copilot host command and is not
counted as an Agent Harbor result. The tour deliberately does not invoke
`/player`, `/scout`,
`/team-lead`, a specialist alias, or `/contract`, because those surfaces create
model work by design.

## Play

Install Asciinema, then replay the checked-in asciicast:

```shell
asciinema play docs/assets/agent-harbor-commands.cast
```

Pre-rendered versions are also available:

- [animated GIF](assets/agent-harbor-commands.gif);
- [H.264 MP4](assets/agent-harbor-commands.mp4).

The asciicast uses v3, 100×42 cells, 346 native output events, and 200.820
seconds of source timing. The checked-in GIF is 795×670 and 178.31 seconds;
the browser-compatible MP4 is padded to 796×670, runs at 30 fps, and is 178.30
seconds. The renders remove four seconds of initial blank delay and reduce the
post-exit blank frame to 0.25 seconds; all native events and reading pauses are
retained in the source cast.

## Canonical Windows capture

`scripts/asciinema-copilot-tui-win.py` drives the real Windows executable
through ConPTY. Its only generation-time dependency is `pywinpty==3.0.5`; the
published Agent Harbor plugin neither imports nor ships that package.

Build Agent Harbor and install pywinpty into an ignored working directory:

```powershell
npm run build
python -m pip install --target work/tools/pywinpty --no-deps pywinpty==3.0.5
```

Prepare fresh plugin, project, and Copilot-home copies at the three exact public
roots shown below, then expose them through a clean drive alias. The validator
fails closed unless the supplied paths expand to `C:\agent-foundry-demo`,
`C:\team-demo`, and `C:\team-demo-home`. The visible alias is intentionally and
literally `R:`; if it is already assigned, free it deliberately or use another
machine. A different drive letter is rejected so the privacy contract cannot
silently drift.

```powershell
$capturePaths = @('C:\team-demo', 'C:\team-demo-home', 'C:\agent-foundry-demo')
if ($capturePaths.Where({ Test-Path -LiteralPath $_ }).Count) {
  throw 'A public capture path already exists; do not overwrite it.'
}
if (subst | Select-String '^R:\\:') { throw 'R: is already assigned.' }
New-Item -ItemType Directory -Path C:\team-demo,C:\team-demo-home | Out-Null
Copy-Item plugins\agent-foundry C:\agent-foundry-demo -Recurse
$captureOwner = [guid]::NewGuid().ToString('N')
$captureRoots = @{
  'plugin' = 'C:\agent-foundry-demo'
  'project' = 'C:\team-demo'
  'copilot-home' = 'C:\team-demo-home'
}
$utf8NoBom = [Text.UTF8Encoding]::new($false)
foreach ($entry in $captureRoots.GetEnumerator()) {
  $marker = @{ schema = 1; owner = $captureOwner; root = $entry.Key } |
    ConvertTo-Json -Compress
  [IO.File]::WriteAllText(
    (Join-Path $entry.Value '.agent-harbor-capture-owner.json'),
    $marker,
    $utf8NoBom
  )
}
subst R: C:\
git init --initial-branch=main R:\team-demo
```

Record the native TUI. The Windows Copilot installation must already be
authenticated and able to discover its models. The recorder verifies version
1.0.73 before starting, proves that the public plugin copy is byte-for-byte the
exact bundled `plugins\agent-foundry` build (a second public copy cannot certify
itself), and records into a private unpredictable staging directory protected
by a cross-process lock. It rechecks both trees after the tour, promotes the
work cast only after all postconditions pass, and never writes directly to
final assets.

```powershell
$env:PYTHONPATH = (Resolve-Path work\tools\pywinpty).Path
python scripts\asciinema-copilot-tui-win.py `
  --copilot (Get-Command copilot).Source `
  --plugin R:\agent-foundry-demo `
  --canonical-plugin (Resolve-Path plugins\agent-foundry).Path `
  --project R:\team-demo `
  --copilot-home R:\team-demo-home `
  --capture-owner $captureOwner `
  --expected-version 1.0.73 `
  --expected-plugin-version 0.12.1 `
  --output work\asciinema-release\agent-harbor-commands.cast
```

Publish with the settings used for the checked-in assets (`agg` 1.7.0 and
FFmpeg/FFprobe 8.1.1 in the verified run):

```powershell
python scripts\publish-asciinema-assets.py `
  --source-cast work\asciinema-release\agent-harbor-commands.cast `
  --canonical-plugin (Resolve-Path plugins\agent-foundry).Path `
  --asset-dir docs\assets `
  --agg (Get-Command agg).Source `
  --ffmpeg (Get-Command ffmpeg).Source `
  --ffprobe (Get-Command ffprobe).Source `
  --font-dir C:\Windows\Fonts
```

The publisher validates the source cast, full zero-model tour, raw privacy,
GIF/MP4 signatures, duration agreement, H.264/yuv420p encoding, even dimensions,
and MP4 faststart. It renders all files in private staging, writes
`agent-harbor-commands.manifest.json` with plugin/tool/artifact digests, and then
promotes the complete cast/GIF/MP4/manifest set with exact rollback on ordinary
errors.

Immediately verify that the four published directory entries agree with the
new manifest. This catches an interrupted publication or later artifact drift:

```powershell
$manifestPath = 'docs\assets\agent-harbor-commands.manifest.json'
$manifestItem = Get-Item -LiteralPath $manifestPath -Force
if (($manifestItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
    $manifestItem.PSIsContainer) {
  throw "Invalid release manifest: $manifestPath"
}
$manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
if ($manifest.schema -ne 1 -or $manifest.plugin.name -ne 'agent-foundry' -or
    $manifest.plugin.version -ne '0.12.1' -or
    $manifest.plugin.sha256 -notmatch '^[0-9a-f]{64}$') {
  throw 'Release manifest provenance is invalid.'
}
$expectedFiles = @(
  'agent-harbor-commands.cast',
  'agent-harbor-commands.gif',
  'agent-harbor-commands.mp4'
)
$records = @($manifest.artifacts)
$actualSet = @($records.file | Sort-Object) -join "`n"
$expectedSet = @($expectedFiles | Sort-Object) -join "`n"
if ($actualSet -ne $expectedSet) {
  throw 'Manifest artifact set is incomplete or unexpected.'
}
foreach ($record in $records) {
  $path = Join-Path (Split-Path $manifestPath) $record.file
  $item = Get-Item -LiteralPath $path -Force
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
      $item.PSIsContainer -or $item.Length -ne $record.bytes) {
    throw "Invalid published artifact metadata: $path"
  }
  $digest = (Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash.ToLowerInvariant()
  if ($digest -ne $record.sha256) { throw "Published artifact digest mismatch: $path" }
}
```

Unmount and move only roots still carrying this run's exact ownership marker
into ignored workspace quarantine. Do not recursively delete by basename:

```powershell
subst R: /D
$workRoot = [IO.Path]::GetFullPath((Join-Path (Resolve-Path .).Path 'work'))
$workItem = Get-Item -LiteralPath $workRoot -Force
if (($workItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
  throw "Refusing reparse-point work root: $workRoot"
}
$cleanupRoot = [IO.Path]::GetFullPath((Join-Path $workRoot 'capture-cleanup'))
if (Test-Path -LiteralPath $cleanupRoot) {
  $cleanupItem = Get-Item -LiteralPath $cleanupRoot -Force
  if (($cleanupItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
      -not $cleanupItem.PSIsContainer) {
    throw "Refusing invalid cleanup root: $cleanupRoot"
  }
} else {
  New-Item -ItemType Directory -Path $cleanupRoot | Out-Null
}
$quarantine = [IO.Path]::GetFullPath((Join-Path $cleanupRoot $captureOwner))
if (-not $quarantine.StartsWith($workRoot + [IO.Path]::DirectorySeparatorChar,
    [StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing cleanup destination outside work: $quarantine"
}
if (Test-Path -LiteralPath $quarantine) {
  throw "Cleanup destination already exists: $quarantine"
}
New-Item -ItemType Directory -Path $quarantine | Out-Null
foreach ($entry in $captureRoots.GetEnumerator()) {
  $item = Get-Item -LiteralPath $entry.Value -Force
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "Refusing reparse-point capture root: $($entry.Value)"
  }
  $markerPath = Join-Path $entry.Value '.agent-harbor-capture-owner.json'
  $markerItem = Get-Item -LiteralPath $markerPath -Force
  if (($markerItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
      $markerItem.PSIsContainer) {
    throw "Refusing invalid ownership marker: $markerPath"
  }
  $marker = Get-Content -Raw -LiteralPath $markerPath | ConvertFrom-Json
  if ($marker.schema -ne 1 -or $marker.owner -ne $captureOwner -or
      $marker.root -ne $entry.Key) {
    throw "Refusing capture root without this run's ownership: $($entry.Value)"
  }
  Move-Item -LiteralPath $entry.Value -Destination $quarantine
}
```

The driver interleaves every keystroke with ConPTY reads, holds each completed
command for 1.5 seconds before Enter, leaves 8–18 seconds around results,
retires the demonstration member, returns all six SDLC specialists to the
bench, and exits Copilot normally. It fails closed if the expected bundled
agents, healthy roster transitions, idle stop, help, repeated cleanup, restored
roster, all 11 zero-model results, zero-AIC status, exact CLI version, or path
redaction is missing. It also rejects unexpected tool prompts, plugin drift,
credentials, reparse roots, ownership mismatch, target changes, and malformed
asciicast events. A probe must use a `*.probe.cast` name under `work` and is
permanently tagged `mode=probe`; it cannot replace a release asset.

## POSIX/WSL fallback

`scripts/asciinema-copilot-tui.py` is a standalone Linux PTY recorder with the
same security and semantic postconditions as Windows. It writes asciicast v3
itself, validates every command result, roster restoration, tokens/AIC, raw
privacy, CLI/plugin versions and digest, and only then promotes its staged cast.
It remains a host-comparison fallback, not the source of the checked-in assets.
It requires the exact public roots below and an independently authenticated
public Copilot home; unavailable roles are a failed tour, not a false-green.

```shell
capture_root=/tmp/agent-harbor-capture
test ! -e "$capture_root"
mkdir -p "$capture_root/team-demo" "$capture_root/team-demo-home"
cp -a plugins/agent-foundry "$capture_root/agent-foundry-demo"
export CAPTURE_OWNER="$(python3 -c 'import secrets; print(secrets.token_hex(16))')"
python3 - "$capture_root" "$CAPTURE_OWNER" <<'PY'
import json, pathlib, sys
root, owner = pathlib.Path(sys.argv[1]), sys.argv[2]
for label, name in (("plugin", "agent-foundry-demo"), ("project", "team-demo"),
                    ("copilot-home", "team-demo-home")):
    (root / name / ".agent-harbor-capture-owner.json").write_text(
        json.dumps({"schema": 1, "owner": owner, "root": label}), encoding="utf-8")
PY
COPILOT_HOME="$capture_root/team-demo-home" copilot login
python3 scripts/asciinema-copilot-tui.py \
  --copilot "$(command -v copilot)" \
  --plugin "$capture_root/agent-foundry-demo" \
  --canonical-plugin "$(realpath plugins/agent-foundry)" \
  --project "$capture_root/team-demo" \
  --copilot-home "$capture_root/team-demo-home" \
  --capture-owner "$CAPTURE_OWNER" \
  --expected-version 1.0.73 \
  --expected-plugin-version 0.12.1 \
  --output work/asciinema-release/agent-harbor-posix.cast
```

After the fallback capture, quarantine only the exact owner-verified public
tree with an atomic rename on `/tmp`:

```shell
python3 - "$CAPTURE_OWNER" <<'PY'
import json, os, pathlib, stat, sys
owner = sys.argv[1]
root = pathlib.Path("/tmp/agent-harbor-capture")
destination = pathlib.Path(f"/tmp/agent-harbor-capture-quarantine-{owner}")
if root.is_symlink() or root.resolve(strict=True) != root or destination.exists():
    raise SystemExit("refusing unsafe POSIX capture cleanup")
expected = {"agent-foundry-demo": "plugin", "team-demo": "project",
            "team-demo-home": "copilot-home"}
if {item.name for item in root.iterdir()} != set(expected):
    raise SystemExit("capture root contains unexpected entries")
for name, label in expected.items():
    capture_root = root / name
    marker = capture_root / ".agent-harbor-capture-owner.json"
    if capture_root.is_symlink() or marker.is_symlink():
        raise SystemExit(f"refusing symlink cleanup root: {capture_root}")
    marker_stat = marker.stat(follow_symlinks=False)
    if not stat.S_ISREG(marker_stat.st_mode) or marker_stat.st_nlink != 1:
        raise SystemExit(f"invalid ownership marker: {marker}")
    payload = json.loads(marker.read_text(encoding="utf-8"))
    if payload != {"schema": 1, "owner": owner, "root": label}:
        raise SystemExit(f"ownership mismatch: {capture_root}")
os.rename(root, destination)
print(destination)
PY
```

Run the portable capture-validator gate (Python 3.10+):

```shell
npm run test:capture
npm run test:capture:package
```

The second command builds an npm tarball without lifecycle scripts, extracts it
into a temporary directory, and proves that the packaged `npm run test:capture`
works using only the files actually shipped.

## Atomicity boundary

The open OS lock prevents cooperating Agent Harbor capture/publish processes
from racing, and identity plus SHA-256 snapshots detect target changes before
promotion. Python cannot make four directory entries commit as one filesystem
transaction or stop a malicious same-user process that deliberately ignores
the lock. The publisher therefore provides exact rollback for ordinary errors
and a manifest that makes a host crash or external tampering detectable; release
review must run the manifest comparison immediately after publication.

## Headless regression driver

`npm run demo:commands` remains the faster zero-model SDK/RPC regression
driver. It validates command registration, output, metrics, and absence of
model events, but it is not the source of the checked-in GIF, MP4, or
asciicast.
