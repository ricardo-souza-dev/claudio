<#
.SYNOPSIS
Cria uma release Windows pelo GitHub Actions e, opcionalmente, publica para todos.
.EXAMPLE
.\build-project-win.ps1 -Version 1.0.1
.EXAMPLE
.\build-project-win.ps1 -Version 1.0.1 -Resume -Publish
.EXAMPLE
.\build-project-win.ps1 -Version 1.0.1 -Publish -WhatIf
#>
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$')]
    [string]$Version,
    [switch]$Publish,
    [switch]$Resume,
    [string]$NotesFile,
    [ValidateRange(1, 180)]
    [int]$TimeoutMinutes = 60
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$originalPrompt = $env:GIT_TERMINAL_PROMPT
$originalGhHost = $env:GH_HOST
$originalGhPrompt = $env:GH_PROMPT_DISABLED
$env:GIT_TERMINAL_PROMPT = '0'
$env:GH_HOST = 'github.com'
$env:GH_PROMPT_DISABLED = '1'
# PowerShell 7 can optionally turn nonzero native exits into terminating errors.
# Handle exit codes ourselves, consistently with Windows PowerShell 5.1.
if (Test-Path variable:PSNativeCommandUseErrorActionPreference) { $PSNativeCommandUseErrorActionPreference = $false }

function Invoke-External {
    param([string]$Command, [string[]]$Arguments)
    & $script:Commands[$Command] @Arguments | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "Falha em '$Command $($Arguments -join ' ')' (codigo $LASTEXITCODE)." }
}

function Read-External {
    param([string]$Command, [string[]]$Arguments)
    $output = & $script:Commands[$Command] @Arguments
    if ($LASTEXITCODE -ne 0) { throw "Falha em '$Command $($Arguments -join ' ')' (codigo $LASTEXITCODE)." }
    return ($output -join "`n").Trim()
}

function Assert-Clean {
    $status = Read-External git @('status', '--porcelain', '--untracked-files=normal')
    if ($status) { throw "Ha alteracoes locais. Revise e faca commit antes de executar. O script nao inclui arquivos automaticamente.`n$status" }
}

function Read-PackageVersion {
    # Windows PowerShell 5.1 cannot parse the empty JSON key in lockfile.packages.
    return Read-External node @('-e', "const p=require('./package.json'),l=require('./package-lock.json');if(p.version!==l.version||p.version!==l.packages[''].version){console.error('package.json e package-lock.json precisam ter a mesma versao.');process.exit(1)}console.log(p.version)")
}

$temporary = $null
try {
    if ($env:OS -ne 'Windows_NT') { throw 'Execute este script no Windows.' }
    $wanted = [version]$Version
    if ($NotesFile) { $NotesFile = (Resolve-Path -LiteralPath $NotesFile).Path }
    Push-Location -LiteralPath $PSScriptRoot
    try {
        $script:Commands = @{ node = (Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source }
        $current = Read-PackageVersion
        $builder = Get-Content -LiteralPath 'electron-builder.yml' -Raw
        $ownerMatch = [regex]::Match($builder, '(?m)^  owner: ([a-zA-Z0-9-]+)\s*$')
        $repoMatch = [regex]::Match($builder, '(?m)^  repo: ([a-zA-Z0-9_.-]+)\s*$')
        if (!$ownerMatch.Success -or !$repoMatch.Success -or $builder -notmatch '(?m)^  provider: github\s*$') {
            throw 'O publish do electron-builder.yml precisa apontar para um repositorio GitHub.'
        }
        $repository = "$($ownerMatch.Groups[1].Value)/$($repoMatch.Groups[1].Value)"
        $tag = "v$Version"
        $workflow = 'release.yml'
        if (!(Test-Path -LiteralPath ".github/workflows/$workflow")) { throw 'Workflow de release nao encontrado.' }
        if ($Resume) {
            if ($current -ne $Version) { throw '-Resume exige que a versao local ja seja a versao solicitada.' }
        } elseif ($wanted -le [version]$current) {
            throw "A nova versao deve ser maior que $current. Para retomar $Version, use -Resume."
        }

        Write-Host "`nRelease Windows: $current -> $Version | $repository | $tag" -ForegroundColor Cyan
        Write-Host 'O build e os testes rodam no GitHub Actions. Nenhum teste chama APIs de modelos reais.'
        if ($WhatIfPreference) {
            $null = $PSCmdlet.ShouldProcess($repository, "Atualizar versao, criar commit/tag, enviar main + $tag, aguardar testes/build e conferir os tres arquivos")
            if ($Publish) { $null = $PSCmdlet.ShouldProcess($repository, "Publicar $tag como release estavel mais recente, disponivel aos usuarios") }
            return
        }

        $script:Commands = @{}
        foreach ($name in @('git', 'node', 'npm', 'gh')) {
            $command = Get-Command $name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
            if (!$command) { throw "Instale '$name' antes de continuar. Para gh: https://cli.github.com/" }
            $script:Commands[$name] = $command.Source
        }
        $nodeVersion = Read-External node @('-p', 'process.versions.node')
        if (([version]$nodeVersion).Major -lt 22) { throw 'Node.js 22 ou mais recente e necessario.' }
        $branch = Read-External git @('branch', '--show-current')
        if ($branch -ne 'main') { throw 'Execute na branch main, sem HEAD destacado.' }
        Assert-Clean
        $origin = Read-External git @('remote', 'get-url', 'origin')
        $repoPattern = [regex]::Escape($repository)
        if ($origin -notmatch "^(https://github\.com/|git@github\.com:|ssh://git@github\.com/)$repoPattern(\.git)?/?$") {
            throw 'O origin nao corresponde ao repositorio de publicacao do electron-builder.yml. Credenciais embutidas em URLs nao sao aceitas.'
        }
        Invoke-External gh @('auth', 'status', '--hostname', 'github.com')
        $actualRepo = Read-External gh @('repo', 'view', $repository, '--json', 'nameWithOwner', '--jq', '.nameWithOwner')
        if ($actualRepo -ne $repository) { throw 'O GitHub CLI nao confirmou o repositorio esperado.' }

        $head = Read-External git @('rev-parse', 'HEAD')
        $localTag = Read-External git @('tag', '--list', $tag)
        if (!$Resume -and $localTag) { throw "A tag local $tag ja existe. Nao sera sobrescrita; use -Resume se esta for a release em andamento." }
        if ($Resume) {
            if (!$localTag) { throw "A tag local $tag nao existe. Confira o commit da release antes de retomar." }
            $tagHead = Read-External git @('rev-parse', "$tag^{commit}")
            if ($tagHead -ne $head) { throw '-Resume exige HEAD no mesmo commit da tag. Retome a partir do commit da release.' }
        }
        $remoteTags = Read-External git @('ls-remote', '--tags', 'origin')
        $remoteTagHead = $null
        foreach ($line in ($remoteTags -split "`n")) {
            if ($line -match '^([a-f0-9]+)\s+refs/tags/v((?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*))(\^\{\})?$') {
                $foundVersion = $Matches[2]
                $foundHead = $Matches[1]
                if ([version]$foundVersion -gt $wanted) { throw "Ja existe uma tag remota maior: v$foundVersion. Escolha uma versao maior." }
                if ($foundVersion -eq $Version) { $remoteTagHead = $foundHead }
            }
        }
        if ($remoteTagHead -and (!$Resume -or $remoteTagHead -ne $head)) {
            throw "A tag remota $tag ja existe ou aponta para outro commit. Nenhuma tag sera forcada."
        }
        $releasesJson = Read-External gh @('release', 'list', '--repo', $repository, '--limit', '100', '--json', 'tagName,isDraft,isPrerelease')
        $releases = @((ConvertFrom-Json -InputObject $releasesJson))
        $existing = @($releases | Where-Object { $_.tagName -eq $tag })
        if ($existing.Count -gt 1) { throw "Ha $($existing.Count) releases para $tag. Resolva os rascunhos duplicados no GitHub antes de continuar." }
        if ($existing.Count -gt 0) {
            if (!$existing[0].isDraft) { throw "$tag ja esta publicada. Nao substitua arquivos publicados; crie uma versao maior." }
            if (!$Resume) { throw "Ja existe um rascunho de $tag. Confira-o e use -Resume." }
        }
        foreach ($release in $releases) {
            if ($release.tagName -match '^v(\d+\.\d+\.\d+)$' -and [version]$Matches[1] -gt $wanted) {
                throw "Ja existe uma release maior: $($release.tagName). Escolha uma versao maior."
            }
        }

        if (!$PSCmdlet.ShouldProcess($repository, "Enviar o codigo da main e $tag ao GitHub e iniciar/acompanhar a release Windows")) { return }
        if (!$remoteTagHead) {
            Invoke-External git @('fetch', '--no-tags', 'origin', 'main')
            Invoke-External git @('merge-base', '--is-ancestor', 'FETCH_HEAD', 'HEAD')
        }
        if (!$Resume) {
            Invoke-External npm @('version', $Version, '--no-git-tag-version', '--ignore-scripts')
            if ((Read-PackageVersion) -ne $Version) { throw 'A atualizacao da versao nao foi confirmada.' }
            # Commit only the two version files, never unrelated work.
            Invoke-External git @('add', '--', 'package.json', 'package-lock.json')
            Invoke-External git @('commit', '--only', '-m', "chore: release $Version", '--', 'package.json', 'package-lock.json')
            Assert-Clean
            Invoke-External git @('tag', $tag)
            $head = Read-External git @('rev-parse', 'HEAD')
        }
        # Atomic push avoids publishing the tag if main is rejected. Never force either ref.
        if (!$remoteTagHead) {
            Invoke-External git @('push', '--atomic', 'origin', 'HEAD:refs/heads/main', "refs/tags/${tag}:refs/tags/$tag")
        }

        $deadline = (Get-Date).AddMinutes($TimeoutMinutes)
        $runId = $null
        $lastStatus = ''
        Write-Host "`nAguardando o workflow. Actions: https://github.com/$repository/actions" -ForegroundColor Cyan
        while ((Get-Date) -lt $deadline) {
            if (!$runId) {
                $runsJson = Read-External gh @('run', 'list', '--repo', $repository, '--workflow', $workflow, '--commit', $head, '--event', 'push', '--limit', '30', '--json', 'databaseId,headBranch')
                $runs = @((ConvertFrom-Json -InputObject $runsJson) | Where-Object { $_.headBranch -eq $tag })
                if ($runs.Count -gt 0) { $runId = [string]$runs[0].databaseId }
            }
            if ($runId) {
                $runJson = Read-External gh @('run', 'view', $runId, '--repo', $repository, '--json', 'status,conclusion,url')
                $run = $runJson | ConvertFrom-Json
                if ($run.status -ne $lastStatus) { Write-Host "Workflow: $($run.status) | $($run.url)"; $lastStatus = $run.status }
                if ($run.status -eq 'completed') {
                    if ($run.conclusion -ne 'success') { throw "O workflow terminou com '$($run.conclusion)'. Veja $($run.url). Corrija/reexecute no GitHub e depois use -Resume. Nada foi publicado por este script." }
                    break
                }
            }
            Start-Sleep -Seconds 10
        }
        if (!$runId -or $lastStatus -ne 'completed') { throw "Tempo limite atingido. O workflow pode continuar no GitHub. Retome com -Resume; nao crie outra tag." }

        $releaseJson = Read-External gh @('release', 'view', $tag, '--repo', $repository, '--json', 'isDraft,isPrerelease,assets,url')
        $release = $releaseJson | ConvertFrom-Json
        if (!$release.isDraft -or $release.isPrerelease) { throw 'A release precisa continuar como rascunho normal antes da publicacao. Confira o estado no GitHub.' }
        $installerName = "Claudio-Setup-$Version-x64.exe"
        $required = @($installerName, "$installerName.blockmap", 'latest.yml')
        foreach ($name in $required) {
            $asset = @($release.assets | Where-Object { $_.name -eq $name -and $_.size -gt 0 })
            if ($asset.Count -ne 1) { throw "Arquivo ausente, vazio ou duplicado na release: $name" }
        }
        $temporary = Join-Path ([IO.Path]::GetTempPath()) ("claudio-release-" + [guid]::NewGuid().ToString('N'))
        $null = New-Item -ItemType Directory -Path $temporary
        Invoke-External gh @('release', 'download', $tag, '--repo', $repository, '--dir', $temporary, '--pattern', $installerName, '--pattern', "$installerName.blockmap", '--pattern', 'latest.yml')
        $metadata = Get-Content -LiteralPath (Join-Path $temporary 'latest.yml') -Raw
        $feedVersion = [regex]::Match($metadata, '(?m)^version: ([0-9.]+)\s*$').Groups[1].Value
        $feedPath = [regex]::Match($metadata, '(?m)^path: ([^\r\n]+)\s*$').Groups[1].Value.Trim()
        $feedHash = [regex]::Match($metadata, '(?m)^sha512: ([A-Za-z0-9+/=]+)\s*$').Groups[1].Value
        $feedFile = [regex]::Match($metadata, '(?m)^files:\r?\n  - url: ([^\r\n]+)\r?\n    sha512: ([A-Za-z0-9+/=]+)\r?\n    size: ([0-9]+)\s*$')
        $installerSize = (Get-Item -LiteralPath (Join-Path $temporary $installerName)).Length
        if ($feedVersion -ne $Version -or $feedPath -ne $installerName -or !$feedHash -or
            !$feedFile.Success -or $feedFile.Groups[1].Value -ne $installerName -or
            $feedFile.Groups[2].Value -cne $feedHash -or [long]$feedFile.Groups[3].Value -ne $installerSize -or
            ([regex]::Matches($metadata, '(?m)^  - url:')).Count -ne 1) {
            throw 'latest.yml nao corresponde ao instalador e a versao solicitada (version, path, files, size ou sha512).'
        }
        $hash = [Security.Cryptography.SHA512]::Create()
        $stream = [IO.File]::OpenRead((Join-Path $temporary $installerName))
        try { $actualHash = [Convert]::ToBase64String($hash.ComputeHash($stream)) } finally { $stream.Dispose(); $hash.Dispose() }
        if ($actualHash -cne $feedHash) { throw 'O SHA-512 do instalador nao corresponde a latest.yml. Nao publique esta release.' }
        $localDir = Join-Path $PSScriptRoot "dist/releases/$tag"
        $null = New-Item -ItemType Directory -Path $localDir -Force
        foreach ($name in $required) { Copy-Item -LiteralPath (Join-Path $temporary $name) -Destination $localDir -Force }
        Write-Host "`nArquivos conferidos e salvos em $localDir" -ForegroundColor Green
        Write-Host "Rascunho: $($release.url)"
        Write-Warning 'Teste o instalador e a atualizacao de uma versao instalada antes de liberar. Conferir o hash nao substitui assinatura de codigo nem o teste manual.'
        if (!$Publish) {
            Write-Host "Nada foi publicado para os usuarios. Depois de testar, execute: .\build-project-win.ps1 -Version $Version -Resume -Publish"
            return
        }
        if (!$PSCmdlet.ShouldProcess("Todos os usuarios do Claudio ($repository)", "PUBLICAR $tag como release estavel mais recente, disponivel no atualizador e no site")) {
            Write-Host 'O rascunho foi mantido. Nenhuma publicacao foi feita.'
            return
        }
        # Recheck immediately before publishing; never edit an already published release.
        $stateJson = Read-External gh @('release', 'view', $tag, '--repo', $repository, '--json', 'isDraft,isPrerelease')
        $state = $stateJson | ConvertFrom-Json
        if (!$state.isDraft -or $state.isPrerelease) { throw 'O estado da release mudou. Confira no GitHub antes de continuar.' }
        $latestReleasesJson = Read-External gh @('release', 'list', '--repo', $repository, '--limit', '100', '--json', 'tagName,isDraft,isPrerelease')
        foreach ($other in (ConvertFrom-Json -InputObject $latestReleasesJson)) {
            if ($other.tagName -match '^v(\d+\.\d+\.\d+)$' -and [version]$Matches[1] -gt $wanted) {
                throw "Uma release maior surgiu durante o build: $($other.tagName). Nao sera alterada a versao mais recente."
            }
        }
        if (!$NotesFile) {
            $notesJson = Read-External gh @('api', "repos/$repository/releases/generate-notes", '--method', 'POST', '-f', "tag_name=$tag", '-f', "target_commitish=$head")
            $notes = $notesJson | ConvertFrom-Json
            $NotesFile = Join-Path $temporary 'release-notes.md'
            [IO.File]::WriteAllText($NotesFile, [string]$notes.body, (New-Object Text.UTF8Encoding $false))
        }
        Invoke-External gh @('release', 'edit', $tag, '--repo', $repository, '--title', "Claudio $Version", '--notes-file', $NotesFile, '--draft=false', '--prerelease=false', '--latest')
        Write-Host "`nPublicado: https://github.com/$repository/releases/tag/$tag" -ForegroundColor Green
        Write-Host 'O app instalado oferecera a atualizacao nas proximas verificacoes; baixar e reiniciar continuam dependendo do usuario.'
    } finally {
        Pop-Location
    }
} catch {
    Write-Host "`nRelease interrompida: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host 'O script nao desfaz commits, tags ou uploads. Confira git status, git log e a release antes de tentar novamente.'
    Write-Host "Se o commit e a tag ja existem: .\build-project-win.ps1 -Version $Version -Resume"
    throw
} finally {
    if ($temporary -and (Test-Path -LiteralPath $temporary)) { Remove-Item -LiteralPath $temporary -Recurse -Force }
    $env:GIT_TERMINAL_PROMPT = $originalPrompt
    $env:GH_HOST = $originalGhHost
    $env:GH_PROMPT_DISABLED = $originalGhPrompt
}
