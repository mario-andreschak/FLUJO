param(
    [Parameter(Mandatory)][string]$Node,
    [Parameter(Mandatory)][string]$OutputDirectory
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not $IsWindows -or [IntPtr]::Size -ne 8 -or -not [IO.Path]::IsPathFullyQualified($Node) -or -not [IO.Path]::IsPathFullyQualified($OutputDirectory)) { throw 'Windows x64 and absolute owned paths required' }
if ((Get-FileHash -LiteralPath $Node).Hash.ToLowerInvariant() -cne '9c9245166b4a8e182e0b797da9c20136117ff24368eaff1fec8343a123c8db0e') { throw 'Node changed' }
$consoleHost=Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::System)) 'conhost.exe'
$consoleItem=Get-Item -LiteralPath $consoleHost
if ($consoleItem.PSIsContainer -or ($consoleItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $consoleItem.Length -ne 867840 -or (Get-FileHash -LiteralPath $consoleHost).Hash.ToLowerInvariant() -cne 'b02ee54fb2ec69673386d41119ee8ed083a6eab3bfca6aa2155d20ce68ef8963') { throw 'Current System32 console host pin changed' }
# Root must admit exact PS/C#/fixture pins and one finite qualification lease first.
New-Item -ItemType Directory -Path $OutputDirectory | Out-Null
Add-Type -Path (Join-Path $PSScriptRoot 'WindowsRecoveryJob.cs')
$environment = [Collections.Generic.SortedDictionary[string,string]]::new([StringComparer]::OrdinalIgnoreCase)
foreach ($name in @('SystemRoot','WINDIR','COMSPEC','PATHEXT','SystemDrive')) {
    $value = [Environment]::GetEnvironmentVariable($name);if ($value) { $environment.Add($name,$value) }
}
$environment.Add('PATH',(Split-Path -Parent $Node) + ';' + (Join-Path $env:SystemRoot 'System32'))
foreach ($name in @('TEMP','TMP','TMPDIR','HOME','USERPROFILE')) { $environment.Add($name,$OutputDirectory) }
$block=(($environment.GetEnumerator() | ForEach-Object { $_.Key+'='+$_.Value }) -join [char]0)+[char]0+[char]0
$cases=@([ordered]@{id='natural-original-and-child';mode='natural';deadlineMs=10000},
    [ordered]@{id='original-zero-with-held-descendant';mode='orphan';deadlineMs=10000},
    [ordered]@{id='monotonic-held-original-cutoff';mode='held';deadlineMs=1000},
    [ordered]@{id='original-output-overflow';mode='output';deadlineMs=10000})
$passed=0
foreach ($case in $cases) {
    $folder=Join-Path $OutputDirectory $case.id;New-Item -ItemType Directory -Path $folder | Out-Null
    $executablePins=[WindowsRecoveryJob]::VerifyControlImagePins($Node)
    $pinFile=[IO.File]::Open((Join-Path $folder 'original-executable-pins.json'),[IO.FileMode]::CreateNew)
    try { $bytes=[Text.Encoding]::UTF8.GetBytes(($executablePins|ConvertTo-Json -Depth 8));$pinFile.Write($bytes,0,$bytes.Length);$pinFile.Flush($true) } finally { $pinFile.Dispose() }
    if ((Get-FileHash -LiteralPath $Node).Hash.ToLowerInvariant() -cne '9c9245166b4a8e182e0b797da9c20136117ff24368eaff1fec8343a123c8db0e') { throw 'Node changed immediately before native control entry' }
    $receipt=[WindowsRecoveryJob]::Qualify($Node,@((Join-Path $PSScriptRoot 'native-job-fixture.mjs'),$case.mode),$PSScriptRoot,$block,$folder,$case.deadlineMs)
    $file=[IO.File]::Open((Join-Path $folder 'original-native-receipt.json'),[IO.FileMode]::CreateNew)
    try { $bytes=[Text.Encoding]::UTF8.GetBytes(($receipt|ConvertTo-Json -Depth 12));$file.Write($bytes,0,$bytes.Length);$file.Flush($true) } finally { $file.Dispose() }
    if (-not $receipt.AssignedBeforeResume -or -not $receipt.RootExitObserved -or $receipt.Births.Count -lt 1 -or $receipt.Births[0].CorrelationPid -ne $receipt.OriginalCorrelationPid) { throw 'Original birth/exit contract failed' }
    $expectedNodeRoles=if($case.mode -in @('natural','orphan')){2}else{1}
    $roles=[WindowsRecoveryJob]::ValidateControlRoles($receipt,$expectedNodeRoles)
    if ($case.mode -eq 'natural') {
        $roles=[WindowsRecoveryJob]::ValidateNaturalRoles($receipt)
        if ($receipt.Outcome -cne 'original-job-and-pipes-closed' -or $roles.NodeRoles -ne 2 -or $roles.ConsoleHelpers -gt 2 -or $roles.AccountedBirths -ne $receipt.Births.Count -or $receipt.ForcedJobTermination -or -not $receipt.JobClosureVerified -or -not $receipt.StdoutClosed -or -not $receipt.StderrClosed) { throw 'Natural original/cohort closure failed' }
    } else {
        if ($receipt.Outcome -cne 'failed-or-unknown' -or -not $receipt.ForcedJobTermination) { throw 'Negative control became acceptance' }
        $expected = switch ($case.mode) {
            'orphan' { 'original-job-or-pipes-closure-unverified' }
            'held' { 'outer-monotonic-deadline' }
            'output' { 'original-output-budget-exceeded' }
        }
        if ($receipt.Failure -cne $expected) { throw 'Original negative failure changed' }
    }
    $roleFile=[IO.File]::Open((Join-Path $folder 'original-native-role-receipt.json'),[IO.FileMode]::CreateNew)
    try { $bytes=[Text.Encoding]::UTF8.GetBytes(($roles|ConvertTo-Json -Depth 12));$roleFile.Write($bytes,0,$bytes.Length);$roleFile.Flush($true) } finally { $roleFile.Dispose() }
    $passed++
}
[ordered]@{sourceCases=4;passed=$passed;failed=0;scope='Native kernel job/pipe controls only; no application/provider/MCP/package entry';retained=$true}|ConvertTo-Json -Compress
