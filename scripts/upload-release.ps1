# Called only by the Windows release workflow after a successful build.
# Never replaces published releases or existing assets.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$tag = $env:GITHUB_REF_NAME
$repository = $env:GITHUB_REPOSITORY
if ($tag -notmatch '^v(\d+\.\d+\.\d+)$' -or $repository -notmatch '^[\w.-]+/[\w.-]+$') {
    throw 'Tag ou repositorio de release invalido.'
}
$version = $tag.Substring(1)
$installer = "Claudio-Setup-$version-x64.exe"
$files = @("dist/$installer", "dist/$installer.blockmap", 'dist/latest.yml')
foreach ($file in $files) {
    if (!(Test-Path -LiteralPath $file -PathType Leaf) -or (Get-Item -LiteralPath $file).Length -eq 0) {
        throw "Artefato ausente ou vazio: $file"
    }
}

# A draft has a different URL from its tag. Find by tag_name and refuse ambiguity
# instead of uploading to whichever duplicate the API happens to return first.
function Find-ReleaseDrafts {
$found = @()
$page = 1
do {
    $batchJson = & gh api "repos/$repository/releases?per_page=100&page=$page"
    if ($LASTEXITCODE -ne 0) { throw 'Nao foi possivel listar as releases.' }
    $batch = @(($batchJson -join "`n") | ConvertFrom-Json)
    $found += @($batch | Where-Object { $_ -and $_.tag_name -eq $tag })
    $page++
} while ($batch.Count -eq 100)
    return $found
}
$releases = @(Find-ReleaseDrafts)
if ($releases.Count -gt 1) { throw "Ha $($releases.Count) releases com a tag $tag. Resolva os rascunhos duplicados manualmente antes de continuar." }
if ($releases.Count -eq 0) {
    & gh release create $tag --repo $repository --verify-tag --draft --title $version --notes "Build Windows $version em verificacao."
    if ($LASTEXITCODE -ne 0) { throw 'Falha ao criar o rascunho.' }
    # The tag endpoint may return 404 for drafts. List authenticated releases again.
    $releases = @(Find-ReleaseDrafts)
    if ($releases.Count -ne 1) { throw "Esperado um unico rascunho para $tag apos criar; encontrados $($releases.Count)." }
    $release = $releases[0]
} else {
    $release = $releases[0]
}
if (!$release.draft -or $release.prerelease) { throw "A release $tag ja foi publicada ou marcada como pre-release. Nenhum arquivo sera alterado." }

# Inspect assets by release ID, so even a later duplicate cannot redirect uploads.
$assetsJson = & gh api "repos/$repository/releases/$($release.id)/assets?per_page=100"
if ($LASTEXITCODE -ne 0) { throw 'Falha ao consultar os arquivos do rascunho.' }
$assets = @(($assetsJson -join "`n") | ConvertFrom-Json)
foreach ($file in $files) {
    $name = Split-Path -Leaf $file
    $existing = @($assets | Where-Object { $_ -and $_.name -eq $name })
    if ($existing.Count -gt 1) { throw "Arquivo duplicado no rascunho: $name" }
    if ($existing.Count -eq 1) {
        $asset = $existing[0]
        $local = Get-Item -LiteralPath $file
        if ($asset.size -ne $local.Length) { throw "Arquivo existente com tamanho diferente: $name" }
        # GitHub now returns a SHA-256 digest for release assets. When absent,
        # download and compare instead of silently accepting an unrelated build.
        $digest = if ($asset.PSObject.Properties['digest']) { [string]$asset.digest } else { '' }
        if ($digest -match '^sha256:([a-fA-F0-9]{64})$') {
            $expected = $Matches[1]
            $actual = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash
            if ($actual -ine $expected) { throw "Arquivo existente com hash diferente: $name" }
        } else {
            $downloadDir = Join-Path ([IO.Path]::GetTempPath()) ([guid]::NewGuid().ToString('N'))
            New-Item -ItemType Directory -Path $downloadDir | Out-Null
            try {
                & gh release download $tag --repo $repository --dir $downloadDir --pattern $name
                if ($LASTEXITCODE -ne 0) { throw "Falha ao conferir o arquivo existente: $name" }
                if ((Get-FileHash -LiteralPath (Join-Path $downloadDir $name) -Algorithm SHA256).Hash -ine (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash) {
                    throw "Arquivo existente com hash diferente: $name"
                }
            } finally { Remove-Item -LiteralPath $downloadDir -Recurse -Force -ErrorAction SilentlyContinue }
        }
        Write-Host "Ja conferido: $name"
        continue
    }
    & gh release upload $tag $file --repo $repository
    if ($LASTEXITCODE -ne 0) { throw "Falha ao enviar $name" }
}
Write-Host "Rascunho $tag pronto, com os tres arquivos verificados."
