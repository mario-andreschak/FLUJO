# Destructive installation effects are confined to an ephemeral hosted runner.
# This deliberately runs the compiled wizard, its embedded PowerShell 5.1
# installer, real Git/npm/browser downloads, production build and launcher.
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or -not $env:RUNNER_TEMP) {
    throw 'Run this acceptance check only on a fresh GitHub-hosted Windows worker.'
}
$evidence = Join-Path $env:RUNNER_TEMP 'flujo-install-evidence'
$target = Join-Path $env:RUNNER_TEMP 'FLUJO fresh install'
$cli = Join-Path $env:LOCALAPPDATA 'FLUJO-cli'
if ((Test-Path -LiteralPath $target) -or (Test-Path -LiteralPath $cli)) {
    throw 'Acceptance requires an empty installation and no prior FLUJO registration.'
}
New-Item -ItemType Directory -Path $evidence | Out-Null
$started = Get-Date
$installer = (Resolve-Path installer/Output/flujo-setup.exe).Path
$result = [ordered]@{
    sourceRevision = $env:GITHUB_SHA
    sourceRef = $env:GITHUB_REF_NAME
    installerSha256 = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant()
    os = [Environment]::OSVersion.VersionString
    runnerImage = $env:ImageVersion
    prerequisitesBefore = @(foreach ($name in @('git', 'node', 'python', 'uv', 'rg', 'winget')) {
        $command = Get-Command $name -ErrorAction SilentlyContinue
        [ordered]@{ name = $name; present = [bool]$command; path = $command.Source }
    })
    installPassed = $false
    rerunPassed = $false
    userDataPreserved = $false
    unrelatedDirectoryRefused = $false
    missingWingetRefused = $false
    launchPassed = $false
}
if ($env:EXPECTED_INSTALLER_SHA256 -and $result.installerSha256 -cne $env:EXPECTED_INSTALLER_SHA256) {
    throw 'Downloaded installer differs from the compiler artifact digest.'
}
try {
    # Verify the missing-App-Installer path with no winget on the child's PATH.
    # This uses the real executable and must stop before creating app files.
    $originalPath = $env:PATH
    try {
        $env:PATH = "$env:SystemRoot\System32;$env:SystemRoot"
        $missingWinget = Start-Process -FilePath $installer -ArgumentList @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-', "/DIR=`"$target`"", "/LOG=`"$evidence\missing-winget-setup.log`"") -WindowStyle Hidden -Wait -PassThru
        if ($missingWinget.ExitCode -eq 0 -or (Test-Path -LiteralPath $target) -or (Test-Path -LiteralPath (Join-Path $cli 'flujo.cmd'))) {
            throw 'Missing WinGet did not stop setup before registration.'
        }
        $result.missingWingetRefused = $true
    } finally {
        $env:PATH = $originalPath
    }
    $setup = Start-Process -FilePath $installer -ArgumentList @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-', '/TASKS=desktopicon', "/DIR=`"$target`"", "/LOG=`"$evidence\setup.log`"") -WindowStyle Hidden -Wait -PassThru
    $result.installerExitCode = $setup.ExitCode
    if ($setup.ExitCode -ne 0) { throw "Compiled installer exited $($setup.ExitCode)." }
    $manifest = Get-Content -LiteralPath (Join-Path $cli 'install-manifest.json') -Raw | ConvertFrom-Json
    $installedRevision = git -C $target rev-parse HEAD
    if ($installedRevision -cne $env:GITHUB_SHA -or $manifest.revision -cne $env:GITHUB_SHA) {
        throw 'Installed checkout or manifest does not match the compiled source revision.'
    }
    $log = Get-Content -LiteralPath (Join-Path $cli 'install.log') -Raw
    foreach ($stage in @('repository', 'npm-dependencies', 'patchright-chromium', 'build', 'validation', 'registration')) {
        if ($log -notmatch "\[FLUJO_INSTALL_STAGE\] name=$stage state=completed exit=0") { throw "Incomplete installer stage: $stage" }
    }
    $shortcut = Join-Path ([Environment]::GetFolderPath('Desktop')) 'FLUJO.lnk'
    if (-not (Test-Path -LiteralPath $shortcut)) { throw 'Desktop shortcut was not created.' }
    $launcher = Join-Path $cli 'flujo.cmd'
    if (-not (Test-Path -LiteralPath $launcher)) { throw 'Global launcher was not created.' }
    $result.installPassed = $true
    $result.installedRevision = $installedRevision
    $result.installSeconds = [Math]::Round(((Get-Date) - $started).TotalSeconds, 1)
    Copy-Item -LiteralPath (Join-Path $cli 'install.log') -Destination (Join-Path $evidence 'first-install.log')
    $userData = Join-Path $target 'userdata'
    New-Item -ItemType Directory -Force -Path $userData | Out-Null
    $sentinel = Join-Path $userData 'installer-acceptance.txt'
    Set-Content -LiteralPath $sentinel -Value 'Keep existing user data' -Encoding utf8
    # A second execution must safely update the actual installed checkout.
    $rerun = Start-Process -FilePath $installer -ArgumentList @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-', '/TASKS=desktopicon', "/DIR=`"$target`"", "/LOG=`"$evidence\rerun-setup.log`"") -WindowStyle Hidden -Wait -PassThru
    $result.rerunExitCode = $rerun.ExitCode
    if ($rerun.ExitCode -ne 0 -or (git -C $target rev-parse HEAD) -cne $env:GITHUB_SHA) {
        throw 'Rerunning the installed version failed or changed its source revision.'
    }
    $result.rerunPassed = $true
    if ((Get-Content -LiteralPath $sentinel -Raw).Trim() -cne 'Keep existing user data') {
        throw 'Rerunning setup did not preserve existing user data.'
    }
    $result.userDataPreserved = $true
    Copy-Item -LiteralPath (Join-Path $cli 'install.log') -Destination (Join-Path $evidence 'rerun-install.log')
    # The same binary must refuse a directory containing unrelated user files.
    $unrelated = Join-Path $env:RUNNER_TEMP 'FLUJO unrelated directory'
    New-Item -ItemType Directory -Path $unrelated | Out-Null
    $unrelatedFile = Join-Path $unrelated 'keep.txt'
    Set-Content -LiteralPath $unrelatedFile -Value 'Do not change this file' -Encoding utf8
    $refusal = Start-Process -FilePath $installer -ArgumentList @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-', "/DIR=`"$unrelated`"", "/LOG=`"$evidence\refused-directory-setup.log`"") -WindowStyle Hidden -Wait -PassThru
    if ($refusal.ExitCode -eq 0 -or (Get-Content -LiteralPath $unrelatedFile -Raw).Trim() -cne 'Do not change this file' -or (Test-Path -LiteralPath (Join-Path $unrelated '.git'))) {
        throw 'Setup did not safely refuse unrelated user files.'
    }
    $result.unrelatedDirectoryRefused = $true
    # Starting the real generated launcher also verifies its path quoting.
    $server = Start-Process -FilePath $env:ComSpec -ArgumentList @('/d', '/c', "`"$launcher`"") -WorkingDirectory $env:RUNNER_TEMP -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $evidence 'server.stdout.log') -RedirectStandardError (Join-Path $evidence 'server.stderr.log')
    $result.launcherPid = $server.Id
    $deadline = (Get-Date).AddMinutes(3)
    do {
        try {
            $response = Invoke-WebRequest 'http://localhost:4200' -TimeoutSec 5
            if ($response.StatusCode -eq 200) { break }
        } catch {}
        if ($server.HasExited) { throw "Installed launcher exited $($server.ExitCode)." }
        Start-Sleep -Seconds 2
    } while ((Get-Date) -lt $deadline)
    if (-not $response -or $response.StatusCode -ne 200) { throw 'Installed application did not become ready.' }
    & node scripts/verify-windows-install-browser.mjs $target $evidence
    if ($LASTEXITCODE) { throw 'Installed browser startup acceptance failed.' }
    $result.launchPassed = $true
} finally {
    foreach ($name in @('install.log', 'install-error.txt', 'install-stage.txt', 'install-manifest.json', 'browser-install-result.json')) {
        $source = Join-Path $cli $name
        if (Test-Path -LiteralPath $source) { Copy-Item -LiteralPath $source -Destination $evidence }
    }
    $result.totalSeconds = [Math]::Round(((Get-Date) - $started).TotalSeconds, 1)
    $result | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $evidence 'result.json') -Encoding utf8
}
$result | ConvertTo-Json -Depth 6
