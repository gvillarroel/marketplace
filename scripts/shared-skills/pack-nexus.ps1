param(
    [Parameter(Mandatory = $true)][string]$Destination
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$project = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$source = Join-Path $project 'plugins\shared-skills-example'
$output = [System.IO.Path]::GetFullPath($Destination)
if (Test-Path -LiteralPath $output) { throw 'Destination must be a new directory.' }
New-Item -ItemType Directory -Path $output | Out-Null
$utf8 = New-Object System.Text.UTF8Encoding($false)

function New-JsonEntry($Name, $Value) {
    [pscustomobject]@{ Name = $Name; Bytes = $utf8.GetBytes(($Value | ConvertTo-Json -Depth 20) + "`n") }
}

function New-FileEntry($Name, $File) {
    [pscustomobject]@{ Name = $Name; Bytes = [System.IO.File]::ReadAllBytes($File) }
}

function Write-Archive($Name, $Entries) {
    $file = Join-Path $output $Name
    $zip = [System.IO.Compression.ZipFile]::Open($file, [System.IO.Compression.ZipArchiveMode]::Create)
    try {
        foreach ($item in ($Entries | Sort-Object Name)) {
            $entry = $zip.CreateEntry($item.Name, [System.IO.Compression.CompressionLevel]::Optimal)
            $entry.LastWriteTime = [System.DateTimeOffset]::new(1980, 1, 1, 0, 0, 0, [System.TimeSpan]::Zero)
            $stream = $entry.Open()
            try { $stream.Write($item.Bytes, 0, $item.Bytes.Length) } finally { $stream.Dispose() }
        }
    } finally { $zip.Dispose() }
    (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
}

$catalogEntries = @()
foreach ($relative in @('.agents/plugins/marketplace.json', '.github/plugin/marketplace.json')) {
    $catalog = Get-Content -LiteralPath (Join-Path $project $relative) -Raw | ConvertFrom-Json
    $catalog.name = 'shared-skills-nexus'
    $catalog.plugins = @($catalog.plugins | Where-Object { $_.name -in @('shared-example-a', 'shared-example-b') })
    foreach ($plugin in $catalog.plugins) {
        $location = './plugins/' + $plugin.name
        if ($relative.StartsWith('.agents/')) { $plugin.source = [ordered]@{ source = 'local'; path = $location } }
        else { $plugin.source = $location }
    }
    if ($catalog.plugins.Count -ne 2) { throw 'Expected exactly two shared-skill example plugins.' }
    $catalogEntries += New-JsonEntry $relative $catalog
}

$releasePlugins = @()
$bundleEntries = @($catalogEntries)
foreach ($suffix in @('a', 'b')) {
    $name = 'shared-example-' + $suffix
    $pluginRoot = if ($suffix -eq 'a') { $source } else { Join-Path $source 'library' }
    $entries = @()
    foreach ($kind in @('.codex-plugin', '.claude-plugin')) {
        $entries += New-FileEntry ($kind + '/plugin.json') (Join-Path $pluginRoot ($kind + '/plugin.json'))
    }
    $entries += New-FileEntry 'LICENSE' (Join-Path $source 'LICENSE')
    $manifest = Get-Content -LiteralPath (Join-Path $pluginRoot '.codex-plugin/plugin.json') -Raw | ConvertFrom-Json
    foreach ($selection in $manifest.skills) {
        $skillDirectory = [System.IO.Path]::GetFullPath((Join-Path $pluginRoot $selection))
        if (-not $skillDirectory.StartsWith($pluginRoot + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'Skill selection escapes the plugin root.' }
        if (-not (Test-Path -LiteralPath (Join-Path $skillDirectory 'SKILL.md'))) { throw 'Selected skill has no SKILL.md.' }
        $skillRelative = $skillDirectory.Substring($pluginRoot.Length + 1).Replace('\', '/')
        foreach ($file in (Get-ChildItem -LiteralPath $skillDirectory -Recurse -File)) {
            $relative = $file.FullName.Substring($skillDirectory.Length + 1).Replace('\', '/')
            $entries += New-FileEntry ($skillRelative + '/' + $relative) $file.FullName
        }
    }
    $archive = $name + '.zip'
    $digest = Write-Archive $archive $entries
    $releasePlugins += [ordered]@{ name = $name; archive = $archive; sha256 = $digest }
    foreach ($entry in $entries) {
        $bundleEntries += [pscustomobject]@{ Name = 'plugins/' + $name + '/' + $entry.Name; Bytes = $entry.Bytes }
    }
}
$release = [ordered]@{ formatVersion = 1; marketplace = 'shared-skills-nexus'; plugins = $releasePlugins }
$metadataEntries = @($catalogEntries) + @(New-JsonEntry 'nexus-release.json' $release)
Write-Archive 'marketplace.zip' $metadataEntries | Out-Null
Write-Archive 'marketplace-bundle.zip' $bundleEntries | Out-Null
$checksums = @(Get-ChildItem -LiteralPath $output -Filter '*.zip' | Sort-Object Name | ForEach-Object {
    (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant() + '  ' + $_.Name
})
[System.IO.File]::WriteAllText((Join-Path $output 'SHA256SUMS'), ($checksums -join "`n") + "`n", $utf8)
@{ destination = $output; marketplace = 'shared-skills-nexus'; checksums = $checksums } | ConvertTo-Json -Depth 5
