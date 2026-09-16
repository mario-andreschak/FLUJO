<#
.SYNOPSIS
    Updates and restarts FLUJO. Launched detached by the /api/update endpoint.

.DESCRIPTION
    Runs the whole self-update OUT OF PROCESS so it can safely stop the running
    server before rebuilding (on Windows, `next build` fails if `next start` still
    holds .next locked). Steps:

      1. Wait briefly so the HTTP "restarting" response reaches the browser.
      2. Stop whatever is listening on the port (the FLUJO server), by PID.
      3. git update + npm ci + npm run build (server is down, no file locks).
      4. Start the rebuilt server with `npm start` (keeps the custom-CA launcher).
      5. Wait for it to come up, then open the browser.

    Everything is logged to %TEMP%\flujo-update.log for diagnosis.
#>
param(
    [string]$Dir = (Get-Location).Path,
    [int]$Port   = 4200
)

$ErrorActionPreference = 'Continue'
Set-Location -LiteralPath $Dir -ErrorAction Stop

$logFile = Join-Path $env:TEMP 'flujo-update.log'
function Log([string]$m) {
    $line = ('[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m)
    try { Add-Content -LiteralPath $logFile -Value $line } catch { }
    Write-Host $line
}

function Test-PortListening([int]$p) {
    return [bool](Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue)
}

function Invoke-UpdateCommand {
    param([Parameter(Mandatory)] [string]$Command)
    Log $Command
    & cmd.exe /d /s /c $Command 2>&1 | ForEach-Object { Log "  $_" }
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0) { throw "Command '$Command' failed with exit code $exitCode." }
}

function Read-UpdateGit {
    param([string[]]$Arguments)
    $output = & git @Arguments 2>$null
    if ($LASTEXITCODE -ne 0) { throw 'Could not inspect the checkout; update stopped without discarding work.' }
    return ($output -join "`n").Trim()
}

function Assert-UpdateCheckout {
    param([string]$ExpectedBranch)
    $repositoryRoot = Read-UpdateGit @('rev-parse', '--show-toplevel')
    if ([IO.Path]::GetFullPath($repositoryRoot).TrimEnd('\', '/') -ine [IO.Path]::GetFullPath($Dir).TrimEnd('\', '/')) {
        throw 'The application directory must be the repository root to update safely.'
    }
    $branch = Read-UpdateGit @('branch', '--show-current')
    if (-not $branch) { throw 'This is a pinned release checkout. Update using a newer versioned installer; in-app source updates are disabled.' }
    if ($ExpectedBranch -and $branch -cne $ExpectedBranch) { throw 'The checkout branch changed during the update. Retry after finishing other Git work.' }
    $packageName = (Get-Content -LiteralPath (Join-Path $Dir 'package.json') -Raw -ErrorAction Stop | ConvertFrom-Json).name
    $decision = Get-RepositoryUpdateDecision -OriginUrl (Read-UpdateGit @('remote', 'get-url', 'origin')) `
        -WorkingTreeStatus (Read-UpdateGit @('status', '--porcelain', '--untracked-files=normal')) `
        -PackageName $packageName -CurrentBranch $branch -RequestedRef $branch
    if (-not $decision.CanProceed) { throw $decision.Reason }
    $tracking = Read-UpdateGit @('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}')
    if ($tracking -cne "origin/$branch") { throw 'The checkout must track its matching origin branch to update safely.' }
    if ((Read-UpdateGit @('rev-list', '--count', "$tracking..HEAD")) -ne '0') { throw 'The checkout has local commits. Fetch/reconcile manually before updating; no commits were discarded.' }
    return $branch
}

function Get-SafeUpdatePlan {
    $branch = Assert-UpdateCheckout
    $previousRevision = Read-UpdateGit @('rev-parse', 'HEAD')
    & git fetch origin $branch
    if ($LASTEXITCODE -ne 0) { throw 'Could not fetch the update; the running server is unchanged.' }
    $revision = Read-UpdateGit @('rev-parse', 'FETCH_HEAD^{commit}')
    & git merge-base --is-ancestor HEAD $revision
    if ($LASTEXITCODE -ne 0) { throw 'The checkout has local commits or diverged history. Update manually; no commits were discarded.' }
    $null = Assert-UpdateCheckout -ExpectedBranch $branch
    if ((Read-UpdateGit @('rev-parse', 'HEAD')) -cne $previousRevision) { throw 'The checkout changed during preflight. Retry after finishing other Git work.' }
    return [PSCustomObject]@{ Branch = $branch; Revision = $revision; PreviousRevision = $previousRevision }
}

# Kill the process(es) listening on the port. NOTE: no /T — a /T tree-kill would
# also kill THIS script (it was spawned as a child of the server process).
function Stop-Port([int]$p) {
    $conns = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue
    foreach ($procId in (@($conns.OwningProcess) | Select-Object -Unique)) {
        if ($procId -and $procId -gt 0) {
            Log "Stopping server PID $procId on port $p"
            & taskkill /PID $procId /F 2>&1 | ForEach-Object { Log "  $_" }
        }
    }
}

Log "================ FLUJO update started ($Dir) ================"

# Complete the non-destructive safety checks before stopping any server.
try {
    . (Join-Path $Dir 'scripts/installer-functions.ps1')
    $updatePlan = Get-SafeUpdatePlan
} catch {
    Log "Update refused: $($_.Exception.Message)"
    exit 1
}

# 1. Let the response flush to the browser before we kill the server.
Start-Sleep -Seconds 3

# 2. Stop the running server so the rebuild doesn't hit locked .next files.
$deadline = (Get-Date).AddSeconds(30)
while ((Get-Date) -lt $deadline -and (Test-PortListening $Port)) {
    Stop-Port $Port
    Start-Sleep -Seconds 2
}
if (Test-PortListening $Port) { Log "WARNING: port $Port still in use after 30s" } else { Log "Port $Port is free" }

# 3. Pull + install + build (server down -> no Windows file locks).
#
# Recheck after the stop delay and merge only the revision reviewed above.
try {
    $null = Assert-UpdateCheckout -ExpectedBranch $updatePlan.Branch
    if ((Read-UpdateGit @('rev-parse', 'HEAD')) -cne $updatePlan.PreviousRevision) { throw 'Checkout changed after update preflight.' }
    Log "Fast-forwarding to $($updatePlan.Revision)"
    & git merge --ff-only $updatePlan.Revision
    if ($LASTEXITCODE -ne 0) { throw 'Fast-forward update failed; no local work was discarded.' }
} catch {
    Log "Update stopped: $($_.Exception.Message). Restart FLUJO manually after resolving the checkout."
    exit 1
}

# Install with dev dependencies: `next build` needs typescript/webpack/postcss,
# which are devDependencies and get pruned when npm runs in production mode.
# --include=dev forces them in even when NODE_ENV=production.
try {
    Invoke-UpdateCommand 'npm ci --include=dev'
    Invoke-UpdateCommand 'npm run build'
    Invoke-UpdateCommand 'npm run validate:mcp-release'
} catch {
    Log "Update stopped: $($_.Exception.Message) FLUJO was not restarted. Resolve the failure above and restart manually."
    exit 1
}

# 4. Start the rebuilt server in its own window (survives this script).
Log "Starting npm start"
Start-Process -FilePath 'cmd.exe' -ArgumentList '/k', 'npm start' -WorkingDirectory $Dir -WindowStyle Hidden

# 5. Wait for it to come up, then reopen the browser.
$deadline = (Get-Date).AddSeconds(180)
while ((Get-Date) -lt $deadline -and -not (Test-PortListening $Port)) { Start-Sleep -Seconds 2 }
if (Test-PortListening $Port) {
    Log "Server is up at http://localhost:$Port"
    Start-Process "http://localhost:$Port"
} else {
    Log "ERROR: server did not come up within 180s (check the output above)"
}
Log "================ FLUJO update finished ================"
