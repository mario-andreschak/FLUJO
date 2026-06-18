<#
.SYNOPSIS
    FLUJO installer / updater for Windows.

.DESCRIPTION
    Installs the prerequisites (Git, Node.js + npm, Python, uv) via winget,
    refreshes the environment (PATH + vars) for the current session so the new
    tools are usable immediately, clones (or updates) FLUJO, builds it, registers
    a global 'flujo' command (start FLUJO from any folder), and optionally starts
    it.

    Designed to be run either directly:

        powershell -ExecutionPolicy Bypass -File scripts\install.ps1

    or as a one-liner straight from GitHub:

        irm https://raw.githubusercontent.com/mario-andreschak/FLUJO/main/scripts/install.ps1 | iex

    When run as a one-liner it will interactively ask for the install folder
    (default: %LOCALAPPDATA%\FLUJO) and whether to start FLUJO afterwards.

.NOTES
    Parameters only take effect when the script is run as a file. When piped
    through `iex` the script falls back to interactive prompts (or the
    FLUJO_DIR / FLUJO_START / FLUJO_BRANCH / FLUJO_SHORTCUT environment variables
    if they are set).
#>
[CmdletBinding()]
param(
    [string]$InstallDir = $env:FLUJO_DIR,
    [string]$Branch     = $(if ($env:FLUJO_BRANCH) { $env:FLUJO_BRANCH } else { 'main' }),
    [switch]$Start
)

$ErrorActionPreference = 'Stop'
$RepoUrl = 'https://github.com/mario-andreschak/FLUJO/'

# On a fresh Windows the user's execution policy defaults to 'Restricted', which
# blocks running .ps1 files. The `irm ... | iex` one-liner is unaffected (iex
# evaluates a string), but `npm` is a PowerShell shim (npm.ps1) and fails with
# "running scripts is disabled on this system". Relax the policy for THIS PROCESS
# unconditionally so the install below always completes. This does not persist.
try {
    Set-ExecutionPolicy -ExecutionPolicy Bypass -Scope Process -Force -ErrorAction Stop
} catch {
    # Process scope cannot override a Group-Policy-locked machine; in that rare
    # case the persistent prompt below (and a reopened admin terminal) is needed.
}

function Write-Step([string]$Message) { Write-Host "`n==> $Message" -ForegroundColor Cyan }
function Write-Ok([string]$Message)   { Write-Host "    $Message" -ForegroundColor Green }
function Write-Warn2([string]$Message) { Write-Host "    $Message" -ForegroundColor Yellow }

function Test-Command([string]$Name) {
    return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

# Refresh the CURRENT session's environment from the Machine + User registry
# hives, so tools just installed by winget (git, node, uv, ...) are usable in
# this same session without reopening the terminal. winget writes the new PATH
# entries to the registry during install; this re-reads them.
function Update-SessionEnvironment {
    $pathSep = [System.IO.Path]::PathSeparator   # ';' on Windows

    # Preserve PATH entries already added to the live process (e.g. by uv), so a
    # registry refresh does not drop them.
    $processPath = $env:Path

    # Apply Machine-level then User-level vars (User wins). PATH is handled
    # separately below because it must be MERGED, not overwritten.
    foreach ($level in 'Machine', 'User') {
        $vars = [Environment]::GetEnvironmentVariables($level)
        foreach ($name in $vars.Keys) {
            if ($name -ieq 'Path') { continue }
            try { Set-Item -LiteralPath "Env:\$name" -Value $vars[$name] -ErrorAction Stop } catch { }
        }
    }

    # PATH = Machine + User + existing process PATH, de-duplicated, order preserved.
    $machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $userPath    = [Environment]::GetEnvironmentVariable('Path', 'User')
    $seen = @{}
    $merged = foreach ($p in (@($machinePath, $userPath, $processPath) -join $pathSep).Split($pathSep)) {
        $t = $p.Trim()
        if ($t -and -not $seen.ContainsKey($t)) { $seen[$t] = $true; $t }
    }
    $env:Path = $merged -join $pathSep
}

# Install a package via winget only if the given command is missing.
function Install-Prereq {
    param(
        [string]$CommandName,
        [string]$WingetId,
        [string]$DisplayName
    )
    if (Test-Command $CommandName) {
        Write-Ok "$DisplayName already installed ($((Get-Command $CommandName).Source))"
        return
    }
    Write-Step "Installing $DisplayName via winget ($WingetId)"
    winget install --id $WingetId -e --source winget `
        --accept-source-agreements --accept-package-agreements
    Update-SessionEnvironment
    if (Test-Command $CommandName) {
        Write-Ok "$DisplayName installed."
    } else {
        Write-Warn2 "$DisplayName installed but '$CommandName' is not yet on PATH. You may need to reopen the terminal."
    }
}

# Create a global 'flujo' command so FLUJO can be started from any folder by
# typing `flujo`. Writes a tiny launcher to a bin dir on the user's PATH, with
# the chosen install location baked in.
function Register-FlujoCommand {
    param([string]$AppDir)

    $binDir = Join-Path $env:LOCALAPPDATA 'FLUJO-cli'
    New-Item -ItemType Directory -Force -Path $binDir | Out-Null

    $launcher = Join-Path $binDir 'flujo.cmd'
    $cmd = @"
@echo off
REM FLUJO launcher - generated by install.ps1
set "FLUJO_HOME=$AppDir"
if not exist "%FLUJO_HOME%\package.json" (
  echo FLUJO was not found at "%FLUJO_HOME%". Please re-run the installer.
  exit /b 1
)
cd /d "%FLUJO_HOME%"
echo Starting FLUJO ... opening http://localhost:4200
start "" http://localhost:4200
npm start %*
"@
    # OEM encoding matches the codepage cmd.exe reads .cmd files in (handles
    # non-ASCII characters in the install path correctly).
    Set-Content -LiteralPath $launcher -Value $cmd -Encoding Oem

    # Persist the bin dir to the User PATH if it isn't already there.
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    if (($userPath -split ';') -notcontains $binDir) {
        $newUserPath = (@($userPath, $binDir) | Where-Object { $_ }) -join ';'
        [Environment]::SetEnvironmentVariable('Path', $newUserPath, 'User')
        Write-Ok "'flujo' command installed (added $binDir to your user PATH)."
    } else {
        Write-Ok "'flujo' command updated."
    }

    # Make 'flujo' resolvable in the current session too.
    Update-SessionEnvironment

    return $launcher
}

# Create a Desktop shortcut that launches FLUJO via the 'flujo' launcher.
function Add-DesktopShortcut {
    param([string]$Launcher, [string]$AppDir)
    try {
        $desktop = [Environment]::GetFolderPath('Desktop')
        $lnkPath = Join-Path $desktop 'FLUJO.lnk'
        $wsh = New-Object -ComObject WScript.Shell
        $sc = $wsh.CreateShortcut($lnkPath)
        $sc.TargetPath = $Launcher
        $sc.WorkingDirectory = $AppDir
        $sc.Description = 'Start FLUJO'
        $icon = Join-Path $AppDir 'public\favicon.ico'
        if (Test-Path -LiteralPath $icon) { $sc.IconLocation = $icon }
        $sc.Save()
        Write-Ok "Desktop shortcut created: $lnkPath"
    } catch {
        Write-Warn2 "Could not create desktop shortcut: $($_.Exception.Message)"
    }
}

# Ensure the user can run .ps1 shims (npm, npx, ...) in normal terminals from
# now on - not just inside this installer's process. FLUJO builds and runs MCP
# servers (npm/npx/uv/python) on demand later, and developers will run npm by
# hand, so a persistent policy is worthwhile. We use the Microsoft-recommended
# 'RemoteSigned' (local scripts run; downloaded scripts must be signed) at
# 'CurrentUser' scope, which needs no admin. Skipped if scripts are already
# allowed; persistent change is asked for first (or driven by FLUJO_SET_POLICY).
# Determine the execution policy that NEW terminals will actually get, i.e. the
# effective policy IGNORING this installer's transient Process-scope Bypass.
# Precedence (highest first) is MachinePolicy > UserPolicy > CurrentUser >
# LocalMachine; the first scope that isn't 'Undefined' wins. (We skip Process on
# purpose - it does not persist to future terminals.) If all are Undefined,
# Windows falls back to 'Restricted'.
function Get-FutureExecutionPolicy {
    foreach ($scope in 'MachinePolicy', 'UserPolicy', 'CurrentUser', 'LocalMachine') {
        $p = Get-ExecutionPolicy -Scope $scope
        if ($p -ne 'Undefined') { return $p }
    }
    return 'Restricted'
}

function Set-PersistentExecutionPolicy {
    # Check the policy future terminals will inherit, NOT just the CurrentUser
    # scope: a machine can already allow scripts via LocalMachine (or a GPO) with
    # CurrentUser left Undefined, in which case there is nothing to do.
    $current = Get-FutureExecutionPolicy
    if ($current -in @('RemoteSigned', 'Unrestricted', 'Bypass')) {
        Write-Ok "Execution policy already allows scripts in new terminals (effective = $current)."
        return
    }

    $consent = $false
    if ($env:FLUJO_SET_POLICY -in @('1', 'true', 'yes')) {
        $consent = $true
    } elseif ($env:FLUJO_SET_POLICY -in @('0', 'false', 'no')) {
        $consent = $false
    } else {
        Write-Warn2 "Windows blocks running PowerShell scripts (npm/npx are .ps1 shims) by default."
        Write-Warn2 "FLUJO needs to run npm/npx for this install and when building MCP servers later."
        $ans = Read-Host "Set execution policy to RemoteSigned for your user account? (recommended) (Y/n)"
        $consent = -not ($ans -match '^\s*(n|no)\s*$')
    }

    if ($consent) {
        try {
            Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser -Force -ErrorAction Stop
            Write-Ok "Execution policy set to RemoteSigned (CurrentUser). Revert anytime with:"
            Write-Ok "    Set-ExecutionPolicy -ExecutionPolicy Restricted -Scope CurrentUser"
        } catch {
            # Most commonly a System.Security.SecurityException ("Security error.")
            # when security software or a locked-down HKCU ACL blocks writing the
            # ShellIds key. The install is unaffected (Process scope is bypassed),
            # and a one-off admin command can set it machine-wide if ever needed.
            Write-Warn2 "Could not set execution policy: $($_.Exception.Message)"
            Write-Warn2 "This install will still proceed (policy is bypassed for this session)."
            Write-Warn2 "If npm/npx fail in new terminals later, run this once in an admin PowerShell:"
            Write-Warn2 "    Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope LocalMachine"
        }
    } else {
        Write-Warn2 "Skipped. This install proceeds (session-only bypass), but npm/npx may fail"
        Write-Warn2 "in new terminals later until you run:"
        Write-Warn2 "    Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser"
    }
}

Write-Host "FLUJO Installer" -ForegroundColor Magenta
Write-Host "===============" -ForegroundColor Magenta

# winget is required to bootstrap the prerequisites.
if (-not (Test-Command 'winget')) {
    throw "winget (App Installer) was not found. Install 'App Installer' from the Microsoft Store, then re-run this script."
}

# ---------------------------------------------------------------------------
# 1. Gather all the user's choices up front, then run the install in one go.
#    Order: install path -> desktop shortcut -> start after -> security policy.
#    (Script execution already works this session via the Process-scope bypass
#    set at the top; the persistent policy question comes last, just before the
#    work begins.)
# ---------------------------------------------------------------------------
$defaultDir = if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'FLUJO' } else { Join-Path $HOME 'FLUJO' }

if ([string]::IsNullOrWhiteSpace($InstallDir)) {
    $answer = Read-Host "Where should FLUJO be installed? (press Enter for: $defaultDir)"
    $InstallDir = if ([string]::IsNullOrWhiteSpace($answer)) { $defaultDir } else { $answer.Trim() }
}
# Expand any environment variables the user may have typed (e.g. %USERPROFILE%).
$InstallDir = [Environment]::ExpandEnvironmentVariables($InstallDir)
Write-Ok "Installing into: $InstallDir"

# Decide whether to create a Desktop shortcut (defaults to yes).
if ($env:FLUJO_SHORTCUT -in @('0', 'false', 'no')) {
    $makeShortcut = $false
} else {
    $scAnswer = Read-Host "Create a desktop shortcut for FLUJO? (Y/n)"
    $makeShortcut = -not ($scAnswer -match '^\s*(n|no)\s*$')
}

# Decide whether to start FLUJO afterwards.
$startAfter = $Start.IsPresent
if (-not $startAfter) {
    if ($env:FLUJO_START -in @('1', 'true', 'yes')) {
        $startAfter = $true
    } else {
        $startAnswer = Read-Host "Start FLUJO after building? (y/N)"
        $startAfter = ($startAnswer -match '^(y|yes)$')
    }
}

# Last question: persist the script-execution policy for future terminals / on-
# demand MCP server builds (with the user's consent). Skipped automatically if
# scripts are already allowed. After this, the install runs without interruption.
Set-PersistentExecutionPolicy

# ---------------------------------------------------------------------------
# 2. Install prerequisites via winget.
# ---------------------------------------------------------------------------
# npm ships with Node.js, so there is no separate winget package for it.
Install-Prereq -CommandName 'git'    -WingetId 'Git.Git'            -DisplayName 'Git'
Install-Prereq -CommandName 'node'   -WingetId 'OpenJS.NodeJS'      -DisplayName 'Node.js (includes npm)'
Install-Prereq -CommandName 'python' -WingetId 'Python.Python.3.12' -DisplayName 'Python 3.12'
Install-Prereq -CommandName 'uv'     -WingetId 'astral-sh.uv'       -DisplayName 'uv'

Update-SessionEnvironment

# ---------------------------------------------------------------------------
# 3. Clone or update the repository.
# ---------------------------------------------------------------------------
if (Test-Path (Join-Path $InstallDir '.git')) {
    Write-Step "Existing FLUJO clone found - updating ($Branch)"
    git -C $InstallDir fetch origin $Branch
    git -C $InstallDir checkout $Branch
    git -C $InstallDir pull origin $Branch
} else {
    Write-Step "Cloning FLUJO into $InstallDir"
    $parent = Split-Path -Parent $InstallDir
    if ($parent -and -not (Test-Path $parent)) {
        New-Item -ItemType Directory -Force -Path $parent | Out-Null
    }
    git clone -b $Branch $RepoUrl $InstallDir
}

# ---------------------------------------------------------------------------
# 4. Install dependencies and build.
# ---------------------------------------------------------------------------
Push-Location $InstallDir
try {
    Write-Step "Installing npm dependencies (npm install)"
    npm install

    Write-Step "Building FLUJO (npm run build)"
    npm run build

    Write-Ok "Build complete."

    # Register the global 'flujo' command (works from any folder).
    $flujoLauncher = Register-FlujoCommand -AppDir $InstallDir
    if ($makeShortcut) {
        Add-DesktopShortcut -Launcher $flujoLauncher -AppDir $InstallDir
    }

    if ($startAfter) {
        Write-Step "Starting FLUJO (npm start) - open http://localhost:4200"
        Start-Process 'http://localhost:4200'
        npm start
    } else {
        Write-Host "`nDone! Start FLUJO from any folder by typing:" -ForegroundColor Green
        Write-Host "    flujo" -ForegroundColor Green
        Write-Host "(in a new terminal). Then open http://localhost:4200" -ForegroundColor Green
    }
}
finally {
    Pop-Location
}
