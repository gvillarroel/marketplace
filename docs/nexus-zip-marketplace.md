# Distributing shared-skill plugins through Nexus ZIPs

Nexus Raw can store the marketplace and plugin ZIPs. Codex and Copilot CLI can
use their contents after a download-and-extract step, followed by native local
marketplace registration. Neither tested CLI installs a ZIP directly from its
Nexus URL: both interpret marketplace HTTP URLs as Git repositories.

This procedure packages the two instruction-only shared-skill example plugins.
The existing GitHub installation and its [three canonical skill sources](shared-skills-marketplace.md)
remain unchanged. It does not package the Agent Harbor runtime.

## Verified behavior

Tested on Windows with Codex CLI **0.145.0**, Copilot CLI **1.0.103**,
PowerShell **7.6.9**, and a real local Sonatype Nexus **3.96.0-09 Community**
container (`sonatype/nexus3:3.96.0`). Uploads used a Raw hosted repository;
downloads were checked against the uploaded bytes and SHA-256 digests.

| Configuration | Codex | Copilot |
| --- | --- | --- |
| Register HTTP `marketplace.zip` URL | Fails: attempts Git clone | Fails: attempts Git clone |
| Register standalone HTTP `marketplace.json` URL | Fails: attempts Git clone | Fails: attempts Git clone |
| Plugin source `{ "source": "url", "url": "...zip" }` | Catalog registers; installation attempts Git clone and fails | Catalog registers; installation attempts Git clone and fails |
| Plugin source type `archive` or `zip` | Entries are not installable | Catalog schema rejects them |
| Plugin source as a plain ZIP URL string | Plugin not found | URL is treated as a relative directory |
| Register local ZIP without extracting | Fails: requires a directory | Fails: searches inside a directory named after the ZIP |
| Download/extract marketplace ZIP plus separate plugin ZIPs | Install/list and 4/4 verified invocations | Install/list and 4/4 verified invocations |
| Download/extract one complete ZIP with separate plugin payload directories | Native install/list passed | Native install/list passed |

The four live invocations were A:1, A:2, B:2, and B:3. Each loaded the correct
plugin, read its proof file, and returned the exact token. B remained available
after removing/disabling A, and a fresh B-then-A installation passed. The single
bundle contains the same plugin payload bytes; native installation/listing was
checked separately for it. See the [acceptance report](validation/nexus-zip/report.md).

Authenticated download also passed against the same Nexus instance: disabling
anonymous access produced HTTP 401 without credentials, while the extractor
succeeded with a Basic Authorization header. Published evidence excludes credentials.

## Why packaging materializes each plugin

The authored repository still contains exactly three skills and metadata-only
manifest folders. The packager generates self-contained payloads: A contains
skills 1 and 2; B contains skills 2 and 3. Skill 2 therefore appears in both
generated plugin payloads. These are release copies, not authored duplicates.
Generated ZIPs stay under ignored `work/` rather than Git.

This matters for Copilot's local installation behavior. Extracting the original
nested Git layout with one shared physical directory allows installation, but
Copilot loads local plugins live and deduplicates the shared skill path. In the
tested A+B case, requesting B:2 loaded A:2. Giving each generated plugin its own
installed path preserved both identities in the successful live tests. Codex
copies local plugin sources into its cache.

## Build and publish

Run from this repository on Windows with PowerShell 7, using a new output path:

```powershell
pwsh -NoProfile -File .\scripts\shared-skills\pack-nexus.ps1 `
  -Destination .\work\nexus-release-1
```

The output is:

- `marketplace.zip`: both native catalogs and `nexus-release.json`; metadata only.
- `shared-example-a.zip`: manifests, license, and A's selected skills.
- `shared-example-b.zip`: manifests, license, and B's selected skills.
- `marketplace-bundle.zip`: both catalogs and both materialized plugin payloads.
- `SHA256SUMS`: the four archive digests.

Skill selections are read from each plugin's manifest. The generated marketplace
name is `shared-skills-nexus`. Native catalogs point
to `./plugins/shared-example-a` and `./plugins/shared-example-b`. Release metadata
pins the adjacent plugin archive basenames and hashes. Fixed timestamps and
stable metadata ordering produced identical repeat builds in the tested environment.

Upload the artifacts into the same versioned directory in a **Raw (hosted)**
Nexus repository. HTTP PUT is supported. The real test verified HTTP 201 uploads
and HTTP 200 downloads with identical bytes. For example, the following prompts
for the password; repeat for the other ZIPs and `SHA256SUMS`:

```powershell
curl.exe --fail --user $env:NEXUS_USER `
  --upload-file .\work\nexus-release-1\marketplace.zip `
  https://nexus.example.com/repository/agent-plugins/releases/1.0.0/marketplace.zip
```

A new Nexus instance requires Sonatype onboarding and EULA acceptance before
uploads/downloads. The test accepted it only after explicit user authorization
for the local temporary instance.

## Download, verify, and extract

Choose `marketplace.zip` to fetch its two adjacent plugin ZIPs, or
`marketplace-bundle.zip` for a single archive download. Use the corresponding
SHA-256 from your trusted build output. Keep the destination while installed:
Copilot reads the plugin files there.

```powershell
$uri = 'https://nexus.example.com/repository/agent-plugins/releases/1.0.0/marketplace.zip'
$sha256 = '<SHA-256 of marketplace.zip from your trusted build>'
$destination = Join-Path $env:LOCALAPPDATA 'shared-skills-nexus\1.0.0'

pwsh -NoProfile -File .\scripts\shared-skills\expand-nexus.ps1 `
  -Uri $uri -Sha256 $sha256 -Destination $destination
```

For a private repository, call within PowerShell and pass the Authorization
header supplied by your credential manager:

```powershell
$headers = @{ Authorization = $env:NEXUS_AUTHORIZATION }
& .\scripts\shared-skills\expand-nexus.ps1 `
  -Uri $uri -Sha256 $sha256 -Destination $destination -Headers $headers
```

The extractor requires HTTPS except for loopback HTTP tests. It rejects
redirects, credentials/query strings/fragments in URLs, hash mismatches, existing
targets, paths escaping the destination, symlinks, duplicate destinations, and
archives over its entry/expanded-size limits. It does not accept licenses,
change client settings, register marketplaces, or invoke models. Inspect an
incomplete extraction before retrying with a new destination; existing paths
are never overwritten.

## Native registration and use

```powershell
codex plugin marketplace add $destination
codex plugin add shared-example-a@shared-skills-nexus
codex plugin add shared-example-b@shared-skills-nexus
codex plugin list --json

copilot plugin marketplace add $destination
copilot plugin install shared-example-a@shared-skills-nexus
copilot plugin install shared-example-b@shared-skills-nexus
copilot skill list --json
```

In Copilot, use `/shared-example-a:shared-example-2` and
`/shared-example-b:shared-example-2` to distinguish the shared skill. For reference
files outside the working directory, grant access to the extracted directory
with `copilot --add-dir $destination` or approve that directory interactively.
The acceptance test added that specific directory and allowed only skill/view tools.

In Codex, request the installed plugin's skill, for example
`Use shared-example-b:shared-example-2 and follow its instructions.` Discovery
was verified through native app-server `skills/list`, followed by `codex exec`.

These tests cover the CLIs, not the Codex desktop installation UI or VS Code
Copilot extension. Keep release artifacts immutable and use a new directory for
a new version; update registration/installation using the client's commands.
Automatic updates were not tested.

## Repeatable transport tests

```powershell
py -3 -m unittest discover -s tests -p test_nexus_zip.py -v
```

These nine tests use a loopback HTTP fixture, separately from real Nexus
acceptance. They cover repeatability, source counts, both layouts, exact payload
bytes, authentication headers, hash failures, preservation of existing files,
path traversal, symlinks, and the HTTP restriction. PowerShell is required;
the suite reports a skip if absent.

For a fully native single `plugin marketplace add URL`, keep the verified Git
transport. Codex also documents npm plugin sources, using package tarballs and
registry configuration. Nexus npm distribution was not tested here; it is a
different artifact format and provides no evidence of ZIP support in either client.

## References

- [Copilot CLI plugin sources](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-plugin-reference).
- [OpenAI plugin packaging and marketplaces](https://developers.openai.com/plugins/build/plugins).
- [Sonatype Raw repositories](https://help.sonatype.com/en/raw-repositories.html).
- [Sonatype Community Edition onboarding](https://help.sonatype.com/en/ce-onboarding.html).
- [Official Nexus container](https://github.com/sonatype/docker-nexus3).

[Documentation index](README.md).
