param(
    [Parameter(Mandatory = $true)][System.Uri]$Uri,
    [Parameter(Mandatory = $true)][ValidatePattern('^[A-Fa-f0-9]{64}$')][string]$Sha256,
    [Parameter(Mandatory = $true)][string]$Destination,
    [hashtable]$Headers = @{}
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$destinationPath = [System.IO.Path]::GetFullPath($Destination).TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
if (Test-Path -LiteralPath $destinationPath) { throw 'Destination must be a new directory.' }

function Expand-VerifiedArchive([System.Uri]$DownloadUri, [string]$Digest, [string]$Target) {
    if (-not $DownloadUri.IsAbsoluteUri -or $DownloadUri.UserInfo -or $DownloadUri.Query -or $DownloadUri.Fragment) { throw 'Use an absolute URL without embedded credentials, query, or fragment; pass authentication in Headers.' }
    if ($DownloadUri.Scheme -ne 'https' -and -not ($DownloadUri.Scheme -eq 'http' -and $DownloadUri.IsLoopback)) { throw 'HTTPS is required except for a local loopback test.' }
    if (Test-Path -LiteralPath $Target) { throw 'Archive target must be a new directory.' }
    $temporary = [System.IO.Path]::GetTempFileName()
    try {
        Invoke-WebRequest -Uri $DownloadUri -Headers $Headers -OutFile $temporary -UseBasicParsing -MaximumRedirection 0 | Out-Null
        $actual = (Get-FileHash -LiteralPath $temporary -Algorithm SHA256).Hash
        if ($actual -ne $Digest) { throw 'Archive SHA-256 mismatch.' }
        $zip = [System.IO.Compression.ZipFile]::OpenRead($temporary)
        try {
            if ($zip.Entries.Count -gt 5000) { throw 'Archive has too many entries.' }
            $totalSize = 0L
            $targets = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
            foreach ($entry in $zip.Entries) {
                $totalSize += $entry.Length
                if ($totalSize -gt 50MB) { throw 'Archive expands beyond the 50 MiB limit.' }
                if ([System.IO.Path]::IsPathRooted($entry.FullName) -or $entry.FullName.Contains(':')) { throw 'Absolute or alternate-stream archive path.' }
                $entryTarget = [System.IO.Path]::GetFullPath((Join-Path $Target $entry.FullName))
                if (-not $entryTarget.StartsWith($Target + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'Archive path escapes the destination.' }
                if (-not $targets.Add($entryTarget)) { throw 'Duplicate archive destination.' }
                if ((($entry.ExternalAttributes -shr 16) -band 0xF000) -eq 0xA000) { throw 'Symlink entries are not allowed.' }
            }
        } finally { $zip.Dispose() }
        [System.IO.Compression.ZipFile]::ExtractToDirectory($temporary, $Target)
    } finally { Remove-Item -LiteralPath $temporary -Force }
}

Expand-VerifiedArchive $Uri $Sha256 $destinationPath
$catalogs = @()
foreach ($relative in @('.agents/plugins/marketplace.json', '.github/plugin/marketplace.json')) {
    $file = Join-Path $destinationPath $relative
    if (-not (Test-Path -LiteralPath $file)) { throw "Missing catalog: $relative" }
    $catalogs += Get-Content -LiteralPath $file -Raw | ConvertFrom-Json
}
if ($catalogs[0].name -ne $catalogs[1].name) { throw 'Catalog marketplace names differ.' }
if ($catalogs[0].name -notmatch '^[a-z0-9]+(-[a-z0-9]+)*$') { throw 'Invalid marketplace name.' }
$catalogPluginNames = @($catalogs[0].plugins | ForEach-Object { $_.name } | Sort-Object)
if ($catalogPluginNames.Count -eq 0) { throw 'Marketplace contains no plugins.' }
foreach ($catalog in $catalogs) {
    $seen = @{}
    foreach ($plugin in $catalog.plugins) {
        if ($plugin.name -notmatch '^[a-z0-9]+(-[a-z0-9]+)*$' -or $seen.ContainsKey($plugin.name)) { throw 'Invalid or duplicate catalog plugin name.' }
        $seen[$plugin.name] = $true
        if ($plugin.source -isnot [string] -and $plugin.source.source -ne 'local') { throw 'Expected local plugin sources.' }
    }
    if ((@($catalog.plugins | ForEach-Object { $_.name } | Sort-Object) -join ',') -ne ($catalogPluginNames -join ',')) { throw 'Catalog plugin sets differ.' }
}
$releasePath = Join-Path $destinationPath 'nexus-release.json'
if (Test-Path -LiteralPath $releasePath) {
    $release = Get-Content -LiteralPath $releasePath -Raw | ConvertFrom-Json
    if ($release.formatVersion -ne 1 -or $release.marketplace -ne $catalogs[0].name) { throw 'Unsupported Nexus release metadata.' }
    $seenPlugins = @{}
    foreach ($plugin in $release.plugins) {
        if ($plugin.name -notmatch '^[a-z0-9]+(-[a-z0-9]+)*$' -or $seenPlugins.ContainsKey($plugin.name)) { throw 'Invalid or duplicate plugin name.' }
        if ($plugin.archive -ne ($plugin.name + '.zip') -or $plugin.sha256 -notmatch '^[A-Fa-f0-9]{64}$') { throw 'Invalid plugin archive metadata.' }
        $seenPlugins[$plugin.name] = $true
        $pluginUri = [System.Uri]::new($Uri, [string]$plugin.archive)
        Expand-VerifiedArchive $pluginUri $plugin.sha256 (Join-Path $destinationPath ('plugins/' + $plugin.name))
    }
    if ((@($seenPlugins.Keys | Sort-Object) -join ',') -ne ($catalogPluginNames -join ',')) { throw 'Release plugin set differs from catalogs.' }
}
foreach ($catalog in $catalogs) {
    foreach ($plugin in $catalog.plugins) {
        $relative = if ($plugin.source -is [string]) { $plugin.source } else { $plugin.source.path }
        if ($relative -ne ('./plugins/' + $plugin.name)) { throw 'Expected a local plugin in the extracted plugins directory.' }
        $pluginRoot = Join-Path $destinationPath ('plugins/' + $plugin.name)
        foreach ($kind in @('.codex-plugin', '.claude-plugin')) {
            $manifest = Get-Content -LiteralPath (Join-Path $pluginRoot ($kind + '/plugin.json')) -Raw | ConvertFrom-Json
            if ($manifest.name -ne $plugin.name) { throw 'Plugin manifest name differs from catalog.' }
        }
    }
}
@{ directory = $destinationPath; sha256 = $Sha256.ToLowerInvariant(); marketplace = $catalogs[0].name; downloadedFrom = $Uri.AbsoluteUri } | ConvertTo-Json -Compress
