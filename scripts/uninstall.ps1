<#
.SYNOPSIS
    FLUJO uninstaller for Windows.

.DESCRIPTION
    Reverses what scripts\install.ps1 did:
      - Optionally removes the prerequisites it installed via winget (Git, Node.js,
        Python, uv). For each one it asks, defaulting to YES when FLUJO installed it
        and NO when it was already on the system (read from the install manifest).
      - Removes the global 'flujo' command and its user-PATH entry.
      - Removes the desktop shortcut.
      - Optionally reverts the CurrentUser execution policy (only if FLUJO set it).
      - Deletes the FLUJO install folder (including the db\ folder with all user data).

    The folder deletion is delegated to a tiny detached helper in %TEMP%, because a
    script cannot reliably delete the folder it is running from (and this folder may
    also be the current working directory). The helper waits for this process to exit,
    then removes the install folder and the FLUJO-cli metadata folder.

    Designed to be run either directly:

        powershell -ExecutionPolicy Bypass -File scripts\uninstall.ps1

    or as a one-liner straight from GitHub:

        irm https://raw.githubusercontent.com/mario-andreschak/FLUJO/main/scripts/uninstall.ps1 | iex

    The folder to delete is taken from the install manifest
    (%LOCALAPPDATA%\FLUJO-cli\install-manifest.json), so the one-liner works even though
    the script itself never lives on disk inside the install folder.

.NOTES
    Installs done before the manifest existed have no manifest. In that case the script
    detects which prerequisites are present and asks about each one, defaulting to NO
    (keep) since it cannot prove FLUJO installed them.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

# Match install.ps1: relax the policy for THIS process so .ps1 shims work this session.
try {
    Set-ExecutionPolicy -ExecutionPolicy Bypass -Scope Process -Force -ErrorAction Stop
} catch { }

function Write-Step([string]$Message) { Write-Host "`n==> $Message" -ForegroundColor Cyan }
function Write-Ok([string]$Message)   { Write-Host "    $Message" -ForegroundColor Green }
function Write-Warn2([string]$Message) { Write-Host "    $Message" -ForegroundColor Yellow }

function Test-Command([string]$Name) {
    return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

# Yes/No prompt with a configurable default (returned on empty/unrecognized input).
function Read-YesNo([string]$Prompt, [bool]$DefaultYes) {
    $suffix = if ($DefaultYes) { '(Y/n)' } else { '(y/N)' }
    $ans = Read-Host "$Prompt $suffix"
    if ($ans -match '^\s*(y|yes)\s*$') { return $true }
    if ($ans -match '^\s*(n|no)\s*$')  { return $false }
    return $DefaultYes
}

# The winget IDs install.ps1 uses, for the fallback path when there is no manifest.
$KnownPrereqs = @(
    [PSCustomObject]@{ command = 'git';    wingetId = 'Git.Git';            displayName = 'Git' }
    [PSCustomObject]@{ command = 'node';   wingetId = 'OpenJS.NodeJS';      displayName = 'Node.js (includes npm)' }
    [PSCustomObject]@{ command = 'python'; wingetId = 'Python.Python.3.12'; displayName = 'Python 3.12' }
    [PSCustomObject]@{ command = 'uv';     wingetId = 'astral-sh.uv';       displayName = 'uv' }
)

Write-Host "FLUJO Uninstaller" -ForegroundColor Magenta
Write-Host "=================" -ForegroundColor Magenta

# ---------------------------------------------------------------------------
# 1. Load the install manifest (written by install.ps1), if present.
# ---------------------------------------------------------------------------
$binDir = Join-Path $env:LOCALAPPDATA 'FLUJO-cli'
$manifestPath = Join-Path $binDir 'install-manifest.json'
$manifest = $null
if (Test-Path -LiteralPath $manifestPath) {
    try {
        $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
        Write-Ok "Found install manifest: $manifestPath"
    } catch {
        Write-Warn2 "Install manifest is unreadable ($($_.Exception.Message)); continuing without it."
        $manifest = $null
    }
} else {
    Write-Warn2 "No install manifest found - this install predates it (or was moved)."
}

# ---------------------------------------------------------------------------
# 2. Resolve the install directory to delete.
# ---------------------------------------------------------------------------
if ($manifest -and $manifest.installDir) {
    $installDir = [string]$manifest.installDir
    # Prefer the binDir recorded in the manifest if present.
    if ($manifest.binDir) { $binDir = [string]$manifest.binDir }
} else {
    $defaultDir = if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'FLUJO' } else { Join-Path $HOME 'FLUJO' }
    $guess = if ($env:FLUJO_DIR) {
        $env:FLUJO_DIR
    } elseif ($PSScriptRoot -and (Test-Path -LiteralPath (Join-Path (Split-Path -Parent $PSScriptRoot) 'package.json'))) {
        Split-Path -Parent $PSScriptRoot   # running as a file from <install>\scripts
    } else {
        $defaultDir
    }
    $answer = Read-Host "Where is FLUJO installed? (press Enter for: $guess)"
    $installDir = if ([string]::IsNullOrWhiteSpace($answer)) { $guess } else { $answer.Trim() }
}
$installDir = [Environment]::ExpandEnvironmentVariables($installDir)

if ([string]::IsNullOrWhiteSpace($installDir)) {
    throw "Could not determine the FLUJO install directory. Aborting."
}
Write-Ok "FLUJO install directory: $installDir"
if (-not (Test-Path -LiteralPath (Join-Path $installDir 'package.json'))) {
    Write-Warn2 "Warning: '$installDir' does not look like a FLUJO install (no package.json)."
    Write-Warn2 "Double-check the path below before confirming - the wrong folder could be deleted."
}

# ---------------------------------------------------------------------------
# 3. Gather all choices up front (prereqs, execution policy), then confirm.
# ---------------------------------------------------------------------------
# Build the list of prerequisites to ask about.
$toRemove = @()
if ($manifest -and $manifest.prerequisites) {
    Write-Step "Prerequisites (winget). FLUJO-installed default to remove; pre-existing default to keep."
    foreach ($p in $manifest.prerequisites) {
        if (-not (Test-Command $p.command)) {
            Write-Ok "$($p.displayName) is not installed (nothing to remove)."
            continue
        }
        $defaultYes = -not [bool]$p.preexisting
        $note = if ($p.preexisting) { "was already on your system before FLUJO" } else { "installed by FLUJO" }
        if ($p.command -eq 'node') {
            Write-Warn2 "Note: Node.js/npm is shared by many tools; removing it affects them too."
        }
        if (Read-YesNo "Remove $($p.displayName)? ($note; winget: $($p.wingetId))" $defaultYes) {
            $toRemove += [PSCustomObject]@{ wingetId = $p.wingetId; displayName = $p.displayName }
        }
    }
} else {
    Write-Step "Prerequisites (winget). No manifest - cannot confirm which FLUJO installed, so each defaults to KEEP."
    foreach ($p in $KnownPrereqs) {
        if (-not (Test-Command $p.command)) { continue }
        if ($p.command -eq 'node') {
            Write-Warn2 "Note: Node.js/npm is shared by many tools; removing it affects them too."
        }
        if (Read-YesNo "Remove $($p.displayName)? (can't confirm FLUJO installed it; winget: $($p.wingetId))" $false) {
            $toRemove += [PSCustomObject]@{ wingetId = $p.wingetId; displayName = $p.displayName }
        }
    }
}

# Claude Code CLI (npm global) - offer removal only if FLUJO installed it (and it
# wasn't already present), mirroring the prereq default-to-remove behavior.
$removeClaudeCli = $false
if ($manifest -and $manifest.claudeCli -and $manifest.claudeCli.installed -and `
    -not $manifest.claudeCli.preexisting -and (Test-Command 'claude')) {
    $pkg = if ($manifest.claudeCli.npmPackage) { [string]$manifest.claudeCli.npmPackage } else { '@anthropic-ai/claude-code' }
    $removeClaudeCli = Read-YesNo "Remove the Claude Code CLI that FLUJO installed (npm: $pkg)?" $true
}

# Execution policy revert - only offered if the manifest records that FLUJO set it.
$revertPolicy = $false
if ($manifest -and $manifest.executionPolicyChanged) {
    $revertPolicy = Read-YesNo "FLUJO set your PowerShell execution policy to RemoteSigned. Revert it to Restricted?" $false
}

# ---------------------------------------------------------------------------
# 4. Final destructive confirmation (gates everything below).
# ---------------------------------------------------------------------------
Write-Host ""
Write-Warn2 "This will PERMANENTLY DELETE the FLUJO folder:"
Write-Warn2 "    $installDir"
Write-Warn2 "including db\ - ALL your flows, encrypted API keys, MCP server configs and chat"
Write-Warn2 "history. If you want to keep any of it, cancel now and use FLUJO's built-in"
Write-Warn2 "backup/export first."
$confirm = Read-Host "Type DELETE (in capitals) to confirm, or anything else to cancel"
if ($confirm -cne 'DELETE') {
    Write-Host "`nCancelled. Nothing was changed." -ForegroundColor Green
    return
}

# ---------------------------------------------------------------------------
# 5. Execute.
# ---------------------------------------------------------------------------

# 5a. Stop a running FLUJO so its files are not locked (port 4200, same as launcher).
Write-Step "Stopping any running FLUJO (port 4200)"
try {
    $conns = Get-NetTCPConnection -LocalPort 4200 -State Listen -ErrorAction SilentlyContinue
    $pids = $conns | Select-Object -ExpandProperty OwningProcess -Unique
    foreach ($processId in $pids) {
        if ($processId) {
            # No /T (tree kill): avoid killing this uninstaller's own process tree.
            taskkill /PID $processId /F 2>$null | Out-Null
            Write-Ok "Stopped process PID $processId."
        }
    }
    if (-not $pids) { Write-Ok "Nothing listening on port 4200." }
} catch {
    Write-Warn2 "Could not check/stop the FLUJO process: $($_.Exception.Message)"
}

# 5b. Uninstall the chosen prerequisites via winget.
foreach ($p in $toRemove) {
    Write-Step "Removing $($p.displayName) via winget ($($p.wingetId))"
    try {
        winget uninstall --id $p.wingetId -e --silent
        Write-Ok "$($p.displayName) removed (or removal started)."
    } catch {
        Write-Warn2 "Could not remove $($p.displayName): $($_.Exception.Message)"
    }
}

# 5b-2. Remove the Claude Code CLI (npm global) if FLUJO installed it.
if ($removeClaudeCli) {
    $pkg = if ($manifest.claudeCli.npmPackage) { [string]$manifest.claudeCli.npmPackage } else { '@anthropic-ai/claude-code' }
    Write-Step "Removing Claude Code CLI via npm ($pkg)"
    try {
        npm uninstall -g $pkg | Out-Host
        Write-Ok "Claude CLI removed (or removal started)."
    } catch {
        Write-Warn2 "Could not remove the Claude CLI: $($_.Exception.Message)"
    }
}

# 5c. Remove the desktop shortcut (reverses Add-DesktopShortcut).
try {
    $lnk = Join-Path ([Environment]::GetFolderPath('Desktop')) 'FLUJO.lnk'
    if (Test-Path -LiteralPath $lnk) {
        Remove-Item -LiteralPath $lnk -Force
        Write-Ok "Desktop shortcut removed."
    }
} catch {
    Write-Warn2 "Could not remove desktop shortcut: $($_.Exception.Message)"
}

# 5d. Remove the 'flujo' bin dir from the user PATH (reverses Register-FlujoCommand).
#     The flujo.cmd file and the manifest inside binDir are deleted by the detached
#     helper below (along with the install folder).
try {
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    if ($userPath) {
        $target = $binDir.TrimEnd('\')
        $kept = $userPath -split ';' | Where-Object { $_ -and ($_.TrimEnd('\') -ne $target) }
        $newPath = $kept -join ';'
        if ($newPath -ne $userPath) {
            [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
            Write-Ok "'flujo' command removed from your user PATH."
        }
    }
} catch {
    Write-Warn2 "Could not update user PATH: $($_.Exception.Message)"
}

# 5e. Revert execution policy if requested.
if ($revertPolicy) {
    try {
        Set-ExecutionPolicy -ExecutionPolicy Restricted -Scope CurrentUser -Force -ErrorAction Stop
        Write-Ok "Execution policy reverted to Restricted (CurrentUser)."
    } catch {
        Write-Warn2 "Could not revert execution policy: $($_.Exception.Message)"
    }
}

# 5f. Delete the install folder + FLUJO-cli metadata folder via a detached helper.
#     A script cannot reliably remove the folder it runs from (or its CWD), so we
#     write a tiny cleanup script to %TEMP%, launch it hidden, and exit. It waits for
#     this process to release handles, then removes both folders with a retry loop.
Write-Step "Scheduling removal of the FLUJO folder"
try {
    $escInstall = $installDir.Replace("'", "''")
    $escBin     = $binDir.Replace("'", "''")
    $header = "`$target = '$escInstall'`n`$bin = '$escBin'`n"
    $body = @'
$ErrorActionPreference = 'SilentlyContinue'
$log = Join-Path $env:TEMP 'flujo-uninstall.log'
Set-Location $env:TEMP   # ensure CWD is not inside the folder we are deleting
"[{0}] FLUJO uninstall cleanup starting" -f (Get-Date) | Out-File -FilePath $log -Append
Start-Sleep -Seconds 2   # let the uninstaller process exit and release handles

function Remove-Dir($path) {
    if (-not $path -or -not (Test-Path -LiteralPath $path)) {
        "  not present: $path" | Out-File -FilePath $log -Append
        return
    }
    for ($i = 1; $i -le 10; $i++) {
        try {
            Remove-Item -LiteralPath $path -Recurse -Force -ErrorAction Stop
            "  removed: $path" | Out-File -FilePath $log -Append
            return
        } catch {
            "  attempt $i failed for ${path}: $($_.Exception.Message)" | Out-File -FilePath $log -Append
            Start-Sleep -Seconds 1
        }
    }
    "  GAVE UP on: $path (still in use?)" | Out-File -FilePath $log -Append
}

Remove-Dir $target
Remove-Dir $bin
"[{0}] FLUJO uninstall cleanup done" -f (Get-Date) | Out-File -FilePath $log -Append
Remove-Item -LiteralPath $PSCommandPath -Force   # delete this temp helper itself
'@
    $deleter = Join-Path $env:TEMP 'flujo-uninstall-cleanup.ps1'
    Set-Content -LiteralPath $deleter -Value ($header + $body) -Encoding UTF8
    Start-Process -FilePath 'powershell.exe' -WindowStyle Hidden `
        -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $deleter | Out-Null
    Write-Ok "Folder removal started in the background (log: %TEMP%\flujo-uninstall.log)."
} catch {
    Write-Warn2 "Could not schedule folder removal: $($_.Exception.Message)"
    Write-Warn2 "Delete it manually: $installDir"
}

Write-Host "`nFLUJO has been uninstalled." -ForegroundColor Green
Write-Host "The 'flujo' command will be gone from new terminals." -ForegroundColor Green
Write-Host "The install folder is being removed in the background (a few seconds)." -ForegroundColor Green
