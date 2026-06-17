<#
.SYNOPSIS
    FLUJO installer / updater for Windows.

.DESCRIPTION
    Installs the prerequisites (Git, Node.js + npm, Python, uv) via winget,
    refreshes the PATH for the current session, clones (or updates) FLUJO,
    builds it, and optionally starts it.

    Designed to be run either directly:

        powershell -ExecutionPolicy Bypass -File scripts\install.ps1

    or as a one-liner straight from GitHub:

        irm https://raw.githubusercontent.com/mario-andreschak/FLUJO/main/scripts/install.ps1 | iex

    When run as a one-liner it will interactively ask for the install folder
    (default: %LOCALAPPDATA%\FLUJO) and whether to start FLUJO afterwards.

.NOTES
    Parameters only take effect when the script is run as a file. When piped
    through `iex` the script falls back to interactive prompts (or the
    FLUJO_DIR / FLUJO_START / FLUJO_BRANCH environment variables if they are set).
#>
[CmdletBinding()]
param(
    [string]$InstallDir = $env:FLUJO_DIR,
    [string]$Branch     = $(if ($env:FLUJO_BRANCH) { $env:FLUJO_BRANCH } else { 'main' }),
    [switch]$Start
)

$ErrorActionPreference = 'Stop'
$RepoUrl = 'https://github.com/mario-andreschak/FLUJO/'

function Write-Step([string]$Message) { Write-Host "`n==> $Message" -ForegroundColor Cyan }
function Write-Ok([string]$Message)   { Write-Host "    $Message" -ForegroundColor Green }
function Write-Warn2([string]$Message) { Write-Host "    $Message" -ForegroundColor Yellow }

function Test-Command([string]$Name) {
    return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

# Rebuild $env:Path from the Machine + User registry values so tools installed
# by winget in this session resolve without reopening the terminal.
function Update-SessionPath {
    $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $user    = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = (@($machine, $user) | Where-Object { $_ } ) -join ';'
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
    Update-SessionPath
    if (Test-Command $CommandName) {
        Write-Ok "$DisplayName installed."
    } else {
        Write-Warn2 "$DisplayName installed but '$CommandName' is not yet on PATH. You may need to reopen the terminal."
    }
}

Write-Host "FLUJO Installer" -ForegroundColor Magenta
Write-Host "===============" -ForegroundColor Magenta

# winget is required to bootstrap the prerequisites.
if (-not (Test-Command 'winget')) {
    throw "winget (App Installer) was not found. Install 'App Installer' from the Microsoft Store, then re-run this script."
}

# ---------------------------------------------------------------------------
# 1. Ask for the install location (interactive, with a sensible default).
# ---------------------------------------------------------------------------
$defaultDir = if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'FLUJO' } else { Join-Path $HOME 'FLUJO' }

if ([string]::IsNullOrWhiteSpace($InstallDir)) {
    $answer = Read-Host "Where should FLUJO be installed? (press Enter for: $defaultDir)"
    $InstallDir = if ([string]::IsNullOrWhiteSpace($answer)) { $defaultDir } else { $answer.Trim() }
}
# Expand any environment variables the user may have typed (e.g. %USERPROFILE%).
$InstallDir = [Environment]::ExpandEnvironmentVariables($InstallDir)
Write-Ok "Installing into: $InstallDir"

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

# ---------------------------------------------------------------------------
# 2. Install prerequisites via winget.
# ---------------------------------------------------------------------------
# npm ships with Node.js, so there is no separate winget package for it.
Install-Prereq -CommandName 'git'    -WingetId 'Git.Git'            -DisplayName 'Git'
Install-Prereq -CommandName 'node'   -WingetId 'OpenJS.NodeJS'      -DisplayName 'Node.js (includes npm)'
Install-Prereq -CommandName 'python' -WingetId 'Python.Python.3.12' -DisplayName 'Python 3.12'
Install-Prereq -CommandName 'uv'     -WingetId 'astral-sh.uv'       -DisplayName 'uv'

Update-SessionPath

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

    if ($startAfter) {
        Write-Step "Starting FLUJO (npm start) - open http://localhost:4200"
        Start-Process 'http://localhost:4200'
        npm start
    } else {
        Write-Host "`nDone! To start FLUJO later, run:" -ForegroundColor Green
        Write-Host "    cd `"$InstallDir`"; npm start" -ForegroundColor Green
        Write-Host "Then open http://localhost:4200" -ForegroundColor Green
    }
}
finally {
    Pop-Location
}
