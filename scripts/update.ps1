<#
.SYNOPSIS
    Updates and restarts FLUJO. Launched detached by the /api/update endpoint.

.DESCRIPTION
    Runs the whole self-update OUT OF PROCESS so it can safely stop the running
    server before rebuilding (on Windows, `next build` fails if `next start` still
    holds .next locked). Steps:

      1. Wait briefly so the HTTP "restarting" response reaches the browser.
      2. Stop whatever is listening on the port (the FLUJO server), by PID.
      3. git pull + npm install + npm run build (server is down, no file locks).
      4. Start the rebuilt server with `npm start` (keeps the custom-CA launcher).
      5. Wait for it to come up, then open the browser.

    Everything is logged to %TEMP%\flujo-update.log for diagnosis.
#>
param(
    [string]$Dir = (Get-Location).Path,
    [int]$Port   = 4200
)

$ErrorActionPreference = 'Continue'
Set-Location -LiteralPath $Dir

$logFile = Join-Path $env:TEMP 'flujo-update.log'
function Log([string]$m) {
    $line = ('[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m)
    try { Add-Content -LiteralPath $logFile -Value $line } catch { }
    Write-Host $line
}

function Test-PortListening([int]$p) {
    return [bool](Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue)
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
# `npm install` rewrites package-lock.json on nearly every run (npm-version /
# partial-install drift), which leaves the working tree dirty and makes a plain
# `git pull` abort with "local changes would be overwritten by merge". This is a
# deployment copy (in %LOCALAPPDATA%\FLUJO), not a dev checkout, so we hard-reset
# to the remote branch instead of merging. `reset --hard` only touches TRACKED
# files; untracked node_modules/.next/user data are preserved.
$branch = (& git rev-parse --abbrev-ref HEAD 2>$null | Out-String).Trim()
if (-not $branch -or $branch -eq 'HEAD') { $branch = 'main' }
$remote = (& git config --get "branch.$branch.remote" 2>$null | Out-String).Trim()
if (-not $remote) { $remote = 'origin' }

Log "git fetch $remote"
& git fetch --prune $remote 2>&1 | ForEach-Object { Log "  $_" }
$fetchOk = ($LASTEXITCODE -eq 0)

Log "git reset --hard $remote/$branch"
& git reset --hard "$remote/$branch" 2>&1 | ForEach-Object { Log "  $_" }
if ($fetchOk -and $LASTEXITCODE -eq 0) {
    Log "Working tree reset to $remote/$branch"
} else {
    Log "WARNING: could not update code (fetch/reset failed); restarting on the EXISTING version"
}

# Install with dev dependencies: `next build` needs typescript/webpack/postcss,
# which are devDependencies and get pruned when npm runs in production mode.
# --include=dev forces them in even when NODE_ENV=production.
Log "npm install"
& cmd /c "npm install --include=dev" 2>&1 | ForEach-Object { Log "  $_" }
Log "npm run build"
& cmd /c "npm run build" 2>&1 | ForEach-Object { Log "  $_" }

# 4. Start the rebuilt server in its own window (survives this script).
Log "Starting npm start"
Start-Process -FilePath 'cmd.exe' -ArgumentList '/k', 'npm start' -WorkingDirectory $Dir

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
