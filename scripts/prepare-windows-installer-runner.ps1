# GitHub's Server image lacks the desktop App Installer present on consumer
# Windows. Provision the real Microsoft client; never substitute a winget stub.
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted') {
    throw 'This preparation script is restricted to ephemeral GitHub-hosted workers.'
}
if (-not (Get-Command winget.exe -ErrorAction SilentlyContinue)) {
    Install-Module Microsoft.WinGet.Client -Scope CurrentUser -Force -Repository PSGallery
    Repair-WinGetPackageManager -AllUsers
}
if (-not (Get-Command winget.exe -ErrorAction SilentlyContinue)) {
    $package = Get-AppxPackage Microsoft.DesktopAppInstaller | Select-Object -First 1
    if (-not $package) { throw 'App Installer registration failed.' }
    $env:PATH = "$($package.InstallLocation);$env:PATH"
    $package.InstallLocation | Out-File -FilePath $env:GITHUB_PATH -Encoding utf8 -Append
}
winget --version
if ($LASTEXITCODE) { throw 'WinGet is unavailable.' }
