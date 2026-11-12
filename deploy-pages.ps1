param(
    [string]$Repository = 'Ucicke/gonka-k-klapanu'
)

$ErrorActionPreference = 'Stop'

function Invoke-Native {
    param(
        [Parameter(Mandatory)] [string]$Command,
        [Parameter(Mandatory)] [string[]]$Arguments,
        [Parameter(Mandatory)] [string]$Failure
    )
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) { throw $Failure }
}

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoName = ($Repository -split '/')[-1]
if ($Repository -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') {
    throw "Repository must use owner/name format: $Repository"
}
if ($repoName -eq 'github.io') { throw 'Use a project repository name, not a user site repository.' }

foreach ($tool in @('git', 'gh', 'npm', 'node')) {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { throw "Required command not found: $tool" }
}

$gitRoot = (& git -C $projectRoot rev-parse --show-toplevel 2>$null).Trim()
if ($LASTEXITCODE -ne 0 -or [IO.Path]::GetFullPath($gitRoot) -ne [IO.Path]::GetFullPath($projectRoot)) {
    throw 'Run this script from the jam2 Git repository.'
}
$origin = (& git -C $projectRoot remote get-url origin 2>$null)
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($origin)) {
    throw "Git remote 'origin' is missing. Set it to https://github.com/$Repository.git first."
}
$normalizedOrigin = $origin.Trim() -replace '^git@github\.com:', 'https://github.com/' -replace '^ssh://git@github\.com/', 'https://github.com/' -replace '\.git$', '' -replace '/$', ''
if ($normalizedOrigin -ine "https://github.com/$Repository") {
    throw "Remote 'origin' points to $origin; expected https://github.com/$Repository."
}

Invoke-Native 'gh' @('auth', 'status') 'GitHub CLI is not authenticated. Run: gh auth login'
$repoJson = & gh repo view $Repository --json nameWithOwner,url,isPrivate
if ($LASTEXITCODE -ne 0) { throw "GitHub repository not found: $Repository" }
$repoInfo = $repoJson | ConvertFrom-Json
if ($repoInfo.isPrivate) { throw 'The repository must be public so friends can open the Pages link.' }

Push-Location $projectRoot
try {
    if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'node_modules/.bin/vite.cmd') -PathType Leaf)) {
        Invoke-Native 'npm' @('ci') 'Dependency installation failed.'
    }
    Invoke-Native 'npm' @('run', 'build', '--', "--base=/$repoName/") 'Production build failed.'
} finally {
    Pop-Location
}

$dist = Join-Path $projectRoot 'dist'
$index = Join-Path $dist 'index.html'
if (-not (Test-Path -LiteralPath $index -PathType Leaf)) { throw 'Build output is missing dist/index.html.' }
if (-not (Select-String -LiteralPath $index -SimpleMatch "/$repoName/assets/" -Quiet)) {
    throw "Build output does not use the /$repoName/ Pages base path."
}

$deploymentRoot = Join-Path ([IO.Path]::GetTempPath()) ('gonka-k-klapanu-pages-' + [Guid]::NewGuid().ToString('N'))
$tempPrefix = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
try {
    Invoke-Native 'git' @('clone', '--quiet', $origin, $deploymentRoot) 'Could not clone the deployment repository.'
    $pagesBranch = & git -C $deploymentRoot ls-remote --exit-code --heads origin gh-pages 2>$null
    if ($LASTEXITCODE -eq 0) {
        Invoke-Native 'git' @('-C', $deploymentRoot, 'fetch', '--quiet', 'origin', 'gh-pages') 'Could not fetch gh-pages.'
        Invoke-Native 'git' @('-C', $deploymentRoot, 'switch', '-C', 'gh-pages', '--track', 'origin/gh-pages') 'Could not switch to gh-pages.'
    } else {
        Invoke-Native 'git' @('-C', $deploymentRoot, 'switch', '--orphan', 'gh-pages') 'Could not create gh-pages branch.'
    }

    $resolvedDeploymentRoot = [IO.Path]::GetFullPath($deploymentRoot)
    if (-not $resolvedDeploymentRoot.StartsWith($tempPrefix, [StringComparison]::OrdinalIgnoreCase) -or
        [IO.Path]::GetFileName($resolvedDeploymentRoot) -notlike 'gonka-k-klapanu-pages-*' -or
        -not (Test-Path -LiteralPath (Join-Path $resolvedDeploymentRoot '.git') -PathType Container)) {
        throw "Refusing to clear an unexpected deployment work directory: $resolvedDeploymentRoot"
    }
    Get-ChildItem -LiteralPath $resolvedDeploymentRoot -Force | Where-Object { $_.Name -ne '.git' } |
        Remove-Item -Recurse -Force
    Get-ChildItem -LiteralPath $dist -Force | Copy-Item -Destination $resolvedDeploymentRoot -Recurse -Force
    New-Item -ItemType File -Path (Join-Path $resolvedDeploymentRoot '.nojekyll') -Force | Out-Null

    Invoke-Native 'git' @('-C', $resolvedDeploymentRoot, 'add', '--all') 'Could not stage the Pages build.'
    & git -C $resolvedDeploymentRoot diff --cached --quiet
    if ($LASTEXITCODE -eq 1) {
        $login = (& gh api user --jq .login).Trim()
        $userId = (& gh api user --jq .id).Trim()
        if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($login) -or [string]::IsNullOrWhiteSpace($userId)) {
            throw 'Could not read the authenticated GitHub user for the deployment commit.'
        }
        & git -C $resolvedDeploymentRoot -c "user.name=$login" -c "user.email=$userId+$login@users.noreply.github.com" commit -m 'Deploy game to GitHub Pages'
        if ($LASTEXITCODE -ne 0) { throw 'Could not commit the Pages build.' }
    } elseif ($LASTEXITCODE -ne 0) {
        throw 'Could not compare the Pages build with the current deployment.'
    }
    & git -C $resolvedDeploymentRoot config --local credential.helper ''
    if ($LASTEXITCODE -ne 0) { throw 'Could not configure GitHub CLI authentication for the Pages push.' }
    & git -C $resolvedDeploymentRoot config --local --add credential.helper '!gh auth git-credential'
    if ($LASTEXITCODE -ne 0) { throw 'Could not configure GitHub CLI authentication for the Pages push.' }
    $env:GIT_TERMINAL_PROMPT = '0'
    Invoke-Native 'git' @('-C', $resolvedDeploymentRoot, 'push', 'origin', 'gh-pages') 'Could not publish gh-pages.'

    $pagesConfig = Join-Path $resolvedDeploymentRoot 'pages-config.json'
    $json = '{"build_type":"legacy","source":{"branch":"gh-pages","path":"/"}}'
    [IO.File]::WriteAllText($pagesConfig, $json, [Text.UTF8Encoding]::new($false))
    & gh api "repos/$Repository/pages" --silent 2>$null
    $pagesExist = $LASTEXITCODE -eq 0
    $method = if ($pagesExist) { 'PUT' } else { 'POST' }
    Invoke-Native 'gh' @('api', '--method', $method, "repos/$Repository/pages", '--input', $pagesConfig) 'GitHub Pages configuration failed.'

    Write-Host "Published: https://$($repoInfo.nameWithOwner.Split('/')[0]).github.io/$repoName/"
} finally {
    if (Test-Path -LiteralPath $deploymentRoot) {
        $resolvedDeploymentRoot = [IO.Path]::GetFullPath($deploymentRoot)
        if ($resolvedDeploymentRoot.StartsWith($tempPrefix, [StringComparison]::OrdinalIgnoreCase) -and
            [IO.Path]::GetFileName($resolvedDeploymentRoot) -like 'gonka-k-klapanu-pages-*') {
            Remove-Item -LiteralPath $resolvedDeploymentRoot -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}
