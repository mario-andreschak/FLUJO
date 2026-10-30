# Exercise the production command handler in the same PowerShell 5.1 process
# boundary used by setup.exe. No installer prerequisites or user state are changed.
[CmdletBinding()]
param(
    [string]$InstallScript = (Join-Path $PSScriptRoot '../scripts/install.ps1'),
    [string]$WorkDirectory = (Join-Path $PSScriptRoot '../.tmp/installer-native'),
    [string]$Probe = '',
    [switch]$ExpectLegacyFailure
)
$ErrorActionPreference = 'Stop'
$InstallScript = (Resolve-Path -LiteralPath $InstallScript).Path
New-Item -ItemType Directory -Force -Path $WorkDirectory | Out-Null
$WorkDirectory = (Resolve-Path -LiteralPath $WorkDirectory).Path

if ($Probe) {
    . (Join-Path $PSScriptRoot '../scripts/installer-functions.ps1')
    $tokens = $null
    $parseErrors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseFile($InstallScript, [ref]$tokens, [ref]$parseErrors)
    if ($parseErrors.Count) { throw 'Installer script does not parse.' }
    $definitions = foreach ($name in @('Write-Step', 'Stop-Installer', 'Write-InstallerStage', 'Invoke-InstallerCommand', 'Invoke-InstallerCommandOnce')) {
        $definition = $ast.Find({
            param($node)
            $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name
        }, $true)
        if (-not $definition) { throw "Missing installer function: $name" }
        $definition.Extent.Text
    }
    $definitionsPath = Join-Path $WorkDirectory "$Probe-functions.ps1"
    Set-Content -LiteralPath $definitionsPath -Value ($definitions -join "`r`n") -Encoding UTF8
    . $definitionsPath
    $script:InstallerSensitiveValues = @('fixture-secret')
    $script:InstallerLogPath = Join-Path $WorkDirectory "$Probe.log"
    $script:InstallerStagePath = Join-Path $WorkDirectory "$Probe.stage"
    $script:InstallerErrorPath = Join-Path $WorkDirectory "$Probe.error"
    Set-Content -LiteralPath $script:InstallerLogPath -Value '' -Encoding UTF8
    $env:FLUJO_INSTALL_TEST_VALUE = 'original'
    $env:NODE_TLS_REJECT_UNAUTHORIZED = '0'
    $environment = @{ FLUJO_INSTALL_TEST_VALUE = 'temporary' }
    switch ($Probe) {
        'stderr-success' {
            Invoke-InstallerCommand -Stage repository -Command $env:ComSpec -Arguments @('/d', '/c', 'echo ordinary progress 1>&2 & echo stdout finished & exit /b 0') -Environment $environment
        }
        'stderr-failure' {
            Invoke-InstallerCommand -Stage repository -Command $env:ComSpec -Arguments @('/d', '/c', 'echo fatal fixture-secret 1>&2 & exit /b 37') -Environment $environment
        }
        'silent-failure' {
            Invoke-InstallerCommand -Stage build -Command $env:ComSpec -Arguments @('/d', '/c', 'exit /b 37')
        }
        'missing-command' {
            Invoke-InstallerCommand -Stage repository -Command 'flujo-no-such-executable-9573'
        }
        'git-clone' {
            Invoke-InstallerCommand -Stage repository -Command git -Arguments @('clone', (Join-Path $WorkDirectory 'origin'), (Join-Path $WorkDirectory 'fresh install with spaces')) -Environment $environment
        }
        default { throw "Unknown probe: $Probe" }
    }
    if ($env:FLUJO_INSTALL_TEST_VALUE -cne 'original' -or $env:NODE_TLS_REJECT_UNAUTHORIZED -cne '0') {
        throw 'Installer did not restore the process environment.'
    }
    if ($ErrorActionPreference -ne 'Stop') { throw 'Installer changed caller error handling.' }
    exit 0
}

$origin = Join-Path $WorkDirectory 'origin'
if (Test-Path -LiteralPath $origin) { throw 'Use a fresh WorkDirectory for each run.' }
git init -b main $origin | Out-Host
if ($LASTEXITCODE) { throw 'Could not create repository fixture.' }
Set-Content -LiteralPath (Join-Path $origin 'README.txt') -Value 'Installer clone fixture'
git -C $origin add README.txt
git -C $origin -c user.name=InstallerTest -c user.email=installer@example.invalid commit -m fixture | Out-Host
if ($LASTEXITCODE) { throw 'Could not commit repository fixture.' }
$cases = if ($ExpectLegacyFailure) {
    @{ 'stderr-success' = 1; 'git-clone' = 1 }
} else {
    @{ 'stderr-success' = 0; 'stderr-failure' = 37; 'silent-failure' = 37; 'missing-command' = 1; 'git-clone' = 0 }
}
foreach ($case in ($cases.Keys | Sort-Object)) {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $PSCommandPath -Probe $case -InstallScript $InstallScript -WorkDirectory $WorkDirectory
    $code = $LASTEXITCODE
    if ($code -ne $cases[$case]) { throw "$case returned $code; expected $($cases[$case])." }
    Write-Host "PASS: $case (exit $code)"
}
if (-not $ExpectLegacyFailure) {
    $log = Get-Content -LiteralPath (Join-Path $WorkDirectory 'stderr-success.log') -Raw
    if ($log -notmatch 'ordinary progress' -or $log -notmatch 'stdout finished' -or $log -notmatch 'state=completed') {
        throw 'Successful native output was lost.'
    }
    $failure = Get-Content -LiteralPath (Join-Path $WorkDirectory 'stderr-failure.error') -Raw
    if ($failure -notmatch '37' -or $failure -notmatch 'fatal \[REDACTED\]' -or $failure -match 'fixture-secret') {
        throw 'Failure summary lost the native diagnostic or exposed sensitive data.'
    }
    if ((git -C (Join-Path $WorkDirectory 'fresh install with spaces') rev-parse HEAD) -cne (git -C $origin rev-parse HEAD)) {
        throw 'Clone did not produce the expected checkout.'
    }
}
Write-Host 'Windows PowerShell native command boundary checks passed.'
