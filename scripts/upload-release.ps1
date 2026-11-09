# Called only by the Windows release workflow after a successful build.
# Never replaces published releases or existing assets.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (Test-Path variable:PSNativeCommandUseErrorActionPreference) { $PSNativeCommandUseErrorActionPreference = $false }

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

# ConvertFrom-Json writes the whole JSON array as one pipeline object on some
# PowerShell versions. Assign first, then enumerate explicitly, on both 5.1 and 7.
function Get-ApiPages {
    param([string]$Endpoint)
    $page = 1
    do {
        $json = & gh api "${Endpoint}?per_page=100&page=$page"
        if ($LASTEXITCODE -ne 0) { throw "Falha ao consultar $Endpoint (pagina $page)." }
        $parsed = ConvertFrom-Json -InputObject ($json -join "`n")
        $batch = @($parsed)
        foreach ($item in $batch) { if ($null -ne $item) { Write-Output $item } }
        $page++
    } while ($batch.Count -eq 100)
}

$releases = @(Get-ApiPages "repos/$repository/releases" | Where-Object { $_.tag_name -eq $tag })
if ($releases.Count -gt 1) { throw "Ha $($releases.Count) releases com a tag $tag. Resolva os rascunhos duplicados manualmente antes de continuar." }
if ($releases.Count -eq 0) {
    # Verify the tag first: creating a release must never implicitly create a tag.
    $null = & gh api "repos/$repository/git/ref/tags/$tag"
    if ($LASTEXITCODE -ne 0) { throw "Nao foi possivel confirmar a tag existente $tag." }
    # Use the creation response directly. The releases list can lag behind a
    # successful creation, and a draft's public URL does not contain its tag.
    $createdJson = & gh api "repos/$repository/releases" --method POST -f "tag_name=$tag" -f "name=$version" -f "body=Build Windows $version em verificacao." -F draft=true -F prerelease=false
    if ($LASTEXITCODE -ne 0) { throw 'Falha ao criar o rascunho. Confira no GitHub antes de tentar novamente.' }
    $release = ConvertFrom-Json -InputObject ($createdJson -join "`n")
} else {
    $release = $releases[0]
}
if (!$release.id -or $release.tag_name -ne $tag -or !$release.draft -or $release.prerelease) {
    throw "A release $tag nao e um rascunho normal valido. Nenhum arquivo sera alterado."
}
$releaseId = $release.id

# Read and write assets by release ID, not by tag, to avoid selecting another draft.
$assets = @(Get-ApiPages "repos/$repository/releases/$releaseId/assets")
foreach ($file in $files) {
    $name = Split-Path -Leaf $file
    $existing = @($assets | Where-Object { $_.name -eq $name })
    if ($existing.Count -gt 1) { throw "Arquivo duplicado no rascunho: $name" }
    if ($existing.Count -eq 1) {
        $asset = $existing[0]
        $local = Get-Item -LiteralPath $file
        if ($asset.size -ne $local.Length) { throw "Arquivo existente com tamanho diferente: $name" }
        $digest = if ($asset.PSObject.Properties['digest']) { [string]$asset.digest } else { '' }
        if ($digest -match '^sha256:([a-fA-F0-9]{64})$') {
            $expected = $Matches[1]
        } else {
            # Pipe raw bytes inside Node: PowerShell 5.1 can corrupt binary output.
            $hashScript = 'const {spawn}=require("node:child_process");const {createHash}=require("node:crypto");const h=createHash("sha256"),p=spawn("gh",["api",process.argv[1],"-H","Accept: application/octet-stream"],{stdio:["ignore","pipe","inherit"]});p.stdout.on("data",b=>h.update(b));p.on("error",e=>{console.error(e);process.exitCode=1});p.on("close",c=>{if(c!==0)process.exitCode=1;else console.log(h.digest("hex"))})'
            $expected = & node -e $hashScript "repos/$repository/releases/assets/$($asset.id)"
            if ($LASTEXITCODE -ne 0) { throw "Falha ao conferir o arquivo existente: $name" }
        }
        $actual = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash
        if ($actual -ine $expected) { throw "Arquivo existente com hash diferente: $name" }
        Write-Host "Ja conferido: $name"
        continue
    }
    $encodedName = [Uri]::EscapeDataString($name)
    $null = & gh api "https://uploads.github.com/repos/$repository/releases/$releaseId/assets?name=$encodedName" --method POST -H 'Content-Type: application/octet-stream' --input $file
    if ($LASTEXITCODE -ne 0) { throw "Falha ao enviar $name" }
}
Write-Host "Rascunho $tag pronto, com os tres arquivos verificados."
